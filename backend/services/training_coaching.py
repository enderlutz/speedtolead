"""Corvette-sandwich coaching note system.

Per user (2026-06-12): mid-call, the rep (typically Alan) can drop the
trigger word "corvette" twice — first "corvette" opens the capture,
second "corvette" closes it. Everything spoken between the two becomes
a persisted coaching note.

These notes get injected into:
  - Future grill personas' backstories (so the customer knows what a
    great rep should be doing and can push when they don't)
  - The post-call grading prompt (so reps get scored against
    accumulated coaching rules)

The detector is a per-WS-session state machine. Once the second
"corvette" lands, we extract the sandwich text, persist a row, reset
the buffer, and the rep can drop another sandwich later in the same
call if they want.
"""
from __future__ import annotations
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from database import TrainingCoachingNote

logger = logging.getLogger(__name__)

# Trigger word — case-insensitive match against whole words only.
# `r"\bcorvette\b"` so transcripts like "I drive a corvette" still fire,
# but "concorvette" wouldn't. Reps are explicitly trained on the word,
# so collisions with normal sales talk are vanishingly rare.
_TRIGGER_PATTERN = re.compile(r"\bcorvette\b", re.IGNORECASE)


class CorvetteSandwichDetector:
    """Per-WS-session state machine for the trigger.

    Methods are sync — they're called from inside the WS receive loop
    where we already have a per-utterance text string.
    """

    def __init__(self) -> None:
        self._open: bool = False              # are we currently between two "corvette"s?
        self._buffer: list[str] = []          # rep utterances captured during the sandwich
        self._notes_captured: int = 0         # how many sandwiches this session produced

    @property
    def notes_captured(self) -> int:
        return self._notes_captured

    @property
    def is_capturing(self) -> bool:
        return self._open

    def process_utterance(
        self,
        text: str,
        db: Session,
        session_id: str,
        captured_by_user_id: str,
        captured_by_name: str,
    ) -> Optional[str]:
        """Feed one rep utterance into the detector.

        Returns the saved note text if a sandwich just closed on THIS
        utterance, else None. The caller can use the return value to
        emit a UI confirmation ("Coaching note saved").

        Logic:
        - If the utterance has TWO+ "corvette"s, the sandwich opens and
          closes in the same utterance — capture only what's between them.
        - If ONE "corvette" and we were closed → open + start buffering
          whatever comes after the trigger word (same utterance).
        - If ONE "corvette" and we were open → close, save buffered text
          + whatever was before the trigger in this utterance.
        - If NO "corvette" and we were open → append the utterance to
          the buffer.
        - If NO "corvette" and we were closed → no-op.
        """
        matches = list(_TRIGGER_PATTERN.finditer(text or ""))
        n = len(matches)

        if n == 0:
            if self._open:
                self._buffer.append(text)
            return None

        if n >= 2:
            # Self-contained sandwich in one utterance.
            start = matches[0].end()
            end = matches[-1].start()
            note_text = (text[start:end] or "").strip()
            self._open = False
            self._buffer = []
            return self._persist(note_text, db, session_id, captured_by_user_id, captured_by_name)

        # Exactly one trigger.
        m = matches[0]
        before = (text[: m.start()] or "").strip()
        after = (text[m.end() :] or "").strip()

        if not self._open:
            # First "corvette" — open. Anything after the trigger word in
            # the same utterance starts the capture.
            self._open = True
            self._buffer = []
            if after:
                self._buffer.append(after)
            return None

        # Second "corvette" — close. Anything BEFORE the trigger in this
        # utterance is the tail of the note.
        if before:
            self._buffer.append(before)
        note_text = " ".join(s for s in (b.strip() for b in self._buffer) if s).strip()
        self._buffer = []
        self._open = False
        # If anything came AFTER this closing trigger, treat it as the
        # opening of a new sandwich — lets the rep chain notes back-to-back.
        if after:
            self._open = True
            self._buffer.append(after)
        return self._persist(note_text, db, session_id, captured_by_user_id, captured_by_name)

    def _persist(
        self,
        note_text: str,
        db: Session,
        session_id: str,
        captured_by_user_id: str,
        captured_by_name: str,
    ) -> Optional[str]:
        if not note_text:
            logger.info(
                "Corvette sandwich closed with empty content — skipping persistence "
                "(session=%s, user=%s)",
                session_id, captured_by_user_id,
            )
            return None
        try:
            row = TrainingCoachingNote(
                id=f"coach_{uuid.uuid4().hex[:12]}",
                created_at=datetime.now(timezone.utc).isoformat(),
                note_text=note_text,
                captured_in_session_id=session_id,
                captured_by_user_id=captured_by_user_id,
                captured_by_name=captured_by_name,
                active=True,
            )
            db.add(row)
            db.commit()
            self._notes_captured += 1
            logger.info(
                "Corvette sandwich saved: id=%s note=%r session=%s user=%s",
                row.id, note_text[:80], session_id, captured_by_user_id,
            )
            return note_text
        except Exception as e:
            logger.error("Failed to persist coaching note: %s", e)
            db.rollback()
            return None


def list_active_notes(db: Session, limit: int = 50) -> list[str]:
    """All active coaching notes, newest first, returned as plain text.

    Used by `build_grill_persona()` and the post-call grader to inject
    accumulated rules. Capped at `limit` so the prompt doesn't blow up
    as notes accumulate over months of training.
    """
    rows = (
        db.query(TrainingCoachingNote)
        .filter(TrainingCoachingNote.active == True)
        .order_by(TrainingCoachingNote.created_at.desc())
        .limit(limit)
        .all()
    )
    return [r.note_text for r in rows if r.note_text]
