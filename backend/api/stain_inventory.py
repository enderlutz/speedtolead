"""Stain inventory — what stain we have on hand.

    GET    /api/stain-inventory              list, with optional search + finish filter
    POST   /api/stain-inventory              add a stain
    PUT    /api/stain-inventory/{item_id}    update one (full body)
    DELETE /api/stain-inventory/{item_id}    remove one

Quantity is containers × gallons-per-container; the gallon total is derived by
StainInventoryItem.to_dict, not stored. Gated on the stain_inventory permission
so office staff (VA role) can maintain it, not just the owner.
"""
from __future__ import annotations
import uuid
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, or_

from database import get_db, StainInventoryItem
from api.permissions import require_perm

router = APIRouter()
logger = logging.getLogger(__name__)

# The four finishes Alan buys. Kept server-side so the UI dropdown and the
# stored value can't drift apart the way the two hardcoded colour lists in
# ScheduleJobModal and PmHq did.
FINISH_TYPES = ("transparent", "semi_transparent", "semi_solid", "solid")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class StainInventoryBody(BaseModel):
    brand: str
    finish_type: str
    color_name: str
    container_count: float = 0
    gallons_per_container: float = 0
    notes: str = ""
    active: bool = True


def _validate(body: StainInventoryBody) -> None:
    """Shared create/update validation — 400 on anything the UI shouldn't send."""
    if not body.brand.strip():
        raise HTTPException(status_code=400, detail="Brand is required")
    if not body.color_name.strip():
        raise HTTPException(status_code=400, detail="Color name is required")
    if body.finish_type not in FINISH_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"finish_type must be one of: {', '.join(FINISH_TYPES)}",
        )
    if body.container_count < 0:
        raise HTTPException(status_code=400, detail="container_count must be >= 0")
    if body.gallons_per_container < 0:
        raise HTTPException(status_code=400, detail="gallons_per_container must be >= 0")


def _apply(item: StainInventoryItem, body: StainInventoryBody) -> None:
    item.brand = body.brand.strip()
    item.finish_type = body.finish_type
    item.color_name = body.color_name.strip()
    item.container_count = body.container_count
    item.gallons_per_container = body.gallons_per_container
    item.notes = body.notes.strip()
    item.active = body.active
    item.updated_at = _now()


@router.get("/stain-inventory")
def list_stain_inventory(
    q: str = Query("", description="Match brand or color name"),
    finish_type: str = Query("", description="Filter to one finish"),
    user: dict = Depends(require_perm("stain_inventory")),
):
    del user
    db = get_db()
    try:
        query = db.query(StainInventoryItem)
        term = q.strip()
        if term:
            like = f"%{term.lower()}%"
            query = query.filter(
                or_(
                    func.lower(StainInventoryItem.brand).like(like),
                    func.lower(StainInventoryItem.color_name).like(like),
                )
            )
        if finish_type.strip():
            query = query.filter(StainInventoryItem.finish_type == finish_type.strip())
        rows = query.order_by(
            StainInventoryItem.brand.asc(), StainInventoryItem.color_name.asc()
        ).all()
        return {
            "items": [r.to_dict() for r in rows],
            "total_gallons": round(
                sum(float(r.container_count or 0) * float(r.gallons_per_container or 0) for r in rows), 2
            ),
        }
    finally:
        db.close()


@router.post("/stain-inventory")
def create_stain_inventory_item(
    body: StainInventoryBody,
    user: dict = Depends(require_perm("stain_inventory")),
):
    del user
    _validate(body)
    db = get_db()
    try:
        item = StainInventoryItem(id=str(uuid.uuid4()), created_at=_now())
        _apply(item, body)
        db.add(item)
        db.commit()
        return item.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.put("/stain-inventory/{item_id}")
def update_stain_inventory_item(
    item_id: str,
    body: StainInventoryBody,
    user: dict = Depends(require_perm("stain_inventory")),
):
    del user
    _validate(body)
    db = get_db()
    try:
        item = db.query(StainInventoryItem).filter(StainInventoryItem.id == item_id).first()
        if not item:
            raise HTTPException(status_code=404, detail="Stain not found")
        _apply(item, body)
        db.commit()
        return item.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.delete("/stain-inventory/{item_id}")
def delete_stain_inventory_item(
    item_id: str,
    user: dict = Depends(require_perm("stain_inventory")),
):
    del user
    db = get_db()
    try:
        item = db.query(StainInventoryItem).filter(StainInventoryItem.id == item_id).first()
        if not item:
            raise HTTPException(status_code=404, detail="Stain not found")
        db.delete(item)
        db.commit()
        return {"status": "deleted"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()
