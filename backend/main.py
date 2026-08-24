from __future__ import annotations
import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from database import init_db, get_db
from config import get_settings
from api import webhooks, leads, estimates, analytics, pdf_templates, proposals, notifications, settings, auth, fence_ai, chatbot, calls, crew, crew_app, scheduling, estimate_delays, time_logs, accounting, quickbooks, wrapped, sops, call_script, operator, followups, internal, call_list, call_dispositions, payments, training, exterior, customer_upsell, painting_upsell, permissions, estimator, daily_tasks, qb_invoices, worker_shift, video_estimate, stain_inventory, fence_photos
from api.training import training_ws_handler
from services.poller import poll_ghl_contacts, poll_ghl_messages
from services.call_poller import poll_ghl_call_recordings
from services.correction_escalator import check_escalations
from services.nudge import run_nudge_check
from services.weekly_reminder import run_weekly_reminder
from services.wrapped_dispatcher import run_wrapped_dispatcher
from services.sms_worker import process_pending_messages
from services.event_bus import subscribe

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


# ── Background loop offset schedule (T1.1, 2026-05-26) ───────────────
# Five loops share a 300s cadence. If they all start at t=0 (or any
# clustered offsets), they tick at the same wall-clock minute every
# cycle and pile their GHL traffic into the same 10-second burst window
# — which is what we keep blowing through. Spread them every 60s across
# the 300s window so no two co-fire:
#   t+0    lead poller
#   t+60   followup engine
#   t+120  message poller
#   t+180  nudge
#   t+240  call recording poller
# Longer-cadence loops (estimate delay 600s, correction escalator 900s,
# weekly/wrapped/backfill/learning) align rarely enough that their
# offsets don't need careful spacing.

async def _poller_loop():
    """Background task: sync GHL contacts. Runs every 5 minutes (300s)."""
    while True:
        try:
            await asyncio.to_thread(poll_ghl_contacts)
        except Exception as e:
            logger.error(f"Poller error: {e}")
        await asyncio.sleep(300)


async def _message_poller_loop():
    """Background task: sync GHL messages every 5 minutes (safety net for missed webhooks)."""
    await asyncio.sleep(120)
    while True:
        try:
            await asyncio.to_thread(poll_ghl_messages)
        except Exception as e:
            logger.error(f"Message poller error: {e}")
        await asyncio.sleep(300)


async def _nudge_loop():
    """Background task: nudge Alan + Olga every 5 minutes about pending leads."""
    await asyncio.sleep(180)
    while True:
        try:
            await asyncio.to_thread(run_nudge_check)
        except Exception as e:
            logger.error(f"Nudge error: {e}")
        await asyncio.sleep(300)


async def _sms_worker_loop():
    """Background task: process scheduled SMS messages every 30 seconds."""
    await asyncio.sleep(10)
    while True:
        try:
            await asyncio.to_thread(process_pending_messages)
        except Exception as e:
            logger.error(f"SMS worker error: {e}")
        await asyncio.sleep(30)


async def _weekly_reminder_loop():
    """Background task: check every hour if it's Saturday morning to remind Alan."""
    await asyncio.sleep(60)
    while True:
        try:
            await asyncio.to_thread(run_weekly_reminder)
        except Exception as e:
            logger.error(f"Weekly reminder error: {e}")
        await asyncio.sleep(3600)  # Check every hour


async def _wrapped_dispatcher_loop():
    """Background task: hourly tick that fires Saturday-morning weekly
    Wrapped SMS + last-day-of-month monthly Wrapped SMS to Alan."""
    await asyncio.sleep(120)
    while True:
        try:
            await asyncio.to_thread(run_wrapped_dispatcher)
        except Exception as e:
            logger.error(f"Wrapped dispatcher error: {e}")
        await asyncio.sleep(3600)


