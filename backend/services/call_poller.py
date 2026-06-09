"""
GHL call recording poller.
Checks for new call recordings and triggers transcription + analysis pipeline.

NOTE: GHL call recording endpoint TBD — this is a ready-to-connect stub.
Once we confirm the GHL API endpoint for call recordings, we plug it in here.
"""
from __future__ import annotations
import uuid
import json
import logging
import httpx
from datetime import datetime, timezone
from config import get_settings
from database import get_db, CallRecording, Lead
from services.ghl import GHL_BASE, _headers

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def probe_ghl_call_endpoints(lead) -> dict:
    """Sprint 4 T4.A probe (2026-06-07). Hits the three most likely GHL
    endpoints for finding call recordings and returns the raw response
    shape from each so we can see what GHL actually exposes for this
    account before committing to a code path. Admin-only via the
    /calls/ghl-call-probe endpoint that wraps this.

    Probes (in order):
      1. /conversations/search?contactId=...  (lists conversation IDs)
      2. /conversations/{cid}/messages         (per-conversation messages,
          calls usually arrive as messageType TYPE_CALL with a recordingUrl)
      3. /conversations/calls?contactId=...    (guess — a direct calls list)

    Returns a structured dict with status codes + body snippets for each."""
    contact_id = (lead.ghl_contact_id or "").strip()
    location_id = (lead.ghl_location_id or "").strip() or None
    if not contact_id:
        return {"error": "Lead has no ghl_contact_id"}

    out: dict = {
        "lead_id": lead.id,
        "ghl_contact_id": contact_id,
        "ghl_location_id": location_id or "",
        "probes": [],
    }
    headers = _headers(location_id)

    # --- Probe 1: list conversations for this contact ---
    convo_id_for_step_2 = None
    try:
        r = httpx.get(
            f"{GHL_BASE}/conversations/search",
            params={"contactId": contact_id, "limit": 20},
            headers=headers,
            timeout=15,
        )
        body_preview = r.text[:600]
        try:
            payload = r.json()
        except Exception:
            payload = None
        # Try to grab a conversation id to use in probe 2
        if payload and isinstance(payload, dict):
            convos = payload.get("conversations") or []
            if convos:
                convo_id_for_step_2 = convos[0].get("id")
        out["probes"].append({
            "name": "1_conversations_search",
            "url": f"{GHL_BASE}/conversations/search?contactId={contact_id}&limit=20",
            "status_code": r.status_code,
            "body_preview": body_preview,
            "first_conversation_id": convo_id_for_step_2,
        })
    except Exception as e:
        out["probes"].append({"name": "1_conversations_search", "error": str(e)})

    # --- Probe 2: fetch messages for that first conversation (calls usually
    #              arrive here as TYPE_CALL message records with a recordingUrl) ---
    first_call_message_id: str | None = None
    if convo_id_for_step_2:
        try:
            r = httpx.get(
                f"{GHL_BASE}/conversations/{convo_id_for_step_2}/messages",
                params={"limit": 50},
                headers=headers,
                timeout=15,
            )
            body_preview = r.text[:2000]   # bigger preview here — we want to see the call shape
            # Hunt for any messageType that smells like a call
            call_message_samples: list = []
            try:
                payload = r.json()
                msgs = (payload.get("messages") or {}).get("messages") or []
                for m in msgs:
                    mt = (m.get("messageType") or m.get("type") or "").upper()
                    if "CALL" in mt:
                        # Cache the first CALL id so probes 4–6 can use it
                        # to find the recording endpoint.
                        if first_call_message_id is None:
                            first_call_message_id = m.get("id")
                        call_message_samples.append({
                            "id": m.get("id"),
                            "messageType": mt,
                            "direction": m.get("direction"),
                            "dateAdded": m.get("dateAdded"),
                            "duration": m.get("duration"),
                            "recordingUrl": m.get("recordingUrl"),
                            "attachments": m.get("attachments"),
                            "meta": m.get("meta"),
                            "raw_keys": list(m.keys()),
                        })
                        if len(call_message_samples) >= 3:
                            break
            except Exception:
                pass
            out["probes"].append({
                "name": "2_conversation_messages",
                "url": f"{GHL_BASE}/conversations/{convo_id_for_step_2}/messages",
                "status_code": r.status_code,
                "body_preview": body_preview,
                "call_message_samples": call_message_samples,
            })
        except Exception as e:
            out["probes"].append({"name": "2_conversation_messages", "error": str(e)})

    # --- Probe 3: speculative direct calls endpoint ---
    try:
        r = httpx.get(
            f"{GHL_BASE}/conversations/calls",
            params={"contactId": contact_id, "limit": 20},
            headers=headers,
            timeout=15,
        )
        out["probes"].append({
            "name": "3_direct_calls_endpoint_guess",
            "url": f"{GHL_BASE}/conversations/calls?contactId={contact_id}",
            "status_code": r.status_code,
            "body_preview": r.text[:600],
        })
    except Exception as e:
        out["probes"].append({"name": "3_direct_calls_endpoint_guess", "error": str(e)})

    # --- Probes 4–6: ONLY fire when we have a real TYPE_CALL message id from
    #                 probe 2. These pinpoint the recording URL location.
    if first_call_message_id:
        # 4 — single message detail endpoint. Some GHL accounts return the
        #     recordingUrl ONLY here, not in the list response.
        try:
            r = httpx.get(
                f"{GHL_BASE}/conversations/messages/{first_call_message_id}",
                headers=headers,
                timeout=15,
            )
            # Try to surface keys + key recording-relevant fields cleanly.
            sample = None
            try:
                pj = r.json()
                if isinstance(pj, dict):
                    sample = {
                        "raw_keys": list(pj.keys()),
                        "recordingUrl": pj.get("recordingUrl"),
                        "attachments": pj.get("attachments"),
                        "meta": pj.get("meta"),
                        # Some GHL accounts nest under .message
                        "nested_message_keys": list((pj.get("message") or {}).keys()) if isinstance(pj.get("message"), dict) else None,
                    }
            except Exception:
                pass
            out["probes"].append({
                "name": "4_single_message_detail",
                "url": f"{GHL_BASE}/conversations/messages/{first_call_message_id}",
                "status_code": r.status_code,
                "body_preview": r.text[:1200],
                "sample": sample,
            })
        except Exception as e:
            out["probes"].append({"name": "4_single_message_detail", "error": str(e)})

        # 5 — the documented recording endpoint shape. If 200 with audio
        #     content-type, this is our integration path: stream the body
        #     to disk and feed it into the existing transcriber.
        try:
            url_5 = (
                f"{GHL_BASE}/conversations/messages/{first_call_message_id}"
                f"/locations/{location_id}/recording" if location_id
                else f"{GHL_BASE}/conversations/messages/{first_call_message_id}/recording"
            )
            r = httpx.get(url_5, headers=headers, timeout=20)
            out["probes"].append({
                "name": "5_recording_endpoint",
                "url": url_5,
                "status_code": r.status_code,
                "content_type": r.headers.get("content-type", ""),
                "content_length_bytes": len(r.content),
                # Tiny preview — first 200 chars only since this might be binary.
                "body_preview": r.text[:200] if "json" in r.headers.get("content-type", "").lower() else f"<binary, {len(r.content)} bytes>",
            })
        except Exception as e:
            out["probes"].append({"name": "5_recording_endpoint", "error": str(e)})

        # 6 — transcription endpoint (bonus). If GHL transcribes calls
        #     server-side we can skip Deepgram entirely.
        try:
            url_6 = (
                f"{GHL_BASE}/conversations/messages/{first_call_message_id}"
                f"/locations/{location_id}/transcription" if location_id
                else f"{GHL_BASE}/conversations/messages/{first_call_message_id}/transcription"
            )
            r = httpx.get(url_6, headers=headers, timeout=15)
            out["probes"].append({
                "name": "6_transcription_endpoint",
                "url": url_6,
                "status_code": r.status_code,
                "body_preview": r.text[:600],
            })
        except Exception as e:
            out["probes"].append({"name": "6_transcription_endpoint", "error": str(e)})

    out["first_call_message_id"] = first_call_message_id
    return out


