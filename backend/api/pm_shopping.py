"""What to buy (Alan, 2026-10-26): "every single morning we'll have to stop
by Lowe's and buy stain… an hour times two workers." One list for the coming
days: each customer with a staining or repairs day, the stain they need
(gallons, less what's already on the shelf) and the repair materials, each
with a box to tick once it's bought or set aside. Buy it the day before, not
on the clock with two workers waiting.

Stain on the shelf is shared out in date order, so two jobs in the same
colour don't both count the same five gallons. No prices in this module.
"""
import json
import math
import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.company_cam import _repairs
from api.pm_calendar import _office, _rows, _today_ct
from database import Booking, CompanyCamJob, StainInventoryItem, SystemConfig, get_db
from services.company_cam import SQFT_PER_GALLON, SQFT_PER_GALLON_SOLID, gallons_for, stain_label

router = APIRouter()

HAVE_KEY = "pm_hq_shopping_have"
BUY_TASKS = ("staining", "repairs")
POST_FT = {"post6": 6, "post7": 7, "post8": 8}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _have(db) -> dict:
    try:
        v = json.loads(SystemConfig.get(db, HAVE_KEY, "{}") or "{}")
    except (ValueError, TypeError):
        v = {}
    return v if isinstance(v, dict) else {}


def _estimate_inputs(db, lead_id: str) -> dict:
    """The sold estimate's inputs (closed), else the last one sent."""
    from database import Estimate
    for status in ("closed", "sent"):
        est = (db.query(Estimate).filter(Estimate.lead_id == lead_id, Estimate.status == status)
               .order_by(Estimate.created_at.desc()).first())
        if est:
            try:
                v = json.loads(est.inputs or "{}") or {}
                return v if isinstance(v, dict) else {}
            except (ValueError, TypeError):
                return {}
    return {}


def _feet(v) -> float:
    try:
        return float(re.sub(r"[^0-9.]", "", str(v or "")) or 0)
    except ValueError:
        return 0.0


def _sqft(job: CompanyCamJob, inputs: dict) -> float:
    if float(job.sqft or 0) > 0:
        return float(job.sqft)
    s = _feet(inputs.get("_sqft"))
    return s or _feet(inputs.get("linear_feet")) * _feet(inputs.get("fence_height"))


def _height(job: CompanyCamJob, inputs: dict, post_type: str) -> int:
    """The post size set on the job (the office or crew picked it), else the
    estimate's fence height, else 6 ft."""
    for raw in (job.extras_json, job.repairs_json):
        try:
            v = json.loads(raw or "{}") or {}
        except (ValueError, TypeError):
            v = {}
        if isinstance(v, dict) and v.get("post_type") in POST_FT:
            return POST_FT[v["post_type"]]
    n = int(_feet(inputs.get("fence_height")))
    return n if 4 <= n <= 10 else POST_FT.get(post_type, 6)


def repair_counts(job: CompanyCamJob) -> tuple[dict, str, str, bool]:
    """(counts, picket type, post type, confirmed). A final count from the
    fence replaces the phone plan; add-on extras go on top of it."""
    plan = _repairs(job)
    extra = _repairs(job, job.extras_json or "")
    confirmed = bool(job.extras_confirmed_at)
    if extra["mode"] == "final" and any(extra["counts"].values()):
        return extra["counts"], extra["picket_type"], extra["post_type"], confirmed
    counts = {k: plan["counts"].get(k, 0) + extra["counts"].get(k, 0) for k in plan["counts"]}
    src = extra if any(extra["counts"].values()) else plan
    return counts, src["picket_type"], src["post_type"], confirmed


def material_lines(counts: dict, picket_type: str, height: int, picket_ft: float = 0) -> list[dict]:
    """What the store sells, for the repairs on one job. The picket length is
    what the cleaner measured on site when there is one; the fence height
    otherwise (and the line says so, because that's how the crew turned up
    with 6 ft pickets for an 8 ft fence)."""
    wood = "cedar" if picket_type == "cedar" else "pine (treated)"
    pf = f"{picket_ft:g}" if picket_ft else str(height)
    items = [
        ("pickets", counts.get("pickets", 0), f"{wood} pickets, {pf} ft"),
        ("rail", counts.get("rail", 0), "treated 2x4 rails, 8 ft"),
        ("rotboard", counts.get("rotboard", 0), "rot boards (treated 2x6)"),
        ("cap", counts.get("cap", 0), "cap boards (top trim)"),
        ("posts", counts.get("posts", 0), f"treated 4x4 posts, {height + 2} ft"),
        ("concrete", counts.get("posts", 0) * 2, "bags fast-setting concrete"),
    ]
    out = [{"key": k, "qty": q, "item": it, "label": f"{q} {it}"} for k, q, it in items if q]
    if out:
        out.append({"key": "screws", "qty": 0, "item": "Exterior screws", "label": "Exterior screws"})
    return out


