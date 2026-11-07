"""The greeting on every text that carries a bill or a pay link.

"Good evening Mrs. Tran, ..." instead of "Hi ana, ..." (Alan, 2026-11-06).
Morning / afternoon / evening is Houston time at the moment the text is
written. Mr. or Mrs. plus the last name goes on only when we KNOW: the
call listener heard how the customer sounds and saved it on the lead, the
customer typed it in their own name ("Mrs. Jones"), or staff set it.
Nothing is guessed from the name, and any doubt means no label at all,
just the first name (Alan: "hear how the customer sounds before assuming
gender, and if they are transgender for whatever reason just don't put a
label").

The lead's form_data carries it:
  salutation       "Mr." | "Mrs." | "Ms." | "Dr." | "none"
  salutation_from  "call" (the listener) | "staff"
The listener only ever fills an empty slot or its own earlier answer, so a
person's choice sticks.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from zoneinfo import ZoneInfo

HOUSTON = ZoneInfo("America/Chicago")
KEY = "salutation"
FROM_KEY = "salutation_from"
NONE = "none"

LABELS = {"mr": "Mr.", "mister": "Mr.", "mrs": "Mrs.", "ms": "Ms.", "miss": "Ms.", "dr": "Dr.", "doctor": "Dr."}
VOICE = {"a man": "Mr.", "a woman": "Mrs."}        # what the listener may say → the label
SUFFIXES = {"jr", "sr", "ii", "iii", "iv"}

AFTERNOON_FROM, EVENING_FROM = 12, 17


def time_greeting(now: datetime | None = None) -> str:
    """Good morning before noon, afternoon until 5, evening after, Houston time."""
    now = now or datetime.now(HOUSTON)
    if now.tzinfo is not None:
        now = now.astimezone(HOUSTON)
    if now.hour < AFTERNOON_FROM:
        return "Good morning"
    if now.hour < EVENING_FROM:
        return "Good afternoon"
    return "Good evening"


def _clean(word: str) -> str:
    return re.sub(r"[.,;:]+$", "", (word or "").strip()).strip()


def _cap(word: str) -> str:
    """ana → Ana, d'angelo → D'Angelo, o'brien-smith → O'Brien-Smith."""
    return re.sub(r"(^|[-' ])([a-z])", lambda m: m.group(1) + m.group(2).upper(), word.lower())


def names(contact_name: str | None) -> tuple[str, str]:
    """(First, Last) with their capitals, honorifics and Jr./Sr. dropped.
    One word is a first name with no last name."""
    words = [_clean(w) for w in (contact_name or "").split()]
    words = [w for w in words if w]
    labelled = False
    while words and words[0].lower() in LABELS:
        words.pop(0)
        labelled = True
    while len(words) > 1 and words[-1].lower() in SUFFIXES:
        words.pop()
    if not words:
        return "", ""
    if len(words) == 1:
        # "Mrs. Jones" is a last name; "ana" is a first name.
        return ("", _cap(words[0])) if labelled else (_cap(words[0]), "")
    return _cap(words[0]), _cap(words[-1])


def typed_label(contact_name: str | None) -> str:
    """A label the customer typed into their own name ("Mrs. Jones")."""
    words = (contact_name or "").split()
    return LABELS.get(_clean(words[0]).lower(), "") if words else ""


def form(lead) -> dict:
    try:
        data = json.loads(getattr(lead, "form_data", None) or "{}")
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def label(lead) -> str:
    """Mr./Mrs./Ms./Dr. when we know it, else ''. "none" on the lead means a
    person decided there's no label, whatever a call said."""
    if lead is None:
        return ""
    chosen = str(form(lead).get(KEY) or "").strip()
    if chosen.lower() == NONE:
        return ""
    if chosen:
        return LABELS.get(chosen.lower().rstrip("."), chosen)
    return typed_label(getattr(lead, "contact_name", ""))


def who(lead) -> str:
    """"Mrs. Tran", or "Ana" when there's no label or no last name, or ''."""
    if lead is None:
        return ""
    first, last = names(getattr(lead, "contact_name", ""))
    lab = label(lead)
    if lab and last:
        return f"{lab} {last}"
    return first


def greet(lead, now: datetime | None = None) -> str:
    """"Good evening Mrs. Tran" / "Good evening Ana" / "Good evening"."""
    name = who(lead)
    return f"{time_greeting(now)} {name}" if name else time_greeting(now)


def greet_name(name: str | None, now: datetime | None = None) -> str:
    """The same for someone we only have a name for (the spouse who pays)."""
    first, _ = names(name)
    return f"{time_greeting(now)} {first}" if first else time_greeting(now)


def heard_voice(lead, heard: dict | None) -> str:
    """What the call listener heard ("customer_voice": a man / a woman /
    can't tell) onto the lead. Fills an empty slot or its own earlier
    answer only; "can't tell" writes nothing. Returns the label it set."""
    if lead is None or not isinstance(heard, dict):
        return ""
    lab = VOICE.get(str(heard.get("customer_voice") or "").strip().lower(), "")
    if not lab:
        return ""
    data = form(lead)
    if data.get(KEY) and data.get(FROM_KEY) != "call":
        return ""
    if data.get(KEY) == lab:
        return lab
    data[KEY], data[FROM_KEY] = lab, "call"
    lead.form_data = json.dumps(data)
    return lab


def set_label(lead, value: str) -> None:
    """Staff's word: "Mr.", "Mrs.", "Ms.", "Dr." or "none"."""
    data = form(lead)
    data[KEY], data[FROM_KEY] = (LABELS.get(value.lower().rstrip("."), value) if value.lower() != NONE else NONE), "staff"
    lead.form_data = json.dumps(data)
