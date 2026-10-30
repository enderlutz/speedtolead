"""The calendar invite says what was agreed on the call (Alan, 2026-10-30:
"go listen to the calls, go to the text messages, and build the calendar
invite based on how the call went… every single calendar invite. Don't just
make some bullshit up").

A customer's invite had said "we clean a day or two before, then stain on
Saturday… no need to be home" when the call had set cleaning Saturday 9–10
with the stain samples (she'd be home to pick), staining Sunday, and the
package still open between two. The template said what usually happens; the
call said what will.

Claude reads the customer's recent calls and texts and returns the plan in
plain words. Every line has to carry a short quote of what was actually said
or texted, and a line whose quote isn't found in the calls or texts is
dropped. Nothing said → the invite keeps its usual lines. Saved on the lead
(form_data["invite_from_call"]) so the invite reads the same each time and
the office can see what it was built from.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone

from database import CallRecording, CallTranscript, Lead, Message

logger = logging.getLogger(__name__)

MODEL = "claude-opus-5-5"
KEY = "invite_from_call"
MAX_CALL_CHARS = 60000
TIERS = ("essential", "signature", "legacy")

PROMPT = """You are reading the calls and texts between Sterling Fence Staining (Alan, the office, "Amy" who is Olga) and a customer who just booked. Write down only what was actually agreed or said about THIS job, for the customer's calendar invite.

The booked day on the invite is {day} ({weekday}). The calls happened on the dates shown. Turn "Saturday", "the day after", "next week" into real dates (YYYY-MM-DD) using those.

Return JSON only:
{{
  "visits": [{{"date": "YYYY-MM-DD", "what": "plain words: what happens that visit and who comes", "window": "arrival time if said, else empty", "quote": "..."}}],
  "home": {{"value": "yes" | "no" | "", "text": "plain words, e.g. You'll be home Saturday morning to pick the color", "quote": "..."}},
  "package": {{"choices": ["signature", "legacy"], "text": "plain words on the package decision", "quote": "..."}},
  "color": {{"text": "plain words on the color: what they want, the colors named as candidates, how they'll choose", "quote": "..."}},
  "talked_about": [{{"text": "one plain line about something agreed or promised (repairs and their prices, extra work, a promise like sealing the tops of the boards, a call before the job)", "quote": "..."}}]
}}

Rules:
- "quote" is a short exact phrase (4 to 15 words) copied from the call or texts that shows it. No quote, leave the item out.
- Leave out anything not said. Empty lists and empty strings are fine. Never fill in a usual practice that wasn't said.
- "package.choices" lists only packages still being decided between (signature, legacy, essential). One agreed package: just that one.
- Short, plain words a 60-year-old reads easily. No prices unless they were said. No card or bank numbers.
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def sources(db, lead_id: str) -> tuple[str, str]:
    """(the calls, the texts) as text with dates, newest calls first, capped."""
    calls = (db.query(CallTranscript.full_text, CallRecording.created_at)
             .join(CallRecording, CallTranscript.recording_id == CallRecording.id)
             .filter(CallRecording.lead_id == lead_id, CallTranscript.full_text.isnot(None))
             .order_by(CallRecording.created_at.desc()).limit(6).all())
    call_txt, used = [], 0
    for text, at in calls:
        t = (text or "").strip()
        if len(t) < 200 or used >= MAX_CALL_CHARS:    # voicemails and blanks
            continue
        t = t[: MAX_CALL_CHARS - used]
        used += len(t)
        call_txt.append(f"=== Call on {str(at)[:10]} ===\n{t}")
    msgs = (db.query(Message.body, Message.direction, Message.created_at)
            .filter(Message.lead_id == lead_id).order_by(Message.created_at.desc()).limit(60).all())
    text_lines = [f"{str(at)[:10]} {'customer' if d == 'inbound' else 'us'}: {b.strip()}"
                  for b, d, at in reversed(msgs) if (b or "").strip() and not (b or "").startswith("Opportunity ")]
    scrub = lambda s: re.sub(r"(?:\d[ -]?){12,19}", "[number]", s)  # noqa: E731
    return scrub("\n\n".join(call_txt)), scrub("\n".join(text_lines))


def _ask(day: str, calls: str, texts: str) -> dict:
    import anthropic
    from config import get_settings
    key = get_settings().anthropic_api_key
    if not key:
        return {}
    wd = datetime.strptime(day, "%Y-%m-%d").strftime("%A") if day else ""
    msg = anthropic.Anthropic(api_key=key).messages.create(
        model=MODEL, max_tokens=1500,
        messages=[{"role": "user", "content": PROMPT.format(day=day, weekday=wd)
                   + f"\n\nCALLS:\n{calls or '(none)'}\n\nTEXTS:\n{texts or '(none)'}"}])
    raw = "".join(getattr(b, "text", "") for b in msg.content)
    m = re.search(r"\{.*\}", raw, re.S)
    try:
        return json.loads(m.group(0)) if m else {}
    except ValueError:
        return {}


def verify(facts: dict, calls: str, texts: str) -> dict:
    """Keep only lines whose quote is really in the calls or texts."""
    hay = _norm(calls + "\n" + texts)

    def ok(item) -> bool:
        q = _norm((item or {}).get("quote", "")) if isinstance(item, dict) else ""
        return len(q.split()) >= 3 and q in hay

    out: dict = {"visits": [], "talked_about": []}
    for v in facts.get("visits") or []:
        if ok(v) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(v.get("date") or "")) and (v.get("what") or "").strip():
            out["visits"].append({"date": v["date"], "what": v["what"].strip(), "window": (v.get("window") or "").strip()})
    out["visits"].sort(key=lambda v: v["date"])
    h = facts.get("home") or {}
    if ok(h) and h.get("value") in ("yes", "no") and (h.get("text") or "").strip():
        out["home"] = {"value": h["value"], "text": h["text"].strip()}
    p = facts.get("package") or {}
    choices = [c for c in (p.get("choices") or []) if c in TIERS]
    if ok(p) and choices:
        out["package"] = {"choices": choices, "text": (p.get("text") or "").strip()}
    c = facts.get("color") or {}
    if ok(c) and (c.get("text") or "").strip():
        out["color"] = {"text": c["text"].strip()}
    for t in facts.get("talked_about") or []:
        if ok(t) and (t.get("text") or "").strip():
            out["talked_about"].append({"text": t["text"].strip()})
    return out


def build(db, lead: Lead, day: str) -> dict:
    """Read the calls and texts, keep what checks out, save it on the lead."""
    calls, texts = sources(db, lead.id)
    if not calls and not texts:
        return {}
    try:
        facts = verify(_ask(day, calls, texts), calls, texts)
    except Exception as e:  # noqa: BLE001 - the usual invite still goes
        logger.warning("invite_from_call failed for %s: %s", lead.id, e)
        return {}
    facts["built_at"] = _now()
    facts["for_day"] = day
    try:
        fd = json.loads(lead.form_data or "{}")
    except ValueError:
        fd = {}
    fd[KEY] = facts
    lead.form_data = json.dumps(fd)
    db.commit()
    return facts


def saved(lead: Lead, day: str = "") -> dict:
    """What was built for this lead, when it's for the same day."""
    try:
        f = (json.loads(lead.form_data or "{}") or {}).get(KEY) or {}
    except ValueError:
        return {}
    return f if f and (not day or f.get("for_day") == day) else {}
