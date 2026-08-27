"""Call prep — everything we know about one customer, turned into a brief.

Pulls a lead's whole history in order (texts, call transcripts, the estimates
and prices we sent them) and hands it to Claude, which returns two things:

  1. What to talk about on the call — where this actually stands, what they
     already told us, what to open with, what to ask.
  2. Three text messages to send if they don't pick up — each one attacking a
     different reason they've gone quiet, so the rep picks the one that fits.

Written for the moment right before dialling: the rep opens the lead, hits the
button, reads for fifteen seconds, and calls. So the output is short and
specific, and it never pads. If we barely know the customer it says so rather
than inventing a backstory.

Note on coverage: only a fraction of call recordings are transcribed, so for
most leads this runs on texts + estimates. That's flagged in the output rather
than hidden, because a brief built on thin evidence should look thin.
"""
from __future__ import annotations
import json
import logging
from datetime import datetime, timezone

from config import get_settings
from database import (
    get_db, Lead, Message, CallTranscript, CallRecording, CallAnalysis, Estimate,
)

logger = logging.getLogger(__name__)

# Caps. A chatty customer can have hundreds of texts and an hour of transcript;
# past a point more history doesn't sharpen the brief, it just costs money and
# buries the recent signal that actually matters.
_MAX_MESSAGES = 60
_MAX_TRANSCRIPTS = 6
_TRANSCRIPT_CHARS = 5000
_MAX_ESTIMATES = 6

_SYSTEM = """You are prepping a fence-staining salesperson for a call they are about to make.

You will be given one customer's complete history with the company, in date order:
their text messages, transcripts of previous calls, and the estimates and prices
already sent to them.

Return ONLY a JSON object, no markdown fence, in exactly this shape:

{
  "headline": "One sentence: where this customer actually stands right now.",
  "where_it_stands": "2-4 sentences of plain summary. What they wanted, what we quoted, what they said last, how long it's been quiet. Reference specifics — prices, colours, dates, their own words.",
  "talking_points": [
    {"point": "Short imperative, 3-8 words", "detail": "One or two sentences on why, quoting them where it helps."}
  ],
  "questions_to_ask": ["A specific question this rep should actually ask on this call"],
  "watch_out": "Optional. Something that could blow the call — a complaint, a promise we made, a sensitivity. Empty string if nothing.",
  "messages": [
    {"angle": "2-4 word label for the approach",
     "rationale": "One line: why this angle, for this customer",
     "text": "The actual SMS, ready to send."}
  ]
}

RULES

- Exactly 3 messages. Each takes a DIFFERENT angle at why this specific customer
  has gone quiet — not three tones of the same message. Base the angles on what
  they actually said. Typical shapes: a light check-in; one that answers the
  objection they raised; one with a concrete reason to act now. If their history
  points somewhere else, go there instead.
- Messages are real SMS: 1-3 sentences, under 320 characters, first name only,
  no greeting block, no signature, no emoji, no ALL CAPS. Write how a person
  texts. Never invent a discount, price, date, or promise that isn't in the
  history. If you reference a price, it must be one we actually sent.
- 2 to 5 talking points, 1 to 4 questions. Fewer and sharper beats more.
- Ground everything in the record. Quote the customer where a quote lands harder
  than a paraphrase. Never invent history.
- If the history is thin, say so in where_it_stands and keep the brief short.
  A three-line honest brief is worth more than a page of guessing.
- Plain language. No sales-training vocabulary, no "leverage", no "circle back",
  no "reach out". Write like the owner talking to his rep."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _fmt_date(iso: str) -> str:
    if not iso:
        return "unknown date"
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).strftime("%b %d, %Y")
    except Exception:
        return iso[:10]


def _days_since(iso: str) -> int | None:
    if not iso:
        return None
    try:
        then = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if then.tzinfo is None:
            then = then.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - then).days
    except Exception:
        return None


def gather_history(lead_id: str) -> dict:
    """Everything we know about this customer, ordered oldest to newest.

    Returns the raw material plus counts, so the caller can tell the difference
    between "quiet customer" and "we have nothing on them"."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            return {}

        msgs = (
            db.query(Message)
            .filter(Message.lead_id == lead_id)
            .order_by(Message.created_at.asc())
            .all()
        )
        # Keep the most recent when over the cap — the newest exchange is the
        # one the call has to pick up from.
        msgs_kept = msgs[-_MAX_MESSAGES:]

        transcripts = (
            db.query(CallTranscript, CallRecording)
            .join(CallRecording, CallRecording.id == CallTranscript.recording_id)
            .filter(CallTranscript.lead_id == lead_id)
            .order_by(CallRecording.created_at.asc())
            .all()
        )
        transcripts_kept = transcripts[-_MAX_TRANSCRIPTS:]

        analyses = (
            db.query(CallAnalysis)
            .filter(CallAnalysis.lead_id == lead_id)
            .order_by(CallAnalysis.created_at.asc())
            .all()
        )

        estimates = (
            db.query(Estimate)
            .filter(Estimate.lead_id == lead_id)
            .order_by(Estimate.created_at.asc())
            .all()
        )
        estimates_kept = estimates[-_MAX_ESTIMATES:]

        # Total recordings vs transcribed ones — lets the UI be honest about
        # calls we have audio for but haven't transcribed.
        total_calls = (
            db.query(CallRecording).filter(CallRecording.lead_id == lead_id).count()
        )

        last_stamps = [m.created_at for m in msgs if m.created_at]
        last_stamps += [r.created_at for _, r in transcripts if r.created_at]
        last_contact = max(last_stamps) if last_stamps else ""

        return {
            "lead": lead,
            "messages": msgs_kept,
            "messages_total": len(msgs),
            "transcripts": transcripts_kept,
            "transcripts_total": len(transcripts),
            "analyses": analyses,
            "estimates": estimates_kept,
            "estimates_total": len(estimates),
            "calls_total": total_calls,
            "last_contact": last_contact,
        }
    finally:
        db.close()


