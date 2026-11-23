"""Per-run, per-face measurements on a confirmed job.

Part of the confirmed-job measurement step on the job page. Not part of lead
intake, estimating, quoting or booking. It is never needed to confirm or book
a job, and it never changes the estimate or its price.

Why: one total (278 ft x 7 ft = 1,946 sq ft at Carlos Garcia's) can't say
that the front and left runs get October Brown Solid inside and clear
outside while the back and right get the solid inside only. So the stain
order for each product came from a single gallon figure (10 gal) that is
right for neither product by itself.

The model:
  * Each physical fence run is traced ONCE: a label ("Front left gate/run"),
    its length and its height. Two runs can share a group ("Front") and still
    keep their own measurement. A gate already inside the run's length is
    marked `includes_gate` so nobody adds it again.
  * Each run has two faces, inside and outside. Each face is one of:
      - "coat": gets coated, with the exact product (a Stain Inventory row:
        brand + finish + color) in `stain_id`
      - "pending": gets coated, but the finish or color isn't picked yet
      - "excluded": not coated
    A run coated on both faces counts its area once for each face, with no
    second line drawn.
  * Gallons use the same per-product coverage rule as the rest of the job
    page (services/company_cam.py: a solid covers 175 sq ft a gallon, the
    other finishes 165) and the same round-up to the half gallon. A product
    with no finish type on file has no coverage rate, and its gallons are
    left blank rather than guessed.

Nothing here touches CompanyCamJob.sqft or gallons_needed. Jobs with only a
single total (no runs) keep working exactly as before.
"""
from __future__ import annotations

import json
import uuid

from services.company_cam import (
    FINISH_LABELS,
    SQFT_PER_GALLON,
    SQFT_PER_GALLON_SOLID,
    gallons_for,
    stain_label,
)

FACES = ("inside", "outside")
FACE_STATES = ("coat", "pending", "excluded")
FACE_LABELS = {"inside": "inside", "outside": "outside"}
# The finish types the existing coverage rule knows. Anything else, or a blank
# finish type, has no coverage rate on file.
_KNOWN_FINISHES = set(FINISH_LABELS) - {"bleach"}


def _num(v) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    return f if f > 0 else 0.0