def backfill_v2_call_recordings(lookback_days: int = 90, sleep_between_leads: float = 1.0) -> dict:
    """One-shot backfill for Sterling (v2 pipeline) leads.

    Walks every NON-test, NON-archived v2 lead with a GHL contact id whose
    created_at or updated_at falls in the lookback window, ingests every
    new TYPE_CALL recording, and hands each off to the existing
    transcribe-then-analyze pipeline. Same idempotency guarantees as the
    10-min poller (`_ingest_calls_for_lead` dedupes by ghl_call_id), so
    re-running is safe and won't double-bill Deepgram.

    Throttling: `sleep_between_leads` seconds between leads so a large
    batch doesn't trip GHL's per-key rate limits and collateral-damage
    the live dashboard. Default 1.0s — at 500 leads that's ~8 min of
    pure sleep plus the actual fetch time.

    Intended for the admin POST /api/calls/backfill-sterling endpoint,
    fired as a BackgroundTask (the run can take 30-90 min for a full
    90-day backfill, well past any HTTP request timeout)."""
    import time
    from datetime import timedelta
    settings = get_settings()
    if not settings.ghl_api_key:
        return {"status": "skipped", "reason": "ghl_api_key not set"}

    cutoff_iso = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).isoformat()
    db = get_db()
    summary = {
        "lookback_days": lookback_days,
        "leads_scanned": 0,
        "calls_found": 0,
        "new_recordings": 0,
        "skipped_dedup": 0,
        "skipped_incomplete": 0,
        "audio_fetch_failed": 0,
        "errors": [],
    }
    try:
        leads = (
            db.query(Lead)
            .filter(Lead.ghl_contact_id.isnot(None), Lead.ghl_contact_id != "")
            .filter(Lead.is_test == False)                      # noqa: E712
            .filter(Lead.pipeline_version == "v2")              # Sterling only
            .filter(Lead.status != "archived")                  # skip archived
            .filter(
                (Lead.updated_at >= cutoff_iso) | (Lead.created_at >= cutoff_iso)
            )
            .all()
        )
        total = len(leads)
        logger.info(f"[backfill v2] starting — {total} Sterling leads in window")

        for i, lead in enumerate(leads, start=1):
            try:
                lead_stats = _ingest_calls_for_lead(db, lead)
                summary["calls_found"] += lead_stats["calls_found"]
                summary["new_recordings"] += lead_stats["new_recordings"]
                summary["skipped_dedup"] += lead_stats["skipped_dedup"]
                summary["skipped_incomplete"] += lead_stats["skipped_incomplete"]
                summary["audio_fetch_failed"] += lead_stats["audio_fetch_failed"]
                summary["leads_scanned"] += 1
                # Commit per-lead so progress survives a mid-run crash —
                # no need to redo the first 200 leads if lead 201 explodes.
                db.commit()
            except Exception as e:
                logger.warning(f"[backfill v2] lead {lead.id} ingest failed: {e}")
                summary["errors"].append({"lead_id": lead.id, "error": str(e)})
                db.rollback()

            # Progress every 25 leads keeps Railway log noise manageable
            # while still letting Alan watch it churn.
            if i % 25 == 0 or i == total:
                logger.info(
                    f"[backfill v2] progress {i}/{total} — "
                    f"new_recordings={summary['new_recordings']} "
                    f"dedup={summary['skipped_dedup']} "
                    f"fetch_failed={summary['audio_fetch_failed']}"
                )

            # Throttle between leads. Skip the sleep on the very last
            # iteration so we don't add unnecessary latency at the tail.
            if i < total and sleep_between_leads > 0:
                time.sleep(sleep_between_leads)

        logger.info(
            f"[backfill v2] COMPLETE — scanned={summary['leads_scanned']} "
            f"calls_found={summary['calls_found']} "
            f"new_recordings={summary['new_recordings']} "
            f"dedup={summary['skipped_dedup']} "
            f"fetch_failed={summary['audio_fetch_failed']} "
            f"errors={len(summary['errors'])}"
        )
        return summary
    except Exception as e:
        logger.error(f"[backfill v2] outer error: {e}")
        summary["error"] = str(e)
        return summary
    finally:
        db.close()


