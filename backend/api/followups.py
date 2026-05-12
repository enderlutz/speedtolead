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
    CFG_MASTER_ON, CFG_MYCRMSIM_PROVIDER_ID, CFG_TEST_LEAD_ID,
    CFG_IMESSAGE_NUMBER, CFG_SMS_NUMBER,  # legacy, retained for back-compat
    start_run, get_mycrmsim_provider_id, is_master_on,
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
        return {
            "master_on": is_master_on(db),
            "mycrmsim_provider_id": get_mycrmsim_provider_id(db),
            # Legacy fields — surfaced so the UI can show them as deprecated
            # and let admin clear out stale values. Not used by the send path.
            "imessage_from_number": SystemConfig.get(db, CFG_IMESSAGE_NUMBER, ""),
            "sms_from_number": SystemConfig.get(db, CFG_SMS_NUMBER, ""),
            "test_lead_id": SystemConfig.get(db, CFG_TEST_LEAD_ID, ""),
        }
    finally:
        db.close()


class ConfigUpdate(BaseModel):
    master_on: Optional[bool] = None
    mycrmsim_provider_id: Optional[str] = None
    # Legacy — accepted but no longer routed through.
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
        if body.mycrmsim_provider_id is not None:
            SystemConfig.set(db, CFG_MYCRMSIM_PROVIDER_ID, body.mycrmsim_provider_id.strip())
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
    # Send window — defaults match Alan's GHL workflow rule (8 AM - 8 PM CT).
    send_window_start_hour: int = 8
    send_window_end_hour: int = 20
    timezone: str = "America/Chicago"


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
            send_window_start_hour=int(body.send_window_start_hour) if body.send_window_start_hour is not None else 8,
            send_window_end_hour=int(body.send_window_end_hour) if body.send_window_end_hour is not None else 20,
            timezone=(body.timezone or "America/Chicago").strip(),
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
        if body.send_window_start_hour is not None:
            seq.send_window_start_hour = int(body.send_window_start_hour)
        if body.send_window_end_hour is not None:
            seq.send_window_end_hour = int(body.send_window_end_hour)
        if body.timezone:
            seq.timezone = body.timezone.strip()
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
    # New fields supporting the GHL-style workflow editor.
    wait_kind: str = "hours"                 # "minutes" | "hours" | "calendar_day"
    window_start_hour: int | None = None
    window_start_minute: int = 0
    window_end_hour: int | None = None
    window_end_minute: int = 0
    action_kind: str = "send_message"        # "send_message" | "add_tag"
    tag_value: str = ""
    branch_field: str = ""
    variants: dict | None = None             # JSON: {branch_value: body, "_default": fallback}


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
            wait_kind=(body.wait_kind or "hours").strip(),
            window_start_hour=body.window_start_hour,
            window_start_minute=int(body.window_start_minute or 0),
            window_end_hour=body.window_end_hour,
            window_end_minute=int(body.window_end_minute or 0),
            action_kind=(body.action_kind or "send_message").strip(),
            tag_value=(body.tag_value or "").strip(),
            branch_field=(body.branch_field or "").strip(),
            variants=json.dumps(body.variants) if body.variants else "{}",
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
        if body.wait_kind:
            step.wait_kind = body.wait_kind.strip()
        step.window_start_hour = body.window_start_hour
        step.window_start_minute = int(body.window_start_minute or 0)
        step.window_end_hour = body.window_end_hour
        step.window_end_minute = int(body.window_end_minute or 0)
        if body.action_kind:
            step.action_kind = body.action_kind.strip()
        step.tag_value = (body.tag_value or "").strip()
        step.branch_field = (body.branch_field or "").strip()
        if body.variants is not None:
            step.variants = json.dumps(body.variants)
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

class CompileInstructionBody(BaseModel):
    instruction: str


@router.post("/followups/sequences/{seq_id}/compile")
def compile_sequence_instruction(seq_id: str, body: CompileInstructionBody, user: dict = Depends(require_admin)):
    """Translate a natural-language instruction into a proposed sequence
    plan + diff. Does NOT mutate anything — admin reviews then calls
    apply-plan to persist. Used by the workflow editor."""
    del user
    from services.workflow_compiler import compile_instruction, compute_diff
    db = get_db()
    try:
        seq = db.query(FollowUpSequence).filter(FollowUpSequence.id == seq_id).first()
        if not seq:
            raise HTTPException(status_code=404, detail="Sequence not found")
        steps = db.query(FollowUpStep).filter(FollowUpStep.sequence_id == seq_id).order_by(FollowUpStep.position).all()
        current = {
            "sequence_name": seq.name,
            "sequence_description": seq.description or "",
            "trigger_event": seq.trigger_event or "",
            "pause_on_events": seq.pause_on_events or "",
            "steps": [
                {
                    "position": s.position or 0,
                    "delay_hours": float(s.delay_hours or 0),
                    "channel": s.channel or "sms",
                    "message_template": s.message_template or "",
                    "use_ai_personalization": bool(s.use_ai_personalization),
                }
                for s in steps
            ],
        }
        proposed = compile_instruction(current, body.instruction)
        diff = compute_diff(current, proposed)
        return {"current": current, "proposed": proposed, "diff": diff}
    finally:
        db.close()


