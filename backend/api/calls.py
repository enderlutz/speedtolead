"""
Call recordings API — upload, transcribe, analyze, and browse call recordings.
"""
from __future__ import annotations
import uuid
import json
import time
import logging
import threading
from collections import defaultdict
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Depends, Response, Request
from sqlalchemy import func
from sqlalchemy.orm import defer
from pydantic import BaseModel
from database import (
    get_db, CallRecording, CallTranscript, CallAnalysis, CallReview,
    Lead, Estimate,
)
from api.auth import get_current_user, require_admin

router = APIRouter()
logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_dt(s: str | None):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


@router.get("/calls/lead/{lead_id}")
def get_lead_calls(lead_id: str, include_archived: bool = False):
    """Get all call recordings for a lead with transcripts and analyses."""
    db = get_db()
    try:
        # defer(recording_data) keeps the multi-MB audio BLOB out of the row
        # fetch — listing only needs metadata + has_recording_data flag.
        # Without this, every Call Coach page load streams every BLOB from
        # Postgres to Railway and counts as billable egress.
        q = (
            db.query(CallRecording)
            .options(defer(CallRecording.recording_data))
            .filter(CallRecording.lead_id == lead_id)
        )
        if not include_archived:
            q = q.filter(CallRecording.is_archived.is_(False) | CallRecording.is_archived.is_(None))
        recordings = q.order_by(CallRecording.created_at.desc()).limit(50).all()

        results = []
        for rec in recordings:
            entry = rec.to_dict()

            # Attach transcript
            transcript = db.query(CallTranscript).filter(
                CallTranscript.recording_id == rec.id
            ).first()
            entry["transcript"] = transcript.to_dict() if transcript else None

            # Attach analysis
            analysis = db.query(CallAnalysis).filter(
                CallAnalysis.recording_id == rec.id
            ).first()
            entry["analysis"] = analysis.to_dict() if analysis else None

            results.append(entry)

        return results
    finally:
        db.close()


# NOTE: The bare GET /calls/{recording_id} route is defined at the BOTTOM
# of this file. FastAPI matches routes in declaration order, so any literal
# path like /calls/all, /calls/storage, /calls/coaching-profile must be
# declared before the catch-all {recording_id} route — otherwise FastAPI
# routes those literal paths to the catch-all and 404s because no recording
# has that ID.


@router.post("/calls/upload")
async def upload_call_recording(
    file: UploadFile = File(...),
    lead_id: str = Form(...),
    call_direction: str = Form("outbound"),
    recorded_by: str = Form(""),
):
    """Upload a call recording and trigger transcription + analysis pipeline."""
    data = await file.read()
    if len(data) > 50 * 1024 * 1024:  # 50MB limit
        raise HTTPException(status_code=400, detail="File too large (max 50MB)")

    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        recording = CallRecording(
            id=str(uuid.uuid4()),
            lead_id=lead_id,
            ghl_contact_id=lead.ghl_contact_id or "",
            ghl_location_id=lead.ghl_location_id or "",
            recording_data=data,
            has_recording_data=True,
            duration_seconds=0,  # Will be determined by transcription
            call_direction=call_direction,
            caller_name=lead.contact_name or "",
            recorded_by=(recorded_by or "").strip(),
            status="pending",
            created_at=_now(),
        )
        db.add(recording)

        # Auto-flip precall_done on lead + latest estimate so the green phone
        # icon shows up on the kanban card without the VA having to also tick
        # the manual checkbox.
        if not lead.precall_done:
            lead.precall_done = True
        latest_estimate = (
            db.query(Estimate)
            .filter(Estimate.lead_id == lead_id)
            .order_by(Estimate.created_at.desc())
            .first()
        )
        if latest_estimate and not latest_estimate.precall_done:
            latest_estimate.precall_done = True
            latest_estimate.precall_at = _now()

        db.commit()

        recording_id = recording.id
        logger.info(f"Call recording uploaded for lead {lead_id}: {recording_id}")

        try:
            from services.event_bus import publish
            publish("lead_updated", {"lead_id": lead_id})
        except Exception:
            pass

        # Trigger pipeline in background thread
        thread = threading.Thread(
            target=_run_pipeline,
            args=[recording_id],
            daemon=True,
        )
        thread.start()

        return {"id": recording_id, "status": "processing"}

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Upload failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


