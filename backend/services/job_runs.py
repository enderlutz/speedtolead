"""Per-run, per-face measurements on a confirmed job (Alan, 2026-11-23).

Only for a job that is already confirmed (the customer booked). It documents
the exact work for the crew; it never touches lead intake, the estimator,
pricing or booking.

A run is one physical stretch of fence, traced once:
    {"id", "label", "group", "length_ft", "height_ft", "gate_in_length",
     "faces": {"inside": {"state", "stain_id"}, "outside": {...}}}

Each face is one of:
    "coat"     gets coated with the stain `stain_id` (a Stain Inventory row)
    "pending"  gets coated, but the product / finish / colour isn't picked yet
    "skip"     not coated

Both faces coated = the same measured area counted once per face; nobody
draws the run twice. A gate already inside the run's length is never added
again (`gate_in_length` is a note for the crew, not extra feet).

Nothing here guesses. A missing length or height, a pending finish or a stain
with no coverage rate shows up in `missing`, that material gets no gallons,
and the list isn't `ready` to load.
"""
from __future__ import annotations

import uuid

from services.company_cam import FINISH_LABELS, gallons_for, per_gallon_for_finish, stain_label

FACES = ("inside", "outside")
FACE_STATES = ("coat", "pending", "skip")
GROUPS = ("Front", "Back", "Left", "Right", "Other")
MAX_RUNS = 40


def _num(v) -> float:
    try:
        f = float(v or 0)
    except (TypeError, ValueError):
        return 0.0
    return f if f > 0 and f < 100000 else 0.0


def _text(v, n: int = 60) -> str:
    return str(v or "").strip()[:n]


def normalize_runs(raw) -> list[dict]:
    """Clean what the screen sent. Unknown states become "pending" (it gets
    coated, finish unknown) rather than silently dropping work; a "coat"
    with no stain is pending too."""
    out: list[dict] = []
    for r in (raw or [])[:MAX_RUNS]:
        if not isinstance(r, dict):
            continue
        faces_in = r.get("faces") if isinstance(r.get("faces"), dict) else {}
        faces: dict[str, dict] = {}
        for f in FACES:
            fv = faces_in.get(f) if isinstance(faces_in.get(f), dict) else {}
            state = fv.get("state") if fv.get("state") in FACE_STATES else "skip" if not fv else "pending"
            stain_id = _text(fv.get("stain_id"), 64)
            if state == "coat" and not stain_id:
                state = "pending"
            faces[f] = {"state": state, "stain_id": stain_id if state == "coat" else ""}
        group = r.get("group") if r.get("group") in GROUPS else "Other"
        out.append({
            "id": _text(r.get("id"), 40) or uuid.uuid4().hex[:10],
            "label": _text(r.get("label")) or group,
            "group": group,
            "length_ft": round(_num(r.get("length_ft")), 1),
            "height_ft": round(_num(r.get("height_ft")), 2),
            "gate_in_length": bool(r.get("gate_in_length")),
            "faces": faces,
        })
    return out


def measurements_of(runs: list[dict]) -> list[tuple]:
    """(id, length, height) per run: what verifying the measurements covers."""
    return [(r["id"], r["length_ft"], r["height_ft"]) for r in runs]


def finishes_of(runs: list[dict]) -> list[tuple]:
    """(id, face, state, stain) per face: what confirming the finish covers."""
    return [(r["id"], f, r["faces"][f]["state"], r["faces"][f]["stain_id"]) for r in runs for f in FACES]


