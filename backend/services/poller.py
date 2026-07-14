"""
Background GHL pipeline poller — syncs leads from the
"FENCE STAINING NEW AUTOMATION FLOW" pipeline, only from specific stages.
"""
from __future__ import annotations
import uuid
import json
import logging
from datetime import datetime, timezone, timedelta
from config import get_settings
from database import get_db, Lead, Estimate, Message
from services.ghl import get_pipelines, get_opportunities, get_contact, get_conversations, get_conversation_messages
from services.estimator import calculate_estimate, parse_priority, determine_kanban_column
from services.notifications import notify_new_lead
from services.event_bus import publish

logger = logging.getLogger(__name__)

# Pipeline name to match (case-insensitive)
TARGET_PIPELINE = "fence staining new automation flow"

# Stages to pull from (case-insensitive) → priority mapping.
# New GHL pipeline uses "HOT LEAD_SEND ESTIMATE" (underscore). The other 13 stages
# downstream (Estimate Sent, Closed, etc.) get populated by drag-and-drop on the
# kanban (which pushes back to GHL via update_opportunity_stage).
TARGET_STAGES = {
    "new lead": "MEDIUM",
    "hot lead_send estimate": "HOT",
}

# Backward-move guard. The poller only queries the two pre-send stages above,
# so every opp it syncs is reported by GHL as "New Lead" or "Hot Lead". When we
# send an estimate (with OR without the GHL tag) we move the lead to ESTIMATE
# SENT locally AND push the opp to GHL. On the no-tag path there's no GHL
# workflow to move the opp for us, so if our direct push lags/fails the opp is
# still sitting in its pre-send stage — and a naive sync would drag the lead
# right back out of the Estimate Sent column. Rule: never let a poll move a
# lead BACKWARD across the estimate-sent line. Instead re-assert our post-send
# stage to GHL (self-heal) so GHL converges. Bounded to the 24h window after
# the lead's last local change so we still defer to genuine manual GHL edits.
from dataclasses import dataclass
from services.pipeline_stages import V2_STAGE_IDS_IN_ORDER, STAGE_NAME_BY_ID
from services.pipeline_stages_b import (
    V2B_STAGE_IDS_IN_ORDER, STAGE_NAME_BY_ID_B, PIPELINE_VERSION_B,
    ESTIMATE_SENT_STAGE_ID_B,
)
_STAGE_ORDER: dict[str, int] = {sid: i for i, (sid, _) in enumerate(V2_STAGE_IDS_IN_ORDER)}
_ESTIMATE_SENT_STAGE_ID = "dc3600f2-009b-4075-95fa-786823131416"
_ESTIMATE_SENT_ORDER = _STAGE_ORDER.get(_ESTIMATE_SENT_STAGE_ID, 4)
_STAGE_ORDER_B: dict[str, int] = {sid: i for i, (sid, _) in enumerate(V2B_STAGE_IDS_IN_ORDER)}
_ESTIMATE_SENT_ORDER_B = _STAGE_ORDER_B.get(ESTIMATE_SENT_STAGE_ID_B, 6)
_SELF_HEAL_WINDOW = timedelta(hours=24)


@dataclass(frozen=True)
class _PipelineCfg:
    """Per-pipeline knobs for the poller so one code path serves both the
    fence pipeline (A) and STERLING (B). Defaults everywhere = A, so A's
    behavior is unchanged."""
    name: str                      # case-insensitive substring matched against GHL pipeline names
    version: str                   # pipeline_version stamped on created leads
    brand: str                     # on_lead_created brand key (controls sequence enrollment)
    board_label: str               # human board name for new-lead alerts
    stage_order: dict              # stage_id -> index, for the backward-move guard
    estimate_sent_order: int       # index of the "estimate sent" stage
    stage_name_by_id: dict         # id -> name, for log messages


_CFG_A = _PipelineCfg(
    name=TARGET_PIPELINE, version="v2", brand="sterling",
    board_label="Sterling Leads A", stage_order=_STAGE_ORDER,
    estimate_sent_order=_ESTIMATE_SENT_ORDER, stage_name_by_id=STAGE_NAME_BY_ID,
)
# STERLING (B) — same Cypress location, different pipeline. brand="sterling_b"
# so B leads never enroll in A's "sterling" follow-up sequences.
_CFG_B = _PipelineCfg(
    name="sterling", version=PIPELINE_VERSION_B, brand="sterling_b",
    board_label="Sterling Leads B", stage_order=_STAGE_ORDER_B,
    estimate_sent_order=_ESTIMATE_SENT_ORDER_B, stage_name_by_id=STAGE_NAME_BY_ID_B,
)