class ApplyPlanBody(BaseModel):
    plan: dict


@router.post("/followups/sequences/{seq_id}/apply-plan")
def apply_plan(seq_id: str, body: ApplyPlanBody, user: dict = Depends(require_admin)):
    """Persist a compiled plan. Replaces sequence-level fields + ALL
    steps (delete + re-create) inside a single transaction. The version
    counter bumps so the workflow editor can show 'v3 → v4' history."""
    del user
    db = get_db()
    try:
        seq = db.query(FollowUpSequence).filter(FollowUpSequence.id == seq_id).first()
        if not seq:
            raise HTTPException(status_code=404, detail="Sequence not found")
        plan = body.plan or {}
        if "sequence_name" in plan and plan["sequence_name"]:
            seq.name = str(plan["sequence_name"])[:200]
        if "sequence_description" in plan:
            seq.description = str(plan.get("sequence_description") or "")
        if "trigger_event" in plan:
            seq.trigger_event = str(plan.get("trigger_event") or "").strip()
        if "pause_on_events" in plan:
            seq.pause_on_events = str(plan.get("pause_on_events") or "customer_replied").strip()
        if "send_window_start_hour" in plan and plan["send_window_start_hour"] is not None:
            seq.send_window_start_hour = int(plan["send_window_start_hour"])
        if "send_window_end_hour" in plan and plan["send_window_end_hour"] is not None:
            seq.send_window_end_hour = int(plan["send_window_end_hour"])
        if "timezone" in plan and plan["timezone"]:
            seq.timezone = str(plan["timezone"]).strip()
        # Replace steps. Drop existing, then re-create from plan. New
        # fields (wait_kind, window_*, action_kind, tag_value, branch_field,
        # variants) round-trip so the editor can save without losing data.
        db.query(FollowUpStep).filter(FollowUpStep.sequence_id == seq_id).delete()
        steps_in = plan.get("steps") or []
        for i, s in enumerate(steps_in):
            variants_in = s.get("variants")
            if isinstance(variants_in, dict):
                variants_str = json.dumps(variants_in)
            elif isinstance(variants_in, str) and variants_in.strip():
                variants_str = variants_in
            else:
                variants_str = "{}"
            db.add(FollowUpStep(
                id=str(uuid.uuid4()),
                sequence_id=seq_id,
                position=int(s.get("position", i)),
                delay_hours=float(s.get("delay_hours", 24)),
                channel=str(s.get("channel") or "sms"),
                message_template=str(s.get("message_template") or "")[:1200],
                use_ai_personalization=bool(s.get("use_ai_personalization", False)),
                wait_kind=str(s.get("wait_kind") or "hours"),
                window_start_hour=s.get("window_start_hour") if s.get("window_start_hour") is not None else None,
                window_start_minute=int(s.get("window_start_minute") or 0),
                window_end_hour=s.get("window_end_hour") if s.get("window_end_hour") is not None else None,
                window_end_minute=int(s.get("window_end_minute") or 0),
                action_kind=str(s.get("action_kind") or "send_message"),
                tag_value=str(s.get("tag_value") or ""),
                branch_field=str(s.get("branch_field") or ""),
                variants=variants_str,
                created_at=_now(),
                updated_at=_now(),
            ))
        seq.version = (seq.version or 1) + 1
        seq.updated_at = _now()
        db.commit()
        return {"sequence": seq.to_dict(), "step_count": len(steps_in)}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


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

        # Surface common misconfig states in the response — the toast on
        # the frontend reads these and warns admin loudly instead of
        # pretending everything's fine.
        seq = db.query(FollowUpSequence).filter(FollowUpSequence.id == body.sequence_id).first()
        if not seq:
            raise HTTPException(404, "Sequence not found")
        seq_active = bool(seq.active)
        master_on = is_master_on(db)

        run_id = start_run(
            lead_id=lead_id,
            sequence_id=body.sequence_id,
            actor=f"manual:{user.get('sub', '')}",
            test_mode=True,
        )
        if not run_id:
            raise HTTPException(status_code=500, detail="Failed to start run")

        warnings: list[str] = []
        if not master_on:
            warnings.append("Engine master is OFF — flip Settings → Follow-up Engine → Master to ON to fire.")
        if not seq_active:
            warnings.append("This sequence is INACTIVE — the run will pause itself on the next tick until you enable the sequence.")

        return {
            "run_id": run_id,
            "lead_id": lead_id,
            "lead_name": lead.contact_name,
            "next_due_at_immediate": True,
            "master_on": master_on,
            "sequence_active": seq_active,
            "warnings": warnings,
            "hint": " ".join(warnings) if warnings else "All set — engine will fire on the next tick (within 5 min).",
        }
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()
