"""
Fence staining pricing engine — ported from AT-System parent.
Zone-based pricing, 3-tier system (Essential/Signature/Legacy),
Green/Yellow/Red approval logic.
Pricing can be overridden via PricingConfig DB table.
"""
from __future__ import annotations
import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

# --- Default zone zip code sets (overridden by DB if configured) ---

BASE_ZONE_ZIPS = {
    "77033", "77040", "77041", "77064", "77065", "77066", "77067", "77068",
    "77069", "77070", "77084", "77095", "77355", "77362", "77375", "77377",
    "77379", "77388", "77410", "77429", "77433", "77447", "77449", "77484",
    "77493",
}

BLUE_ZONE_ZIPS = {
    "77018", "77024", "77077", "77079", "77094", "77354", "77380", "77381",
    "77382", "77384", "77385", "77386", "77389", "77423", "77441", "77445",
    "77450", "77494",
}

PURPLE_ZONE_ZIPS = {
    "77479", "77478", "77406", "77407", "77469", "77471", "77043", "77042",
    "77057", "77008", "77007", "77302", "77303", "77304", "77316", "77459",
    "77477", "77489", "77498", "77301", "77305", "77306", "77318", "77356",
    "77009", "77003", "77004", "77006", "77019", "77027", "77056", "77025",
    "77030", "77074", "77036", "77063", "77096", "77044", "77396", "77345",
    "77346", "77338", "77339", "77373",
}

ZONE_SURCHARGES: dict[str, float | None] = {
    "Base": 0.00,
    "Blue": 0.02,
    "Purple": 0.05,
    "Outside": None,
}

# --- Default pricing tiers per sqft by age bracket ---

TIER_RATES: dict[str, dict[str, float] | None] = {
    "brand_new": {"essential": 0.72, "signature": 0.84, "legacy": 1.09},
    "1_6yr":     {"essential": 0.74, "signature": 0.86, "legacy": 1.11},
    "6_15yr":    {"essential": 0.76, "signature": 0.88, "legacy": 1.13},
    "15plus":    None,
}

SIZE_SURCHARGE_RATE = 0.12
SIZE_SURCHARGE_MIN = 500
SIZE_SURCHARGE_MAX = 1000
MIN_SQFT_AUTO = 500


def _load_pricing_config() -> dict | None:
    """Try to load pricing config from DB. Returns None if not configured."""
    try:
        from database import get_db, PricingConfig
        db = get_db()
        try:
            cfg = db.query(PricingConfig).filter(PricingConfig.service_type == "fence_staining").first()
            if cfg and cfg.config:
                data = json.loads(cfg.config) if isinstance(cfg.config, str) else cfg.config
                return data if data else None
            return None
        finally:
            db.close()
    except Exception:
        return None


def _get_zone_zips() -> tuple[set, set, set]:
    """Return (base, blue, purple) zip sets, from DB config or defaults."""
    cfg = _load_pricing_config()
    if cfg and "zones" in cfg:
        zones = cfg["zones"]
        return (
            set(zones.get("base", list(BASE_ZONE_ZIPS))),
            set(zones.get("blue", list(BLUE_ZONE_ZIPS))),
            set(zones.get("purple", list(PURPLE_ZONE_ZIPS))),
        )
    return BASE_ZONE_ZIPS, BLUE_ZONE_ZIPS, PURPLE_ZONE_ZIPS


def _get_tier_rates() -> dict[str, dict[str, float] | None]:
    """Return tier rates from DB config or defaults."""
    cfg = _load_pricing_config()
    if cfg and "tier_rates" in cfg:
        return cfg["tier_rates"]
    return TIER_RATES


def _get_surcharge_config() -> tuple[float, int, int]:
    """Return (rate, min_sqft, max_sqft) from DB config or defaults."""
    cfg = _load_pricing_config()
    if cfg and "surcharge" in cfg:
        s = cfg["surcharge"]
        return (
            float(s.get("rate", SIZE_SURCHARGE_RATE)),
            int(s.get("min_sqft", SIZE_SURCHARGE_MIN)),
            int(s.get("max_sqft", SIZE_SURCHARGE_MAX)),
        )
    return SIZE_SURCHARGE_RATE, SIZE_SURCHARGE_MIN, SIZE_SURCHARGE_MAX