def poll_ghl_call_recordings(lookback_days: int = 60, max_leads: int = 200) -> dict:
    """Sprint 4 T4.A (2026-06-08). Walk recent leads, fetch new
    TYPE_CALL messages from GHL, download the WAV audio via the
    /conversations/messages/{id}/locations/{lid}/recording endpoint
    (confirmed by the 2026-06-07 probe — returns audio/x-wav binary
    directly), persist as CallRecording rows, and kick the existing
    transcribe→analyze pipeline.

    Scope (intentional cost control — every lead = a GHL API call):
      - Leads created OR updated in the last `lookback_days` days
      - Excludes is_test leads
      - Caps at `max_leads` per run to avoid burning quota when a
        large backlog appears
      - Idempotent: dedupes by ghl_call_id, skips calls already in our DB

    Returns a per-run summary the caller (poller schedule / admin
    trigger endpoint) can log."""
    settings = get_settings()
    if not settings.ghl_api_key:
        return {"status": "skipped", "reason": "ghl_api_key not set"}

    from datetime import timedelta
    cutoff_iso = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).isoformat()

    db = get_db()
    summary = {
        "leads_scanned": 0,
        "calls_found": 0,
        "new_recordings": 0,
        "skipped_dedup": 0,
        "skipped_incomplete": 0,
        "audio_fetch_failed": 0,
        "errors": [],
    }
    try:
        leads = (
            db.query(Lead)
            .filter(Lead.ghl_contact_id.isnot(None), Lead.ghl_contact_id != "")
            .filter(Lead.is_test == False)  # noqa: E712 SQLAlchemy needs ==
            .filter(
                (Lead.updated_at >= cutoff_iso) | (Lead.created_at >= cutoff_iso)
            )
            .limit(max_leads)
            .all()
        )

        for lead in leads:
            try:
                lead_stats = _ingest_calls_for_lead(db, lead)
                summary["calls_found"] += lead_stats["calls_found"]
                summary["new_recordings"] += lead_stats["new_recordings"]
                summary["skipped_dedup"] += lead_stats["skipped_dedup"]
                summary["skipped_incomplete"] += lead_stats["skipped_incomplete"]
                summary["audio_fetch_failed"] += lead_stats["audio_fetch_failed"]
                summary["leads_scanned"] += 1
            except Exception as e:
                logger.warning(f"poll_ghl_call_recordings: lead {lead.id} ingest failed: {e}")
                summary["errors"].append({"lead_id": lead.id, "error": str(e)})

        db.commit()
        logger.info(
            f"[call poller] scanned={summary['leads_scanned']} "
            f"new_recordings={summary['new_recordings']} "
            f"dedup={summary['skipped_dedup']} "
            f"incomplete={summary['skipped_incomplete']} "
            f"fetch_failed={summary['audio_fetch_failed']}"
        )
        return summary

    except Exception as e:
        logger.error(f"poll_ghl_call_recordings outer error: {e}")
        summary["error"] = str(e)
        return summary
    finally:
        db.close()


