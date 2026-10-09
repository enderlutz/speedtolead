"""When a customer filled out the form — every time, not just the first.

One in ten leads fills the form again (192 of 2,002 on 2026-10-09). The lead
row is created once, so a customer who first came in on August 28th and
filled the form again on October 8th sat two hundred rows down the Contacts
page, under a "sent" badge, while the intake text went out to them like a
brand-new lead. Alan (2026-10-09, Allque): "he basically restarts from zero
when he fills out the form again".

The signal is GHL's own activity stream: every form fill makes a new
opportunity card, and the message poller stores that as a TYPE_ACTIVITY
message with the body "Opportunity created". So each lead has a list of
intake moments, and "the current cycle" of a customer's journey — replied,
discovery call, estimate sent — is measured from the latest one. Nothing is
stored: the history is read from messages already on the lead, which also
covers every refill from before this existed.

Two cards made within a day of each other are one intake (the A and B
pipelines can each make a card for the same fill).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

INTAKE_TYPE = "TYPE_ACTIVITY_OPPORTUNITY"
INTAKE_BODY = "Opportunity created"
SAME_INTAKE = timedelta(hours=24)


def _ts(value) -> datetime | None:
    if not value:
        return None
    try:
        d = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def intake_times(db, lead) -> list[datetime]:
    """Every form fill this customer made, oldest first — one per card.

    Only the cards count. The lead row's own creation is NOT a floor: a
    contact mirrored from GHL gets a created_at long after its real history,
    and a call from before that stamp is still a call. A lead with no cards
    at all (from before the message poller) has no cycle, and everything on
    it counts, as it always did."""
    from database import Message
    stamps: list[datetime] = []
    rows = (
        db.query(Message.created_at)
        .filter(Message.lead_id == lead.id, Message.message_type == INTAKE_TYPE,
                Message.body == INTAKE_BODY)
        .all()
    )
    stamps += [t for t in (_ts(r[0]) for r in rows) if t]
    stamps.sort()
    out: list[datetime] = []
    for t in stamps:
        if out and t - out[-1] <= SAME_INTAKE:
            continue
        out.append(t)
    return out


def latest_intake(db, lead) -> datetime | None:
    times = intake_times(db, lead)
    return times[-1] if times else None


def _born(lead) -> datetime | None:
    return _ts(lead.ghl_created_at) or _ts(lead.created_at)


def _count_with_birth(cards: list[datetime], born: datetime | None) -> int:
    """Cards, plus the lead's own arrival when that was more than a day
    before the first card — a lead from before the poller whose first fill
    never got a card, and who then came back."""
    n = len(cards)
    if born and (not cards or cards[0] - born > SAME_INTAKE):
        n += 1
    return max(1, n)


def intake_summary(db, lead) -> dict:
    """For the lead page: when they last came in, and how many times. With
    no cards, the lead's creation stands in for display only."""
    times = intake_times(db, lead)
    born = _born(lead)
    if not times:
        at = born.isoformat() if born else None
        return {"at": at, "first_at": at, "count": 1, "restarts": False}
    first = min([times[0]] + ([born] if born else []))
    return {
        "at": times[-1].isoformat(),
        "first_at": first.isoformat(),
        "count": _count_with_birth(times, born),
        # True when the journey is measured from the latest card.
        "restarts": True,
    }


def last_intakes(db, lead_ids: list[str] | None) -> dict[str, str]:
    """lead_id -> the latest "Opportunity created" stamp, for sorting and
    for deciding whether an estimate went out since. No 24-hour collapse
    needed here: the latest card is the latest either way."""
    from sqlalchemy import func
    from database import Message
    q = (
        db.query(Message.lead_id, func.max(Message.created_at))
        .filter(Message.message_type == INTAKE_TYPE, Message.body == INTAKE_BODY,
                Message.lead_id.isnot(None))
    )
    if lead_ids is not None:
        if not lead_ids:
            return {}
        q = q.filter(Message.lead_id.in_(lead_ids))
    return {lid: t for lid, t in q.group_by(Message.lead_id).all() if t}


def intake_counts(db, lead_ids: list[str]) -> dict[str, int]:
    """lead_id -> how many times they came in (same rule as intake_summary),
    so a refill can be flagged on a list without a query per row."""
    from database import Lead, Message
    if not lead_ids:
        return {}
    born = {lid: (_ts(g) or _ts(c)) for lid, g, c in
            db.query(Lead.id, Lead.ghl_created_at, Lead.created_at).filter(Lead.id.in_(lead_ids)).all()}
    rows = (
        db.query(Message.lead_id, Message.created_at)
        .filter(Message.message_type == INTAKE_TYPE, Message.body == INTAKE_BODY,
                Message.lead_id.in_(lead_ids))
        .order_by(Message.lead_id, Message.created_at)
        .all()
    )
    cards: dict[str, list[datetime]] = {}
    for lid, at in rows:
        t = _ts(at)
        if not t:
            continue
        mine = cards.setdefault(lid, [])
        if mine and t - mine[-1] <= SAME_INTAKE:
            continue
        mine.append(t)
    return {lid: _count_with_birth(cards.get(lid, []), born.get(lid)) for lid in lead_ids}