def build_dossier(h: dict) -> str:
    """Flatten the history into the text block the model reads."""
    lead: Lead = h["lead"]
    out: list[str] = []

    out.append("=== CUSTOMER ===")
    out.append(f"Name: {lead.contact_name or '(unknown)'}")
    if lead.address:
        out.append(f"Address: {lead.address}")
    if lead.contact_phone:
        out.append(f"Phone: {lead.contact_phone}")
    if getattr(lead, "kanban_column", ""):
        out.append(f"Board stage: {lead.kanban_column}")
    if getattr(lead, "deposit_status", ""):
        out.append(f"Deposit: {lead.deposit_status}")
    out.append(f"In our system since: {_fmt_date(lead.created_at or '')}")
    days = _days_since(h.get("last_contact", ""))
    if days is not None:
        out.append(f"Days since last contact: {days}")

    ests = h["estimates"]
    out.append("\n=== ESTIMATES / PRICES WE SENT ===")
    if not ests:
        out.append("(none — we have never sent this customer a price)")
    for e in ests:
        line = f"[{_fmt_date(e.sent_at or e.created_at or '')}] {e.service_type or 'fence_staining'} — status {e.status or 'pending'}"
        tiers = {}
        try:
            tiers = json.loads(e.tiers or "{}")
        except Exception:
            pass
        if tiers:
            priced = []
            for name, val in tiers.items():
                if isinstance(val, dict):
                    val = val.get("price") or val.get("total") or ""
                if val:
                    priced.append(f"{name} ${val}")
            if priced:
                line += " | quoted: " + ", ".join(priced)
        elif e.estimate_low or e.estimate_high:
            line += f" | quoted ${e.estimate_low:.0f}-${e.estimate_high:.0f}"
        if e.closed_at:
            line += f" | CLOSED {e.closed_tier or ''} at ${e.closed_price or 0:.0f} on {_fmt_date(e.closed_at)}"
        if e.owner_notes:
            line += f" | notes: {e.owner_notes[:200]}"
        out.append(line)

    msgs = h["messages"]
    out.append("\n=== TEXT MESSAGES ===")
    if not msgs:
        out.append("(none)")
    if h["messages_total"] > len(msgs):
        out.append(f"(showing the {len(msgs)} most recent of {h['messages_total']})")
    for m in msgs:
        who = "CUSTOMER" if (m.direction or "") == "inbound" else "US"
        body = (m.body or "").strip()
        if body:
            out.append(f"[{_fmt_date(m.created_at or '')}] {who}: {body}")

    out.append("\n=== PHONE CALLS ===")
    tr = h["transcripts"]
    if h["calls_total"] and not tr:
        out.append(
            f"({h['calls_total']} call(s) recorded but none transcribed yet — "
            f"we don't know what was said)"
        )
    elif not tr:
        out.append("(no calls on record)")
    else:
        if h["calls_total"] > h["transcripts_total"]:
            out.append(
                f"(NOTE: {h['calls_total']} calls recorded, {h['transcripts_total']} transcribed. "
                f"Some conversations are missing from this history.)"
            )
        for t, rec in tr:
            text = (t.full_text or "").strip()
            if len(text) > _TRANSCRIPT_CHARS:
                text = text[:_TRANSCRIPT_CHARS] + " …[truncated]"
            out.append(f"\n--- Call on {_fmt_date(rec.created_at or '')} ---\n{text}")

    # The stored per-call analysis is cheap, already-distilled signal.
    objections: list[str] = []
    for a in h["analyses"]:
        try:
            objections += json.loads(a.objections or "[]")
        except Exception:
            pass
    if objections:
        out.append("\n=== OBJECTIONS LOGGED ON PAST CALLS ===")
        for o in objections[:12]:
            out.append(f"- {o}")

    return "\n".join(out)


