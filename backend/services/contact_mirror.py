"""
Mirror the GHL contact list into `contacts`.

Why this exists
---------------
Lead intake walks *opportunity cards* (services/poller.py), so a GHL contact
with no card in one of the two polled pipelines never became a row anywhere.
On 2026-09-29 that was 469 of 1,972 contacts — 24% of the customer base
invisible to every list, audit and queue in the dashboard.

So `leads` is a subset, and "who has no estimate?" could not be answered from
it. This module makes the complete set available: one row per GHL contact, in
GHL's own order, with a link to the pipeline row when there is one.

Rules
-----
GHL is the system of record. Every sweep overwrites the mirror from GHL,
**including the name** — if a name was fixed in GHL, the linked lead is
renamed to match.

One row per person. A contact is matched to an existing lead by GHL contact id
first, then by phone (last 10 digits), so somebody re-created in a newer GHL
account attaches to the lead they already had instead of doubling up.
"""
from __future__ import annotations
import json
import logging
import uuid
from datetime import datetime, timezone

from config import get_settings
from database import get_db, Contact, Lead
from services.ghl import get_contacts
from services.identity import stamp_lead_keys
from services.name_match import phone_key

logger = logging.getLogger(__name__)

# Marker values for the lead rows this module creates. Every existing
# lead-facing view filters on pipeline_version in ("v2", "v2b") — the two
# Sterling boards, the Hit List (api/daily_tasks.py:159) and the call list
# (api/call_list.py:209) — so "contact" keeps these rows out of all of them
# while still letting the message and call pollers, which key off Lead, pull
# their history.
#
# STATUS_CONTACT matters just as much: the nudge loop selects on
# `status in ("new","estimated")` with no version filter
# (services/nudge.py:42), so importing 469 people as "new" would fire 469
# nudges. "contact" is invisible to it.
PIPELINE_VERSION_CONTACT = "contact"
STATUS_CONTACT = "contact"
KANBAN_CONTACT = "contact"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _full_name(c: dict) -> str:
    """GHL's own display name, falling back to the raw name parts.

    `contactName` is lowercased by GHL ("amy may"); the *Raw fields keep what
    was actually typed ("Amy May"), so prefer those and only fall back to the
    lowercased field when they are missing.
    """
    first = (c.get("firstNameRaw") or c.get("firstName") or "").strip()
    last = (c.get("lastNameRaw") or c.get("lastName") or "").strip()
    joined = " ".join(p for p in (first, last) if p).strip()
    return joined or (c.get("contactName") or c.get("name") or "").strip()


def _address(c: dict) -> str:
    return (c.get("address1") or "").strip()


def _pick_lead_by_phone(db, pk: str) -> Lead | None:
    """The lead a phone number should attach to when several share it.

    110 of 1,899 leads shared a phone with another row on the day this was
    written (re-submitted forms, the same customer across two GHL accounts).
    Newest-created wins: that is the record the pipeline has been working, and
    linking to a stale twin would point the contact list at a dead row.
    """
    if not pk:
        return None
    return (
        db.query(Lead)
        .filter(Lead.phone_key == pk)
        .order_by(Lead.created_at.desc())
        .first()
    )


def _create_shadow_lead(db, c: dict, cid: str, loc: str, label: str,
                        name: str, phone: str) -> Lead:
    """A lead row for a contact that has none, so their history can be pulled.

    The message and call pollers both iterate `Lead`, so a contact without a
    lead row can never have its texts or calls fetched. This creates the row
    they were missing.

    Deliberately inert. It is stamped with the "contact" markers above so it
    stays out of every board, the Hit List, the call list and the nudge loop,
    and this function does NOT:

      * create an Estimate (the opportunity path does; nothing here should
        put a price on a lead nobody has looked at)
      * call followup_engine.on_lead_created (that enrols sequences, which
        SEND TEXTS — importing a contact must never message them)
      * notify anyone

    Importing history must be silent. 469 people getting an automated text
    because they were backfilled would be far worse than the gap this fixes.
    """
    lead = Lead(
        id=str(uuid.uuid4()),
        ghl_contact_id=cid,
        ghl_location_id=loc,
        location_label=label,
        contact_name=name,
        contact_phone=phone,
        contact_email=(c.get("email") or "").strip(),
        address=_address(c),
        zip_code=(c.get("postalCode") or "").strip(),
        service_type="fence_staining",
        status=STATUS_CONTACT,
        kanban_column=KANBAN_CONTACT,
        priority="MEDIUM",
        pipeline_version=PIPELINE_VERSION_CONTACT,
        division="fence",
        lead_source="contact_mirror",
        form_data="{}",
        ghl_created_at=(c.get("dateAdded") or "").strip(),
        dashboard_synced_at=_now(),
        created_at=(c.get("dateAdded") or "").strip() or _now(),
        updated_at=_now(),
        # GHL's own opt-out. Mirrored onto the lead so the send endpoint's
        # do_not_contact check covers these rows from the moment they exist,
        # rather than only after someone replies "stop" to us.
        do_not_contact=bool(c.get("dnd")),
    )
    stamp_lead_keys(lead)
    db.add(lead)
    return lead


