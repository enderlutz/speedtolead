"""How much of GoHighLevel's daily API allowance we use (Alan, 2026-11-13:
"understanding how many API calls we're getting a day, making sure we're not
breaking the limit on GoHighLevel" before moving automations off GHL).

GHL answers every request with its own count: X-RateLimit-Limit-Daily and
X-RateLimit-Daily-Remaining (per location / app). We keep the latest of
those per account, plus our own tally for the day: total requests, which
endpoints, and how many GHL refused (429). The numbers live in memory and
are saved to system_config every minute, so the dashboard and David's 9 PM
check can read them. Nothing here ever slows or blocks a request.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time

logger = logging.getLogger(__name__)

KEY = "ghl_usage"
FLUSH_SECONDS = 60
LOW_SHARE = 0.20     # warn when under 20% of the day's allowance is left

_lock = threading.Lock()
_state: dict = {"day": "", "total": 0, "refused": 0, "paths": {}, "accounts": {}, "first_at": "", "last_at": ""}
_last_flush = 0.0


def _today() -> str:
    from clock import now_ct
    return now_ct().strftime("%Y-%m-%d")


def _now_iso() -> str:
    from clock import now_ct
    return now_ct().isoformat(timespec="seconds")


def path_label(url: str) -> str:
    """'/contacts/abc123/notes' -> 'contacts/notes': the endpoint, ids dropped."""
    path = re.sub(r"^https?://[^/]+", "", url or "").split("?", 1)[0]
    parts = [p for p in path.split("/") if p and not re.search(r"\d", p) and len(p) < 30]
    return "/".join(parts[:2]) or "other"


def _account(resp) -> str:
    """Which GHL account the request was for: the locationId in the URL or
    body when there is one, else 'main'."""
    try:
        url = str(resp.request.url)
        m = re.search(r"locationId=([A-Za-z0-9]+)", url) or re.search(r"/locations/([A-Za-z0-9]{15,})", url)
        if m:
            return m.group(1)
        body = resp.request.content or b""
        m = re.search(rb'"locationId"\s*:\s*"([A-Za-z0-9]+)"', body[:2000])
        if m:
            return m.group(1).decode()
    except Exception:  # noqa: BLE001
        pass
    return "main"


def note(resp) -> None:
    """Count one GHL response. Never raises."""
    try:
        day = _today()
        with _lock:
            if _state["day"] != day:
                _state.update(day=day, total=0, refused=0, paths={}, first_at=_now_iso())
                for a in _state["accounts"].values():
                    a["seen_today"] = False
            _state["total"] += 1
            _state["last_at"] = _now_iso()
            label = path_label(str(resp.request.url))
            _state["paths"][label] = _state["paths"].get(label, 0) + 1
            if getattr(resp, "status_code", 0) == 429:
                _state["refused"] += 1
            h = resp.headers
            limit = h.get("x-ratelimit-limit-daily")
            left = h.get("x-ratelimit-daily-remaining")
            if limit and left is not None:
                acct = _account(resp)
                _state["accounts"][acct] = {"limit": int(limit), "left": int(left), "at": _now_iso(), "seen_today": True}
        _maybe_flush()
    except Exception:  # noqa: BLE001 - counting must never break a request
        logger.debug("ghl_usage.note failed", exc_info=True)


def snapshot() -> dict:
    with _lock:
        return json.loads(json.dumps(_state))


def _maybe_flush(force: bool = False) -> None:
    global _last_flush
    now = time.monotonic()
    if not force and now - _last_flush < FLUSH_SECONDS:
        return
    _last_flush = now
    threading.Thread(target=_flush, daemon=True).start()


def _flush() -> None:
    try:
        from database import SystemConfig, get_db
        db = get_db()
        try:
            SystemConfig.set(db, KEY, json.dumps(snapshot()))
            db.commit()
        finally:
            db.close()
    except Exception:  # noqa: BLE001
        logger.debug("ghl_usage flush failed", exc_info=True)


def saved(db) -> dict:
    """The last saved numbers (what the dashboard and David read)."""
    from database import SystemConfig
    try:
        v = json.loads(SystemConfig.get(db, KEY, "") or "{}")
        return v if isinstance(v, dict) else {}
    except ValueError:
        return {}


def summary(data: dict, names: dict | None = None) -> dict:
    """Plain numbers for a person: per account how much is used and left."""
    names = names or {}
    accounts = []
    for acct, a in (data.get("accounts") or {}).items():
        limit, left = int(a.get("limit") or 0), int(a.get("left") or 0)
        used = max(0, limit - left)
        accounts.append({"account": names.get(acct, acct), "limit": limit, "left": left, "used": used,
                         "share_left": round(left / limit, 3) if limit else None, "at": a.get("at", ""),
                         "low": bool(limit and left / limit < LOW_SHARE)})
    top = sorted((data.get("paths") or {}).items(), key=lambda kv: -kv[1])[:8]
    return {"day": data.get("day", ""), "our_requests_today": int(data.get("total") or 0),
            "refused_today": int(data.get("refused") or 0), "accounts": accounts,
            "top_endpoints": [{"endpoint": k, "requests": v} for k, v in top],
            "since": data.get("first_at", ""), "last_at": data.get("last_at", "")}


def account_names() -> dict:
    from config import get_settings
    s = get_settings()
    out = {}
    for loc, name in ((getattr(s, "ghl_location_id", ""), "Sterling"), (getattr(s, "ghl_location_id_2", ""), "Sterling (2nd)"),
                      (getattr(s, "ghl_location_id_at", ""), "A&T")):
        if loc:
            out[loc] = name
    out["main"] = "Sterling"
    return out


def report_lines(db) -> list[str]:
    """For David's 9 PM check."""
    s = summary(saved(db), account_names())
    if not s["our_requests_today"] and not s["accounts"]:
        return []
    lines = [f"Our GHL requests today: {s['our_requests_today']:,}" + (f" · GHL refused {s['refused_today']}" if s["refused_today"] else "")]
    for a in s["accounts"]:
        pct = f"{round(100 * (a['share_left'] or 0))}%"
        lines.append(f"{'⚠️ ' if a['low'] else ''}{a['account']}: {a['used']:,} of {a['limit']:,} used, {a['left']:,} left ({pct})")
    if s["top_endpoints"]:
        lines.append("Most: " + ", ".join(f"{t['endpoint']} {t['requests']:,}" for t in s["top_endpoints"][:3]))
    return lines
