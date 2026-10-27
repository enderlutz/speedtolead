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
    return {"rows": rows, "missing_stain": missing, "bleach": bleach_file(db), "bleach_min_jobs": BLEACH_MIN_JOBS}


# Bleach (Alan, 2026-10-19): the same learning as stain. Every cleaning with
# its footage and the bleach the cleaner used teaches us sq ft a gallon of
# bleach, by fence age; once there are enough cleanings the cleaner is told
# how much to bring without anyone working it out.
BLEACH_MIN_JOBS = 10


def _bleach_jobs(db) -> list[tuple]:
    """(lead, sq ft, gallons) for every cleaning with footage and bleach used.
    A washing job's bleach (pw_bleach_gallons) is a different job and isn't here."""
    from database import CompanyCamJob, Lead

    return [(lead, float(job.sqft), float(job.bleach_gallons_used))
            for job, lead in (db.query(CompanyCamJob, Lead).join(Lead, Lead.id == CompanyCamJob.lead_id)
                              .filter(CompanyCamJob.bleach_gallons_used > 0, CompanyCamJob.sqft > 0).all())]


def bleach_stats(db, age: str = "") -> dict:
    """Sq ft one gallon of bleach cleaned, over every cleaning and on fences
    this old. Total sq ft ÷ total gallons, so a big fence counts for more."""
    tot, same = [0.0, 0.0, 0], [0.0, 0.0, 0]
    for lead, sqft, gal in _bleach_jobs(db):
        for bucket, hit in ((tot, True), (same, bool(age) and fence_age(db, lead) == age)):
            if hit:
                bucket[0] += sqft
                bucket[1] += gal
                bucket[2] += 1
    rate = lambda b: round(b[0] / b[1]) if b[1] else None  # noqa: E731
    return {"all_jobs": tot[2], "all_avg": rate(tot), "age_jobs": same[2], "age_avg": rate(same),
            "min_jobs": BLEACH_MIN_JOBS}


def bleach_suggestion(sqft: float, stats: dict) -> dict | None:
    """Gallons of bleach to bring, once we've learned it: fences this old
    first, every fence when this age hasn't got enough cleanings yet. Rounded
    up to the half gallon, like the stain."""
    if not sqft or sqft <= 0:
        return None
    for basis, jobs, rate in (("age", stats["age_jobs"], stats["age_avg"]), ("all", stats["all_jobs"], stats["all_avg"])):
        if jobs >= BLEACH_MIN_JOBS and rate:
            return {"gallons": gallons_for(sqft, rate), "rate": rate, "jobs": jobs, "basis": basis}
    return None


def bleach_file(db) -> list[dict]:
    """Bleach by fence age: cleanings, total sq ft, total gallons, sq ft a gallon."""
    groups: dict[str, dict] = {}
    for lead, sqft, gal in _bleach_jobs(db):
        age = fence_age(db, lead) or "Didn't say"
        g = groups.setdefault(age, {"fence_age": age, "jobs": [], "sqft": 0, "gallons": 0.0})
        g["jobs"].append({"lead_id": lead.id, "name": lead.contact_name or "", "sqft": round(sqft), "gallons": gal,
                          "sqft_per_gallon": round(sqft / gal)})
        g["sqft"] += round(sqft)
        g["gallons"] += gal
    out = []
    for g in groups.values():
        g["gallons"] = round(g["gallons"], 2)
        g["sqft_per_gallon"] = round(g["sqft"] / g["gallons"]) if g["gallons"] else None
        out.append(g)
    return sorted(out, key=lambda g: g["fence_age"])


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


def list_cents(key: str, picket_type: str = "pine", post_type: str = "post6") -> int:
    """The price list for one repair, by its count key."""
    if key == "pickets":
        return REPAIR_PRICE_CENTS.get(picket_type, 1200)
    if key == "posts":
        return REPAIR_PRICE_CENTS.get(post_type, 22500)
    return REPAIR_PRICE_CENTS.get(key, 0)


