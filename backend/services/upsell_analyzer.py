"""Customer upsell analyzer.

Per user (2026-06-15): when a job lands in the
"COMPLETED JOB-HAPPY CUSTOMER- SEND REVIEW" kanban column, the team
calls the customer to (1) check how the fence is holding up, (2) ask
for a Google review, (3) pitch an upsell — exterior painting first,
or anything else the customer mentioned wanting during the original
sale.

This service does the prep work: it pulls everything we have on the
customer (call transcripts, SMS history, the estimate they signed,
internal notes, exterior-photo presence) and asks Claude to extract
structured talking points for the rep.

Runs on-demand from the Upsell tab — no caching, no background job.
A single Claude call per tab open is cheap and keeps the data current
if new texts came in between opens.
"""
from __future__ import annotations
import json
import logging
from typing import Optional

from sqlalchemy.orm import Session

from config import get_settings
from database import (
    Lead,
    CallTranscript,
    Message,
    Estimate,
)

logger = logging.getLogger(__name__)

CLAUDE_MODEL = "claude-sonnet-4-6"
MAX_TOKENS_PER_ANALYSIS = 1400  # Sections + draft SMS — generous ceiling
TRANSCRIPT_LIMIT = 5             # Newest N transcripts
TRANSCRIPT_CHAR_CAP = 6000       # Per-transcript truncation to keep prompt sane
SMS_LIMIT = 60                   # Newest N SMS messages from local cache
SMS_CHAR_CAP = 400               # Per-message truncation


def analyze_lead_for_upsell(lead_id: str, db: Session) -> dict:
    """Pull all conversation sources for the lead and ask Claude to
    produce structured upsell talking points. Returns the result
    dict ready to send to the frontend (no further shaping needed).

    Output envelope (also returned on error so the UI has something to
    render):
      {
        "status": "ok" | "skipped" | "error",
        "skip_reason"?: str,
        "what_they_bought": str,
        "pain_points": [str, ...],
        "things_mentioned": [str, ...],
        "recommended_upsell": {"type": str, "why": str, "hook": str},
        "suggested_opening": str,
        "draft_upsell_sms": str,
        "source_summary": {"transcripts": int, "sms": int, "has_exterior_photos": bool}
      }
    """
    lead = db.query(Lead).filter(Lead.id == lead_id).first()
    if not lead:
        return _error("Lead not found")

    settings = get_settings()
    if not settings.anthropic_api_key:
        return _error("ANTHROPIC_API_KEY not configured")

    sources = _collect_sources(lead, db)
    prompt = _build_prompt(lead, sources)
    raw = _call_claude(settings.anthropic_api_key, prompt)
    if raw is None:
        return _error("Claude returned no text")

    parsed = _safe_json_loads(raw)
    if not parsed:
        return _error("Claude returned malformed JSON")

    return _finalize(parsed, sources)


# ---------------------------------------------------------------- sources --

def _collect_sources(lead: Lead, db: Session) -> dict:
    """Pull every relevant piece of context for this lead. Order matters
    only for the prompt's narrative — the actual fetch is cheap."""
    transcripts: list[dict] = []
    rows = (
        db.query(CallTranscript)
        .filter(CallTranscript.lead_id == lead.id)
        .order_by(CallTranscript.created_at.desc())
        .limit(TRANSCRIPT_LIMIT)
        .all()
    )
    for r in rows:
        body = (r.full_text or "").strip()
        if not body:
            continue
        if len(body) > TRANSCRIPT_CHAR_CAP:
            body = body[:TRANSCRIPT_CHAR_CAP] + "\n... [truncated]"
        transcripts.append({
            "created_at": r.created_at or "",
            "text": body,
        })

    sms_rows = (
        db.query(Message)
        .filter(Message.lead_id == lead.id)
        .order_by(Message.created_at.desc())
        .limit(SMS_LIMIT)
        .all()
    )
    # Reverse so oldest-first in the prompt (reads like a conversation).
    sms_rows = list(reversed(sms_rows))
    sms: list[dict] = []
    for m in sms_rows:
        body = (m.body or "").strip()
        if not body:
            continue
        if len(body) > SMS_CHAR_CAP:
            body = body[:SMS_CHAR_CAP] + "..."
        sms.append({
            "direction": m.direction or "inbound",
            "body": body,
            "ts": m.created_at or "",
        })

    latest_estimate = (
        db.query(Estimate)
        .filter(Estimate.lead_id == lead.id)
        .order_by(Estimate.created_at.desc())
        .first()
    )
    estimate_info: Optional[dict] = None
    if latest_estimate:
        try:
            tiers = json.loads(latest_estimate.tiers or "{}")
        except Exception:
            tiers = {}
        estimate_info = {
            "signature_price": tiers.get("signature", 0),
            "essential_price": tiers.get("essential", 0),
            "legacy_price": tiers.get("legacy", 0),
            "sent_at": latest_estimate.sent_at or "",
            # What they ACTUALLY signed for — more useful than the menu.
            "closed_tier": latest_estimate.closed_tier or "",
            "closed_price": latest_estimate.closed_price or 0,
            "closed_at": latest_estimate.closed_at or "",
        }

    has_exterior_photos = False
    try:
        photos = json.loads(getattr(lead, "exterior_photos_json", "[]") or "[]")
        has_exterior_photos = bool(photos)
    except Exception:
        has_exterior_photos = False

    return {
        "transcripts": transcripts,
        "sms": sms,
        "estimate": estimate_info,
        "has_exterior_photos": has_exterior_photos,
        "lead_summary": {
            "name": lead.contact_name or "",
            "address": lead.address or "",
            "phone": lead.contact_phone or "",
        },
    }