async def _call_recording_poller_loop():
    """Background task: check for new GHL call recordings every 10 minutes.
    Re-enabled 2026-06-08 (Sprint 4 T4.B) now that T4.A's fetcher is
    real. Gated on settings.enable_call_recording_poller so it can be
    flipped off via env var without a redeploy if Deepgram or BLOB
    ingest needs to be paused."""
    # Longer initial sleep — let the app fully warm before the first
    # poll fires through the rate-limited GHL client.
    await asyncio.sleep(240)
    while True:
        try:
            await asyncio.to_thread(poll_ghl_call_recordings)
        except Exception as e:
            logger.error(f"Call recording poller error: {e}")
        # 10 min between polls. Calls aren't time-critical — the rest
        # of the dashboard (proposal-viewed SMS, call disposition UI)
        # is what drives Alan's real-time behavior. The pipeline here
        # is for downstream analytics.
        await asyncio.sleep(600)


async def _map_geocode_loop():
    """Background task: auto-pin new leads. Every 5 min, geocode any mappable
    lead still missing coords so the Lead Map fills in on its own — no manual
    'Re-geocode all'. force=False, newest-first, capped per pass, so steady
    state only touches fresh arrivals. Offset t+90 to spread startup load."""
    await asyncio.sleep(90)
    while True:
        try:
            from api.leads import auto_geocode_new_leads
            await asyncio.to_thread(auto_geocode_new_leads)
        except Exception as e:
            logger.error(f"Map geocode loop error: {e}")
        await asyncio.sleep(300)


async def _qb_reconcile_loop():
    """Background task: nightly QB reconciliation pass (W3, 2026-06-08).

    The QB webhook is the primary push path that marks jobs + deposits
    paid. This loop is the safety net for missed webhooks — it walks
    every outstanding invoice in the local DB, pulls QB's view of each,
    and applies the same logic the webhook does. Idempotent.

    Schedule: roughly every 24h with a long initial sleep so the cron
    doesn't race the app's first request. We compute a delay-until-3am
    rather than running on a fixed offset so the pass lands during
    Texas overnight regardless of when the deploy happened.

    Mock mode → the service no-ops. Disabling the flag in config also
    no-ops without a redeploy."""
    from services.qb_reconcile import reconcile_all

    # Stagger start so this never races other startup work.
    await asyncio.sleep(300)
    while True:
        try:
            # Find the next 3am CST. Approximate (no DST transition
            # logic — close enough; the pass is idempotent so a 1-hour
            # drift twice a year doesn't matter).
            now = datetime.now(timezone.utc)
            is_dst = 3 <= now.month <= 10
            cst_now = now + timedelta(hours=(-5 if is_dst else -6))
            next_3am_cst = cst_now.replace(hour=3, minute=0, second=0, microsecond=0)
            if cst_now >= next_3am_cst:
                next_3am_cst = next_3am_cst + timedelta(days=1)
            delay_seconds = max(60, (next_3am_cst - cst_now).total_seconds())
            await asyncio.sleep(delay_seconds)

            def _run_reconcile():
                db = get_db()
                try:
                    return reconcile_all(db)
                finally:
                    db.close()

            stats = await asyncio.to_thread(_run_reconcile)
            logger.info(f"[QB RECONCILE CRON] completed — {stats}")
        except Exception as e:
            logger.error(f"QB reconcile poller error: {e}")
            # On error, sleep an hour and try again so we don't spin tight.
            await asyncio.sleep(3600)


async def _correction_escalator_loop():
    """Background task: SMS Alan when a customer correction request has been
    sitting unresolved for > 24 hours. Checks every 15 minutes."""
    await asyncio.sleep(180)  # Stagger after other startup tasks
    while True:
        try:
            await asyncio.to_thread(check_escalations)
        except Exception as e:
            logger.error(f"Correction escalator error: {e}")
        await asyncio.sleep(900)  # Every 15 minutes


async def _estimate_delay_loop():
    """Background task: detect leads that have crossed 24h without an estimate
    and auto-resolve any whose estimates have since gone out. Every 10 min."""
    from api.estimate_delays import detect_and_record_delays, auto_resolve_delays
    from database import get_db as _get_db
    await asyncio.sleep(240)  # Stagger after other startup tasks
    while True:
        try:
            def _tick():
                db = _get_db()
                try:
                    detect_and_record_delays(db)
                    auto_resolve_delays(db)
                finally:
                    db.close()
            await asyncio.to_thread(_tick)
        except Exception as e:
            logger.error(f"Estimate delay detector error: {e}")
        await asyncio.sleep(600)  # Every 10 minutes


