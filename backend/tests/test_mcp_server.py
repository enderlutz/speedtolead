"""The Claude-app connector: sign-in (OAuth + PKCE) and the read-only tools."""
import base64
import hashlib
import json
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

PASSWORD = "correct-horse-battery"
REDIRECT = "https://claude.ai/api/mcp/auth_callback"


@pytest.fixture
def client(db, monkeypatch):
    from config import get_settings
    import api.mcp_server as srv

    s = get_settings()
    monkeypatch.setattr(s, "mcp_owner_password", PASSWORD)
    monkeypatch.setattr(s, "mcp_token_version", "1")
    monkeypatch.setattr(s, "mcp_public_url", "https://dash.example")
    srv._fails.clear()
    srv._used_codes.clear()
    app = FastAPI()
    app.include_router(srv.router)
    return TestClient(app, follow_redirects=False)


def _pkce():
    verifier = "v" * 64
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def _sign_in(c):
    reg = c.post("/mcp/oauth/register", json={"redirect_uris": [REDIRECT], "client_name": "Claude"})
    assert reg.status_code == 201
    cid = reg.json()["client_id"]
    verifier, challenge = _pkce()
    q = {"client_id": cid, "redirect_uri": REDIRECT, "response_type": "code", "state": "xyz",
         "code_challenge": challenge, "code_challenge_method": "S256"}
    page = c.get("/mcp/oauth/authorize", params=q)
    assert page.status_code == 200 and "Sterling Dashboard" in page.text
    r = c.post("/mcp/oauth/authorize", data=dict(q, password=PASSWORD))
    assert r.status_code == 302
    back = parse_qs(urlparse(r.headers["location"]).query)
    assert back["state"] == ["xyz"]
    code = back["code"][0]
    tok = c.post("/mcp/oauth/token", data={"grant_type": "authorization_code", "code": code,
                                            "client_id": cid, "redirect_uri": REDIRECT,
                                            "code_verifier": verifier})
    assert tok.status_code == 200, tok.text
    return cid, code, verifier, tok.json()


