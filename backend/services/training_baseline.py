"""Alan-baseline gold-standard tracking.

Per user (2026-06-12): "we can have a baseline where it detects Alan
Bonner's call with this grilling call, so we can show the sales rep
where they should be."

Mechanism: when Alan completes a grill session, the system marks that
session as a baseline (TrainingSession.is_baseline = True). Future
reps' grill sessions get graded with reference to Alan's baseline so
the coach can say "Alan handled this question by saying X — yours
was vaguer."

We detect Alan by username — `alanbonner` is the seeded admin account
in `api/auth.py`. If the account ever changes, only this constant needs
to update.
"""
from __future__ import annotations
import logging
from typing import Optional

from sqlalchemy.orm import Session

from database import TrainingSession

logger = logging.getLogger(__name__)


# The single source of truth for "who is Alan." If we ever rename the
# account or add a second baseline owner, this is the one knob.
BASELINE_USERNAME = "alanbonner"


def maybe_mark_session_as_baseline(
    session_row: TrainingSession,
    db: Session,
) -> bool:
    """If the session's rep is Alan AND it's a grill call AND it has a
    transcript with at least a couple of turns, flag it as baseline.
    Returns True if it was newly marked, False otherwise.

    Called from the WS finalize path so every Alan grill call gets
    captured without needing a separate "save as baseline" button.
    """
    if not session_row:
        return False
    if (session_row.rep_user_id or "").lower() != BASELINE_USERNAME:
        return False
    if (session_row.persona_source or "") != "grill":
        return False
    if session_row.is_baseline:
        return False
    # Sanity check: at least 4 turns (greeting + rep + persona + rep) so
    # we don't bless an empty call as the gold standard.
    try:
        import json as _json
        history = _json.loads(session_row.transcript_json or "[]")
    except Exception:
        history = []
    if len(history) < 4:
        logger.info(
            "Skipping baseline mark for session %s — only %d turns",
            session_row.id, len(history),
        )
        return False
    try:
        session_row.is_baseline = True
        db.commit()
        logger.info(
            "Marked TrainingSession %s as Alan baseline (turns=%d)",
            session_row.id, len(history),
        )
        return True
    except Exception as e:
        logger.error("Failed to mark session as baseline: %s", e)
        db.rollback()
        return False


def get_latest_baseline_session(db: Session) -> Optional[TrainingSession]:
    """Most recent Alan-tagged baseline session, or None."""
    return (
        db.query(TrainingSession)
        .filter(TrainingSession.is_baseline == True)
        .order_by(TrainingSession.started_at.desc())
        .first()
    )


def list_baseline_excerpts(db: Session, limit: int = 15) -> list[str]:
    """Pull Alan's actual answers (assistant→rep utterances) from the
    most recent baseline session, formatted as short reference excerpts.

    NOTE: in our training transcript, the REP's utterances are stored
    with role=`user` (because the persona is the AI assistant). When Alan
    is the rep, his answers ARE the user-role turns. Those are the gold
    standard we want to show downstream prompts.
    """
    sess = get_latest_baseline_session(db)
    if not sess:
        return []
    try:
        import json as _json
        history = _json.loads(sess.transcript_json or "[]")
    except Exception:
        return []
    excerpts: list[str] = []
    for turn in history:
        if turn.get("role") != "user":
            continue
        content = (turn.get("content") or "").strip()
        if not content:
            continue
        # Skip very short fillers — those aren't useful gold-standard refs
        if len(content) < 25:
            continue
        # Trim huge answers to first ~280 chars to keep the prompt budget sane.
        if len(content) > 280:
            content = content[:280].rstrip() + "..."
        excerpts.append(content)
        if len(excerpts) >= limit:
            break
    return excerpts


def get_latest_baseline_summary(db: Session) -> dict:
    """One-row metadata about the current baseline session — for UI use.
    Used by the Training page so Alan can see "your latest baseline was
    captured 3 days ago, 18 turns, 8 questions answered."
    """
    sess = get_latest_baseline_session(db)
    if not sess:
        return {"exists": False}
    try:
        import json as _json
        history = _json.loads(sess.transcript_json or "[]")
    except Exception:
        history = []
    return {
        "exists": True,
        "session_id": sess.id,
        "captured_at": sess.started_at or "",
        "turns": len(history),
        "duration_seconds": int(sess.duration_seconds or 0),
    }
