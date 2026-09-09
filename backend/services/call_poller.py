"""
GHL call recording poller.

Pulls call audio out of GoHighLevel and runs it through transcription (and
optionally analysis). GHL does NOT expose transcripts — it exposes the WAV,
via /conversations/messages/{id}/locations/{lid}/recording, confirmed by the
2026-06-07 probe. The text is made here with Deepgram.

Three entry points, deliberately separate:
  poll_ghl_call_recordings — the background rotation. Talks to GHL.
  transcribe_backlog       — catches up recordings whose audio we already
                             hold. Talks to Deepgram only, never GHL.
  process_recording_pipeline — one recording, transcribe → analyze.
"""
from __future__ import annotations
import uuid
import json
import logging
import httpx
from datetime import datetime, timezone
from config import get_settings
from database import get_db, CallRecording, Lead
import clock
from services.ghl import GHL_BASE, _headers

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def probe_ghl_call_endpoints(lead) -> dict:
    """Sprint 4 T4.A probe (2026-06-07). Hits the three most likely GHL
    endpoints for finding call recordings and returns the raw response
    shape from each so we can see what GHL actually exposes for this
    account before committing to a code path. Admin-only via the
    /calls/ghl-call-probe endpoint that wraps this.

    Probes (in order):
      1. /conversations/search?contactId=...  (lists conversation IDs)
      2. /conversations/{cid}/messages         (per-conversation messages,
          calls usually arrive as messageType TYPE_CALL with a recordingUrl)
      3. /conversations/calls?contactId=...    (guess — a direct calls list)

    Returns a structured dict with status codes + body snippets for each."""
    contact_id = (lead.ghl_contact_id or "").strip()
    location_id = (lead.ghl_location_id or "").strip() or None
    if not contact_id:
        return {"error": "Lead has no ghl_contact_id"}

    out: dict = {
        "lead_id": lead.id,
        "ghl_contact_id": contact_id,
        "ghl_location_id": location_id or "",
        "probes": [],
    }
    headers = _headers(location_id)

    # --- Probe 1: list conversations for this contact ---
    convo_id_for_step_2 = None
    try:
        r = httpx.get(
            f"{GHL_BASE}/conversations/search",
            params={"contactId": contact_id, "limit": 20},
            headers=headers,
            timeout=15,
        )
        body_preview = r.text[:600]
        try:
            payload = r.json()
        except Exception:
            payload = None
        # Try to grab a conversation id to use in probe 2
        if payload and isinstance(payload, dict):
            convos = payload.get("conversations") or []
            if convos:
                convo_id_for_step_2 = convos[0].get("id")
        out["probes"].append({
            "name": "1_conversations_search",
            "url": f"{GHL_BASE}/conversations/search?contactId={contact_id}&limit=20",
            "status_code": r.status_code,
            "body_preview": body_preview,
            "first_conversation_id": convo_id_for_step_2,
        })
    except Exception as e:
        out["probes"].append({"name": "1_conversations_search", "error": str(e)})

    # --- Probe 2: fetch messages for that first conversation (calls usually
    #              arrive here as TYPE_CALL message records with a recordingUrl) ---
    first_call_message_id: str | None = None
    if convo_id_for_step_2:
        try:
            r = httpx.get(
                f"{GHL_BASE}/conversations/{convo_id_for_step_2}/messages",
                params={"limit": 50},
                headers=headers,
                timeout=15,
            )
            body_preview = r.text[:2000]   # bigger preview here — we want to see the call shape
            # Hunt for any messageType that smells like a call
            call_message_samples: list = []
            try:
                payload = r.json()
                msgs = (payload.get("messages") or {}).get("messages") or []
                for m in msgs:
                    mt = (m.get("messageType") or m.get("type") or "").upper()
                    if "CALL" in mt:
                        # Cache the first CALL id so probes 4–6 can use it
                        # to find the recording endpoint.
                        if first_call_message_id is None:
                            first_call_message_id = m.get("id")
                        call_message_samples.append({
                            "id": m.get("id"),
                            "messageType": mt,
                            "direction": m.get("direction"),
                            "dateAdded": m.get("dateAdded"),
                            "duration": m.get("duration"),
                            "recordingUrl": m.get("recordingUrl"),
                            "attachments": m.get("attachments"),
                            "meta": m.get("meta"),
                            "raw_keys": list(m.keys()),
                        })
                        if len(call_message_samples) >= 3:
                            break
            except Exception:
                pass
            out["probes"].append({
                "name": "2_conversation_messages",
                "url": f"{GHL_BASE}/conversations/{convo_id_for_step_2}/messages",
                "status_code": r.status_code,
                "body_preview": body_preview,
                "call_message_samples": call_message_samples,
            })
        except Exception as e:
            out["probes"].append({"name": "2_conversation_messages", "error": str(e)})

    # --- Probe 3: speculative direct calls endpoint ---
    try:
        r = httpx.get(
            f"{GHL_BASE}/conversations/calls",
            params={"contactId": contact_id, "limit": 20},
            headers=headers,
            timeout=15,
        )
        out["probes"].append({
            "name": "3_direct_calls_endpoint_guess",
            "url": f"{GHL_BASE}/conversations/calls?contactId={contact_id}",
            "status_code": r.status_code,
            "body_preview": r.text[:600],
        })
    except Exception as e:
        out["probes"].append({"name": "3_direct_calls_endpoint_guess", "error": str(e)})

    # --- Probes 4–6: ONLY fire when we have a real TYPE_CALL message id from
    #                 probe 2. These pinpoint the recording URL location.
    if first_call_message_id:
        # 4 — single message detail endpoint. Some GHL accounts return the
        #     recordingUrl ONLY here, not in the list response.
        try:
            r = httpx.get(
                f"{GHL_BASE}/conversations/messages/{first_call_message_id}",
                headers=headers,
                timeout=15,
            )
            # Try to surface keys + key recording-relevant fields cleanly.
            sample = None
            try:
                pj = r.json()
                if isinstance(pj, dict):
                    sample = {
                        "raw_keys": list(pj.keys()),
                        "recordingUrl": pj.get("recordingUrl"),
                        "attachments": pj.get("attachments"),
                        "meta": pj.get("meta"),
                        # Some GHL accounts nest under .message
                        "nested_message_keys": list((pj.get("message") or {}).keys()) if isinstance(pj.get("message"), dict) else None,
                    }
            except Exception:
                pass
            out["probes"].append({
                "name": "4_single_message_detail",
                "url": f"{GHL_BASE}/conversations/messages/{first_call_message_id}",
                "status_code": r.status_code,
                "body_preview": r.text[:1200],
                "sample": sample,
            })
        except Exception as e:
            out["probes"].append({"name": "4_single_message_detail", "error": str(e)})

        # 5 — the documented recording endpoint shape. If 200 with audio
        #     content-type, this is our integration path: stream the body
        #     to disk and feed it into the existing transcriber.
        try:
            url_5 = (
                f"{GHL_BASE}/conversations/messages/{first_call_message_id}"
                f"/locations/{location_id}/recording" if location_id
                else f"{GHL_BASE}/conversations/messages/{first_call_message_id}/recording"
            )
            r = httpx.get(url_5, headers=headers, timeout=20)
            out["probes"].append({
                "name": "5_recording_endpoint",
                "url": url_5,
                "status_code": r.status_code,
                "content_type": r.headers.get("content-type", ""),
                "content_length_bytes": len(r.content),
                # Tiny preview — first 200 chars only since this might be binary.
                "body_preview": r.text[:200] if "json" in r.headers.get("content-type", "").lower() else f"<binary, {len(r.content)} bytes>",
            })
        except Exception as e:
            out["probes"].append({"name": "5_recording_endpoint", "error": str(e)})

        # 6 — transcription endpoint (bonus). If GHL transcribes calls
        #     server-side we can skip Deepgram entirely.
        try:
            url_6 = (
                f"{GHL_BASE}/conversations/messages/{first_call_message_id}"
                f"/locations/{location_id}/transcription" if location_id
                else f"{GHL_BASE}/conversations/messages/{first_call_message_id}/transcription"
            )
            r = httpx.get(url_6, headers=headers, timeout=15)
            out["probes"].append({
                "name": "6_transcription_endpoint",
                "url": url_6,
                "status_code": r.status_code,
                "body_preview": r.text[:600],
            })
        except Exception as e:
            out["probes"].append({"name": "6_transcription_endpoint", "error": str(e)})

    out["first_call_message_id"] = first_call_message_id
    return out


