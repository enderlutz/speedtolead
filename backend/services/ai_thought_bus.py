"""
AI Thought Bus — write-side helper for the Operator AI feed.

Any background module (follow-up engine, future procurement watcher, sales
aged-quote scanner) calls `publish(...)` to drop a thought into the
shared AIThought log. The /agents page picks it up via SSE.

Design notes:
  * Observer pattern — modules NEVER auto-execute. They only describe what
    they want to happen via `proposed_action_*`. Admin approves before
    anything mutates.
  * Idempotency — when a module re-detects the same condition (e.g. "23
    aged quotes" → "24 aged quotes"), it should supersede the prior
    thought rather than spamming a new one. Use `supersede_kind` to
    declare a dedup key.
  * Best-effort — bus failures must never crash the calling module. All
    exceptions are caught and logged.
"""
from __future__ import annotations
import json
import logging
import uuid
from datetime import datetime, timezone

from database import get_db, AIThought
from services.event_bus import publish as sse_publish

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def publish(
    *,
    source: str,
    title: str,
    summary: str = "",
    severity: str = "medium",
    category: str = "",
    source_ref_id: str = "",
    proposed_action_text: str = "",
    proposed_action_payload: dict | None = None,
    confidence_pct: int = 70,
    supersede_kind: str = "",
) -> str | None:
    """Write a thought to the bus. Returns the thought ID (None on failure).

    Args:
        source: module name — "followup", "followup_learning", future…
        title: short headline shown in the feed card.
        summary: paragraph of context.
        severity: "low" | "medium" | "high" — drives UI tint + ordering.
        category: human-readable bucket ("Sales", "Field", "Procurement"…).
        source_ref_id: the entity this thought is about (lead_id, run_id…).
        proposed_action_text: human-readable description of the action.
        proposed_action_payload: structured action dict — the approve handler
            uses this to actually execute. Shape is module-specific.
        confidence_pct: 0-100, AI's self-rated confidence.
        supersede_kind: dedup key. If non-empty, any prior active thought
            from the same source + source_ref_id + supersede_kind is
            marked superseded so the feed shows only the latest version.
    """
    db = get_db()
    try:
        if supersede_kind and source_ref_id:
            prior = db.query(AIThought).filter(
                AIThought.source == source,
                AIThought.source_ref_id == source_ref_id,
                AIThought.status == "active",
            ).all()
            for p in prior:
                try:
                    payload = json.loads(p.proposed_action_payload or "{}")
                except Exception:
                    payload = {}
                if payload.get("_kind") == supersede_kind:
                    p.status = "superseded"
                    p.decided_at = _now()

        payload_dict = dict(proposed_action_payload or {})
        if supersede_kind:
            payload_dict["_kind"] = supersede_kind

        thought = AIThought(
            id=str(uuid.uuid4()),
            created_at=_now(),
            source=source,
            source_ref_id=source_ref_id,
            severity=severity if severity in ("low", "medium", "high") else "medium",
            category=category,
            title=title[:200],
            summary=summary,
            proposed_action_text=proposed_action_text,
            proposed_action_payload=json.dumps(payload_dict),
            confidence_pct=max(0, min(100, int(confidence_pct))),
            status="active",
        )
        db.add(thought)
        db.commit()

        try:
            sse_publish("ai_thought", {"id": thought.id, "source": source, "severity": thought.severity, "title": thought.title})
        except Exception:
            pass

        logger.info(f"AI thought published: [{source}/{severity}] {title}")
        return thought.id
    except Exception as e:
        db.rollback()
        logger.error(f"ai_thought_bus.publish failed: {e}")
        return None
    finally:
        db.close()
