"""New-customer pricing (Alan, 2026-11-04).

The mentor's plan: raise prices 10%. Alan's rule: only for a brand-new
person, "a lead that's never filled out anything with us or done any kind of
conversation with us". Everyone already in the system keeps today's prices,
so an old lead Gioconda calls back and re-sends gets the same number as
before.

How it works: when a lead row is first written (database._stamp_new_pricing,
a before-insert listener, so every path that creates a lead goes through
it), the lead gets `price_uplift_pct` = the current setting (10) if nobody
with the same phone or email is already in the system, and 0 otherwise.
It is decided once and never changes, so changing the setting later only
moves leads that come in after the change.

"Already in the system" means any of:
  - another lead with the same phone (last 10 digits) or email;
  - a GHL contact with that phone, email or GHL id that GHL created more
    than KNOWN_AFTER_DAYS ago (they texted, called or chatted before, even
    if they never got a lead card).

The price engine multiplies everything by `multiplier(lead)`: the package
rates, the zone and small-job surcharges and the minimum job: the staining
price only. Repairs are never uplifted; they're always the plain list price
(Alan, 2026-11-11; services/repair_prices.py). Estimates already sent stay
frozen as they are.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import text

SETTING_KEY = "new_customer_uplift_percent"
DEFAULT_PERCENT = 10.0
# A GHL contact made in the last few days is this same new person arriving
# (the contact is created a moment before the form's lead). Older than this
# and they were here before.
KNOWN_AFTER_DAYS = 3


def _percent_from(raw: str | None) -> float:
    try:
        v = float(raw) if raw not in (None, "") else DEFAULT_PERCENT
    except (TypeError, ValueError):
        v = DEFAULT_PERCENT
    return max(0.0, min(v, 100.0))


def percent_setting(db) -> float:
    """The percent a brand-new lead gets today (0 turns it off)."""
    from database import SystemConfig
    return _percent_from(SystemConfig.get(db, SETTING_KEY, ""))


def multiplier(lead) -> float:
    """1.10 for a new-customer-pricing lead at 10%, 1.0 for everyone else."""
    pct = float(getattr(lead, "price_uplift_pct", 0) or 0) if lead is not None else 0.0
    return 1.0 + pct / 100.0 if pct > 0 else 1.0


def _older_than(stamp: str, cutoff: datetime) -> bool:
    s = (stamp or "").strip()
    if not s:
        return False
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return False
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt < cutoff


def seen_before(connection, *, lead_id: str, phone_key: str, email: str, ghl_contact_id: str,
                now: datetime | None = None) -> bool:
    """True when this person is already in the system in any form."""
    pk = (phone_key or "").strip()
    em = (email or "").strip().lower()
    gid = (ghl_contact_id or "").strip()
    if pk or em:
        hit = connection.execute(text(
            # A contact-mirror placeholder (pipeline_version 'contact') is not
            # a past lead: the contacts check below dates the person instead.
            "SELECT 1 FROM leads WHERE id <> :id"
            " AND coalesce(pipeline_version, '') <> 'contact' AND ("
            " (:pk <> '' AND phone_key = :pk) OR"
            " (:em <> '' AND lower(trim(coalesce(contact_email, ''))) = :em)) LIMIT 1"),
            {"id": lead_id or "", "pk": pk, "em": em}).first()
        if hit:
            return True
    if pk or em or gid:
        cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=KNOWN_AFTER_DAYS)
        try:
            rows = connection.execute(text(
                "SELECT date_added FROM contacts WHERE"
                " (:pk <> '' AND phone_key = :pk) OR"
                " (:em <> '' AND lower(trim(coalesce(email, ''))) = :em) OR"
                " (:gid <> '' AND ghl_contact_id = :gid)"),
                {"pk": pk, "em": em, "gid": gid}).fetchall()
        except Exception:  # noqa: BLE001 — no contacts table (fresh test DB)
            rows = []
        if any(_older_than(r[0], cutoff) for r in rows):
            return True
    return False


def uplift_for_new_lead(connection, lead) -> float:
    """The percent to stamp on a lead being created: the setting for a
    brand-new person, 0 for anyone we've seen before or can't identify."""
    try:
        row = connection.execute(text("SELECT value FROM system_config WHERE key = :k"),
                                 {"k": SETTING_KEY}).first()
        pct = _percent_from(row[0] if row else None)
    except Exception:  # noqa: BLE001
        pct = DEFAULT_PERCENT
    if pct <= 0:
        return 0.0
    from services.name_match import phone_key as _pk
    pk = getattr(lead, "phone_key", "") or _pk(getattr(lead, "contact_phone", "") or "")
    email = getattr(lead, "contact_email", "") or ""
    if not (pk or email.strip()):
        return 0.0  # can't tell who they are: today's prices
    # The GHL contact behind this lead was made days ago: they were here before.
    cutoff = datetime.now(timezone.utc) - timedelta(days=KNOWN_AFTER_DAYS)
    if _older_than(getattr(lead, "ghl_created_at", "") or "", cutoff):
        return 0.0
    if seen_before(connection, lead_id=getattr(lead, "id", "") or "", phone_key=pk, email=email,
                   ghl_contact_id=getattr(lead, "ghl_contact_id", "") or ""):
        return 0.0
    return pct