def _stain_choice(db, job: CompanyCamJob, booking_color: str) -> dict:
    """The colour to buy, or the ones still in play."""
    plan = []
    try:
        plan = json.loads(job.color_plan_json or "[]") or []
    except (ValueError, TypeError):
        pass
    color = (job.final_color or job.color or "").strip()
    if color and (job.color_confirmed or any(r.get("status") == "confirmed" for r in plan if isinstance(r, dict))):
        return {"color": color, "picked": True}
    choosing = [c for r in plan if isinstance(r, dict) for c in (r.get("colors") or [])]
    if choosing:
        return {"color": "", "picked": False, "choices": choosing}
    if color:
        return {"color": color, "picked": True}
    if booking_color:
        return {"color": booking_color, "picked": True}
    return {"color": "", "picked": False, "choices": []}


def _shelf_match(items: list, color: str):
    """The shelf row for a colour label ("Darkest Night · Valspar · Solid"),
    matching the brand and finish when the label has them."""
    parts = [p.strip() for p in color.split("·")]
    name = _norm(parts[0])
    brand = _norm(parts[1]) if len(parts) > 1 else ""
    finish = _norm(parts[2]) if len(parts) > 2 else ""
    best = None
    for it in items:
        if _norm(it.color_name) != name:
            continue
        if brand and _norm(it.brand) != brand:
            continue
        if finish and finish not in _norm(stain_label(it)):
            continue
        if best is None or (it.gallons or 0) > (best.gallons or 0):
            best = it
    return best


def shopping(db, start: str, end: str) -> list[dict]:
    rows = [r for r in _rows(db, start, end) if r["task"] in BUY_TASKS]
    first: dict[str, dict] = {}
    for r in rows:
        f = first.setdefault(r["lead_id"], {"name": r["name"], "address": r["address"], "days": {}})
        f["days"].setdefault((r["date"], r["task"]), []).append(r["person"])
    if not first:
        return []
    jobs = {j.lead_id: j for j in db.query(CompanyCamJob).filter(CompanyCamJob.lead_id.in_(list(first))).all()}
    bookings = {b.lead_id: b for b in db.query(Booking).filter(Booking.lead_id.in_(list(first)), Booking.status == "held").all()}
    shelf = db.query(StainInventoryItem).filter(StainInventoryItem.active.is_(True)).all()
    left = {it.id: float(it.gallons or 0) for it in shelf}
    have = _have(db)
    out = []
    order = sorted(first, key=lambda lid: (min(d for d, _ in first[lid]["days"]), first[lid]["name"].lower()))
    for lid in order:
        f, job = first[lid], jobs.get(lid)
        if not job or job.completed_at:
            continue
        days = [{"date": d, "task": t, "people": sorted(set(p))} for (d, t), p in sorted(f["days"].items())]
        stain_day = next((d["date"] for d in days if d["task"] == "staining"), "")
        repair_day = next((d["date"] for d in days if d["task"] == "repairs"), "")
        mine = have.get(lid, {})
        inputs = _estimate_inputs(db, lid)
        lines = []
        if stain_day:
            pick = _stain_choice(db, job, (bookings[lid].color if lid in bookings else "") or "")
            sqft = _sqft(job, inputs)
            item = _shelf_match(shelf, pick["color"]) if pick["color"] else None
            solid = "solid" in _norm(pick["color"]) or (item is not None and item.finish_type == "solid")
            need = float(job.gallons_needed or 0) or gallons_for(sqft, SQFT_PER_GALLON_SOLID if solid else SQFT_PER_GALLON)
            on_shelf = 0.0
            if item is not None and need:
                on_shelf = min(left.get(item.id, 0.0), need)
                left[item.id] = left.get(item.id, 0.0) - on_shelf
            buy = max(0, math.ceil(need - on_shelf)) if need and pick["picked"] else 0
            if not pick["picked"]:
                label = "Stain: color not picked yet" + (f" ({' or '.join(c.split(' · ')[0] for c in pick['choices'])})" if pick.get("choices") else "")
                label += f", about {need:g} gal" if need else ""
            else:
                label = f"{pick['color']}: {need:g} gal" if need else f"{pick['color']}: gallons unknown (no footage on the job)"
            lines.append({
                "key": "stain", "label": label, "need_by": stain_day, "blocked": not pick["picked"],
                "gallons": need, "on_shelf": round(on_shelf, 2), "buy_gallons": buy,
                "color": pick["color"],
                "note": ("Pick the color now so the stain is bought ahead, not the morning of" if not pick["picked"] else
                         f"{on_shelf:g} gal on the shelf, buy {buy} gal" if on_shelf and buy else
                         f"All {need:g} gal on the shelf" if need and not buy else
                         f"None on the shelf, buy {buy} gal" if buy else ""),
            })
        counts, ptype, post, confirmed = repair_counts(job)
        pf = float(getattr(job, "picket_length_ft", 0) or 0)
        mats = material_lines(counts, ptype, _height(job, inputs, post), pf) if any(counts.values()) else []
        for m in mats:
            notes = [] if confirmed else ["Count not confirmed with the customer yet"]
            if m["key"] == "pickets" and not pf:
                notes.append("Length not measured by the cleaner yet: this is the fence height from the estimate")
            m.update({"need_by": repair_day or stain_day, "note": ". ".join(notes)})
        lines += mats
        for ln in lines:
            h = mine.get(ln["key"])
            ln["have"] = bool(h) and h.get("label") == ln["label"]
            ln["have_by"] = h.get("by", "") if ln["have"] else ""
        out.append({"lead_id": lid, "name": f["name"], "address": f["address"], "days": days, "lines": lines,
                    "first_day": min(d["date"] for d in days)})
    return out


