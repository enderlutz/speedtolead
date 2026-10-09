"""The customer's form answers, keyed the way the dashboard reads them.

GHL hands a contact's custom fields back as {id, value} pairs — the id is a
random string like P5hpKBzBuNhdrNOSCQnY — and the field's name only comes
with the location's field definitions. For a long time the poller guessed
each answer's meaning from its VALUE ("6ft" → fence_height), which worked
for the picklists and broke the moment Alan added two free-text questions
to the ad form (2026-10-06): "Repairs?" and "sides?". Their answers were
stored under the raw id, which nothing on the lead page reads, and a
customer who typed "yes" for sides had the answer thrown away because
"yes" looked like a previously-stained answer (Kayode Fakunle, 2026-10-08).

Now every field is named first and guessed last:
  1. an explicit mapping saved in Settings → GHL Fields,
  2. the field's own key in GHL (contact.repairs → repairs), learned from
     the location's field definitions — fetched at most once an hour, only
     when an id we have never seen shows up — and remembered in
     ghl_field_mapping so Settings lists the field as well,
  3. the old guess from the value.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

# GHL field key (the part after "contact.") → the name the dashboard reads.
KEY_DEFAULTS: dict[str, str] = {
    "fence_height": "fence_height",
    "fence_age": "fence_age",
    "previously_stained": "previously_stained",
    "service_timeline": "service_timeline",
    "timeframe": "service_timeline",
    "additional_services": "additional_services",
    "additional_notes": "additional_notes",
    "linear_feet": "linear_feet",
    # The two questions on the October ads. Free text: the customer writes
    # whatever they like ("Inside facing and gate outside", "yes").
    "repairs": "repairs",
    "sides": "sides_wanted",
}

# Answers only the customer gives. The dashboard never edits these, so a
# sweep can refresh them on any lead without undoing an estimator's work.
CUSTOMER_ONLY: frozenset[str] = frozenset({"repairs", "sides_wanted"})

# --- the old value guess, kept as the last resort ---
_HEIGHT_VALUES = {"6ft", "6.5ft", "7ft", "8ft", "standard", "rot board", "not sure"}
_AGE_VALUES = {"brand new", "less than 6", "1-6 year", "6-12 year", "6-15 year", "older than 15", "not sure"}
# "this month" rather than "sometime this month": GHL's live picklist option
# is literally "This month", so the longer phrase never matched it and the
# value fell through to be stored under its raw GHL field id instead.
_TIMELINE_VALUES = {"as soon as possible", "asap", "within 2 weeks", "this month", "just planning ahead", "getting a quote", "planning ahead"}


def _classify_field(value: str) -> str | None:
    v = str(value).lower().strip()
    if any(h in v for h in _HEIGHT_VALUES):
        return "fence_height"
    if any(a in v for a in _AGE_VALUES):
        return "fence_age"
    if any(t in v for t in _TIMELINE_VALUES):
        return "service_timeline"
    return None


# --- what we know about the fields: explicit mappings and GHL keys ---
_MAPPING_TTL = 300.0        # re-read Settings' mappings this often
_LEARN_TTL = 3600.0         # ask GHL for field definitions at most this often
_cache: dict = {"our": {}, "keys": {}, "loaded_at": 0.0}
_learned_at: dict[str, float] = {}


def invalidate_field_mapping_cache() -> None:
    _cache["loaded_at"] = 0.0


def _load_mappings() -> None:
    if time.monotonic() - _cache["loaded_at"] < _MAPPING_TTL:
        return
    our: dict[str, str] = {}
    keys: dict[str, str] = {}
    try:
        from database import get_db, GhlFieldMapping
        db = get_db()
        try:
            for m in db.query(GhlFieldMapping).all():
                if m.our_field_name:
                    our[m.ghl_field_id] = m.our_field_name
                if m.ghl_field_key:
                    keys[m.ghl_field_id] = m.ghl_field_key
        finally:
            db.close()
    except Exception as e:
        logger.warning(f"form answers: could not read field mappings: {e}")
        return
    _cache.update(our=our, keys=keys, loaded_at=time.monotonic())


def _learn(location_id: str, unknown_ids: set[str]) -> None:
    """Fetch the location's field definitions for ids we have never seen,
    and remember them in ghl_field_mapping (name and key only — the
    explicit mapping stays the admin's)."""
    if not location_id or not unknown_ids:
        return
    if time.monotonic() - _learned_at.get(location_id, -_LEARN_TTL) < _LEARN_TTL:
        return
    _learned_at[location_id] = time.monotonic()
    try:
        from services.ghl import get_custom_fields
        fields = get_custom_fields(location_id)
    except Exception as e:
        logger.warning(f"form answers: field definitions for {location_id} failed: {e}")
        return
    learned: dict[str, tuple[str, str]] = {}
    for f in fields:
        fid = f.get("id") or ""
        key = f.get("fieldKey") or f.get("key") or ""
        if fid and key and key != fid:
            learned[fid] = (key, f.get("name") or "")
    if not learned:
        return
    _cache["keys"].update({fid: key for fid, (key, _) in learned.items()})
    try:
        from database import get_db, GhlFieldMapping
        db = get_db()
        try:
            have = {m.ghl_field_id for m in db.query(GhlFieldMapping.ghl_field_id).all()}
            now = datetime.now(timezone.utc).isoformat()
            for fid, (key, name) in learned.items():
                if fid in have:
                    continue
                db.add(GhlFieldMapping(ghl_field_id=fid, ghl_field_key=key, ghl_field_name=name,
                                       our_field_name=None, created_at=now))
            db.commit()
        finally:
            db.close()
    except Exception as e:
        logger.warning(f"form answers: could not remember field definitions: {e}")
    logger.info(f"form answers: learned {len(learned)} field names for {location_id}: "
                f"{sorted(k for k in unknown_ids if k in learned)}")


def _name_for(field_id: str) -> str | None:
    """Where this GHL field lands in form_data, or None when only the value
    can tell us."""
    our = _cache["our"].get(field_id)
    if our:
        return our
    key = _cache["keys"].get(field_id) or ""
    tail = key.split(".")[-1].strip().lower()
    return KEY_DEFAULTS.get(tail)


def field_names(ids: list[str], location_id: str | None = None) -> dict[str, str]:
    """GHL field id → our name, for the ids we can name."""
    _load_mappings()
    wanted = [i for i in ids if i]
    unknown = {i for i in wanted if i not in _cache["keys"] and i not in _cache["our"]}
    if unknown and location_id:
        _learn(location_id, unknown)
    out: dict[str, str] = {}
    for i in wanted:
        name = _name_for(i)
        if name:
            out[i] = name
    return out


def resolve_custom_fields(raw_fields: list | dict, location_id: str | None = None) -> dict:
    """The contact's custom fields as form_data keys. Unnamed fields keep
    their raw key, as before, so nothing is lost."""
    result: dict = {}
    items: list[tuple[str, str, str]] = []   # (field_id, key, value)
    if isinstance(raw_fields, list):
        for cf in raw_fields:
            field_id = cf.get("id") or ""
            key = cf.get("key") or field_id
            value = cf.get("value") or ""
            if isinstance(value, list):
                value = ", ".join(str(v) for v in value)
            if key and value:
                items.append((field_id, key, str(value)))
    elif isinstance(raw_fields, dict):
        for key, value in raw_fields.items():
            if isinstance(value, list):
                value = ", ".join(str(v) for v in value)
            if key and value:
                items.append((key, key, str(value)))

    names = field_names([fid for fid, _, _ in items], location_id)
    unnamed: list[tuple[str, str]] = []
    for field_id, key, value in items:
        name = names.get(field_id)
        if name:
            result[name] = value
        else:
            unnamed.append((key, value))

    # Fall back to value-based guessing for fields nobody could name.
    stained_candidates: list[str] = []
    for key, value in unnamed:
        v_lower = value.lower().strip()
        field_name = _classify_field(value)
        if field_name:
            result.setdefault(field_name, value)
            continue
        if v_lower in ("yes", "no"):
            stained_candidates.append(value)
            continue
        result[key] = value

    if stained_candidates and "previously_stained" not in result:
        result["previously_stained"] = stained_candidates[0]
    return result


def merge_answers(form_data: dict, raw_fields: list | dict, location_id: str | None = None,
                  only: frozenset[str] | set[str] | None = None) -> bool:
    """Write the contact's current answers into a lead's form_data, in
    place. Empty answers never blank a value; raw-id keys from before the
    field was named are dropped once the named one is written. `only`
    limits the write to those names (the mirror passes CUSTOMER_ONLY so it
    never undoes an estimator's edits). Returns True when anything changed."""
    answers = resolve_custom_fields(raw_fields, location_id)
    changed = False
    for k, v in answers.items():
        if v in (None, ""):
            continue
        if only is not None and k not in only:
            continue
        if str(form_data.get(k, "")) != str(v):
            form_data[k] = v
            changed = True
    for raw in stale_raw_keys(form_data, location_id):
        name = field_names([raw], location_id).get(raw)
        if only is not None and name not in only:
            continue
        form_data.pop(raw, None)
        changed = True
    return changed


def stale_raw_keys(form_data: dict, location_id: str | None = None) -> list[str]:
    """form_data keys that are GHL field ids we can now name."""
    raw = [k for k in form_data if isinstance(k, str) and len(k) == 20 and k.isalnum() and "_" not in k]
    if not raw:
        return []
    return [k for k in raw if k in field_names(raw, location_id)]