# Module-level state for the one-shot Sterling backfill. Lives in memory
# only — survives mid-run with per-lead commits, but a process restart
# loses the progress dict (the DB rows persist either way). Operator can
# re-fire the endpoint; idempotency makes that safe.
_backfill_status: dict = {
    "running": False,
    "started_at": None,
    "completed_at": None,
    "scanned": 0,
    "total": 0,
    "new_recordings": 0,
    # [{lead_id, contact_name, new_recordings, calls_found}] — populated
    # as soon as a lead's ingest finishes with > 0 new recordings.
    "collected_leads": [],
    "error": None,
}


# ─── Transcription backlog ───────────────────────────────────────────────
# State for the one-time catch-up over recordings the commit-ordering bug
# above left stranded at status "pending". Same shape/contract as the
# Sterling backfill status so the UI can poll it the same way.
_transcribe_status: dict = {
    "running": False,
    "started_at": None,
    "completed_at": None,
    "total": 0,          # how many we set out to do this run
    "done": 0,           # attempted (transcribed + failed)
    "transcribed": 0,
    "failed": 0,
    "remaining": 0,      # still pending after this run
    "error": None,
}


def get_transcribe_backlog_status() -> dict:
    return dict(_transcribe_status)


def transcribe_backlog(limit: int = 200, sleep_between: float = 0.5,
                      transcribe_only: bool = True) -> dict:
    """Run stranded `pending` recordings through transcribe → analyze.

    Newest first, because the most recent calls are the ones worth mining.
    Only touches status == "pending" and only rows that actually have audio,
    so it's safe to re-run: anything already transcribed is skipped, and a
    half-finished run just resumes where it stopped.

    Deepgram bills per minute of audio, so `limit` is deliberately required
    to be small by default — run 200, check the results, then decide.

    transcribe_only defaults to True: a catch-up over old recordings wants
    the text, not a Claude analysis of every one. Deepgram is fractions of a
    cent per call; the analysis is what exhausted the API credits last time.
    Pass transcribe_only=False to run the full pipeline."""
    global _transcribe_status
    if _transcribe_status.get("running"):
        return get_transcribe_backlog_status()

    _transcribe_status = {
        "running": True, "started_at": _now(), "completed_at": None,
        "total": 0, "done": 0, "transcribed": 0, "failed": 0,
        "remaining": 0, "error": None,
    }
    try:
        return _transcribe_backlog_inner(limit, sleep_between, transcribe_only)
    except Exception as e:
        # Same guarantee as the intent drain: the flag must always come down.
        # This path works today, but one unhandled exception would wedge it
        # permanently and silently, and a backlog nobody can see stalling is
        # exactly how 1,728 calls sat untranscribed for three months.
        logger.error(f"Transcribe backlog aborted: {e}", exc_info=True)
        _transcribe_status["error"] = str(e)
        return get_transcribe_backlog_status()
    finally:
        _transcribe_status["running"] = False
        _transcribe_status["completed_at"] = _now()


