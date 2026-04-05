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

    # Notifications
    owner_ghl_contact_id: str = ""  # Alan - SMS
    olga_ghl_contact_id: str = ""   # Olga - WhatsApp
    fragne_ghl_contact_id: str = "" # Fragne - SMS

    # Labels
    ghl_location_1_label: str = "Cypress"
    ghl_location_2_label: str = "Woodlands"

    # URLs
    frontend_url: str = "http://localhost:5173"
    proposal_base_url: str = "http://localhost:5173"

    # Google Maps
    google_maps_api_key: str = ""

    # GHL Pipeline sync
    ghl_pipeline_id: str = ""
    ghl_pipeline_id_2: str = ""

    # Auth
    auth_secret: str = "change-me-in-production"

    # Server
    port: int = 8000
    allowed_origins: str = "*"  # Comma-separated for production

    class Config:
        env_file = ".env"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
