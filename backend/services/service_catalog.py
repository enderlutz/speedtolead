"""Service catalog for the schedule / calendar-invite line items.

The scheduling screen moved from a single fixed "package" to invoice-style
service line items (2026-07-30). This module is the canonical list of
services Alan can add to a job, plus their default customer-facing
descriptions.

Descriptions are editable at runtime: the admin's overrides live in
SystemConfig under SERVICE_DESCRIPTIONS_KEY (a JSON {key: text} map) and win
over the DEFAULT_DESCRIPTIONS drafts below. The three staining tiers
(essential / signature / legacy) are flagged is_tier=True so the schedule
modal knows to pre-fill their price from the lead's estimate; everything
else is manually priced per job.
"""
from __future__ import annotations
import json

from database import SystemConfig

SERVICE_DESCRIPTIONS_KEY = "service_descriptions"

# (key, customer-facing label, is_staining_tier)
SERVICE_CATALOG: list[tuple[str, str, bool]] = [
    ("essential", "Essential finish", True),
    ("signature", "Signature finish", True),
    ("legacy", "Legacy finish", True),
    ("pergola_staining", "Pergola staining", False),
    ("deck_staining", "Deck staining", False),
    ("sprinkler_repair", "Sprinkler repair", False),
    ("house_washing", "House washing", False),
    ("driveway_walkway_cleaning", "Driveway & walkway cleaning", False),
    ("roof_washing", "Roof washing", False),
    ("gutter_cleaning", "Gutter cleaning", False),
    ("exterior_window_cleaning", "Exterior window cleaning", False),
]

# Short starter drafts. Alan edits these to taste via the Service
# Descriptions modal; his edits are stored in SystemConfig and override
# these. Kept intentionally brief — they show to the customer on the
# calendar invite, one per service.
DEFAULT_DESCRIPTIONS: dict[str, str] = {
    "essential": "Essential finish — thorough cleaning and staining of your fence for solid, even protection.",
    "signature": "Signature finish — deep cleaning and premium staining for a rich, even finish that lasts.",
    "legacy": "Legacy finish — our top-tier cleaning and staining with maximum protection and the richest color.",
    "pergola_staining": "Cleaning and staining of your pergola to protect the wood and match your fence.",
    "deck_staining": "Cleaning and staining of your deck for a fresh, protected, even finish.",
    "sprinkler_repair": "Inspection and repair of sprinkler heads and lines as needed.",
    "house_washing": "Exterior house washing to remove dirt, mildew, and buildup.",
    "driveway_walkway_cleaning": "Pressure cleaning of your driveway and walkways to lift dirt and stains.",
    "roof_washing": "Gentle soft-wash roof cleaning to remove algae, moss, and black streaks.",
    "gutter_cleaning": "Clearing and flushing of your gutters and downspouts so they drain freely.",
    "exterior_window_cleaning": "Exterior window cleaning for a clear, streak-free shine.",
}

_LABELS = {k: label for k, label, _ in SERVICE_CATALOG}
_TIER_KEYS = {k for k, _, tier in SERVICE_CATALOG if tier}


def _load_overrides(db) -> dict:
    raw = SystemConfig.get(db, SERVICE_DESCRIPTIONS_KEY, "")
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def get_catalog(db) -> list[dict]:
    """Full catalog with the current (possibly admin-edited) descriptions."""
    overrides = _load_overrides(db)
    return [
        {
            "key": key,
            "label": label,
            "is_tier": tier,
            "description": (overrides.get(key) or DEFAULT_DESCRIPTIONS.get(key, "")),
        }
        for key, label, tier in SERVICE_CATALOG
    ]


def save_overrides(db, descriptions: dict) -> None:
    """Persist Alan's description edits. Only known keys with non-empty text
    are stored; a blank value drops back to the DEFAULT for that service."""
    clean: dict[str, str] = {}
    for key, _, _ in SERVICE_CATALOG:
        v = (descriptions.get(key) or "").strip()
        if v:
            clean[key] = v
    SystemConfig.set(db, SERVICE_DESCRIPTIONS_KEY, json.dumps(clean))


def is_tier(key: str) -> bool:
    return key in _TIER_KEYS


def label_for(key: str) -> str:
    return _LABELS.get(key, (key or "").replace("_", " ").title())


def primary_tier_key(services: list[dict]) -> str:
    """The staining tier among a job's services, used to keep
    ScheduledJob.package_tier in sync for downstream (proposals, accounting,
    worker view). Falls back to 'custom' when services exist but none is a
    tier, or '' when there are no services at all."""
    for s in services or []:
        if (s.get("key") or "") in _TIER_KEYS:
            return s["key"]
    return "custom" if services else ""
