"""
Daily Task List — the "no lead slips through the cracks" work queue.

One table of every lead sitting in ESTIMATE SENT or RESPONDED TO ESTIMATE,
so staff can work each one until they hear a yes (schedule) or a no (decline).
Reuses existing infrastructure:
  - call log        → CallDisposition rows (POST/GET /leads/{id}/call-dispositions)
  - decline (a no)  → move to DECLINED ESTIMATE via /leads/{id}/stage
  - schedule (a yes)→ the normal ScheduleJobModal → Closed & Scheduled

This endpoint just assembles the read model: which leads, their called/notes
state (derived from dispositions), and the signature-tier price.
"""
from __future__ import annotations
import json
import logging
import math

from fastapi import APIRouter, Depends
from sqlalchemy import desc

from database import get_db, Lead, Estimate, CallDisposition
from api.auth import require_staff

router = APIRouter()
logger = logging.getLogger(__name__)

# Stages that belong on the daily task list, grouped into the two labels the
# owner asked for. Mirrors the Sterling V2 pipeline stage IDs.
_ESTIMATE_SENT_ID = "dc3600f2-009b-4075-95fa-786823131416"
_RESPONDED_IDS = {
    "8e1eb2cd-b9db-4eb7-aacf-901945cfca9b",  # RESPONDED TO ESTIMATE
    "147bd53b-3848-449d-b7c2-7a2cfad2a5f5",  # Top Priority-Responded to Estimate
}
_STAGE_KEYS = {_ESTIMATE_SENT_ID: "estimate_sent", **{sid: "responded" for sid in _RESPONDED_IDS}}
_STAGE_LABELS = {"estimate_sent": "Estimate sent", "responded": "Responded to estimate"}


def _signature_prices(db, lead_ids: list[str]) -> dict[str, int]:
    """Latest-estimate signature price per lead, rounded up to whole dollars
    (matches the proposal). Batched — one query for all leads."""
    out: dict[str, int] = {}
    if not lead_ids:
        return out
    ests = (
        db.query(Estimate)
        .filter(Estimate.lead_id.in_(lead_ids))
        .order_by(desc(Estimate.created_at))
        .all()
    )
    for e in ests:
        if e.lead_id in out:
            continue  # first seen = latest
        try:
            tiers = json.loads(e.tiers or "{}")
            sig = float(tiers.get("signature") or 0)
        except (TypeError, ValueError, json.JSONDecodeError):
            sig = 0
        out[e.lead_id] = math.ceil(sig) if sig > 0 else 0
    return out


@router.get("/daily-tasks")
def get_daily_tasks(user: dict = Depends(require_staff)):
    """Every lead in ESTIMATE SENT / RESPONDED TO ESTIMATE, with its call log
    (from CallDisposition) and signature price. Ordered so nothing slips:
    responded first, then leads with no call yet, then higher-value first."""
    del user
    db = get_db()
    try:
        stage_ids = [_ESTIMATE_SENT_ID, *_RESPONDED_IDS]
        leads = (
            db.query(Lead)
            .filter(
                Lead.pipeline_version == "v2",
                Lead.is_test.isnot(True),
                Lead.ghl_pipeline_stage_id.in_(stage_ids),
            )
            .all()
        )
        lead_ids = [l.id for l in leads]

        # Call dispositions per lead (newest first) → the notes log + called flag.
        disp_by_lead: dict[str, list[dict]] = {}
        if lead_ids:
            disps = (
                db.query(CallDisposition)
                .filter(CallDisposition.lead_id.in_(lead_ids))
                .order_by(desc(CallDisposition.disposed_at))
                .all()
            )
            for d in disps:
                disp_by_lead.setdefault(d.lead_id, []).append({
                    "outcome": d.outcome or "",
                    "notes": d.notes or "",
                    "disposed_by": d.disposed_by or "",
                    "disposed_at": d.disposed_at or "",
                })

        prices = _signature_prices(db, lead_ids)

        rows = []
        for l in leads:
            sid = l.ghl_pipeline_stage_id or ""
            stage_key = _STAGE_KEYS.get(sid, "estimate_sent")
            log = disp_by_lead.get(l.id, [])
            rows.append({
                "id": l.id,
                "contact_name": l.contact_name or "",
                "address": l.address or "",
                "stage_key": stage_key,
                "stage_label": _STAGE_LABELS[stage_key],
                "called": len(log) > 0,
                "call_count": len(log),
                "last_called_at": log[0]["disposed_at"] if log else None,
                "dispositions": log,
                "signature_price": prices.get(l.id, 0),
            })

        # Responded first, then uncalled-first, then higher price first.
        rows.sort(key=lambda r: (
            0 if r["stage_key"] == "responded" else 1,
            0 if not r["called"] else 1,
            -r["signature_price"],
        ))
        return {"tasks": rows}
    finally:
        db.close()