def summarize(runs: list[dict], stains: dict[str, dict]) -> dict:
    """What the crew card shows.

    `stains` maps a Stain Inventory id to {"label", "finish_type"}.

    Returns the coated square feet, one material line per product/finish/
    colour (sq ft, gallons when the rate is known, the faces it goes on), the
    pending area, and every missing input in plain words."""
    missing: list[str] = []
    materials: dict[str, dict] = {}
    pending = {"sqft": 0.0, "faces": []}
    total = 0.0
    measured_all = True
    for r in runs:
        name = r["label"]
        area = r["length_ft"] * r["height_ft"]
        coated = [f for f in FACES if r["faces"][f]["state"] != "skip"]
        if not coated:
            continue
        if not r["length_ft"] or not r["height_ft"]:
            measured_all = False
            what = " and ".join(w for w, v in (("length", r["length_ft"]), ("height", r["height_ft"])) if not v)
            missing.append(f"{name}: no {what}")
        for f in coated:
            face = r["faces"][f]
            where = f"{name} · {f}"
            total += area
            if face["state"] == "pending":
                pending["sqft"] += area
                pending["faces"].append(where)
                missing.append(f"{where}: finish not picked")
                continue
            sid = face["stain_id"]
            st = stains.get(sid)
            m = materials.setdefault(sid, {
                "stain_id": sid,
                "label": (st or {}).get("label") or "Unknown stain",
                "finish_type": (st or {}).get("finish_type") or "",
                "sqft": 0.0, "faces": [], "unmeasured": False,
            })
            m["sqft"] += area
            m["faces"].append(where)
            if not area:
                m["unmeasured"] = True
    lines = []
    for m in materials.values():
        rate = per_gallon_for_finish(m["finish_type"]) if m["label"] != "Unknown stain" else None
        if m["label"] == "Unknown stain":
            missing.append("A face uses a stain that's no longer in Stain Inventory")
        elif rate is None:
            missing.append(f"{m['label']}: no coverage rate for this finish")
        ok = rate is not None and not m["unmeasured"]
        lines.append({
            "stain_id": m["stain_id"], "label": m["label"],
            "finish": FINISH_LABELS.get(m["finish_type"], m["finish_type"]),
            "sqft": round(m["sqft"]),
            "sqft_per_gallon": rate,
            "gallons": gallons_for(m["sqft"], rate) if ok else None,
            "faces": m["faces"],
        })
    lines.sort(key=lambda l: -l["sqft"])
    if not runs:
        missing.append("No runs traced yet")
    ready = bool(runs) and not missing
    return {
        "total_sqft": round(total),
        "measured": bool(runs) and measured_all,
        "materials": lines,
        "pending": {"sqft": round(pending["sqft"]), "faces": pending["faces"]},
        "missing": missing,
        "ready": ready,
        "gallons_total": round(sum(l["gallons"] for l in lines), 2) if ready else None,
    }


def stain_lookup(db) -> dict[str, dict]:
    from database import StainInventoryItem
    try:
        rows = db.query(StainInventoryItem).all()
    except Exception:  # noqa: BLE001 — a missing table must not break the crew screen
        return {}
    return {r.id: {"label": stain_label(r), "finish_type": r.finish_type or ""} for r in rows}


def apply_side_changes(runs: list[dict], before: list[str], now: list[str]) -> list[dict]:
    """The scope's fence sides changed (Alan, 2026-11-23: measure each side
    once, then the estimator's sides double it or take it away). A side face
    added ("Outside Front") gets coated on every run of that side, finish not
    picked yet; a side face taken away stops being coated. Faces whose side
    didn't change keep whatever the office set, so a one-off (only two short
    front pieces outside) survives until that side itself is toggled."""
    added, removed = set(now) - set(before), set(before) - set(now)
    if not added and not removed:
        return runs
    out = []
    for r in runs:
        r = {**r, "faces": {f: dict(v) for f, v in r["faces"].items()}}
        for f in FACES:
            key = f"{f.title()} {r['group']}"
            if key in added and r["faces"][f]["state"] == "skip":
                r["faces"][f] = {"state": "pending", "stain_id": ""}
            elif key in removed and r["faces"][f]["state"] != "skip":
                r["faces"][f] = {"state": "skip", "stain_id": ""}
        out.append(r)
    return out
