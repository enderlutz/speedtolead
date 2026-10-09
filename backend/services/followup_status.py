"""What has happened since the estimate went out — for the lead page.

Alan's question, 2026-10-08: when we send an estimate, did we start the
follow-ups or not, are they still going, and how many times have we tried to
call since?

The follow-ups are GHL workflows started by the "estimate sent" tag. Nothing
here can look inside a GHL workflow, so this reports the evidence instead:

* **Started?** Every send without the tag logs `estimate_sent_tag_skipped`
  (277 of 1,755 sends so far). A send with no such entry put the tag on.
* **Still going?** Alan's rule: the workflows run while the opportunity sits
  in ESTIMATE SENT. Once it moves — they replied, booked, declined — they
  stop. So the current stage is the answer.
* **Texts actually sent.** Automated follow-ups are templates: the same
  message goes to hundreds of customers ("wanted to make sure your estimate
  didn't get lost in the shuffle" went to 353). A text counts as automated
  when its wording, with names, links, prices and numbers blanked, was sent
  to five or more customers after their estimate. Measured over 120 days:
  5,656 of 10,186 post-estimate texts matched; the rest were typed by a
  person.
* **Calls.** Every call attempt is in the message history as TYPE_CALL,
  answered or not, but with no outcome. A call counts as connected when it
  has a non-voicemail recording of 30 seconds or more, or someone logged it
  as a real conversation.
"""
from __future__ import annotations

import json
import re
import threading
import time
from datetime import datetime, timedelta, timezone

TEMPLATE_MIN_CUSTOMERS = 5
TEMPLATE_WINDOW_DAYS = 120
_CACHE_SECONDS = 6 * 3600
_cache: dict = {"at": 0.0, "keys": frozenset()}
_lock = threading.Lock()

TALKED_OUTCOMES = {
    "closed", "objection_price", "objection_timing", "objection_spouse",
    "objection_hoa", "objection_more_estimates", "callback",
}

_GREETING = re.compile(r"^(hi|hey|hello|good (morning|afternoon|evening))[ ,!]+\w+[,!. ]*")


def template_key(body: str | None) -> str:
    """A message's wording with the per-customer parts blanked out."""
    b = (body or "").lower()
    b = re.sub(r"https?://\S+", "<url>", b)
    b = re.sub(r"\$[\d,\.]+", "<$>", b)
    b = re.sub(r"\d+", "#", b)
    b = re.sub(r"\s+", " ", b).strip()
    return _GREETING.sub("", b)[:70]


def _ts(value) -> datetime | None:
    if not value:
        return None
    try:
        d = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def automated_template_keys(db, *, force: bool = False) -> frozenset:
    """Wordings sent to TEMPLATE_MIN_CUSTOMERS+ customers after their estimate.
    Recomputed every six hours; one query over ~10k rows."""
    with _lock:
        if not force and time.time() - _cache["at"] < _CACHE_SECONDS and _cache["keys"]:
            return _cache["keys"]
    from sqlalchemy import text as sql
    since = (datetime.now(timezone.utc) - timedelta(days=TEMPLATE_WINDOW_DAYS)).isoformat()
    rows = db.execute(sql("""
        SELECT m.lead_id, m.body FROM messages m
        JOIN (SELECT lead_id, MIN(sent_at) AS t FROM estimates
              WHERE status IN ('sent', 'closed') AND sent_at IS NOT NULL GROUP BY lead_id) fs
          ON fs.lead_id = m.lead_id
        WHERE m.direction = 'outbound' AND m.message_type = 'TYPE_SMS'
          AND m.created_at > fs.t AND m.created_at >= :since
    """), {"since": since}).fetchall()
    seen: dict[str, set] = {}
    for lead_id, body in rows:
        k = template_key(body)
        if len(k) >= 12:    # blank / link-only messages say nothing about who wrote them
            seen.setdefault(k, set()).add(lead_id)
    keys = frozenset(k for k, leads in seen.items() if len(leads) >= TEMPLATE_MIN_CUSTOMERS)
    with _lock:
        _cache.update(at=time.time(), keys=keys)
    return keys


