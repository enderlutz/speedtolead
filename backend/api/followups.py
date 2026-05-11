"""
Follow-up Engine API — sequences + runs + master toggle.

Admin-only. Phase 2 surfaces just enough to (a) configure routing
numbers, (b) flip the master switch, (c) toggle individual sequences,
(d) edit/delete sequences + steps, and (e) start a manual test run.
The richer workflow editor lands in Phase 4.
"""
from __future__ import annotations
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from database import get_db, Lead, SystemConfig, FollowUpSequence, FollowUpStep, FollowUpRun, FollowUpEvent
from api.auth import require_admin
from services.followup_engine import (
    CFG_MASTER_ON, CFG_IMESSAGE_NUMBER, CFG_SMS_NUMBER, CFG_TEST_LEAD_ID,
    start_run, get_routing_numbers, is_master_on,
)

router = APIRouter()
logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# -----------------------------------------------------------------------
# Master config — toggles + numbers + test recipient
# -----------------------------------------------------------------------

@router.get("/followups/config")
def get_config(user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        imsg, sms = get_routing_numbers(db)
        return {
            "master_on": is_master_on(db),
            "imessage_from_number": imsg,
            "sms_from_number": sms,
            "test_lead_id": SystemConfig.get(db, CFG_TEST_LEAD_ID, ""),
        }
    finally:
        db.close()


class ConfigUpdate(BaseModel):
    master_on: Optional[bool] = None
    imessage_from_number: Optional[str] = None
    sms_from_number: Optional[str] = None
    test_lead_id: Optional[str] = None


@router.put("/followups/config")
def update_config(body: ConfigUpdate, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        if body.master_on is not None:
            SystemConfig.set(db, CFG_MASTER_ON, "true" if body.master_on else "false")
        if body.imessage_from_number is not None:
            SystemConfig.set(db, CFG_IMESSAGE_NUMBER, body.imessage_from_number.strip())
        if body.sms_from_number is not None:
            SystemConfig.set(db, CFG_SMS_NUMBER, body.sms_from_number.strip())
        if body.test_lead_id is not None:
            SystemConfig.set(db, CFG_TEST_LEAD_ID, body.test_lead_id.strip())
        return get_config(user={"role": "admin"})  # echo current state
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


# -----------------------------------------------------------------------
# Sequences CRUD
# -----------------------------------------------------------------------

@router.get("/followups/sequences")
def list_sequences(user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        seqs = db.query(FollowUpSequence).order_by(FollowUpSequence.created_at.desc()).all()
        return {"sequences": [s.to_dict() for s in seqs]}
    finally:
        db.close()


@router.get("/followups/sequences/{seq_id}")
def get_sequence(seq_id: str, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        seq = db.query(FollowUpSequence).filter(FollowUpSequence.id == seq_id).first()
        if not seq:
            raise HTTPException(status_code=404, detail="Sequence not found")
        steps = db.query(FollowUpStep).filter(FollowUpStep.sequence_id == seq_id).order_by(FollowUpStep.position).all()
        return {
            "sequence": seq.to_dict(),
            "steps": [s.to_dict() for s in steps],
        }
    finally:
        db.close()


class SequenceBody(BaseModel):
    name: str
    description: str = ""
    trigger_event: str = ""
    pause_on_events: str = "customer_replied"


@router.post("/followups/sequences")
def create_sequence(body: SequenceBody, user: dict = Depends(require_admin)):
    db = get_db()
    try:
        seq_id = str(uuid.uuid4())
        seq = FollowUpSequence(
            id=seq_id,
            name=body.name.strip()[:200],
            description=body.description or "",
            trigger_event=(body.trigger_event or "").strip(),
            pause_on_events=(body.pause_on_events or "customer_replied").strip(),
            active=False,
            version=1,
            created_at=_now(),
            updated_at=_now(),
            created_by=user.get("sub", ""),
        )
        db.add(seq)
        db.commit()
        return seq.to_dict()
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.put("/followups/sequences/{seq_id}")
def update_sequence(seq_id: str, body: SequenceBody, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        seq = db.query(FollowUpSequence).filter(FollowUpSequence.id == seq_id).first()
        if not seq:
            raise HTTPException(status_code=404, detail="Sequence not found")
        seq.name = body.name.strip()[:200]
        seq.description = body.description or ""
        seq.trigger_event = (body.trigger_event or "").strip()
        seq.pause_on_events = (body.pause_on_events or "customer_replied").strip()
        seq.version = (seq.version or 1) + 1
        seq.updated_at = _now()
        db.commit()
        return seq.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/followups/sequences/{seq_id}/toggle")
def toggle_sequence(seq_id: str, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        seq = db.query(FollowUpSequence).filter(FollowUpSequence.id == seq_id).first()
        if not seq:
            raise HTTPException(status_code=404, detail="Sequence not found")
        seq.active = not bool(seq.active)
        seq.updated_at = _now()
        db.commit()
        return {"id": seq.id, "active": bool(seq.active)}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.delete("/followups/sequences/{seq_id}")
def delete_sequence(seq_id: str, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        seq = db.query(FollowUpSequence).filter(FollowUpSequence.id == seq_id).first()
        if not seq:
            raise HTTPException(status_code=404, detail="Sequence not found")
        # Hard-delete steps. Runs/events stay for audit (orphaned, that's fine — they reference by id).
        db.query(FollowUpStep).filter(FollowUpStep.sequence_id == seq_id).delete()
        db.delete(seq)
        db.commit()
        return {"status": "deleted"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


# -----------------------------------------------------------------------
# Steps CRUD
# -----------------------------------------------------------------------

class StepBody(BaseModel):
    position: int = 0
    delay_hours: float = 24
    channel: str = "sms"
    message_template: str = ""
    use_ai_personalization: bool = False


@router.post("/followups/sequences/{seq_id}/steps")
def add_step(seq_id: str, body: StepBody, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        seq = db.query(FollowUpSequence).filter(FollowUpSequence.id == seq_id).first()
        if not seq:
            raise HTTPException(status_code=404, detail="Sequence not found")
        step = FollowUpStep(
            id=str(uuid.uuid4()),
            sequence_id=seq_id,
            position=body.position,
            delay_hours=body.delay_hours,
            channel=body.channel,
            message_template=body.message_template,
            use_ai_personalization=body.use_ai_personalization,
            created_at=_now(),
            updated_at=_now(),
        )
        db.add(step)
        seq.updated_at = _now()
        db.commit()
        return step.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.put("/followups/steps/{step_id}")
def update_step(step_id: str, body: StepBody, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        step = db.query(FollowUpStep).filter(FollowUpStep.id == step_id).first()
        if not step:
            raise HTTPException(status_code=404, detail="Step not found")
        step.position = body.position
        step.delay_hours = body.delay_hours
        step.channel = body.channel
        step.message_template = body.message_template
        step.use_ai_personalization = body.use_ai_personalization
        step.updated_at = _now()
        db.commit()
        return step.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.delete("/followups/steps/{step_id}")
def delete_step(step_id: str, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        step = db.query(FollowUpStep).filter(FollowUpStep.id == step_id).first()
        if not step:
            raise HTTPException(status_code=404, detail="Step not found")
        db.delete(step)
        db.commit()
        return {"status": "deleted"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


# -----------------------------------------------------------------------
# Runs (per-lead + control)
# -----------------------------------------------------------------------

@router.get("/followups/runs/by-lead/{lead_id}")
def runs_by_lead(lead_id: str, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        runs = db.query(FollowUpRun).filter(FollowUpRun.lead_id == lead_id).order_by(FollowUpRun.started_at.desc()).all()
        seq_names: dict[str, str] = {}
        out = []
        for r in runs:
            sname = seq_names.get(r.sequence_id)
            if sname is None:
                seq = db.query(FollowUpSequence).filter(FollowUpSequence.id == r.sequence_id).first()
                sname = seq.name if seq else "(deleted)"
                seq_names[r.sequence_id] = sname
            d = r.to_dict()
            d["sequence_name"] = sname
            out.append(d)
        return {"runs": out}
    finally:
        db.close()


@router.get("/followups/runs/{run_id}/events")
def run_events(run_id: str, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        events = db.query(FollowUpEvent).filter(FollowUpEvent.run_id == run_id).order_by(FollowUpEvent.created_at.asc()).all()
        return {"events": [e.to_dict() for e in events]}
    finally:
        db.close()


@router.post("/followups/runs/{run_id}/pause")
def pause_run(run_id: str, user: dict = Depends(require_admin)):
    db = get_db()
    try:
        run = db.query(FollowUpRun).filter(FollowUpRun.id == run_id).first()
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")
        if run.status not in ("active",):
            raise HTTPException(status_code=400, detail=f"Cannot pause a {run.status} run")
        run.status = "paused"
        run.paused_reason = "manual"
        db.add(FollowUpEvent(
            id=str(uuid.uuid4()), run_id=run_id, event_type="paused",
            payload=json.dumps({"reason": "manual"}),
            actor=f"admin:{user.get('sub', '')}", created_at=_now(),
        ))
        db.commit()
        return run.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/followups/runs/{run_id}/resume")
def resume_run(run_id: str, user: dict = Depends(require_admin)):
    db = get_db()
    try:
        run = db.query(FollowUpRun).filter(FollowUpRun.id == run_id).first()
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")
        if run.status != "paused":
            raise HTTPException(status_code=400, detail=f"Cannot resume a {run.status} run")
        run.status = "active"
        run.paused_reason = ""
        if not run.next_due_at:
            run.next_due_at = _now()
        db.add(FollowUpEvent(
            id=str(uuid.uuid4()), run_id=run_id, event_type="resumed",
            payload=json.dumps({}),
            actor=f"admin:{user.get('sub', '')}", created_at=_now(),
        ))
        db.commit()
        return run.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/followups/runs/{run_id}/send-now")
def send_now(run_id: str, user: dict = Depends(require_admin)):
    """Bump next_due_at to now so the next tick fires this step immediately.
    Admin uses this to nudge a sequence forward without waiting for the
    scheduled delay."""
    db = get_db()
    try:
        run = db.query(FollowUpRun).filter(FollowUpRun.id == run_id).first()
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")
        if run.status != "active":
            raise HTTPException(status_code=400, detail=f"Cannot send-now on a {run.status} run")
        run.next_due_at = _now()
        db.add(FollowUpEvent(
            id=str(uuid.uuid4()), run_id=run_id, event_type="send_now_requested",
            payload=json.dumps({}),
            actor=f"admin:{user.get('sub', '')}", created_at=_now(),
        ))
        db.commit()
        return run.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/followups/runs/{run_id}/skip-step")
def skip_step(run_id: str, user: dict = Depends(require_admin)):
    """Advance to the next step without sending the current one. Engine
    will schedule the new step's send based on its delay_hours from now."""
    from datetime import timedelta
    db = get_db()
    try:
        run = db.query(FollowUpRun).filter(FollowUpRun.id == run_id).first()
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")
        if run.status not in ("active", "paused"):
            raise HTTPException(status_code=400, detail=f"Cannot skip on a {run.status} run")
        prev_step = run.current_step or 0
        run.current_step = prev_step + 1
        # Schedule the new step's first send using its delay_hours; if no
        # next step exists, set next_due_at to now so the engine completes
        # the run on the next tick.
        next_step_row = (
            db.query(FollowUpStep)
            .filter(FollowUpStep.sequence_id == run.sequence_id, FollowUpStep.position == run.current_step)
            .first()
        )
        if next_step_row:
            from datetime import datetime as _dt, timezone as _tz
            run.next_due_at = (_dt.now(_tz.utc) + timedelta(hours=float(next_step_row.delay_hours or 0))).isoformat()
        else:
            run.next_due_at = _now()
        db.add(FollowUpEvent(
            id=str(uuid.uuid4()), run_id=run_id, event_type="step_skipped",
            payload=json.dumps({"from_step": prev_step, "to_step": run.current_step}),
            actor=f"admin:{user.get('sub', '')}", created_at=_now(),
        ))
        db.commit()
        return run.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/followups/leads/{lead_id}/clear-dnc")
def clear_do_not_contact(lead_id: str, user: dict = Depends(require_admin)):
    """Clear the do_not_contact flag — used when admin reviews an
    AI-flagged opt-out and decides it was a false positive. Existing
    paused runs stay paused (admin resumes them separately if they want)."""
    del user
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        if not lead.do_not_contact:
            return {"status": "noop", "do_not_contact": False}
        lead.do_not_contact = False
        lead.updated_at = _now()
        db.commit()
        return {"status": "cleared", "do_not_contact": False}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


class StartSequenceBody(BaseModel):
    sequence_id: str


@router.post("/followups/leads/{lead_id}/start-sequence")
def start_sequence_on_lead(lead_id: str, body: StartSequenceBody, user: dict = Depends(require_admin)):
    """Start a sequence on a specific lead (admin-initiated). Distinct
    from test-run in that the target lead is explicit + not flagged as
    test_mode. Used from the Lead Detail intervention panel."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        if not lead.ghl_contact_id:
            raise HTTPException(status_code=400, detail="Lead has no ghl_contact_id — can't send via GHL")
        if lead.do_not_contact:
            raise HTTPException(status_code=400, detail="Lead is marked do_not_contact — clear that first")
        run_id = start_run(
            lead_id=lead_id,
            sequence_id=body.sequence_id,
            actor=f"manual:{user.get('sub', '')}",
            test_mode=False,
        )
        if not run_id:
            raise HTTPException(status_code=500, detail="Failed to start run")
        return {"run_id": run_id, "master_on": is_master_on(db)}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/followups/runs/{run_id}/stop")
def stop_run(run_id: str, user: dict = Depends(require_admin)):
    db = get_db()
    try:
        run = db.query(FollowUpRun).filter(FollowUpRun.id == run_id).first()
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")
        run.status = "stopped"
        run.completed_at = _now()
        db.add(FollowUpEvent(
            id=str(uuid.uuid4()), run_id=run_id, event_type="stopped",
            payload=json.dumps({}),
            actor=f"admin:{user.get('sub', '')}", created_at=_now(),
        ))
        db.commit()
        return run.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


# -----------------------------------------------------------------------
# Test run — admin one-click to start a sequence on the configured test lead
# -----------------------------------------------------------------------

class TestRunBody(BaseModel):
    sequence_id: str
    # Optional override; defaults to SystemConfig CFG_TEST_LEAD_ID, which
    # itself defaults to the first lead whose name contains "Fragne".
    lead_id: Optional[str] = None


@router.post("/followups/test-run")
def start_test_run(body: TestRunBody, user: dict = Depends(require_admin)):
    db = get_db()
    try:
        # Resolve the test lead. Order of precedence:
        #   1. body.lead_id (explicit override)
        #   2. SystemConfig CFG_TEST_LEAD_ID
        #   3. Lead whose contact_name starts with "Fragne"
        lead_id = (body.lead_id or "").strip() or SystemConfig.get(db, CFG_TEST_LEAD_ID, "")
        if not lead_id:
            fragne = db.query(Lead).filter(Lead.contact_name.ilike("Fragne%")).first()
            if fragne:
                lead_id = fragne.id
                SystemConfig.set(db, CFG_TEST_LEAD_ID, lead_id)
        if not lead_id:
            raise HTTPException(
                status_code=400,
                detail="No test lead configured and no lead named 'Fragne …' found. Set test_lead_id in /followups/config first.",
            )

        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail=f"Test lead {lead_id} not found")
        if not lead.ghl_contact_id:
            raise HTTPException(
                status_code=400,
                detail=f"Test lead {lead.contact_name or lead_id} has no ghl_contact_id — can't send via GHL",
            )

        run_id = start_run(
            lead_id=lead_id,
            sequence_id=body.sequence_id,
            actor=f"manual:{user.get('sub', '')}",
            test_mode=True,
        )
        if not run_id:
            raise HTTPException(status_code=500, detail="Failed to start run")
        return {
            "run_id": run_id,
            "lead_id": lead_id,
            "lead_name": lead.contact_name,
            "next_due_at_immediate": True,
            "master_on": is_master_on(db),
            "hint": (
                "If master_on is false, the engine will not actually send. "
                "Flip Settings → Follow-up Engine → Master ON to fire."
            ),
        }
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()
