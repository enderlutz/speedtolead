"""
Call recordings API — upload, transcribe, analyze, and browse call recordings.
"""
from __future__ import annotations
import uuid
import json
import logging
import threading
from collections import defaultdict
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from database import (
    get_db, CallRecording, CallTranscript, CallAnalysis,
    Lead, Estimate,
)

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
def get_lead_calls(lead_id: str):
    """Get all call recordings for a lead with transcripts and analyses."""
    db = get_db()
    try:
        recordings = (
            db.query(CallRecording)
            .filter(CallRecording.lead_id == lead_id)
            .order_by(CallRecording.created_at.desc())
            .limit(50)
            .all()
        )

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


@router.post("/calls/upload")
async def upload_call_recording(
    file: UploadFile = File(...),
    lead_id: str = Form(...),
    call_direction: str = Form("outbound"),
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
            duration_seconds=0,  # Will be determined by transcription
            call_direction=call_direction,
            caller_name=lead.contact_name or "",
            status="pending",
            created_at=_now(),
        )
        db.add(recording)
        db.commit()

        recording_id = recording.id
        logger.info(f"Call recording uploaded for lead {lead_id}: {recording_id}")

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

        result = analyze_call(labeled_text, lead_context)

        analysis = CallAnalysis(
            id=str(uuid.uuid4()),
            recording_id=recording_id,
            lead_id=rec.lead_id,
            summary=result["summary"],
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
def get_all_calls(limit: int = 50, offset: int = 0):
    """Get all call recordings with analyses for the Calls page."""
    db = get_db()
    try:
        recordings = (
            db.query(CallRecording)
            .order_by(CallRecording.created_at.desc())
            .offset(offset)
            .limit(limit)
            .all()
        )

        results = []
        for rec in recordings:
            entry = rec.to_dict()

            # Get lead name
            if rec.lead_id:
                lead = db.query(Lead).filter(Lead.id == rec.lead_id).first()
                entry["contact_name"] = lead.contact_name if lead else ""
            else:
                entry["contact_name"] = rec.caller_name or ""

            # Attach analysis summary (not full transcript to keep response light)
            analysis = db.query(CallAnalysis).filter(
                CallAnalysis.recording_id == rec.id
            ).first()
            entry["analysis"] = analysis.to_dict() if analysis else None

            results.append(entry)

        total = db.query(CallRecording).count()

        return {"calls": results, "total": total}
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
