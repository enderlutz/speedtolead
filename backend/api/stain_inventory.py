"""Stain inventory — how many gallons of each stain we have on hand.

    GET    /api/stain-inventory              list every stain + the grand total
    POST   /api/stain-inventory              add a stain
    PUT    /api/stain-inventory/{stain_id}   edit it (including the gallon count)
    DELETE /api/stain-inventory/{stain_id}   remove it
    GET    /api/stain-movements              audit trail, newest first

One row per brand + finish + colour, holding one number: gallons. That's the
whole model. Counting individual containers was tried and dropped — Alan walks
the storage unit and writes down a total per colour, so a 5-gallon with 3 left
next to two full 1-gallons is just "5 gallons".

Every gallon change writes a StainMovement with the actor's name. Nothing in
the main screen depends on it; it's there so that once workers are updating
counts from the field, a number that looks wrong is traceable to a person.
"""
from __future__ import annotations
import uuid
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from database import get_db, StainInventoryItem, StainMovement, FencePhoto
from api.permissions import require_perm
from config import get_settings
import services.supabase_storage as storage

router = APIRouter()
logger = logging.getLogger(__name__)

# Finishes we stock, ordered most opaque → least, with oil-based last (it's a
# base, not an opacity, but it's how the Ready Seal line gets grouped on the
# shelf). Server-side so the UI dropdown and the stored value can't drift apart
# the way the two hardcoded colour lists already have.
FINISH_TYPES = (
    "solid",
    "semi_solid",
    "semi_transparent",
    "transparent",
    "clear",
    "oil_based",
)
_FINISH_RANK = {name: i for i, name in enumerate(FINISH_TYPES)}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _actor(user: dict) -> str:
    return (user.get("name") or user.get("sub") or "Unknown").strip()


def _log(db: Session, *, stain_id: str, action: str, before: float,
         after: float, actor: str, note: str = "") -> None:
    """Append an audit row. Caller commits — the movement and the change it
    describes must land in the same transaction or the trail can lie."""
    db.add(StainMovement(
        id=str(uuid.uuid4()),
        stain_id=stain_id,
        action=action,
        previous_gallons=round(before, 2),
        delta_gallons=round(after - before, 2),
        resulting_gallons=round(after, 2),
        actor=actor,
        note=note.strip(),
        created_at=_now(),
    ))


class StainBody(BaseModel):
    brand: str
    finish_type: str
    color_name: str
    gallons: float = 0
    notes: str = ""
    active: bool = True
    note: str = ""          # optional reason for the change, lands in history


def _validate(body: StainBody) -> None:
    if not body.brand.strip():
        raise HTTPException(status_code=400, detail="Brand is required")
    if not body.color_name.strip():
        raise HTTPException(status_code=400, detail="Stain name is required")
    if body.finish_type not in FINISH_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"finish_type must be one of: {', '.join(FINISH_TYPES)}",
        )
    if body.gallons < 0:
        raise HTTPException(status_code=400, detail="Gallons can't be negative")


def _sort_key(item: StainInventoryItem) -> tuple:
    """Brand, then finish by opacity, then colour alphabetically — the order
    the storage unit gets read in."""
    return (
        (item.brand or "").lower(),
        _FINISH_RANK.get(item.finish_type or "", len(FINISH_TYPES)),
        (item.color_name or "").lower(),
    )


