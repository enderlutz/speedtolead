"""Alan's nightly read of his Plaud recordings (2026-10-31: "every time I
finish a recording it uploads to here and every night you read all
transcripts and let me know what you think").

At 9 PM Houston, Claude reads the day's recordings and writes the brief:
what got decided, who owns what, what only Alan can do, what looks off, and
what Claude thinks. The short version is texted to Alan; new tasks go on his
Ideas/Tasks page as ideas, marked from Plaud.
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from database import Idea, get_db
from plaud_models import PlaudBrief, PlaudNote

logger = logging.getLogger(__name__)

HOU = ZoneInfo("America/Chicago")
MODEL = "claude-opus-5-5"
HOUR = 21
MAX_CHARS = 120000
AREAS = {"content", "marketing", "sales", "followup", "customer", "operations", "automation",
         "hiring", "accounting", "hoa", "expansion"}

PROMPT = """You are Alan's chief of staff at Sterling Fence Staining (Houston fence staining; crew stains, Alan sells and runs it; Olga texts as "Amy"). Below are today's recordings from his Plaud: his calls and meetings, transcribed. Read all of them and write his nightly brief.

Return JSON only:
{{
  "text": "the text message to Alan, under 600 characters, plain words: the 2-4 things that matter most tonight",
  "brief": "the full brief in plain words with short headings: Decided today / Who owes what / Only you can do / Looks off or inconsistent (scope, price, dates, a promise that may not be in the system) / What I think",
  "tasks": [{{"title": "a task Alan said he'd do or wants done and hasn't, one line", "area": "one of: content, marketing, sales, followup, customer, operations, automation, hiring, accounting, hoa, expansion"}}]
}}

Rules: only what was said; names as spoken (they may be misspelled, say so if unsure); no card, bank or SSN numbers; no more than 8 tasks; straight talk, no fluff.
"""


def scrub(s: str) -> str:
    s = re.sub(r"(?:\d[ -]?){12,19}", "[number]", s or "")
    return re.sub(r"\b\d{3}-\d{2}-\d{4}\b", "[number]", s)


def houston_day(iso: str) -> str:
    try:
        d = datetime.fromisoformat((iso or "").replace("Z", "+00:00"))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d.astimezone(HOU).strftime("%Y-%m-%d")
    except ValueError:
        return ""


def notes_for(db, day: str) -> list[PlaudNote]:
    return [n for n in db.query(PlaudNote).order_by(PlaudNote.recorded_at).all()
            if houston_day(n.recorded_at or n.received_at) == day]


def _ask(notes: list[PlaudNote]) -> dict:
    import anthropic
    from config import get_settings
    key = get_settings().anthropic_api_key
    if not key:
        return {}
    parts, used = [], 0
    for n in notes:
        t = f"=== {n.title or 'Recording'} ({n.recorded_at[:16]})\nSUMMARY: {n.summary}\nTRANSCRIPT: {n.transcript}"
        t = t[: MAX_CHARS - used]
        used += len(t)
        parts.append(t)
        if used >= MAX_CHARS:
            break
    msg = anthropic.Anthropic(api_key=key).messages.create(
        model=MODEL, max_tokens=3000,
        messages=[{"role": "user", "content": PROMPT + "\n\n" + scrub("\n\n".join(parts))}])
    raw = "".join(getattr(b, "text", "") for b in msg.content)
    m = re.search(r"\{.*\}", raw, re.S)
    try:
        return json.loads(m.group(0)) if m else {}
    except ValueError:
        return {}


def run(day: str | None = None, send=None) -> dict | None:
    """Write (once) the brief for a Houston day that has recordings."""
    day = day or datetime.now(HOU).strftime("%Y-%m-%d")
    db = get_db()
    try:
        if db.query(PlaudBrief).filter(PlaudBrief.day == day).first():
            return None
        notes = notes_for(db, day)
        if not notes:
            return None
        out = _ask(notes)
        if not out.get("brief"):
            return None
        now = datetime.now(timezone.utc).isoformat()
        text = (out.get("text") or "").strip()
        for t in (out.get("tasks") or [])[:8]:
            title = (t.get("title") or "").strip()
            if title and not db.query(Idea).filter(Idea.title == title).first():
                db.add(Idea(id=str(uuid.uuid4()), title=title[:300], area=t.get("area") if t.get("area") in AREAS else "operations",
                            stage="idea", timeframe="week", source="plaud", details=f"From your Plaud recordings, {day}.",
                            created_at=now, updated_at=now))
        db.add(PlaudBrief(day=day, body=out["brief"], text_sent=text, created_at=now))
        db.commit()
        if text:
            if send is None:
                from services.after_pay_hooks import alert_alan as send
            send(f"Tonight's brief from your recordings:\n{text}\n\nThe full brief is on Ideas/Tasks → Recordings.")
        return {"day": day, "notes": len(notes)}
    finally:
        db.close()


def tick() -> None:
    """Every few minutes: after 9 PM Houston, write tonight's brief."""
    if datetime.now(HOU).hour >= HOUR:
        run()