def cycle_sends(db, lead) -> tuple[datetime | None, list[datetime]]:
    """(when this customer last came in, the estimate sends since then).

    A customer who fills the form again starts over (services/intake.py), so
    an estimate sent before that refill is a previous cycle's: it doesn't
    count as "sent", and a call before it isn't this cycle's discovery call.
    """
    from database import Estimate
    from services.intake import latest_intake

    intake = latest_intake(db, lead)
    sends = sorted(
        t for t in (
            _ts(r[0]) for r in db.query(Estimate.sent_at)
            .filter(Estimate.lead_id == lead.id, Estimate.sent_at.isnot(None),
                    Estimate.status.in_(("sent", "closed"))).all()
        ) if t and (intake is None or t >= intake)
    )
    return intake, sends


def after_estimate(db, lead) -> dict | None:
    """The block the lead page shows under "Estimate sent". None until an
    estimate has gone out — since the customer last came in."""
    from database import (
        AutomationLog, CallDisposition, CallRecording, Message,
    )
    from services.pipeline_stages import STAGE_NAME_BY_ID
    from services.pipeline_stages_b import ESTIMATE_SENT_STAGE_ID_B, STAGE_NAME_BY_ID_B

    _, sends = cycle_sends(db, lead)
    if not sends:
        return None
    first_sent, last_sent = sends[0], sends[-1]

    # Did the latest send put the follow-up tag on?
    log = (
        db.query(AutomationLog.event_type, AutomationLog.created_at)
        .filter(AutomationLog.lead_id == lead.id,
                AutomationLog.event_type.in_(("estimate_sent_tag_skipped",
                                              "estimate_sent_tag_deferred",
                                              "estimate_sent_tag_applied")))
        .all()
    )
    window = timedelta(minutes=10)
    skipped = any(e == "estimate_sent_tag_skipped" and _ts(t) and abs(_ts(t) - last_sent) <= window
                  for e, t in log)
    # A scheduled send logs "deferred" when booked and "applied" when it goes.
    deferred = any(e == "estimate_sent_tag_deferred" for e, _ in log) and not any(
        e == "estimate_sent_tag_applied" for e, _ in log)

    a_sent = "dc3600f2-009b-4075-95fa-786823131416"
    stage_id = lead.ghl_pipeline_stage_id or ""
    in_sent_stage = stage_id in (a_sent, ESTIMATE_SENT_STAGE_ID_B)
    stage_name = STAGE_NAME_BY_ID.get(stage_id) or STAGE_NAME_BY_ID_B.get(stage_id) or ""

    if skipped:
        status = "not_started"
    elif deferred and datetime.now(timezone.utc) < last_sent:
        status = "waiting"           # scheduled send, tag goes on when it does
    elif in_sent_stage:
        status = "running"
    else:
        status = "stopped"

    # Texts and calls since the latest send. The estimate text itself goes
    # out within a minute or two of the send, so it isn't a follow-up.
    keys = automated_template_keys(db)
    after = last_sent + timedelta(minutes=3)
    outbound = (
        db.query(Message.message_type, Message.body, Message.created_at)
        .filter(Message.lead_id == lead.id, Message.direction == "outbound",
                Message.message_type.in_(("TYPE_SMS", "TYPE_CALL")))
        .all()
    )
    auto_texts = [t for kind, body, t in outbound
                  if kind == "TYPE_SMS" and _ts(t) and _ts(t) > after and template_key(body) in keys]
    calls = [t for kind, _, t in outbound if kind == "TYPE_CALL" and _ts(t) and _ts(t) > last_sent]

    # A conversation counts if it happened after the send — including a call
    # that started BEFORE the send and was still going 30s+ after it. That's
    # the estimate sent while the customer is on the line (Ray Rascoe: call
    # at 4:20, estimate at 4:23, 22 more minutes of conversation). GHL stamps
    # the call at its start, so a start-time check alone missed it.
    connected = 0
    on_call_at_send = False
    for start, secs, vm in (
        db.query(CallRecording.created_at, CallRecording.duration_seconds, CallRecording.is_voicemail)
        .filter(CallRecording.lead_id == lead.id).all()
    ):
        t, secs = _ts(start), int(secs or 0)
        if not t or vm or secs < 30:
            continue
        if t > last_sent:
            connected += 1
        elif t + timedelta(seconds=secs) >= last_sent + timedelta(seconds=30):
            connected += 1
            on_call_at_send = True
    talked_logged = sum(
        1 for outcome, at in db.query(CallDisposition.outcome, CallDisposition.disposed_at)
        .filter(CallDisposition.lead_id == lead.id).all()
        if outcome in TALKED_OUTCOMES and _ts(at) and _ts(at) > last_sent
    )

    def iso(d):
        return d.isoformat() if d else None

    return {
        "first_sent_at": iso(first_sent),
        "last_sent_at": iso(last_sent),
        "status": status,               # running | stopped | not_started | waiting
        "stage_name": stage_name,
        "auto_texts": len(auto_texts),
        "last_auto_text_at": max(auto_texts, key=lambda t: _ts(t)) if auto_texts else None,
        # A connected call was also a call tried. Recordings uploaded from the
        # browser never appear in GHL's message history, so without this
        # "tried" could read lower than "connected" (Carolyn Johnson: 0 / 2).
        "calls_tried": max(len(calls), connected, talked_logged),
        "calls_connected": max(connected, talked_logged),
        "last_call_at": max(calls, key=lambda t: _ts(t)) if calls else None,
        "on_call_at_send": on_call_at_send,
    }


