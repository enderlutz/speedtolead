"""GET /api/ghl/usage: how much of GoHighLevel's daily API allowance we've
used today (Alan, 2026-11-13). See services/ghl_usage.py."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from api.auth import require_admin
from database import get_db
from services import ghl_usage

router = APIRouter()


@router.get("/ghl/usage")
def usage(user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        saved = ghl_usage.summary(ghl_usage.saved(db), ghl_usage.account_names())
    finally:
        db.close()
    live = ghl_usage.summary(ghl_usage.snapshot(), ghl_usage.account_names())
    # This server's own count is the freshest; fall back to the saved one.
    return live if live["our_requests_today"] else saved