def _is_backward_across_send(current_stage_id: str, incoming_stage_id: str, cfg: "_PipelineCfg" = _CFG_A) -> bool:
    """True when GHL wants to pull a post-send lead back to a pre-send stage."""
    cur = cfg.stage_order.get(current_stage_id or "", -1)
    inc = cfg.stage_order.get(incoming_stage_id or "", -1)
    return cur >= cfg.estimate_sent_order and 0 <= inc < cfg.estimate_sent_order

# --- Smart GHL field resolver (value-based, works across locations) ---

_HEIGHT_VALUES = {"6ft", "6.5ft", "7ft", "8ft", "standard", "rot board", "not sure"}
_AGE_VALUES = {"brand new", "less than 6", "1-6 year", "6-12 year", "6-15 year", "older than 15", "not sure"}
_TIMELINE_VALUES = {"as soon as possible", "within 2 weeks", "sometime this month", "just planning ahead", "getting a quote"}
_BOOL_VALUES = {"yes", "no"}


def _classify_field(value: str) -> str | None:
    v = str(value).lower().strip()
    if any(h in v for h in _HEIGHT_VALUES):
        return "fence_height"
    if any(a in v for a in _AGE_VALUES):
        return "fence_age"
    if any(t in v for t in _TIMELINE_VALUES):
        return "service_timeline"
    return None


def _load_field_mappings() -> dict[str, str]:
    """Load saved GHL field ID → our field name mappings from DB."""
    try:
        from database import get_db, GhlFieldMapping
        db = get_db()
        try:
            mappings = db.query(GhlFieldMapping).filter(GhlFieldMapping.our_field_name.isnot(None)).all()
            return {m.ghl_field_id: m.our_field_name for m in mappings if m.our_field_name}
        finally:
            db.close()
    except Exception:
        return {}


# Cache mappings in memory, reload every 5 minutes
_field_mapping_cache: dict[str, str] = {}
_field_mapping_loaded = False


def _get_field_mappings() -> dict[str, str]:
    global _field_mapping_cache, _field_mapping_loaded
    if not _field_mapping_loaded:
        _field_mapping_cache = _load_field_mappings()
        _field_mapping_loaded = True
    return _field_mapping_cache


def invalidate_field_mapping_cache():
    global _field_mapping_loaded
    _field_mapping_loaded = False


