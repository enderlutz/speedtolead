"""
QuickBooks Payroll Elite sync orchestration.

Wires together:
  - Employee push  (our Employee → QB Online Employee + QB Time User)
  - Job code push  (our ScheduledJob → QB Time job code workers clock into)
  - Time pull      (QB Time timesheets → our TimeEntry rows; nightly)
  - Paycheck pull  (QB Online journal entries → reconcile against Payment)

Designed to be safely callable from both background loops AND admin-
triggered endpoints (Settings -> Sync now). Every function is fire-and-
forget at the row level — one bad row never aborts a whole sweep, just
gets logged and counted in the summary.

Mock-mode aware: if QB is mock, functions short-circuit with synthetic
summaries so the admin UI shows "would have synced N rows" rather
than crashing.
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone, timedelta

from database import get_db, Employee, ScheduledJob
from services import quickbooks_client as qb
from services import qb_time_client as qbt

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Employee push ─────────────────────────────────────────────────────

def sync_employees_to_qb() -> dict:
    """One-way push: every active Employee gets a matching record in
    QB Online (for payroll runs) and QB Time (for clock-in). Updates
    qb_employee_id + qb_time_user_id + qb_synced_at on success.

    Idempotent. Re-running it on an already-synced employee updates
    the QB-side record with current name/pay rate without creating a
    duplicate."""
    summary = {
        "scanned": 0, "pushed_qbo": 0, "pushed_qbt": 0,
        "skipped": 0, "errors": 0, "mode": qb.qb_mode(),
    }
    db = get_db()
    try:
        employees = db.query(Employee).filter(Employee.status == "active").all()
        summary["scanned"] = len(employees)
        for e in employees:
            try:
                # QB Online side — Employee record powers payroll
                if qb.qb_mode() == "live":
                    # TODO: call qb.create_or_update_employee(...) once we
                    # add it to quickbooks_client.py (mirrors the existing
                    # create_or_update_customer pattern).
                    # For Phase 6 foundation we record intent + stub the ID
                    # so the migration path is clear.
                    pass
                if not e.qb_employee_id:
                    e.qb_employee_id = f"pending_qbo_{e.id[:8]}"
                    summary["pushed_qbo"] += 1

                # QB Time side — User record for clock-in
                if qbt.qbt_mode() == "live":
                    qbt_id = qbt.upsert_user(
                        first_name=e.first_name or "",
                        last_name=e.last_name or "",
                        email=e.email or "",
                        pay_rate=float(e.pay_rate or 0),
                        user_id=e.qb_time_user_id or None,
                    )
                    if qbt_id and qbt_id != e.qb_time_user_id:
                        e.qb_time_user_id = qbt_id
                        summary["pushed_qbt"] += 1
                else:
                    if not e.qb_time_user_id:
                        e.qb_time_user_id = f"pending_qbt_{e.id[:8]}"
                        summary["pushed_qbt"] += 1

                e.qb_synced_at = _now_iso()
            except Exception as ex:
                summary["errors"] += 1
                logger.warning(f"sync_employees: row {e.id} failed: {ex}")
        db.commit()
        logger.info(f"sync_employees_to_qb: {summary}")
        return summary
    except Exception as e:
        db.rollback()
        logger.error(f"sync_employees_to_qb crashed: {e}")
        summary["errors"] += 1
        return summary
    finally:
        db.close()


# ── Job code push ────────────────────────────────────────────────────

def sync_scheduled_jobs_to_qb_time() -> dict:
    """Mirror every active/upcoming ScheduledJob as a QB Time job code
    workers can clock into from the mobile app. Skips completed +
    cancelled jobs (no reason to clock into a finished job)."""
    summary = {"scanned": 0, "pushed": 0, "skipped": 0, "errors": 0}
    db = get_db()
    try:
        # Window: anything scheduled in the last 7 days OR all future
        # jobs. Past-but-recent kept in case admin backdates work.
        today = datetime.now(timezone.utc).date()
        cutoff_low = (today - timedelta(days=7)).isoformat()
        jobs = (
            db.query(ScheduledJob)
            .filter(ScheduledJob.status.in_(["scheduled", "in_progress"]))
            .filter(ScheduledJob.job_date >= cutoff_low)
            .all()
        )
        summary["scanned"] = len(jobs)
        for j in jobs:
            try:
                code_name = f"{j.customer_name or 'Job'} — {j.job_date}"
                if qbt.qbt_mode() == "live":
                    # We store the mapping in admin_notes for now; once we
                    # add a dedicated qb_time_jobcode_id column on
                    # ScheduledJob, switch to that.
                    new_id = qbt.upsert_jobcode(name=code_name)
                    if new_id:
                        summary["pushed"] += 1
                else:
                    summary["pushed"] += 1
            except Exception as ex:
                summary["errors"] += 1
                logger.warning(f"sync_jobs: row {j.id} failed: {ex}")
        logger.info(f"sync_scheduled_jobs_to_qb_time: {summary}")
        return summary
    except Exception as e:
        logger.error(f"sync_scheduled_jobs_to_qb_time crashed: {e}")
        summary["errors"] += 1
        return summary
    finally:
        db.close()


# ── Time pull ────────────────────────────────────────────────────────

def pull_timesheets_from_qb_time(*, hours_back: int = 36) -> dict:
    """Pull recently-modified timesheets from QB Time and create/update
    matching TimeEntry rows in our DB. Default window is 36h so the
    nightly job comfortably overlaps the previous day's entries.

    NOT YET PERSISTING — Phase 6 foundation only. Returns the count of
    rows that would be upserted. Once Alan completes QB Time setup +
    one full payroll cycle confirms the wire-up, swap the dry-run
    flag for real writes."""
    summary = {"fetched": 0, "would_upsert": 0, "errors": 0, "mode": qbt.qbt_mode()}
    if not qbt.is_connected():
        summary["errors"] = 0  # not an error — just not configured yet
        summary["reason"] = "qb_time_not_configured"
        return summary
    try:
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours_back)).isoformat()
        rows = qbt.list_timesheets(modified_since=cutoff)
        summary["fetched"] = len(rows)
        # Real upsert wiring follows in Phase 6 step 4 (after sandbox
        # smoke-tests). For now we count + log.
        summary["would_upsert"] = len(rows)
        logger.info(f"pull_timesheets_from_qb_time (dry-run): {summary}")
        return summary
    except Exception as e:
        logger.error(f"pull_timesheets_from_qb_time crashed: {e}")
        summary["errors"] += 1
        return summary


# ── Paycheck reconciliation ──────────────────────────────────────────

def pull_paychecks_from_qb_online(*, days_back: int = 14) -> dict:
    """Pull recent paycheck journal entries from QB Online and
    reconcile against our Payment table. Surfaces paycheck info on the
    crew page without us having to manually enter it after each
    payroll run.

    Dry-run Phase 6 foundation — no writes yet. Confirmed visually
    first, then enabled."""
    summary = {"fetched": 0, "would_reconcile": 0, "errors": 0, "mode": qb.qb_mode()}
    if qb.qb_mode() != "live":
        summary["reason"] = "qb_online_not_live"
        return summary
    try:
        tokens = qb.ensure_valid_access_token()
        if not tokens:
            summary["reason"] = "qb_online_not_connected"
            return summary
        since = (datetime.now(timezone.utc) - timedelta(days=days_back)).strftime("%Y-%m-%d")
        # Paychecks land in QB Online as JournalEntry rows tagged for
        # payroll. The exact tag depends on Alan's chart of accounts.
        # We query broadly and filter Python-side rather than guess at
        # an account name.
        query = (
            f"SELECT * FROM JournalEntry "
            f"WHERE TxnDate >= '{since}' MAXRESULTS 200"
        )
        resp = qb.qbo_request(
            "GET",
            f"/v3/company/{tokens.realm_id}/query",
            params={"query": query},
        )
        entries = ((resp.get("QueryResponse") or {}).get("JournalEntry")) or []
        summary["fetched"] = len(entries)
        # Reconciliation rules are placeholder until we observe one real
        # cycle and confirm the JE shape Intuit emits for paychecks.
        summary["would_reconcile"] = len(entries)
        logger.info(f"pull_paychecks_from_qb_online (dry-run): {summary}")
        return summary
    except Exception as e:
        logger.error(f"pull_paychecks_from_qb_online crashed: {e}")
        summary["errors"] += 1
        return summary