def sync_contacts(location_id: str | None = None, location_label: str = "",
                  create_leads: bool = True) -> dict:
    """Pull every GHL contact for one location into `contacts`.

    Returns counts. Safe to re-run: keyed on `ghl_contact_id`, so a second
    sweep updates in place rather than inserting again.
    """
    settings = get_settings()
    loc = location_id or settings.ghl_location_id
    if not loc:
        return {"error": "no GHL location configured", "fetched": 0}

    started = _now()
    try:
        fetched = get_contacts(loc)
    except Exception as e:
        # Deliberately not swallowed. A short read would look like contacts
        # were deleted in GHL, and the caller must be able to tell the
        # difference between "nothing changed" and "we could not read".
        logger.error(f"contact mirror: GHL read failed for {loc}: {e}")
        return {"error": f"GHL read failed: {e}", "fetched": 0}

    stats = {
        "location_id": loc,
        "fetched": len(fetched),
        "created": 0,
        "updated": 0,
        "linked_by_ghl_id": 0,
        "linked_by_phone": 0,
        "no_lead": 0,
        "leads_created": 0,
        "names_corrected": 0,
        "no_phone": 0,
        "errors": 0,
    }
    renamed: list[dict] = []

    db = get_db()
    try:
        for c in fetched:
            cid = (c.get("id") or "").strip()
            if not cid:
                stats["errors"] += 1
                continue
            try:
                phone = (c.get("phone") or "").strip()
                pk = phone_key(phone)
                name = _full_name(c)
                if not pk:
                    stats["no_phone"] += 1

                # ── Link to a pipeline row ────────────────────────────
                # GHL id is exact. Phone is the fallback that stops the
                # same person existing twice; it needs a real 10-digit
                # key, or every contact without a phone would match every
                # other one.
                lead = db.query(Lead).filter(Lead.ghl_contact_id == cid).first()
                link_method = ""
                if lead:
                    link_method = "ghl_id"
                    stats["linked_by_ghl_id"] += 1
                else:
                    lead = _pick_lead_by_phone(db, pk)
                    if lead:
                        link_method = "phone"
                        stats["linked_by_phone"] += 1
                    else:
                        stats["no_lead"] += 1
                        if create_leads:
                            lead = _create_shadow_lead(
                                db, c, cid, loc, location_label, name, phone
                            )
                            link_method = "created"
                            stats["leads_created"] += 1

                # ── GHL wins on the name ──────────────────────────────
                # Only when GHL actually has one: an empty GHL name must
                # never blank out a name somebody typed on the dashboard.
                if lead and name and (lead.contact_name or "").strip() != name:
                    renamed.append({
                        "lead_id": lead.id,
                        "from": lead.contact_name or "",
                        "to": name,
                    })
                    lead.contact_name = name
                    lead.updated_at = _now()
                    # name_key/phonetic_key are derived from the name, so the
                    # voice + duplicate matchers go stale unless re-stamped.
                    stamp_lead_keys(lead)
                    stats["names_corrected"] += 1

                row = db.query(Contact).filter(Contact.ghl_contact_id == cid).first()
                if row is None:
                    row = Contact(
                        id=str(uuid.uuid4()),
                        ghl_contact_id=cid,
                        first_synced_at=started,
                    )
                    db.add(row)
                    stats["created"] += 1
                else:
                    stats["updated"] += 1

                row.ghl_location_id = loc
                row.name = name
                row.first_name = (c.get("firstNameRaw") or c.get("firstName") or "").strip()
                row.last_name = (c.get("lastNameRaw") or c.get("lastName") or "").strip()
                row.phone = phone
                row.phone_key = pk
                row.email = (c.get("email") or "").strip()
                row.address = _address(c)
                row.city = (c.get("city") or "").strip()
                row.state = (c.get("state") or "").strip()
                row.postal_code = (c.get("postalCode") or "").strip()
                row.country = (c.get("country") or "").strip()
                row.source = (c.get("source") or "").strip()
                row.contact_type = (c.get("type") or "").strip()
                row.tags_json = json.dumps(c.get("tags") or [])
                row.dnd = bool(c.get("dnd"))
                row.date_added = (c.get("dateAdded") or "").strip()
                row.date_updated = (c.get("dateUpdated") or "").strip()
                row.lead_id = lead.id if lead else None
                row.link_method = link_method
                row.synced_at = started
                db.commit()
            except Exception as e:
                db.rollback()
                stats["errors"] += 1
                logger.error(f"contact mirror: failed on contact {cid}: {e}")

        # Rows we hold that this sweep did not see. `synced_at` doubles as the
        # freshness marker, so no extra column is needed to spot them: either
        # they were deleted in GHL or the read was short. Reported, never
        # auto-deleted — a bad read must not silently empty the mirror.
        stale = (
            db.query(Contact)
            .filter(Contact.ghl_location_id == loc)
            .filter((Contact.synced_at < started) | (Contact.synced_at.is_(None)))
            .count()
        )
        stats["not_seen_this_sweep"] = stale
        stats["renamed"] = renamed[:50]
        stats["finished_at"] = _now()
        logger.info(
            f"contact mirror {location_label or loc}: fetched {stats['fetched']}, "
            f"created {stats['created']}, updated {stats['updated']}, "
            f"no lead {stats['no_lead']}, names corrected {stats['names_corrected']}"
        )
        return stats
    finally:
        db.close()


def sync_all_locations(create_leads: bool = True) -> dict:
    """Mirror every GHL location the app is configured for.

    Location 1 only, deliberately. Location 2 is still in the settings, but
    its lead intake was switched off in April 2026 (services/poller.py:693)
    and its newest contact is dated 27 April — it is a closed account. Its
    people are already represented by the 396 legacy leads in the database,
    and pulling them into the working contact list would put hundreds of
    names nobody can serve back in front of the team.
    """
    settings = get_settings()
    out: dict = {}
    if settings.ghl_location_id:
        out["location_1"] = sync_contacts(
            settings.ghl_location_id,
            settings.ghl_location_1_label,
            create_leads=create_leads,
        )
    else:
        out["error"] = "ghl_location_id is not configured"
    return out
