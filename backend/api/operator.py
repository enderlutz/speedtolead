"""
Operator AI — admin-only Diagnosis Feed.

Read/decide endpoints over the AIThought log. The bus is observer-only;
all behavior changes go through approve/dismiss here so there's a single
audit point.

Approve handlers are registered per `proposed_action_payload.kind`. When a
new module ships (follow-up engine, future procurement watcher, …) it
registers its kind here so the approve button actually does something.
For now we have a single placeholder kind to prove the wiring; phase 2
will register the follow-up kinds.
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone
from typing import Callable, Optional

from fastapi import APIRouter, HTTPException, Query, Depends
from pydantic import BaseModel
from sqlalchemy import desc

from database import get_db, AIThought
from api.auth import require_admin

router = APIRouter()
logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# --- Approve-action handler registry ---
# Modules register a handler keyed by payload["kind"]. The handler is
# called when an admin clicks Approve. Signature: (thought_dict, user) -> dict
# Result is included in the API response so the UI can show what happened.

_ACTION_HANDLERS: dict[str, Callable[[dict, dict], dict]] = {}


def register_action_handler(kind: str, handler: Callable[[dict, dict], dict]):
    """Used by other modules to plug in their approve behavior."""
    _ACTION_HANDLERS[kind] = handler
    logger.info(f"AI action handler registered: {kind}")


# Stub handler — proves the wiring without doing anything destructive.
def _noop_handler(thought: dict, user: dict) -> dict:
    del user
    return {"ok": True, "kind": "noop", "message": "Acknowledged"}


_ACTION_HANDLERS["noop"] = _noop_handler


# Standard "open_lead" handler — the AI uses this when its proposed action
# is "go look at this lead" (opt-out review, send failure, etc.). Server
# returns a navigate_to URL and the frontend honors it after approve.
def _open_lead_handler(thought: dict, user: dict) -> dict:
    del user
    payload = thought.get("proposed_action_payload") or {}
    lead_id = payload.get("lead_id") or thought.get("source_ref_id") or ""
    if not lead_id:
        return {"ok": False, "message": "no lead_id in payload"}
    return {"ok": True, "kind": "navigate", "navigate_to": f"/leads/{lead_id}"}


_ACTION_HANDLERS["open_lead"] = _open_lead_handler


# --- API ---

@router.get("/operator/thoughts")
def list_thoughts(
    status: Optional[str] = Query(None, description="active|approved|dismissed|snoozed|executed|all"),
    source: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    user: dict = Depends(require_admin),
):
    del user
    db = get_db()
    try:
        q = db.query(AIThought)
        if status and status != "all":
            q = q.filter(AIThought.status == status)
        else:
            q = q.filter(AIThought.status.in_(("active", "snoozed")))
        if source:
            q = q.filter(AIThought.source == source)
        # High first, then by created_at desc.
        rows = q.order_by(
            desc(AIThought.created_at),
        ).limit(limit).all()
        severity_rank = {"high": 0, "medium": 1, "low": 2}
        items = [r.to_dict() for r in rows]
        items.sort(key=lambda t: (severity_rank.get(t["severity"], 3), -1 * _ts(t["created_at"])))
        active_count = db.query(AIThought).filter(AIThought.status == "active").count()
        return {"thoughts": items, "active_count": active_count}
    finally:
        db.close()


def _ts(iso: str) -> int:
    try:
        return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())
    except Exception:
        return 0


@router.get("/operator/thoughts/{thought_id}")
def get_thought(thought_id: str, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        t = db.query(AIThought).filter(AIThought.id == thought_id).first()
        if not t:
            raise HTTPException(status_code=404, detail="Thought not found")
        return t.to_dict()
    finally:
        db.close()


class DecisionBody(BaseModel):
    note: str = ""


@router.post("/operator/thoughts/{thought_id}/approve")
def approve_thought(thought_id: str, body: DecisionBody, user: dict = Depends(require_admin)):
    db = get_db()
    try:
        t = db.query(AIThought).filter(AIThought.id == thought_id).first()
        if not t:
            raise HTTPException(status_code=404, detail="Thought not found")
        if t.status != "active":
            raise HTTPException(status_code=400, detail=f"Cannot approve a {t.status} thought")
        snapshot = t.to_dict()
        t.status = "approved"
        t.decided_at = _now()
        t.decided_by = user.get("sub", "")
        t.decision_note = body.note or ""
        db.commit()

        # Dispatch the underlying action.
        kind = snapshot["proposed_action_payload"].get("kind", "noop")
        handler = _ACTION_HANDLERS.get(kind)
        if not handler:
            logger.warning(f"No action handler for kind={kind} on thought {thought_id}")
            return {"status": "approved_no_action", "result": None}
        try:
            result = handler(snapshot, user)
            t.status = "executed"
            db.commit()
            return {"status": "executed", "result": result}
        except Exception as e:
            logger.error(f"Approve handler {kind} failed for thought {thought_id}: {e}")
            return {"status": "approved_failed", "error": str(e)}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/operator/thoughts/{thought_id}/dismiss")
def dismiss_thought(thought_id: str, body: DecisionBody, user: dict = Depends(require_admin)):
    db = get_db()
    try:
        t = db.query(AIThought).filter(AIThought.id == thought_id).first()
        if not t:
            raise HTTPException(status_code=404, detail="Thought not found")
        if t.status not in ("active", "snoozed"):
            raise HTTPException(status_code=400, detail=f"Cannot dismiss a {t.status} thought")
        t.status = "dismissed"
        t.decided_at = _now()
        t.decided_by = user.get("sub", "")
        t.decision_note = body.note or ""
        db.commit()
        return {"status": "dismissed"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


class SnoozeBody(BaseModel):
    until: str  # ISO timestamp


@router.post("/operator/thoughts/{thought_id}/snooze")
def snooze_thought(thought_id: str, body: SnoozeBody, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        t = db.query(AIThought).filter(AIThought.id == thought_id).first()
        if not t:
            raise HTTPException(status_code=404, detail="Thought not found")
        t.status = "snoozed"
        t.snooze_until = body.until
        db.commit()
        return {"status": "snoozed", "until": body.until}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


# Test endpoint — admin can drop a sample thought to verify the feed
# end-to-end. Useful for staging + smoke tests. Removed once we have real
# observers feeding the bus.
class TestThoughtBody(BaseModel):
    title: str = "Sample diagnosis"
    summary: str = "This is a test thought to verify the Operator AI feed."
    severity: str = "medium"
    category: str = "System"


@router.post("/operator/thoughts/_test")
def drop_test_thought(body: TestThoughtBody, user: dict = Depends(require_admin)):
    del user
    from services.ai_thought_bus import publish
    tid = publish(
        source="manual",
        title=body.title,
        summary=body.summary,
        severity=body.severity,
        category=body.category or "System",
        proposed_action_text="No-op (test thought)",
        proposed_action_payload={"kind": "noop"},
        confidence_pct=50,
    )
    if not tid:
        raise HTTPException(status_code=500, detail="Failed to publish thought")
    return {"id": tid}