async def _video_capture_reminder_loop():
    """FenceScope: nudge customers who got a video-capture link but never
    submitted (24h, then 72h), then auto-route to the estimator (>=96h). Each
    step fires once per lead — throttled to avoid the old nudge-spam. Every
    30 min."""
    from services.video_estimate_capture import run_video_capture_reminders
    await asyncio.sleep(420)  # stagger well after boot
    while True:
        try:
            res = await asyncio.to_thread(run_video_capture_reminders)
            if res and any(res.values()):
                logger.info(f"FenceScope reminders: {res}")
        except Exception as e:
            logger.error(f"Video-capture reminder loop error: {e}")
        await asyncio.sleep(1800)  # every 30 minutes


async def _followup_engine_loop():
    """Background task: advance due follow-up runs every 5 minutes.
    Master-toggle gated — exits fast when off."""
    from services.followup_engine import tick as followup_tick
    # Offset = 60s within the shared 300s window (see T1.1 schedule
    # above). 300s used to be the offset, which after the first cycle
    # aligned perfectly with the lead poller (t=0 + 300 = 300) — the
    # single worst collision in the pre-fix layout.
    await asyncio.sleep(60)
    while True:
        try:
            await asyncio.to_thread(followup_tick)
        except Exception as e:
            logger.error(f"Follow-up engine tick error: {e}")
        await asyncio.sleep(300)


async def _followup_backfill_loop():
    """Background task: every ~4 weeks, scan for leads stranded in a
    stage-triggered sequence's target stage without ever having been
    enrolled. Auto-enrolls them so legacy leads (in stage before
    sequence activation) eventually get the nurture treatment.

    Designed to prevent the "Alan flips P06 on, 50 leads already in
    LTN never get a single nurture text" failure mode without
    requiring admin to remember a manual backfill step."""
    from services.followup_engine import backfill_stage_triggered_sequences
    # Run once 10 minutes after boot so first deploy picks up the
    # backlog right away, then settle into the ~monthly cadence.
    await asyncio.sleep(600)
    while True:
        try:
            await asyncio.to_thread(backfill_stage_triggered_sequences)
        except Exception as e:
            logger.error(f"Follow-up backfill loop error: {e}")
        await asyncio.sleep(28 * 24 * 3600)  # 4 weeks


async def _followup_learning_loop():
    """Background task: weekly pattern analysis. Cheap because it only
    runs once every 24h and writes thoughts only when anomalies clearly
    exceed thresholds. Quiet until enough volume accumulates."""
    from services.followup_learning import run_weekly_analysis
    await asyncio.sleep(3600)  # 1h after boot
    while True:
        try:
            await asyncio.to_thread(run_weekly_analysis)
        except Exception as e:
            logger.error(f"Follow-up learning error: {e}")
        await asyncio.sleep(24 * 3600)  # Daily — quick scan, only publishes when signal is real


