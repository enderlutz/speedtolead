"""Address geocoding via Google Maps Geocoding API."""
from __future__ import annotations
import logging
import httpx
from config import get_settings

logger = logging.getLogger(__name__)


def geocode_address(address: str) -> dict | None:
    """
    Geocode an address and return structured result.
    Returns dict with: formatted_address, zip_code, lat, lng, or None on failure.
    """
    settings = get_settings()
    if not settings.google_maps_api_key or not address:
        return None

    try:
        r = httpx.get(
            "https://maps.googleapis.com/maps/api/geocode/json",
            params={"address": address, "key": settings.google_maps_api_key},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()

        if data.get("status") != "OK" or not data.get("results"):
            return None

        result = data["results"][0]
        components = {c["types"][0]: c for c in result.get("address_components", []) if c.get("types")}

        zip_code = ""
        if "postal_code" in components:
            zip_code = components["postal_code"].get("short_name", "")

        return {
            "formatted_address": result.get("formatted_address", address),
            "zip_code": zip_code,
            "lat": result["geometry"]["location"]["lat"],
            "lng": result["geometry"]["location"]["lng"],
        }
    except Exception as e:
        logger.error(f"Geocoding failed for '{address}': {e}")
        return None


def extract_zip(address: str) -> str:
    """Try to extract a ZIP code from an address string, using geocoder as fallback."""
    import re
    match = re.search(r'\b(\d{5})(?:-\d{4})?\b', address)
    if match:
        return match.group(1)

    result = geocode_address(address)
    return result["zip_code"] if result else ""