def repair_lines(counts: dict, picket_type: str, post_type: str, prices: dict | None = None) -> list[dict]:
    """[{"name": "Picket replacement (Pine)", "qty": 5, "unit_cents": 1200, "key": "pickets"}, ...]
    `prices` (dollars each, by key) is what was agreed; the list otherwise."""
    prices = prices or {}
    each = lambda k: int(round(float(prices[k]) * 100)) if prices.get(k) else list_cents(k, picket_type, post_type)  # noqa: E731
    out = []
    if counts.get("pickets"):
        out.append({"name": f"Picket replacement ({picket_type.title()})", "qty": int(counts["pickets"]),
                    "unit_cents": each("pickets"), "key": "pickets"})
    for key, label in (("rotboard", "Rot board"), ("cap", "Cap"), ("rail", "Rail")):
        if counts.get(key):
            out.append({"name": f"{label} replacement", "qty": int(counts[key]), "unit_cents": each(key), "key": key})
    if counts.get("posts"):
        out.append({"name": f"Post replacement ({POST_LABELS.get(post_type, '6 ft fence')})", "qty": int(counts["posts"]),
                    "unit_cents": each("posts"), "key": "posts"})
    return out


def _load(raw: str) -> dict:
    try:
        v = json.loads(raw or "{}") or {}
    except (ValueError, TypeError):
        v = {}
    return v if isinstance(v, dict) else {}


def planned_repairs(job) -> dict:
    """What the office agreed with the customer on the phone: lines at the
    agreed price each, and the total. Already in the job's price."""
    v = _load(getattr(job, "repairs_json", "") or "")
    lines = repair_lines(v.get("counts") or {}, v.get("picket_type") or "pine", v.get("post_type") or "post6", v.get("prices"))
    return {"lines": lines, "total_cents": sum(l["qty"] * l["unit_cents"] for l in lines)}


def site_extras(job) -> dict:
    """The confirmed on-site repairs: the lines to put on the invoice and
    their total, or empty.

    Two kinds. An add-on (the old way): extras on top of the plan, at the
    price list. A final count (Alan and Chris, 2026-10-22): the crew counted
    what the fence really needs with the customer, at the price each that
    was agreed (they can change it on the spot), and it replaces the plan.
    The plan is already in the job's price, so a final count comes back as
    its lines plus one minus line for the plan: the total is the change to
    the bill, up or down."""
    if not job or not (job.extras_confirmed_at or ""):
        return {"lines": [], "total_cents": 0, "confirmed_at": ""}
    v = _load(job.extras_json or "")
    pt, po = v.get("picket_type") or "pine", v.get("post_type") or "post6"
    lines = repair_lines(v.get("counts") or {}, pt, po, v.get("prices"))
    if v.get("mode") != "final":
        return {"lines": lines, "total_cents": sum(l["qty"] * l["unit_cents"] for l in lines), "confirmed_at": job.extras_confirmed_at}
    plan = planned_repairs(job)
    final_cents = sum(l["qty"] * l["unit_cents"] for l in lines)
    agreed = {l["key"]: l["unit_cents"] for l in plan["lines"]}
    below = [l["name"] for l in lines if l["unit_cents"] < agreed.get(l["key"], list_cents(l["key"], pt, po))]
    out = list(lines)
    if plan["total_cents"]:
        out.append({"name": "Repairs agreed before (already in your price)", "qty": 1, "unit_cents": -plan["total_cents"], "key": "plan"})
    return {"lines": out, "total_cents": final_cents - plan["total_cents"], "confirmed_at": job.extras_confirmed_at,
            "final": True, "final_cents": final_cents, "planned_cents": plan["total_cents"], "below": below}


def sqft_per_gallon(db, job) -> float:
    """175 when the stain they went with is a solid, else 165."""
    if not (job.final_stain_id or ""):
        return SQFT_PER_GALLON
    from database import StainInventoryItem
    item = db.query(StainInventoryItem).filter(StainInventoryItem.id == job.final_stain_id).first()
    return SQFT_PER_GALLON_SOLID if item and (item.finish_type or "") == "solid" else SQFT_PER_GALLON


