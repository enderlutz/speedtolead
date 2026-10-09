"""When a customer filled out the form — every time, not just the first.

One in ten leads fills the form again (192 of 2,002 on 2026-10-09). The lead
row is created once, so a customer who first came in on August 28th and
filled the form again on October 8th sat two hundred rows down the Contacts
page, under a "sent" badge, while the intake text went out to them like a
brand-new lead. Alan (2026-10-09, Allque): "he basically restarts from zero
when he fills out the form again".

The raw signal is GHL's own activity stream: a form fill makes a new
opportunity card, and the message poller stores that as a TYPE_ACTIVITY
message with the body "Opportunity created". But NOT every card is a form
fill — the "estimate sent" automation makes a card too, minutes after the
send (Michelle Stout: estimate 8:52, card 8:59, and the page said she'd
never been priced). So a card after the first only counts when the intake
workflow fired for it: the first text after a form fill is always the
introduction ("Hi X, this is Amy with Sterling Fence Staining… received your
inquiry"), in every wording the workflow has ever had, and an automation
card is never followed by one. A card within two hours of an estimate send
is the automation's, whatever follows.

Nothing is stored: the history is read from messages already on the lead,
which also covers every refill from before this existed. Two cards within a
day are one intake (the A and B pipelines can each make a card for one
fill).
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

INTAKE_TYPE = "TYPE_ACTIVITY_OPPORTUNITY"
INTAKE_BODY = "Opportunity created"
SAME_INTAKE = timedelta(hours=24)
# The intake text can land a minute before the card (the webhook is quicker
# than the card) or, with quiet hours, the next morning.
INTRO_BEFORE = timedelta(minutes=10)
INTRO_AFTER = timedelta(hours=36)
# A card this soon after a send is the "estimate sent" automation's.
SEND_SHADOW = timedelta(hours=2)

# The intake workflow's opening line, across every version it has had:
# "this is Amy with A&T's…", "this is Alan with Sterling…, sister company",
# "we just received your inquiry", "I just recieved your inquitry" (sic).
INTRO = re.compile(r"\bthis is \w+ with\b|\brecei?ved your\b|\bthanks for reaching out\b", re.I)


def _ts(value) -> datetime | None:
    if not value:
        return None
    try:
        d = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def is_intro_text(body: str | None) -> bool:
    return bool(body) and bool(INTRO.search(body or ""))


def fills_by_lead(db, lead_ids: list[str] | None) -> dict[str, list[datetime]]:
    """lead_id -> every form fill, oldest first. Leads with no card at all
    are absent: they are from before the message poller, have no cycle, and
    everything on them counts. `lead_ids=None` means every lead."""
    from sqlalchemy import or_
    from database import Estimate, Message

    cards_q = (
        db.query(Message.lead_id, Message.created_at)
        .filter(Message.message_type == INTAKE_TYPE, Message.body == INTAKE_BODY,
                Message.lead_id.isnot(None))
    )
    if lead_ids is not None:
        if not lead_ids:
            return {}
        cards_q = cards_q.filter(Message.lead_id.in_(lead_ids))
    cards: dict[str, list[datetime]] = {}
    for lid, at in cards_q.all():
        t = _ts(at)
        if t:
            cards.setdefault(lid, []).append(t)
    for lst in cards.values():
        lst.sort()

    with_cards = list(cards)
    intros: dict[str, list[datetime]] = {}
    sends: dict[str, list[datetime]] = {}
    if with_cards:
        # Pre-filtered in SQL with loose LIKEs (both databases speak them),
        # then held to the real pattern here, so the whole-table call for
        # the stats reads a few hundred rows rather than every text.
        looks_like_intro = or_(
            Message.body.ilike("%this is % with %"),
            Message.body.ilike("%received your%"),
            Message.body.ilike("%recieved your%"),
            Message.body.ilike("%thanks for reaching out%"),
        )
        for lid, at, body in (
            db.query(Message.lead_id, Message.created_at, Message.body)
            .filter(Message.lead_id.in_(with_cards), Message.direction == "outbound",
                    Message.message_type == "TYPE_SMS", looks_like_intro).all()
        ):
            t = _ts(at)
            if t and is_intro_text(body):
                intros.setdefault(lid, []).append(t)
        for lid, at in (
            db.query(Estimate.lead_id, Estimate.sent_at)
            .filter(Estimate.lead_id.in_(with_cards), Estimate.sent_at.isnot(None),
                    Estimate.status.in_(("sent", "closed"))).all()
        ):
            t = _ts(at)
            if t:
                sends.setdefault(lid, []).append(t)

    # Every card is held to the rule, the first included: a lead whose only
    # card is the automation's (Michelle Stout — her form fill made the lead
    # before the poller stored any card) has no cycle at all, and all of
    # its history counts.
    out: dict[str, list[datetime]] = {}
    for lid, lst in cards.items():
        fills: list[datetime] = []
        for t in lst:
            if any(t - SEND_SHADOW <= s <= t for s in sends.get(lid, [])):
                continue   # the automation's card, right after a send
            if not any(t - INTRO_BEFORE <= it <= t + INTRO_AFTER for it in intros.get(lid, [])):
                continue   # nobody was welcomed: not a form fill
            if fills and t - fills[-1] <= SAME_INTAKE:
                continue
            fills.append(t)
        if fills:
            out[lid] = fills
    return out


def intake_times(db, lead) -> list[datetime]:
    return fills_by_lead(db, [lead.id]).get(lead.id, [])


def latest_intake(db, lead) -> datetime | None:
    times = intake_times(db, lead)
    return times[-1] if times else None


def _born(lead) -> datetime | None:
    return _ts(lead.ghl_created_at) or _ts(lead.created_at)


def _count_with_birth(fills: list[datetime], born: datetime | None) -> int:
    """Fills, plus the lead's own arrival when that was more than a day
    before the first card — a lead from before the poller whose first fill
    never got a card, and who then came back."""
    n = len(fills)
    if born and (not fills or fills[0] - born > SAME_INTAKE):
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
        # True when the journey is measured from the latest fill.
        "restarts": True,
    }


def last_intakes(db, lead_ids: list[str] | None) -> dict[str, str]:
    """lead_id -> the latest form fill, ISO, for sorting a list and for
    deciding whether an estimate went out since."""
    return {lid: fills[-1].isoformat() for lid, fills in fills_by_lead(db, lead_ids).items() if fills}


def intake_counts(db, lead_ids: list[str]) -> dict[str, int]:
    """lead_id -> how many times they came in (same rule as intake_summary),
    so a refill can be flagged on a list without a query per row."""
    from database import Lead
    if not lead_ids:
        return {}
    born = {lid: (_ts(g) or _ts(c)) for lid, g, c in
            db.query(Lead.id, Lead.ghl_created_at, Lead.created_at).filter(Lead.id.in_(lead_ids)).all()}
    fills = fills_by_lead(db, lead_ids)
    return {lid: _count_with_birth(fills.get(lid, []), born.get(lid)) for lid in lead_ids}
