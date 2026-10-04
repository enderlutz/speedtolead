"""
Contacts — a mirror of the GHL contact list.

The lead boards show whoever had an opportunity card in one of two polled
pipelines. This shows *everyone*, in GHL's own order (newest added first), so
"who have we not sent an estimate to?" can be answered against the whole
customer base instead of a subset of it.

See services/contact_mirror.py for how the mirror is filled and deduped.
"""
from __future__ import annotations
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_

from database import get_db, Contact, Lead, Message, AutomationLog, CallRecording, SmsQueue
from api.auth import get_current_user, require_admin

router = APIRouter()
logger = logging.getLogger(__name__)

# The estimate text carries a proposal link; an outbound message containing
# one is proof it went out. Kept in sync with api/estimates.py:845.
PROPOSAL_LINK = "proposal.atpressurewash.com/proposal/"

# Events the send path writes. `estimate_sent_to_customer` is logged at the
# moment the customer SMS is dispatched (api/estimates.py:873) and is the
# authoritative record — cross-checked against the texted link and against
# `proposal_viewed` on 2026-09-29, the three disagreed on 2 of 1,330 leads.
SENT_EVENTS = (
    "estimate_sent_to_customer",
    "custom_proposal_sent",
    "scheduled_sms_sent",
)

# How long past its send_at a queued estimate may sit before we stop calling
# it sent. The worker is punctual — across all 22 scheduled sends in
# production the median was 0 minutes late and the worst ever was 1 — but it
# polls on a 30s cycle, sleeps 2s between sends and takes up to 20 a batch,
# so a legitimately busy run can land a couple of minutes behind. Five
# minutes clears that comfortably without letting a genuinely stalled worker
# masquerade as a success for long.
QUEUE_GRACE_MINUTES = 5


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _iso_z(dt: datetime) -> str:
    """Render a UTC datetime the way `sms_queue.send_at` is stored.

    send_at comes straight from the browser's `Date.toISOString()`, so it is
    always `...sss` + `Z`. These columns are Text and compared as text, so a
    cutoff built with `.isoformat()` (`+00:00`, six decimals) would only sort
    correctly by accident. Matching the stored shape keeps it exact.
    """
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _scheduled_send_state(db, lead_ids: list[str] | None) -> tuple[set[str], set[str]]:
    """Split leads with a queued estimate into (in-flight, overdue).

    A scheduled estimate counts as sent the moment it is queued — the whole
    point of the ten-minute button is not having to come back in ten minutes
    to find out whether a customer has a price.

    Reading the live queue rather than the schedule-time log event is what
    makes the double-check automatic and continuous instead of a one-off
    sweep: the instant the worker marks a row cancelled, failed or blocked it
    stops qualifying here, and the contact reverts to "never sent" on the
    next load. There is no reconciliation job to write, schedule or trust.

    The one row that must *not* count is one still pending well past its
    send_at. That means the worker is stalled and nothing is going out, so
    calling it sent would be precisely the silent failure that reads as a
    success until the customer never replies — the trap that cost three
    customers in September (services/sms_worker.py:138).
    """
    q = db.query(SmsQueue.lead_id, SmsQueue.send_at).filter(SmsQueue.status == "pending")
    if lead_ids is not None:
        if not lead_ids:
            return set(), set()
        q = q.filter(SmsQueue.lead_id.in_(lead_ids))

    latest: dict[str, str] = {}
    for lid, send_at in q.all():
        if not lid:
            continue
        # Newest wins if a lead somehow has two queued, so a fresh re-send
        # isn't judged overdue because of a stale row behind it.
        if lid not in latest or (send_at or "") > latest[lid]:
            latest[lid] = send_at or ""

    cutoff = _iso_z(datetime.now(timezone.utc) - timedelta(minutes=QUEUE_GRACE_MINUTES))
    in_flight = {lid for lid, sa in latest.items() if sa >= cutoff}
    overdue = {lid for lid, sa in latest.items() if sa < cutoff}
    return in_flight, overdue


