"""Materials: receipts, the 2-week shelf count, prices by store, and what each
job really cost (Alan, 2026-10-19).

    POST   /api/material-purchases               log a receipt (photo required)
    GET    /api/material-purchases?month=        the receipts, newest first
    GET    /api/material-purchases/{id}/receipt  the receipt image
    DELETE /api/material-purchases/{id}          undo a wrong entry (admin)
    GET    /api/material-prices                  $ per gallon by item and store
    POST   /api/stain-inventory/count            the shelf count, every item at once
    GET    /api/job-costing?month=YYYY-MM        gross margin per finished job (admin)

How the money flows:
- A stain or bleach receipt adds its gallons to the shelf and blends its price
  into that item's running average cost per gallon. The receipt keeps its own
  price, so the by-store comparison stays honest.
- "Job done" on Company Cam takes the stain and bleach the crew used off the
  shelf, once, and prices them at the average cost right then
  (`apply_job_materials`). Undoing "Job done" puts them back.
- Shop supplies (tips, tape, tarps) never touch the shelf. Job costing spreads
  the month's supplies receipts evenly across the jobs finished that month.
- The shelf count resets each item to what's really there and records the
  difference, so missing gallons show up as dollars.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from api.auth import get_current_user, require_admin
from api.permissions import require_perm
from database import CompanyCamJob, Lead, MaterialPurchase, StainInventoryItem, StainMovement, get_db

router = APIRouter()
logger = logging.getLogger(__name__)

CATEGORIES = ("stain", "bleach", "supplies")
STORES = ("lowes", "home_depot", "sherwin_williams", "gulf_coast", "other")
STORE_LABELS = {"lowes": "Lowe's", "home_depot": "Home Depot", "sherwin_williams": "Sherwin-Williams",
                "gulf_coast": "Gulf Coast Wood Products", "other": "Other"}
# Card fees on what the customer pays, used only in job costing. QuickBooks
# Payments and Stripe both land near 3% on cards.
CARD_FEE_RATE = 0.03
MAX_RECEIPT_BYTES = 15 * 1024 * 1024


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _actor(user: dict) -> str:
    return (user.get("name") or user.get("sub") or "Unknown").strip()


def _label(item: StainInventoryItem | None) -> str:
    if not item:
        return ""
    from services.company_cam import stain_label
    return stain_label(item)


def _can_log(user: dict = Depends(get_current_user)) -> dict:
    """The office (stain_inventory) logs receipts from the inventory page; the
    crew (company_cam) logs the ones they buy on the way to a job."""
    for key in ("stain_inventory", "company_cam"):
        try:
            return require_perm(key)(user=user)
        except HTTPException:
            continue
    raise HTTPException(status_code=403, detail="Missing permission: stain_inventory")


def _move(db, *, item: StainInventoryItem, delta: float, action: str, actor: str, note: str = "",
          lead_id: str = "", unit_cost: float = 0.0) -> None:
    """Change an item's gallons and write the audit row. The caller commits."""
    before = round(float(item.gallons or 0), 2)
    after = round(before + delta, 2)
    item.gallons = after
    item.updated_at = _now()
    db.add(StainMovement(
        id=str(uuid.uuid4()), stain_id=item.id, action=action,
        previous_gallons=before, delta_gallons=round(delta, 2), resulting_gallons=after,
        actor=actor, note=note.strip(), lead_id=lead_id or "", unit_cost=round(unit_cost, 4),
        created_at=_now(),
    ))


def blend_average(on_hand: float, avg: float, gallons: float, unit: float) -> float:
    """Running average cost per gallon after adding `gallons` at `unit`.
    Nothing (or less than nothing) on the shelf: the new price is the average."""
    if on_hand <= 0 or avg <= 0:
        return unit
    return (on_hand * avg + gallons * unit) / (on_hand + gallons)


