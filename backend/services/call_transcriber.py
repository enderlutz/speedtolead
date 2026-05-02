"""
Call transcription service using Deepgram.
Speaker diarization labels who said what.
"""
from __future__ import annotations
import logging
import httpx
from config import get_settings

logger = logging.getLogger(__name__)


def transcribe_recording(audio_data: bytes) -> dict:
    """
    Transcribe audio using Deepgram Nova-2 with speaker diarization.

    Returns: {
        full_text: str,
        segments: [{speaker: int, text: str, start: float, end: float}],
        confidence: float,
    }
    """
    settings = get_settings()
    if not settings.deepgram_api_key:
        logger.warning("DEEPGRAM_API_KEY not configured")
        return {"full_text": "", "segments": [], "confidence": 0.0}

    url = "https://api.deepgram.com/v1/listen"
    params = {
        "model": "nova-2",
        "language": "en",
        "smart_format": "true",
        "diarize": "true",        # Speaker diarization
        "punctuate": "true",
        "paragraphs": "true",
        "utterances": "true",     # Get utterance-level segments
    }
    headers = {
        "Authorization": f"Token {settings.deepgram_api_key}",
        "Content-Type": "audio/wav",  # Deepgram auto-detects format
    }

    try:
        with httpx.Client(timeout=120) as client:
            resp = client.post(url, params=params, headers=headers, content=audio_data)
            resp.raise_for_status()
            data = resp.json()

        result = data.get("results", {})
        channels = result.get("channels", [{}])
        alternatives = channels[0].get("alternatives", [{}]) if channels else [{}]
        best = alternatives[0] if alternatives else {}

        full_text = best.get("transcript", "")
        confidence = best.get("confidence", 0.0)

        # Extract utterances with speaker labels
        utterances = result.get("utterances", [])
        segments = []
        for utt in utterances:
            segments.append({
                "speaker": utt.get("speaker", 0),
                "text": utt.get("transcript", ""),
                "start": round(utt.get("start", 0), 2),
                "end": round(utt.get("end", 0), 2),
            })

        logger.info(f"Transcription complete | {len(segments)} segments | confidence={confidence:.2f}")
        return {
            "full_text": full_text,
            "segments": segments,
            "confidence": confidence,
        }

    except httpx.HTTPStatusError as e:
        logger.error(f"Deepgram API error {e.response.status_code}: {e.response.text[:200]}")
        return {"full_text": "", "segments": [], "confidence": 0.0}
    except Exception as e:
        logger.error(f"Transcription failed: {e}")
        return {"full_text": "", "segments": [], "confidence": 0.0}


def build_speaker_map(segments: list[dict], call_direction: str, team_name: str = "") -> dict:
    """
    Map speaker IDs to names based on call direction. Handles N speakers
    (e.g., customer + spouse + sales rep) — anyone who isn't the team is
    labeled "Customer". Use of multiple non-team speakers becomes "Customer A",
    "Customer B" etc. so the analyzer can tell them apart.

    Outbound call: speaker who talks first is the team member.
    Inbound call: speaker who talks first is the customer.

    `team_name` is the logged-in user who hit Record. Falls back to "Team" for
    polled GHL recordings where no user is attached.
    """
    if not segments:
        return {}

    label = (team_name or "").strip() or "Team"
    speaker_ids: list[str] = []
    for seg in segments:
        sid = str(seg.get("speaker", 0))
        if sid not in speaker_ids:
            speaker_ids.append(sid)

    first = speaker_ids[0]
    team_id = first if call_direction == "outbound" else (speaker_ids[1] if len(speaker_ids) > 1 else first)

    customer_ids = [s for s in speaker_ids if s != team_id]
    speaker_map = {team_id: label}
    if len(customer_ids) == 1:
        speaker_map[customer_ids[0]] = "Customer"
    else:
        for i, sid in enumerate(customer_ids):
            speaker_map[sid] = f"Customer {chr(ord('A') + i)}"
    return speaker_map


def format_transcript_for_display(segments: list[dict], speaker_map: dict) -> str:
    """Format transcript segments into readable text with speaker labels."""
    lines = []
    for seg in segments:
        speaker_id = str(seg.get("speaker", 0))
        speaker_name = speaker_map.get(speaker_id, f"Speaker {speaker_id}")
        lines.append(f"{speaker_name}: {seg.get('text', '')}")
    return "\n".join(lines)