def _transcribe_backlog_inner(limit: int, sleep_between: float,
                              transcribe_only: bool) -> dict:
    import time

    db = get_db()
    try:
        ids = [
            r[0] for r in db.query(CallRecording.id)
            .filter(
                CallRecording.status == "pending",
                CallRecording.has_recording_data.is_(True),
            )
            .order_by(CallRecording.created_at.desc())
            .limit(max(1, int(limit)))
            .all()
        ]
        _transcribe_status["total"] = len(ids)
        logger.info(f"Transcription backlog: starting on {len(ids)} recording(s)")
    finally:
        db.close()

    for rid in ids:
        try:
            # Opens and closes its own session per recording, and sets the
            # row's own status — so a crash mid-run loses at most one.
            process_recording_pipeline(rid, transcribe_only=transcribe_only)
        except Exception as e:
            logger.warning(f"Backlog pipeline failed for {rid}: {e}")
        finally:
            _transcribe_status["done"] += 1

        d = get_db()
        try:
            row = d.query(CallRecording.status).filter(CallRecording.id == rid).first()
            if row and row[0] in ("transcribed", "analyzed"):
                _transcribe_status["transcribed"] += 1
            else:
                _transcribe_status["failed"] += 1
        finally:
            d.close()

        if sleep_between:
            time.sleep(sleep_between)      # be kind to Deepgram's rate limits

    db = get_db()
    try:
        _transcribe_status["remaining"] = (
            db.query(CallRecording)
            .filter(CallRecording.status == "pending",
                    CallRecording.has_recording_data.is_(True))
            .count()
        )
    finally:
        db.close()

    logger.info(
        f"Transcription backlog done: {_transcribe_status['transcribed']} transcribed, "
        f"{_transcribe_status['failed']} failed, {_transcribe_status['remaining']} still pending"
    )
    return get_transcribe_backlog_status()


def get_backfill_status() -> dict:
    """Snapshot of the current Sterling-backfill state for the UI poll
    endpoint. Returns a shallow copy so the caller can't mutate the
    live dict."""
    snap = dict(_backfill_status)
    # The list is the only mutable nested value — copy it explicitly.
    snap["collected_leads"] = list(_backfill_status["collected_leads"])
    return snap


