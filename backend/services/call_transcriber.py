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


def build_speaker_map(segments: list[dict], call_direction: str) -> dict:
    """
    Map speaker IDs to names based on call direction.
    Outbound call: Speaker who talks first is likely Alan/Olga.
    Inbound call: Speaker who talks first is likely the customer.
    """
    if not segments:
        return {}

    first_speaker = segments[0].get("speaker", 0)

    if call_direction == "outbound":
        return {
            str(first_speaker): "Team",
            str(1 - first_speaker): "Customer",
        }
    else:
        return {
            str(first_speaker): "Customer",
            str(1 - first_speaker): "Team",
        }


def format_transcript_for_display(segments: list[dict], speaker_map: dict) -> str:
    """Format transcript segments into readable text with speaker labels."""
    lines = []
    for seg in segments:
        speaker_id = str(seg.get("speaker", 0))
        speaker_name = speaker_map.get(speaker_id, f"Speaker {speaker_id}")
        lines.append(f"{speaker_name}: {seg.get('text', '')}")
    return "\n".join(lines)
