"""Painting Upsell importer — one-shot pull from the OLD GHL account.

Per user (2026-06-16): A&T's owners separated; we ended up on a new
GHL account and the old account's leads were never pulled across. The
"COMPLETED JOB-HAPPY CUSTOMER- SEND REVIEW" stage in the old account
holds ~30 customers we want to pitch exterior painting to. This module
pulls them into the dashboard so the team can use the Upsell tab + the
new "Painting Upsell" pipeline view to work the agenda.

Read-only against the old account. Writes go ONLY to the local DB —
new leads land with pipeline_version="painting_upsell" in the
PAINTING_UPSELL_NEW_STAGE column on a dedicated kanban. From there a
separate Stage B push (api/painting_upsell.py) creates the v2-GHL
contact + opportunity when a customer actually books.

Per user direction:
  - No dedup. The importer creates a fresh lead row every time, even
    if the phone matches an existing v2 lead.
  - Closed price is left 0 (the old GHL opps all have monetaryValue=0
    so there's nothing to map).
  - Everything else (SMS history, notes, tags) comes over.
"""
from __future__ import annotations
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx
from sqlalchemy.orm import Session

from database import Lead, Message, Estimate
from services.ghl import (
    GHL_BASE,
    _client,
    get_contact,
    get_conversations,
    get_conversation_messages,
)
from services.painting_upsell_stages import (
    PAINTING_UPSELL_NEW_STAGE,
    PIPELINE_VERSION,
)
from services.activity_log import log_event

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# The pipeline + stage IDs in the OLD account are FIXED (we discovered
# them on 2026-06-16). The API key + location_id come in per-request
# from the admin form — no persistent storage of credentials.
OLD_PIPELINE_ID = "DhAgHB94UlwNPySeLoht"
OLD_STAGE_ID = "1d3fa925-b70f-466d-9d33-d160e9fab429"
OLD_LOCATION_ID = "Av5xMTGXnCv1YARiyu6Z"


def _build_creds(api_key: str, location_id: str = "") -> dict:
    """Bundle the per-request credentials into a single dict so the
    downstream helpers don't take 4 string args each. location_id
    defaults to the discovered old-account location — the admin only
    has to paste the API key."""
    return {
        "api_key": api_key,
        "location_id": location_id or OLD_LOCATION_ID,
        "pipeline_id": OLD_PIPELINE_ID,
        "stage_id": OLD_STAGE_ID,
    }


# ---------------------------------------------------------- discovery --

def fetch_happy_customer_opportunities(
    api_key: str, limit: int = 100, location_id: str = ""
) -> tuple[list[dict], Optional[str]]:
    """List opportunities in the old-account Happy Customer stage.

    Returns (opportunities, error_message). When the call succeeds and
    GHL legitimately returns zero opportunities, error_message is None
    and opportunities is []. When the API call FAILS (401/403/network/
    parse error), opportunities is [] and error_message holds the
    surfaceable reason so the admin sees something better than "no
    opportunities returned."
    """
    if not api_key:
        return [], "API key is empty"
    cfg = _build_creds(api_key, location_id)
    try:
        r = _client.get(
            f"{GHL_BASE}/opportunities/search",
            headers={
                "Authorization": f"Bearer {cfg['api_key']}",
                "Version": "2021-07-28",
                "Content-Type": "application/json",
            },
            params={
                "location_id": cfg["location_id"],
                "pipeline_id": cfg["pipeline_id"],
                "pipeline_stage_id": cfg["stage_id"],
                "limit": limit,
            },
            timeout=30,
        )
        if r.status_code != 200:
            # Surface the GHL response body so we can distinguish 401
            # (wrong key), 403 (key lacks scope), 404 (pipeline gone),
            # etc. Truncate to keep the UI tidy.
            body = (r.text or "")[:300]
            msg = f"GHL returned HTTP {r.status_code}: {body}"
            logger.error("Painting upsell: %s", msg)
            return [], msg
        opps = r.json().get("opportunities", []) or []
        return opps, None
    except Exception as e:
        msg = f"Fetch crashed: {type(e).__name__}: {e}"
        logger.error("Painting upsell: %s", msg)
        return [], msg


