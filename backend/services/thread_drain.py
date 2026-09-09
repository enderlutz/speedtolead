"""Read customer intent off text threads, for open leads, on a loop.

The text-side twin of the intent drain in services/call_poller.py, with the
same shape and the same guarantees:

  - Only leads still worth calling (the callback list's stage set).
  - A thread is read when it has a chat message newer than its last read —
    so the backlog is read once, and after that a lead is re-read exactly
    when a new text lands. In steady state a run is one cheap query.
  - The running flag comes down in a `finally`, whatever happened, because a
    flag that stays up wedges the drain silently and forever.
  - A read that did not happen (no credit, bad response) writes nothing and
    is retried, so one outage cannot blank out the backlog.
  - A heartbeat in system_config says what the last run did and, when it
    failed, exactly why — the diagnosis that took a day to get for calls.
"""

from __future__ import annotations

import logging
import time
import uuid

from sqlalchemy import desc, func, not_

import clock
from database import Lead, Message, ThreadIntent, get_db
from services.thread_intent import NOT_CHAT_TAGS

logger = logging.getLogger(__name__)

_status: dict = {
    "running": False,
    "started_at": None,
    "completed_at": None,
    "total": 0,
    "done": 0,
    "extracted": 0,
    "failed": 0,
    "remaining": 0,
    "error": None,
    "last_reason": None,
}

_HEARTBEAT_KEY = "thread_drain_last_run"


def get_thread_backlog_status() -> dict:
    return dict(_status)


def _record_heartbeat(note: str) -> None:
    try:
        d = get_db()
        try:
            from database import SystemConfig
            SystemConfig.set(d, _HEARTBEAT_KEY, f"{clock.now_iso()} | {note}"[:900])
        finally:
            d.close()
    except Exception:
        pass    # diagnostics must never break the thing they diagnose


def _open_lead_ids(db) -> set[str]:
    """Leads still worth calling — the callback list's own stage set."""
    from services.pipeline_stages import CALL_LIST_STAGE_IDS
    return {
        lid for (lid,) in db.query(Lead.id)
        .filter(Lead.ghl_pipeline_stage_id.in_(tuple(CALL_LIST_STAGE_IDS)))
        .filter(Lead.is_test == False)  # noqa: E712
        .all()
    }


def _chat_only(query):
    """SQL twin of thread_intent.is_chat, so candidates and reads agree.

    Without this a lead whose only NEW row is an "Opportunity updated"
    activity would look unread after every read, and be re-read forever.
    """
    col = func.upper(func.coalesce(Message.message_type, ""))
    for tag in NOT_CHAT_TAGS:
        query = query.filter(not_(col.like(f"%{tag}%")))
    return query


def leads_needing_a_read(db, limit: int) -> list[tuple[str, str]]:
    """(lead_id, newest chat message time) for open leads with an unread text.

    Newest conversation first, so the reads that matter for today's list land
    first and the long tail fills in behind.
    """
    open_ids = _open_lead_ids(db)
    if not open_ids:
        return []

    q = (
        db.query(Message.lead_id, func.max(Message.created_at))
        .filter(Message.lead_id.in_(tuple(open_ids)))
    )
    newest = {lid: (ts or "") for lid, ts in _chat_only(q).group_by(Message.lead_id).all() if lid}
    if not newest:
        return []

    covered: dict[str, str] = {}
    for lid, through, _created in (
        db.query(ThreadIntent.lead_id, ThreadIntent.through_message_at, ThreadIntent.created_at)
        .filter(ThreadIntent.lead_id.in_(tuple(newest)))
        .order_by(desc(ThreadIntent.created_at))
        .all()
    ):
        if lid not in covered:
            covered[lid] = through or ""

    todo = [(lid, ts) for lid, ts in newest.items() if ts > covered.get(lid, "")]
    todo.sort(key=lambda p: p[1], reverse=True)
    return todo[:max(1, int(limit))]


