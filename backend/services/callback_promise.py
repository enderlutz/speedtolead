"""When a call ends with "call me back Monday", that is the next step.

Alan (2026-10-17, Marie Reed): "She told me she's not going to call me until
Monday, so that's when I should call her." The Contacts next step read only
timestamps, so an estimate she opened after the call turned into "Call
them" the same afternoon. This reads the last real call's transcript for the
day that was agreed, either way round: "I'll call you back Monday" (they
call us) or "call me Monday" / "I'll call you Monday" (we call them).

Plain phrase matching, no model: it costs nothing per page load and it
works on every call already recorded.
"""
from __future__ import annotations

import re
from datetime import date, timedelta

from clock import to_ct

WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
_WHEN = r"(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|later today|tonight|this evening|this afternoon)"
# "call (you|me) (back) (on|first thing|next) Monday", up to three words between.
_CALL = re.compile(r"\b(call|talk|get back to)\b((?:\s+[\w']+){0,4}?)\s+(?:on\s+|by\s+)?" + _WHEN + r"\b", re.I)
# The customer promising to ring us, not asking us to ring them.
_THEY_CALL = re.compile(r"\b(i'll|i will|i'm gonna|i am going to|let me)\s+(call|get back to)\s+you\b", re.I)


def _resolve(word: str, called: date) -> date:
    w = word.lower()
    if w == "tomorrow":
        return called + timedelta(days=1)
    if w == "next week":
        return called + timedelta(days=7 - called.weekday())  # the next Monday
    if w in WEEKDAYS:
        ahead = (WEEKDAYS.index(w) - called.weekday()) % 7
        return called + timedelta(days=ahead or 7)
    return called  # later today, tonight, this evening/afternoon


def find_promise(text: str, called_at) -> dict | None:
    """{"day": date, "word": "Monday", "they_call": bool} for the last day
    agreed on the call, or None. `called_at` is when the call happened."""
    called = to_ct(called_at)
    if not text or called is None:
        return None
    last = None
    for m in _CALL.finditer(text):
        last = m
    if last is None:
        return None
    # Look just before the phrase too: "I'll call you back Monday".
    start = max(0, last.start() - 20)
    they = bool(_THEY_CALL.search(text[start:last.end()]))
    word = last.group(3)
    return {"day": _resolve(word, called.date()), "word": word.strip().capitalize(), "they_call": they}
