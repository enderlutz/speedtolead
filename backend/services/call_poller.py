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

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def poll_ghl_call_recordings():
    """
    Poll GHL for new call recordings.

    TODO: Once GHL call recording API endpoint is confirmed, implement:
    1. Fetch recent calls for each location
    2. Match to leads by ghl_contact_id
    3. Download recording
    4. Create CallRecording row (dedup by ghl_call_id)
    5. Trigger transcription + analysis pipeline
    """
    settings = get_settings()
    if not settings.ghl_api_key:
        return

    db = get_db()
    try:
        # Get leads that have GHL contact IDs (potential call targets)
        leads_with_contacts = (
            db.query(Lead)
            .filter(Lead.ghl_contact_id.isnot(None), Lead.ghl_contact_id != "")
            .limit(50)
            .all()
        )

        if not leads_with_contacts:
            return

        # TODO: Replace with actual GHL call recording API call
        # Example of what it would look like:
        #
        # for location_id, api_key in locations:
        #     headers = {"Authorization": f"Bearer {api_key}", "Version": "2021-07-28"}
        #     resp = httpx.get(
        #         f"https://services.leadconnectorhq.com/conversations/calls",
        #         params={"locationId": location_id, "limit": 50},
        #         headers=headers,
        #     )
        #     for call in resp.json().get("calls", []):
        #         ghl_call_id = call["id"]
        #         # Check if already in DB
        #         existing = db.query(CallRecording).filter(
        #             CallRecording.ghl_call_id == ghl_call_id
        #         ).first()
        #         if existing:
        #             continue
        #         # Download recording
        #         recording_resp = httpx.get(call["recordingUrl"])
        #         # Create record + trigger pipeline
        #         _process_new_recording(db, recording_resp.content, call, lead)

        logger.debug("Call recording poller: GHL endpoint not yet configured")

    except Exception as e:
        logger.error(f"Call recording poller error: {e}")
    finally:
        db.close()


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

        speaker_map = build_speaker_map(result["segments"], recording.call_direction)

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

        analysis_result = analyze_call(labeled_text, lead_context)

        analysis = CallAnalysis(
            id=str(uuid.uuid4()),
            recording_id=recording_id,
            lead_id=recording.lead_id,
            summary=analysis_result["summary"],
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
