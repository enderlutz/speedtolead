"""Drive-time estimates via the Google Distance Matrix API.

Used by the estimator scheduler to show the admin how long it takes to drive
between consecutive estimate stops, and to cache the drive time onto each
EstimatorVisit at schedule time. Reuses the same GOOGLE_MAPS_API_KEY as the
geocoder. Every function degrades gracefully to None when the key is missing
or Google errors, so scheduling still works without drive times."""
from __future__ import annotations
import logging
import httpx
from config import get_settings

logger = logging.getLogger(__name__)

LatLng = tuple[float, float]


def drive_minutes(origin: LatLng, dest: LatLng) -> float | None:
    """Approx driving time in minutes between two (lat, lng) points.
    Returns None if the API key is missing or Google returns no route."""
    settings = get_settings()
    if not settings.google_maps_api_key or not origin or not dest:
        return None
    try:
        r = httpx.get(
            "https://maps.googleapis.com/maps/api/distancematrix/json",
            params={
                "origins": f"{origin[0]},{origin[1]}",
                "destinations": f"{dest[0]},{dest[1]}",
                "mode": "driving",
                "units": "imperial",
                "key": settings.google_maps_api_key,
            },
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        if data.get("status") != "OK":
            logger.info(f"Distance Matrix non-OK: {data.get('status')}")
            return None
        el = data["rows"][0]["elements"][0]
        if el.get("status") != "OK":
            return None
        return round(el["duration"]["value"] / 60.0, 1)
    except Exception as e:
        logger.warning(f"Distance Matrix failed: {e}")
        return None
