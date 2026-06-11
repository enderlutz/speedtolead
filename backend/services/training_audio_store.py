"""Upload + index voice training audio segments.

Each practice call yields a stream of small audio files: one webm/opus
blob per rep utterance, one mp3 per persona reply. We upload them to
Supabase Storage so they survive Railway redeploys and don't bloat the
SQLite/Postgres DB (avoiding the egress crisis we already paid for).
The DB only stores the segment list — URLs, speaker roles, ordering.

Bucket layout: <SUPABASE_TRAINING_AUDIO_BUCKET>/<session_id>/<role>-<padded_idx>.<ext>

Degrades to a no-op when Supabase Storage isn't configured: returns None
on upload + records nothing. The conversation loop continues with text-
only playback. Same forgiving pattern as ElevenLabs TTS.
"""
from __future__ import annotations
import logging
from typing import Optional

from config import get_settings
from services.supabase_storage import upload_image  # generic byte upload despite the name

logger = logging.getLogger(__name__)


def _bucket() -> str:
    return get_settings().supabase_training_audio_bucket or "training-audio"


def save_segment(
    session_id: str,
    seg_index: int,
    audio_bytes: bytes,
    role: str,
    content_type: str,
) -> Optional[dict]:
    """Upload one segment to Storage. Returns a segment dict on success
    or None if Storage is unavailable / the upload failed.

    `role` is 'rep' or 'persona'. `content_type` is 'audio/webm' or 'audio/mpeg'.
    Caller is responsible for appending the returned dict to the session's
    audio_segments_json list and persisting.
    """
    if not audio_bytes:
        return None

    ext = "webm" if "webm" in content_type else "mp3" if "mpeg" in content_type or "mp3" in content_type else "bin"
    safe_role = role if role in ("rep", "persona") else "seg"
    path = f"{session_id}/{safe_role}-{seg_index:04d}.{ext}"

    url = upload_image(_bucket(), path, audio_bytes, content_type=content_type)
    if not url:
        logger.debug(f"Training audio upload skipped or failed for session {session_id}")
        return None

    return {
        "turn_index": seg_index,
        "role": safe_role,
        "url": url,
        "content_type": content_type,
        "bytes": len(audio_bytes),
    }