def discovery_call(db, lead) -> dict:
    """Did we talk to this customer on the phone before the estimate went out?

    Alan's definition (2026-10-08): a real conversation whose call STARTED
    before the first estimate was sent — which includes the call where the
    estimate is sent while they're on the line, because GHL stamps a call at
    the moment it starts. Tracked so close rates can later be compared with
    and without one.

    A call counts as a conversation on the same rule as calls_connected: a
    non-voicemail recording of 30 seconds or more. A call logged as a real
    conversation (closed, an objection, call back) also counts when it was
    logged before the first send. With no estimate sent yet, any such call so
    far counts.

    Measured within the current cycle (2026-10-09): from the customer's
    latest form fill to the first estimate sent after it. A conversation
    from a previous cycle doesn't carry over — if they came back, we talk to
    them again. Reports how long after the form the call came and how long
    it ran, which is what the discovery-call statistics are built from.
    """
    from database import CallDisposition, CallRecording

    intake, sends = cycle_sends(db, lead)
    first_sent = sends[0] if sends else None

    def before(t):
        return (t is not None and (intake is None or t >= intake)
                and (first_sent is None or t <= first_sent))

    calls = []
    for start, secs, vm in (
        db.query(CallRecording.created_at, CallRecording.duration_seconds, CallRecording.is_voicemail)
        .filter(CallRecording.lead_id == lead.id).all()
    ):
        t = _ts(start)
        if before(t) and not vm and int(secs or 0) >= 30:
            calls.append((t, int(secs or 0)))
    for outcome, at in (
        db.query(CallDisposition.outcome, CallDisposition.disposed_at)
        .filter(CallDisposition.lead_id == lead.id).all()
    ):
        t = _ts(at)
        if outcome in TALKED_OUTCOMES and before(t):
            calls.append((t, 0))
    base = {
        "intake_at": intake.isoformat() if intake else None,
        "estimate_sent": first_sent is not None,
    }
    if not calls:
        return {**base, "done": False, "at": None, "seconds": 0, "mid_call_send": False,
                "minutes_from_intake": None}
    calls.sort()
    first_at, secs = calls[0]
    # Was the estimate sent while they were on this call?
    mid = any(first_sent and t <= first_sent <= t + timedelta(seconds=s + 60) for t, s in calls if s)
    # The longest conversation before the send is the discovery call's
    # length — a 5-second connect followed by a 10-minute call-back is a
    # 10-minute discovery call.
    longest = max(s for _, s in calls)
    return {
        **base,
        "done": True,
        "at": first_at.isoformat(),
        "seconds": longest,
        "mid_call_send": bool(mid),
        "minutes_from_intake": (
            max(0, int((first_at - intake).total_seconds() // 60)) if intake else None
        ),
    }