def backfill_v2_call_recordings(lookback_days: int = 90, sleep_between_leads: float = 1.0) -> dict:
    """One-shot backfill for Sterling (v2 pipeline) leads.

    Walks every NON-test, NON-archived v2 lead with a GHL contact id whose
    created_at or updated_at falls in the lookback window, ingests every
    new TYPE_CALL recording, and hands each off to the existing
    transcribe-then-analyze pipeline. Same idempotency guarantees as the
    10-min poller (`_ingest_calls_for_lead` dedupes by ghl_call_id), so
    re-running is safe and won't double-bill Deepgram.

    Throttling: `sleep_between_leads` seconds between leads so a large
    batch doesn't trip GHL's per-key rate limits and collateral-damage
    the live dashboard. Default 1.0s — at 500 leads that's ~8 min of
    pure sleep plus the actual fetch time.

    Intended for the admin POST /api/calls/backfill-sterling endpoint,
    fired as a BackgroundTask (the run can take 30-90 min for a full
    90-day backfill, well past any HTTP request timeout)."""
    import time
    from datetime import timedelta
    settings = get_settings()
    if not settings.ghl_api_key:
        return {"status": "skipped", "reason": "ghl_api_key not set"}

    cutoff_iso = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).isoformat()
    # Initialize the live status the UI polls. Reset on every fresh run
    # so the previous run's state doesn't bleed through.
    _backfill_status.update({
        "running": True,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "completed_at": None,
        "scanned": 0,
        "total": 0,
        "new_recordings": 0,
        "collected_leads": [],
        "error": None,
    })

    db = get_db()
    summary = {
        "lookback_days": lookback_days,
        "leads_scanned": 0,
        "calls_found": 0,
        "new_recordings": 0,
        "skipped_dedup": 0,
        "skipped_incomplete": 0,
        "audio_fetch_failed": 0,
        "errors": [],
    }
    try:
        leads = (
            db.query(Lead)
            .filter(Lead.ghl_contact_id.isnot(None), Lead.ghl_contact_id != "")
            .filter(Lead.is_test == False)                      # noqa: E712
            .filter(Lead.pipeline_version == "v2")              # Sterling only
            .filter(Lead.status != "archived")                  # skip archived
            .filter(
                (Lead.updated_at >= cutoff_iso) | (Lead.created_at >= cutoff_iso)
            )
            .all()
        )
        total = len(leads)
        _backfill_status["total"] = total
        logger.info(f"[backfill v2] starting — {total} Sterling leads in window")

        for i, lead in enumerate(leads, start=1):
            try:
                lead_stats = _ingest_calls_for_lead(db, lead)
                summary["calls_found"] += lead_stats["calls_found"]
                summary["new_recordings"] += lead_stats["new_recordings"]
                summary["skipped_dedup"] += lead_stats["skipped_dedup"]
                summary["skipped_incomplete"] += lead_stats["skipped_incomplete"]
                summary["audio_fetch_failed"] += lead_stats["audio_fetch_failed"]
                summary["leads_scanned"] += 1
                # Commit per-lead so progress survives a mid-run crash —
                # no need to redo the first 200 leads if lead 201 explodes.
                db.commit()
                # Live status update for the UI poll. Only leads that
                # actually contributed new recordings show up in the
                # collected_leads list — the "give me a list of names
                # we got transcripts for" the owner asked for.
                if lead_stats["new_recordings"] > 0:
                    _backfill_status["collected_leads"].append({
                        "lead_id": lead.id,
                        "contact_name": lead.contact_name or "(no name)",
                        "new_recordings": lead_stats["new_recordings"],
                        "calls_found": lead_stats["calls_found"],
                    })
                _backfill_status["new_recordings"] = summary["new_recordings"]
            except Exception as e:
                logger.warning(f"[backfill v2] lead {lead.id} ingest failed: {e}")
                summary["errors"].append({"lead_id": lead.id, "error": str(e)})
                db.rollback()
            _backfill_status["scanned"] = i

            # Progress every 25 leads keeps Railway log noise manageable
            # while still letting Alan watch it churn.
            if i % 25 == 0 or i == total:
                logger.info(
                    f"[backfill v2] progress {i}/{total} — "
                    f"new_recordings={summary['new_recordings']} "
                    f"dedup={summary['skipped_dedup']} "
                    f"fetch_failed={summary['audio_fetch_failed']}"
                )

            # Throttle between leads. Skip the sleep on the very last
            # iteration so we don't add unnecessary latency at the tail.
            if i < total and sleep_between_leads > 0:
                time.sleep(sleep_between_leads)

        logger.info(
            f"[backfill v2] COMPLETE — scanned={summary['leads_scanned']} "
            f"calls_found={summary['calls_found']} "
            f"new_recordings={summary['new_recordings']} "
            f"dedup={summary['skipped_dedup']} "
            f"fetch_failed={summary['audio_fetch_failed']} "
            f"errors={len(summary['errors'])}"
        )
        _backfill_status["running"] = False
        _backfill_status["completed_at"] = datetime.now(timezone.utc).isoformat()
        return summary
    except Exception as e:
        logger.error(f"[backfill v2] outer error: {e}")
        summary["error"] = str(e)
        _backfill_status["running"] = False
        _backfill_status["completed_at"] = datetime.now(timezone.utc).isoformat()
        _backfill_status["error"] = str(e)
        return summary
    finally:
        db.close()


