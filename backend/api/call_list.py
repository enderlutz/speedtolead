"""
Call List API — shared priority queue of leads to call back.

The sales team runs aggressive callback campaigns on leads in the
post-estimate range. This endpoint surfaces those leads sorted by deal
size (signature price), with a Priority tier for $1500+. One-tap
'called' marks the lead as touched and suppresses it from the list for
24 hours.

Shared across admin + VA users — when Olga marks a lead called, it
disappears for Alan too. Per user's framing: it's a team campaign.

Stage filter: CALL_LIST_STAGE_IDS (services/pipeline_stages.py) covers
ESTIMATE SENT through DEAL CLOSED & NOT SCHEDULED, intentionally
excluding DECLINED ESTIMATE and CLOSED & SCHEDULED+.

Workers don't see this endpoint — UI gating is handled in the frontend
panel mount (App.tsx checks role).
"""
from __future__ import annotations
import json
import uuid
import logging
from datetime import datetime, timezone, timedelta, date
from fastapi import APIRouter, HTTPException, Depends, Query
from sqlalchemy import desc

from database import (
    get_db, Lead, Estimate, CallTouch, CallDisposition, ScheduledJob, CallIntent,
    ThreadIntent,
)
import clock
from api.auth import require_staff
from services.pipeline_stages import CALL_LIST_STAGE_IDS, STAGE_NAME_BY_ID
from services.follow_up_flags import compute_follow_up_flag
from services.geo import haversine
from services.geocoder import geocode_address

router = APIRouter()
logger = logging.getLogger(__name__)

# Threshold (USD signature price) for the Priority bucket per user spec.
PRIORITY_VALUE_THRESHOLD = 1500.0

# Suppression window — how long a lead stays off the list after being
# marked called. 24h gives the customer a day to call back before we
# resurface them in the queue.
SUPPRESSION_HOURS = 24

# How warm the customer sounded, for ordering WITHIN a priority bucket. An
# impression rather than a request, so it never jumps a bucket on its own.
_TEMP_RANK = {"hot": 3, "warm": 2, "unknown": 1, "cold": 0}


def _call_time(ci) -> str:
    """When the call happened; falls back to read time for rows that predate
    call_at. The backlog reads newest calls first, so read time alone would
    headline a lead's OLDEST call."""
    return ci.call_at or ci.created_at or ""


def _is_conversation(ci) -> bool:
    """Did anyone actually talk? A voicemail or a dropped ring reads as
    temperature "unknown" with nothing wanted, promised or asked. On the
    first live run Amy's 24-second voicemail from this afternoon was the
    "latest call" for a customer Alan had spent sixteen minutes with on
    Friday — and the row said "never spoken to anyone"."""
    if (ci.temperature or "unknown") != "unknown":
        return True
    return bool((ci.wanted or "").strip() or (ci.commitment or "").strip()
                or (ci.callback_phrase or "").strip())


def _days_since(iso_ts: str, today_ct: str) -> int:
    """Whole Houston days from a timestamp to today. Huge when unknown, so a
    missing date never reads as "just now"."""
    try:
        day = clock.ct_date_of(iso_ts) if iso_ts else ""
        if not day:
            return 10_000
        return (date.fromisoformat(today_ct) - date.fromisoformat(day)).days
    except (TypeError, ValueError):
        return 10_000


def _callback_boost(callback_at: str, today_ct: str) -> int:
    """How much "call me on <day>" lifts a lead, by how overdue it is.

    Due today or within the last week: the strongest reason on the list.
    Up to a month late: still worth chasing, but behind fresher asks. Older
    than that it is a promise that died — on the first live run a "call me
    tomorrow" from June 11 sat at the top in September.
    """
    if not callback_at or callback_at > today_ct:
        return 0
    try:
        late = (date.fromisoformat(today_ct) - date.fromisoformat(callback_at[:10])).days
    except (TypeError, ValueError):
        return 0
    return 900 if late <= 7 else (400 if late <= 30 else 0)


def _superseded(own_at: str, own_temp: str, other, other_at: str) -> bool:
    """Does a later, colder conversation override this one's callback?

    A promise made on a warm call doesn't survive the customer texting
    "we're gonna pass" three days later. Seen live: a declined customer's
    old "call me Friday" was still being counted as a due callback because
    the two channels' boosts were simply added together, whichever read
    made them was ignored.
    """
    if own_temp == "cold":
        return True
    if other is not None and other_at > own_at \
            and (getattr(other, "temperature", "") or "") == "cold":
        return True
    return False


