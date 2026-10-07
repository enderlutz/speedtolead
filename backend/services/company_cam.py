"""Company Cam — the job-site record for one customer.

Everything a cleaner or stainer needs while standing at the fence, and
everything management needs back from them before they drive away.

Why this is keyed on `lead_id` and not `scheduled_job_id`:
the crew fields already existed on ScheduledJob — `color_choice`,
`gallons_estimate`, `inspection_notes` — along with a whole `job_photos`
table with `inspection | post_cleanup | post_staining` categories. None of
it was ever adopted: 58 scheduled jobs, 0 completed, 8 with a colour, 3 with
gallons, and `job_photos` holds **0 rows**. Meanwhile there are 2,420 leads.
Alan asked for this on every lead, and the data agrees with him — a record
that only exists once somebody remembers to schedule a job is a record that
does not exist.

The derived numbers (square footage, package, colour) are seeded from the
latest sent estimate and then editable. The crew's number wins: they are the
ones at the fence.
"""
from __future__ import annotations

import json
import logging

logger = logging.getLogger(__name__)

# Square feet one gallon of stain covers.
#
# Alan said 165 on 2026-10-06. api/scheduling.py:507 says 175 and attributes
# that to him too, so one of the two is stale — flagged, not silently picked.
# Kept as a constant so changing it is one line and every surface moves
# together.
SQFT_PER_GALLON = 165.0

# The photo sections, in the order the job actually happens.
#
# There is deliberately no "before staining" section. Alan's reasoning, and
# it is right: the after-cleaning photos already show the fence immediately
# before stain goes on, so a fourth set would be the same fence twice and
# crews would stop bothering with any of it.
SECTIONS: list[dict] = [
    {
        "key": "fence_scope",
        "label": "Fence scope",
        "who": "Office, before the crew goes out",
        "hint": "What are we actually staining? Pulled from the Fence Scope tab "
                "automatically when a scope drawing exists. If there isn't one, "
                "add a photo — or write out the scope so the cleaner and stainer "
                "know exactly what is and isn't included.",
        "wants_damage": False,
    },
    {
        "key": "clean_before",
        "label": "Before cleaning",
        "who": "Cleaner, on arrival",
        "hint": "Every single side of the fence before you touch it — we need to "
                "see everything. Also photograph anything already broken or "
                "damaged, and mark those as damage.",
        "wants_damage": True,
    },
    {
        "key": "clean_after",
        "label": "After cleaning",
        "who": "Cleaner, before leaving",
        "hint": "The clean fence, every side. This is also the stainer's "
                "before-shot, so make it count.",
        "wants_damage": False,
    },
    {
        "key": "stain_after",
        "label": "After staining",
        "who": "Stainer, before leaving",
        "hint": "Every single side of the finished fence, plus anything that "
                "looks broken or damaged.",
        "wants_damage": True,
    },
]

SECTION_KEYS = tuple(s["key"] for s in SECTIONS)

# Upsells the crew can tick. Sourced from the real service catalogue so the
# keys match everything else in the app, plus the two Alan named that the
# catalogue doesn't sell yet.
EXTRA_UPSELLS: list[tuple[str, str]] = [
    ("landscaping", "Landscaping"),
    ("fence_replacement", "Fence replacement"),
]


def upsell_options() -> list[dict]:
    """Tickable upsells: the non-staining services we already sell, plus the
    two Alan asked for that aren't in the catalogue."""
    from services.service_catalog import SERVICE_CATALOG

    out = [
        {"key": k, "label": label}
        for k, label, is_tier in SERVICE_CATALOG
        if not is_tier
    ]
    have = {o["key"] for o in out}
    out.extend({"key": k, "label": l} for k, l in EXTRA_UPSELLS if k not in have)
    return out


def gallons_for(sqft: float | None) -> float:
    """Gallons of stain for a given area, rounded up to the nearest half
    gallon — you cannot buy 3.07 gallons, and sending a crew out short is
    worse than sending them with a little spare."""
    try:
        s = float(sqft or 0)
    except (TypeError, ValueError):
        return 0.0
    if s <= 0:
        return 0.0
    raw = s / SQFT_PER_GALLON
    return round((int(raw * 2) + (1 if raw * 2 % 1 else 0)) / 2, 2)


def derive_from_estimate(db, lead_id: str) -> dict:
    """Square footage, package and colour as the latest sent estimate has them.

    Returns only what it actually found — the caller must not overwrite a
    crew's edit with a zero just because an estimate is missing a field.
    """
    from database import Estimate

    est = (
        db.query(Estimate)
        .filter(Estimate.lead_id == lead_id, Estimate.status == "sent")
        .order_by(Estimate.sent_at.desc().nullslast())
        .first()
    )
    if not est:
        return {}

    out: dict = {"estimate_id": est.id}
    try:
        inputs = json.loads(est.inputs or "{}")
    except (ValueError, TypeError):
        inputs = {}

    # `_sqft` is what the estimator computed; linear_feet x height is the
    # fallback when an older estimate predates it.
    sqft = inputs.get("_sqft")
    if not sqft:
        try:
            lf = float(inputs.get("linear_feet") or 0)
            h = str(inputs.get("fence_height") or "").lower().replace("ft", "").strip()
            sqft = lf * float(h) if (lf and h) else 0
        except (TypeError, ValueError):
            sqft = 0
    try:
        if float(sqft or 0) > 0:
            out["sqft"] = round(float(sqft), 1)
    except (TypeError, ValueError):
        pass

    # The tier the customer actually bought, when we know it.
    if (est.closed_tier or "").strip():
        out["package"] = est.closed_tier.strip().lower()
    return out