def extract_thread_backlog(limit: int = 100, sleep_between: float = 0.3) -> dict:
    """Read every open lead's thread that has moved since it was last read."""
    global _status
    if _status.get("running"):
        return get_thread_backlog_status()

    _status = {
        "running": True, "started_at": clock.now_iso(), "completed_at": None,
        "total": 0, "done": 0, "extracted": 0, "failed": 0,
        "remaining": 0, "error": None, "last_reason": None,
    }
    try:
        return _extract_thread_backlog_inner(limit, sleep_between)
    except Exception as e:
        logger.error(f"Thread backlog aborted: {e}", exc_info=True)
        _status["error"] = str(e)
        _record_heartbeat(f"ABORTED: {type(e).__name__}: {e}")
        return get_thread_backlog_status()
    finally:
        _status["running"] = False
        _status["completed_at"] = clock.now_iso()


def _extract_thread_backlog_inner(limit: int, sleep_between: float) -> dict:
    from services.thread_intent import extract_thread_intent

    db = get_db()
    try:
        todo = leads_needing_a_read(db, limit)
        _status["total"] = len(todo)
        logger.info(f"Thread backlog: starting on {len(todo)} lead(s)")
    finally:
        db.close()

    for lead_id, newest_at in todo:
        d = get_db()
        try:
            lead = d.query(Lead).filter(Lead.id == lead_id).first()
            msgs = (
                d.query(Message)
                .filter(Message.lead_id == lead_id)
                .order_by(Message.created_at.asc())
                .all()
            )
            result = extract_thread_intent(
                msgs,
                lead_context={
                    "contact_name": lead.contact_name if lead else "",
                    "address": lead.address if lead else "",
                },
            )
            if not result.get("ok"):
                # The read did not happen. Leave the thread untouched so the
                # next pass retries it, and keep the reason where the
                # heartbeat can carry it.
                _status["failed"] += 1
                _status["last_reason"] = result.get("one_line") or "unknown"
                continue

            d.add(ThreadIntent(
                id=str(uuid.uuid4()),
                lead_id=lead_id,
                through_message_id=result.get("through_message_id") or "",
                # Cover the candidate's newest message even when the reader
                # found nothing to read, or the lead would be a candidate
                # on every run forever.
                through_message_at=result.get("through_message_at") or newest_at,
                message_count=int(result.get("message_count") or 0),
                inbound_count=int(result.get("inbound_count") or 0),
                last_inbound_at=result.get("last_inbound_at") or "",
                last_outbound_at=result.get("last_outbound_at") or "",
                awaiting_reply=bool(result.get("awaiting_reply")),
                wanted=result["wanted"],
                blocker=result["blocker"],
                blocker_detail=result["blocker_detail"],
                commitment=result["commitment"],
                callback_phrase=result["callback_phrase"],
                callback_at=result["callback_at"],
                temperature=result["temperature"],
                one_line=result["one_line"],
                quoted_price_mentioned=bool(result["quoted_price_mentioned"]),
                created_at=clock.now_iso(),
            ))
            d.commit()
            _status["extracted"] += 1
        except Exception as e:
            logger.warning(f"Thread read failed for lead {lead_id}: {e}")
            _status["failed"] += 1
        finally:
            d.close()
            _status["done"] += 1

        if sleep_between:
            time.sleep(sleep_between)

    d = get_db()
    try:
        _status["remaining"] = len(leads_needing_a_read(d, 1_000_000))
    except Exception:
        pass
    finally:
        d.close()

    logger.info(
        f"Thread backlog done: {_status['extracted']} read, "
        f"{_status['failed']} failed, {_status['remaining']} remaining"
    )
    _record_heartbeat(
        f"ran: total={_status['total']} extracted={_status['extracted']} "
        f"failed={_status['failed']} remaining={_status['remaining']} "
        f"last_reason={_status.get('last_reason') or '-'}"
    )
    return get_thread_backlog_status()