def resolve_custom_fields(raw_fields: list | dict) -> dict:
    result: dict = {}
    saved_mappings = _get_field_mappings()

    items: list[tuple[str, str]] = []
    if isinstance(raw_fields, list):
        for cf in raw_fields:
            field_id = cf.get("id") or ""
            key = cf.get("key") or field_id
            value = cf.get("value") or ""
            if isinstance(value, list):
                value = ", ".join(str(v) for v in value)
            if key and value:
                # Check saved mapping first (by field ID)
                if field_id and field_id in saved_mappings:
                    result[saved_mappings[field_id]] = str(value)
                    continue
                items.append((key, str(value)))
    elif isinstance(raw_fields, dict):
        for key, value in raw_fields.items():
            if isinstance(value, list):
                value = ", ".join(str(v) for v in value)
            if key and value:
                if key in saved_mappings:
                    result[saved_mappings[key]] = str(value)
                    continue
                items.append((key, str(value)))

    # Fall back to value-based guessing for unmapped fields
    stained_candidates: list[str] = []
    for key, value in items:
        v_lower = value.lower().strip()
        field_name = _classify_field(value)
        if field_name:
            result[field_name] = value
            continue
        if v_lower in ("yes", "no"):
            stained_candidates.append(value)
            continue
        result[key] = value

    if stained_candidates and "previously_stained" not in result:
        result["previously_stained"] = stained_candidates[0]
    return result


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _find_pipeline_and_stages(location_id: str, cfg: "_PipelineCfg" = _CFG_A) -> tuple[str | None, dict[str, str]]:
    """Find the target pipeline ID and stage IDs for the target stages.
    Uses cached pipeline IDs from env vars when available to avoid rate-limited API calls."""
    settings = get_settings()

    # Check if we have a cached pipeline ID for this location. The cached IDs
    # in settings are the FENCE pipeline (A) only, so this fallback applies to
    # cfg A; B (and any other pipeline) always resolves by name.
    cached_pid = ""
    if cfg.name == TARGET_PIPELINE:
        if location_id == settings.ghl_location_id and settings.ghl_pipeline_id:
            cached_pid = settings.ghl_pipeline_id
        elif location_id == settings.ghl_location_id_2 and settings.ghl_pipeline_id_2:
            cached_pid = settings.ghl_pipeline_id_2

    pipelines = get_pipelines(location_id)

    # If API call failed but we have a cached pipeline ID, use it directly
    if not pipelines and cached_pid:
        logger.info(f"Poller: using cached pipeline ID {cached_pid} (API returned empty)")
        # We still need stage IDs — fetch opportunities for all stages using search
        return cached_pid, {}

    for p in pipelines:
        name = (p.get("name") or "").lower().strip()
        if cfg.name in name:
            pipeline_id = p.get("id", "")
            stages = p.get("stages", [])
            # Return ALL stages so existing leads get their stage re-synced
            # no matter where they currently sit in the pipeline. The
            # create-new-lead branch downstream still gates on TARGET_STAGES
            # so we don't accidentally pull Closed Lost into the dashboard.
            stage_map: dict[str, str] = {}
            for s in stages:
                sname = (s.get("name") or "").lower().strip()
                if sname:
                    stage_map[sname] = s.get("id", "")
            return pipeline_id, stage_map
    return None, {}


