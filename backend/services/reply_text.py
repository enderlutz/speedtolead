"""A bill's text written from what the customer just said (Alan, 2026-11-13).

The friendly reminder said "just a friendly reminder that your balance is
still open" to a customer who had texted that morning "please send an
invoice so I can pay you. He did a great job yesterday!" - a reminder to
someone who was asking to pay. When the customer has texted since we last
wrote, the text answers them first, then carries the link.

Only when they texted: no new customer words = the preset text, unchanged.
Best effort: any failure (no key, the model refused, the link went missing,
too long) falls back to the preset. Staff still see it and send on a tap.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

MODEL = "claude-sonnet-5-5"
FALLBACK_MODEL = "claude-sonnet-4-6"
LOOKBACK_DAYS = 14
MAX_CHARS = 320
# Thread lines that aren't anyone talking.
NOISE = ("opportunity updated",)


def _ts(s: str | None) -> datetime | None:
    try:
        t = datetime.fromisoformat((s or "").replace("Z", "+00:00"))
        return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _real(m) -> bool:
    body = (m.body or "").strip()
    return bool(body) and body.lower() not in NOISE


def thread(db, lead, limit: int = 12) -> list:
    """The last real messages with this customer, oldest first."""
    from database import Message
    if lead is None:
        return []
    rows = (db.query(Message).filter(Message.lead_id == lead.id)
            .order_by(Message.created_at.desc()).limit(limit * 3).all())
    return list(reversed([m for m in rows if _real(m)][:limit]))


def new_words(msgs: list, since: str | None = None, now: datetime | None = None) -> list:
    """What the customer texted that we haven't answered yet: their messages
    after our last real text (and after `since`, e.g. when the bill went
    out), from the last two weeks. Empty = nothing to answer."""
    now = now or datetime.now(timezone.utc)
    floor = now - timedelta(days=LOOKBACK_DAYS)
    s = _ts(since)
    if s and s > floor:
        floor = s
    last_out = max((_ts(m.created_at) for m in msgs if m.direction == "outbound" and _ts(m.created_at)), default=None)
    if last_out and last_out > floor:
        floor = last_out
    return [m for m in msgs if m.direction == "inbound" and (_ts(m.created_at) or floor) > floor]


TASK = """You write one text message from a fence staining company to a customer, about a bill.

The customer texted us and nobody has answered yet. Answer what they said first, warmly and briefly, then give the pay link.

Rules:
- Start with exactly this greeting, then a comma: {greeting}
- Then: "it's {sender}{title}." (exactly).
- Answer their words in one short sentence. If they asked for the bill, it's here. If they praised the job, thank them. If they said something is wrong, say we'll make it right and that you'll call them; still include the link.
- Then the amount and the link, word for word: {amount} {link}
- At most {max_chars} characters in total, counting the link. Shorter is better.
- Plain, friendly words a fifth grader reads easily. One emoji at most, or none.
- Never offer a discount, never change the amount, never promise a date, never invent anything they didn't say.
- Never use any name except in the greeting.
- What the bill is for: {what}.

Reply with the text only. No quotes, no notes."""


def _ask(system: str, user: str) -> str:
    from config import get_settings
    key = get_settings().anthropic_api_key
    if not key:
        return ""
    import anthropic
    client = anthropic.Anthropic(api_key=key)
    kw = dict(max_tokens=4000, system=system, messages=[{"role": "user", "content": user}])

    def _text(r) -> str:
        return "".join(getattr(b, "text", "") for b in (r.content or []) if getattr(b, "type", "") == "text").strip()
    try:
        out = _text(client.messages.create(model=MODEL, **kw))
    except (anthropic.NotFoundError, anthropic.BadRequestError, anthropic.PermissionDeniedError):
        out = ""
    return out or _text(client.messages.create(model=FALLBACK_MODEL, **kw))


def _when(m) -> str:
    t = _ts(m.created_at)
    if not t:
        return ""
    from clock import to_ct
    return to_ct(t).strftime("%a %b %-d %-I:%M %p")


def draft(db, lead, link_url: str, amount: str, what: str, greeting: str,
          sender: str = "Alan", since: str | None = None) -> dict | None:
    """{"message", "their_words"} written from what they said, or None to
    use the preset (they didn't text, or anything went wrong)."""
    try:
        msgs = thread(db, lead)
        fresh = new_words(msgs, since)
        if not fresh:
            return None
        title = ", the project manager at Sterling" if sender == "Alan" else " with Sterling Fence Staining"
        system = TASK.format(greeting=greeting, sender=sender, title=title, amount=amount, link=link_url,
                             max_chars=MAX_CHARS, what=what)
        convo = "\n".join(f"[{_when(m)}] {'CUSTOMER' if m.direction == 'inbound' else 'US'}: {(m.body or '').strip()}"
                          for m in msgs)
        text = _ask(system, f"The conversation so far (oldest first):\n{convo}\n\nWrite the text now.")
        text = text.strip().strip('"').strip()
        if not text or link_url not in text or len(text) > MAX_CHARS + 40:
            logger.info("reply_text: draft refused (len %s, link %s)", len(text), link_url in text)
            return None
        return {"message": text, "their_words": [(m.body or "").strip() for m in fresh]}
    except Exception:  # noqa: BLE001 - never block the bill
        logger.exception("reply_text: draft failed")
        return None
