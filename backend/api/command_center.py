"""GET /api/dashboard/command: the Dashboard tab's command center (Alan,
2026-11-14). Read-only; money numbers, so the Money tab's people only."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from api.auth import require_revenue
from database import get_db

router = APIRouter()


@router.get("/dashboard/command")
def command(fresh: bool = False, user: dict = Depends(require_revenue)):
    from services.command_center import build
    db = get_db()
    try:
        return build(db, fresh=fresh)
    finally:
        db.close()