def _receipt_bytes(raw: bytes, mime: str) -> tuple[bytes, str]:
    """Shrink a receipt photo to a readable JPEG (and drop its GPS). PDFs are
    kept as they are."""
    if mime == "application/pdf":
        return raw, mime
    from api.fence_photos import _encode, _load_image
    img = _load_image(raw, mime)
    data, _, _ = _encode(img, 1600, 82)
    return data, "image/jpeg"


# ── Receipts ────────────────────────────────────────────────────────────

@router.post("/material-purchases")
async def log_purchase(
    category: str = Form(...),
    store: str = Form(...),
    total_cost: float = Form(...),
    purchased_on: str = Form(...),
    gallons: float = Form(0),
    stain_id: str = Form(""),
    description: str = Form(""),
    lead_id: str = Form(""),
    receipt: UploadFile = File(...),
    user: dict = Depends(_can_log),
):
    if category not in CATEGORIES:
        raise HTTPException(400, "Pick stain, bleach or shop supplies")
    if store not in STORES:
        raise HTTPException(400, "Pick the store")
    if total_cost <= 0:
        raise HTTPException(400, "Enter what the receipt says you paid")
    try:
        datetime.strptime(purchased_on[:10], "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "Pick the day you bought it")
    if category in ("stain", "bleach"):
        if gallons <= 0:
            raise HTTPException(400, "How many gallons?")
        if not stain_id and category == "stain":
            raise HTTPException(400, "Pick which stain")
    raw = await receipt.read()
    if not raw:
        raise HTTPException(400, "Take a picture of the receipt")
    if len(raw) > MAX_RECEIPT_BYTES:
        raise HTTPException(400, "That picture is too big")
    data, mime = _receipt_bytes(raw, (receipt.content_type or "image/jpeg").lower())

    db = get_db()
    try:
        item = None
        if category == "bleach" and not stain_id:
            # The crew just says "bleach": there's one bleach item on the shelf.
            item = _bleach_item(db)
            if not item:
                raise HTTPException(400, "Add bleach to Stain Inventory first")
            stain_id = item.id
        if category in ("stain", "bleach"):
            item = item or db.query(StainInventoryItem).filter(StainInventoryItem.id == stain_id).first()
            if not item:
                raise HTTPException(404, "That item isn't in inventory")
            if (item.finish_type == "bleach") != (category == "bleach"):
                raise HTTPException(400, "That's bleach, not stain" if item.finish_type == "bleach" else "That's a stain, not bleach")
        if lead_id and not db.query(Lead.id).filter(Lead.id == lead_id).first():
            raise HTTPException(404, "Customer not found")
        row = MaterialPurchase(
            id=str(uuid.uuid4()), category=category, stain_id=stain_id if item else "", store=store,
            gallons=round(gallons, 2) if item else 0.0, total_cost=round(total_cost, 2),
            purchased_on=purchased_on[:10], description=description.strip(), lead_id=lead_id or "",
            receipt_data=data, has_receipt=True, receipt_mime=mime,
            created_by=_actor(user), created_at=_now(),
        )
        db.add(row)
        if item:
            unit = total_cost / gallons
            item.avg_cost = round(blend_average(float(item.gallons or 0), float(item.avg_cost or 0), gallons, unit), 4)
            _move(db, item=item, delta=gallons, action="purchased", actor=_actor(user), lead_id=lead_id,
                  unit_cost=unit, note=f"Bought at {STORE_LABELS[store]}: {gallons:g} gal for ${total_cost:,.2f}")
        db.commit()
        return {**row.to_dict(), "item_label": _label(item), "store_label": STORE_LABELS[store],
                "avg_cost": round(float(item.avg_cost or 0), 2) if item else 0.0}
    except HTTPException:
        db.rollback()
        raise
    finally:
        db.close()


@router.get("/material-purchases")
def list_purchases(month: str = Query("", description="YYYY-MM; blank = the last 200"),
                   user: dict = Depends(require_perm("stain_inventory"))):
    del user
    db = get_db()
    try:
        q = db.query(MaterialPurchase)
        if month:
            q = q.filter(MaterialPurchase.purchased_on.like(f"{month[:7]}%"))
        rows = q.order_by(MaterialPurchase.purchased_on.desc(), MaterialPurchase.created_at.desc()).limit(500 if month else 200).all()
        items = {i.id: i for i in db.query(StainInventoryItem).filter(
            StainInventoryItem.id.in_({r.stain_id for r in rows if r.stain_id})).all()} if rows else {}
        names = {l.id: l.contact_name for l in db.query(Lead.id, Lead.contact_name).filter(
            Lead.id.in_({r.lead_id for r in rows if r.lead_id})).all()} if rows else {}
        out = [{**r.to_dict(), "item_label": _label(items.get(r.stain_id)), "store_label": STORE_LABELS.get(r.store, r.store),
                "customer": names.get(r.lead_id, "")} for r in rows]
        return {"purchases": out, "total": round(sum(p["total_cost"] for p in out), 2)}
    finally:
        db.close()


@router.get("/material-purchases/{purchase_id}/receipt")
def get_receipt(purchase_id: str, user: dict = Depends(require_perm("stain_inventory"))):
    del user
    db = get_db()
    try:
        row = db.query(MaterialPurchase).filter(MaterialPurchase.id == purchase_id).first()
        if not row or not row.has_receipt or not row.receipt_data:
            raise HTTPException(404, "No receipt")
        return Response(content=row.receipt_data, media_type=row.receipt_mime or "image/jpeg",
                        headers={"Cache-Control": "private, max-age=86400"})
    finally:
        db.close()


@router.delete("/material-purchases/{purchase_id}")
def delete_purchase(purchase_id: str, user: dict = Depends(require_admin)):
    """Undo a receipt entered by mistake: its gallons come back off the shelf.
    The average cost isn't un-blended; the next purchase or count settles it."""
    db = get_db()
    try:
        row = db.query(MaterialPurchase).filter(MaterialPurchase.id == purchase_id).first()
        if not row:
            raise HTTPException(404, "Not found")
        item = db.query(StainInventoryItem).filter(StainInventoryItem.id == row.stain_id).first() if row.stain_id else None
        if item and row.gallons:
            _move(db, item=item, delta=-float(row.gallons), action="updated", actor=_actor(user), lead_id=row.lead_id,
                  note=f"Receipt from {row.purchased_on} deleted")
        db.delete(row)
        db.commit()
        return {"ok": True}
    finally:
        db.close()


@router.get("/material-prices")
def prices_by_store(user: dict = Depends(require_perm("stain_inventory"))):
    """$ per gallon for each item at each store: the average across receipts,
    the latest one, and how many receipts."""
    del user
    db = get_db()
    try:
        rows = db.query(MaterialPurchase).filter(MaterialPurchase.gallons > 0).order_by(MaterialPurchase.purchased_on).all()
        items = {i.id: i for i in db.query(StainInventoryItem).all()}
        groups: dict[tuple[str, str], list[MaterialPurchase]] = {}
        for r in rows:
            groups.setdefault((r.stain_id, r.store), []).append(r)
        out = []
        for (sid, store), rs in groups.items():
            gal = sum(float(r.gallons or 0) for r in rs)
            cost = sum(float(r.total_cost or 0) for r in rs)
            last = rs[-1]
            out.append({
                "stain_id": sid, "item_label": _label(items.get(sid)) or "(removed item)",
                "store": store, "store_label": STORE_LABELS.get(store, store),
                "receipts": len(rs), "gallons": round(gal, 2),
                "avg_per_gallon": round(cost / gal, 2) if gal else 0.0,
                "last_per_gallon": round(float(last.total_cost or 0) / float(last.gallons), 2),
                "last_date": last.purchased_on or "",
            })
        out.sort(key=lambda x: (x["item_label"].lower(), x["avg_per_gallon"]))
        return {"prices": out}
    finally:
        db.close()


# ── The shelf count ─────────────────────────────────────────────────────

class CountLine(BaseModel):
    id: str
    gallons: float


class CountBody(BaseModel):
    counts: list[CountLine]
    note: str = ""


@router.post("/stain-inventory/count")
def shelf_count(body: CountBody, user: dict = Depends(require_perm("stain_inventory"))):
    """Every 2 weeks (Alan, 2026-10-19): walk the storage unit and type what's
    really there. Each item is reset to the count; the gap from what the books
    said is logged and priced, so it's visible what went missing."""
    if not body.counts:
        raise HTTPException(400, "Nothing counted")
    db = get_db()
    try:
        ids = {c.id for c in body.counts}
        items = {i.id: i for i in db.query(StainInventoryItem).filter(StainInventoryItem.id.in_(ids)).all()}
        lines, value = [], 0.0
        for c in body.counts:
            item = items.get(c.id)
            if not item:
                continue
            if c.gallons < 0:
                raise HTTPException(400, "Gallons can't be negative")
            delta = round(c.gallons - float(item.gallons or 0), 2)
            item.last_counted_at = _now()
            if abs(delta) > 1e-9:
                _move(db, item=item, delta=delta, action="counted", actor=_actor(user), unit_cost=float(item.avg_cost or 0),
                      note=(body.note.strip() or "Shelf count"))
            else:
                item.updated_at = _now()
            gap_value = round(delta * float(item.avg_cost or 0), 2)
            value += gap_value
            if abs(delta) > 1e-9:
                lines.append({"id": item.id, "label": _label(item), "difference": delta, "value": gap_value})
        db.commit()
        return {"counted": len(body.counts), "differences": lines, "difference_value": round(value, 2)}
    finally:
        db.close()


# ── Job materials ───────────────────────────────────────────────────────

def _bleach_item(db) -> StainInventoryItem | None:
    return (db.query(StainInventoryItem)
            .filter(StainInventoryItem.finish_type == "bleach", StainInventoryItem.active.is_(True))
            .order_by(StainInventoryItem.created_at).first())


def apply_job_materials(db, job: CompanyCamJob, actor: str) -> None:
    """Take the job's stain and bleach off the shelf and price them, once.
    Called by "Job done". The caller commits."""
    if job.materials_logged_at:
        return
    who = job.lead_id
    stain_cost = bleach_cost = 0.0
    used = float(job.stain_gallons_used or 0)
    if used > 0 and job.final_stain_id:
        item = db.query(StainInventoryItem).filter(StainInventoryItem.id == job.final_stain_id).first()
        if item:
            unit = float(item.avg_cost or 0)
            stain_cost = used * unit
            _move(db, item=item, delta=-used, action="used", actor=actor, lead_id=who, unit_cost=unit,
                  note="Used on the job")
    bleach = float(job.bleach_gallons_used or 0)
    if bleach > 0:
        item = _bleach_item(db)
        if item:
            unit = float(item.avg_cost or 0)
            bleach_cost = bleach * unit
            _move(db, item=item, delta=-bleach, action="used", actor=actor, lead_id=who, unit_cost=unit,
                  note="Bleach used on the job")
    job.stain_cost = round(stain_cost, 2)
    job.bleach_cost = round(bleach_cost, 2)
    job.materials_logged_at = _now()


def reverse_job_materials(db, job: CompanyCamJob, actor: str) -> None:
    """Put a job's stain and bleach back on the shelf (undo of "Job done", or
    before re-applying after the gallons were corrected). The caller commits."""
    if not job.materials_logged_at:
        return
    moves = (db.query(StainMovement)
             .filter(StainMovement.lead_id == job.lead_id, StainMovement.action == "used").all())
    net: dict[str, tuple[float, float]] = {}
    for m in moves:
        g, _ = net.get(m.stain_id, (0.0, 0.0))
        net[m.stain_id] = (g + float(m.delta_gallons or 0), float(m.unit_cost or 0))
    returned = (db.query(StainMovement)
                .filter(StainMovement.lead_id == job.lead_id, StainMovement.action == "returned").all())
    for m in returned:
        g, u = net.get(m.stain_id, (0.0, 0.0))
        net[m.stain_id] = (g + float(m.delta_gallons or 0), u)
    for sid, (g, unit) in net.items():
        if g < -1e-9:
            item = db.query(StainInventoryItem).filter(StainInventoryItem.id == sid).first()
            if item:
                _move(db, item=item, delta=-g, action="returned", actor=actor, lead_id=job.lead_id, unit_cost=unit,
                      note="Job reopened: put back on the shelf")
    job.stain_cost = 0.0
    job.bleach_cost = 0.0
    job.materials_logged_at = ""


# ── Job costing ─────────────────────────────────────────────────────────

def _crew_cost(job: CompanyCamJob) -> tuple[float, list[str]]:
    """Every flat line on the job added up (pay belongs to a line: a person's
    day and task; an "included" day is part of a flat on another line and
    counts nothing), plus who has an hourly line and so isn't in the number."""
    from api.company_cam import _crew_entries
    flat = 0.0
    hourly: list[str] = []
    for e in _crew_entries(job):
        name = e["username"]
        if e.get("pay_type") == "flat":
            flat += float(e.get("pay") or 0)
        elif e.get("pay_type") != "included" and name not in hourly:
            hourly.append(name)
    return flat, hourly


@router.get("/job-costing")
def job_costing(month: str = Query(..., description="YYYY-MM"), user: dict = Depends(require_admin)):
    """What each finished job made: price − crew − stain − bleach − its share
    of the month's shop supplies − card fees."""
    del user
    m = month[:7]
    db = get_db()
    try:
        jobs = db.query(CompanyCamJob).filter(CompanyCamJob.completed_at.like(f"{m}%")).all()
        supplies = sum(float(p.total_cost or 0) for p in db.query(MaterialPurchase).filter(
            MaterialPurchase.category == "supplies", MaterialPurchase.purchased_on.like(f"{m}%")).all())
        share = supplies / len(jobs) if jobs else 0.0
        names = {l.id: l.contact_name for l in db.query(Lead.id, Lead.contact_name).filter(
            Lead.id.in_({j.lead_id for j in jobs})).all()} if jobs else {}
        items = {i.id: i for i in db.query(StainInventoryItem).all()}
        bleach = _bleach_item(db)
        rows = []
        for j in sorted(jobs, key=lambda x: x.completed_at or ""):
            price = (j.final_price_cents or 0) / 100
            crew, hourly = _crew_cost(j)
            estimated = not j.materials_logged_at
            if estimated:
                # Finished before costing existed: price the gallons used at today's average.
                st = items.get(j.final_stain_id or "")
                stain = float(j.stain_gallons_used or 0) * float(st.avg_cost or 0) if st else 0.0
                bl = float(j.bleach_gallons_used or 0) * float(bleach.avg_cost or 0) if bleach else 0.0
            else:
                stain, bl = float(j.stain_cost or 0), float(j.bleach_cost or 0)
            fees = price * CARD_FEE_RATE
            gross = price - crew - stain - bl - share - fees
            rows.append({
                "lead_id": j.lead_id, "customer": names.get(j.lead_id, ""), "completed_on": (j.completed_at or "")[:10],
                "package": j.package or "", "price": round(price, 2), "crew_pay": round(crew, 2), "hourly_crew": hourly,
                "stain_gallons": float(j.stain_gallons_used or 0), "stain_cost": round(stain, 2),
                "bleach_gallons": float(j.bleach_gallons_used or 0), "bleach_cost": round(bl, 2),
                "supplies": round(share, 2), "fees": round(fees, 2), "gross_profit": round(gross, 2),
                "margin_pct": round(gross / price * 100, 1) if price else 0.0, "estimated": estimated,
            })
        tot = {k: round(sum(r[k] for r in rows), 2) for k in
               ("price", "crew_pay", "stain_cost", "bleach_cost", "supplies", "fees", "gross_profit")}
        tot["margin_pct"] = round(tot["gross_profit"] / tot["price"] * 100, 1) if tot["price"] else 0.0
        return {"month": m, "jobs": rows, "totals": tot, "supplies_total": round(supplies, 2), "card_fee_rate": CARD_FEE_RATE}
    finally:
        db.close()
