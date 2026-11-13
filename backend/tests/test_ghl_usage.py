"""GHL usage meter (2026-11-13)."""
import httpx

from services import ghl_usage as gu


def _resp(url, status=200, limit=None, left=None, body=b""):
    req = httpx.Request("GET", url, content=body)
    headers = {}
    if limit is not None:
        headers = {"X-RateLimit-Limit-Daily": str(limit), "X-RateLimit-Daily-Remaining": str(left)}
    return httpx.Response(status, headers=headers, request=req)


def test_counts_requests_paths_refusals_and_allowance(monkeypatch):
    monkeypatch.setattr(gu, "_maybe_flush", lambda force=False: None)
    gu._state.update(day="", total=0, refused=0, paths={}, accounts={})
    gu.note(_resp("https://services.leadconnectorhq.com/contacts/abc123XYZ/notes?locationId=LOC1", limit=200000, left=150000))
    gu.note(_resp("https://services.leadconnectorhq.com/conversations/search?locationId=LOC1", status=429))
    s = gu.summary(gu.snapshot(), {"LOC1": "Sterling"})
    assert s["our_requests_today"] == 2 and s["refused_today"] == 1
    assert s["accounts"][0] == {"account": "Sterling", "limit": 200000, "left": 150000, "used": 50000,
                                "share_left": 0.75, "at": s["accounts"][0]["at"], "low": False}
    assert {t["endpoint"] for t in s["top_endpoints"]} == {"contacts/notes", "conversations/search"}


def test_low_allowance_is_flagged():
    s = gu.summary({"accounts": {"L": {"limit": 1000, "left": 100}}}, {})
    assert s["accounts"][0]["low"] is True


def test_path_label_drops_ids():
    assert gu.path_label("https://x.com/contacts/AbC123/tasks") == "contacts/tasks"
    assert gu.path_label("https://x.com/opportunities/search?q=1") == "opportunities/search"