def generate(lead_id: str) -> dict:
    """Build the brief. Raises RuntimeError with a readable message on failure."""
    settings = get_settings()
    if not settings.anthropic_api_key:
        raise RuntimeError("ANTHROPIC_API_KEY isn't set on the backend.")

    h = gather_history(lead_id)
    if not h:
        raise RuntimeError("Lead not found")

    dossier = build_dossier(h)
    thin = (
        h["messages_total"] == 0
        and h["transcripts_total"] == 0
        and h["estimates_total"] == 0
    )

    import anthropic

    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    try:
        resp = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=2000,
            system=[{"type": "text", "text": _SYSTEM, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": dossier}],
        )
    except Exception as e:
        logger.exception("Call prep generation failed")
        raise RuntimeError(f"Couldn't reach Claude: {e}")

    raw = resp.content[0].text if resp.content else ""
    clean = raw.strip()
    if clean.startswith("```"):
        clean = clean.split("\n", 1)[1] if "\n" in clean else clean
        clean = clean.rsplit("```", 1)[0]
    try:
        data = json.loads(clean)
    except Exception:
        logger.error(f"Call prep returned unparseable JSON: {raw[:400]}")
        raise RuntimeError("The brief came back malformed. Try again.")

    usage = resp.usage
    logger.info(
        f"Call prep for {lead_id} | in={usage.input_tokens} out={usage.output_tokens}"
    )

    # Never hand the UI a half-shaped object — it renders these directly.
    msgs = data.get("messages") or []
    data["messages"] = [
        {
            "angle": str(m.get("angle") or "Follow up"),
            "rationale": str(m.get("rationale") or ""),
            "text": str(m.get("text") or "").strip(),
        }
        for m in msgs if isinstance(m, dict) and (m.get("text") or "").strip()
    ][:3]
    data["talking_points"] = [
        {"point": str(p.get("point") or ""), "detail": str(p.get("detail") or "")}
        for p in (data.get("talking_points") or []) if isinstance(p, dict)
    ]
    data["questions_to_ask"] = [str(q) for q in (data.get("questions_to_ask") or []) if str(q).strip()]
    data["headline"] = str(data.get("headline") or "")
    data["where_it_stands"] = str(data.get("where_it_stands") or "")
    data["watch_out"] = str(data.get("watch_out") or "")

    data["evidence"] = {
        "texts": h["messages_total"],
        "calls_recorded": h["calls_total"],
        "calls_transcribed": h["transcripts_total"],
        "estimates": h["estimates_total"],
        "last_contact": h["last_contact"],
        "days_since_contact": _days_since(h["last_contact"]),
        "thin": thin,
    }
    data["generated_at"] = _now()
    return data