# ---------------------------------------------------------------- prompt --

def _build_prompt(lead: Lead, sources: dict) -> str:
    """Compose the Claude prompt. Structured sections + JSON output.

    The hard rule baked into the prompt: recommended_upsell defaults to
    exterior painting UNLESS the transcripts/SMS explicitly show the
    customer declined it during the original sale. In that case fall
    back to whatever else they surfaced as a future intent.
    """
    transcripts_block = _format_transcripts(sources["transcripts"])
    sms_block = _format_sms(sources["sms"])
    estimate_block = _format_estimate(sources["estimate"])

    first_name = (lead.contact_name or "there").split()[0]

    return f"""You are reviewing a fence-staining customer's complete history at A&T's Fence Staining. The job has been COMPLETED and the customer was happy. We're about to call them to:
  1. Check how the fence is holding up
  2. Ask for a Google review
  3. Pitch an UPSELL — exterior painting is the priority. If they declined exterior during the original sale, fall back to ANYTHING ELSE they mentioned wanting later (deck staining, gate repair, fence section addition, etc.)

# Customer
Name: {sources['lead_summary']['name'] or 'unknown'}
First name: {first_name}
Address: {sources['lead_summary']['address'] or 'unknown'}
Has uploaded exterior-painting photos already? {'YES (exterior pitch is already in motion)' if sources['has_exterior_photos'] else 'no'}

# Estimate signed
{estimate_block}

# Call transcripts ({len(sources['transcripts'])} found, newest first)
{transcripts_block}

# SMS history ({len(sources['sms'])} messages, oldest first)
{sms_block}

# Your job
Produce a structured talking-points brief for the rep. Be SPECIFIC — quote actual customer phrases when relevant. Don't invent things they didn't say. If you have no signal on a section, say so honestly ("no specific pain points surfaced — start with a check-in question").

# Output (JSON only — no prose, no backticks)
{{
  "what_they_bought": "<1-2 sentence summary of the tier and price they signed for, plus when. If unknown, say so.>",
  "pain_points": [
    "<specific concern they raised during the sale, ideally with a brief quote>",
    "..."
  ],
  "things_mentioned": [
    "<specific upsell-worthy thing they mentioned wanting, ideally with a brief quote>",
    "..."
  ],
  "recommended_upsell": {{
    "type": "<exterior painting | deck staining | gate repair | fence add-on | stain refresh | other>",
    "why": "<1 sentence reasoning>",
    "hook": "<1 sentence the rep can use to bring it up naturally>"
  }},
  "suggested_opening": "<one sentence the rep can use to open the call — tuned to THIS customer's specific context>",
  "draft_upsell_sms": "<a short, friendly SMS the rep could send INSTEAD OF or BEFORE the call. Mention {first_name} by name, reference something specific from the history when possible. Keep under 200 chars. Sign off as A&T's Fence Staining.>"
}}

HARD RULES:
- recommended_upsell.type defaults to 'exterior painting' unless the customer explicitly declined exterior during the sale. If declined, pick from things_mentioned[].
- pain_points and things_mentioned each cap at 4 items — quality over quantity.
- Don't recommend pitching something they already bought.
- If no signal anywhere, output empty arrays and a generic "how's the fence holding up?" opener.
"""


