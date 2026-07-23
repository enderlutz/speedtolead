from __future__ import annotations
from functools import lru_cache
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Database — SQLite for local dev, PostgreSQL (Supabase) for production
    database_url: str = "sqlite:///./at_system_lite.db"

    # GHL - Cypress
    ghl_api_key: str = ""
    ghl_location_id: str = ""

    # GHL - Woodlands
    ghl_api_key_2: str = ""
    ghl_location_id_2: str = ""

    # GHL - OLD account credentials moved out of env (2026-06-16). The
    # Painting Upsell import is a one-shot admin action; the API key is
    # entered into the admin form, used for the single request, and
    # never persisted. See services/painting_upsell_importer.py for the
    # hardcoded discovered pipeline + stage IDs.

    # Notifications
    owner_ghl_contact_id: str = ""  # Alan - SMS
    olga_ghl_contact_id: str = ""   # Olga - WhatsApp
    fragne_ghl_contact_id: str = "" # Fragne - SMS
    pm_ghl_contact_id: str = ""     # PM - Crew App "wrapping up" alerts (falls back to owner)
    edward_ghl_contact_id: str = "" # Edward - "30-min / almost done" crew alerts (SMS)
    edward_phone: str = "+12817449324"  # Edward's phone — resolved to a GHL contact when no contact_id is set

    # Labels
    ghl_location_1_label: str = "Cypress"
    ghl_location_2_label: str = "Woodlands"

    # URLs
    frontend_url: str = "http://localhost:5173"
    proposal_base_url: str = "http://localhost:5173"

    # Google Maps
    # Server key — geocoding lead addresses (server-side only).
    google_maps_api_key: str = ""
    # Browser/maps key — the estimator drive-path Maps JavaScript map (returned
    # to the frontend) AND the Distance Matrix drive-time calls. Kept separate
    # so the geocoding key and the browser-exposed maps key can be enabled/
    # restricted independently in Google Cloud. Falls back to
    # google_maps_api_key when unset.
    google_maps_browser_key: str = ""

    # GHL Pipeline sync
    ghl_pipeline_id: str = ""
    ghl_pipeline_id_2: str = ""

    # Brick Staining division intake. Empty name = brick intake OFF (the poller
    # skips it). Set to the brick GHL pipeline's name (case-insensitive substring
    # match) to turn it on; leads it creates are stamped division="brick".
    ghl_pipeline_brick_name: str = ""
    ghl_pipeline_brick_location_id: str = ""  # empty → same Cypress location as fence (ghl_location_id)

    # GHL user ID — required by POST /contacts/{id}/notes (every note must
    # be attributed to a real GHL user). Find yours in GHL → My Profile.
    ghl_default_user_id: str = ""

    # Google Calendar OAuth (Alan's calendar — single account, all jobs)
    google_oauth_client_id: str = ""
    google_oauth_client_secret: str = ""
    google_oauth_redirect_uri: str = ""  # e.g., https://api.../api/google/callback

    # Anthropic (Claude API for AI fence measurement + chatbot)
    anthropic_api_key: str = ""

    # Deepgram (call transcription)
    deepgram_api_key: str = ""

    # ElevenLabs (voice training simulator TTS). When empty, the training
    # feature still works but in text-only mode — the conversation loop runs
    # without audio so the rep can practice via transcript. Audio flips on
    # automatically the moment a real key lands here.
    elevenlabs_api_key: str = ""

    # Auth
    auth_secret: str = "change-me-in-production"

    # Shared secret for GHL webhooks. When set, /webhook/ghl/* endpoints
    # require the secret as either a `?token=...` query param OR an
    # `X-Webhook-Token` header. Defense against random POSTs to our
    # webhook URLs from anyone who guesses the path. Empty (default)
    # disables the check for local dev.
    ghl_webhook_secret: str = ""

    # Supabase Storage — used for proposal page images. Lets us serve
    # JPEGs from Supabase's CDN instead of pulling BLOBs through the DB
    # (which counts against the metered DB egress quota and saturates
    # the connection pool). The service role key bypasses RLS for
    # backend uploads — keep it secret, never expose to the frontend.
    supabase_url: str = ""
    supabase_service_key: str = ""
    # Bucket name for proposal page JPEGs. Must exist + be public.
    supabase_proposal_pages_bucket: str = "proposal-pages"
    # Bucket name for voice training simulator audio segments. Must
    # exist + be public. Each practice call uploads one segment per
    # rep utterance + one per persona reply. Tiny files (~50-300KB)
    # so storage cost is negligible — ~$0.001 per call.
    supabase_training_audio_bucket: str = "training-audio"
    # Bucket name for exterior painting estimate photos uploaded by
    # customers via the public /capture/<token> page. Must exist + be
    # public. ~500KB-2MB per photo, ~8-12 photos per lead.
    supabase_exterior_photos_bucket: str = "exterior-photos"
    # Bucket name for estimator conversation recordings. Must exist + be
    # public. Can be large (a full estimate conversation, tens of MB) —
    # keeping these out of the DB is exactly why they live in Storage.
    supabase_estimator_recordings_bucket: str = "estimator-recordings"
    # Bucket for FenceScope guided video-estimate captures (customer-recorded
    # fence walk videos + damage close-ups) via the public /v/<token> page.
    # Must exist + be public. Videos are large (tens of MB) — Storage, not DB.
    # See fencescope.md. Raw video purged after 90 days; frames/measurements kept.
    supabase_estimate_video_bucket: str = "estimate-videos"

    # Server
    port: int = 8000
    allowed_origins: str = "*"  # Comma-separated for production

    # T2.2 (2026-05-26): The GHL InboundMessage webhook at
    # POST /webhook/ghl/message is the real-time path for customer
    # replies and handles everything the 5-min message poller did
    # (storage, customer_responded flag, follow-up engine integration,
    # SSE publish, opt-out detection). The poller is now a fallback,
    # disabled by default. Flip this to True only if the webhook ever
    # stops firing (deploy issue, GHL config drift, etc.). Saves ~20
    # GHL API calls per 5-min cycle when off.
    enable_message_poller: bool = False

    # Sprint 4 T4.B (2026-06-08). Call recording poller (T4.A's fetcher
    # wrapped in a 10-min loop). Defaults ON now that the GHL endpoint
    # is confirmed and T4.A is shipping in production. Flip to False
    # via env var if Deepgram or DB blob ingest causes issues — the
    # admin POST /api/calls/ingest-all endpoint still works as a
    # manual fallback.
    enable_call_recording_poller: bool = True

    # W3 (2026-06-08). QuickBooks payment reconciliation. The QB webhook
    # is the primary push path that marks jobs + deposits paid; this
    # nightly loop is the safety net for missed webhooks. Runs at 3am CST
    # (low traffic), walks every outstanding invoice, pulls QB state,
    # applies the same canonical update. Idempotent. Mock mode no-ops.
    # Set False to disable the cron — the manual /api/quickbooks/reconcile
    # endpoint still works as a fallback.
    enable_qb_reconcile_poller: bool = True

    class Config:
        env_file = ".env"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