def _ingest_calls_for_lead(db, lead) -> dict:
    """Fetch one lead's conversations + their messages, persist new
    TYPE_CALL completed-status messages as CallRecording rows, and
    fire the transcribe→analyze pipeline for each. Returns per-lead
    counts the caller aggregates."""
    from services.ghl import get_conversations, get_conversation_messages
    import uuid as _uuid

    stats = {
        "calls_found": 0,
        "new_recordings": 0,
        "skipped_dedup": 0,
        "skipped_incomplete": 0,
        "audio_fetch_failed": 0,
    }

    contact_id = (lead.ghl_contact_id or "").strip()
    location_id = (lead.ghl_location_id or "").strip() or None
    if not contact_id:
        return stats

    conversations = get_conversations(contact_id, location_id)
    for convo in conversations:
        convo_id = convo.get("id")
        if not convo_id:
            continue
        messages = get_conversation_messages(convo_id, location_id)
        for msg in messages:
            msg_type = (msg.get("messageType") or "").upper()
            if msg_type != "TYPE_CALL":
                continue
            stats["calls_found"] += 1

            msg_id = msg.get("id", "")
            if not msg_id:
                continue

            # Dedupe — we already have this call in the DB.
            existing = (
                db.query(CallRecording)
                .filter(CallRecording.ghl_call_id == msg_id)
                .first()
            )
            if existing:
                stats["skipped_dedup"] += 1
                continue

            # Skip incomplete calls — no recording to download.
            call_meta = (msg.get("meta") or {}).get("call") or {}
            call_status = (call_meta.get("status") or "").lower()
            if call_status != "completed":
                stats["skipped_incomplete"] += 1
                continue

            duration = int(call_meta.get("duration") or 0)
            # Skip really short calls (< 5 sec) — usually instant hangups
            # with no useful audio. Keeps Deepgram tokens from being
            # burned on silence.
            if duration < 5:
                stats["skipped_incomplete"] += 1
                continue

            audio_bytes = _fetch_recording_audio(msg_id, location_id)
            if not audio_bytes:
                stats["audio_fetch_failed"] += 1
                continue

            # Persist. recording_data is deferred at the model level so
            # this row only loads the BLOB on explicit access — listing
            # endpoints stay cheap.
            recording = CallRecording(
                id=str(_uuid.uuid4()),
                lead_id=lead.id,
                ghl_contact_id=contact_id,
                ghl_location_id=location_id or "",
                ghl_call_id=msg_id,
                recording_data=audio_bytes,
                has_recording_data=True,
                duration_seconds=duration,
                call_direction=(msg.get("direction") or "outbound"),
                caller_name="",  # T4.D will resolve userId → User.name later
                status="pending",
                created_at=msg.get("dateAdded") or _now(),
            )
            db.add(recording)
            db.flush()
            stats["new_recordings"] += 1

            # Kick the pipeline. Best-effort — failures here don't
            # roll back the row write since the manual analyze endpoint
            # can retry later if Deepgram is having a moment.
            try:
                process_recording_pipeline(recording.id)
            except Exception as e:
                logger.warning(f"Pipeline kick failed for {recording.id}: {e}")

    return stats