def _warmest(*temps: str) -> str:
    known = [t for t in temps if t]
    if not known:
        return "unknown"
    return max(known, key=lambda t: _TEMP_RANK.get(t, 1))


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _latest_signature_price(db, lead_id: str) -> float:
    """Pull signature tier from the lead's most recent estimate. Returns
    0.0 if no estimate or signature missing — caller treats those leads
    as low-priority but still surfaces them."""
    est = (
        db.query(Estimate)
        .filter(Estimate.lead_id == lead_id)
        .order_by(desc(Estimate.created_at))
        .first()
    )
    if not est:
        return 0.0
    try:
        tiers = json.loads(est.tiers or "{}")
    except (TypeError, ValueError, json.JSONDecodeError):
        return 0.0
    try:
        return float(tiers.get("signature") or 0)
    except (TypeError, ValueError):
        return 0.0


@router.get("/call-list")
def get_call_list(
    user: dict = Depends(require_staff),
    near_zip: str = Query("", description="5-digit ZIP. When provided, leads are sorted by distance from that ZIP ascending."),
):
    """Return leads in the post-estimate range, sorted by signature price.
    Excludes leads called in the last 24h. Excludes DECLINED ESTIMATE and
    everything past DEAL CLOSED & NOT SCHEDULED per pipeline_stages.CALL_LIST_STAGE_IDS.

    When `near_zip` is provided, distance from that ZIP's centroid is
    computed per lead and the list is re-sorted by distance ascending
    (overrides the priority sort). Useful when the rep wants to plan
    a route through a specific neighborhood."""
    del user
    db = get_db()
    try:
        # near_zip filter — geocode the target zip ONCE up front, then
        # compare every lead's coords against it. Geocode failures
        # (invalid ZIP, Maps key missing) degrade to "no filter applied"
        # rather than erroring — we just don't decorate distance and
        # the list keeps the default sort.
        near_target: tuple[float, float] | None = None
        near_zip_clean = (near_zip or "").strip()
        if near_zip_clean:
            geo = geocode_address(near_zip_clean)
            if geo and geo.get("lat") and geo.get("lng"):
                near_target = (float(geo["lat"]), float(geo["lng"]))
        # Per-zip centroid cache for lead-side fallback when a lead has
        # no lat/lng yet but does have a zip_code.
        zip_centroid_cache: dict[str, tuple[float, float] | None] = {}

        def _zip_centroid(z: str) -> tuple[float, float] | None:
            z = (z or "").strip()
            if not z:
                return None
            if z in zip_centroid_cache:
                return zip_centroid_cache[z]
            g = geocode_address(z)
            coords = None
            if g and g.get("lat") and g.get("lng"):
                coords = (float(g["lat"]), float(g["lng"]))
            zip_centroid_cache[z] = coords
            return coords

        # Suppression cutoff — lead reappears once 24h have passed since
        # their most recent touch.
        cutoff_iso = (_now_utc() - timedelta(hours=SUPPRESSION_HOURS)).isoformat()
        recently_touched_lead_ids = {
            t.lead_id
            for t in db.query(CallTouch).filter(CallTouch.marked_at >= cutoff_iso).all()
        }

        # Base query: in-range leads, not currently suppressed.
        leads = (
            db.query(Lead)
            .filter(Lead.ghl_pipeline_stage_id.in_(list(CALL_LIST_STAGE_IDS)))
            .filter(Lead.pipeline_version == "v2")
            .all()
        )

        # Sprint 3 T3.E (2026-06-07). Pre-load upcoming scheduled jobs
        # (today → 14 days ahead, non-cancelled) once so each call-list
        # row can check for ZIP-match proximity in O(1). ZIP-only by
        # design: same-ZIP is the strongest signal per client, distance
        # is computed only for display when both sides have coords. No
        # geocoder calls fired in the hot path here.
        from datetime import date as _date_cls
        today_iso = _date_cls.today().isoformat()
        end_iso = (_date_cls.today() + timedelta(days=14)).isoformat()
        upcoming_jobs = (
            db.query(ScheduledJob)
            .filter(ScheduledJob.job_date >= today_iso)
            .filter(ScheduledJob.job_date <= end_iso)
            .filter(ScheduledJob.status != "cancelled")
            .all()
        )
        # Bucket by ZIP for O(1) lookup per lead.
        upcoming_by_zip: dict[str, list] = {}
        for j in upcoming_jobs:
            z = (j.zip_code or "").strip()
            if not z:
                continue
            upcoming_by_zip.setdefault(z, []).append(j)
        # Sort each ZIP bucket by job_date ascending so 'closest in time'
        # is also 'first in list' when there are multiple matches.
        for z in upcoming_by_zip:
            upcoming_by_zip[z].sort(key=lambda j: j.job_date or "")

        # Batch-load latest disposition + latest estimate for every in-list
        # lead so the follow-up flag compute is O(1) per lead, not N+1.
        # Sprint 2 T2.E (2026-06-07).
        lead_ids = [l.id for l in leads if l.id not in recently_touched_lead_ids]
        latest_disp_by_lead: dict[str, CallDisposition] = {}
        if lead_ids:
            # Newest-first over the whole set; first row per lead_id wins.
            for d in (
                db.query(CallDisposition)
                .filter(CallDisposition.lead_id.in_(lead_ids))
                .order_by(desc(CallDisposition.disposed_at))
                .all()
            ):
                if d.lead_id not in latest_disp_by_lead:
                    latest_disp_by_lead[d.lead_id] = d
        latest_est_by_lead: dict[str, Estimate] = {}
        if lead_ids:
            for e in (
                db.query(Estimate)
                .filter(Estimate.lead_id.in_(lead_ids))
                .order_by(desc(Estimate.sent_at))
                .all()
            ):
                if e.lead_id not in latest_est_by_lead and e.sent_at:
                    latest_est_by_lead[e.lead_id] = e

        # Latest customer-intent read per lead — what THEY said on their most
        # recent CALL. Chosen by when the call happened, not when it was
        # read: the backlog reads newest calls first, so for a lead with
        # several calls the most recently WRITTEN row is their oldest call.
        # ...and by whether anyone talked: the latest real conversation wins
        # over any number of voicemails after it. Those are counted instead,
        # as attempts since.
        latest_intent_by_lead: dict[str, CallIntent] = {}
        attempts_since: dict[str, int] = {}
        if lead_ids:
            by_lead: dict[str, list] = {}
            for ci in db.query(CallIntent).filter(CallIntent.lead_id.in_(lead_ids)).all():
                by_lead.setdefault(ci.lead_id, []).append(ci)
            for lid, reads in by_lead.items():
                best = max(reads, key=lambda c: (_is_conversation(c), _call_time(c)))
                latest_intent_by_lead[lid] = best
                attempts_since[lid] = sum(
                    1 for c in reads
                    if not _is_conversation(c) and _call_time(c) > _call_time(best)
                )

        # And the latest read of their TEXT thread. One row per read of the
        # whole thread, so the newest read is the conversation's current
        # state. Same first-row-wins shape as the dispositions above.
        latest_thread_by_lead: dict[str, ThreadIntent] = {}
        if lead_ids:
            for ti in (
                db.query(ThreadIntent)
                .filter(ThreadIntent.lead_id.in_(lead_ids))
                .order_by(desc(ThreadIntent.created_at))
                .all()
            ):
                if ti.lead_id not in latest_thread_by_lead:
                    latest_thread_by_lead[ti.lead_id] = ti

        # Leads that are already sold but never moved stage in GHL. On the
        # first live run five of the top twenty had paid a deposit — their
        # last text was "Paid the 250", which read as hot and unanswered.
        # 18 of 616 open leads had a paid deposit and 4 a scheduled job. The
        # system already knows; the list just has to look.
        scheduled_by_lead: dict[str, str] = {}
        if lead_ids:
            for j_lead_id, j_date in (
                db.query(ScheduledJob.lead_id, ScheduledJob.job_date)
                .filter(ScheduledJob.lead_id.in_(lead_ids))
                .filter(ScheduledJob.status != "cancelled")
                .order_by(ScheduledJob.job_date.asc())
                .all()
            ):
                scheduled_by_lead.setdefault(j_lead_id, j_date or "")

        today_ct = clock.today_ct_iso()

        items = []
        for lead in leads:
            if lead.id in recently_touched_lead_ids:
                continue
            sig_price = _latest_signature_price(db, lead.id)
            stage_label = STAGE_NAME_BY_ID.get(lead.ghl_pipeline_stage_id or "", "")
            # "Came in" date — prefer ghl_created_at (when GHL first saw
            # the lead, the source of truth for "when the customer arrived")
            # and fall back to our created_at for any lead that predates
            # the ghl_created_at field being populated.
            came_in_at = lead.ghl_created_at or lead.created_at or ""

            disp = latest_disp_by_lead.get(lead.id)
            est = latest_est_by_lead.get(lead.id)
            flag = compute_follow_up_flag(
                proposal_last_viewed_at=lead.proposal_last_viewed_at or lead.proposal_viewed_at,
                proposal_view_count=lead.proposal_view_count or 0,
                latest_disposition_outcome=disp.outcome if disp else None,
                latest_disposition_disposed_at=disp.disposed_at if disp else None,
                latest_disposition_callback_at=disp.callback_at if disp else None,
                latest_estimate_sent_at=est.sent_at if est else None,
            )

            # T3.E — Proximity match. ZIP-only for ranking; distance is
            # informational only (computed when both sides have coords).
            nearby_match = None
            lead_zip = (lead.zip_code or "").strip()
            if lead_zip and lead_zip in upcoming_by_zip:
                soonest = upcoming_by_zip[lead_zip][0]
                # Best-effort distance: both sides need coords. Falls back
                # to None when missing — UI renders without the (4.2 mi) bit.
                dist = None
                if lead.lat and lead.lng and soonest.lat and soonest.lng:
                    dist = round(haversine(
                        float(lead.lat), float(lead.lng),
                        float(soonest.lat), float(soonest.lng),
                    ), 1)
                nearby_match = {
                    "match_kind": "same_zip",
                    "job_id": soonest.id,
                    "customer_name": soonest.customer_name or "",
                    "job_date": soonest.job_date or "",
                    "distance_miles": dist,
                    "zip_code": lead_zip,
                }

            # Distance from the rep's input ZIP when near_zip is active.
            # Uses lead lat/lng when available; falls back to lead's own
            # ZIP centroid so a not-yet-geocoded lead still gets a rough
            # rank. None when neither path resolves — those leads sink to
            # the bottom of the near-zip-sorted list.
            distance_from_near = None
            if near_target:
                lead_coords: tuple[float, float] | None = None
                if lead.lat and lead.lng:
                    lead_coords = (float(lead.lat), float(lead.lng))
                elif lead_zip:
                    lead_coords = _zip_centroid(lead_zip)
                if lead_coords:
                    d = haversine(
                        near_target[0], near_target[1],
                        lead_coords[0], lead_coords[1],
                    )
                    if d != float("inf"):
                        distance_from_near = round(d, 1)

            # What the customer said — on their last call and over text — and
            # how much it should lift them. Boosts are on the same scale as
            # the follow-up flag (hot 1000 / callback_due 800 / warm 400) and
            # are ADDED to it rather than replacing it: the flag watches
            # proposal views and dispositions, this is the customer's own
            # words.
            ci = latest_intent_by_lead.get(lead.id)
            ti = latest_thread_by_lead.get(lead.id)
            ci_at = _call_time(ci) if ci else ""
            ti_at = (ti.through_message_at or ti.created_at or "") if ti else ""
            intent_block = None
            text_block = None
            intent_boost = 0
            temp_rank = 0
            if ci:
                stale = _superseded(ci_at, ci.temperature or "unknown", ti, ti_at)
                callback_due = bool(ci.callback_at) and ci.callback_at <= today_ct and not stale
                # They asked to be called by now. Nothing on this list is a
                # stronger reason to dial, so this competes with the
                # follow-up flag for the top of the list — while the ask is
                # fresh, and while nothing said since overrides it. See
                # _callback_boost for how it fades.
                if not stale:
                    intent_boost += _callback_boost(ci.callback_at or "", today_ct)
                # Temperature is softer evidence — an impression of the
                # customer, not a request from them. It ranks WITHIN a
                # priority bucket rather than above one: a merely "warm"
                # read on a $400 job should not outrank a $9,000 job we
                # know nothing about yet.
                temp_rank = max(temp_rank, _TEMP_RANK.get(ci.temperature or "unknown", 1))
                intent_block = {
                    "temperature": ci.temperature or "unknown",
                    "blocker": ci.blocker or "unknown",
                    "blocker_detail": ci.blocker_detail or "",
                    "one_line": ci.one_line or "",
                    "brief": "" if (ci.brief or "-") == "-" else ci.brief,
                    "commitment": ci.commitment or "",
                    "callback_at": ci.callback_at or "",
                    "callback_phrase": ci.callback_phrase or "",
                    "callback_due": callback_due,
                    "call_at": ci.call_at or "",
                    # Voicemails and dropped rings after this conversation.
                    "attempts_since": attempts_since.get(lead.id, 0),
                    "read_at": ci.created_at or "",
                }
            if ti:
                stale = _superseded(ti_at, ti.temperature or "unknown", ci, ci_at)
                text_due = bool(ti.callback_at) and ti.callback_at <= today_ct and not stale
                if not stale:
                    intent_boost += _callback_boost(ti.callback_at or "", today_ct)
                # Their text is the last one in the thread and nobody has
                # answered it. Fresh, that is the most actionable row on the
                # whole list. Stale, it is a conversation that died, and it
                # gets a nudge rather than the top — a three-month-old
                # "thanks" must not sit above a customer who asked for a
                # call today.
                #
                # ...and only when the reader saw interest. On the first
                # live run, three customers who had declined sat in the top
                # ten because "thanks anyway" is also an unanswered text. A
                # cold read gets nothing, and so does an unknown one: if the
                # reader couldn't tell whether they want the job, the silence
                # isn't evidence that they do. The badge still shows.
                unanswered_boost = 0
                if ti.awaiting_reply and ti.last_inbound_at \
                        and (ti.temperature or "") in ("hot", "warm"):
                    age = _days_since(ti.last_inbound_at, today_ct)
                    unanswered_boost = 900 if age <= 7 else (400 if age <= 30 else 0)
                intent_boost += unanswered_boost
                temp_rank = max(temp_rank, _TEMP_RANK.get(ti.temperature or "unknown", 1))
                text_block = {
                    "temperature": ti.temperature or "unknown",
                    "blocker": ti.blocker or "unknown",
                    "blocker_detail": ti.blocker_detail or "",
                    "one_line": ti.one_line or "",
                    "brief": "" if (ti.brief or "-") == "-" else ti.brief,
                    "commitment": ti.commitment or "",
                    "callback_at": ti.callback_at or "",
                    "callback_phrase": ti.callback_phrase or "",
                    "callback_due": text_due,
                    "awaiting_reply": bool(ti.awaiting_reply),
                    "last_inbound_at": ti.last_inbound_at or "",
                    "last_outbound_at": ti.last_outbound_at or "",
                    "message_count": int(ti.message_count or 0),
                    "read_at": ti.created_at or "",
                }

            # One headline per row. The more recent conversation wins; the
            # other fills in whatever the newer one left blank, so a customer
            # who explained everything on the phone and then texted "ok"
            # still shows what they wanted.
            follow_up = None
            if intent_block or text_block:
                text_is_newer = bool(text_block) and (not intent_block or ti_at >= ci_at)
                newer, older = (
                    (text_block, intent_block) if text_is_newer
                    else (intent_block, text_block)
                )
                older = older or {}

                def _pick(key: str, blank=("", "unknown")):
                    v = newer.get(key)
                    return v if v not in blank else (older.get(key) or v or "")

                follow_up = {
                    "source": "text" if text_is_newer else "call",
                    "about": _pick("one_line"),
                    "brief": _pick("brief"),
                    "blocker": _pick("blocker") or "unknown",
                    "blocker_detail": _pick("blocker_detail"),
                    "commitment": _pick("commitment"),
                    "temperature": _warmest(
                        (intent_block or {}).get("temperature", ""),
                        (text_block or {}).get("temperature", ""),
                    ),
                    "callback_due": bool(
                        (intent_block or {}).get("callback_due")
                        or (text_block or {}).get("callback_due")
                    ),
                    "awaiting_reply": bool((text_block or {}).get("awaiting_reply")),
                    "last_contact_at": max(ci_at, ti_at),
                }

            # Already sold? Then nothing above applies — this is a customer
            # to look after, not one to close. Kept on the list, at the
            # bottom, labelled, so someone moves the stage in GHL.
            deal_state = "open"
            booked_note = ""
            if (lead.deposit_status or "") in ("paid", "waived"):
                deal_state = "booked"
                paid_day = clock.ct_date_of(lead.deposit_paid_at) if lead.deposit_paid_at else ""
                booked_note = (
                    f"Deposit paid {paid_day}" if paid_day
                    else ("Deposit waived" if lead.deposit_status == "waived" else "Deposit paid")
                )
            if lead.id in scheduled_by_lead:
                deal_state = "booked"
                job_day = scheduled_by_lead[lead.id]
                booked_note = f"Job scheduled {job_day}" if job_day else "Job scheduled"
            if deal_state == "booked":
                intent_boost = 0
                if follow_up:
                    follow_up["deal_state"] = deal_state
            elif follow_up:
                follow_up["deal_state"] = "open"

            items.append({
                "deal_state": deal_state,
                "booked_note": booked_note,
                "call_intent": intent_block,
                "text_intent": text_block,
                "follow_up": follow_up,
                "intent_boost": intent_boost,
                "_temp_rank": temp_rank,
                "lead_id": lead.id,
                "contact_name": lead.contact_name or "",
                "contact_phone": lead.contact_phone or "",
                "address": lead.address or "",
                "zip_code": lead_zip,
                "signature_price": sig_price,
                "stage_id": lead.ghl_pipeline_stage_id or "",
                "stage_label": stage_label,
                "is_priority": sig_price >= PRIORITY_VALUE_THRESHOLD,
                "ghl_opportunity_id": lead.ghl_opportunity_id or "",
                "came_in_at": came_in_at,
                "follow_up_flag": flag,
                "nearby_match": nearby_match,
                "distance_from_near_zip_miles": distance_from_near,
            })

        # Sort order:
        #   When near_zip is active: distance ascending. The rep is route-
        #   planning; they want the closest house first. Priority + flag +
        #   value badges stay visible in the row so the high-leverage leads
        #   are still obvious, but the order serves the geographic intent.
        #
        #   Default (no near_zip):
        #     1. follow-up flag boost + due-callback boost. The flag reads
        #        proposal views and dispositions; the callback boost is the
        #        customer asking, in their own words, to be rung by now.
        #        Nothing on this list beats "call me Thursday", on Thursday.
        #     ...then, within a bucket, how warm the customer sounded, which
        #        is an impression rather than a request and so ranks below
        #        deal size's priority tier rather than above it.
        #     2. proximity boost — same-ZIP-match-with-upcoming-job adds 200
        #     3. $1500+ priority bucket
        #     4. signature price desc
        #     5. name asc
        #   Either way, a lead that is already sold sinks below every open
        #   one — it is not a call to make, it is a stage to fix in GHL.
        if near_target:
            items.sort(
                key=lambda x: (
                    1 if x.get("deal_state") == "booked" else 0,
                    # Leads with no computable distance sink to the bottom
                    x["distance_from_near_zip_miles"]
                    if x["distance_from_near_zip_miles"] is not None
                    else float("inf"),
                    -x["signature_price"],
                    x["contact_name"].lower(),
                )
            )
        else:
            items.sort(
                key=lambda x: (
                    1 if x.get("deal_state") == "booked" else 0,
                    -(((x.get("follow_up_flag") or {}).get("priority_boost") or 0)
                      + (x.get("intent_boost") or 0)),
                    -(200 if x.get("nearby_match") else 0),
                    0 if x["is_priority"] else 1,
                    -(x.get("_temp_rank") or 0),
                    -x["signature_price"],
                    x["contact_name"].lower(),
                )
            )

        # Internal ranking key — not part of the response contract.
        for it in items:
            it.pop("_temp_rank", None)

        return {
            "items": items,
            "priority_threshold": PRIORITY_VALUE_THRESHOLD,
            "suppression_hours": SUPPRESSION_HOURS,
            "near_zip": near_zip_clean if near_target else "",
            "near_zip_resolved": bool(near_target),
        }
    finally:
        db.close()


@router.post("/call-list/{lead_id}/touch")
def mark_called(lead_id: str, user: dict = Depends(require_staff)):
    """Record a 'called' touch for this lead. Removes it from the call
    list query for the next 24h via suppression-window filtering."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")
        touch = CallTouch(
            id=str(uuid.uuid4()),
            lead_id=lead_id,
            marked_at=_now_utc().isoformat(),
            marked_by=user.get("name", "") or user.get("sub", ""),
        )
        db.add(touch)
        db.commit()
        return {
            "status": "ok",
            "touch_id": touch.id,
            "marked_at": touch.marked_at,
            "marked_by": touch.marked_by,
        }
    finally:
        db.close()