async def _async_db_init():
    """Run DB init + seed in a background thread so lifespan doesn't block
    uvicorn from serving /health. If Supabase is briefly unreachable, we
    retry instead of crashing the container at boot. Endpoints that need DB
    will fail fast (per request) until init succeeds — but /health stays
    responsive so Railway's healthcheck passes."""
    delay = 2
    for attempt in range(1, 7):
        try:
            await asyncio.to_thread(init_db)
            await asyncio.to_thread(auth.seed_default_users)
            await asyncio.to_thread(auth.seed_fragned_user)
            await asyncio.to_thread(auth.seed_eduardo_user)
            await asyncio.to_thread(auth.seed_edward_user)
            await asyncio.to_thread(auth.seed_brent_user)
            await asyncio.to_thread(auth.seed_emmanuel_user)
            await asyncio.to_thread(auth.seed_neo_user)
            await asyncio.to_thread(auth.migrate_neo_visits_to_emmanuel)
            await asyncio.to_thread(auth.seed_olga_estimator_access)
            await asyncio.to_thread(auth.seed_geoconda_user)
            await asyncio.to_thread(auth.seed_anna_moran_user)
            # One-time historical revenue: the May 2026 payment links Alan
            # collected before he started invoicing. Idempotent, and skips
            # anything the QuickBooks sync already covers.
            await asyncio.to_thread(qb_invoices.backfill_may_2026_payment_links)
            # Backfill dashboard-link notes for any A/B leads that entered past
            # the intake stage and never got one. Idempotent — cheap no-op once
            # all leads are covered. Off-thread so it never blocks boot.
            try:
                from services.notifications import backfill_missing_dashboard_link_notes
                await asyncio.to_thread(backfill_missing_dashboard_link_notes)
            except Exception as bf_err:
                logger.warning(f"Dashboard-link backfill skipped: {bf_err}")
            # Pre-warm the 16MB PDF template into module-level RAM so the
            # first customer-facing request after deploy doesn't pay the
            # cold-start tax (BLOB transfer + the retry-with-sleep loop in
            # template_cache._reload_template). Off-thread so we don't
            # block the event loop during the (network-bound) load.
            try:
                from services.template_cache import get_template
                await asyncio.to_thread(get_template)
            except Exception as warm_err:
                logger.warning(f"PDF template prewarm skipped (will lazy-load on first request): {warm_err}")
            try:
                from services.followup_engine import (
                    seed_test_sequence,
                    seed_p1_sterling_estimate_sent,
                    seed_p0_sterling_intake,
                    seed_p03_address_confirmation,
                    seed_u01_manual_move_to_ltn,
                    seed_p06_long_term_nurture,
                    seed_external_workflow_shells,
                )
                await asyncio.to_thread(seed_test_sequence)
                await asyncio.to_thread(seed_p1_sterling_estimate_sent)
                await asyncio.to_thread(seed_p0_sterling_intake)
                await asyncio.to_thread(seed_p03_address_confirmation)
                await asyncio.to_thread(seed_u01_manual_move_to_ltn)
                await asyncio.to_thread(seed_p06_long_term_nurture)
                await asyncio.to_thread(seed_external_workflow_shells)
            except Exception as seed_err:
                logger.warning(f"Follow-up sequence seed skipped: {seed_err}")
            logger.info("Database initialized")
            return
        except Exception as e:
            logger.error(f"DB init attempt {attempt} failed: {e}")
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)
    logger.error("DB init giving up after 6 attempts — endpoints will keep retrying via get_db()")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_task = asyncio.create_task(_async_db_init())
    poller = asyncio.create_task(_poller_loop())
    # T2.2: Message poller is now a fallback for the InboundMessage
    # webhook (api/webhooks.py POST /webhook/ghl/message), which handles
    # storage + customer_responded + follow-up engine integration + SSE
    # + opt-out detection in real time. Default off — set
    # ENABLE_MESSAGE_POLLER=true in env if the webhook ever stops firing.
    msg_poller = None
    if get_settings().enable_message_poller:
        msg_poller = asyncio.create_task(_message_poller_loop())
        logger.info("Message poller ENABLED via ENABLE_MESSAGE_POLLER env var")
    sms_worker = asyncio.create_task(_sms_worker_loop())
    weekly = asyncio.create_task(_weekly_reminder_loop())
    wrapped_loop = asyncio.create_task(_wrapped_dispatcher_loop())
    # Sprint 4 T4.B (2026-06-08). Call recording poller re-enabled now
    # that T4.A's GHL fetcher is shipping. Gated on the config flag so
    # it can be turned off without redeploying. Default: ON.
    call_poller = None
    if get_settings().enable_call_recording_poller:
        call_poller = asyncio.create_task(_call_recording_poller_loop())
    # W3 (2026-06-08). Nightly QB reconciliation safety net. Catches any
    # invoice payments that arrived but whose webhook delivery failed.
    # Mock mode no-ops at the service level. Default: ON.
    qb_reconcile = None
    if get_settings().enable_qb_reconcile_poller:
        qb_reconcile = asyncio.create_task(_qb_reconcile_loop())
    correction_escalator = asyncio.create_task(_correction_escalator_loop())
    delay_detector = asyncio.create_task(_estimate_delay_loop())
    followup_engine = asyncio.create_task(_followup_engine_loop())
    followup_learning = asyncio.create_task(_followup_learning_loop())
    followup_backfill = asyncio.create_task(_followup_backfill_loop())
    map_geocoder = asyncio.create_task(_map_geocode_loop())
    video_reminders = asyncio.create_task(_video_capture_reminder_loop())
    # Nudge loop disabled — was spamming Alan every 5 min
    # nudger = asyncio.create_task(_nudge_loop())
    yield
    init_task.cancel()
    poller.cancel()
    if msg_poller is not None:
        msg_poller.cancel()
    sms_worker.cancel()
    weekly.cancel()
    wrapped_loop.cancel()
    if call_poller is not None:
        call_poller.cancel()
    if qb_reconcile is not None:
        qb_reconcile.cancel()
    correction_escalator.cancel()
    delay_detector.cancel()
    followup_engine.cancel()
    followup_learning.cancel()
    followup_backfill.cancel()
    map_geocoder.cancel()
    video_reminders.cancel()


