"""Objection scanner — reads each new customer text and call transcript and
ticks every objection the customer gave.

Agreed with Alan on 2026-10-08 (see the test sheet in docs/):

* Fully automatic. Nobody picks a "main" objection; a rep can only remove a
  wrong tag.
* Many per customer, tagged per message or per transcript line, so a
  customer's objections can change over time.
* Whether an objection came before or after the estimate is decided HERE,
  from timestamps, never by the model. GHL stamps a call at the moment it
  started (ringing included), and the estimate is often sent mid-call, so
  each line's moment is call start + the line's offset in the transcript,
  compared with the first estimate send. A minute's grace covers the ring
  time the recording doesn't include.
* Transcript speaker labels are often swapped, so the model works out who
  the customer is from context.

Only the customer can raise an objection. Questions about how to buy are not
objections. "Stop texting me" is tagged opt_out and surfaced, never acted on
automatically.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta, timezone

from config import get_settings

logger = logging.getLogger(__name__)

MODEL = "claude-opus-5-5"
GRACE = timedelta(seconds=60)

# key -> (label, can still be won?)
CATEGORIES: dict[str, tuple[str, bool]] = {
    "price": ("Price", True),
    "timing": ("Timing", True),
    "spouse_family": ("Spouse / family", True),
    "shopping_quotes": ("Shopping quotes", True),
    "hoa": ("HOA", True),
    "financing": ("Financing", True),
    "scope": ("Scope", True),
    "fence_condition": ("Fence condition", True),
    "neighbors": ("Neighbours", True),
    "waiting_photos": ("Waiting on photos", True),
    "replacing_instead": ("Replacing instead", False),
    "diy": ("Doing it themselves", False),
    "went_elsewhere": ("Went elsewhere", False),
    "moving_selling": ("Moving / selling", False),
    "not_interested": ("No thanks", False),
    "opt_out": ("Asked us to stop", False),
}

SYSTEM_PROMPT = """You tag customer objections for Sterling Fence Staining, a fence cleaning and staining company in Houston. Staff send customers a written estimate with three packages (Essential, Signature, Legacy) and follow up by text and phone.

You will get one customer's recent conversation: texts (with ids) and call transcripts (with line indexes). Some items are marked NEW. Tag every objection the CUSTOMER raised in the NEW items only — earlier items are context.

An objection is a reason the customer gives for not buying, not buying now, or not buying as quoted. A customer can raise several in one message; tag each one separately. Most conversations have none — return an empty list then.

Categories:
- price: too expensive, over budget, more than expected, wants it cheaper, asks for a discount because of cost
- timing: not now, later, a future date, too busy, out of town, waiting on something unrelated. Vague stalls count as timing: "I need a little bit more time", "not sure at this time", "if/when I'm ready". Softer "let me think about it / look it over / I'll get back to you" count as timing with low confidence.
- spouse_family: needs to talk to a wife, husband, partner or family member first
- shopping_quotes: waiting on or comparing other companies' quotes
- hoa: needs HOA approval, or an HOA rule is a blocker
- financing: can't pay up front, wants monthly payments or financing
- scope: wants fewer or different sides, or less work, to bring the price down
- fence_condition: thinks the fence needs repair or replacement first, unsure staining is worth it
- neighbors: waiting on neighbours — their agreement, their availability, their fence being fixed or matching
- waiting_photos: we're waiting on the customer to send photos, a video or other information before we can quote, re-quote or go ahead (e.g. "I'll send you some pictures"). Tag it whether the customer offers or staff asks and the customer agrees.
- replacing_instead: has decided to replace the fence rather than stain it
- diy: will do it themselves
- went_elsewhere: hired another company, or already had it done
- moving_selling: moving or selling the house
- not_interested: no thanks, never mind, not interested, with no reason given
- opt_out: asks us to stop texting or calling, or to be removed

Not objections — never tag: questions about how to buy (colours, an HOA colour question that is not a blocker, which sides, weather, scheduling, how long it takes), compliments, scheduling logistics, complaints about work already done, anything staff said.

Only the customer can object. In call transcripts the speaker labels are often wrong or swapped — work out who the customer is from context (staff introduce themselves, explain packages, send the estimate).

