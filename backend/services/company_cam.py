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


# --- the eight sides of a fence ---
#
# The same vocabulary the estimator saves in `form_data.fence_sides`, so a
# colour row on Company Cam and a side on the estimate are literally the same
# string. Front faces the street.
FENCE_SIDE_GROUPS: dict[str, list[str]] = {
    "Inside":  ["Inside Front", "Inside Left", "Inside Back", "Inside Right"],
    "Outside": ["Outside Front", "Outside Left", "Outside Back", "Outside Right"],
}
FENCE_SIDE_KEYS: tuple[str, ...] = tuple(
    s for group in FENCE_SIDE_GROUPS.values() for s in group
)


def normalize_sides(raw) -> list[str]:
    """A list of known side names, in the order given, no repeats. Accepts a
    list or the comma-separated string older form_data used."""
    if isinstance(raw, str):
        raw = [x.strip() for x in raw.split(",")]
    out: list[str] = []
    for x in raw or []:
        name = str(x or "").strip()
        if name in FENCE_SIDE_KEYS and name not in out:
            out.append(name)
    return out


def sides_label(sides: list[str]) -> str:
    """"All insides", "Inside: Front, Left · Outside: Back", "Whole fence".
    What a row of sides is called in the cleaner's instructions."""
    chosen = normalize_sides(sides)
    if not chosen:
        return ""
    if len(chosen) == len(FENCE_SIDE_KEYS):
        return "Whole fence"
    parts: list[str] = []
    for group, names in FENCE_SIDE_GROUPS.items():
        mine = [n for n in names if n in chosen]
        if not mine:
            continue
        if len(mine) == len(names):
            parts.append(f"All {group.lower()}s")
        else:
            short = ", ".join(n.replace(f"{group} ", "") for n in mine)
            parts.append(f"{group}: {short}")
    return " · ".join(parts)


def estimate_sides(db, lead) -> list[str]:
    """The sides the customer bought, as the estimator last saved them.

    `form_data.fence_sides` is what the VA sees on the Estimate tab, so it
    wins; the latest sent estimate's inputs are the fallback for a lead whose
    form_data was never written back."""
    from database import Estimate

    try:
        fd = json.loads(lead.form_data or "{}") if isinstance(lead.form_data, str) else (lead.form_data or {})
    except (ValueError, TypeError):
        fd = {}
    sides = normalize_sides(fd.get("fence_sides")) if isinstance(fd, dict) else []
    if sides:
        return sides
    est = (
        db.query(Estimate)
        .filter(Estimate.lead_id == lead.id, Estimate.status == "sent")
        .order_by(Estimate.sent_at.desc().nullslast())
        .first()
    )
    if not est:
        return []
    try:
        inputs = json.loads(est.inputs or "{}")
    except (ValueError, TypeError):
        inputs = {}
    return normalize_sides(inputs.get("fence_sides")) if isinstance(inputs, dict) else []


# --- the colours we actually use ---
#
# Every colour recorded on a real job through Sep 2026 (frontend/src/data/
# jobs.json), so the crew taps a name instead of spelling it. Not the
# catalogue — Sterling buys from several brands and this is what has gone on
# a fence. The live stain inventory is merged in ahead of these at request
# time, so a colour on the shelf is always offered even if it is new here.
# "Other" on the screen takes anything else, HOA colours included.
STAIN_COLORS: list[str] = [
    "October Brown",
    "Cedar Naturaltone",
    "Simply Cedar",
    "Chocolate Chip",
    "Classic Mahogany",
    "Redwood Naturaltone",
    "Pine Bark",
    "Dark Walnut",
    "Natural Cedar",
    "Pecan",
    "Darkest Night",
    "Cowboy Suede",
    "Potato Skin",
    "Charwood",
    "Bark Mulch",
]


def color_options(db) -> list[str]:
    """What is on the shelf, then the rest of the usual list. De-duplicated
    ignoring case, so "pine bark" in inventory and "Pine Bark" here is one
    chip, spelled the way inventory has it."""
    from database import StainInventoryItem

    out: list[str] = []
    seen: set[str] = set()

    def add(name: str) -> None:
        n = str(name or "").strip()
        if n and n.lower() not in seen:
            seen.add(n.lower())
            out.append(n)

    try:
        rows = (
            db.query(StainInventoryItem)
            .filter(StainInventoryItem.active.is_(True))
            .order_by(StainInventoryItem.color_name)
            .all()
        )
        for r in rows:
            add(r.color_name)
    except Exception:  # noqa: BLE001 — a missing table must not break the crew screen
        logger.exception("stain inventory unavailable for colour options")
    for c in STAIN_COLORS:
        add(c)
    return out


