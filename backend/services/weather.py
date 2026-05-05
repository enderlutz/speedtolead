"""
Weather forecast lookup via Open-Meteo (free, no API key, accurate up to ~7 days).

Used by the scheduling page to surface weather risk per scheduled job. We
geocode US ZIP codes via Open-Meteo's geocoding endpoint, then ask their
forecast endpoint for daily summaries.

Caching: forecasts are stable for hours, so we keep an in-memory dict TTL of
30 minutes per ZIP. This is good enough for this volume; if we ever hit it
hard we can swap in Redis.
"""
from __future__ import annotations
import logging
import time
import httpx

logger = logging.getLogger(__name__)

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

_client = httpx.Client(timeout=10)
_cache: dict[str, tuple[float, dict]] = {}  # zip -> (cached_at_epoch, payload)
_TTL = 30 * 60                              # 30 minutes


def _zip_to_coords(zip_code: str) -> tuple[float, float] | None:
    if not zip_code:
        return None
    try:
        r = _client.get(GEOCODE_URL, params={"name": zip_code, "country": "US", "count": 1})
        r.raise_for_status()
        results = r.json().get("results") or []
        if not results:
            return None
        return float(results[0]["latitude"]), float(results[0]["longitude"])
    except Exception as e:
        logger.warning(f"Open-Meteo geocode failed for zip {zip_code}: {e}")
        return None


def get_forecast(zip_code: str) -> dict | None:
    """Returns {'days': [{date, high_f, low_f, precip_in, precip_chance, summary}, ...],
    'accurate_through': '<date>', 'note': '...'}"""
    zip_code = (zip_code or "").strip()
    if not zip_code:
        return None

    # Cache hit?
    cached = _cache.get(zip_code)
    if cached and (time.time() - cached[0]) < _TTL:
        return cached[1]

    coords = _zip_to_coords(zip_code)
    if not coords:
        return None
    lat, lon = coords

    try:
        r = _client.get(FORECAST_URL, params={
            "latitude": lat,
            "longitude": lon,
            "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,weather_code",
            "temperature_unit": "fahrenheit",
            "precipitation_unit": "inch",
            "timezone": "America/Chicago",
            "forecast_days": 14,  # request 14, only first 7 are accurate
        })
        r.raise_for_status()
        data = r.json().get("daily", {})
        dates = data.get("time", [])
        highs = data.get("temperature_2m_max", [])
        lows = data.get("temperature_2m_min", [])
        precip = data.get("precipitation_sum", [])
        precip_chance = data.get("precipitation_probability_max", [])
        codes = data.get("weather_code", [])

        days = []
        for i, d in enumerate(dates):
            days.append({
                "date": d,
                "high_f": highs[i] if i < len(highs) else None,
                "low_f": lows[i] if i < len(lows) else None,
                "precip_in": precip[i] if i < len(precip) else 0.0,
                "precip_chance_pct": precip_chance[i] if i < len(precip_chance) else None,
                "summary": _wmo_to_text(codes[i] if i < len(codes) else None),
            })

        accurate_through = dates[6] if len(dates) > 6 else (dates[-1] if dates else "")
        payload = {
            "zip_code": zip_code,
            "days": days,
            "accurate_through": accurate_through,
            "note": "Forecast accuracy drops sharply past 7 days.",
        }
        _cache[zip_code] = (time.time(), payload)
        return payload
    except Exception as e:
        logger.warning(f"Open-Meteo forecast failed for zip {zip_code}: {e}")
        return None


def get_day(zip_code: str, date: str) -> dict | None:
    """Convenience — single-day lookup. Returns None if outside forecast window."""
    fc = get_forecast(zip_code)
    if not fc:
        return None
    for d in fc["days"]:
        if d["date"] == date:
            return d
    return None


def _wmo_to_text(code: int | None) -> str:
    """WMO weather code → human label. Subset that matters for outdoor work."""
    if code is None:
        return ""
    table = {
        0: "Clear",
        1: "Mostly clear",
        2: "Partly cloudy",
        3: "Overcast",
        45: "Fog",
        48: "Freezing fog",
        51: "Light drizzle",
        53: "Drizzle",
        55: "Heavy drizzle",
        61: "Light rain",
        63: "Rain",
        65: "Heavy rain",
        71: "Light snow",
        73: "Snow",
        75: "Heavy snow",
        80: "Rain showers",
        81: "Heavy showers",
        82: "Violent showers",
        95: "Thunderstorm",
        96: "Thunderstorm + hail",
        99: "Heavy thunderstorm + hail",
    }
    return table.get(code, "")
