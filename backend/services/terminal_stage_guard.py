"""
Terminal-stage guard — stops all active follow-up runs on a lead when
it enters a "terminal" pipeline stage.

Replaces Alan's GHL workflow U02 "Stop Workflows in Terminal Stages."
When a lead is declined, escalated to top priority, or has the deal
closed (scheduled or not), all in-flight nurture sequences should stop.
Continuing to text a customer after they've declined or scheduled is
either annoying or actively harmful.

Trigger surfaces (any of these calls the guard):
  - The engine's `move_column` action (catches our own end-of-flow moves)
  - The poller's stage-sync path (catches manual GHL moves within 5 min)
  - Future: a GHL OpportunityStageChanged webhook for real-time response

Kill-switch via the "U02 Stop Workflows in Terminal Stages" shell
sequence — toggle Active off in the workflow editor to disable.
"""
from __future__ import annotations
import json
import logging
import uuid
from datetime import datetime, timezone

from database import get_db, FollowUpRun, FollowUpEvent

logger = logging.getLogger(__name__)


# Stage IDs that count as terminal — entering any of these stops all
# active follow-up runs on the lead. The first 4 come from Alan's U02
# GHL spec verbatim; "Cold Leads (Never answered)" is added as a
# defensive measure so that if Olga ever moves a lead there manually
# while a sequence is mid-flow (e.g. mid-P06 LTN nurture), the rest
# of the cadence stops. To add/remove a terminal stage, edit this set.
TERMINAL_STAGE_IDS: frozenset[str] = frozenset({
    "f207a600-81c9-4150-941c-e977ea876929",  # DECLINED ESTIMATE
    "147bd53b-3848-449d-b7c2-7a2cfad2a5f5",  # Top Priority-Responded to Estimate
    "bbebbdac-0011-4253-9ed7-65522bafde02",  # DEAL CLOSED & NOT SCHEDULED
    "3eed5964-573f-445e-a181-1ee28068f066",  # CLOSED & SCHEDULED
    "0ca2e2a6-2990-4a5b-8ace-608393e39b5a",  # Cold Leads (Never answered)
})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def is_terminal_stage(stage_id: str) -> bool:
    """True if `stage_id` is one of the configured terminal stages."""
    return (stage_id or "") in TERMINAL_STAGE_IDS


def on_pipeline_stage_changed(
    lead_id: str, new_stage_id: str, exclude_run_id: str | None = None,
) -> int:
    """Pause every active follow-up run on `lead_id` if `new_stage_id`
    is terminal. Returns the count of runs paused.

    `exclude_run_id` skips the named run — used when the engine's
    move_column action calls this guard mid-step so the current run can
    finish advancing normally instead of pausing itself mid-execution.

    Idempotent and best-effort. Already-paused / completed / failed
    runs are left alone. The pause sets `paused_reason="terminal_stage"`
    so admin can identify these in the run history.

    Skipped entirely when the U02 shell sequence is toggled inactive in
    the workflow editor (lazy import to avoid a circular dependency
    with services.followup_engine)."""
    if not is_terminal_stage(new_stage_id):
        return 0

    # Lazy import — services.followup_engine imports from this module
    # indirectly via the run advancer wiring.
    try:
        from services.followup_engine import (
            is_external_workflow_active,
            EXTERNAL_WORKFLOW_U02_NAME,
        )
        if not is_external_workflow_active(EXTERNAL_WORKFLOW_U02_NAME):
            return 0
    except Exception as e:
        logger.warning(f"U02 active-check failed (proceeding with default-on): {e}")

    db = get_db()
    paused = 0
    try:
        query = db.query(FollowUpRun).filter(
            FollowUpRun.lead_id == lead_id,
            FollowUpRun.status == "active",
        )
        if exclude_run_id:
            query = query.filter(FollowUpRun.id != exclude_run_id)
        runs = query.all()
        if not runs:
            return 0
        for run in runs:
            run.status = "paused"
            run.paused_reason = "terminal_stage"
            db.add(FollowUpEvent(
                id=str(uuid.uuid4()),
                run_id=run.id,
                event_type="paused",
                payload=json.dumps({
                    "reason": "terminal_stage",
                    "stage_id": new_stage_id,
                }),
                actor="system:u02",
                created_at=_now(),
            ))
            paused += 1
        db.commit()
        logger.info(
            f"U02 terminal-stage guard: paused {paused} active run(s) for "
            f"lead {lead_id} entering stage {new_stage_id}"
        )
        return paused
    except Exception as e:
        db.rollback()
        logger.error(f"U02 on_pipeline_stage_changed failed for {lead_id}: {e}")
        return 0
    finally:
        db.close()
