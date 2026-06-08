"""Route-clustering geometry — Sprint 3 T3.A (2026-06-07).

Two responsibilities:
  1. haversine() — great-circle distance between two lat/lng points in miles.
  2. find_nearby_scheduled_jobs() — return scheduled jobs ranked by
     route-stack value relative to a target point + ZIP, organized into
     two tiers: SAME ZIP (best — same neighborhood, same drive) and
     NEARBY (within ~15 mi but a different ZIP, still a routing benefit).

The compute is intentionally a thin pure-function pass — the caller
batch-loads the candidate jobs and we just sort + decorate. Cheap to
run on every lead detail page load."""

from __future__ import annotations
import math
from typing import Iterable

# Anything beyond this is treated as "not nearby" even if same-ZIP. ZIPs
# can be huge in rural areas; a 30-mile job in the same ZIP isn't useful
# for routing. Tunable from one place if A&T's service area changes.
DEFAULT_RADIUS_MILES = 15.0
EARTH_RADIUS_MILES = 3958.7613


def haversine(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in MILES between two points. Returns inf if
    any coordinate is unset (0.0, 0.0) so the caller can skip-on-missing
    rather than treat them as a real point near Africa."""
    if not (lat1 and lng1 and lat2 and lng2):
        return float("inf")
    rlat1 = math.radians(lat1)
    rlat2 = math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return EARTH_RADIUS_MILES * c


def cluster_nearby_jobs(
    *,
    target_lat: float,
    target_lng: float,
    target_zip: str,
    candidate_jobs: Iterable,  # iterable of ScheduledJob rows
    radius_miles: float = DEFAULT_RADIUS_MILES,
) -> list[dict]:
    """Decorate + rank candidate jobs against a target lead location.

    Returns a list of dicts (newest cleaner shape, NOT ScheduledJob rows)
    sorted by:
       1. same_zip first (True > False)
       2. distance_miles ascending
       3. job_date ascending (closer dates rank higher within distance ties)

    Jobs beyond radius_miles AND not in the same ZIP are EXCLUDED. Jobs
    with missing lat/lng on EITHER side fall through to a ZIP-match-only
    check — same ZIP without coords still counts as routing value, we
    just can't show a distance.

    Each row in the response:
        {
          job_id, customer_name, address, zip_code, job_date,
          arrival_time, lat, lng,
          distance_miles  — float or None when can't compute,
          same_zip        — bool,
        }
    """
    target_zip_clean = (target_zip or "").strip()
    out: list[dict] = []

    for j in candidate_jobs:
        job_zip = (j.zip_code or "").strip()
        same_zip = bool(target_zip_clean) and (job_zip == target_zip_clean)

        j_lat = float(j.lat or 0)
        j_lng = float(j.lng or 0)
        can_compute = (target_lat and target_lng and j_lat and j_lng)
        if can_compute:
            dist = haversine(target_lat, target_lng, j_lat, j_lng)
        else:
            dist = None

        # Inclusion rule:
        #   include if same_zip (even with no coords — neighborhood match)
        #   OR computed distance within radius
        #   else drop
        if not same_zip:
            if dist is None or dist > radius_miles:
                continue

        out.append({
            "job_id": j.id,
            "customer_name": j.customer_name or "",
            "address": j.address or "",
            "zip_code": job_zip,
            "job_date": j.job_date or "",
            "arrival_time": j.arrival_time or "",
            "lat": j_lat,
            "lng": j_lng,
            "distance_miles": round(dist, 1) if dist is not None else None,
            "same_zip": same_zip,
        })

    def _sort_key(row: dict) -> tuple:
        # same_zip True sorts BEFORE False (invert via 0/1 trick)
        z = 0 if row["same_zip"] else 1
        # None distance sorts AFTER computable ones — but only relevant
        # within the same_zip bucket since non-same-zip rows always have
        # a computable distance (else they were dropped).
        d = row["distance_miles"] if row["distance_miles"] is not None else 99999.0
        # Job date string sort works because we use YYYY-MM-DD throughout.
        return (z, d, row["job_date"])

    out.sort(key=_sort_key)
    return out
