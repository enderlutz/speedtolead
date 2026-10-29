"""The three numbers and the money watch (Alan, 2026-10-29).

    GET  /api/scoreboard              today's numbers (live), the money watch, the last 60 days
    POST /api/scoreboard/save         work today out again and keep it
    PUT  /api/scoreboard/stain-cost   the stain cost per gallon the numbers use
"""
from __future__ import annotations

import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.auth import require_admin
from database import DailyScore, SystemConfig, get_db
from services import scoreboard as sb

router = APIRouter()


@router.get("/scoreboard")
def get_scoreboard(user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        today = datetime.now(sb.CT).date()
        row = db.get(DailyScore, today.isoformat())
        if row is None:
            row = sb.save_day(db, today)
        data = json.loads(row.data_json or "{}")
        return {"today": data, "saved_at": row.saved_at, "history": sb.history(db, 60),
                "stuck_dollars": sb.STRIPE_STUCK_DOLLARS, "stuck_days": sb.STRIPE_STUCK_DAYS}
    finally:
        db.close()


@router.post("/scoreboard/save")
def save_now(user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        row = sb.save_day(db)
        return {"today": json.loads(row.data_json or "{}"), "saved_at": row.saved_at, "history": sb.history(db, 60)}
    finally:
        db.close()


class StainCost(BaseModel):
    dollars: float


@router.put("/scoreboard/stain-cost")
def set_stain_cost(body: StainCost, user: dict = Depends(require_admin)):
    del user
    if not 5 <= body.dollars <= 300:
        raise HTTPException(400, "A gallon of stain has to cost between $5 and $300")
    db = get_db()
    try:
        SystemConfig.set(db, sb.STAIN_COST_KEY, f"{body.dollars:.2f}")
        row = sb.save_day(db)
        return {"today": json.loads(row.data_json or "{}"), "saved_at": row.saved_at, "history": sb.history(db, 60)}
    finally:
        db.close()