@router.get("/stain-inventory")
def list_stain_inventory(
    q: str = Query("", description="Match brand or stain name"),
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

        # Sorted in Python — finish order is by opacity, not alphabet, and a
        # SQL CASE for six values is more noise than this is worth.
        rows = sorted(query.all(), key=_sort_key)
        items = [r.to_dict() for r in rows]
        return {
            "items": items,
            "total_gallons": round(sum(i["gallons"] for i in items), 2),
        }
    finally:
        db.close()


@router.post("/stain-inventory")
def create_stain(body: StainBody, user: dict = Depends(require_perm("stain_inventory"))):
    _validate(body)
    db = get_db()
    try:
        stain = StainInventoryItem(
            id=str(uuid.uuid4()),
            brand=body.brand.strip(),
            finish_type=body.finish_type,
            color_name=body.color_name.strip(),
            gallons=round(body.gallons, 2),
            notes=body.notes.strip(),
            active=body.active,
            created_at=_now(),
            updated_at=_now(),
        )
        db.add(stain)
        _log(
            db, stain_id=stain.id, action="added", before=0.0,
            after=round(body.gallons, 2), actor=_actor(user),
            note=body.note or "Added to inventory",
        )
        db.commit()
        return stain.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.put("/stain-inventory/{stain_id}")
def update_stain(stain_id: str, body: StainBody, user: dict = Depends(require_perm("stain_inventory"))):
    _validate(body)
    db = get_db()
    try:
        stain = db.query(StainInventoryItem).filter(StainInventoryItem.id == stain_id).first()
        if not stain:
            raise HTTPException(status_code=404, detail="Stain not found")

        before = round(float(stain.gallons or 0), 2)
        after = round(body.gallons, 2)

        stain.brand = body.brand.strip()
        stain.finish_type = body.finish_type
        stain.color_name = body.color_name.strip()
        stain.gallons = after
        stain.notes = body.notes.strip()
        stain.active = body.active
        stain.updated_at = _now()

        # Only log a real movement — renaming a stain isn't a gallon change.
        if abs(after - before) > 1e-9:
            _log(
                db, stain_id=stain_id, action="updated", before=before,
                after=after, actor=_actor(user), note=body.note,
            )
        db.commit()
        return stain.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.delete("/stain-inventory/{stain_id}")
def delete_stain(stain_id: str, user: dict = Depends(require_perm("stain_inventory"))):
    db = get_db()
    try:
        stain = db.query(StainInventoryItem).filter(StainInventoryItem.id == stain_id).first()
        if not stain:
            raise HTTPException(status_code=404, detail="Stain not found")
        had = round(float(stain.gallons or 0), 2)
        label = " · ".join(x for x in (stain.brand, stain.color_name) if x)

        # Fence Photos hang off this stain. Take them with it — rows and the
        # Storage objects behind them — or they orphan with nothing pointing
        # at them. Deleted inline rather than by importing api.fence_photos,
        # which imports this module (circular).
        photos = db.query(FencePhoto).filter(FencePhoto.stain_id == stain_id).all()
        if photos:
            bucket = get_settings().supabase_fence_photos_bucket or "fence-photos"
            for p in photos:
                for path in (p.storage_path, p.thumb_storage_path):
                    if not path:
                        continue
                    try:
                        storage.delete_object(bucket, path)
                    except Exception as e:
                        logger.warning(f"Fence photo storage delete failed for {path}: {e}")
                db.delete(p)
            logger.info(f"Deleted {len(photos)} fence photo(s) with stain {label}")

        db.delete(stain)
        _log(
            db, stain_id=stain_id, action="removed", before=had, after=0.0,
            actor=_actor(user), note=f"Removed {label} from inventory",
        )
        # The movement rows stay — the history of a deleted stain is still the
        # answer to "where did those gallons go".
        db.commit()
        return {"status": "deleted"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.get("/stain-movements")
def list_stain_movements(
    stain_id: str = Query("", description="Limit to one stain"),
    limit: int = Query(100, ge=1, le=500),
    user: dict = Depends(require_perm("stain_inventory")),
):
    del user
    db = get_db()
    try:
        query = db.query(StainMovement)
        if stain_id.strip():
            query = query.filter(StainMovement.stain_id == stain_id.strip())
        rows = query.order_by(StainMovement.created_at.desc()).limit(limit).all()

        # Stamp each row with its stain's name so the history reads on its own,
        # including for stains that have since been deleted.
        names: dict[str, str] = {}
        ids = {r.stain_id for r in rows if r.stain_id}
        if ids:
            for s in db.query(StainInventoryItem).filter(StainInventoryItem.id.in_(ids)).all():
                names[s.id] = " · ".join(x for x in (s.brand, s.color_name) if x)
        return {
            "movements": [
                {**r.to_dict(), "stain_label": names.get(r.stain_id, "(deleted stain)")}
                for r in rows
            ]
        }
    finally:
        db.close()
