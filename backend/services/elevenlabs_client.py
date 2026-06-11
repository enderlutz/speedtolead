"""ElevenLabs TTS wrapper for the voice training simulator.

Designed to fail gracefully: when ELEVENLABS_API_KEY is not set (e.g.
before the user signs up for ElevenLabs), `tts_to_mp3` returns an empty
bytes object instead of raising. The orchestrator treats that as
"text-only mode" — the conversation still flows, just without audio.
Once the key lands in env, audio kicks on with no code change.
"""
from __future__ import annotations
import logging
import httpx
from config import get_settings

logger = logging.getLogger(__name__)


# Default voice — "Rachel" is ElevenLabs' standard demo voice and exists
# on every account. Phase 2 will hand-pick a per-persona voice map.
DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"


def is_configured() -> bool:
    return bool(get_settings().elevenlabs_api_key)


def tts_to_mp3(text: str, voice_id: str = "default", model_id: str = "eleven_turbo_v2_5") -> bytes:
    """Synthesize text to MP3 bytes via ElevenLabs.

    Returns empty bytes if the API key is missing or the call fails — the
    orchestrator will route the persona's text response to the browser as
    text-only when this happens, so the practice loop still works.
    """
    settings = get_settings()
    if not settings.elevenlabs_api_key:
        logger.debug("ELEVENLABS_API_KEY not configured — returning silent TTS")
        return b""

    if not text or not text.strip():
        return b""

    resolved_voice = DEFAULT_VOICE_ID if (not voice_id or voice_id == "default") else voice_id

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{resolved_voice}"
    headers = {
        "xi-api-key": settings.elevenlabs_api_key,
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
    }
    payload = {
        "text": text,
        "model_id": model_id,
        "voice_settings": {
            "stability": 0.45,
            "similarity_boost": 0.75,
            "style": 0.35,
            "use_speaker_boost": True,
        },
    }

    try:
        with httpx.Client(timeout=30) as client:
            resp = client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
            return resp.content
    except httpx.HTTPStatusError as e:
        body = e.response.text[:200] if e.response is not None else ""
        logger.error(f"ElevenLabs API error {e.response.status_code}: {body}")
        return b""
    except Exception as e:
        logger.error(f"ElevenLabs TTS failed: {e}")
        return b""
