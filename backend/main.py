from __future__ import annotations
import asyncio
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from database import init_db
from config import get_settings
from api import webhooks, leads, estimates, analytics, pdf_templates, proposals, notifications, settings, auth, fence_ai, chatbot, calls, crew, scheduling, estimate_delays, time_logs, accounting, quickbooks, wrapped, sops, call_script
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


async def _poller_loop():
    """Background task: sync GHL contacts every 60 seconds."""
    while True:
        try:
            await asyncio.to_thread(poll_ghl_contacts)
        except Exception as e:
            logger.error(f"Poller error: {e}")
        await asyncio.sleep(60)


async def _message_poller_loop():
    """Background task: sync GHL messages every 5 minutes (safety net for missed webhooks).
    Delayed start to let lead poller run first without hitting rate limits."""
    await asyncio.sleep(90)
    while True:
        try:
            await asyncio.to_thread(poll_ghl_messages)
        except Exception as e:
            logger.error(f"Message poller error: {e}")
        await asyncio.sleep(300)  # Every 5 minutes


async def _nudge_loop():
    """Background task: nudge Alan + Olga every 5 minutes about pending leads."""
    await asyncio.sleep(30)
    while True:
        try:
            await asyncio.to_thread(run_nudge_check)
        except Exception as e:
            logger.error(f"Nudge error: {e}")
        await asyncio.sleep(300)  # Every 5 minutes


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
    """Background task: check for new GHL call recordings every 5 minutes."""
    await asyncio.sleep(120)  # Stagger after lead poller
    while True:
        try:
            await asyncio.to_thread(poll_ghl_call_recordings)
        except Exception as e:
            logger.error(f"Call recording poller error: {e}")
        await asyncio.sleep(300)


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
    # Message poller disabled — was consuming GHL rate limit and blocking lead poller
    # msg_poller = asyncio.create_task(_message_poller_loop())
    sms_worker = asyncio.create_task(_sms_worker_loop())
    weekly = asyncio.create_task(_weekly_reminder_loop())
    wrapped_loop = asyncio.create_task(_wrapped_dispatcher_loop())
    # Call recording poller disabled — recordings now happen exclusively
    # in-browser via the dashboard, no longer pulling from GHL
    # call_poller = asyncio.create_task(_call_recording_poller_loop())
    correction_escalator = asyncio.create_task(_correction_escalator_loop())
    delay_detector = asyncio.create_task(_estimate_delay_loop())
    # Nudge loop disabled — was spamming Alan every 5 min
    # nudger = asyncio.create_task(_nudge_loop())
    yield
    init_task.cancel()
    poller.cancel()
    sms_worker.cancel()
    weekly.cancel()
    wrapped_loop.cancel()
    correction_escalator.cancel()
    delay_detector.cancel()


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
app.include_router(scheduling.router, prefix="/api")
app.include_router(estimate_delays.router, prefix="/api")
app.include_router(time_logs.router, prefix="/api")
app.include_router(accounting.router, prefix="/api")
app.include_router(quickbooks.router, prefix="/api")
app.include_router(wrapped.router, prefix="/api")
app.include_router(sops.router, prefix="/api")
app.include_router(call_script.router, prefix="/api")


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