def _fetch_recording_audio(message_id: str, location_id: str | None) -> bytes | None:
    """GET the WAV audio for a GHL call message via the endpoint the
    2026-06-07 probe confirmed:
        /conversations/messages/{messageId}/locations/{locationId}/recording
    Returns the binary bytes on success, None on any failure (logged)."""
    if not message_id:
        return None
    try:
        if location_id:
            url = f"{GHL_BASE}/conversations/messages/{message_id}/locations/{location_id}/recording"
        else:
            # Fallback when somehow a lead has no location_id — unlikely
            # but don't crash on it.
            url = f"{GHL_BASE}/conversations/messages/{message_id}/recording"
        r = httpx.get(url, headers=_headers(location_id), timeout=60)
        if r.status_code != 200:
            logger.warning(
                f"GHL recording fetch HTTP {r.status_code} for msg {message_id}: "
                f"{r.text[:200]}"
            )
            return None
        ctype = (r.headers.get("content-type") or "").lower()
        if "audio" not in ctype:
            logger.warning(
                f"GHL recording for {message_id} returned non-audio content-type: {ctype} "
                f"(body preview: {r.text[:200]})"
            )
            return None
        return r.content
    except Exception as e:
        logger.error(f"GHL recording fetch errored for {message_id}: {e}")
        return None