def _format_transcripts(transcripts: list[dict]) -> str:
    if not transcripts:
        return "(no call transcripts on file)"
    out = []
    for i, t in enumerate(transcripts):
        ts = t.get("created_at") or "unknown date"
        out.append(f"--- Transcript {i+1} ({ts}) ---\n{t['text']}")
    return "\n\n".join(out)


def _format_sms(sms: list[dict]) -> str:
    if not sms:
        return "(no SMS history on file)"
    lines = []
    for m in sms:
        speaker = "REP" if m.get("direction") == "outbound" else "CUSTOMER"
        ts = m.get("ts") or ""
        lines.append(f"[{ts}] {speaker}: {m.get('body', '')}")
    return "\n".join(lines)


def _format_estimate(estimate: Optional[dict]) -> str:
    if not estimate:
        return "(no estimate on file)"
    parts = []
    if estimate.get("closed_tier"):
        parts.append(
            f"SIGNED FOR: {estimate['closed_tier'].upper()} "
            f"@ ${estimate.get('closed_price', 0)}"
            + (f" (closed {estimate['closed_at']})" if estimate.get("closed_at") else "")
        )
    parts.append(
        f"Tier menu offered: Essential ${estimate.get('essential_price', 0)} / "
        f"Signature ${estimate.get('signature_price', 0)} / "
        f"Legacy ${estimate.get('legacy_price', 0)}"
    )
    if estimate.get("sent_at"):
        parts.append(f"Estimate sent at: {estimate['sent_at']}")
    return "\n".join(parts)


# ---------------------------------------------------------------- Claude --

def _call_claude(api_key: str, prompt: str) -> Optional[str]:
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=api_key)
        resp = client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=MAX_TOKENS_PER_ANALYSIS,
            messages=[{"role": "user", "content": prompt}],
        )
        return resp.content[0].text.strip() if resp.content else None
    except Exception as e:
        logger.error("Follow-up analyzer Claude call failed: %s", e)
        return None


def _safe_json_loads(text: str) -> Optional[dict]:
    """Strip markdown fencing and extract JSON. Mirrors training_orchestrator."""
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.startswith("json"):
            cleaned = cleaned[4:].strip()
    try:
        return json.loads(cleaned)
    except Exception:
        # Sometimes Claude wraps in prose despite instructions — try to
        # carve out the first {...} block.
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(cleaned[start : end + 1])
            except Exception:
                return None
        return None


# ---------------------------------------------------------------- shape --

def _finalize(parsed: dict, sources: dict) -> dict:
    """Clean up the parsed Claude output + add a source summary so the
    UI can show "based on N transcripts + M texts." Belt-and-suspenders
    typing in case Claude returns slightly off-shape JSON."""
    def _str(v) -> str:
        return str(v).strip() if v is not None else ""

    def _list_str(v) -> list[str]:
        if not isinstance(v, list):
            return []
        return [s for s in (_str(x) for x in v) if s][:4]

    upsell = parsed.get("recommended_upsell") or {}
    if not isinstance(upsell, dict):
        upsell = {}

    return {
        "status": "ok",
        "what_they_bought": _str(parsed.get("what_they_bought")),
        "pain_points": _list_str(parsed.get("pain_points")),
        "things_mentioned": _list_str(parsed.get("things_mentioned")),
        "recommended_upsell": {
            "type": _str(upsell.get("type")) or "exterior painting",
            "why": _str(upsell.get("why")),
            "hook": _str(upsell.get("hook")),
        },
        "suggested_opening": _str(parsed.get("suggested_opening")),
        "draft_upsell_sms": _str(parsed.get("draft_upsell_sms")),
        "source_summary": {
            "transcripts": len(sources["transcripts"]),
            "sms": len(sources["sms"]),
            "has_exterior_photos": bool(sources["has_exterior_photos"]),
            "has_estimate": bool(sources["estimate"]),
        },
    }


def _error(reason: str) -> dict:
    """A consistent error envelope that still satisfies the UI shape."""
    return {
        "status": "error",
        "skip_reason": reason,
        "what_they_bought": "",
        "pain_points": [],
        "things_mentioned": [],
        "recommended_upsell": {"type": "", "why": "", "hook": ""},
        "suggested_opening": "",
        "draft_upsell_sms": "",
        "source_summary": {
            "transcripts": 0,
            "sms": 0,
            "has_exterior_photos": False,
            "has_estimate": False,
        },
    }