# --- pressure washing ---
#
# A third kind of crew job (Alan, 2026-10-19: Brent does one tomorrow
# morning). No fence scope, stain or sides: the office ticks which services
# the customer bought, and the crew photographs each one before and after.
# Keys are stable: photo sections are named after them.
PW_TASK = "pressure_washing"
# Repairs (Alan, 2026-10-26): a crew day for fixing the fence before the
# stain, e.g. Jose and Alfredo replacing Chris Harrell's pickets on Tuesday
# and staining on Wednesday.
REPAIR_TASK = "repairs"
CREW_TASKS: tuple[str, ...] = ("cleaning", "staining", PW_TASK, REPAIR_TASK)
FENCE_TASKS: tuple[str, ...] = ("cleaning", "staining", REPAIR_TASK)

PW_SERVICES: list[dict] = [
    {"key": "house_wash", "label": "House wash"},
    {"key": "windows", "label": "Window cleaning"},
    {"key": "pool_deck", "label": "Pool deck"},
    {"key": "driveway", "label": "Driveway & sidewalks"},
    {"key": "patio", "label": "Patio"},
    {"key": "gutters", "label": "Gutters"},
    {"key": "roof", "label": "Roof"},
    {"key": "fence", "label": "Fence wash"},
]
PW_SERVICE_KEYS: tuple[str, ...] = tuple(s["key"] for s in PW_SERVICES)
PW_SERVICE_LABELS: dict[str, str] = {s["key"]: s["label"] for s in PW_SERVICES}


# A service the office typed in (Alan, 2026-10-21: "Back patio" isn't on the
# list): keyed x_<slug>, its label kept on the job in pw_custom_json.
CUSTOM_PW_RE = re.compile(r"^x_[a-z0-9]+(?:_[a-z0-9]+)*$")
PW_CUSTOM_SECTION_RE = re.compile(r"^pw_(x_[a-z0-9]+(?:_[a-z0-9]+)*)_(before|after)$")


