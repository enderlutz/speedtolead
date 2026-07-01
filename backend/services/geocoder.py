"""Address geocoding via Google Maps Geocoding API."""
from __future__ import annotations
import logging
import re
import httpx
from config import get_settings

logger = logging.getLogger(__name__)

# The company only serves the greater Houston metro, so bias + constrain
# geocoding to Texas. This is what stops an ambiguous street name from
# resolving to a same-named street in another state (e.g. New Jersey).
_HOME_STATE = "TX"
_HOME_BOUNDS = "28.9,-96.2|30.6,-94.5"  # SW|NE — greater Houston + suburbs


def _first_home_state_result(data: dict | None) -> dict | None:
    """The first result physically in the home state (TX). Google can return a
    match in the wrong state for a bare street name; this rejects those so we
    never cache a pin in New Jersey for a Houston lead."""
    if not data or data.get("status") != "OK":
        return None
    for res in data.get("results", []):
        for comp in res.get("address_components", []):
            if "administrative_area_level_1" in comp.get("types", []) and comp.get("short_name") == _HOME_STATE:
                return res
    return None


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

    # Give Google every signal we have: the street address, the home state
    # (adding "TX" stops a bare "123 Foo St" from resolving out of state), and
    # the ZIP folded into the query text.
    address_q = address
    if not re.search(r"\bTX\b", address_q, re.I) and "texas" not in address_q.lower():
        address_q = f"{address_q}, {_HOME_STATE}"
    if z and not re.search(r"\b\d{5}(?:-\d{4})?\b", address):
        address_q = f"{address_q} {z}"

    def _query(components: str) -> dict | None:
        try:
            r = httpx.get(
                "https://maps.googleapis.com/maps/api/geocode/json",
                params={"address": address_q, "key": api_key, "components": components, "bounds": _HOME_BOUNDS},
                timeout=10,
            )
            r.raise_for_status()
            return r.json()
        except Exception as e:
            logger.error(f"Geocoding request failed for '{address_q}': {e}")
            return None

    # Pass 1: hard ZIP + country filter (most precise).
    comps = ["country:US"]
    if z:
        comps.append(f"postal_code:{z}")
    data = _query("|".join(comps))
    result = _first_home_state_result(data)

    # Pass 2: ZIP dropped (stale/wrong ZIP on file) but constrained to Texas —
    # so it can never jump to a same-named street in another state.
    if result is None:
        if z:
            logger.info(f"Geocode found nothing for '{address_q}' with ZIP — retrying constrained to {_HOME_STATE}")
        data2 = _query(f"country:US|administrative_area:{_HOME_STATE}")
        result = _first_home_state_result(data2) or result
        data = data2 or data

    if result is None:
        logger.warning(
            f"Geocode failed for '{address}': status={(data or {}).get('status')} "
            f"error={(data or {}).get('error_message')}"
        )
        return None

    components_out = {
        c["types"][0]: c
        for c in result.get("address_components", [])
        if c.get("types")
    }
    out_zip = components_out.get("postal_code", {}).get("short_name", "") if "postal_code" in components_out else ""
    loc = result["geometry"]["location"]
    return {
        "formatted_address": result.get("formatted_address", address),
        "zip_code": out_zip,
        "lat": loc["lat"],
        "lng": loc["lng"],
    }


def extract_zip(address: str) -> str:
    """Try to extract a ZIP code from an address string, using geocoder as fallback."""
    match = re.search(r"\b(\d{5})(?:-\d{4})?\b", address)
    if match:
        return match.group(1)

    result = geocode_address(address)
    return result["zip_code"] if result else ""
