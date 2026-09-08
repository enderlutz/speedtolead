"""What the CUSTOMER said, so Alan knows who to call today.

Not to be confused with services/call_analyzer.py, which is the AI Call Coach.
That one grades Olga's intake technique and says so in its own prompt: "This is
NOT a sales call. Do NOT grade her on closing skill, objection handling, or
pitching." Its close_likelihood field means *was the intake complete* — across
713 analysed calls it reads 352 "unknown" and 343 "needs_followup" — and its
next_action is advice for Olga, not a step for the customer.

Useful, but it answers a different question. Running more calls through it
produces more critiques of Olga and nothing about who is close to buying.

This module reads the same transcript from the other side of the conversation:
what the customer wanted, what is stopping them, what they committed to, and
when they said to call back. That is what a callback list can rank on.

Two rules, both learned the expensive way elsewhere in this codebase:

  Never invent a commitment or a callback date. An empty field is correct and
  useful; a plausible fabrication sends Alan to call someone who never asked
  to be called, and he stops trusting the list.

  Dates resolve through clock.resolve_relative_day against Houston time. "Next
  Tuesday" said on a call is meaningless without the day it was said on, and a
  weekday is derived from the date, never the other way round.
"""

from __future__ import annotations

import json
import logging

import clock
from config import get_settings

logger = logging.getLogger(__name__)

# Long transcripts cost tokens and add nothing after a point — the buying
# signal is in what was said, not in every minute of it.
_MAX_TRANSCRIPT_CHARS = 12_000

TEMPERATURES = ("hot", "warm", "cold", "unknown")

BLOCKERS = (
    "price", "timing", "spouse_or_partner", "competitor", "scope_unclear",
    "access", "waiting_on_us", "none", "unknown",
)


_PROMPT = """You read one recorded call between Sterling Fence Staining and a
customer, and report what the CUSTOMER said. You are not evaluating the rep.

Sterling stains and restores fences in the Houston area. A typical path is:
customer enquires, we send a written estimate with three tiers, then someone
follows up to close and get the job on the calendar.

Your output decides who gets called today, so a wrong confident answer is worse
than an honest empty one.

Return ONLY a JSON object, no prose around it:

{
  "wanted": "What the customer actually asked for, in their terms. Empty string if the call never got there.",
  "blocker": "ONE of: price | timing | spouse_or_partner | competitor | scope_unclear | access | waiting_on_us | none | unknown",
  "blocker_detail": "One sentence on the blocker, quoting them where you can. Empty if blocker is none or unknown.",
  "commitment": "Something the customer said THEY would do, close to verbatim. Empty string if they committed to nothing.",
  "callback_phrase": "The customer's own words about when to follow up, e.g. 'call me after Thursday'. Empty string if they never said.",
  "temperature": "hot | warm | cold | unknown",
  "one_line": "One line Alan reads in two seconds before he dials.",
  "quoted_price_mentioned": true or false
}

HOW TO JUDGE TEMPERATURE — about the customer buying, not about call quality:
  hot     — asked to schedule, asked about start dates, accepted a price, or
            pushed to move forward.
  warm    — engaged and interested, but something is unresolved.
  cold    — declined, went quiet, said not now with no date, or already used
            somebody else.
  unknown — the call was too short, was a wrong number, went to voicemail, or
            never reached the subject at all.

RULES:
- Report only what is in the transcript. Never infer a commitment, a date or a
  price that was not spoken.
- "callback_phrase" is the customer's words, NOT a date you calculated. Leave
  it empty rather than guessing. The date is computed elsewhere.
- A rep saying "I'll follow up Tuesday" is NOT a customer commitment.
- If the transcript is empty, unintelligible or clearly not a customer call,
  return temperature "unknown" and leave the text fields empty.
- Do not include advice for the rep. That is another system's job.
"""


def _empty(reason: str = "") -> dict:
    return {
        "wanted": "",
        "blocker": "unknown",
        "blocker_detail": "",
        "commitment": "",
        "callback_phrase": "",
        "callback_at": "",
        "temperature": "unknown",
        "one_line": reason,
        "quoted_price_mentioned": False,
    }


