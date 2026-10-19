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


# ── The time, when one was said (Alan, 2026-10-19) ──────────────────────────
# "call me back at 5", "give me a call around 6:30", "call me in an hour".
# Same plain matching: the words after a call phrase, within a few seconds of
# talk. Business hours read 1–7 as PM and 8–11 as AM.

_NUM = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
        "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "a": 1, "an": 1, "half an": 0.5, "thirty": 30,
        "fifteen": 15, "twenty": 20, "forty five": 45, "forty-five": 45}
_CALL_ANY = re.compile(r"\b(call|ring|talk|get back to|reach out|text)\b", re.I)
_CLOCK = re.compile(r"\b(?:at|around|about|after|by|like)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)"
                    r"(?:[:.](\d{2}))?(?:\s*(a\.?m\.?|p\.?m\.?|o'clock|in the (?:morning|afternoon|evening)))?", re.I)
_IN = re.compile(r"\bin\s+(half an|an|a|one|two|three|\d{1,3}|thirty|fifteen|twenty|forty[- ]five)\s+(hours?|minutes?|mins?)\b", re.I)


def _num(w: str) -> float:
    w = w.lower().strip()
    return float(w) if w.replace(".", "").isdigit() else float(_NUM.get(w, 0))


def find_callback_time(text: str, called_at) -> dict | None:
    """{"at": datetime (Houston), "they_call": bool, "words": "..."} for the
    last call phrase followed by a time, or None. A day word in the same
    breath ("Monday at 5") moves it to that day; a bare time that's already
    passed means tomorrow."""
    from datetime import datetime as _dt
    called = to_ct(called_at)
    if not text or called is None:
        return None
    best = None
    for m in _CALL_ANY.finditer(text):
        window = text[m.start(): m.end() + 70]
        t = _CLOCK.search(window) or _IN.search(window)
        if t:
            best = (m, t, window)
    if not best:
        return None
    m, t, window = best
    they = bool(_THEY_CALL.search(text[max(0, m.start() - 20): m.end() + 15]))
    if t.re is _IN:
        n, unit = _num(t.group(1)), t.group(2).lower()
        at = called + timedelta(hours=n) if unit.startswith("hour") else called + timedelta(minutes=n)
        return {"at": at, "they_call": they, "words": t.group(0)}
    hour = int(_num(t.group(1)))
    minute = int(t.group(2) or 0)
    if not 1 <= hour <= 12 or minute > 59:
        return None
    ampm = (t.group(3) or "").lower()
    if ampm.startswith("p") or "afternoon" in ampm or "evening" in ampm:
        hour = hour % 12 + 12
    elif ampm.startswith("a") or "morning" in ampm:
        hour = hour % 12
    elif hour <= 7 or hour == 12:
        hour = hour % 12 + 12                      # "at 5" in business hours
    day_word = re.search(_WHEN, window, re.I)
    day = _resolve(day_word.group(1), called.date()) if day_word else called.date()
    at = called.replace(year=day.year, month=day.month, day=day.day, hour=hour, minute=minute, second=0, microsecond=0)
    if not day_word and at <= called:
        at += timedelta(days=1)
    del _dt
    return {"at": at, "they_call": they, "words": t.group(0)}
