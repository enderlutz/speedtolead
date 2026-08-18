"""Stain inventory — what stain we have on hand, container by container.

Stains
    GET    /api/stain-inventory                       list stains + their containers
    POST   /api/stain-inventory                       add a stain
    PUT    /api/stain-inventory/{stain_id}            rename / retire a stain
    DELETE /api/stain-inventory/{stain_id}            remove a stain and its containers

Containers (the actual stock)
    POST   /api/stain-inventory/{stain_id}/containers add container(s)
    PUT    /api/stain-containers/{container_id}       set how much is left in one
    DELETE /api/stain-containers/{container_id}       container's gone (empty/discarded)

History
    GET    /api/stain-movements                       audit trail, newest first

Containers are tracked individually because they're never equally full — a
5-gallon with 3 gallons left sits beside an untouched one. `gallons_remaining`
is the single number for both ways of counting: a half-full 1-gallon can IS
0.5 gallons.

Every add / adjust / remove writes a StainMovement with the actor's name, so
once workers are entering usage from the field a wrong number is traceable.
"""
from __future__ import annotations
import uuid
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from database import get_db, StainInventoryItem, StainContainer, StainMovement
from api.permissions import require_perm

router = APIRouter()
logger = logging.getLogger(__name__)

# The four finishes Alan buys. Server-side so the UI dropdown and the stored
# value can't drift apart the way the two hardcoded colour lists already have.
FINISH_TYPES = ("transparent", "semi_transparent", "semi_solid", "solid")

# Container sizes we stock. Kept permissive (any positive number is accepted)
# but these are what the UI offers.
COMMON_SIZES = (5.0, 1.0)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _actor(user: dict) -> str:
    return (user.get("name") or user.get("sub") or "Unknown").strip()


def _stain_total(db: Session, stain_id: str) -> float:
    """Current gallons across every container of a stain."""
    total = db.query(func.coalesce(func.sum(StainContainer.gallons_remaining), 0.0)).filter(
        StainContainer.stain_id == stain_id
    ).scalar()
    return round(float(total or 0), 2)


def _log(db: Session, *, stain_id: str, container_id: str, action: str,
         delta: float, actor: str, note: str = "") -> None:
    """Append an audit row. Caller commits — the movement and the change it
    describes must land in the same transaction or the trail can lie."""
    db.add(StainMovement(
        id=str(uuid.uuid4()),
        stain_id=stain_id,
        container_id=container_id,
        action=action,
        delta_gallons=round(float(delta), 2),
        resulting_gallons=_stain_total(db, stain_id),
        actor=actor,
        note=note.strip(),
        created_at=_now(),
    ))


class StainBody(BaseModel):
    brand: str
    finish_type: str
    color_name: str
    notes: str = ""
    active: bool = True


class ContainerBody(BaseModel):
    size_gallons: float = 5
    gallons_remaining: float = 0
    label: str = ""
    count: int = 1          # add several identical containers in one go
    note: str = ""


class ContainerUpdateBody(BaseModel):
    gallons_remaining: float
    size_gallons: float | None = None
    label: str | None = None
    note: str = ""


def _validate_stain(body: StainBody) -> None:
    if not body.brand.strip():
        raise HTTPException(status_code=400, detail="Brand is required")
    if not body.color_name.strip():
        raise HTTPException(status_code=400, detail="Color name is required")
    if body.finish_type not in FINISH_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"finish_type must be one of: {', '.join(FINISH_TYPES)}",
        )


def _validate_amounts(size: float, remaining: float) -> None:
    if size <= 0:
        raise HTTPException(status_code=400, detail="Container size must be greater than 0")
    if remaining < 0:
        raise HTTPException(status_code=400, detail="Gallons remaining can't be negative")
    if remaining > size:
        raise HTTPException(
            status_code=400,
            detail=f"A {size:g}-gallon container can't hold {remaining:g} gallons",
        )


# ─── Stains ──────────────────────────────────────────────────────────────

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
        stains = query.order_by(
            StainInventoryItem.brand.asc(), StainInventoryItem.color_name.asc()
        ).all()

        # One query for every container, grouped in Python — avoids N+1 as the
        # stain list grows.
        by_stain: dict[str, list[StainContainer]] = {}
        if stains:
            ids = [s.id for s in stains]
            containers = (
                db.query(StainContainer)
                .filter(StainContainer.stain_id.in_(ids))
                .order_by(StainContainer.size_gallons.desc(), StainContainer.created_at.asc())
                .all()
            )
            for c in containers:
                by_stain.setdefault(c.stain_id, []).append(c)

        items = [s.to_dict(by_stain.get(s.id, [])) for s in stains]
        return {
            "items": items,
            "total_gallons": round(sum(i["total_gallons"] for i in items), 2),
            "total_containers": sum(i["container_count"] for i in items),
        }
    finally:
        db.close()


