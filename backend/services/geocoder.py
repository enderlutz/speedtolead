"""Address geocoding via Google Maps Geocoding API."""
from __future__ import annotations
import logging
import re
import httpx
from config import get_settings

logger = logging.getLogger(__name__)


def geocode_address(address: str, zip_code: str = "", api_key: str | None = None) -> dict | None:
    """
    Geocode an address and return structured result.
    Returns dict with: formatted_address, zip_code, lat, lng, or None on failure.

    `api_key` lets a caller force a specific key (e.g. the Lead Map passes the
    browser key, which has Geocoding enabled). When omitted, prefer the
    dedicated geocoding key, then the maps/browser key.

    When a separate `zip_code` is provided, we pass it to Google as a
    `components` constraint AND fold it into the address string. The
    components filter is a hard constraint on Google's side — the API
    will only return matches inside that ZIP — which is a much stronger
    signal than just hoping Google guesses right from a vague address.
    All US queries are also constrained to country:US so "123 Main St"
    doesn't suddenly resolve to a London match.
    """
    settings = get_settings()
    api_key = api_key or settings.google_maps_api_key or settings.google_maps_browser_key
    if not api_key or not address:
        return None

    z = (zip_code or "").strip()
    # Pull a 5-digit ZIP out of the address itself if we weren't given
    # one separately — same logic extract_zip uses below, inlined here
    # so we can pass it as a hard components constraint to Google.
    if not z:
        m = re.search(r"\b(\d{5})(?:-\d{4})?\b", address)
        if m:
            z = m.group(1)
    z = z[:5] if len(z) >= 5 else ""

    # If the caller passed us a ZIP and the address doesn't already
    # contain a ZIP, fold it into the query string so Google has the
    # zip in BOTH the address text and the components filter — a couple
    # of edge cases (multiple cities sharing a street name) resolve
    # better when the zip is in the address text too.
    address_q = address
    if z and not re.search(r"\b\d{5}(?:-\d{4})?\b", address):
        address_q = f"{address}, {z}"

    params = {"address": address_q, "key": api_key}
    components = ["country:US"]
    if z:
        components.append(f"postal_code:{z}")
    params["components"] = "|".join(components)

    try:
        r = httpx.get(
            "https://maps.googleapis.com/maps/api/geocode/json",
            params=params,
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()

        if data.get("status") != "OK" or not data.get("results"):
            # If the components-constrained query found nothing, retry once
            # without the ZIP constraint — covers the case where the lead's
            # zip_code on file is stale or wrong but the street address is
            # otherwise valid.
            if z:
                logger.info(
                    f"Geocode found nothing for '{address_q}' with ZIP constraint — retrying without"
                )
                r2 = httpx.get(
                    "https://maps.googleapis.com/maps/api/geocode/json",
                    params={
                        "address": address,
                        "key": api_key,
                        "components": "country:US",
                    },
                    timeout=10,
                )
                r2.raise_for_status()
                data = r2.json()
                if data.get("status") != "OK" or not data.get("results"):
                    logger.warning(
                        f"Geocode failed for '{address}': status={data.get('status')} "
                        f"error={data.get('error_message')}"
                    )
                    return None
            else:
                logger.warning(
                    f"Geocode failed for '{address}': status={data.get('status')} "
                    f"error={data.get('error_message')}"
                )
                return None

        result = data["results"][0]
        components_out = {
            c["types"][0]: c
            for c in result.get("address_components", [])
            if c.get("types")
        }

        out_zip = ""
        if "postal_code" in components_out:
            out_zip = components_out["postal_code"].get("short_name", "")

        return {
            "formatted_address": result.get("formatted_address", address),
            "zip_code": out_zip,
            "lat": result["geometry"]["location"]["lat"],
            "lng": result["geometry"]["location"]["lng"],
        }
    except Exception as e:
        logger.error(f"Geocoding failed for '{address_q}': {e}")
        return None


def extract_zip(address: str) -> str:
    """Try to extract a ZIP code from an address string, using geocoder as fallback."""
    match = re.search(r"\b(\d{5})(?:-\d{4})?\b", address)
    if match:
        return match.group(1)

    result = geocode_address(address)
    return result["zip_code"] if result else ""