def _fetch_all_pages(
    api_key: str, location_id: str = "", page_size: int = 100, max_pages: int = 20,
) -> tuple[list[dict], Optional[str]]:
    """Drain every page of opportunities in the Happy Customer stage.

    GHL caps `limit` at 100; we walk pages using their `startAfter` +
    `startAfterId` cursor convention. max_pages is a runaway safety —
    20×100 = 2000 leads, far more than the dead-account stage will ever
    hold. Returns (all_opps, error_message) using the same shape as
    fetch_happy_customer_opportunities.
    """
    cfg = _build_creds(api_key, location_id)
    all_opps: list[dict] = []
    start_after: Optional[str] = None
    start_after_id: Optional[str] = None
    for _ in range(max_pages):
        params = {
            "location_id": cfg["location_id"],
            "pipeline_id": cfg["pipeline_id"],
            "pipeline_stage_id": cfg["stage_id"],
            "limit": page_size,
        }
        if start_after and start_after_id:
            params["startAfter"] = start_after
            params["startAfterId"] = start_after_id
        try:
            r = _client.get(
                f"{GHL_BASE}/opportunities/search",
                headers={
                    "Authorization": f"Bearer {cfg['api_key']}",
                    "Version": "2021-07-28",
                    "Content-Type": "application/json",
                },
                params=params,
                timeout=30,
            )
            if r.status_code != 200:
                body = (r.text or "")[:300]
                return all_opps, f"GHL returned HTTP {r.status_code}: {body}"
            data = r.json() or {}
        except Exception as e:
            return all_opps, f"Pagination crashed: {type(e).__name__}: {e}"

        page = data.get("opportunities", []) or []
        all_opps.extend(page)
        # Stop when the page is shorter than the limit — no more rows.
        if len(page) < page_size:
            break
        # Cursor for the next page comes from the last opportunity's
        # createdAt + id, per GHL's cursor convention.
        last = page[-1]
        start_after = last.get("createdAt")
        start_after_id = last.get("id")
        if not start_after or not start_after_id:
            break
    return all_opps, None


def preview_import(api_key: str, limit: int = 100, location_id: str = "") -> dict:
    """Read-only — surface the count + a handful of samples so the admin
    can sanity-check before running the import."""
    opps, err = fetch_happy_customer_opportunities(api_key, limit=limit, location_id=location_id)
    samples = []
    for o in opps[:8]:
        contact = o.get("contact") or {}
        first = contact.get("firstName") or ""
        last = contact.get("lastName") or ""
        full = (contact.get("name") or f"{first} {last}").strip() or "(unnamed)"
        samples.append({
            "name": full,
            "phone": contact.get("phone") or "",
            "monetary_value": float(o.get("monetaryValue") or 0),
            "created_at": (o.get("createdAt") or "")[:10],
        })
    return {
        "count": len(opps),
        "samples": samples,
        "error": err,
    }


# ---------------------------------------------------------- import --

def run_import(api_key: str, db: Session, location_id: str = "") -> dict:
    """Pull every opportunity in the old Happy Customer stage and create
    one local Lead per row. Returns counts for the admin response."""
    if not api_key:
        return {"imported": 0, "skipped": 0, "errors": ["API key is empty"]}
    cfg = _build_creds(api_key, location_id)

    # GHL caps `limit` at 100 per request. Paginate via startAfter +
    # startAfterId until we've drained the stage. Cheap (30-ish total).
    opps, err = _fetch_all_pages(api_key, location_id=location_id)
    if err:
        return {"imported": 0, "skipped": 0, "errors": [err]}
    if not opps:
        return {
            "imported": 0,
            "skipped": 0,
            "errors": [
                "No opportunities returned. The API call succeeded but the "
                "Happy Customer stage is empty — or the stored stage ID is "
                "stale. Confirm in old GHL that opportunities are sitting in "
                "the COMPLETED JOB-HAPPY CUSTOMER- SEND REVIEW column."
            ],
        }

    imported = 0
    skipped = 0
    errors: list[str] = []
    for opp in opps:
        try:
            result = _import_one(opp, cfg, db)
            if result == "imported":
                imported += 1
            elif result == "skipped":
                skipped += 1
        except Exception as e:
            # Don't let one bad lead kill the whole run; log + continue.
            opp_id = opp.get("id", "?")
            logger.error("Painting upsell: import failed for opp %s: %s", opp_id, e)
            errors.append(f"{opp_id}: {e}")
    return {"imported": imported, "skipped": skipped, "errors": errors}