def _run_pipeline(recording_id: str):
    """Run transcription + analysis pipeline in background."""
    try:
        from services.call_poller import process_recording_pipeline
        process_recording_pipeline(recording_id)
    except Exception as e:
        logger.error(f"Pipeline thread error: {e}")


@router.post("/calls/{recording_id}/analyze")
def reanalyze_call(recording_id: str):
    """Re-trigger analysis on an existing recording."""
    db = get_db()
    try:
        rec = db.query(CallRecording).filter(CallRecording.id == recording_id).first()
        if not rec:
            raise HTTPException(status_code=404, detail="Recording not found")

        # Must have a transcript first
        transcript = db.query(CallTranscript).filter(
            CallTranscript.recording_id == recording_id
        ).first()
        if not transcript:
            raise HTTPException(status_code=400, detail="No transcript available. Upload recording first.")

        # Delete existing analysis
        db.query(CallAnalysis).filter(CallAnalysis.recording_id == recording_id).delete()
        db.commit()

        # Run analysis in background
        thread = threading.Thread(
            target=_run_analysis_only,
            args=[recording_id],
            daemon=True,
        )
        thread.start()

        return {"status": "reanalyzing"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


def _run_analysis_only(recording_id: str):
    """Run just the analysis step (transcript already exists)."""
    from services.call_analyzer import analyze_call
    from services.call_transcriber import format_transcript_for_display

    db = get_db()
    try:
        rec = db.query(CallRecording).filter(CallRecording.id == recording_id).first()
        transcript = db.query(CallTranscript).filter(CallTranscript.recording_id == recording_id).first()
        if not rec or not transcript:
            return

        lead_context = None
        if rec.lead_id:
            lead = db.query(Lead).filter(Lead.id == rec.lead_id).first()
            estimate = db.query(Estimate).filter(Estimate.lead_id == rec.lead_id).order_by(Estimate.created_at.desc()).first()
            if lead:
                lead_context = {
                    "contact_name": lead.contact_name,
                    "address": lead.address,
                    "tiers": estimate.to_dict().get("tiers", {}) if estimate else {},
                }

        segments = json.loads(transcript.segments) if transcript.segments else []
        speaker_map = json.loads(transcript.speaker_map) if transcript.speaker_map else {}
        labeled_text = format_transcript_for_display(segments, speaker_map)

        profile_text = None
        recent_reviews = []
        try:
            from services.coaching_profile import get_active_profile, fetch_recent_reviews
            profile = get_active_profile(db)
            profile_text = profile.profile_text if profile else None
            recent_reviews = fetch_recent_reviews(db, limit=5, exclude_recording_id=recording_id)
        except Exception as e:
            logger.warning(f"Coaching calibration fetch failed (re-analysis will run without it): {e}")

        result = analyze_call(labeled_text, lead_context, profile_text, recent_reviews)

        analysis = CallAnalysis(
            id=str(uuid.uuid4()),
            recording_id=recording_id,
            lead_id=rec.lead_id,
            summary=result["summary"],
            summary_one_line=result.get("summary_one_line", ""),
            stage_evaluation=json.dumps(result.get("stage_evaluation", [])),
            boundary_violations=json.dumps(result.get("boundary_violations", [])),
            what_went_well=result.get("what_went_well", ""),
            next_action=result.get("next_action", ""),
            coaching_tips=json.dumps(result["coaching_tips"]),
            sentiment=result["sentiment"],
            customer_sentiment=result["customer_sentiment"],
            objections=json.dumps(result["objections"]),
            key_topics=json.dumps(result["key_topics"]),
            customer_data_extracted=json.dumps(result["customer_data_extracted"]),
            call_score=result["call_score"],
            close_likelihood=result["close_likelihood"],
            created_at=_now(),
        )
        db.add(analysis)
        rec.status = "analyzed"
        rec.analyzed_at = _now()
        db.commit()
        logger.info(f"Re-analysis complete for {recording_id}")
    except Exception as e:
        logger.error(f"Re-analysis failed: {e}")
    finally:
        db.close()


@router.get("/calls/all")
def get_all_calls(
    limit: int = 50,
    offset: int = 0,
    archived: bool = False,
    favorites_only: bool = False,
):
    """Get all call recordings with analyses for the Calls page.
    By default returns active (non-archived) recordings. Set archived=true
    to fetch the archive view."""
    db = get_db()
    try:
        # defer(recording_data) — same reasoning as get_lead_calls. Listing
        # doesn't need the audio BLOB; loading it on every request is what
        # caused the May-12 egress spike that blew past the 250 GB Pro quota.
        q = (
            db.query(CallRecording)
            .options(defer(CallRecording.recording_data))
        )
        if archived:
            q = q.filter(CallRecording.is_archived.is_(True))
        else:
            q = q.filter(CallRecording.is_archived.is_(False) | CallRecording.is_archived.is_(None))
        if favorites_only:
            q = q.filter(CallRecording.is_favorite.is_(True))

        total = q.count()
        recordings = q.order_by(CallRecording.created_at.desc()).offset(offset).limit(limit).all()

        results = []
        for rec in recordings:
            entry = rec.to_dict()

            # Get lead name
            if rec.lead_id:
                lead = db.query(Lead).filter(Lead.id == rec.lead_id).first()
                entry["contact_name"] = lead.contact_name if lead else ""
            else:
                entry["contact_name"] = rec.caller_name or ""

            # Transcript preview (first ~140 chars)
            transcript = db.query(CallTranscript).filter(
                CallTranscript.recording_id == rec.id
            ).first()
            if transcript and transcript.full_text:
                snippet = transcript.full_text.strip().replace("\n", " ")
                entry["transcript_preview"] = snippet[:140] + ("..." if len(snippet) > 140 else "")
            else:
                entry["transcript_preview"] = ""

            # Attach analysis summary (not full transcript to keep response light)
            analysis = db.query(CallAnalysis).filter(
                CallAnalysis.recording_id == rec.id
            ).first()
            entry["analysis"] = analysis.to_dict() if analysis else None

            results.append(entry)

        return {"calls": results, "total": total}
    finally:
        db.close()


_STORAGE_CACHE: dict = {"value": None, "ts": 0.0}
_STORAGE_TTL_SECONDS = 60


@router.get("/calls/storage")
def get_storage_stats():
    """Total bytes used by call recording blobs + count. Cached for 60s
    because summing func.length() over bytea forces Postgres to read every
    TOAST'd audio blob — slow query that we don't want running on every
    Call Coach page load."""
    now = time.time()
    cached = _STORAGE_CACHE["value"]
    if cached is not None and (now - _STORAGE_CACHE["ts"]) < _STORAGE_TTL_SECONDS:
        return cached

    db = get_db()
    try:
        total_bytes = db.query(func.coalesce(func.sum(func.length(CallRecording.recording_data)), 0)).scalar() or 0
        active_count = db.query(CallRecording).filter(
            CallRecording.is_archived.is_(False) | CallRecording.is_archived.is_(None)
        ).count()
        archived_count = db.query(CallRecording).filter(CallRecording.is_archived.is_(True)).count()
        result = {
            "total_bytes": int(total_bytes),
            "active_count": active_count,
            "archived_count": archived_count,
        }
        _STORAGE_CACHE["value"] = result
        _STORAGE_CACHE["ts"] = now
        return result
    finally:
        db.close()


@router.get("/calls/{recording_id}/audio")
def stream_audio(recording_id: str, request: Request):
    """Stream the raw audio bytes for playback in the browser. Honors HTTP
    Range requests so the <audio> element can seek (scrub the timeline)
    without downloading the whole file first."""
    db = get_db()
    try:
        rec = db.query(CallRecording).filter(CallRecording.id == recording_id).first()
        if not rec or not rec.recording_data:
            raise HTTPException(status_code=404, detail="Recording not found")

        data = rec.recording_data
        total = len(data)
        media_type = "audio/webm"  # browsers handle webm/mp4/ogg/wav fine

        range_header = request.headers.get("range") or request.headers.get("Range")
        if range_header and range_header.startswith("bytes="):
            try:
                spec = range_header.replace("bytes=", "", 1).strip()
                start_str, _, end_str = spec.partition("-")
                start = int(start_str) if start_str else 0
                end = int(end_str) if end_str else total - 1
                if end >= total:
                    end = total - 1
                if start < 0 or start > end or start >= total:
                    return Response(status_code=416, headers={"Content-Range": f"bytes */{total}"})
                chunk = data[start : end + 1]
                return Response(
                    content=chunk,
                    status_code=206,
                    media_type=media_type,
                    headers={
                        "Content-Range": f"bytes {start}-{end}/{total}",
                        "Accept-Ranges": "bytes",
                        "Content-Length": str(len(chunk)),
                        "Cache-Control": "private, max-age=600",
                    },
                )
            except ValueError:
                # Malformed Range header — fall through to full body
                pass

        # No (or unparsable) Range header → serve the whole file but still
        # advertise byte-range support so the next request can seek.
        return Response(
            content=data,
            media_type=media_type,
            headers={
                "Accept-Ranges": "bytes",
                "Content-Length": str(total),
                "Cache-Control": "private, max-age=600",
            },
        )
    finally:
        db.close()


def _refresh_precall_for_lead(db, lead_id: str) -> None:
    """After archive/un-archive, recompute whether the lead has any active
    recordings. Mirror that onto lead.precall_done + latest estimate so the
    'called' icon reflects reality."""
    if not lead_id:
        return
    has_active = (
        db.query(CallRecording)
        .filter(
            CallRecording.lead_id == lead_id,
            (CallRecording.is_archived.is_(False) | CallRecording.is_archived.is_(None)),
        )
        .first()
    )
    lead = db.query(Lead).filter(Lead.id == lead_id).first()
    if not lead:
        return
    desired = bool(has_active)
    if lead.precall_done != desired:
        lead.precall_done = desired
    latest_estimate = (
        db.query(Estimate)
        .filter(Estimate.lead_id == lead_id)
        .order_by(Estimate.created_at.desc())
        .first()
    )
    if latest_estimate and latest_estimate.precall_done != desired:
        latest_estimate.precall_done = desired
        latest_estimate.precall_at = _now() if desired else None


@router.post("/calls/{recording_id}/archive")
def archive_recording(recording_id: str, user: dict = Depends(get_current_user)):
    """Soft-delete a recording. Used when a call didn't connect (no answer)
    or was otherwise unwanted. Un-flips the lead's 'called' icon if no other
    active recordings remain. Anyone can archive; admins can still view via
    the Archived tab."""
    db = get_db()
    try:
        rec = db.query(CallRecording).filter(CallRecording.id == recording_id).first()
        if not rec:
            raise HTTPException(status_code=404, detail="Recording not found")
        if rec.status == "pending":
            raise HTTPException(status_code=400, detail="Recording is still being transcribed — try again in a moment")

        rec.is_archived = True
        rec.archived_at = _now()
        lead_id = rec.lead_id
        _refresh_precall_for_lead(db, lead_id)
        db.commit()

        try:
            from services.event_bus import publish
            if lead_id:
                publish("lead_updated", {"lead_id": lead_id})
        except Exception:
            pass

        return {"status": "archived"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/calls/{recording_id}/unarchive")
def unarchive_recording(recording_id: str, user: dict = Depends(get_current_user)):
    """Restore an archived recording back to the active list. Re-flips the
    lead's 'called' icon."""
    db = get_db()
    try:
        rec = db.query(CallRecording).filter(CallRecording.id == recording_id).first()
        if not rec:
            raise HTTPException(status_code=404, detail="Recording not found")

        rec.is_archived = False
        rec.archived_at = None
        lead_id = rec.lead_id
        _refresh_precall_for_lead(db, lead_id)
        db.commit()

        try:
            from services.event_bus import publish
            if lead_id:
                publish("lead_updated", {"lead_id": lead_id})
        except Exception:
            pass

        return {"status": "active"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


class FavoriteBody(BaseModel):
    favorite: bool


@router.post("/calls/{recording_id}/favorite")
def set_favorite(recording_id: str, body: FavoriteBody, user: dict = Depends(get_current_user)):
    """Star or unstar a recording for training/reference."""
    db = get_db()
    try:
        rec = db.query(CallRecording).filter(CallRecording.id == recording_id).first()
        if not rec:
            raise HTTPException(status_code=404, detail="Recording not found")
        rec.is_favorite = bool(body.favorite)
        db.commit()
        return {"is_favorite": rec.is_favorite}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


class NotesBody(BaseModel):
    notes: str


@router.put("/calls/{recording_id}/notes")
def update_notes(recording_id: str, body: NotesBody, user: dict = Depends(get_current_user)):
    """Save freeform admin notes on a call recording."""
    del user
    db = get_db()
    try:
        rec = db.query(CallRecording).filter(CallRecording.id == recording_id).first()
        if not rec:
            raise HTTPException(status_code=404, detail="Recording not found")
        rec.notes = (body.notes or "").strip()
        db.commit()
        return {"notes": rec.notes}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.delete("/calls/{recording_id}")
def hard_delete_recording(recording_id: str, user: dict = Depends(require_admin)):
    """Permanent deletion — admin-only, only allowed on already-archived
    recordings. Removes the audio bytes, transcript, and analysis."""
    db = get_db()
    try:
        rec = db.query(CallRecording).filter(CallRecording.id == recording_id).first()
        if not rec:
            raise HTTPException(status_code=404, detail="Recording not found")
        if not rec.is_archived:
            raise HTTPException(status_code=400, detail="Archive the recording before permanently deleting")

        db.query(CallTranscript).filter(CallTranscript.recording_id == recording_id).delete()
        db.query(CallAnalysis).filter(CallAnalysis.recording_id == recording_id).delete()
        db.delete(rec)
        db.commit()
        return {"status": "deleted"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/calls/{recording_id}/retry")
def retry_transcription(recording_id: str, user: dict = Depends(get_current_user)):
    """Re-run transcription + analysis on a failed recording. Clears any
    partial transcript/analysis first."""
    db = get_db()
    try:
        rec = db.query(CallRecording).filter(CallRecording.id == recording_id).first()
        if not rec:
            raise HTTPException(status_code=404, detail="Recording not found")
        if not rec.recording_data:
            raise HTTPException(status_code=400, detail="No audio data — cannot retry")

        db.query(CallTranscript).filter(CallTranscript.recording_id == recording_id).delete()
        db.query(CallAnalysis).filter(CallAnalysis.recording_id == recording_id).delete()
        rec.status = "pending"
        rec.transcribed_at = None
        rec.analyzed_at = None
        db.commit()

        thread = threading.Thread(target=_run_pipeline, args=[recording_id], daemon=True)
        thread.start()

        return {"status": "processing"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.get("/calls/patterns")
def get_call_patterns():
    """Aggregated pattern analysis — closed vs lost calls."""
    db = get_db()
    try:
        # Get all analyzed calls with their lead's close status
        analyses = (
            db.query(CallAnalysis, Estimate)
            .join(Lead, CallAnalysis.lead_id == Lead.id)
            .outerjoin(Estimate, Estimate.lead_id == Lead.id)
            .filter(Lead.is_test.is_(False))
            .all()
        )

        closed_scores = []
        lost_scores = []
        closed_durations = []
        lost_durations = []
        all_objections = defaultdict(int)
        closed_objections = defaultdict(int)
        all_topics = defaultdict(int)
        closed_topics = defaultdict(int)
        all_tips = defaultdict(int)
        sentiment_counts = {"closed": defaultdict(int), "lost": defaultdict(int)}

        for analysis, estimate in analyses:
            is_closed = estimate and estimate.closed_tier is not None
            score = analysis.call_score or 0
            objections = json.loads(analysis.objections) if analysis.objections else []
            topics = json.loads(analysis.key_topics) if analysis.key_topics else []
            tips = json.loads(analysis.coaching_tips) if analysis.coaching_tips else []

            # Get recording duration
            rec = db.query(CallRecording).filter(CallRecording.id == analysis.recording_id).first()
            duration = rec.duration_seconds if rec else 0

            if is_closed:
                closed_scores.append(score)
                closed_durations.append(duration)
                sentiment_counts["closed"][analysis.customer_sentiment] += 1
                for obj in objections:
                    closed_objections[obj] += 1
                for topic in topics:
                    closed_topics[topic] += 1
            else:
                lost_scores.append(score)
                lost_durations.append(duration)
                sentiment_counts["lost"][analysis.customer_sentiment] += 1

            for obj in objections:
                all_objections[obj] += 1
            for topic in topics:
                all_topics[topic] += 1
            for tip in tips:
                all_tips[tip] += 1

        total_calls = len(closed_scores) + len(lost_scores)

        return {
            "total_calls": total_calls,
            "closed_calls": len(closed_scores),
            "lost_calls": len(lost_scores),
            "avg_score_closed": round(sum(closed_scores) / len(closed_scores), 1) if closed_scores else 0,
            "avg_score_lost": round(sum(lost_scores) / len(lost_scores), 1) if lost_scores else 0,
            "avg_duration_closed": round(sum(closed_durations) / len(closed_durations) / 60, 1) if closed_durations else 0,
            "avg_duration_lost": round(sum(lost_durations) / len(lost_durations) / 60, 1) if lost_durations else 0,
            "top_objections": sorted(all_objections.items(), key=lambda x: -x[1])[:10],
            "top_topics_closed": sorted(closed_topics.items(), key=lambda x: -x[1])[:10],
            "top_coaching_tips": sorted(all_tips.items(), key=lambda x: -x[1])[:10],
            "sentiment_closed": dict(sentiment_counts["closed"]),
            "sentiment_lost": dict(sentiment_counts["lost"]),
        }
    except Exception as e:
        logger.error(f"Pattern analysis error: {e}")
        return {"total_calls": 0, "error": str(e)}
    finally:
        db.close()


# ─── Call Reviews — admin coaching feedback on a recorded call ──────────

@router.get("/calls/{recording_id}/reviews")
def list_call_reviews(recording_id: str, user: dict = Depends(get_current_user)):
    """Anyone authenticated can read reviews — Olga needs to see hers."""
    del user
    db = get_db()
    try:
        rows = (
            db.query(CallReview)
            .filter(CallReview.recording_id == recording_id)
            .order_by(CallReview.created_at.asc())
            .all()
        )
        return [r.to_dict() for r in rows]
    finally:
        db.close()


@router.post("/calls/{recording_id}/reviews")
async def create_call_review(
    recording_id: str,
    text: str = Form(""),
    audio: UploadFile | None = File(None),
    user: dict = Depends(require_admin),
):
    """Admin-only. Accepts either a typed `text` body, or an uploaded `audio`
    blob, or both. If audio is provided and text is empty, we transcribe the
    audio via Deepgram and use that as the text body. Audio is stored so
    Olga can listen to Alan's actual voice if she prefers."""
    db = get_db()
    try:
        rec = db.query(CallRecording).filter(CallRecording.id == recording_id).first()
        if not rec:
            raise HTTPException(status_code=404, detail="Recording not found")

        audio_bytes: bytes | None = None
        audio_mime = ""
        if audio is not None:
            audio_bytes = await audio.read()
            if len(audio_bytes) > 25 * 1024 * 1024:  # 25MB cap on review audio
                raise HTTPException(status_code=400, detail="Audio too large (max 25MB)")
            audio_mime = audio.content_type or "audio/webm"

        final_text = text.strip()
        if not final_text and audio_bytes:
            try:
                from services.call_transcriber import transcribe_recording
                result = transcribe_recording(audio_bytes)
                final_text = (result.get("full_text") or "").strip()
            except Exception as e:
                logger.error(f"Review transcription failed: {e}")

        if not final_text:
            raise HTTPException(status_code=400, detail="Review needs either text or audio (audio failed to transcribe)")

        review = CallReview(
            id=str(uuid.uuid4()),
            recording_id=recording_id,
            lead_id=rec.lead_id,
            reviewer_user_id=user.get("sub", ""),
            reviewer_name=user.get("name", "Admin"),
            text=final_text,
            audio_data=audio_bytes,
            has_audio_data=bool(audio_bytes),  # avoids loading audio BLOB in to_dict() egress hot path
            audio_mime=audio_mime,
            created_at=_now(),
        )
        db.add(review)
        db.commit()

        # Notify Olga in the background — never block on it
        try:
            lead_name = ""
            if rec.lead_id:
                lead = db.query(Lead).filter(Lead.id == rec.lead_id).first()
                lead_name = (lead.contact_name if lead else "") or "the lead"
            else:
                lead_name = rec.caller_name or "the lead"
            from services.notifications import notify_call_review
            threading.Thread(
                target=notify_call_review,
                args=[rec.lead_id or "", lead_name, review.reviewer_name, final_text],
                daemon=True,
            ).start()
        except Exception as e:
            logger.warning(f"Review SMS dispatch failed: {e}")

        # Self-learning: trigger a profile regen if enough new reviews have
        # accumulated since the last snapshot. Background — non-blocking.
        try:
            from services.coaching_profile import maybe_regenerate_profile_async
            maybe_regenerate_profile_async()
        except Exception as e:
            logger.warning(f"Coaching profile auto-regen dispatch failed: {e}")

        return review.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Create review failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.get("/calls/coaching-profile")
def get_coaching_profile(user: dict = Depends(get_current_user)):
    """The current self-learning coaching profile distilled from all of
    Alan's reviews. Returns null if no reviews have been written yet."""
    del user
    db = get_db()
    try:
        from services.coaching_profile import get_active_profile
        profile = get_active_profile(db)
        return profile.to_dict() if profile else None
    finally:
        db.close()


@router.post("/calls/coaching-profile/regenerate")
def regenerate_coaching_profile(user: dict = Depends(require_admin)):
    """Force a fresh profile regen now (instead of waiting for the auto
    threshold). Admin-only."""
    db = get_db()
    try:
        from services.coaching_profile import generate_coaching_profile
        profile = generate_coaching_profile(db, generated_by=user.get("name", "Admin"))
        if not profile:
            raise HTTPException(status_code=400, detail="No reviews to learn from yet, or generation failed")
        return profile.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.get("/calls/reviews/{review_id}/audio")
def stream_review_audio(review_id: str):
    """Stream the reviewer's voice clip for browser playback."""
    db = get_db()
    try:
        rev = db.query(CallReview).filter(CallReview.id == review_id).first()
        if not rev or not rev.audio_data:
            raise HTTPException(status_code=404, detail="Review audio not found")
        return Response(content=rev.audio_data, media_type=rev.audio_mime or "audio/webm")
    finally:
        db.close()


# Catch-all single-recording fetch — MUST stay last so it doesn't shadow the
# literal-path routes above (/calls/all, /calls/storage, /calls/patterns,
# /calls/coaching-profile, /calls/reviews/...).
@router.get("/calls/{recording_id}")
def get_call(recording_id: str):
    """Get a single call recording with transcript and analysis."""
    db = get_db()
    try:
        rec = db.query(CallRecording).filter(CallRecording.id == recording_id).first()
        if not rec:
            raise HTTPException(status_code=404, detail="Recording not found")

        entry = rec.to_dict()

        transcript = db.query(CallTranscript).filter(
            CallTranscript.recording_id == rec.id
        ).first()
        entry["transcript"] = transcript.to_dict() if transcript else None

        analysis = db.query(CallAnalysis).filter(
            CallAnalysis.recording_id == rec.id
        ).first()
        entry["analysis"] = analysis.to_dict() if analysis else None

        return entry
    finally:
        db.close()
