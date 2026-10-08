"""Customers' own words from the emails they send us.

Alan, 2026-10-08: Liza Reheiser replied to our estimate email — "Definitely
will go with your company. I close on the 30th and move in on the 31…" — and
neither GHL's message list nor our database had a word of it. Every reply
has to come in whole, or nothing built on top (Heard back, objections, when
to follow up next) can be trusted.

Why it was lost: GHL shows an email THREAD as one conversation message, and
that message's body is the first email in the thread — for a reply to our
estimate email, that is our own text. The thread lists each email's id in
`meta.email.messageIds`, and each id fetches that one email in full. 12
inbound emails since May looked like this.

A thread's entry can also be reused when the customer replies later, so an
entry we stored as our outbound estimate email can quietly gain a reply. The
sweep therefore re-reads every recent email thread, not only inbound ones.

What gets stored:
* An inbound thread entry keeps its row; its body becomes the customer's
  reply (the inbound email nearest the entry's time).
* Every other inbound email in the thread becomes its own row, keyed
  `email:<id>`, at the time it was sent.
Each is cut at the quoted part ("On Oct 6, 2026, at 5:59 PM, … wrote:").
"""
from __future__ import annotations

import html as html_lib
import json
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

EMAIL_TYPES = ("TYPE_EMAIL", "Email", "EMAIL")
WATCH_DAYS = 21          # how long a thread is re-read for late replies
RECHECK_HOURS = 6
BATCH = 20               # threads per sweep (each is 2–3 GHL calls)

# Where the quoted earlier email starts, in the order mail apps write it.
_QUOTE_HTML = re.compile(
    r"<blockquote|<div[^>]+class=\"?[^\">]*gmail_quote|<div[^>]+id=\"?(appendonsend|divRplyFwdMsg)"
    r"|<hr[^>]*>\s*<div[^>]*>\s*<b>From:",
    re.I,
)
_QUOTE_TEXT = [
    re.compile(r"^\s*On .{3,200}?wrote:\s*$", re.I | re.M | re.S),
    re.compile(r"^\s*-{2,}\s*Original Message\s*-{2,}", re.I | re.M),
    re.compile(r"^\s*_{10,}\s*$", re.M),
    re.compile(r"^\s*From: .+\n\s*(Sent|Date): ", re.I | re.M),
    re.compile(r"^\s*>", re.M),
]
_SIGNOFF = re.compile(r"^\s*Sent from my (iPhone|iPad|Android|Galaxy|phone|Samsung)[^\n]*$|^\s*Get Outlook for \w+\s*$",
                      re.I | re.M)


def _html_to_text(body: str) -> str:
    b = re.sub(r"<(style|script|head)[^>]*>.*?</\1>", " ", body, flags=re.S | re.I)
    b = re.sub(r"<br\s*/?>|</(p|div|li|tr|h\d)>", "\n", b, flags=re.I)
    b = re.sub(r"<[^>]+>", "", b)
    return html_lib.unescape(b).replace("\xa0", " ")


def reply_text(body: str | None, content_type: str | None = "") -> str:
    """Just what the customer wrote: no quoted thread, no "Sent from my iPhone"."""
    b = body or ""
    if "html" in (content_type or "").lower() or re.search(r"<(div|br|p|html|body)\b", b, re.I):
        m = _QUOTE_HTML.search(b)
        if m:
            b = b[:m.start()]
        b = _html_to_text(b)
    cut = len(b)
    for rx in _QUOTE_TEXT:
        m = rx.search(b)
        if m:
            cut = min(cut, m.start())
    b = _SIGNOFF.sub("", b[:cut])
    b = re.sub(r"[ \t]+\n", "\n", b)
    return re.sub(r"\n{3,}", "\n\n", b).strip()


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


def thread_replies(ghl_message_id: str, location_id: str | None = None) -> list[dict] | None:
    """Every inbound email in a thread, oldest first, as
    {id, at, text}. None when GHL couldn't be read (try again later)."""
    from services import ghl

    msg = ghl.get_message(ghl_message_id, location_id)
    if msg is None:
        return None
    ids = ((msg.get("meta") or {}).get("email") or {}).get("messageIds") or []
    out = []
    for eid in ids:
        e = ghl.get_email_message(eid, location_id)
        if e is None:
            return None
        if not e or (e.get("direction") or "").lower() != "inbound":
            continue
        out.append({
            "id": eid,
            "at": e.get("dateAdded") or msg.get("dateAdded") or "",
            "text": reply_text(e.get("body"), e.get("contentType")),
        })
    out.sort(key=lambda r: r["at"])
    return out