def _coerce(value: str, allowed: tuple[str, ...], fallback: str) -> str:
    v = (value or "").strip().lower().replace(" ", "_")
    return v if v in allowed else fallback


def extract_intent(transcript_text: str, *, call_date: str = "",
                   lead_context: dict | None = None) -> dict:
    """Pull the customer-side signal out of one transcript.

    `call_date` is the Houston day the call happened ("YYYY-MM-DD"). It is what
    makes "next Tuesday" mean anything — a relative phrase resolves against the
    day it was spoken, not against today.

    Never raises. A failure returns the empty shape, because one unparseable
    call must not stop a backlog run.
    """
    text = (transcript_text or "").strip()
    if not text:
        return _empty("No transcript.")

    settings = get_settings()
    api_key = (getattr(settings, "anthropic_api_key", "") or "").strip()
    if not api_key:
        logger.warning("call_intent: no Anthropic key configured")
        return _empty("Not analysed — no API key.")

    if len(text) > _MAX_TRANSCRIPT_CHARS:
        text = text[:_MAX_TRANSCRIPT_CHARS] + "\n[transcript truncated]"

    context = ""
    if lead_context:
        name = (lead_context.get("contact_name") or "").strip()
        address = (lead_context.get("address") or "").strip()
        if name or address:
            context = f"\n\nCUSTOMER: {name}{f' — {address}' if address else ''}"
    if call_date:
        context += f"\nCALL DATE: {clock.echo_day(call_date)}"

    try:
        from anthropic import Anthropic
        client = Anthropic(api_key=api_key)
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=800,
            # The prompt is identical on every call, so cache it — this runs
            # over hundreds of transcripts in a batch.
            system=[{"type": "text", "text": _PROMPT,
                     "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user",
                       "content": f"CALL TRANSCRIPT:{context}\n\n{text}"}],
        )
        raw = response.content[0].text if response.content else ""
    except Exception as e:
        logger.error(f"call_intent: Claude call failed: {e}")
        return _empty("Not analysed — extraction failed.")

    clean = raw.strip()
    if clean.startswith("```"):
        clean = clean.split("\n", 1)[1] if "\n" in clean else clean
        clean = clean.rsplit("```", 1)[0]
    try:
        parsed = json.loads(clean)
    except (json.JSONDecodeError, ValueError) as e:
        logger.error(f"call_intent: unparseable JSON: {e}")
        return _empty("Not analysed — bad response.")

    out = {
        "wanted": str(parsed.get("wanted") or "").strip(),
        "blocker": _coerce(parsed.get("blocker", ""), BLOCKERS, "unknown"),
        "blocker_detail": str(parsed.get("blocker_detail") or "").strip(),
        "commitment": str(parsed.get("commitment") or "").strip(),
        "callback_phrase": str(parsed.get("callback_phrase") or "").strip(),
        "temperature": _coerce(parsed.get("temperature", ""), TEMPERATURES, "unknown"),
        "one_line": str(parsed.get("one_line") or "").strip(),
        "quoted_price_mentioned": bool(parsed.get("quoted_price_mentioned")),
    }
    out["callback_at"] = resolve_callback(out["callback_phrase"], call_date)
    return out


def resolve_callback(phrase: str, call_date: str = "") -> str:
    """Turn the customer's words into an absolute Houston date, or "".

    Deliberately strict. The model returns a PHRASE and the date is computed
    here, so a hallucinated date can never reach the callback list — the worst
    case is an unparseable phrase, which yields "" and simply doesn't schedule
    anything.

    Resolved against the day of the CALL, not today: "Tuesday" said three weeks
    ago meant that week's Tuesday.
    """
    phrase = (phrase or "").strip()
    if not phrase:
        return ""
    basis = None
    if call_date:
        parsed = clock.parse_iso(f"{call_date[:10]}T12:00:00+00:00")
        if parsed:
            basis = parsed
    resolved = clock.resolve_relative_day(phrase, now=basis)
    return resolved.date if resolved else ""