def process_recording_pipeline(recording_id: str):
    """
    Run the full pipeline: transcribe → analyze → update status.
    Called after a recording is saved (from poller or manual upload).
    """
    from services.call_transcriber import transcribe_recording, build_speaker_map
    from services.call_analyzer import analyze_call
    from database import CallTranscript, CallAnalysis, Estimate

    db = get_db()
    try:
        recording = db.query(CallRecording).filter(CallRecording.id == recording_id).first()
        if not recording:
            logger.error(f"Recording {recording_id} not found")
            return

        audio_data = recording.recording_data
        if not audio_data:
            # Try to download from URL
            if recording.recording_url:
                try:
                    with httpx.Client(timeout=60) as client:
                        resp = client.get(recording.recording_url)
                        resp.raise_for_status()
                        audio_data = resp.content
                except Exception as e:
                    logger.error(f"Failed to download recording: {e}")
                    recording.status = "failed"
                    db.commit()
                    return
            else:
                logger.error(f"No audio data for recording {recording_id}")
                recording.status = "failed"
                db.commit()
                return

        # Step 1: Transcribe
        logger.info(f"Transcribing recording {recording_id}...")
        result = transcribe_recording(audio_data)

        if not result["full_text"]:
            logger.warning(f"Empty transcript for recording {recording_id}")
            recording.status = "failed"
            db.commit()
            return

        speaker_map = build_speaker_map(
            result["segments"],
            recording.call_direction,
            recording.recorded_by or "",
        )

        transcript = CallTranscript(
            id=str(uuid.uuid4()),
            recording_id=recording_id,
            lead_id=recording.lead_id,
            full_text=result["full_text"],
            segments=json.dumps(result["segments"]),
            speaker_map=json.dumps(speaker_map),
            confidence=result["confidence"],
            created_at=_now(),
        )
        db.add(transcript)
        recording.status = "transcribed"
        recording.transcribed_at = _now()
        db.commit()
        logger.info(f"Transcript saved for recording {recording_id}")

        # Step 2: Analyze with Claude
        logger.info(f"Analyzing recording {recording_id}...")
        lead_context = None
        if recording.lead_id:
            lead = db.query(Lead).filter(Lead.id == recording.lead_id).first()
            estimate = db.query(Estimate).filter(Estimate.lead_id == recording.lead_id).order_by(Estimate.created_at.desc()).first()
            if lead:
                lead_context = {
                    "contact_name": lead.contact_name,
                    "address": lead.address,
                    "tiers": estimate.to_dict().get("tiers", {}) if estimate else {},
                }

        # Format transcript with speaker labels for analysis
        from services.call_transcriber import format_transcript_for_display
        labeled_text = format_transcript_for_display(result["segments"], speaker_map)

        # Pull the active coaching profile + recent reviews so the analyzer
        # can calibrate its evaluation to how Alan actually coaches.
        profile_text = None
        recent_reviews = []
        try:
            from services.coaching_profile import get_active_profile, fetch_recent_reviews
            profile = get_active_profile(db)
            profile_text = profile.profile_text if profile else None
            recent_reviews = fetch_recent_reviews(db, limit=5, exclude_recording_id=recording_id)
        except Exception as e:
            logger.warning(f"Coaching calibration fetch failed (analysis will run without it): {e}")

        analysis_result = analyze_call(labeled_text, lead_context, profile_text, recent_reviews)

        analysis = CallAnalysis(
            id=str(uuid.uuid4()),
            recording_id=recording_id,
            lead_id=recording.lead_id,
            summary=analysis_result["summary"],
            summary_one_line=analysis_result.get("summary_one_line", ""),
            stage_evaluation=json.dumps(analysis_result.get("stage_evaluation", [])),
            boundary_violations=json.dumps(analysis_result.get("boundary_violations", [])),
            what_went_well=analysis_result.get("what_went_well", ""),
            next_action=analysis_result.get("next_action", ""),
            coaching_tips=json.dumps(analysis_result["coaching_tips"]),
            sentiment=analysis_result["sentiment"],
            customer_sentiment=analysis_result["customer_sentiment"],
            objections=json.dumps(analysis_result["objections"]),
            key_topics=json.dumps(analysis_result["key_topics"]),
            customer_data_extracted=json.dumps(analysis_result["customer_data_extracted"]),
            call_score=analysis_result["call_score"],
            close_likelihood=analysis_result["close_likelihood"],
            created_at=_now(),
        )
        db.add(analysis)
        recording.status = "analyzed"
        recording.analyzed_at = _now()
        db.commit()
        logger.info(f"Analysis saved for recording {recording_id} | score={analysis_result['call_score']}/10")

    except Exception as e:
        db.rollback()
        logger.error(f"Recording pipeline error for {recording_id}: {e}")
        try:
            recording = db.query(CallRecording).filter(CallRecording.id == recording_id).first()
            if recording:
                recording.status = "failed"
                db.commit()
        except Exception:
            pass
    finally:
        db.close()