app = FastAPI(title="Sterling Fence Staining", lifespan=lifespan)

# CORS — explicit origin list (wildcard + credentials is invalid per spec)
_settings = get_settings()
origins = [
    "https://admin.atpressurewash.com",
    "https://proposal.atpressurewash.com",
]
# Add frontend/proposal URLs from env
for extra in [_settings.frontend_url, _settings.proposal_base_url]:
    if extra and extra not in origins:
        origins.append(extra)
# Add any extra configured origins (skip wildcard)
for o in _settings.allowed_origins.split(","):
    o = o.strip()
    if o and o != "*" and o not in origins:
        origins.append(o)
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api")
app.include_router(permissions.router, prefix="/api")
app.include_router(estimator.router, prefix="/api")
app.include_router(webhooks.router)
app.include_router(leads.router, prefix="/api")
app.include_router(estimates.router, prefix="/api")
app.include_router(proposals.router, prefix="/api")
app.include_router(analytics.router, prefix="/api")
app.include_router(notifications.router, prefix="/api")
app.include_router(settings.router, prefix="/api")
app.include_router(pdf_templates.router, prefix="/api")
app.include_router(fence_ai.router, prefix="/api")
app.include_router(chatbot.router, prefix="/api")
app.include_router(calls.router, prefix="/api")
app.include_router(crew.router, prefix="/api")
app.include_router(crew_app.router, prefix="/api")
app.include_router(scheduling.router, prefix="/api")
app.include_router(estimate_delays.router, prefix="/api")
app.include_router(time_logs.router, prefix="/api")
app.include_router(accounting.router, prefix="/api")
app.include_router(stain_inventory.router, prefix="/api")
app.include_router(fence_photos.router, prefix="/api")
app.include_router(quickbooks.router, prefix="/api")
app.include_router(wrapped.router, prefix="/api")
app.include_router(sops.router, prefix="/api")
app.include_router(call_script.router, prefix="/api")
app.include_router(operator.router, prefix="/api")
app.include_router(followups.router, prefix="/api")
app.include_router(call_list.router, prefix="/api")
app.include_router(payments.router, prefix="/api")
app.include_router(call_dispositions.router, prefix="/api")
app.include_router(daily_tasks.router, prefix="/api")
app.include_router(worker_shift.router, prefix="/api")
app.include_router(qb_invoices.router, prefix="/api")
app.include_router(training.router, prefix="/api")
app.include_router(exterior.router, prefix="/api")
app.include_router(video_estimate.router, prefix="/api")
app.include_router(customer_upsell.router, prefix="/api")
app.include_router(painting_upsell.router, prefix="/api")
app.include_router(internal.router, prefix="/api")


# Voice training simulator WebSocket. Lives at root (not /api) because
# the browser WebSocket API can't set Authorization headers — the rep's
# JWT comes as a ?token=... query param, validated inside the handler.
@app.websocket("/ws/training/{session_id}")
async def training_ws(websocket: WebSocket, session_id: str):
    await training_ws_handler(websocket, session_id)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/events")
async def sse_events():
    """Server-Sent Events stream. Pushes new_lead, estimate_sent, etc. in real-time."""
    return StreamingResponse(
        subscribe(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )
