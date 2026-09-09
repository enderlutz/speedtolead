"""What the CUSTOMER said over text, so the callback list can rank on it.

The call reader (services/call_intent.py) answers "who should Alan ring
today" from recorded calls. Most of the conversation with a customer happens
over SMS, though, and until this existed none of it reached the list. This
reads a lead's whole text thread the same way: what they wanted, what is
stopping them, what they committed to, and when they said to follow up.

Two facts are computed HERE from the messages and never asked of the model:

  awaiting_reply — the customer's text is the last one in the thread. It is
  the single most actionable thing on the list, and it is a fact rather than
  an impression, so it must not depend on a reading.

  the callback basis date — "text me after the 15th" means the 15th after
  it was SENT. Relative phrases resolve against the day of the customer's
  last message, not against today and never against a date the model made
  up.

Same rules as the call reader: never invent a commitment or a date. An empty
field is correct and useful; a plausible fabrication sends Alan to call
someone who never asked.
"""

from __future__ import annotations

import logging

import clock
from services.call_intent import (
    _MAX_TRANSCRIPT_CHARS,
    _empty,
    ask_claude_json,
    customer_context,
    intent_fields,
    resolve_callback,
)

logger = logging.getLogger(__name__)

# A thread is read from its tail: the newest messages carry the state of the
# conversation, and the front of a 200-message thread is history.
_MAX_MESSAGES = 80

# GHL files everything in the conversation stream — opportunity-stage
# changes, call records, emails, emoji reactions. None of those are the
# customer talking. Anything whose type carries one of these is not chat.
NOT_CHAT_TAGS = ("ACTIVITY", "CALL", "EMAIL", "REACTION", "INTERNAL", "REVIEW")


_THREAD_PROMPT = """You read one text-message thread between Sterling Fence Staining and a
customer, and report what the CUSTOMER said. You are not evaluating our side.

Sterling stains and restores fences in the Houston area. A typical path is:
customer enquires, we send a written estimate with three tiers, then someone
follows up by text and phone to close and get the job on the calendar.

Lines marked "Sterling:" are ours. Many are automated follow-ups, and a run of
them with no answer means the customer went quiet, not that they agreed.
Lines marked "Customer:" are theirs. Only their lines are evidence.

Your output decides who gets called today, so a wrong confident answer is worse
than an honest empty one.

Return ONLY a JSON object, no prose around it:

{
  "wanted": "What the customer actually asked for, in their terms. Empty string if they never said.",
  "blocker": "ONE of: price | timing | spouse_or_partner | competitor | scope_unclear | access | waiting_on_us | none | unknown",
  "blocker_detail": "One sentence on the blocker, quoting them where you can. Empty if blocker is none or unknown.",
  "commitment": "Something the customer said THEY would do, close to verbatim. Empty string if they committed to nothing.",
  "callback_phrase": "The customer's own words about WHEN to follow up, e.g. 'text me after the 15th'. Empty string if they never said.",
  "temperature": "hot | warm | cold | unknown",
  "one_line": "One line Alan reads in two seconds before he dials.",
  "brief": "Three to five plain sentences for the person making the next call: what the customer wants (which sides, color, tier if they picked one), where it stands (what was sent and when, what they said last, whether they are waiting on us), what is in the way, and what to do or say on this call. Only what the thread supports.",
  "quoted_price_mentioned": true or false
}

HOW TO JUDGE TEMPERATURE — about the customer buying, not about the thread:
  hot     — asked to schedule, asked about dates, accepted a price, said yes.
  warm    — replied and engaged, but something is unresolved.
  cold    — declined, went with someone else, asked us to stop, or has not
            replied to several of our messages.
  unknown — they never wrote anything, or nothing they wrote is about the job.

RULES:
- Report only what the customer wrote. Never infer a commitment, a date or a
  price that is not in their words.
- "callback_phrase" is the customer's words, NOT a date you calculated. Leave
  it empty rather than guessing. The date is computed elsewhere.
- Our side saying "I'll follow up Tuesday" is NOT a customer commitment.
- If the customer wrote nothing, return temperature "unknown" and leave the
  text fields empty.
- Do not include advice for whoever replies. That is another system's job.
"""


def _get(m, key: str, default=""):
    """Read a field off an ORM row or a plain dict alike."""
    if isinstance(m, dict):
        return m.get(key, default)
    return getattr(m, key, default)


def is_chat(message_type: str | None) -> bool:
    """Is this a person-to-person message, as opposed to a system event?

    A missing type is treated as chat: rows the webhook stored without one
    are texts.
    """
    t = (message_type or "").upper()
    if not t:
        return True
    return not any(tag in t for tag in NOT_CHAT_TAGS)


def chat_messages(messages) -> list:
    """The chat rows of a thread, oldest first."""
    rows = [m for m in messages if is_chat(_get(m, "message_type"))]
    rows.sort(key=lambda m: _get(m, "created_at") or "")
    return rows


def thread_facts(msgs: list) -> dict:
    """What is true of the thread without reading a word of it.

    `msgs` must already be chat-only and chronological (see chat_messages).
    """
    inbound = [m for m in msgs if _get(m, "direction") == "inbound"]
    outbound = [m for m in msgs if _get(m, "direction") != "inbound"]
    last = msgs[-1] if msgs else None
    awaiting = bool(
        last is not None
        and _get(last, "direction") == "inbound"
        and (_get(last, "body") or "").strip()
    )
    return {
        "message_count": len(msgs),
        "inbound_count": len(inbound),
        "last_inbound_at": (_get(inbound[-1], "created_at") or "") if inbound else "",
        "last_outbound_at": (_get(outbound[-1], "created_at") or "") if outbound else "",
        "awaiting_reply": awaiting,
        "through_message_id": (_get(last, "id") or "") if last else "",
        "through_message_at": (_get(last, "created_at") or "") if last else "",
    }


def render_thread(msgs: list, *, max_chars: int = _MAX_TRANSCRIPT_CHARS,
                  max_messages: int = _MAX_MESSAGES) -> str:
    """The thread as the model sees it: one dated line per message.

    Days are Houston days, so "[2026-09-03] Customer: Thursday works" and the
    CUSTOMER'S LAST MESSAGE line agree about what Thursday means. Trimmed
    from the front when over budget — the end of a thread is its state.
    """
    lines = []
    for m in msgs[-max(1, max_messages):]:
        body = " ".join((_get(m, "body") or "").split())
        if not body:
            continue
        who = "Customer" if _get(m, "direction") == "inbound" else "Sterling"
        ts = _get(m, "created_at") or ""
        day = clock.ct_date_of(ts) if ts else ""
        lines.append(f"[{day or '?'}] {who}: {body}")
    text = "\n".join(lines)
    if len(text) > max_chars:
        text = "[earlier messages trimmed]\n" + text[-max_chars:]
    return text


def extract_thread_intent(messages, *, lead_context: dict | None = None) -> dict:
    """Read one lead's thread. Never raises.

    Returns the thread facts merged with the intent fields and an `ok` flag
    with the same meaning as the call reader's: False means the read did not
    happen (no key, no credit, bad response) and the caller must not record
    it, so the thread is retried rather than marked done forever.
    """
    msgs = chat_messages(messages)
    facts = thread_facts(msgs)
    if not msgs:
        # Nothing to read is a real answer, not a failure.
        return {**facts, **_empty("No messages.", ok=True)}

    rendered = render_thread(msgs)
    if not rendered.strip():
        return {**facts, **_empty("No messages.", ok=True)}

    basis_at = facts["last_inbound_at"] or facts["through_message_at"]
    basis_day = clock.ct_date_of(basis_at) if basis_at else ""

    context = customer_context(lead_context)
    if basis_day:
        context += f"\nCUSTOMER'S LAST MESSAGE: {clock.echo_day(basis_day)}"

    answer = ask_claude_json(_THREAD_PROMPT, f"TEXT THREAD:{context}\n\n{rendered}")
    if not answer["ok"]:
        return {**facts, **_empty(answer["reason"])}

    out = {**facts, "ok": True, **intent_fields(answer["parsed"])}
    # The date is computed here from the phrase, against the day they wrote
    # it — never taken from the model.
    out["callback_at"] = resolve_callback(out["callback_phrase"], basis_day)
    return out
