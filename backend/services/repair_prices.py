"""The repair price list, editable on the Pricing page (Alan, 2026-11-11:
"just to have if we ever decide to adjust them").

Prices per unit in cents, tax included, kept in SystemConfig under
SETTING_KEY as JSON ({"pine": 1200, ...}). Nothing saved = the defaults
(services/company_cam.REPAIR_PRICE_CENTS). A saved list only changes what
is priced from the list from then on: a booking stores each line's price
when it's sent, and a job's agreed price each sits in its repairs_json.

Repairs are always at the plain list price: the new-customer +10%
(services/new_pricing.py) is for the staining price only (Alan, 2026-11-11).
"""
from __future__ import annotations

import json
import time

SETTING_KEY = "repair_prices"
KEYS: tuple[str, ...] = ("pine", "cedar", "rotboard", "cap", "rail", "post6", "post7", "post8")
LABELS: dict[str, str] = {"pine": "Pine picket", "cedar": "Cedar picket", "rotboard": "Rot board", "cap": "Cap",
                          "rail": "Rail", "post6": "Post (6 ft fence)", "post7": "Post (7 ft fence)",
                          "post8": "Post (8 ft fence)"}
MAX_CENTS = 200_000  # $2,000 each
CACHE_SECONDS = 30.0

_cache: dict | None = None
_cache_at = 0.0


def defaults() -> dict[str, int]:
    from services.company_cam import REPAIR_PRICE_CENTS
    return {k: int(REPAIR_PRICE_CENTS[k]) for k in KEYS}


def clear_cache() -> None:
    global _cache, _cache_at
    _cache, _cache_at = None, 0.0


def _parse(raw: str) -> dict[str, int]:
    """The saved list over the defaults; anything missing or bad = its default."""
    out = defaults()
    try:
        v = json.loads(raw or "{}") or {}
    except (TypeError, ValueError):
        v = {}
    if isinstance(v, dict):
        for k in KEYS:
            c = v.get(k)
            if isinstance(c, (int, float)) and not isinstance(c, bool) and 0 < c <= MAX_CENTS:
                out[k] = int(round(c))
    return out


def _read(db) -> dict[str, int]:
    from database import SystemConfig
    return _parse(SystemConfig.get(db, SETTING_KEY, ""))


def get_prices(db=None) -> dict[str, int]:
    """{"pine": 1200, ..., "post8": 35000}: the live list, cached briefly.
    `db` is optional (bills are priced from a job with no session at hand);
    without one a short session of its own is opened. Any read error falls
    back to the defaults, so a bill can always be priced."""
    global _cache, _cache_at
    now = time.monotonic()
    if _cache is not None and now - _cache_at < CACHE_SECONDS:
        return dict(_cache)
    try:
        if db is not None:
            prices = _read(db)
        else:
            from database import get_db
            own = get_db()
            try:
                prices = _read(own)
            finally:
                own.close()
    except Exception:  # noqa: BLE001
        return defaults()
    _cache, _cache_at = prices, now
    return dict(prices)


def validate(body: dict) -> dict[str, int]:
    """Every key, whole cents, more than $0 and at most $2,000. Raises
    ValueError with a plain-words reason."""
    if not isinstance(body, dict):
        raise ValueError("Send the price list.")
    out: dict[str, int] = {}
    for k in KEYS:
        if k not in body:
            raise ValueError(f"{LABELS[k]} is missing a price.")
        c = body[k]
        if isinstance(c, bool) or not isinstance(c, (int, float)):
            raise ValueError(f"{LABELS[k]}: type a number.")
        if c != int(c):
            raise ValueError(f"{LABELS[k]}: whole cents only.")
        if c <= 0:
            raise ValueError(f"{LABELS[k]} has to be more than $0.")
        if c > MAX_CENTS:
            raise ValueError(f"{LABELS[k]} can't be more than $2,000.")
        out[k] = int(c)
    unknown = [k for k in body if k not in KEYS]
    if unknown:
        raise ValueError(f"Unknown repair: {unknown[0]}.")
    return out


def save_prices(db, prices: dict[str, int]) -> tuple[dict[str, int], dict[str, tuple[int, int]]]:
    """Save a validated list; returns (the new list, {key: (old, new)} for
    what changed). Clears the cache."""
    from database import SystemConfig
    old = _read(db)
    SystemConfig.set(db, SETTING_KEY, json.dumps({k: int(prices[k]) for k in KEYS}))
    clear_cache()
    new = get_prices(db)
    return new, {k: (old[k], new[k]) for k in KEYS if old[k] != new[k]}