def _sync_location(location_id: str, label: str, cfg: "_PipelineCfg" = _CFG_A):
    """Sync leads from one GHL pipeline (cfg) for one GHL location."""
    import time

    if not location_id:
        return

    db = get_db()
    try:
        # Retry pipeline fetch up to 3 times with backoff (handles 429s)
        pipeline_id, stage_map = None, {}
        for attempt in range(3):
            pipeline_id, stage_map = _find_pipeline_and_stages(location_id, cfg)
            if pipeline_id:
                break
            logger.warning(f"Poller: pipeline not found for {label}/{cfg.name}, attempt {attempt + 1}/3, retrying in {5 * (attempt + 1)}s...")
            time.sleep(5 * (attempt + 1))

        if not pipeline_id:
            logger.warning(f"Poller: pipeline '{cfg.name}' not found for {label} after 3 attempts")
            return

        logger.info(f"Poller: found pipeline for {label}, stages: {list(stage_map.keys())}")

        new_count = 0
        error_count = 0

        # If no stage map (API was rate limited but we have cached pipeline ID),
        # fetch all opportunities from the pipeline without stage filter
        if not stage_map:
            stage_map = {"all": ""}

        for stage_name, stage_id in stage_map.items():
            opps = get_opportunities(location_id, pipeline_id, stage_id if stage_id else None)
            is_target_stage = any(t in stage_name for t in TARGET_STAGES)
            priority = TARGET_STAGES.get(stage_name, "MEDIUM")
            logger.info(f"Poller: {label} stage '{stage_name}' returned {len(opps)} opportunities")

            for opp in opps:
                try:
                    contact_id = opp.get("contact", {}).get("id") or opp.get("contactId") or ""
                    contact_name = opp.get("contact", {}).get("name", "") or opp.get("name", "")
                    if not contact_id:
                        logger.warning(f"Poller: skipping opp with no contact_id: {opp.get('id', '?')}")
                        continue

                    # Existing lead — keep stage AND contact info in sync with
                    # GHL (GHL is the system-of-record). Refreshes name, phone,
                    # email, address, zip + custom fields so edits the client
                    # makes in GHL show up on the dashboard within one poll
                    # cycle.
                    existing = db.query(Lead).filter(Lead.ghl_contact_id == contact_id).first()
                    # ghl_contact_id is UNIQUE, so a contact has exactly one lead
                    # row. If that row belongs to the OTHER twin (A's v2 vs B's
                    # v2b), never touch it — leave it on whichever board claimed
                    # the contact first, so the two passes can't fight over a
                    # contact that sits in both GHL pipelines. (v1/legacy handling
                    # is unchanged.)
                    if existing and existing.pipeline_version in ("v2", "v2b") and existing.pipeline_version != cfg.version:
                        continue
                    if existing:
                        changed = False
                        stage_changed = bool(stage_id and existing.ghl_pipeline_stage_id != stage_id)

                        # Never let a poll drag a lead BACKWARD across the
                        # estimate-sent line. This is the no-tag send race: we
                        # moved the lead to ESTIMATE SENT and pushed GHL, but
                        # the opp is still showing pre-send here because our
                        # push lagged/failed and (no tag) no GHL workflow moved
                        # it. Reverting would bounce it out of Estimate Sent.
                        # Re-assert our stage to GHL instead. Scoped to the 24h
                        # window after the lead's last local change so genuine
                        # manual GHL moves still win once the send race is over.
                        if stage_changed and _is_backward_across_send(existing.ghl_pipeline_stage_id, stage_id, cfg):
                            recent = False
                            try:
                                upd = datetime.fromisoformat(str(existing.updated_at).replace("Z", "+00:00"))
                                if upd.tzinfo is None:
                                    upd = upd.replace(tzinfo=timezone.utc)
                                recent = (datetime.now(timezone.utc) - upd) <= _SELF_HEAL_WINDOW
                            except Exception:
                                recent = False
                            if recent:
                                logger.warning(
                                    f"Poller: GHL shows lead {existing.id} back in pre-send stage "
                                    f"'{stage_name}' but local is post-send "
                                    f"'{cfg.stage_name_by_id.get(existing.ghl_pipeline_stage_id, existing.ghl_pipeline_stage_id)}'; "
                                    f"re-asserting to GHL instead of reverting (no-tag send race)."
                                )
                                if existing.ghl_opportunity_id:
                                    try:
                                        from services.ghl import update_opportunity_stage
                                        update_opportunity_stage(
                                            existing.ghl_opportunity_id,
                                            existing.ghl_pipeline_stage_id,
                                            existing.ghl_location_id or None,
                                        )
                                    except Exception as e:
                                        logger.warning(f"Poller self-heal stage push failed for {existing.id}: {e}")
                                stage_changed = False  # suppress the revert

                        if stage_changed:
                            existing.ghl_pipeline_stage_id = stage_id
                            changed = True
                            logger.info(f"Poller: synced stage for lead {existing.id} -> {stage_id} ({stage_name})")
                            # Stage-change hooks — fire both on every
                            # detected stage transition:
                            #   (a) on_stage_entered → starts P06 LTN (or
                            #       any future stage-triggered sequence)
                            #   (b) U02 → pauses runs if entering a
                            #       terminal stage
                            # Commit the stage change first so neither
                            # hook's transaction deadlocks with this one.
                            try:
                                db.commit()
                                from services.followup_engine import on_stage_entered
                                from services.terminal_stage_guard import on_pipeline_stage_changed
                                on_stage_entered(existing.id, stage_id)
                                on_pipeline_stage_changed(existing.id, stage_id)
                            except Exception as e:
                                logger.warning(f"Poller stage-change hooks failed for lead {existing.id}: {e}")

                        # T1.3: Skip the per-opp get_contact() call when the
                        # opportunity hasn't changed since the last successful
                        # sync. The pre-fix code re-fetched the full contact
                        # for every opp in the pipeline every 5 min — 30-50
                        # wasted GHL calls per cycle. Skip when ALL of:
                        #   - stage didn't change this cycle
                        #   - opp's updatedAt is older than our last sync
                        # If we can't determine an opp timestamp, fall back
                        # to the old behavior (fetch every time) so the
                        # tag-trigger fallback below still works.
                        contact = None
                        opp_updated_raw = opp.get("updatedAt") or opp.get("dateUpdated") or opp.get("lastStageChangeAt") or ""
                        last_sync_raw = existing.dashboard_synced_at or ""
                        should_skip_contact = False
                        if not stage_changed and opp_updated_raw and last_sync_raw:
                            try:
                                opp_dt = datetime.fromisoformat(str(opp_updated_raw).replace("Z", "+00:00"))
                                sync_dt = datetime.fromisoformat(str(last_sync_raw).replace("Z", "+00:00"))
                                if opp_dt <= sync_dt:
                                    should_skip_contact = True
                            except Exception:
                                should_skip_contact = False

                        if not should_skip_contact:
                            try:
                                contact = get_contact(contact_id, location_id)
                            except Exception:
                                contact = None
                        if contact:
                            name = contact.get("contactName") or contact.get("name") or ""
                            if not name:
                                first = contact.get("firstName") or ""
                                last = contact.get("lastName") or ""
                                name = f"{first} {last}".strip()
                            phone = contact.get("phone") or ""
                            email = contact.get("email") or ""
                            addr1 = contact.get("address1") or ""
                            city = contact.get("city") or ""
                            state = contact.get("state") or ""
                            postal = contact.get("postalCode") or ""
                            full_address = addr1
                            if city and state:
                                full_address = f"{addr1}, {city}, {state} {postal}".strip(", ")

                            if name and name != existing.contact_name:
                                existing.contact_name = name; changed = True
                            if phone and phone != existing.contact_phone:
                                existing.contact_phone = phone; changed = True
                            if email and email != existing.contact_email:
                                existing.contact_email = email; changed = True
                            if full_address and full_address != existing.address:
                                existing.address = full_address; changed = True
                            if postal and postal != existing.zip_code:
                                existing.zip_code = postal; changed = True

                            # Refresh custom fields (fence_height/age/etc.) by
                            # merging GHL-side values into form_data. We only
                            # write back if something actually changed so we
                            # don't churn updated_at.
                            try:
                                ghl_form = resolve_custom_fields(contact.get("customFields") or [])
                            except Exception:
                                ghl_form = {}
                            if ghl_form:
                                try:
                                    current_fd = json.loads(existing.form_data or "{}")
                                except Exception:
                                    current_fd = {}
                                fd_changed = False
                                for k, v in ghl_form.items():
                                    if v in (None, ""):
                                        continue
                                    if str(current_fd.get(k, "")) != str(v):
                                        current_fd[k] = v
                                        fd_changed = True
                                if fd_changed:
                                    existing.form_data = json.dumps(current_fd)
                                    changed = True

                        # Stamp dashboard_synced_at whenever we successfully
                        # touched this opp this cycle (even if no fields
                        # changed). Without this stamp, the T1.3 skip-check
                        # above can never fire — we'd re-fetch get_contact
                        # forever because last_sync_raw stayed equal to
                        # ghl_created at the original insert.
                        if contact is not None or should_skip_contact:
                            existing.dashboard_synced_at = _now()
                        if changed:
                            existing.updated_at = _now()
                            db.commit()
                            try:
                                from services.event_bus import publish
                                publish("lead_updated", {"lead_id": existing.id})
                            except Exception:
                                pass
                        elif contact is not None or should_skip_contact:
                            # Commit the sync timestamp even when no fields
                            # changed — otherwise the skip-check is permanently
                            # disabled.
                            db.commit()

                        # Tag-trigger fallback for the follow-up engine.
                        # GHL's ContactTagUpdate webhook is preferred, but if
                        # it ever drops/misfires, this catches new tags on
                        # the next 5-min tick. We only fire when no run has
                        # ever existed for this lead+sequence (any status)
                        # so the poller doesn't keep re-starting completed
                        # runs every tick because the tag is still there.
                        try:
                            ghl_tag_set = [t for t in (contact.get("tags") or []) if t] if contact else []
                            if ghl_tag_set:
                                from database import FollowUpSequence, FollowUpRun
                                from services.followup_engine import start_run

                                # Normalize tags: lowercase, collapse
                                # whitespace, underscore→space. Matches the
                                # webhook path so legacy `estimate_sent`
                                # (underscore) maps to `estimate sent` (space).
                                def _norm_tag(t: str) -> str:
                                    return " ".join(str(t or "").strip().lower().replace("_", " ").split())

                                norm_tags = [_norm_tag(t) for t in ghl_tag_set]
                                seqs = (
                                    db.query(FollowUpSequence)
                                    .filter(FollowUpSequence.active.is_(True))
                                    .all()
                                )
                                for seq in seqs:
                                    te = (seq.trigger_event or "").strip().lower()
                                    if not te.startswith("tag_added:"):
                                        continue
                                    seq_tag = _norm_tag(te[len("tag_added:"):])
                                    if seq_tag not in norm_tags:
                                        continue
                                    any_run = (
                                        db.query(FollowUpRun)
                                        .filter(
                                            FollowUpRun.lead_id == existing.id,
                                            FollowUpRun.sequence_id == seq.id,
                                            FollowUpRun.test_mode.is_(False),
                                        )
                                        .first()
                                    )
                                    if any_run:
                                        continue
                                    start_run(existing.id, seq.id, actor=f"trigger:tag_added:{seq_tag}:poller")
                                    logger.info(
                                        f"Poller: auto-started sequence '{seq.name}' for lead {existing.id} "
                                        f"(tag '{seq_tag}' seen)"
                                    )
                        except Exception as e:
                            logger.warning(f"Poller tag-trigger fallback failed (non-fatal): {e}")
                        continue

                    # New opportunity — create the lead regardless of stage
                    # to maintain a true 1:1 mirror with GHL. Notifications
                    # are gated below so backfilled historical leads from
                    # non-intake stages don't spam the team.

                    # Fetch full contact to get custom fields + details
                    contact = get_contact(contact_id, location_id)
                    if not contact:
                        continue

                    name = contact.get("contactName") or contact.get("name") or ""
                    if not name:
                        first = contact.get("firstName") or ""
                        last = contact.get("lastName") or ""
                        name = f"{first} {last}".strip()

                    phone = contact.get("phone") or ""
                    email = contact.get("email") or ""
                    address = contact.get("address1") or ""
                    city = contact.get("city") or ""
                    state = contact.get("state") or ""
                    postal = contact.get("postalCode") or ""

                    full_address = address
                    if city and state:
                        full_address = f"{address}, {city}, {state} {postal}".strip(", ")

                    if not postal and full_address:
                        from services.geocoder import extract_zip
                        postal = extract_zip(full_address)

                    # Resolve custom fields
                    custom_fields = contact.get("customFields") or []
                    form_data = resolve_custom_fields(custom_fields)

                    # Check for estimate_sent tag
                    ghl_tags = [t.lower().strip() for t in (contact.get("tags") or [])]
                    already_sent = "estimate_sent" in ghl_tags or "estimate sent" in ghl_tags

                    # Use GHL creation date
                    date_added = contact.get("dateAdded") or contact.get("createdAt") or ""
                    if isinstance(date_added, (int, float)):
                        ghl_created = datetime.fromtimestamp(date_added / 1000, tz=timezone.utc).isoformat()
                    elif date_added:
                        ghl_created = str(date_added).replace("Z", "+00:00")
                    else:
                        ghl_created = _now()

                    lead_id = str(uuid.uuid4())
                    now = _now()

                    low, high, breakdown, meta = calculate_estimate("fence_staining", form_data, postal)
                    est_priority = meta.get("priority") or priority
                    approval_status = meta.get("approval_status", "red")
                    approval_reason = meta.get("approval_reason", "")
                    kanban_col = determine_kanban_column(
                        {**form_data, "address": full_address}, approval_status, postal, approval_reason
                    )

                    lead = Lead(
                        id=lead_id,
                        ghl_contact_id=contact_id,
                        ghl_location_id=location_id,
                        location_label=label,
                        contact_name=name,
                        contact_phone=phone,
                        contact_email=email,
                        address=full_address,
                        zip_code=postal,
                        service_type="fence_staining",
                        status="archived" if already_sent else ("estimated" if low > 0 else "new"),
                        kanban_column="archived" if already_sent else kanban_col,
                        priority=est_priority,
                        pipeline_version=cfg.version,
                        form_data=json.dumps(form_data),
                        ghl_opportunity_id=opp.get("id", ""),
                        ghl_pipeline_stage_id=stage_id or "",
                        ghl_created_at=ghl_created,
                        dashboard_synced_at=now,
                        created_at=ghl_created,
                        updated_at=now,
                    )
                    db.add(lead)

                    estimate = Estimate(
                        id=str(uuid.uuid4()),
                        lead_id=lead_id,
                        service_type="fence_staining",
                        status="pending",
                        inputs=json.dumps({**form_data, **{f"_{k}": v for k, v in meta.items()}}),
                        breakdown=json.dumps(breakdown),
                        estimate_low=low,
                        estimate_high=high,
                        tiers=json.dumps(meta.get("tiers", {})),
                        approval_status=approval_status,
                        approval_reason=approval_reason,
                        created_at=now,
                    )
                    db.add(estimate)
                    db.commit()
                    new_count += 1

                    if is_target_stage and not already_sent:
                        logger.info(f"Poller: new lead {lead_id} from {label}/{cfg.name}/{stage_name}: {name}")
                        notify_new_lead(lead.to_dict(), board_label=cfg.board_label)
                        # Start any sequence triggered by lead_created, keyed on
                        # the pipeline's brand (A="sterling"; B="sterling_b",
                        # which has no seeded sequences → no enrollment).
                        try:
                            from services.followup_engine import on_lead_created
                            on_lead_created(lead_id, brand=cfg.brand)
                        except Exception as e:
                            logger.warning(f"Poller on_lead_created hook failed for {lead_id}: {e}")
                    else:
                        logger.info(f"Poller: backfilled lead {lead_id} from {label}/{stage_name}: {name} (no notify — non-intake stage)")

                except Exception as e:
                    db.rollback()
                    error_count += 1
                    logger.error(f"Poller: failed to process opp {opp.get('id', '?')}: {e}")

        logger.info(f"Poller: {label} done — {new_count} new, {error_count} errors")

    except Exception as e:
        logger.error(f"Poller sync error for {label}: {e}")
    finally:
        db.close()