@router.get("/contacts")
def list_contacts(
    q: str | None = Query(None, description="name, phone or email substring"),
    estimate: str | None = Query(None, description="sent | not_sent"),
    has_lead: bool | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user: dict = Depends(get_current_user),
):
    """One page of the mirror, newest-added first — the GHL contact order.

    Each row carries the counts the team actually triages on: whether an
    estimate went out, and how much history we hold (texts, calls). Counts are
    computed per page, so widening the page costs proportionally and nothing
    scans the whole table.
    """
    del user
    db = get_db()
    try:
        query = db.query(Contact)

        if q:
            like = f"%{q.strip()}%"
            digits = "".join(ch for ch in q if ch.isdigit())
            clauses = [
                Contact.name.ilike(like),
                Contact.email.ilike(like),
                Contact.address.ilike(like),
            ]
            if digits:
                clauses.append(Contact.phone_key.like(f"%{digits[-10:]}%"))
            query = query.filter(or_(*clauses))

        if has_lead is True:
            query = query.filter(Contact.lead_id.isnot(None))
        elif has_lead is False:
            query = query.filter(Contact.lead_id.is_(None))

        total = query.count()

        # NULLS LAST: a contact with no dateAdded must not outrank Amy May.
        rows = (
            query.order_by(Contact.date_added.desc().nullslast())
            .offset(offset)
            .limit(limit)
            .all()
        )

        lead_ids = [r.lead_id for r in rows if r.lead_id]
        sent: set[str] = set()
        msg_counts: dict[str, int] = {}
        inbound_counts: dict[str, int] = {}
        call_counts: dict[str, int] = {}
        stage_by_lead: dict[str, tuple[str, str]] = {}
        # Queued estimates: in flight (counts as sent) vs stalled past its
        # send_at (does not). See _scheduled_send_state.
        scheduled: set[str] = set()
        overdue: set[str] = set()

        if lead_ids:
            # The pipeline still matters — it just no longer decides whether
            # somebody exists. Shown as an attribute of the contact.
            from services.pipeline_stages import STAGE_NAME_BY_ID
            from services.pipeline_stages_b import STAGE_NAME_BY_ID_B
            names = {**STAGE_NAME_BY_ID, **STAGE_NAME_BY_ID_B}
            for lid, ver, stage_id in (
                db.query(Lead.id, Lead.pipeline_version, Lead.ghl_pipeline_stage_id)
                .filter(Lead.id.in_(lead_ids)).all()
            ):
                stage_by_lead[lid] = (ver or "", names.get(stage_id or "", ""))

            sent = {
                r[0] for r in db.query(AutomationLog.lead_id)
                .filter(AutomationLog.lead_id.in_(lead_ids))
                .filter(AutomationLog.event_type.in_(SENT_EVENTS))
                .distinct().all()
            }
            # Belt and braces: an estimate texted before the log event existed
            # still counts. The link in an outbound message is the artefact.
            sent |= {
                r[0] for r in db.query(Message.lead_id)
                .filter(Message.lead_id.in_(lead_ids))
                .filter(Message.direction == "outbound")
                .filter(Message.body.contains(PROPOSAL_LINK))
                .distinct().all()
            }
            msg_counts = dict(
                db.query(Message.lead_id, func.count(Message.id))
                .filter(Message.lead_id.in_(lead_ids))
                .group_by(Message.lead_id).all()
            )
            inbound_counts = dict(
                db.query(Message.lead_id, func.count(Message.id))
                .filter(Message.lead_id.in_(lead_ids))
                .filter(Message.direction == "inbound")
                .group_by(Message.lead_id).all()
            )
            call_counts = dict(
                db.query(CallRecording.lead_id, func.count(CallRecording.id))
                .filter(CallRecording.lead_id.in_(lead_ids))
                .group_by(CallRecording.lead_id).all()
            )
            scheduled, overdue = _scheduled_send_state(db, lead_ids)
            sent |= scheduled

        out = []
        for r in rows:
            d = r.to_dict()
            lid = r.lead_id
            d["estimate_sent"] = bool(lid and lid in sent)
            # Lets the badge say "sending in 10 min" rather than a bare "sent",
            # and flag a stalled send instead of hiding it among the people we
            # genuinely never priced.
            d["estimate_scheduled"] = bool(lid and lid in scheduled)
            d["estimate_send_overdue"] = bool(lid and lid in overdue)
            d["message_count"] = int(msg_counts.get(lid, 0)) if lid else 0
            d["inbound_count"] = int(inbound_counts.get(lid, 0)) if lid else 0
            d["call_count"] = int(call_counts.get(lid, 0)) if lid else 0
            ver, stage = stage_by_lead.get(lid or "", ("", ""))
            # "contact" means this row exists only because the contact does —
            # nobody ever made an opportunity card for them.
            d["pipeline"] = "" if ver == "contact" else ver
            d["stage"] = stage
            out.append(d)

        # Filtering on estimate status is applied after the page is built,
        # because "sent" is derived from two other tables rather than stored
        # on the contact. Callers who need exact paging on it should use the
        # counts from /contacts/stats.
        if estimate == "sent":
            out = [c for c in out if c["estimate_sent"]]
        elif estimate == "not_sent":
            out = [c for c in out if not c["estimate_sent"]]

        return {"total": total, "limit": limit, "offset": offset, "contacts": out}
    finally:
        db.close()