def poll_ghl_call_recordings(lookback_days: int = 60, max_leads: int = 80) -> dict:
    """Sprint 4 T4.A (2026-06-08). Walk recent leads, fetch new
    TYPE_CALL messages from GHL, download the WAV audio via the
    /conversations/messages/{id}/locations/{lid}/recording endpoint
    (confirmed by the 2026-06-07 probe — returns audio/x-wav binary
    directly), persist as CallRecording rows, and kick the existing
    transcribe→analyze pipeline.

    Scope (intentional cost control — every lead = a GHL API call):
      - Leads created OR updated in the last `lookback_days` days
      - Excludes is_test leads
      - Takes the `max_leads` LEAST-RECENTLY-CHECKED of those, so the
        eligible set rotates and every lead comes up in turn
      - Idempotent: dedupes by ghl_call_id, skips calls already in our DB

    The rotation is the point. This used to take an arbitrary `.limit(200)`
    with no ordering, which meant the same 200 leads were re-scanned every
    ten minutes forever while 731 eligible leads were NEVER checked — their
    calls simply never entered the system. Ordering on calls_checked_at
    covers all 931 for LESS traffic than the old design used on 200, because
    the waste was re-asking about the same leads 144 times a day.

    Returns a per-run summary the caller (poller schedule / admin
    trigger endpoint) can log."""
    settings = get_settings()
    if not settings.ghl_api_key:
        return {"status": "skipped", "reason": "ghl_api_key not set"}

    from datetime import timedelta
    cutoff_iso = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).isoformat()

    db = get_db()
    summary = {
        "leads_scanned": 0,
        "calls_found": 0,
        "new_recordings": 0,
        "skipped_dedup": 0,
        "skipped_incomplete": 0,
        "audio_fetch_failed": 0,
        "errors": [],
    }
    try:
        leads = (
            db.query(Lead)
            .filter(Lead.ghl_contact_id.isnot(None), Lead.ghl_contact_id != "")
            .filter(Lead.is_test == False)  # noqa: E712 SQLAlchemy needs ==
            .filter(
                (Lead.updated_at >= cutoff_iso) | (Lead.created_at >= cutoff_iso)
            )
            # Least-recently-checked first. calls_checked_at defaults to "",
            # which sorts before any ISO timestamp, so leads never checked
            # come up ahead of everything else.
            .order_by(Lead.calls_checked_at.asc())
            .limit(max_leads)
            .all()
        )

        for lead in leads:
            try:
                lead_stats = _ingest_calls_for_lead(db, lead)
                summary["calls_found"] += lead_stats["calls_found"]
                summary["new_recordings"] += lead_stats["new_recordings"]
                summary["skipped_dedup"] += lead_stats["skipped_dedup"]
                summary["skipped_incomplete"] += lead_stats["skipped_incomplete"]
                summary["audio_fetch_failed"] += lead_stats["audio_fetch_failed"]
                summary["leads_scanned"] += 1
            except Exception as e:
                logger.warning(f"poll_ghl_call_recordings: lead {lead.id} ingest failed: {e}")
                summary["errors"].append({"lead_id": lead.id, "error": str(e)})
            finally:
                # Stamp even when the ingest raised. A lead that reliably
                # fails would otherwise stay at the front of the queue and
                # block the rotation forever — one bad lead starving all
                # the others is a worse outcome than skipping it this pass.
                lead.calls_checked_at = _now()

        db.commit()
        logger.info(
            f"[call poller] scanned={summary['leads_scanned']} "
            f"new_recordings={summary['new_recordings']} "
            f"dedup={summary['skipped_dedup']} "
            f"incomplete={summary['skipped_incomplete']} "
            f"fetch_failed={summary['audio_fetch_failed']}"
        )
        return summary

    except Exception as e:
        logger.error(f"poll_ghl_call_recordings outer error: {e}")
        summary["error"] = str(e)
        return summary
    finally:
        db.close()


def _ingest_calls_for_lead(db, lead) -> dict:
    """Fetch one lead's conversations + their messages, persist new
    TYPE_CALL completed-status messages as CallRecording rows, and
    fire the transcribe→analyze pipeline for each. Returns per-lead
    counts the caller aggregates."""
    from services.ghl import get_conversations, get_conversation_messages
    import uuid as _uuid

    stats = {
        "calls_found": 0,
        "new_recordings": 0,
        "skipped_dedup": 0,
        "skipped_incomplete": 0,
        "audio_fetch_failed": 0,
    }

    contact_id = (lead.ghl_contact_id or "").strip()
    location_id = (lead.ghl_location_id or "").strip() or None
    if not contact_id:
        return stats

    conversations = get_conversations(contact_id, location_id)
    for convo in conversations:
        convo_id = convo.get("id")
        if not convo_id:
            continue
        messages = get_conversation_messages(convo_id, location_id)
        for msg in messages:
            msg_type = (msg.get("messageType") or "").upper()
            if msg_type != "TYPE_CALL":
                continue
            stats["calls_found"] += 1

            msg_id = msg.get("id", "")
            if not msg_id:
                continue

            # Dedupe — we already have this call in the DB.
            existing = (
                db.query(CallRecording)
                .filter(CallRecording.ghl_call_id == msg_id)
                .first()
            )
            if existing:
                stats["skipped_dedup"] += 1
                continue

            # Skip incomplete calls — no recording to download.
            call_meta = (msg.get("meta") or {}).get("call") or {}
            call_status = (call_meta.get("status") or "").lower()
            if call_status != "completed":
                stats["skipped_incomplete"] += 1
                continue

            duration = int(call_meta.get("duration") or 0)
            # Skip really short calls (< 5 sec) — usually instant hangups
            # with no useful audio. Keeps Deepgram tokens from being
            # burned on silence.
            if duration < 5:
                stats["skipped_incomplete"] += 1
                continue

            audio_bytes = _fetch_recording_audio(msg_id, location_id)
            if not audio_bytes:
                stats["audio_fetch_failed"] += 1
                continue

            # Persist. recording_data is deferred at the model level so
            # this row only loads the BLOB on explicit access — listing
            # endpoints stay cheap.
            recording = CallRecording(
                id=str(_uuid.uuid4()),
                lead_id=lead.id,
                ghl_contact_id=contact_id,
                ghl_location_id=location_id or "",
                ghl_call_id=msg_id,
                recording_data=audio_bytes,
                has_recording_data=True,
                duration_seconds=duration,
                call_direction=(msg.get("direction") or "outbound"),
                caller_name="",  # T4.D will resolve userId → User.name later
                status="pending",
                created_at=msg.get("dateAdded") or _now(),
            )
            db.add(recording)
            # COMMIT, not flush. process_recording_pipeline() opens its own
            # session and looks the recording up by id — on a flush the row is
            # still inside this uncommitted transaction, so that lookup finds
            # nothing, logs "Recording not found", and returns. The row then
            # commits with status "pending" and nothing ever retries it.
            #
            # That is exactly how 2,121 GHL-ingested recordings ended up stuck:
            # every hand-uploaded call transcribed fine (that path commits
            # first) while not one auto-ingested call ever reached Deepgram.
            db.commit()
            stats["new_recordings"] += 1

            # Kick the pipeline. Best-effort — failures here don't
            # roll back the row write since the manual analyze endpoint
            # can retry later if Deepgram is having a moment.
            try:
                process_recording_pipeline(recording.id)
            except Exception as e:
                logger.warning(f"Pipeline kick failed for {recording.id}: {e}")

    return stats