def week_list(jobs: list[dict]) -> list[dict]:
    """One Lowe's order for everything not ticked yet: stain by colour, wood
    and the rest added up across jobs."""
    stain: dict[str, float] = {}
    mats: dict[str, int] = {}
    screws = False
    for j in jobs:
        for ln in j["lines"]:
            if ln["have"]:
                continue
            if ln["key"] == "stain":
                if ln.get("buy_gallons"):
                    stain[ln["color"]] = stain.get(ln["color"], 0) + ln["buy_gallons"]
            elif ln["key"] == "screws":
                screws = True
            elif ln.get("qty"):
                mats[ln["item"]] = mats.get(ln["item"], 0) + ln["qty"]
    out = [{"kind": "stain", "label": f"{g:g} gal {c}"} for c, g in sorted(stain.items())]
    out += [{"kind": "wood", "label": f"{q} {it}"} for it, q in sorted(mats.items())]
    if screws:
        out.append({"kind": "wood", "label": "Exterior screws"})
    return out


@router.get("/pm-hq/shopping")
def get_shopping(start: str = "", end: str = "", user: dict = Depends(_office)):
    start = (start or _today_ct())[:10]
    end = (end or (datetime.strptime(start, "%Y-%m-%d") + timedelta(days=7)).strftime("%Y-%m-%d"))[:10]
    db = get_db()
    try:
        jobs = shopping(db, start, end)
        return {"start": start, "end": end, "today": _today_ct(), "jobs": jobs, "week_list": week_list(jobs)}
    finally:
        db.close()


class HaveBody(BaseModel):
    lead_id: str
    key: str
    label: str
    have: bool


@router.post("/pm-hq/shopping/have")
def set_have(body: HaveBody, user: dict = Depends(_office)):
    """Tick = bought or set aside. Remembered against the line's words, so
    if the count or colour changes the box comes back unticked."""
    if not body.key or len(body.key) > 40:
        raise HTTPException(400, "Bad item")
    db = get_db()
    try:
        have = _have(db)
        mine = have.setdefault(body.lead_id, {})
        if body.have:
            mine[body.key] = {"label": body.label, "by": user.get("name") or user.get("sub") or "",
                              "at": datetime.now(timezone.utc).isoformat()}
        else:
            mine.pop(body.key, None)
        if not mine:
            have.pop(body.lead_id, None)
        SystemConfig.set(db, HAVE_KEY, json.dumps(have))
        return {"ok": True}
    finally:
        db.close()
