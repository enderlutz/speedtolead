"""One line per customer: where they are in the journey and what to do next.

Alan (2026-10-12): the Contacts page should say "what part of the customer
journey they are on … basically telling us what to do next with that
customer." Measured from their latest form fill (services/intake.py): a
customer who fills the form again starts over, so an estimate, a call or a
reply from before that fill doesn't count for this visit.

The order is the attack order (Alan, 2026-10-09): address → a real
conversation → price it → they open it → they reply → they book.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import func

from clock import to_ct
import json

from database import Booking, CallDisposition, CallRecording, CallTone, CallTranscript, Lead, Message, PayLink, ScheduledJob
from services.callback_promise import find_promise
from services.followup_status import TALKED_OUTCOMES
from services.intake import last_intakes

# A send nobody has opened: how long before the step turns into a nudge.
WAIT_DAYS = 2
# A call counts as a conversation on the same rule as the discovery call.
TALK_SECONDS = 30
# A call-back day agreed on a call stops counting a week after it passes.
PROMISE_STALE_DAYS = 7


def _ts(value) -> datetime | None:
    if not value:
        return None
    try:
        d = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _step(key: str, stage: str, next_: str, tone: str) -> dict:
    return {"key": key, "stage": stage, "next": next_, "tone": tone}


# The step of the customer journey, in the lead page's words (Alan,
# 2026-11-04): "put what part of the customer journey they're in". Anyone we
# haven't actually talked to on the phone is on the discovery call, sent
# estimate or not: we keep calling until they pick up.
_JOURNEY = {
    "stopped": "Stopped",
    "done": "Review + referral",
    "scheduled": "Job booked",
    "booked": "Schedule the job",
    "callback": "Call back",
    "replied": "Heard back",
    "viewed": "Follow-up call",
    "sent": "Follow-up call",
    "overdue": "Sending",
    "sending": "Sending",
    "address": "Address",
    "price": "Price it",
    "discovery": "Discovery call",
}
_STILL_TO_TALK = {"replied", "viewed", "sent"}


# After a real conversation and a sent estimate, when to call back (Alan,
# 2026-11-04: "put the day we should call him back for a follow-up"). The
# AI listener's own pick from the call (call_tones follow_up.when_days),
# else two days: long enough to talk it over at home, short enough that it
# doesn't go cold. Never later than two days before a day we're holding.
FOLLOW_UP_DAYS = 2
HOLD_LEAD_DAYS = 2


def follow_up_day(talked_on, when_days, held_on, today):
    """The calendar day to call. `talked_on`/`held_on`/`today` are dates."""
    days = when_days if isinstance(when_days, int) and 1 <= when_days <= 14 else FOLLOW_UP_DAYS
    day = talked_on + timedelta(days=days)
    if held_on and held_on > talked_on:
        day = min(day, max(talked_on + timedelta(days=1), held_on - timedelta(days=HOLD_LEAD_DAYS)))
    if day.weekday() == 6:  # a Sunday call is a Monday call
        day += timedelta(days=1)
    return day


def _day_label(d) -> str:
    return f"{d.strftime('%a')} {d.month}/{d.day}"


def _journey(key: str, talked: bool) -> str:
    if key in _STILL_TO_TALK and not talked:
        return "Discovery call"
    return _JOURNEY.get(key, "")


def next_steps(db, lead_ids: list[str], *, last_send: dict[str, datetime],
               scheduled=frozenset(), overdue=frozenset(), stopped=frozenset(),
               now: datetime | None = None) -> dict[str, dict]:
    """lead_id -> {key, stage, next, tone} for every lead on the page.

    `last_send` is each lead's latest estimate send (api/contacts.py works it
    out for the page already); `scheduled`/`overdue` are queued sends in
    flight or stuck; `stopped` are the people who opted out or asked us to
    stop. Everything else is read here, one query per fact, for the page.
    """
    if not lead_ids:
        return {}
    now = now or datetime.now(timezone.utc)
    leads = {lead.id: lead for lead in db.query(Lead).filter(Lead.id.in_(lead_ids)).all()}
    intakes = {lid: _ts(t) for lid, t in last_intakes(db, lead_ids).items()}
    last_in = {
        lid: _ts(t) for lid, t in
        db.query(Message.lead_id, func.max(Message.created_at))
        .filter(Message.lead_id.in_(lead_ids), Message.direction == "inbound")
        .group_by(Message.lead_id).all()
    }
    talked: dict[str, datetime] = {}
    for lid, t in (
        db.query(CallRecording.lead_id, func.max(CallRecording.created_at))
        .filter(CallRecording.lead_id.in_(lead_ids), CallRecording.is_voicemail.is_(False),
                CallRecording.duration_seconds >= TALK_SECONDS)
        .group_by(CallRecording.lead_id).all()
    ):
        d = _ts(t)
        if d:
            talked[lid] = d
    for lid, t in (
        db.query(CallDisposition.lead_id, func.max(CallDisposition.disposed_at))
        .filter(CallDisposition.lead_id.in_(lead_ids), CallDisposition.outcome.in_(TALKED_OUTCOMES))
        .group_by(CallDisposition.lead_id).all()
    ):
        d = _ts(t)
        if d and (lid not in talked or d > talked[lid]):
            talked[lid] = d
    # The last real call's transcript, for a call-back day agreed on it
    # (Alan, 2026-10-17, Marie Reed: "call me back Monday").
    promises: dict[str, tuple[datetime, dict]] = {}
    for lid, created, text in (
        db.query(CallRecording.lead_id, CallRecording.created_at, CallTranscript.full_text)
        .join(CallTranscript, CallTranscript.recording_id == CallRecording.id)
        .filter(CallRecording.lead_id.in_(lead_ids), CallRecording.is_voicemail.is_(False),
                CallRecording.duration_seconds >= TALK_SECONDS,
                CallRecording.created_at >= (now - timedelta(days=21)).isoformat())
        .order_by(CallRecording.created_at.desc()).all()
    ):
        if lid in promises:
            continue
        at = _ts(created)
        p = find_promise(text or "", created) if at else None
        promises[lid] = (at, p) if p else (at, {})
    today = to_ct(now).date()
    paid = {
        lid for (lid,) in
        db.query(PayLink.lead_id)
        .filter(PayLink.lead_id.in_(lead_ids), PayLink.kind.in_(("deposit", "full")), PayLink.status == "paid")
        .all()
    }
    jobs: dict[str, tuple[str, str | None]] = {}
    for lid, job_date, done in (
        db.query(ScheduledJob.lead_id, ScheduledJob.job_date, ScheduledJob.completed_at)
        .filter(ScheduledJob.lead_id.in_(lead_ids)).order_by(ScheduledJob.job_date.desc()).all()
    ):
        jobs.setdefault(lid, (job_date or "", done))

    def since_intake(lid: str, t: datetime | None) -> bool:
        i = intakes.get(lid)
        return t is not None and (i is None or t >= i)

    out: dict[str, dict] = {}
    for lid in lead_ids:
        lead = leads.get(lid)
        if lead is None:
            continue
        intake = intakes.get(lid)

        def since(t: datetime | None) -> bool:
            return t is not None and (intake is None or t >= intake)

        if lid in stopped or lead.do_not_contact:
            out[lid] = _step("stopped", "Asked us to stop", "Don't text them.", "off")
            continue
        job = jobs.get(lid)
        if job and job[1]:
            out[lid] = _step("done", "Job done", "Ask for the review and a referral.", "warm")
            continue
        if job:
            out[lid] = _step("scheduled", f"Job on {job[0]}", "Nothing until the job.", "cold")
            continue
        if lid in paid or (lead.deposit_status or "") == "paid":
            out[lid] = _step("booked", "Deposit paid", "Schedule the job.", "hot")
            continue
        at, promise = promises.get(lid, (None, {}))
        replied_after = last_in.get(lid)
        if (promise and since(at) and not (replied_after and replied_after > at)
                and (today - promise["day"]).days <= PROMISE_STALE_DAYS):
            day = promise["day"]
            label = f"{day.strftime('%a')} {day.month}/{day.day}"
            if today < day:
                out[lid] = _step("callback", f"On the call: {'they will call' if promise['they_call'] else 'call them'} {label}",
                                 f"Wait. {'They said they would call' if promise['they_call'] else 'They asked for a call'} {label}. Don't call before then.",
                                 "cold")
            else:
                out[lid] = _step("callback", f"Call-back day: {label}",
                                 f"They said {label}. Call them if they haven't called." if promise["they_call"]
                                 else f"Call them today. They asked for a call {label}.", "hot")
            continue
        sent = last_send.get(lid)
        if since(sent):
            replied = last_in.get(lid)
            if replied and replied >= sent:
                out[lid] = _step("replied", "Replied to the estimate", "Answer them.", "hot")
                continue
            viewed = _ts(getattr(lead, "proposal_last_viewed_at", None)) or _ts(lead.proposal_viewed_at)
            if viewed and viewed >= sent:
                out[lid] = _step("viewed", "Opened it, no reply", "Call them.", "hot")
                continue
            if now - sent >= timedelta(days=WAIT_DAYS):
                out[lid] = _step("sent", "Sent, not opened", "Nudge them.", "warm")
                continue
            out[lid] = _step("sent", "Estimate sent", "Give them a day.", "cold")
            continue
        if lid in overdue:
            out[lid] = _step("overdue", "Send stuck", "Check the queue.", "hot")
            continue
        if lid in scheduled:
            out[lid] = _step("sending", "Estimate queued", "Sending in a few minutes.", "cold")
            continue
        if not (lead.address or "").strip():
            out[lid] = _step("address", "No address", "Ask for the address.", "hot")
            continue
        if since(talked.get(lid)):
            out[lid] = _step("price", "Talked, not priced", "Price it today.", "hot")
            continue
        if since(last_in.get(lid)):
            out[lid] = _step("discovery", "Replied, no call yet", "Call them, then price it.", "hot")
            continue
        out[lid] = _step("discovery", "New, no answer yet", "Call them. No answer? Price it anyway.", "warm")
    for lid, step in out.items():
        step["journey"] = _journey(step["key"], since_intake(lid, talked.get(lid)))

    # The follow-up call gets its day.
    due = [lid for lid, st in out.items() if st["journey"] == "Follow-up call"]
    if due:
        picks: dict[str, int | None] = {}
        for lid, raw in (
            db.query(CallRecording.lead_id, CallTone.listen_json)
            .join(CallTone, CallTone.recording_id == CallRecording.id)
            .filter(CallRecording.lead_id.in_(due), CallRecording.is_voicemail.is_(False),
                    CallTone.listen_json != "")
            .order_by(CallRecording.created_at.desc()).all()
        ):
            if lid in picks:
                continue
            try:
                picks[lid] = ((json.loads(raw) or {}).get("follow_up") or {}).get("when_days")
            except (ValueError, AttributeError):
                picks[lid] = None
        held: dict[str, str] = {}
        for lid, d in (
            db.query(Booking.lead_id, Booking.date)
            .filter(Booking.lead_id.in_(due), Booking.status != "cancelled", Booking.sent_at.isnot(None))
            .order_by(Booking.created_at.desc()).all()
        ):
            held.setdefault(lid, d or "")
        for lid in due:
            t = talked.get(lid)
            if not t:
                continue
            try:
                held_on = datetime.strptime(held[lid], "%Y-%m-%d").date() if held.get(lid) else None
            except ValueError:
                held_on = None
            day = follow_up_day(to_ct(t).date(), picks.get(lid), held_on, today)
            step = out[lid]
            step["follow_up_on"] = day.isoformat()
            label = _day_label(day)
            step["journey"] = f"Follow-up call {label}"
            hold = f" We're holding {_day_label(held_on)}." if held_on and held_on >= today else ""
            if day > today:
                step["next"], step["tone"] = f"Wait until {label}, then call.{hold}", "cold"
            elif day == today:
                step["next"], step["tone"] = f"Call them today.{hold}", "hot"
            else:
                step["next"], step["tone"] = f"Late: it was due {label}. Call them now.{hold}", "hot"
    return out