def _fetch_recording_audio(message_id: str, location_id: str | None) -> bytes | None:
    """GET the WAV audio for a GHL call message via the endpoint the
    2026-06-07 probe confirmed:
        /conversations/messages/{messageId}/locations/{locationId}/recording
    Returns the binary bytes on success, None on any failure (logged)."""
    if not message_id:
        return None
    try:
        if location_id:
            url = f"{GHL_BASE}/conversations/messages/{message_id}/locations/{location_id}/recording"
        else:
            # Fallback when somehow a lead has no location_id — unlikely
            # but don't crash on it.
            url = f"{GHL_BASE}/conversations/messages/{message_id}/recording"
        r = httpx.get(url, headers=_headers(location_id), timeout=60)
        if r.status_code != 200:
            logger.warning(
                f"GHL recording fetch HTTP {r.status_code} for msg {message_id}: "
                f"{r.text[:200]}"
            )
            return None
        ctype = (r.headers.get("content-type") or "").lower()
        if "audio" not in ctype:
            logger.warning(
                f"GHL recording for {message_id} returned non-audio content-type: {ctype} "
                f"(body preview: {r.text[:200]})"
            )
            return None
        return r.content
    except Exception as e:
        logger.error(f"GHL recording fetch errored for {message_id}: {e}")
        return None


