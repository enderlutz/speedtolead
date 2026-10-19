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
import re

logger = logging.getLogger(__name__)

# Square feet one gallon of stain covers.
#
# Alan said 165 on 2026-10-06. api/scheduling.py:507 says 175 and attributes
# that to him too, so one of the two is stale — flagged, not silently picked.
# Kept as a constant so changing it is one line and every surface moves
# together.
SQFT_PER_GALLON = 165.0
# A solid stain covers more fence a gallon (Alan, 2026-10-16), so a job
# with a solid stain picked divides by 175 instead.
SQFT_PER_GALLON_SOLID = 175.0

# The photo sections, in the order the job actually happens.
#
# "Before staining" was left out at first: the after-cleaning photos already
# show the fence right before stain goes on. Alan added it back on
# 2026-10-08 as the stainer's own check — anything else they notice around
# the house before they start — and because uploading them is what marks the
# job as "getting stained" on the customer journey. Not a blocker: it is an
# extra check, not proof the job was done.
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
        "key": "stain_before",
        "label": "Before staining",
        "who": "Stainer, on arrival",
        "hint": "Before any stain goes on: anything you notice around the house — "
                "plants, cars, AC units, pool, anything already damaged or in the "
                "way. It's the extra check. Mark damage as damage.",
        "wants_damage": True,
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


def gallons_for(sqft: float | None, per_gallon: float = SQFT_PER_GALLON) -> float:
    """Gallons of stain for a given area, rounded up to the nearest half
    gallon — you cannot buy 3.07 gallons, and sending a crew out short is
    worse than sending them with a little spare."""
    try:
        s = float(sqft or 0)
    except (TypeError, ValueError):
        return 0.0
    if s <= 0:
        return 0.0
    raw = s / (per_gallon or SQFT_PER_GALLON)
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
    """Every stain on the shelf as colour · brand · opacity ("October Brown ·
    Valspar · Solid"). A colour name alone means nothing: the same name comes
    in other brands and other opacities (Alan, 2026-10-15), so the bare
    "usual list" is gone. Active rows only."""
    from database import StainInventoryItem

    try:
        rows = (db.query(StainInventoryItem).filter(StainInventoryItem.active.is_(True),
                                                    StainInventoryItem.finish_type != "bleach")
                .order_by(StainInventoryItem.color_name, StainInventoryItem.brand).all())
    except Exception:  # noqa: BLE001 — a missing table must not break the crew screen
        logger.exception("stain inventory unavailable for colour options")
        return []
    out: list[str] = []
    for r in rows:
        label = stain_label(r)
        if label and label not in out:
            out.append(label)
    return sorted(out, key=str.lower)


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
    # The cleaner pulls the rocks and plants away so the stainer can reach the
    # whole board, down to the ground; the stainer puts them back (Alan,
    # 2026-10-17). New key: a tick on the old "pushed back" item meant the
    # opposite job.
    # Before washing, so the boards behind get cleaned too (Alan, 2026-10-19:
    # pulled back later, the dirt behind lands on a clean fence).
    {"key": "rocks_pulled", "label": "Before washing: rocks, plants and flower beds pulled back from the fence, so the whole board gets cleaned and stained"},
    {"key": "plants_watered", "label": "All plants watered really well"},
    {"key": "fence_rinsed", "label": "All residue rinsed off the fence"},
    {"key": "hose_rolled", "label": "Customer's water hose turned off and rolled back up"},
]