# --- Helpers ---

def get_zone(zip_code: str) -> str:
    base, blue, purple = _get_zone_zips()
    z = str(zip_code).strip()[:5]
    if z in base:
        return "Base"
    if z in blue:
        return "Blue"
    if z in purple:
        return "Purple"
    return "Outside"


def parse_fence_height(height_str: str) -> float:
    s = str(height_str).lower().strip()
    if "6.5" in s or "rot board" in s:
        return 6.5
    for num in ("8", "7", "6"):
        if s.startswith(num):
            return float(num)
    return 6.0


def parse_age_bracket(age_str: str) -> str:
    s = str(age_str).lower().strip()
    if "brand new" in s or "less than 6" in s:
        return "brand_new"
    if "1-6" in s or "1\u20136" in s:
        return "1_6yr"
    if "6-15" in s or "6\u201315" in s:
        return "6_15yr"
    return "15plus"


def parse_priority(timeline_str: str) -> str:
    s = str(timeline_str).lower().strip()
    if "as soon" in s or "possible" in s:
        return "HOT"
    if "2 weeks" in s or "two weeks" in s:
        return "HIGH"
    if "this month" in s or "sometime" in s:
        return "MEDIUM"
    return "LOW"


def get_approval_status(
    age_bracket: str,
    zone: str,
    sqft: float,
    has_addons: bool,
    confident: bool = True,
) -> tuple[str, str]:
    red_reasons = []
    if not confident:
        red_reasons.append("VA not confident in measurement")
    if zone == "Outside":
        red_reasons.append("Outside service zone")
    if 0 < sqft < MIN_SQFT_AUTO:
        red_reasons.append(f"Job too small ({sqft:.0f} sqft)")
    if age_bracket == "15plus":
        red_reasons.append("Fence 15+ years old")

    if red_reasons:
        return "red", "; ".join(red_reasons)
    if has_addons:
        return "yellow", "Add-on services requested"
    return "green", "All criteria met"


def determine_kanban_column(form_data: dict, approval_status: str, zip_code: str, approval_reason: str = "") -> str:
    """Auto-assign kanban column based on data completeness + approval."""
    address = str(form_data.get("address") or "").strip()
    has_zip = bool(zip_code and len(str(zip_code).strip()) >= 5)

    if not address and not has_zip:
        return "no_address"

    linear_feet = float(form_data.get("linear_feet") or 0)
    if linear_feet == 0:
        return "needs_info"

    if approval_status == "red":
        # Route to not_confident for specific reasons, needs_review for others
        reason_lower = approval_reason.lower()
        if "not confident" in reason_lower or "outside service zone" in reason_lower or "too small" in reason_lower:
            return "not_confident"
        return "needs_review"
    if approval_status == "yellow":
        return "yellow"
    return "hot_lead"


# --- Main calculator ---