def _face(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    state = raw.get("state") if raw.get("state") in FACE_STATES else "pending"
    stain_id = str(raw.get("stain_id") or "").strip() if state == "coat" else ""
    return {"state": state, "stain_id": stain_id}


def normalize_runs(raw) -> list[dict]:
    """Clean a list of runs from the screen. Unknown keys are dropped."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "[]")
        except (ValueError, TypeError):
            raw = []
    out = []
    for r in raw if isinstance(raw, list) else []:
        if not isinstance(r, dict):
            continue
        faces = r.get("faces") if isinstance(r.get("faces"), dict) else {}
        out.append({
            "id": str(r.get("id") or "").strip()[:64] or uuid.uuid4().hex[:12],
            "label": str(r.get("label") or "").strip()[:80],
            "group": str(r.get("group") or "").strip()[:40],
            "length_ft": round(_num(r.get("length_ft")), 1),
            "height_ft": round(_num(r.get("height_ft")), 1),
            "includes_gate": bool(r.get("includes_gate")),
            "faces": {f: _face(faces.get(f)) for f in FACES},
        })
    return out


def runs_of(job) -> list[dict]:
    return normalize_runs(getattr(job, "runs_json", "") or "[]")


def _geometry(runs: list[dict]) -> list:
    """What 'measurements verified' vouches for: lengths, heights, and which
    faces get coated. Picking a color doesn't change it."""
    return [(r["id"], r["length_ft"], r["height_ft"], r["includes_gate"],
             tuple(r["faces"][f]["state"] != "excluded" for f in FACES)) for r in runs]


def _finishes(runs: list[dict]) -> list:
    """What 'finish confirmed' vouches for: the state and product of each face."""
    return [(r["id"], tuple((r["faces"][f]["state"], r["faces"][f]["stain_id"]) for f in FACES)) for r in runs]


def geometry_changed(before: list[dict], after: list[dict]) -> bool:
    return _geometry(before) != _geometry(after)


def finishes_changed(before: list[dict], after: list[dict]) -> bool:
    return _finishes(before) != _finishes(after)


def coverage_rate(item) -> float | None:
    """Sq ft a gallon for one product, by the job page's existing rule
    (services/company_cam.sqft_per_gallon): solid 175, other finishes 165.
    None when the product's finish type isn't on file."""
    if item is None:
        return None
    finish = (getattr(item, "finish_type", "") or "").strip()
    if finish == "solid":
        return SQFT_PER_GALLON_SOLID
    if finish in _KNOWN_FINISHES:
        return SQFT_PER_GALLON
    return None


def run_name(r: dict, i: int) -> str:
    return r["label"] or f"Run {i + 1}"


def measurement_problems(runs: list[dict]) -> list[str]:
    """What stops the measurements from being complete."""
    out = []
    if not runs:
        return ["No fence runs traced yet."]
    for i, r in enumerate(runs):
        name = run_name(r, i)
        if not r["length_ft"]:
            out.append(f"{name}: length missing.")
        if not r["height_ft"]:
            out.append(f"{name}: height missing.")
    return out


def finish_problems(runs: list[dict], items: dict) -> list[str]:
    """What stops every finish from being picked."""
    out = []
    for i, r in enumerate(runs):
        name = run_name(r, i)
        for f in FACES:
            face = r["faces"][f]
            if face["state"] == "pending":
                out.append(f"{name} {FACE_LABELS[f]}: finish pending.")
            elif face["state"] == "coat" and not face["stain_id"]:
                out.append(f"{name} {FACE_LABELS[f]}: product not picked.")
            elif face["state"] == "coat" and face["stain_id"] not in items:
                out.append(f"{name} {FACE_LABELS[f]}: product no longer in the stain inventory.")
    return out


def materials(job, items: dict) -> dict:
    """The crew card's material list.

    `items` maps Stain Inventory id -> row. Returns the total coated sq ft
    (each coated face of a run counts its length x height once), one line per
    product/finish/color with its sq ft, gallons and faces, what's missing,
    and whether the list is ready to load.
    """
    runs = runs_of(job)
    verified_at = getattr(job, "runs_verified_at", "") or ""
    confirmed_at = getattr(job, "finishes_confirmed_at", "") or ""
    if not runs:
        return {"has_runs": False, "runs": [], "total_sqft": None, "lines": [], "pending": [],
                "missing": [], "ready": False,
                "measurements_verified": False, "finishes_confirmed": False}

    lines: dict[str, dict] = {}
    pending = []
    total = 0.0
    total_known = True
    for i, r in enumerate(runs):
        name = run_name(r, i)
        area = r["length_ft"] * r["height_ft"] if r["length_ft"] and r["height_ft"] else None
        for f in FACES:
            face = r["faces"][f]
            if face["state"] == "excluded":
                continue
            where = f"{name} {FACE_LABELS[f]}"
            if area is None:
                total_known = False
            else:
                total += area
            if face["state"] == "pending" or not face["stain_id"]:
                pending.append({"face": where, "sqft": round(area) if area is not None else None})
                continue
            key = face["stain_id"]
            item = items.get(key)
            line = lines.setdefault(key, {
                "stain_id": key,
                "label": stain_label(item) if item is not None else "Unknown product",
                "color_name": (getattr(item, "color_name", "") or "") if item is not None else "",
                "brand": (getattr(item, "brand", "") or "") if item is not None else "",
                "finish_type": (getattr(item, "finish_type", "") or "") if item is not None else "",
                "in_inventory": item is not None,
                "faces": [], "sqft": 0.0, "sqft_known": True,
                "sqft_per_gallon": coverage_rate(item), "gallons": None, "missing": [],
            })
            line["faces"].append(where)
            if area is None:
                line["sqft_known"] = False
            else:
                line["sqft"] += area

    out_lines = []
    for line in lines.values():
        if not line["in_inventory"]:
            line["missing"].append("Product isn't in the stain inventory.")
        elif line["sqft_per_gallon"] is None:
            line["missing"].append("No coverage rate: the product has no finish type on file.")
        if not line["sqft_known"]:
            line["missing"].append("A length or height is missing on one of its runs.")
        line["sqft"] = round(line["sqft"]) if line["sqft_known"] else None
        if not line["missing"]:
            line["gallons"] = gallons_for(line["sqft"], line["sqft_per_gallon"])
        del line["sqft_known"]
        out_lines.append(line)
    out_lines.sort(key=lambda x: (-(x["sqft"] or 0), x["label"].lower()))

    missing = measurement_problems(runs) + finish_problems(runs, items)
    for line in out_lines:
        if line["sqft_per_gallon"] is None and line["in_inventory"]:
            missing.append(f"{line['label']}: no coverage rate on file.")
    if not verified_at:
        missing.append("Measurements not verified on site yet.")
    if not confirmed_at:
        missing.append("Finishes not confirmed yet.")
    ready = not missing and bool(out_lines)
    return {
        "has_runs": True,
        "runs": runs,
        "total_sqft": round(total) if total_known else None,
        "lines": out_lines,
        "pending": pending,
        "missing": missing,
        "ready": ready,
        "measurements_verified": bool(verified_at),
        "finishes_confirmed": bool(confirmed_at),
    }


def inventory_items(db, runs: list[dict]) -> dict:
    """The Stain Inventory rows these runs name, by id."""
    from database import StainInventoryItem

    ids = {r["faces"][f]["stain_id"] for r in runs for f in FACES if r["faces"][f]["stain_id"]}
    if not ids:
        return {}
    return {i.id: i for i in db.query(StainInventoryItem).filter(StainInventoryItem.id.in_(list(ids))).all()}


def job_confirmed(db, lead) -> bool:
    """A job the customer has committed to, so the crew is being prepared:
    the estimate was closed, the deposit was paid or waived, a pay link was
    paid, or QuickBooks shows a payment. Same signals the booking page
    (confirmed = paid) and the Booked card use."""
    if (getattr(lead, "status", "") or "") == "closed":
        return True
    if (getattr(lead, "deposit_status", "") or "") in ("paid", "waived"):
        return True
    from database import PayLink, QuickbooksInvoice
    if db.query(PayLink).filter(PayLink.lead_id == lead.id, PayLink.status == "paid").first():
        return True
    if (db.query(QuickbooksInvoice)
            .filter(QuickbooksInvoice.lead_id == lead.id, QuickbooksInvoice.amount_paid > 0,
                    QuickbooksInvoice.status != "void").first()):
        return True
    return False