@router.post("/stain-inventory")
def create_stain(body: StainBody, user: dict = Depends(require_perm("stain_inventory"))):
    del user
    _validate_stain(body)
    db = get_db()
    try:
        stain = StainInventoryItem(
            id=str(uuid.uuid4()),
            brand=body.brand.strip(),
            finish_type=body.finish_type,
            color_name=body.color_name.strip(),
            notes=body.notes.strip(),
            active=body.active,
            created_at=_now(),
            updated_at=_now(),
        )
        db.add(stain)
        db.commit()
        return stain.to_dict([])
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.put("/stain-inventory/{stain_id}")
def update_stain(stain_id: str, body: StainBody, user: dict = Depends(require_perm("stain_inventory"))):
    del user
    _validate_stain(body)
    db = get_db()
    try:
        stain = db.query(StainInventoryItem).filter(StainInventoryItem.id == stain_id).first()
        if not stain:
            raise HTTPException(status_code=404, detail="Stain not found")
        stain.brand = body.brand.strip()
        stain.finish_type = body.finish_type
        stain.color_name = body.color_name.strip()
        stain.notes = body.notes.strip()
        stain.active = body.active
        stain.updated_at = _now()
        db.commit()
        containers = db.query(StainContainer).filter(StainContainer.stain_id == stain_id).all()
        return stain.to_dict(containers)
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.delete("/stain-inventory/{stain_id}")
def delete_stain(stain_id: str, user: dict = Depends(require_perm("stain_inventory"))):
    del user
    db = get_db()
    try:
        stain = db.query(StainInventoryItem).filter(StainInventoryItem.id == stain_id).first()
        if not stain:
            raise HTTPException(status_code=404, detail="Stain not found")
        db.query(StainContainer).filter(StainContainer.stain_id == stain_id).delete()
        db.delete(stain)
        # Movements are deliberately kept — the history of a deleted stain is
        # still the answer to "where did those gallons go".
        db.commit()
        return {"status": "deleted"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


# ─── Containers ──────────────────────────────────────────────────────────

@router.post("/stain-inventory/{stain_id}/containers")
def add_containers(
    stain_id: str,
    body: ContainerBody,
    user: dict = Depends(require_perm("stain_inventory")),
):
    _validate_amounts(body.size_gallons, body.gallons_remaining)
    if body.count < 1 or body.count > 100:
        raise HTTPException(status_code=400, detail="count must be between 1 and 100")
    db = get_db()
    try:
        stain = db.query(StainInventoryItem).filter(StainInventoryItem.id == stain_id).first()
        if not stain:
            raise HTTPException(status_code=404, detail="Stain not found")
        made = []
        for _ in range(body.count):
            c = StainContainer(
                id=str(uuid.uuid4()),
                stain_id=stain_id,
                size_gallons=body.size_gallons,
                gallons_remaining=body.gallons_remaining,
                label=body.label.strip(),
                created_at=_now(),
                updated_at=_now(),
            )
            db.add(c)
            made.append(c)
        db.flush()  # totals below must see the new rows
        _log(
            db, stain_id=stain_id, container_id=made[-1].id if len(made) == 1 else "",
            action="added", delta=body.gallons_remaining * body.count,
            actor=_actor(user),
            note=body.note or f"Added {body.count} × {body.size_gallons:g} gal container(s)",
        )
        db.commit()
        containers = db.query(StainContainer).filter(StainContainer.stain_id == stain_id).all()
        return stain.to_dict(containers)
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.put("/stain-containers/{container_id}")
def update_container(
    container_id: str,
    body: ContainerUpdateBody,
    user: dict = Depends(require_perm("stain_inventory")),
):
    db = get_db()
    try:
        c = db.query(StainContainer).filter(StainContainer.id == container_id).first()
        if not c:
            raise HTTPException(status_code=404, detail="Container not found")
        size = body.size_gallons if body.size_gallons is not None else float(c.size_gallons or 0)
        _validate_amounts(size, body.gallons_remaining)

        before = float(c.gallons_remaining or 0)
        c.size_gallons = size
        c.gallons_remaining = body.gallons_remaining
        if body.label is not None:
            c.label = body.label.strip()
        c.updated_at = _now()
        db.flush()

        delta = body.gallons_remaining - before
        # Only log a real movement — a label-only edit isn't a gallon change.
        if abs(delta) > 1e-9:
            _log(
                db, stain_id=c.stain_id, container_id=c.id, action="adjusted",
                delta=delta, actor=_actor(user), note=body.note,
            )
        db.commit()

        stain = db.query(StainInventoryItem).filter(StainInventoryItem.id == c.stain_id).first()
        containers = db.query(StainContainer).filter(StainContainer.stain_id == c.stain_id).all()
        return stain.to_dict(containers) if stain else {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.delete("/stain-containers/{container_id}")
def delete_container(container_id: str, user: dict = Depends(require_perm("stain_inventory"))):
    db = get_db()
    try:
        c = db.query(StainContainer).filter(StainContainer.id == container_id).first()
        if not c:
            raise HTTPException(status_code=404, detail="Container not found")
        stain_id = c.stain_id
        had = float(c.gallons_remaining or 0)
        db.delete(c)
        db.flush()
        _log(
            db, stain_id=stain_id, container_id=container_id, action="removed",
            delta=-had, actor=_actor(user),
            note=f"Container removed ({had:g} gal in it)",
        )
        db.commit()

        stain = db.query(StainInventoryItem).filter(StainInventoryItem.id == stain_id).first()
        containers = db.query(StainContainer).filter(StainContainer.stain_id == stain_id).all()
        return stain.to_dict(containers) if stain else {"status": "deleted"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


# ─── History ─────────────────────────────────────────────────────────────

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