def pw_custom_key(label: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", (label or "").strip().lower()).strip("_")[:40]
    return f"x_{slug}" if slug else ""


def normalize_pw_services(raw) -> list[str]:
    """Known service keys in the list's own order (so the crew always sees
    them the same way round), then any typed ones in the order given; no
    repeats, nothing made up."""
    want = [str(x or "").strip() for x in (raw or []) if isinstance(x, str)]
    known = [k for k in PW_SERVICE_KEYS if k in want]
    custom: list[str] = []
    for k in want:
        if CUSTOM_PW_RE.match(k) and k not in custom:
            custom.append(k)
    return known + custom


def _job_map(job, attr: str) -> dict[str, str]:
    try:
        v = json.loads((getattr(job, attr, None) if job else None) or "{}")
    except (ValueError, TypeError):
        v = {}
    return {str(k): str(x) for k, x in v.items() if isinstance(x, str) and x} if isinstance(v, dict) else {}


def pw_services_of(job) -> list[str]:
    """The services picked on a job, never an exception."""
    try:
        v = json.loads((getattr(job, "pw_services_json", None) if job else None) or "[]")
    except (ValueError, TypeError):
        v = []
    return normalize_pw_services(v if isinstance(v, list) else [])


def pw_custom_of(job) -> dict[str, str]:
    """Typed services on the job: key → label."""
    return {k: v for k, v in _job_map(job, "pw_custom_json").items() if CUSTOM_PW_RE.match(k)}


def pw_notes_of(job) -> dict[str, str]:
    """The office's note per service, for the crew: key → note."""
    return _job_map(job, "pw_notes_json")


def pw_label(key: str, custom: dict[str, str] | None = None) -> str:
    return PW_SERVICE_LABELS.get(key) or (custom or {}).get(key) or key[2:].replace("_", " ").capitalize()


def set_pw_items(job, items) -> list[str]:
    """The office's list of what's being washed, in one go:
    [{key?, label, note?}]. A known key or label is that service; anything
    else is a typed one. Returns the service keys now on the job."""
    label_to_key = {v.lower(): k for k, v in PW_SERVICE_LABELS.items()}
    services: list[str] = []
    custom: dict[str, str] = {}
    notes: dict[str, str] = {}
    for it in items or []:
        if not isinstance(it, dict):
            continue
        key = str(it.get("key") or "").strip()
        label = str(it.get("label") or "").strip()[:60]
        note = str(it.get("note") or "").strip()[:300]
        if key not in PW_SERVICE_KEYS and not CUSTOM_PW_RE.match(key):
            key = label_to_key.get(label.lower(), "") or pw_custom_key(label)
        if not key:
            continue
        if key not in services:
            services.append(key)
        if key.startswith("x_") and label:
            custom[key] = label
        if note:
            notes[key] = note
    job.pw_services_json = json.dumps(normalize_pw_services(services))
    job.pw_custom_json = json.dumps(custom)
    job.pw_notes_json = json.dumps(notes)
    return pw_services_of(job)


def pw_section_key(service: str, phase: str) -> str:
    return f"pw_{service}_{phase}"


PW_SECTION_KEYS: tuple[str, ...] = tuple(
    pw_section_key(s, phase) for s in PW_SERVICE_KEYS for phase in ("before", "after")
)


def pw_sections(services: list[str], custom: dict[str, str] | None = None,
                notes: dict[str, str] | None = None) -> list[dict]:
    """Two photo sections per picked service, the same shape as SECTIONS so
    the screen's photo section handles them unchanged. Before: every side,
    and anything already damaged marked as damage, so nobody blames us for
    it later. The office's note on a service rides on both its sections."""
    out: list[dict] = []
    for key in normalize_pw_services(services):
        label = pw_label(key, custom)
        note = (notes or {}).get(key, "")
        out.append({
            "key": pw_section_key(key, "before"),
            "label": f"{label} · Before",
            "who": "Before you start",
            "hint": "Every side before you start; mark anything already damaged.",
            "wants_damage": True,
            "service": key,
            "phase": "before",
            "note": note,
        })
        out.append({
            "key": pw_section_key(key, "after"),
            "label": f"{label} · After",
            "who": "When it's done",
            "hint": "Same spots after, every side.",
            "wants_damage": True,
            "service": key,
            "phase": "after",
            "note": note,
        })
    return out


def job_pw_sections(job) -> list[dict]:
    """This job's washing sections, typed services and notes included."""
    return pw_sections(pw_services_of(job), pw_custom_of(job), pw_notes_of(job))


def valid_section(key: str) -> bool:
    """A fence section, or a before/after section of a known washing service."""
    return key in SECTION_KEYS or key in PW_SECTION_KEYS or bool(PW_CUSTOM_SECTION_RE.match(key))


def is_pw_job(job, entries: list[dict]) -> bool:
    """A pure pressure-washing job: washing on it (a crew day or services
    picked) and no cleaning or staining days."""
    tasks = {e.get("task") for e in entries}
    if tasks & set(FENCE_TASKS):
        return False
    return PW_TASK in tasks or bool(pw_services_of(job))


# How the crew finished a washing job (Alan, 2026-10-19): the customer was
# home and is happy, or wasn't and got a call and photos of everything. A
# comeback isn't paid extra, so this is checked before they drive away.
PW_FINISH_CHOICES: list[dict] = [
    {"key": "home_happy", "label": "Customer is home: I checked with them and they're happy"},
    {"key": "called_sent_photos", "label": "Customer isn't home: I called them and sent photos of everything"},
]
PW_FINISH_KEYS: tuple[str, ...] = tuple(c["key"] for c in PW_FINISH_CHOICES)


def pw_progress(services: list[str], sections_with_photos: set[str]) -> tuple[int, int]:
    """(services with both before and after photos, services picked)."""
    picked = normalize_pw_services(services)
    done = sum(1 for s in picked
               if pw_section_key(s, "before") in sections_with_photos
               and pw_section_key(s, "after") in sections_with_photos)
    return done, len(picked)