def poll_ghl_contacts():
    """Sync leads from both GHL locations with delay between to avoid rate limits."""
    import time
    settings = get_settings()
    _sync_location(settings.ghl_location_id, settings.ghl_location_1_label, _CFG_A)
    # Sterling Leads B — the STERLING pipeline, same Cypress location as A.
    # Sequential pass (paced by the shared GHL rate-limit bucket).
    time.sleep(2)
    _sync_location(settings.ghl_location_id, settings.ghl_location_1_label, _CFG_B)
    # Woodlands disabled — no longer pulling leads from this location
    # time.sleep(10)
    # _sync_location(settings.ghl_location_id_2, settings.ghl_location_2_label)


def poll_ghl_messages():
    """Sync recent inbound messages from GHL for active leads.
    Rate-limited: processes 10 leads per cycle with delays between API calls.
    """
    import time

    db = get_db()
    try:
        leads = (
            db.query(Lead)
            .filter(Lead.ghl_contact_id.isnot(None), Lead.ghl_contact_id != "")
            .filter(Lead.status.in_(["new", "estimated", "sent"]))
            .order_by(Lead.updated_at.desc())
            .limit(10)
            .all()
        )

        new_count = 0
        for lead in leads:
            try:
                time.sleep(2)  # Pace API calls to avoid 429s
                convos = get_conversations(lead.ghl_contact_id, lead.ghl_location_id or None)
                for convo in convos:
                    convo_id = convo.get("id", "")
                    if not convo_id:
                        continue

                    time.sleep(1)
                    msgs = get_conversation_messages(convo_id, lead.ghl_location_id or None)
                    for m in msgs:
                        ghl_id = m.get("id", "")
                        if not ghl_id:
                            continue

                        existing = db.query(Message).filter(Message.ghl_message_id == ghl_id).first()
                        if existing:
                            continue

                        direction = "inbound" if m.get("direction") == "inbound" else "outbound"
                        body = m.get("body") or m.get("message") or ""

                        db.add(Message(
                            id=str(uuid.uuid4()),
                            ghl_contact_id=lead.ghl_contact_id,
                            lead_id=lead.id,
                            direction=direction,
                            body=body,
                            message_type=m.get("messageType", "SMS"),
                            ghl_message_id=ghl_id,
                            created_at=m.get("dateAdded") or _now(),
                        ))
                        new_count += 1

                        if direction == "inbound":
                            lead.customer_responded = True
                            lead.customer_response_text = body
                            lead.updated_at = _now()
                            publish("customer_reply", {
                                "lead_id": lead.id,
                                "contact_name": lead.contact_name,
                                "body": body[:200],
                            })

                db.commit()

            except Exception as e:
                db.rollback()
                logger.error(f"Message sync failed for lead {lead.id}: {e}")

        if new_count > 0:
            logger.info(f"Message poller: synced {new_count} new messages")

    except Exception as e:
        logger.error(f"Message poller error: {e}")
    finally:
        db.close()