def recover_message(db, row, location_id: str | None = None) -> dict:
    """Read one stored email thread entry and put the customer's words in.
    Returns {"ok", "updated", "added"}; ok False means retry later."""
    from database import Lead, Message, ObjectionScan
    from services.event_bus import publish

    replies = thread_replies(row.ghl_message_id, location_id)
    if replies is None:
        return {"ok": False, "updated": False, "added": 0}

    own = None
    if row.direction == "inbound" and replies:
        t = _ts(row.created_at)
        own = min(replies, key=lambda r: abs(((_ts(r["at"]) or t) - t).total_seconds()) if t else 0)

    updated, added, newest = False, 0, None
    if own is not None:
        text = own["text"] or "[email with no text]"
        if text != (row.body or ""):
            row.body = text
            updated = True
            # Read again by the objection scanner — it saw our text before.
            db.query(ObjectionScan).filter(ObjectionScan.source_key == f"text:{row.id}").delete()
        newest = (row.created_at, text)

    for r in replies:
        if own is not None and r["id"] == own["id"]:
            continue
        key = f"email:{r['id']}"
        if db.query(Message.id).filter(Message.ghl_message_id == key).first():
            continue
        text = r["text"] or "[email with no text]"
        db.add(Message(
            id=str(uuid.uuid4()), ghl_contact_id=row.ghl_contact_id, lead_id=row.lead_id,
            direction="inbound", body=text, message_type="TYPE_EMAIL",
            ghl_message_id=key, created_at=r["at"] or _now(), attachments_json="[]",
            email_checked_at=_now(),
        ))
        added += 1
        if newest is None or (r["at"] or "") > newest[0]:
            newest = (r["at"], text)

    row.email_checked_at = _now()

    if (updated or added) and newest and row.lead_id:
        lead = db.query(Lead).filter(Lead.id == row.lead_id).first()
        if lead:
            lead.customer_responded = True
            lead.customer_response_text = newest[1]
            lead.updated_at = _now()
            at = _ts(newest[0])
            if at and at > datetime.now(timezone.utc) - timedelta(days=2):
                publish("customer_reply", {"lead_id": lead.id, "contact_name": lead.contact_name,
                                           "body": newest[1][:200]})
    return {"ok": True, "updated": updated, "added": added}


def due(db, limit: int = BATCH) -> list:
    """Email entries to read: every inbound one never read (all history — the
    12 from before this existed), plus any recent thread not read in
    RECHECK_HOURS, in case a reply landed on it."""
    from sqlalchemy import or_
    from database import Message

    now = datetime.now(timezone.utc)
    recent = (now - timedelta(days=WATCH_DAYS)).isoformat()
    stale = (now - timedelta(hours=RECHECK_HOURS)).isoformat()
    unread = or_(Message.email_checked_at.is_(None), Message.email_checked_at == "")
    base = (db.query(Message)
            .filter(Message.message_type.in_(EMAIL_TYPES), Message.lead_id.isnot(None),
                    Message.ghl_message_id.isnot(None), ~Message.ghl_message_id.like("email:%")))
    rows = (base.filter(Message.direction == "inbound", unread)
            .order_by(Message.created_at.desc()).limit(limit).all())
    if len(rows) < limit:
        seen = {r.id for r in rows}
        more = (base.filter(Message.created_at >= recent,
                            or_(unread, Message.email_checked_at < stale))
                .order_by(Message.email_checked_at.asc().nullsfirst(), Message.created_at.desc())
                .limit(limit).all())
        rows += [r for r in more if r.id not in seen][: limit - len(rows)]
    return rows


def sweep_once(limit: int = BATCH) -> dict:
    from database import Lead, get_db

    db = get_db()
    stats = {"read": 0, "updated": 0, "added": 0, "failed": 0}
    try:
        for row in due(db, limit):
            loc = None
            lead = db.query(Lead.ghl_location_id).filter(Lead.id == row.lead_id).first()
            if lead:
                loc = lead[0] or None
            try:
                res = recover_message(db, row, loc)
                db.commit()
            except Exception as e:
                db.rollback()
                logger.error(f"Email reply recovery failed for message {row.id}: {e}")
                stats["failed"] += 1
                continue
            if not res["ok"]:
                stats["failed"] += 1
                continue
            stats["read"] += 1
            stats["updated"] += int(res["updated"])
            stats["added"] += res["added"]
        if stats["updated"] or stats["added"]:
            logger.info(f"Email replies: {json.dumps(stats)}")
        return stats
    finally:
        db.close()