def _rpc(c, token, method, params=None, mid=1):
    return c.post("/mcp", headers={"Authorization": f"Bearer {token}"},
                  json={"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}})


def test_off_without_password(db, monkeypatch):
    from config import get_settings
    import api.mcp_server as srv
    monkeypatch.setattr(get_settings(), "mcp_owner_password", "")
    app = FastAPI()
    app.include_router(srv.router)
    c = TestClient(app)
    assert c.get("/.well-known/oauth-authorization-server").status_code == 404
    assert c.post("/mcp", json={}).status_code == 404


def test_discovery_points_at_sign_in(client):
    pr = client.get("/.well-known/oauth-protected-resource").json()
    assert pr["resource"] == "https://dash.example/mcp"
    meta = client.get("/.well-known/oauth-authorization-server").json()
    assert meta["code_challenge_methods_supported"] == ["S256"]
    assert meta["token_endpoint"] == "https://dash.example/mcp/oauth/token"


def test_no_token_gets_401_with_where_to_sign_in(client):
    r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert r.status_code == 401
    assert "resource_metadata=" in r.headers["www-authenticate"]


def test_full_sign_in_then_tools(client):
    _cid, _code, _v, tok = _sign_in(client)
    init = _rpc(client, tok["access_token"], "initialize", {"protocolVersion": "2025-06-18"}).json()
    assert init["result"]["protocolVersion"] == "2025-06-18"
    assert init["result"]["capabilities"]["tools"] is not None
    note = client.post("/mcp", headers={"Authorization": f"Bearer {tok['access_token']}"},
                       json={"jsonrpc": "2.0", "method": "notifications/initialized"})
    assert note.status_code == 202
    names = {t["name"] for t in _rpc(client, tok["access_token"], "tools/list").json()["result"]["tools"]}
    assert {"find_customer", "customer", "schedule", "job_card", "stain_stock"} <= names


def test_wrong_password_and_lockout(client):
    reg = client.post("/mcp/oauth/register", json={"redirect_uris": [REDIRECT]}).json()
    _v, challenge = _pkce()
    q = {"client_id": reg["client_id"], "redirect_uri": REDIRECT, "response_type": "code",
         "state": "s", "code_challenge": challenge, "code_challenge_method": "S256"}
    for _ in range(5):
        r = client.post("/mcp/oauth/authorize", data=dict(q, password="nope"))
        assert r.status_code == 200 and "Wrong password" in r.text
    r = client.post("/mcp/oauth/authorize", data=dict(q, password=PASSWORD))
    assert "Too many tries" in r.text


def test_code_works_once_and_needs_pkce(client):
    cid, code, verifier, _tok = _sign_in(client)
    again = client.post("/mcp/oauth/token", data={"grant_type": "authorization_code", "code": code,
                                                   "client_id": cid, "redirect_uri": REDIRECT,
                                                   "code_verifier": verifier})
    assert again.status_code == 400


def test_unregistered_redirect_refused(client):
    reg = client.post("/mcp/oauth/register", json={"redirect_uris": [REDIRECT]}).json()
    _v, challenge = _pkce()
    r = client.get("/mcp/oauth/authorize", params={
        "client_id": reg["client_id"], "redirect_uri": "https://evil.example/cb", "response_type": "code",
        "code_challenge": challenge, "code_challenge_method": "S256"})
    assert r.status_code == 400


def test_refresh_and_version_bump_signs_out(client, monkeypatch):
    from config import get_settings
    cid, _c, _v, tok = _sign_in(client)
    r = client.post("/mcp/oauth/token", data={"grant_type": "refresh_token",
                                              "refresh_token": tok["refresh_token"], "client_id": cid})
    assert r.status_code == 200
    monkeypatch.setattr(get_settings(), "mcp_token_version", "2")
    assert _rpc(client, r.json()["access_token"], "tools/list").status_code == 401


def _seed(db):
    from database import Lead, CompanyCamJob, StainInventoryItem, Message
    db.add(Lead(id="L1", contact_name="Test Customer", contact_phone="+15550001111", phone_key="5550001111",
                address="1 Test St", status="new", created_at="2026-11-01T15:00:00+00:00",
                form_data=json.dumps({"notes": "inside only", "fence_sides": ["Inside Back"]})))
    db.add(CompanyCamJob(id="J1", lead_id="L1", sqft=1000, gallons_needed=7, package="legacy",
                         color="Chocolate Chip · Valspar · Solid",
                         crew_json=json.dumps([{"username": "Chris", "date": "2026-11-11", "task": "cleaning",
                                                "order": 1, "pay_type": "flat", "pay": 65}]),
                         created_at="2026-11-01", updated_at="2026-11-01"))
    db.add(StainInventoryItem(id="S1", brand="Valspar", finish_type="solid", color_name="Chocolate Chip",
                              gallons=5, active=True))
    db.add(Message(id="M1", lead_id="L1", direction="inbound", body="Tuesday works",
                   created_at="2026-11-02T15:00:00+00:00"))
    db.commit()


def test_tools_read_the_data(client, db):
    _seed(db)
    _cid, _c, _v, tok = _sign_in(client)
    t = tok["access_token"]

    def call(name, args):
        res = _rpc(client, t, "tools/call", {"name": name, "arguments": args}).json()["result"]
        assert res["isError"] is False, res
        return json.loads(res["content"][0]["text"])

    assert call("find_customer", {"query": "Test Cust"})["matches"][0]["lead_id"] == "L1"
    assert call("find_customer", {"query": "0001111"})["matches"][0]["lead_id"] == "L1"
    full = call("customer", {"lead_id": "L1"})
    assert full["notes"] == "inside only" and full["texts_newest_first"][0]["text"] == "Tuesday works"
    assert full["job"]["sqft"] == 1000
    day = call("schedule", {"date": "2026-11-11"})
    assert day["stops"][0]["worker"] == "Chris" and day["stops"][0]["customer"] == "Test Customer"
    assert call("schedule", {"date": "2026-11-12"})["stops"] == []
    assert call("stain_stock", {"search": "Chocolate"})["stains"][0]["gallons"] == 5


def test_tool_errors_are_readable(client, db):
    _cid, _c, _v, tok = _sign_in(client)
    res = _rpc(client, tok["access_token"], "tools/call",
               {"name": "customer", "arguments": {"lead_id": "nope"}}).json()["result"]
    assert res["isError"] is True and "find_customer" in res["content"][0]["text"]
    bad = _rpc(client, tok["access_token"], "tools/call",
               {"name": "schedule", "arguments": {"date": "tomorrow"}}).json()["result"]
    assert bad["isError"] is True


def _text_lead(db):
    from database import Lead
    db.add(Lead(id="L2", contact_name="Text Customer", ghl_contact_id="ghl-test-2", ghl_location_id="loc",
                contact_phone="+15550002222", phone_key="5550002222", created_at="2026-11-01T15:00:00+00:00",
                form_data="{}"))
    db.commit()


def _call(client, token, name, args):
    return _rpc(client, token, "tools/call", {"name": name, "arguments": args}).json()["result"]


def test_texting_needs_a_draft_and_alans_send(client, db, monkeypatch):
    import services.ghl as ghl
    sent = []
    monkeypatch.setattr(ghl, "send_sms", lambda cid, body, **k: sent.append((cid, body)) or True)
    _text_lead(db)
    _cid, _c, _v, tok = _sign_in(client)
    t = tok["access_token"]

    draft = json.loads(_call(client, t, "draft_text", {"lead_id": "L2", "message": "Good afternoon, see you Thursday."})
                       ["content"][0]["text"])
    assert draft["text"] == "Good afternoon, see you Thursday." and not sent

    no = _call(client, t, "send_text", {"draft_id": draft["draft_id"], "alan_said": "looks good"})
    assert no["isError"] is True and not sent

    ok = _call(client, t, "send_text", {"draft_id": draft["draft_id"], "alan_said": "Send"})
    assert ok["isError"] is False and sent == [("ghl-test-2", "Good afternoon, see you Thursday.")]

    again = _call(client, t, "send_text", {"draft_id": draft["draft_id"], "alan_said": "send"})
    assert again["isError"] is True and len(sent) == 1


def test_tampered_draft_and_off_switch(client, db, monkeypatch):
    import services.ghl as ghl
    from database import SystemConfig
    sent = []
    monkeypatch.setattr(ghl, "send_sms", lambda cid, body, **k: sent.append(body) or True)
    _text_lead(db)
    _cid, _c, _v, tok = _sign_in(client)
    t = tok["access_token"]
    bad = _call(client, t, "send_text", {"draft_id": "made.up.token", "alan_said": "send"})
    assert bad["isError"] is True
    draft = json.loads(_call(client, t, "draft_text", {"lead_id": "L2", "message": "Hi"})["content"][0]["text"])
    SystemConfig.set(db, "mcp_texting_off", "1")
    off = _call(client, t, "send_text", {"draft_id": draft["draft_id"], "alan_said": "send"})
    assert off["isError"] is True and not sent


def test_same_words_twice_in_15_minutes_refused(client, db, monkeypatch):
    from datetime import datetime, timezone
    import services.ghl as ghl
    from database import Message
    sent = []
    monkeypatch.setattr(ghl, "send_sms", lambda cid, body, **k: sent.append(body) or True)
    _text_lead(db)
    db.add(Message(id="M9", lead_id="L2", direction="outbound", body="Hi there",
                   created_at=datetime.now(timezone.utc).isoformat()))
    db.commit()
    _cid, _c, _v, tok = _sign_in(client)
    t = tok["access_token"]
    draft = json.loads(_call(client, t, "draft_text", {"lead_id": "L2", "message": "Hi there"})["content"][0]["text"])
    dup = _call(client, t, "send_text", {"draft_id": draft["draft_id"], "alan_said": "send"})
    assert dup["isError"] is True and not sent


def _crew_user(db, username="Chris"):
    from database import User
    db.add(User(id="U-" + username, username=username, display_name=username, password_hash="x", role="worker"))
    db.commit()


def _ok(client, t, name, args):
    res = _call(client, t, name, args)
    assert res["isError"] is False, res
    return json.loads(res["content"][0]["text"])


def test_change_tools_write_and_log(client, db):
    from database import CompanyCamJob, CrewReimbursement, Lead, SystemConfig
    _seed(db)
    _crew_user(db, "Chris")
    _crew_user(db, "BrentBrown")
    _cid, _c, _v, tok = _sign_in(client)
    t = tok["access_token"]

    out = _ok(client, t, "set_job", {"lead_id": "L1", "color": "Classic Mahogany · Valspar · Solid",
                                    "sqft": 4123, "gallons_needed": 25})
    assert out["changed"]["sqft"] == [1000, 4123]
    job = db.query(CompanyCamJob).filter_by(lead_id="L1").first()
    db.refresh(job)
    assert job.color.startswith("Classic Mahogany") and job.gallons_needed == 25 and job.sqft_edited

    crew = _ok(client, t, "set_crew", {"lead_id": "L1", "worker": "chris", "date": "2026-11-11",
                                      "task": "cleaning", "pay_type": "flat", "pay": 59})
    assert any(e["pay"] == 59 and e["pay_type"] == "flat" for e in crew["crew_now"])
    monday = _ok(client, t, "set_crew", {"lead_id": "L1", "worker": "BrentBrown", "date": "2026-11-16",
                                        "task": "staining", "pay_type": "hourly", "pay": 18})
    assert "never" in monday["warning"]
    bad = _call(client, t, "set_crew", {"lead_id": "L1", "worker": "Nobody", "date": "2026-11-11", "task": "cleaning"})
    assert bad["isError"] is True and "Chris" in bad["content"][0]["text"]

    _ok(client, t, "add_note", {"lead_id": "L1", "note": "cover the pool", "where": "cleaning"})
    _ok(client, t, "add_note", {"lead_id": "L1", "note": "wife picks the color"})
    db.expire_all()
    assert "cover the pool" in db.query(CompanyCamJob).filter_by(lead_id="L1").first().cleaning_notes
    assert "wife picks the color" in json.loads(db.query(Lead).filter_by(id="L1").first().form_data)["notes"]

    _ok(client, t, "log_receipt", {"worker": "BrentBrown", "amount": 23.6, "what": "10 pickets", "date": "2026-11-10"})
    assert db.query(CrewReimbursement).filter_by(username="BrentBrown").first().amount == 23.6

    _ok(client, t, "teach_stella", {"lesson": "Evenings mean 5 PM or later, because customers work days."})
    assert "Evenings mean 5 PM" in SystemConfig.get(db, "stella_playbook", "")

    off = _ok(client, t, "david_day_off", {"worker": "Chris", "weekday": "sunday", "kind": "ask"})
    assert off["all_days_off"]["chris"]["ask"] == ["sunday"]

    log = _ok(client, t, "change_log", {})["changes"]
    assert [c["tool"] for c in log][:3] == ["david_day_off", "teach_stella", "log_receipt"]


def test_change_tools_are_marked_as_writes(client):
    _cid, _c, _v, tok = _sign_in(client)
    tools = {x["name"]: x for x in _rpc(client, tok["access_token"], "tools/list").json()["result"]["tools"]}
    assert tools["set_crew"]["annotations"]["readOnlyHint"] is False
    assert tools["customer"]["annotations"]["readOnlyHint"] is True