def calculate_fence_staining(
    form_data: dict[str, Any],
    zip_code: str = "",
) -> tuple[float, float, list[dict], dict[str, Any]]:
    """
    Returns (estimate_low, estimate_high, breakdown, meta).
    Signature tier is the primary estimate.
    """
    linear_feet = float(form_data.get("linear_feet") or 0)
    height = parse_fence_height(str(form_data.get("fence_height", "6ft standard")))
    age_bracket = parse_age_bracket(str(form_data.get("fence_age", "1-6 years")))
    additional_services = str(form_data.get("additional_services", "") or "").strip()
    has_addons = bool(additional_services) and additional_services.lower() not in ("none", "no")
    confident_pct = form_data.get("confident_pct")
    if confident_pct is not None:
        confident = float(confident_pct) >= 80
    else:
        confident = bool(form_data.get("confident", True))
    priority = parse_priority(str(form_data.get("service_timeline", "")))

    zip_str = str(zip_code or form_data.get("zip_code", "") or "").strip()
    zone = get_zone(zip_str)
    zone_surcharge_rate = ZONE_SURCHARGES.get(zone) or 0.0

    sqft = round(linear_feet * height, 2)

    tier_rates = _get_tier_rates()
    surcharge_rate, surcharge_min, surcharge_max = _get_surcharge_config()

    if sqft == 0:
        approval_status, approval_reason = "red", "Missing linear feet"
        meta: dict[str, Any] = {
            "zone": zone, "zone_surcharge": zone_surcharge_rate,
            "sqft": 0, "height": height, "age_bracket": age_bracket,
            "has_addons": has_addons, "priority": priority,
            "approval_status": approval_status,
            "approval_reason": approval_reason,
            "tiers": {"essential": 0.0, "signature": 0.0, "legacy": 0.0},
            "size_surcharge_applied": False,
        }
        return 0.0, 0.0, [], meta

    approval_status, approval_reason = get_approval_status(age_bracket, zone, sqft, has_addons, confident)

    rates = tier_rates.get(age_bracket)
    if rates is None:
        meta = {
            "zone": zone, "zone_surcharge": zone_surcharge_rate,
            "sqft": sqft, "height": height, "age_bracket": age_bracket,
            "has_addons": has_addons, "priority": priority,
            "approval_status": "red",
            "approval_reason": "Fence 15+ years old",
            "tiers": {"essential": 0.0, "signature": 0.0, "legacy": 0.0},
            "size_surcharge_applied": False,
        }
        return 0.0, 0.0, [], meta

    size_surcharge_applied = surcharge_min <= sqft <= surcharge_max
    size_surcharge = surcharge_rate if size_surcharge_applied else 0.0

    def calc_tier(base_rate: float) -> float:
        return round(sqft * (base_rate + zone_surcharge_rate + size_surcharge), 2)

    tiers = {
        "essential": calc_tier(rates["essential"]),
        "signature": calc_tier(rates["signature"]),
        "legacy": calc_tier(rates["legacy"]),
    }

    mid = tiers["signature"]

    # Expanded breakdown — per-sqft rates for all 3 tiers + surcharges
    breakdown = [
        {"label": f"Essential: ${rates['essential']:.2f}/sqft x {sqft:.0f} sqft",
         "value": round(sqft * rates["essential"], 2),
         "note": f"Base rate for {age_bracket.replace('_', ' ')} fence"},
        {"label": f"Signature: ${rates['signature']:.2f}/sqft x {sqft:.0f} sqft",
         "value": round(sqft * rates["signature"], 2),
         "note": f"Recommended tier"},
        {"label": f"Legacy: ${rates['legacy']:.2f}/sqft x {sqft:.0f} sqft",
         "value": round(sqft * rates["legacy"], 2),
         "note": f"Premium tier"},
    ]
    if zone_surcharge_rate > 0:
        breakdown.append({
            "label": f"{zone} zone surcharge: +${zone_surcharge_rate:.2f}/sqft",
            "value": round(sqft * zone_surcharge_rate, 2),
            "note": f"Applied to all tiers",
        })
    if size_surcharge_applied:
        breakdown.append({
            "label": f"Small job surcharge: +${surcharge_rate:.2f}/sqft",
            "value": round(sqft * surcharge_rate, 2),
            "note": f"Applied for {surcharge_min}-{surcharge_max} sqft jobs",
        })

    meta = {
        "zone": zone, "zone_surcharge": zone_surcharge_rate,
        "sqft": sqft, "height": height, "age_bracket": age_bracket,
        "has_addons": has_addons, "priority": priority,
        "approval_status": approval_status,
        "approval_reason": approval_reason,
        "tiers": tiers,
        "size_surcharge_applied": size_surcharge_applied,
    }

    return mid, mid, breakdown, meta


def calculate_estimate(
    service_type: str,
    form_data: dict[str, Any],
    zip_code: str = "",
) -> tuple[float, float, list[dict], dict[str, Any]]:
    """Top-level dispatcher."""
    return calculate_fence_staining(form_data, zip_code)