# --- where the customer actually is on colour ---
#
# Alan's problem: sometimes a colour is closed on the phone and settled.
# Often it isn't — the photos don't do the colours justice, so the customer
# is "between two or three" and the cleaner has to hold the samples up at the
# fence. And it can differ by area: the front gates settled, the insides not.
#
# So colour is not one field. It is a list of areas, each with a status and
# the colours in play, which is also what tells the cleaner what to do when
# they arrive.
COLOR_STATUSES: list[dict] = [
    {
        "key": "confirmed",
        "label": "Confirmed — no doubt",
        "hint": "Settled on the call. The cleaner does not need to confirm anything.",
        "wants_colors": 1,
    },
    {
        "key": "choosing",
        "label": "Choosing between a few",
        "hint": "List every colour in play. The cleaner shows these at the fence "
                "and confirms which one.",
        "wants_colors": 2,
    },
    {
        "key": "not_chosen",
        "label": "No colour picked yet",
        "hint": "The cleaner shows the range and gets a decision. If they're "
                "leaning a direction — browns, nothing reddish — write that down.",
        "wants_colors": 0,
    },
]

COLOR_STATUS_KEYS = tuple(s["key"] for s in COLOR_STATUSES)

# Starter areas. Free text, because a fence is not always divisible the way a
# dropdown expects — "the bit by the pool" is a real answer.
COLOR_AREA_SUGGESTIONS = [
    "Whole fence", "Inside fences", "Front gates",
    "Outside front", "Outside back", "Outside left", "Outside right",
]


def normalize_color_plan(raw) -> list[dict]:
    """Clean a colour plan off the wire into (area, sides, status, colors, leaning).

    A row is a set of sides. Its `area` is derived from them — "All insides",
    "Inside: Front, Left · Outside: Back" — so the cleaner's instructions read
    naturally. A row with no sides keeps whatever free-text area it had, which
    is how rows written before the sides map carry on working.

    A side belongs to one row: the first row to claim it keeps it.

    A row is dropped only when it says nothing at all — no sides, no area, no
    colours. It used to be dropped for having no area and no colours, which
    threw away every freshly added row before anybody could type in it.
    """
    out: list[dict] = []
    claimed: set[str] = set()
    for row in raw or []:
        if not isinstance(row, dict):
            continue
        sides = [s for s in normalize_sides(row.get("sides")) if s not in claimed]
        claimed.update(sides)
        area = sides_label(sides) if sides else str(row.get("area") or "").strip()[:80]
        status = str(row.get("status") or "").strip()
        if status not in COLOR_STATUS_KEYS:
            status = "not_chosen"
        colors = [
            str(c).strip()[:60]
            for c in (row.get("colors") or [])
            if str(c).strip()
        ][:8]
        leaning = str(row.get("leaning") or "").strip()[:120] if status == "not_chosen" else ""
        if not area and not sides and not colors:
            continue
        out.append({
            "area": area or "Whole fence",
            "sides": sides,
            "status": status,
            "colors": colors,
            "leaning": leaning,
        })
    return out[:12]


def cleaner_color_actions(plan: list[dict]) -> list[str]:
    """What the cleaner has to settle on site, in plain words.

    This is the point of the whole structure — Alan described it as "the next
    step for the cleaner", not as a record of a decision.
    """
    out: list[str] = []
    for row in plan or []:
        area = row.get("area") or "the fence"
        colors = row.get("colors") or []
        if row.get("status") == "choosing":
            shown = ", ".join(colors) if colors else "the samples"
            out.append(f"{area}: show {shown} and confirm which one they want.")
        elif row.get("status") == "not_chosen":
            leaning = str(row.get("leaning") or "").strip()
            if leaning:
                out.append(f"{area}: no colour chosen — they're leaning towards "
                           f"{leaning}; show those and get a decision.")
            else:
                out.append(f"{area}: no colour chosen — show the range and get a decision.")
        elif row.get("status") == "confirmed" and not colors:
            out.append(f"{area}: marked confirmed but no colour written down — check before you start.")
    return out


# --- end-of-job checklists ---
#
# Alan's wording, kept close to how he said it. These exist because the crew
# is moving to a flat rate per job: coming back to redo work will be on their
# own time, so what "done properly" means has to be written down rather than
# assumed.
CLEANER_CHECKLIST: list[dict] = [
    {"key": "rocks_back", "label": "Rocks and landscaping pushed back where they were"},
    {"key": "plants_watered", "label": "All plants watered really well"},
    {"key": "fence_rinsed", "label": "All residue rinsed off the fence"},
    {"key": "hose_rolled", "label": "Customer's water hose turned off and rolled back up"},
]

STAINER_CHECKLIST: list[dict] = [
    {"key": "two_coats", "label": "Two coats of stain"},
    {"key": "hinges_clean", "label": "All hinges checked — no stain on them"},
    {"key": "under_rails", "label": "Checked underneath all the 2x4s"},
    {"key": "two_walkarounds", "label": "Two full walkarounds done"},
    {
        "key": "customer_satisfied",
        "label": "Customer has seen it and is completely satisfied",
        "hint": "If they're not home, call them — it's your job to make sure what "
                "they wanted matches what you did. Coming back is on your time.",
    },
]

CHECKLIST_KEYS = {
    "cleaner": tuple(i["key"] for i in CLEANER_CHECKLIST),
    "stainer": tuple(i["key"] for i in STAINER_CHECKLIST),
}


def filter_checklist(raw, which: str) -> list[str]:
    """Keep only the ticks we recognise, so a stale client cannot store junk."""
    valid = CHECKLIST_KEYS.get(which, ())
    return [str(k) for k in (raw or []) if str(k) in valid]