For each objection give: category, source ("text" or "call"), source_id (the text id or call id exactly as given), line (the call line index, or null for a text), quote (the customer's exact words, at most 200 characters, copied verbatim), confidence ("high", or "low" when borderline)."""

SCHEMA = {
    "type": "object",
    "properties": {
        "objections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "category": {"type": "string", "enum": list(CATEGORIES)},
                    "source": {"type": "string", "enum": ["text", "call"]},
                    "source_id": {"type": "string"},
                    "line": {"type": ["integer", "null"]},
                    "quote": {"type": "string"},
                    "confidence": {"type": "string", "enum": ["high", "low"]},
                },
                "required": ["category", "source", "source_id", "line", "quote", "confidence"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["objections"],
    "additionalProperties": False,
}


def _ts(value) -> datetime | None:
    if not value:
        return None
    try:
        d = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def first_estimate_sent_at(db, lead_id: str) -> datetime | None:
    from database import Estimate
    rows = (
        db.query(Estimate.sent_at)
        .filter(Estimate.lead_id == lead_id, Estimate.sent_at.isnot(None),
                Estimate.status.in_(("sent", "closed")))
        .all()
    )
    stamps = sorted(t for t in (_ts(r[0]) for r in rows) if t)
    return stamps[0] if stamps else None


def classify_timing(said_at: datetime, sent_at: datetime | None, *, call_start: datetime | None = None,
                    call_seconds: int = 0) -> tuple[str, bool]:
    """("after_estimate" | "before_estimate", estimate sent during this call?).

    No estimate sent yet means before. If the estimate went out DURING the
    call, every objection on that call counts as after — Alan's rule
    (2026-10-08, Ray Rascoe and Michelle Stout): the customer is reacting to
    the estimate they're looking at, and line-by-line timing against GHL's
    ring-inclusive start time is too fragile to split one conversation.
    Otherwise a line's moment decides, with a minute's grace on calls for the
    ring time the recording doesn't include."""
    if sent_at is None:
        return "before_estimate", False
    mid_call = bool(call_start and call_start <= sent_at <= call_start + timedelta(seconds=call_seconds) + GRACE)
    if mid_call:
        return "after_estimate", True
    grace = GRACE if call_start else timedelta(0)
    return ("after_estimate" if said_at >= sent_at - grace else "before_estimate"), False


def _gather(db, lead, *, only_after: datetime | None):
    """The lead's conversation, with the items not yet scanned marked NEW.

    Returns (prompt_text, new_texts, new_calls) where the new_* maps hold what
    the timing needs: text id -> sent time, call id -> (start, seconds, lines).
    """
    from database import CallRecording, CallTranscript, Message, ObjectionScan

    scanned = {k for (k,) in db.query(ObjectionScan.source_key).filter(ObjectionScan.lead_id == lead.id).all()}
    msgs = (
        db.query(Message).filter(Message.lead_id == lead.id)
        .order_by(Message.created_at).all()
    )
    new_texts: dict[str, datetime] = {}
    lines_out: list[str] = []
    for m in msgs[-60:]:
        at = _ts(m.created_at)
        body = (m.body or "").strip()
        if not at or not body:
            continue
        is_new = (m.direction == "inbound" and f"text:{m.id}" not in scanned
                  and (only_after is None or at >= only_after))
        if is_new:
            new_texts[m.id] = at
        who = "CUSTOMER" if m.direction == "inbound" else "STAFF"
        lines_out.append(f"[text id={m.id} {at.isoformat()} {who}{' NEW' if is_new else ''}] {body[:800]}")

    new_calls: dict[str, tuple[datetime, int, list[dict]]] = {}
    calls = (
        db.query(CallRecording, CallTranscript)
        .join(CallTranscript, CallTranscript.recording_id == CallRecording.id)
        .filter(CallRecording.lead_id == lead.id)
        .all()
    )
    for rec, tr in calls:
        start = _ts(rec.created_at)
        if not start or f"call:{rec.id}" in scanned or getattr(rec, "is_voicemail", False):
            continue
        if only_after is not None and start < only_after:
            continue
        try:
            segs = json.loads(tr.segments or "[]")
            smap = json.loads(tr.speaker_map or "{}")
        except (ValueError, TypeError):
            continue
        if not segs:
            continue
        new_calls[rec.id] = (start, int(rec.duration_seconds or 0), segs)
        lines_out.append(f"\n[call id={rec.id} started {start.isoformat()} NEW]")
        for i, sg in enumerate(segs):
            who = smap.get(str(sg.get("speaker")), f"Speaker {sg.get('speaker')}")
            lines_out.append(f"  {i} ({who}): {(sg.get('text') or '').strip()}")
    return "\n".join(lines_out), new_texts, new_calls


def _call_model(conversation: str) -> list[dict]:
    import anthropic

    settings = get_settings()
    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    response = client.beta.messages.create(
        model=MODEL,
        max_tokens=4000,
        betas=["server-side-fallback-2026-07-01"],
        system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": conversation}],
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
        # Passed as raw body: the installed SDK predates the fallbacks field.
        extra_body={"fallbacks": "default"},
    )
    if response.stop_reason == "refusal":
        logger.warning("objection scan refused: %s", getattr(response, "stop_details", None))
        return []
    text = next((b.text for b in response.content if b.type == "text"), "")
    return json.loads(text or "{}").get("objections", [])


def scan_lead(db, lead_id: str, *, only_after: datetime | None = None, classify=None) -> dict:
    """Scan whatever is new on one lead. Idempotent: each text and call is read
    once. `classify` is injectable for tests."""
    from database import Lead, LeadObjection, ObjectionScan

    lead = db.query(Lead).filter(Lead.id == lead_id).first()
    if not lead:
        return {"ok": False, "error": "lead not found"}
    conversation, new_texts, new_calls = _gather(db, lead, only_after=only_after)
    if not new_texts and not new_calls:
        return {"ok": True, "scanned": 0, "found": 0}

    tags = (classify or _call_model)(conversation)
    sent_at = first_estimate_sent_at(db, lead_id)
    removed = {
        (r.source_id, r.line, r.category)
        for r in db.query(LeadObjection).filter(LeadObjection.lead_id == lead_id).all()
    }
    found = 0
    for t in tags:
        cat, src, sid = t.get("category"), t.get("source"), str(t.get("source_id") or "")
        if cat not in CATEGORIES:
            continue
        line = t.get("line") if src == "call" else None
        if src == "text" and sid in new_texts:
            said = new_texts[sid]
            timing, mid = classify_timing(said, sent_at)
        elif src == "call" and sid in new_calls and isinstance(line, int):
            start, secs, segs = new_calls[sid]
            if not (0 <= line < len(segs)):
                continue
            said = start + timedelta(seconds=float(segs[line].get("start") or 0))
            timing, mid = classify_timing(said, sent_at, call_start=start, call_seconds=secs)
        else:
            continue   # the model pointed at something it wasn't asked about
        if (sid, line, cat) in removed:
            continue
        db.add(LeadObjection(
            id=str(uuid.uuid4()), lead_id=lead_id, category=cat, source=src, source_id=sid,
            line=line, quote=str(t.get("quote") or "")[:300], said_at=said.isoformat(),
            timing=timing, mid_call_send=mid, confidence=t.get("confidence") or "high",
            created_at=_now(),
        ))
        removed.add((sid, line, cat))
        found += 1

    now = _now()
    for mid_ in new_texts:
        db.merge(ObjectionScan(source_key=f"text:{mid_}", lead_id=lead_id, scanned_at=now))
    for cid in new_calls:
        db.merge(ObjectionScan(source_key=f"call:{cid}", lead_id=lead_id, scanned_at=now))
    db.commit()
    return {"ok": True, "scanned": len(new_texts) + len(new_calls), "found": found}


def leads_due(db, since: datetime, limit: int) -> list[str]:
    """Leads with a customer text or a transcribed call since `since` that the
    scanner hasn't read yet."""
    from sqlalchemy import text as sql
    rows = db.execute(sql("""
        SELECT lead_id FROM (
          SELECT m.lead_id AS lead_id, MAX(m.created_at) AS t FROM messages m
          WHERE m.direction = 'inbound' AND m.lead_id IS NOT NULL AND m.created_at >= :since
            AND NOT EXISTS (SELECT 1 FROM objection_scans s WHERE s.source_key = 'text:' || m.id)
          GROUP BY m.lead_id
          UNION ALL
          SELECT r.lead_id, MAX(r.created_at) FROM call_recordings r
          JOIN call_transcripts c ON c.recording_id = r.id
          WHERE r.lead_id IS NOT NULL AND r.created_at >= :since
            AND NOT EXISTS (SELECT 1 FROM objection_scans s WHERE s.source_key = 'call:' || r.id)
          GROUP BY r.lead_id
        ) x GROUP BY lead_id ORDER BY MAX(t) DESC LIMIT :limit
    """), {"since": since.isoformat(), "limit": limit}).fetchall()
    return [r[0] for r in rows]


def scans_today(db) -> int:
    from database import ObjectionScan
    day = datetime.now(timezone.utc).date().isoformat()
    return db.query(ObjectionScan.lead_id).filter(ObjectionScan.scanned_at >= day).distinct().count()


def scanner_start(db) -> datetime:
    """The moment the scanner first ran. Automatic scanning only reads what
    arrives after it — older conversations are scanned on request, per lead,
    so turning this on can't run up an API bill over the whole history."""
    from database import SystemConfig
    row = db.query(SystemConfig).filter(SystemConfig.key == "objection_scan_started_at").first()
    if row and _ts(row.value):
        return _ts(row.value)
    now = datetime.now(timezone.utc)
    db.merge(SystemConfig(key="objection_scan_started_at", value=now.isoformat()))
    db.commit()
    return now


# The automatic scanner also reads this far back from the moment it first
# ran, once, so customers from just before it went live (Ray Rascoe and
# Michelle Stout, 2026-10-07) are covered without a button. Each text and
# call is still read only once, and the daily cap still applies.
BACKFILL_DAYS = 14


def sweep_once() -> dict:
    """One pass of the background loop."""
    from database import get_db
    settings = get_settings()
    if not settings.enable_objection_scan or not settings.anthropic_api_key:
        return {"skipped": True}
    db = get_db()
    try:
        start = scanner_start(db) - timedelta(days=BACKFILL_DAYS)
        room = max(0, settings.objection_scan_daily_cap - scans_today(db))
        done = found = 0
        for lead_id in leads_due(db, start, min(room, 20)):
            try:
                r = scan_lead(db, lead_id, only_after=start)
                done += 1
                found += r.get("found", 0)
            except Exception:   # one bad lead must not stop the sweep
                db.rollback()
                logger.exception("objection scan failed for %s", lead_id)
        return {"leads": done, "found": found}
    finally:
        db.close()