def process_recording_pipeline(recording_id: str, transcribe_only: bool = False):
    """
    Run the full pipeline: transcribe → analyze → update status.
    Called after a recording is saved (from poller or manual upload).

    transcribe_only=True stops after the transcript is written, leaving the
    recording at status "transcribed". The two steps have very different
    costs — Deepgram is fractions of a cent per call, the Claude analysis is
    the part that exhausted the API credits on the last backlog run — so a
    catch-up over thousands of old recordings wants the cheap half only.
    """
    from services.call_transcriber import transcribe_recording, build_speaker_map
    from services.call_analyzer import analyze_call
    from database import CallTranscript, CallAnalysis, Estimate

    db = get_db()
    try:
        recording = db.query(CallRecording).filter(CallRecording.id == recording_id).first()
        if not recording:
            logger.error(f"Recording {recording_id} not found")
            return

        audio_data = recording.recording_data
        if not audio_data:
            # Try to download from URL
            if recording.recording_url:
                try:
                    with httpx.Client(timeout=60) as client:
                        resp = client.get(recording.recording_url)
                        resp.raise_for_status()
                        audio_data = resp.content
                except Exception as e:
                    logger.error(f"Failed to download recording: {e}")
                    recording.status = "failed"
                    db.commit()
                    return
            else:
                logger.error(f"No audio data for recording {recording_id}")
                recording.status = "failed"
                db.commit()
                return

        # Step 1: Transcribe
        logger.info(f"Transcribing recording {recording_id}...")
        result = transcribe_recording(audio_data)

        if not result["full_text"]:
            logger.warning(f"Empty transcript for recording {recording_id}")
            recording.status = "failed"
            db.commit()
            return

        speaker_map = build_speaker_map(
            result["segments"],
            recording.call_direction,
            recording.recorded_by or "",
        )

        transcript = CallTranscript(
            id=str(uuid.uuid4()),
            recording_id=recording_id,
            lead_id=recording.lead_id,
            full_text=result["full_text"],
            segments=json.dumps(result["segments"]),
            speaker_map=json.dumps(speaker_map),
            confidence=result["confidence"],
            created_at=_now(),
        )
        db.add(transcript)
        recording.status = "transcribed"
        recording.transcribed_at = _now()
        db.commit()
        logger.info(f"Transcript saved for recording {recording_id}")

        if transcribe_only:
            # Stop here. The recording keeps status "transcribed", which is
            # exactly what the intent extraction looks for later.
            return

        # Step 2: Analyze with Claude
        logger.info(f"Analyzing recording {recording_id}...")
        lead_context = None
        if recording.lead_id:
            lead = db.query(Lead).filter(Lead.id == recording.lead_id).first()
            estimate = db.query(Estimate).filter(Estimate.lead_id == recording.lead_id).order_by(Estimate.created_at.desc()).first()
            if lead:
                lead_context = {
                    "contact_name": lead.contact_name,
                    "address": lead.address,
                    "tiers": estimate.to_dict().get("tiers", {}) if estimate else {},
                }

        # Format transcript with speaker labels for analysis
        from services.call_transcriber import format_transcript_for_display
        labeled_text = format_transcript_for_display(result["segments"], speaker_map)

        # Pull the active coaching profile + recent reviews so the analyzer
        # can calibrate its evaluation to how Alan actually coaches.
        profile_text = None
        recent_reviews = []
        try:
            from services.coaching_profile import get_active_profile, fetch_recent_reviews
            profile = get_active_profile(db)
            profile_text = profile.profile_text if profile else None
            recent_reviews = fetch_recent_reviews(db, limit=5, exclude_recording_id=recording_id)
        except Exception as e:
            logger.warning(f"Coaching calibration fetch failed (analysis will run without it): {e}")

        analysis_result = analyze_call(labeled_text, lead_context, profile_text, recent_reviews)

        analysis = CallAnalysis(
            id=str(uuid.uuid4()),
            recording_id=recording_id,
            lead_id=recording.lead_id,
            summary=analysis_result["summary"],
            summary_one_line=analysis_result.get("summary_one_line", ""),
            stage_evaluation=json.dumps(analysis_result.get("stage_evaluation", [])),
            boundary_violations=json.dumps(analysis_result.get("boundary_violations", [])),
            what_went_well=analysis_result.get("what_went_well", ""),
            next_action=analysis_result.get("next_action", ""),
            coaching_tips=json.dumps(analysis_result["coaching_tips"]),
            sentiment=analysis_result["sentiment"],
            customer_sentiment=analysis_result["customer_sentiment"],
            objections=json.dumps(analysis_result["objections"]),
            key_topics=json.dumps(analysis_result["key_topics"]),
            customer_data_extracted=json.dumps(analysis_result["customer_data_extracted"]),
            call_score=analysis_result["call_score"],
            close_likelihood=analysis_result["close_likelihood"],
            created_at=_now(),
        )
        db.add(analysis)
        recording.status = "analyzed"
        recording.analyzed_at = _now()
        db.commit()
        logger.info(f"Analysis saved for recording {recording_id} | score={analysis_result['call_score']}/10")

    except Exception as e:
        db.rollback()
        logger.error(f"Recording pipeline error for {recording_id}: {e}")
        try:
            recording = db.query(CallRecording).filter(CallRecording.id == recording_id).first()
            if recording:
                recording.status = "failed"
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


# ──────────────────────────────────────────────────────────────────────
# Customer-intent extraction
# ──────────────────────────────────────────────────────────────────────

_intent_status: dict = {
    "running": False,
    "started_at": None,
    "completed_at": None,
    "total": 0,
    "done": 0,
    "extracted": 0,
    "failed": 0,
    "remaining": 0,
    "error": None,
}


_INTENT_HEARTBEAT_KEY = "intent_drain_last_run"


def _record_intent_heartbeat(note: str) -> None:
    """Write what the intent drain just did into system_config.

    The drain failed silently for a full day and the only trace was a log
    line on a host nobody could read, so every diagnosis was a guess. A
    heartbeat in the database costs one small write per run and turns "it
    isn't working" into "here is the exact exception".
    """
    try:
        d = get_db()
        try:
            from database import SystemConfig
            SystemConfig.set(d, _INTENT_HEARTBEAT_KEY, f"{_now()} | {note}"[:900])
        finally:
            d.close()
    except Exception:
        pass    # diagnostics must never break the thing they diagnose


def get_intent_backlog_status() -> dict:
    return dict(_intent_status)


def _open_lead_ids(db) -> set[str]:
    """Leads still worth calling — estimate sent, not yet closed or dead.

    The same stage set the callback list already uses, so the two never
    disagree about who is in play.
    """
    from services.pipeline_stages import CALL_LIST_STAGE_IDS
    return {
        lid for (lid,) in db.query(Lead.id)
        .filter(Lead.ghl_pipeline_stage_id.in_(tuple(CALL_LIST_STAGE_IDS)))
        .filter(Lead.is_test == False)  # noqa: E712
        .all()
    }