STAINER_CHECKLIST: list[dict] = [
    # The stainer's pre-check, first thing (Alan, 2026-10-19): the cleaner
    # pulls everything back; the stainer makes sure before the first coat.
    {
        "key": "precheck_pulled_back",
        "label": "Before you start: everything is pulled back from the fence (rocks, plants, flower beds)",
        "hint": "The cleaner should have done it. If not, pull it back, take a photo, and tell the office.",
    },
    {"key": "two_coats", "label": "Two coats of stain"},
    {"key": "hinges_clean", "label": "All hinges checked — no stain on them"},
    {"key": "under_rails", "label": "Checked underneath all the 2x4s"},
    {"key": "rocks_back", "label": "Rocks and landscaping pushed back where they were"},
    {"key": "lights_back", "label": "Lights and anything else that was hanging on the fence hung back up"},
    {"key": "trash_picked_up", "label": "All trash picked up"},
    # Four, not two (Alan, 2026-10-17). New key so an old "two" tick doesn't count.
    {"key": "four_walkarounds", "label": "Four full walkarounds of the property done"},
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


def fence_age(db, lead) -> str:
    """How old the fence is, as the customer answered ("6-15 years").

    The latest sent estimate's inputs first, since that's what was priced;
    the form answer otherwise. Empty when they never said."""
    from database import Estimate

    est = (
        db.query(Estimate)
        .filter(Estimate.lead_id == lead.id, Estimate.status == "sent")
        .order_by(Estimate.sent_at.desc().nullslast())
        .first()
    )
    if est:
        try:
            v = str((json.loads(est.inputs or "{}") or {}).get("fence_age") or "").strip()
        except (ValueError, TypeError, AttributeError):
            v = ""
        if v:
            return v
    try:
        fd = json.loads(lead.form_data or "{}") if isinstance(lead.form_data, str) else (lead.form_data or {})
    except (ValueError, TypeError):
        fd = {}
    return str(fd.get("fence_age") or "").strip() if isinstance(fd, dict) else ""


def sold_package(db, lead_id: str) -> str:
    """The package they bought, wherever it was recorded: the booking, the
    deposit link, or the estimate marked closed. Empty when nowhere."""
    from database import Booking, Estimate, PayLink

    b = (db.query(Booking).filter(Booking.lead_id == lead_id, Booking.status != "cancelled")
         .order_by(Booking.sent_at.desc().nullslast()).first())
    for v in (
        b.tier if b else "",
        next((p.job_tier for p in db.query(PayLink).filter(PayLink.lead_id == lead_id, PayLink.job_tier.isnot(None))
              .order_by(PayLink.created_at.desc()).all() if p.job_tier), ""),
        next((e.closed_tier for e in db.query(Estimate).filter(Estimate.lead_id == lead_id, Estimate.closed_tier.isnot(None)).all()
              if e.closed_tier), ""),
    ):
        v = (v or "").strip().lower()
        if v in ("essential", "signature", "legacy"):
            return v
    return ""


def customer_previously_stained(lead) -> str:
    """The customer's form answer to "previously stained?", as they gave it."""
    try:
        fd = json.loads(lead.form_data or "{}") if isinstance(lead.form_data, str) else (lead.form_data or {})
    except (ValueError, TypeError):
        fd = {}
    return str(fd.get("previously_stained") or "").strip() if isinstance(fd, dict) else ""


def stained_answer(job, lead) -> str:
    """ "yes" | "no" | "unknown": confirmed on site first, else the form."""
    if job.previously_stained in ("yes", "no"):
        return job.previously_stained
    v = customer_previously_stained(lead).lower()
    return "yes" if v == "yes" else "no" if v == "no" else "unknown"


def stain_options(db) -> list[dict]:
    """Every stain in the inventory, to pick the one they went with."""
    from database import StainInventoryItem

    try:
        rows = (db.query(StainInventoryItem).filter(StainInventoryItem.finish_type != "bleach")
                .order_by(StainInventoryItem.color_name, StainInventoryItem.brand).all())
    except Exception:  # noqa: BLE001 — a missing table must not break the crew screen
        logger.exception("stain inventory unavailable for stain options")
        return []
    return [{"id": r.id, "label": stain_label(r), "color_name": r.color_name or "", "brand": r.brand or "",
             "finish_type": r.finish_type or "", "active": bool(r.active)} for r in rows]


FINISH_LABELS = {"solid": "Solid", "semi_solid": "Semi-solid", "semi_transparent": "Semi-transparent",
                 "transparent": "Transparent", "clear": "Clear", "oil_based": "Oil-based",
                 "bleach": "Bleach"}


def stain_label(item) -> str:
    """ "October Brown · Valspar · Solid" """
    parts = [item.color_name or "", item.brand or "", FINISH_LABELS.get(item.finish_type or "", item.finish_type or "")]
    return " · ".join(p.strip() for p in parts if p and p.strip())


def _finished_jobs(db) -> list[tuple]:
    """(job, lead, sq ft a gallon) for every job with footage and gallons used."""
    from database import CompanyCamJob, Lead

    out = []
    for job, lead in (db.query(CompanyCamJob, Lead).join(Lead, Lead.id == CompanyCamJob.lead_id)
                      .filter(CompanyCamJob.stain_gallons_used > 0, CompanyCamJob.sqft > 0).all()):
        out.append((job, lead, float(job.sqft) / float(job.stain_gallons_used)))
    return out


def coverage_stats(db, age: str, stain_id: str = "", stained: str = "", wood: str = "") -> dict:
    """Square feet a gallon actually covered: across all jobs, on fences this
    old, and on this exact stain + age + prior stain (the number Alan wants to
    learn, 2026-10-15)."""
    all_rates, same_age, same_all = [], [], []
    for job, lead, r in _finished_jobs(db):
        all_rates.append(r)
        a = fence_age(db, lead)
        if age and a == age:
            same_age.append(r)
            if (stain_id and job.final_stain_id == stain_id and stained_answer(job, lead) == stained
                    and (job.wood_type or "") == wood):
                same_all.append(r)
    avg = lambda xs: round(sum(xs) / len(xs)) if xs else None  # noqa: E731
    return {"all_jobs": len(all_rates), "all_avg": avg(all_rates), "age_jobs": len(same_age), "age_avg": avg(same_age),
            "match_jobs": len(same_all), "match_avg": avg(same_all)}


def coverage_file(db) -> dict:
    """Every finished job grouped by stain, fence age and prior stain: how
    many jobs, total gallons, total sq ft, and sq ft one gallon covered
    (total sq ft ÷ total gallons, so a big job counts for more than a small
    one). Jobs with gallons but no stain picked are listed so they get fixed."""
    from database import StainInventoryItem

    items = {r.id: r for r in db.query(StainInventoryItem).all()}
    groups: dict[tuple, dict] = {}
    missing = []
    for job, lead, r in _finished_jobs(db):
        item = items.get(job.final_stain_id or "")
        entry = {"lead_id": lead.id, "name": lead.contact_name or "", "sqft": round(float(job.sqft)),
                 "gallons": float(job.stain_gallons_used), "sqft_per_gallon": round(r)}
        if not item:
            missing.append({**entry, "color": job.final_color or ""})
            continue
        age = fence_age(db, lead) or "Didn't say"
        stained = stained_answer(job, lead)
        wood = job.wood_type or "unknown"
        key = (item.id, wood, age, stained)
        g = groups.setdefault(key, {"stain_id": item.id, "stain": stain_label(item), "color_name": item.color_name or "",
                                    "brand": item.brand or "", "finish_type": item.finish_type or "", "wood_type": wood, "fence_age": age,
                                    "previously_stained": stained, "jobs": [], "gallons": 0.0, "sqft": 0})
        g["jobs"].append(entry)
        g["gallons"] += entry["gallons"]
        g["sqft"] += entry["sqft"]
    rows = []
    for g in groups.values():
        g["gallons"] = round(g["gallons"], 2)
        g["sqft_per_gallon"] = round(g["sqft"] / g["gallons"]) if g["gallons"] else None
        rows.append(g)
    rows.sort(key=lambda g: (g["color_name"].lower(), g["brand"].lower(), g["wood_type"], g["fence_age"], g["previously_stained"]))
    return {"rows": rows, "missing_stain": missing}


def _height_ft(v) -> float:
    """ "6ft standard" -> 6.0, "6.5" -> 6.5; 0 when there's no number."""
    m = re.search(r"\d+(?:\.\d+)?", str(v or ""))
    return float(m.group()) if m else 0.0


def _last_recalc(db, lead_id: str) -> str:
    """When the lead's estimate was last saved & recalculated, from the log:
    for estimates saved before the save time was kept on the estimate."""
    from database import AutomationLog

    row = (db.query(AutomationLog.created_at)
           .filter(AutomationLog.lead_id == lead_id, AutomationLog.event_type == "estimate_recalculated")
           .order_by(AutomationLog.created_at.desc()).first())
    return row[0] if row else ""


def estimate_options(db, lead_id: str) -> list[dict]:
    """Every estimate with a footage, sent or only saved, newest first, so the
    job's footage can be picked from one (Alan, 2026-10-15: "even if I saved
    and recalculated and didn't send it")."""
    from database import Estimate

    out = []
    for est in (db.query(Estimate).filter(Estimate.lead_id == lead_id, Estimate.status != "cancelled").all()):
        try:
            inputs = json.loads(est.inputs or "{}") or {}
        except (ValueError, TypeError):
            inputs = {}
        try:
            lf = float(inputs.get("linear_feet") or 0)
        except (TypeError, ValueError):
            lf = 0
        try:
            sqft = float(inputs.get("_sqft") or 0) or lf * _height_ft(inputs.get("fence_height"))
        except (TypeError, ValueError):
            sqft = 0
        if sqft <= 0:
            continue
        when = est.sent_at if est.status == "sent" else (inputs.get("_saved_at") or _last_recalc(db, lead_id) or est.created_at)
        out.append({"id": est.id, "sent": est.status == "sent", "sent_at": est.sent_at or "",
                    "when": when or "", "sqft": round(sqft),
                    "linear_feet": round(lf) if lf else None, "height": str(inputs.get("fence_height") or "")})
    out.sort(key=lambda o: o["when"], reverse=True)
    return out


def measure_options(db, lead_id: str) -> dict:
    """The feet traced on Measure & capture, for footage = feet × height, and
    the height to start from (the newest estimate's)."""
    from database import LeadMeasurement

    rows = [{"id": m.id, "label": m.label or f"Photo {m.seq}", "linear_feet": round(float(m.linear_feet))}
            for m in db.query(LeadMeasurement).filter(LeadMeasurement.lead_id == lead_id, LeadMeasurement.purpose.is_distinct_from("job")).order_by(LeadMeasurement.seq).all()
            if m.linear_feet]
    heights = [_height_ft(o["height"]) for o in estimate_options(db, lead_id)]
    return {"captures": rows, "height_ft": next((h for h in heights if h), 6.0)}


# The repair price list, per unit, tax included. Matches frontend
# lib/repairs.ts; change both together.
REPAIR_PRICE_CENTS = {"pine": 1200, "cedar": 1400, "rotboard": 5000, "cap": 8500, "rail": 7500,
                      "post6": 22500, "post7": 25500, "post8": 35000}
POST_LABELS = {"post6": "6 ft fence", "post7": "7 ft fence", "post8": "8 ft fence"}


def repair_lines(counts: dict, picket_type: str, post_type: str) -> list[dict]:
    """[{"name": "Picket replacement (Pine)", "qty": 5, "unit_cents": 1200}, ...]"""
    out = []
    if counts.get("pickets"):
        out.append({"name": f"Picket replacement ({picket_type.title()})", "qty": int(counts["pickets"]),
                    "unit_cents": REPAIR_PRICE_CENTS.get(picket_type, 1200)})
    for key, label in (("rotboard", "Rot board"), ("cap", "Cap"), ("rail", "Rail")):
        if counts.get(key):
            out.append({"name": f"{label} replacement", "qty": int(counts[key]), "unit_cents": REPAIR_PRICE_CENTS[key]})
    if counts.get("posts"):
        out.append({"name": f"Post replacement ({POST_LABELS.get(post_type, '6 ft fence')})", "qty": int(counts["posts"]),
                    "unit_cents": REPAIR_PRICE_CENTS.get(post_type, 22500)})
    return out


def site_extras(job) -> dict:
    """The confirmed on-site extras: their lines and total, or empty."""
    if not job or not (job.extras_confirmed_at or ""):
        return {"lines": [], "total_cents": 0, "confirmed_at": ""}
    try:
        v = json.loads(job.extras_json or "{}") or {}
    except (ValueError, TypeError):
        v = {}
    lines = repair_lines(v.get("counts") or {}, v.get("picket_type") or "pine", v.get("post_type") or "post6")
    return {"lines": lines, "total_cents": sum(l["qty"] * l["unit_cents"] for l in lines), "confirmed_at": job.extras_confirmed_at}


def sqft_per_gallon(db, job) -> float:
    """175 when the stain they went with is a solid, else 165."""
    if not (job.final_stain_id or ""):
        return SQFT_PER_GALLON
    from database import StainInventoryItem
    item = db.query(StainInventoryItem).filter(StainInventoryItem.id == job.final_stain_id).first()
    return SQFT_PER_GALLON_SOLID if item and (item.finish_type or "") == "solid" else SQFT_PER_GALLON