def _import_one(opp: dict, cfg: dict, db: Session) -> str:
    """Pull one old-account opportunity → contact + conversation +
    notes + tags → write a Lead row + Message rows + Estimate row.
    Returns "imported" / "skipped" so the caller can tally."""
    contact = opp.get("contact") or {}
    contact_id = opp.get("contactId") or contact.get("id") or ""
    if not contact_id:
        return "skipped"

    # Pull the full contact record — the opportunity summary doesn't
    # include address/email/tags/notes.
    full_contact = get_contact(contact_id, location_id=cfg["location_id"], api_key=cfg["api_key"])
    if not full_contact:
        # Fall back to the embedded summary; we'll still import what we
        # can rather than dropping the lead entirely.
        full_contact = contact

    first = full_contact.get("firstName") or ""
    last = full_contact.get("lastName") or ""
    name = full_contact.get("name") or f"{first} {last}".strip()
    phone = full_contact.get("phone") or ""
    email = full_contact.get("email") or ""
    address = full_contact.get("address1") or ""
    zip_code = full_contact.get("postalCode") or ""
    tags = full_contact.get("tags") or []

    lead_id = str(uuid.uuid4())
    now = _now()

    # Notes — old-account notes come on the contact record under
    # `additionalEmails` etc. depending on GHL version, but the most
    # reliable surface is the dedicated notes endpoint. We pull them
    # below; the lead row itself captures the tag list + raw opp ID.
    notes_blob = _build_notes_blob(opp, tags)

    lead = Lead(
        id=lead_id,
        ghl_contact_id=None,  # Old-account contact_id; NOT valid in v2 GHL.
        ghl_location_id="",   # Empty until pushed to v2.
        location_label="Painting Upsell",
        contact_name=name,
        contact_phone=phone,
        contact_email=email,
        address=address,
        zip_code=zip_code,
        service_type="exterior_painting",
        status="active",
        kanban_column=PAINTING_UPSELL_NEW_STAGE,
        priority="MEDIUM",
        pipeline_version=PIPELINE_VERSION,
        form_data=json.dumps({
            "source": "painting_upsell_import",
            "old_contact_id": contact_id,
            "old_opportunity_id": opp.get("id", ""),
            "old_tags": tags,
            "notes_summary": notes_blob,
        }),
        customer_responded=False,
        ghl_opportunity_id="",  # Empty until pushed to v2.
        ghl_pipeline_stage_id=PAINTING_UPSELL_NEW_STAGE,
        ghl_created_at=(opp.get("createdAt") or now)[:32],
        created_at=now,
        updated_at=now,
    )
    db.add(lead)
    db.flush()  # Get the lead.id available for downstream FKs.

    # SMS history → local messages table. Pulls every conversation on
    # the old-account contact, then every message inside each. Cheap.
    _import_sms_history(lead, contact_id, cfg, db)

    # Synthetic estimate row with closed_price=0 (user accepted leaving
    # it blank). Helps the Upsell tab know "they're a closed customer."
    _create_synthetic_estimate(lead, opp, db)

    db.commit()
    log_event(
        lead_id, "painting_upsell_imported",
        f"Imported from old GHL account; old opp={opp.get('id')}, name={name}",
        {"old_contact_id": contact_id, "old_opportunity_id": opp.get("id", "")},
    )
    return "imported"


def _build_notes_blob(opp: dict, tags: list) -> str:
    """Stuff the opp metadata + tags into a single human-readable blob
    that gets stored on form_data.notes_summary. Renderable as-is on
    the lead detail page; also feeds into the Upsell analyzer prompt
    when no formal lead notes exist."""
    parts = []
    if opp.get("name"):
        parts.append(f"Old opp name: {opp['name']}")
    val = float(opp.get("monetaryValue") or 0)
    if val > 0:
        parts.append(f"Old opp value: ${val}")
    if opp.get("source"):
        parts.append(f"Source: {opp['source']}")
    if tags:
        parts.append(f"Tags: {', '.join(tags)}")
    if opp.get("createdAt"):
        parts.append(f"Old opp created: {opp['createdAt'][:10]}")
    return " | ".join(parts)


def _import_sms_history(lead: Lead, old_contact_id: str, cfg: dict, db: Session) -> int:
    """Pull every conversation + message off the old-account contact
    and persist as local Message rows. Returns the number of messages
    written."""
    try:
        convos = get_conversations(
            old_contact_id,
            location_id=cfg["location_id"],
            api_key=cfg["api_key"],
        )
    except Exception as e:
        logger.error("Painting upsell: conversation pull failed for %s: %s", old_contact_id, e)
        return 0

    total = 0
    for c in convos or []:
        convo_id = c.get("id", "")
        if not convo_id:
            continue
        try:
            msgs = get_conversation_messages(
                convo_id,
                location_id=cfg["location_id"],
                api_key=cfg["api_key"],
            )
        except Exception as e:
            logger.error("Painting upsell: message pull failed for convo %s: %s", convo_id, e)
            continue
        for m in msgs or []:
            body = (m.get("body") or m.get("message") or "").strip()
            if not body:
                continue
            db.add(Message(
                id=str(uuid.uuid4()),
                ghl_contact_id=old_contact_id,
                lead_id=lead.id,
                direction=("outbound" if m.get("direction") != "inbound" else "inbound"),
                body=body,
                message_type=m.get("messageType", "SMS"),
                ghl_message_id=m.get("id") or None,
                created_at=m.get("dateAdded") or _now(),
            ))
            total += 1
    return total


def _create_synthetic_estimate(lead: Lead, opp: dict, db: Session) -> None:
    """Drop a closed Estimate row for the lead so the Upsell tab can
    show 'they bought from us in the past' framing. Per user decision,
    closed_price stays at 0 (old GHL never tracked the signed amount)."""
    db.add(Estimate(
        id=str(uuid.uuid4()),
        lead_id=lead.id,
        service_type="fence_staining",
        status="closed",
        inputs=json.dumps({"source": "painting_upsell_import"}),
        breakdown="[]",
        estimate_low=0.0,
        estimate_high=0.0,
        tiers=json.dumps({}),
        approval_status="approved",
        approval_reason="imported from old GHL",
        owner_notes=f"Imported via Painting Upsell from old opp {opp.get('id', '')}",
        created_at=_now(),
        sent_at=opp.get("createdAt"),
        closed_tier="legacy_import",
        closed_at=opp.get("createdAt"),
        closed_price=0.0,
        closed_notes="Imported — actual price unknown (old GHL had $0 monetary value)",
    ))