def extract_intent_backlog(limit: int = 200, sleep_between: float = 0.3) -> dict:
    """Read customer intent off transcripts, for OPEN leads only.

    Scoped deliberately. Every extraction is a Claude call, and a customer who
    bought in June or went dark in July does not need a follow-up plan — the
    whole point is deciding who to ring today. That scoping is what takes this
    from 1,728 calls to roughly 768.

    Only touches recordings that already have a transcript and no intent row,
    so it is safe to re-run and resumes where it stopped.
    """
    global _intent_status
    if _intent_status.get("running"):
        return get_intent_backlog_status()

    from database import CallIntent, CallTranscript
    from services.call_intent import extract_intent
    import time

    _intent_status = {
        "running": True, "started_at": _now(), "completed_at": None,
        "total": 0, "done": 0, "extracted": 0, "failed": 0,
        "remaining": 0, "error": None,
    }

    try:
        return _extract_intent_backlog_inner(limit, sleep_between)
    except Exception as e:
        # Whatever went wrong, the flag MUST come down. Leaving it raised
        # wedges the drain permanently: every later tick sees running=True,
        # short-circuits, and nothing ever runs again — silently, because
        # the caller only logs the one exception it saw. Recording the error
        # here also puts it on the status endpoint instead of only in a log.
        logger.error(f"Intent backlog aborted: {e}", exc_info=True)
        _intent_status["error"] = str(e)
        _record_intent_heartbeat(f"ABORTED: {type(e).__name__}: {e}")
        return get_intent_backlog_status()
    finally:
        _intent_status["running"] = False
        _intent_status["completed_at"] = _now()


def _extract_intent_backlog_inner(limit: int, sleep_between: float) -> dict:
    from database import CallIntent, CallTranscript
    from services.call_intent import extract_intent
    import time

    db = get_db()
    try:
        open_ids = _open_lead_ids(db)
        if not open_ids:
            return get_intent_backlog_status()

        done_ids = {r[0] for r in db.query(CallIntent.recording_id).all()}
        rows = (
            db.query(CallRecording.id, CallRecording.lead_id, CallRecording.created_at)
            .filter(CallRecording.lead_id.in_(tuple(open_ids)))
            .filter(CallRecording.status.in_(("transcribed", "analyzed")))
            .order_by(CallRecording.created_at.desc())
            .all()
        )
        todo = [r for r in rows if r[0] not in done_ids][:max(1, int(limit))]
        _intent_status["total"] = len(todo)
        logger.info(f"Intent backlog: starting on {len(todo)} recording(s)")
    finally:
        db.close()

    for rec_id, lead_id, created_at in todo:
        d = get_db()
        try:
            transcript = (
                d.query(CallTranscript)
                .filter(CallTranscript.recording_id == rec_id)
                .first()
            )
            if not transcript or not (transcript.full_text or "").strip():
                _intent_status["failed"] += 1
                continue

            lead = d.query(Lead).filter(Lead.id == lead_id).first() if lead_id else None
            result = extract_intent(
                transcript.full_text,
                # The Houston day the call happened — what makes a phrase like
                # "next Tuesday" resolvable at all.
                call_date=clock.ct_date_of(created_at),
                lead_context={
                    "contact_name": lead.contact_name if lead else "",
                    "address": lead.address if lead else "",
                },
            )
            if not result.get("ok"):
                # Extraction didn't run (no credit, bad response). Leave the
                # recording untouched so the next pass retries it — recording
                # an empty row here would mark it done forever.
                #
                # Keep the reason: "0 extracted" on its own says nothing about
                # whether the key is missing, the credit is gone, or the model
                # returned junk, and that ambiguity cost a day.
                _intent_status["failed"] += 1
                _intent_status["last_reason"] = result.get("one_line") or "unknown"
                continue

            d.add(CallIntent(
                id=str(uuid.uuid4()),
                recording_id=rec_id,
                lead_id=lead_id,
                wanted=result["wanted"],
                blocker=result["blocker"],
                blocker_detail=result["blocker_detail"],
                commitment=result["commitment"],
                callback_phrase=result["callback_phrase"],
                callback_at=result["callback_at"],
                temperature=result["temperature"],
                one_line=result["one_line"],
                quoted_price_mentioned=result["quoted_price_mentioned"],
                # When the call happened, so the list can headline the
                # latest CALL rather than the latest read.
                call_at=created_at or "",
                created_at=_now(),
            ))
            d.commit()
            _intent_status["extracted"] += 1
        except Exception as e:
            logger.warning(f"Intent extraction failed for {rec_id}: {e}")
            _intent_status["failed"] += 1
        finally:
            d.close()
            _intent_status["done"] += 1

        if sleep_between:
            time.sleep(sleep_between)

    d = get_db()
    try:
        open_ids = _open_lead_ids(d)
        done_ids = {r[0] for r in d.query(CallIntent.recording_id).all()}
        remaining = (
            d.query(CallRecording.id)
            .filter(CallRecording.lead_id.in_(tuple(open_ids) or ("",)))
            .filter(CallRecording.status.in_(("transcribed", "analyzed")))
            .all()
        )
        _intent_status["remaining"] = len([r for r in remaining if r[0] not in done_ids])
    except Exception:
        pass
    finally:
        d.close()

    logger.info(
        f"Intent backlog done: {_intent_status['extracted']} extracted, "
        f"{_intent_status['failed']} failed, {_intent_status['remaining']} remaining"
    )
    _record_intent_heartbeat(
        f"ran: total={_intent_status['total']} "
        f"extracted={_intent_status['extracted']} failed={_intent_status['failed']} "
        f"remaining={_intent_status['remaining']} "
        f"last_reason={_intent_status.get('last_reason') or '-'}"
    )
    return get_intent_backlog_status()
