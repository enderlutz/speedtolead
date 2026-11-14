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
    monkeypatch.setattr(gu, "_restored", True)
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


def test_second_account_pulls_are_paused_unless_turned_on(monkeypatch):
    from types import SimpleNamespace
    from services import ghl
    monkeypatch.setattr(ghl, "get_settings", lambda: SimpleNamespace(ghl_location_id_2="WOOD"))
    ghl._loc2_cache.update(at=10**12, on=False)
    assert ghl.loc2_pulls_paused("WOOD") is True
    assert ghl.loc2_pulls_paused("STERLING") is False
    ghl._loc2_cache.update(at=10**12, on=True)
    assert ghl.loc2_pulls_paused("WOOD") is False
    ghl._loc2_cache.update(at=0.0, on=False)


def test_a_restart_keeps_the_days_count(monkeypatch):
    """After a deploy the meter picks up today's saved numbers (it read 1,691 at night)."""
    monkeypatch.setattr(gu, "_maybe_flush", lambda force=False: None)
    monkeypatch.setattr(gu, "_restored", False)
    monkeypatch.setattr(gu, "_today", lambda: "2026-11-13")
    monkeypatch.setattr(gu, "saved", lambda db: {"day": "2026-11-13", "total": 90000, "refused": 3,
                                                 "paths": {"contacts": 500}, "accounts": {}, "first_at": "x"})
    import database
    monkeypatch.setattr(database, "get_db", lambda: type("D", (), {"close": lambda self: None})())
    gu._state.update(day="", total=0, refused=0, paths={}, accounts={}, first_at="")
    gu.note(_resp("https://services.leadconnectorhq.com/contacts/abc123?locationId=L"))
    snap = gu.snapshot()
    assert snap["total"] == 90001 and snap["refused"] == 3 and snap["paths"]["contacts"] == 501


def test_yesterdays_saved_count_is_not_restored(monkeypatch):
    monkeypatch.setattr(gu, "_maybe_flush", lambda force=False: None)
    monkeypatch.setattr(gu, "_restored", False)
    monkeypatch.setattr(gu, "_today", lambda: "2026-11-14")
    monkeypatch.setattr(gu, "saved", lambda db: {"day": "2026-11-13", "total": 90000})
    import database
    monkeypatch.setattr(database, "get_db", lambda: type("D", (), {"close": lambda self: None})())
    gu._state.update(day="", total=0, refused=0, paths={}, accounts={}, first_at="")
    gu.note(_resp("https://services.leadconnectorhq.com/contacts/abc123?locationId=L"))
    assert gu.snapshot()["total"] == 1