@router.get("/contacts/stats")
def contact_stats(user: dict = Depends(get_current_user)):
    """Headline counts for the top of the page — the mirror's own scoreboard.

    `estimate_sent` is counted across the whole mirror here (not per page), so
    this is the number to trust when asking how many people have never been
    given a price.
    """
    del user
    db = get_db()
    try:
        total = db.query(func.count(Contact.id)).scalar() or 0
        with_lead = db.query(func.count(Contact.id)).filter(Contact.lead_id.isnot(None)).scalar() or 0
        no_phone = db.query(func.count(Contact.id)).filter(
            or_(Contact.phone_key == "", Contact.phone_key.is_(None))
        ).scalar() or 0
        dnd = db.query(func.count(Contact.id)).filter(Contact.dnd.is_(True)).scalar() or 0

        sent_ids = {
            r[0] for r in db.query(AutomationLog.lead_id)
            .filter(AutomationLog.event_type.in_(SENT_EVENTS))
            .filter(AutomationLog.lead_id.isnot(None))
            .distinct().all()
        }
        sent_ids |= {
            r[0] for r in db.query(Message.lead_id)
            .filter(Message.direction == "outbound")
            .filter(Message.body.contains(PROPOSAL_LINK))
            .filter(Message.lead_id.isnot(None))
            .distinct().all()
        }
        # Same rule as the rows, so the headline number can't disagree with
        # the badges underneath it.
        scheduled_ids, overdue_ids = _scheduled_send_state(db, None)
        sent_ids |= scheduled_ids

        linked = [r[0] for r in db.query(Contact.lead_id).filter(Contact.lead_id.isnot(None)).all()]
        estimate_sent = sum(1 for lid in linked if lid in sent_ids)
        send_overdue = sum(1 for lid in linked if lid in overdue_ids)

        newest = db.query(Contact).order_by(Contact.date_added.desc().nullslast()).first()
        oldest = db.query(Contact).order_by(Contact.date_added.asc().nullsfirst()).first()
        last_sync = db.query(func.max(Contact.synced_at)).scalar() or ""

        return {
            "total": total,
            "with_lead": with_lead,
            "without_lead": total - with_lead,
            "estimate_sent": estimate_sent,
            "no_estimate": total - estimate_sent,
            "send_overdue": send_overdue,
            "no_phone": no_phone,
            "dnd": dnd,
            "newest": (newest.name if newest else ""),
            "oldest": (oldest.name if oldest else ""),
            "last_sync": last_sync,
        }
    finally:
        db.close()


@router.post("/contacts/sync")
def sync_contacts_endpoint(
    create_leads: bool = Query(True, description="create inert lead rows for contacts that have none, so their texts and calls can be pulled"),
    user: dict = Depends(require_admin),
):
    """Re-mirror the GHL contact list. Synchronous; returns the counts.

    Admin-only and safe to re-run — keyed on the GHL contact id, so a second
    sweep updates in place. Nothing here messages a customer: see
    services/contact_mirror.py:_create_shadow_lead.
    """
    del user
    from services.contact_mirror import sync_all_locations
    return sync_all_locations(create_leads=create_leads)
