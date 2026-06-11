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
# on every account. Used as the fallback when a persona's voice_id is
# unset or points at a voice not in the user's library.
DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"

# Voice catalog (Phase 2). These are ElevenLabs' built-in "core" voices,
# available on every account regardless of plan tier. Each persona maps
# to one of these via voice_id == catalog key. Add fresh entries here
# when the user adds custom-cloned voices to their library.
VOICE_CATALOG: dict[str, dict] = {
    # Older deep male — Texan retiree vibe
    "adam_mature": {
        "id": "pNInz6obpgDQGcFmaJgB",
        "label": "Adam (deep mature male)",
        "settings": {"stability": 0.55, "similarity_boost": 0.80, "style": 0.30},
    },
    # Older softer male
    "antoni_warm": {
        "id": "ErXwobaYiN019PkySvjV",
        "label": "Antoni (warm older male)",
        "settings": {"stability": 0.50, "similarity_boost": 0.75, "style": 0.30},
    },
    # Young friendly male
    "sam_young": {
        "id": "yoZ06aMxZJJ28mfd3POQ",
        "label": "Sam (young friendly male)",
        "settings": {"stability": 0.40, "similarity_boost": 0.70, "style": 0.45},
    },
    # Mid-age female — detail-oriented, friendly
    "domi_midage": {
        "id": "AZnzlk1XvdvUeBnXmlld",
        "label": "Domi (mid-age female)",
        "settings": {"stability": 0.45, "similarity_boost": 0.75, "style": 0.35},
    },
    # Young female — busy mom, fast-talking
    "bella_busy": {
        "id": "EXAVITQu4vr4xnSDxMaL",
        "label": "Bella (young female)",
        "settings": {"stability": 0.35, "similarity_boost": 0.70, "style": 0.50},
    },
    # Default narrator (fallback)
    "default": {
        "id": DEFAULT_VOICE_ID,
        "label": "Rachel (default)",
        "settings": {"stability": 0.45, "similarity_boost": 0.75, "style": 0.35},
    },
}


def resolve_voice(voice_id: str) -> dict:
    """Look up a voice catalog entry. Falls back to default for unknowns."""
    if voice_id in VOICE_CATALOG:
        return VOICE_CATALOG[voice_id]
    return VOICE_CATALOG["default"]


def is_configured() -> bool:
    return bool(get_settings().elevenlabs_api_key)


def tts_to_mp3(text: str, voice_id: str = "default", model_id: str = "eleven_turbo_v2_5") -> bytes:
    """Synthesize text to MP3 bytes via ElevenLabs.

    `voice_id` is a catalog key from VOICE_CATALOG (e.g. "adam_mature"),
    not the raw ElevenLabs voice UUID. The catalog handles the indirection
    so personas can be reassigned to different voices without touching the
    UUIDs.

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

    voice = resolve_voice(voice_id)
    resolved_uuid = voice["id"]
    voice_settings = {
        **voice["settings"],
        "use_speaker_boost": True,
    }

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{resolved_uuid}"
    headers = {
        "xi-api-key": settings.elevenlabs_api_key,
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
    }
    payload = {
        "text": text,
        "model_id": model_id,
        "voice_settings": voice_settings,
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
