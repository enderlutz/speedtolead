"""David's rulebook (system_config david_playbook): teach / edit / forget,
the MCP tools, the rules sent at MCP initialize, the dashboard endpoints and
the nightly "Learned today" section. Fake rule text only."""
import json
from datetime import datetime

import pytest

from clock import CENTRAL as CT


def _at(monkeypatch, day: str):
    """Pin 'today' (Houston) for the playbook stamps."""
    import services.david_playbook as dp
    import services.stella as st
    fixed = datetime.fromisoformat(f"{day}T10:00:00").replace(tzinfo=CT)
    monkeypatch.setattr(dp, "now_ct", lambda: fixed)
    monkeypatch.setattr(st, "now_ct", lambda: fixed)


def test_teach_dedupe_edit_forget(db, monkeypatch):
    from services import david_playbook as dp
    assert dp.rules(db) == [] and dp.playbook_text(db) == ""

    _at(monkeypatch, "2026-11-10")
    a = dp.teach(db, "  Rule alpha: always do the first thing, because reasons. ")
    assert a["added"] and a["rule"] == {"n": 1, "text": "Rule alpha: always do the first thing, because reasons.",
                                        "added": "2026-11-10"}
    again = dp.teach(db, "rule alpha: always do the first thing, because reasons.")
    assert again["added"] is False and len(dp.rules(db)) == 1

    _at(monkeypatch, "2026-11-11")
    dp.teach(db, "Rule beta: check the second thing every night.")
    dp.teach(db, "Rule gamma: never skip the third thing.")
    assert [r["n"] for r in dp.rules(db)] == [1, 2, 3]
    assert [r["text"][:10] for r in dp.learned_on(db, "2026-11-11")] == ["Rule beta:", "Rule gamma"]
    assert len(dp.learned_on(db, "2026-11-10")) == 1 and dp.learned_on(db, "2026-11-09") == []

    out = dp.edit(db, 2, "Rule beta: check the second thing every morning.")
    assert out["before"].endswith("night.") and out["added"] == "2026-11-11"
    with pytest.raises(dp.RuleError):
        dp.edit(db, 1, "Rule gamma: never skip the third thing.")  # would duplicate rule 3

    gone = dp.forget(db, 1)
    assert gone["text"].startswith("Rule alpha")
    assert [r["n"] for r in dp.rules(db)] == [1, 2] and dp.rules(db)[0]["text"].startswith("Rule beta")

    text = dp.playbook_text(db)
    assert text.splitlines()[0].startswith("DAVID'S RULES")
    assert "1. Rule beta: check the second thing every morning. (2026-11-11)" in text

    for bad in (0, 3, "x"):
        with pytest.raises(dp.RuleError):
            dp.forget(db, bad)
    with pytest.raises(dp.RuleError):
        dp.teach(db, "short")


def test_stella_lessons_on_reads_her_dated_lines(db, monkeypatch):
    from services import stella
    _at(monkeypatch, "2026-11-11")
    stella.teach(db, "Lesson one for testing the stamp.")
    assert stella.lessons_on(db, "2026-11-11") == ["Lesson one for testing the stamp."]
    assert stella.lessons_on(db, "2026-11-10") == []
    # Her existing format is untouched: the default playbook is still the head.
    from database import SystemConfig
    assert SystemConfig.get(db, stella.PLAYBOOK_KEY, "").startswith("STELLA'S PLAYBOOK")


def test_nightly_learned_today(db, monkeypatch):
    from services import david_playbook as dp, project_manager as pm, stella
    assert pm.learned_today(db, "2026-11-11") == ""
    texts = pm.nightly_report(db, "2026-11-11")
    assert not any("LEARNED TODAY" in t for t in texts)

    _at(monkeypatch, "2026-11-11")
    dp.teach(db, "Rule delta: " + "x" * 200)
    dp.teach(db, "Rule epsilon: short and sweet.")
    stella.teach(db, "Lesson zeta for the nightly test.")
    sec = pm.learned_today(db, "2026-11-11")
    lines = sec.splitlines()
    assert lines[0] == "🧠 LEARNED TODAY: David 2 new rules, Stella 1 new lesson"
    assert lines[1].startswith("• David: Rule delta: ") and lines[1].endswith("…")
    assert len(lines[1]) <= len("• David: ") + 80
    assert lines[3] == "• Stella: Lesson zeta for the nightly test."
    texts = pm.nightly_report(db, "2026-11-11")
    assert any("LEARNED TODAY" in t for t in texts)
    assert all(len(t) <= pm.TEXT_LIMIT + 10 for t in texts)
    assert pm.learned_today(db, "2026-11-12") == ""


# ── MCP ──────────────────────────────────────────────────────────────────

from test_mcp_server import _call, _ok, _rpc, _sign_in, client  # noqa: E402,F401


def test_mcp_david_tools(client, db, monkeypatch):
    from database import SystemConfig
    _at(monkeypatch, "2026-11-11")
    _cid, _c, _v, tok = _sign_in(client)
    t = tok["access_token"]

    assert _ok(client, t, "david_rules", {})["rules"] == []
    out = _ok(client, t, "teach_david", {"rule": "Rule eta: confirm the thing before the crew goes out."})
    assert out["saved"] is True and out["rule"]["n"] == 1 and out["rule"]["added"] == "2026-11-11"
    dup = _ok(client, t, "teach_david", {"rule": "Rule eta: confirm the thing before the crew goes out."})
    assert dup["saved"] is False
    _ok(client, t, "teach_david", {"rule": "Rule theta: a second fake rule for the list."})
    assert [r["n"] for r in _ok(client, t, "david_rules", {})["rules"]] == [1, 2]
    assert json.loads(SystemConfig.get(db, "david_playbook", ""))[0]["added"] == "2026-11-11"

    bad = _call(client, t, "forget_david_rule", {"index": 9})
    assert bad["isError"] is True and "No rule 9" in bad["content"][0]["text"]
    short = _call(client, t, "teach_david", {"rule": "eh"})
    assert short["isError"] is True

    left = _ok(client, t, "forget_david_rule", {"index": 1})
    assert left["removed"]["text"].startswith("Rule eta") and len(left["rules"]) == 1

    log = _ok(client, t, "change_log", {})["changes"]
    assert [c["tool"] for c in log][:2] == ["forget_david_rule", "teach_david"]

    tools = {x["name"]: x for x in _rpc(client, t, "tools/list").json()["result"]["tools"]}
    assert tools["teach_david"]["annotations"]["readOnlyHint"] is False
    assert tools["forget_david_rule"]["annotations"]["readOnlyHint"] is False
    assert tools["david_rules"]["annotations"]["readOnlyHint"] is True


def test_mcp_initialize_carries_both_playbooks(client, db, monkeypatch):
    import api.mcp_server as srv
    from services import david_playbook as dp
    _cid, _c, _v, tok = _sign_in(client)
    t = tok["access_token"]

    first = _rpc(client, t, "initialize", {"protocolVersion": "2025-06-18"}).json()["result"]["instructions"]
    assert first.startswith(srv.INSTRUCTIONS)
    assert "== DAVID" in first and "No rules yet" in first
    assert "== STELLA" in first and "STELLA'S PLAYBOOK" in first

    dp.teach(db, "Rule iota: a fake rule that every connecting AI should see.")
    second = _rpc(client, t, "initialize", {"protocolVersion": "2025-06-18"}).json()["result"]["instructions"]
    assert "1. Rule iota: a fake rule that every connecting AI should see." in second
    assert second.index("== DAVID") < second.index("== STELLA")

    monkeypatch.setattr(srv, "PLAYBOOK_CAP", 60)
    capped = srv.instructions()
    assert "call stella for the rest" in capped


# ── dashboard endpoints ─────────────────────────────────────────────────

def _app_as(username):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import api.david_rules as dr
    from api.auth import get_current_user
    app = FastAPI()
    app.include_router(dr.router, prefix="/api")
    app.dependency_overrides[get_current_user] = lambda: {"sub": username}
    return TestClient(app)


def test_dashboard_endpoints_alan_only(db):
    from database import SystemConfig
    c = _app_as("alanbonner")
    assert c.get("/api/david-rules").json() == {"rules": []}
    r = c.post("/api/david-rules", json={"text": "Rule kappa: a fake dashboard rule."}).json()
    assert r["added"] is True and r["rules"][0]["text"] == "Rule kappa: a fake dashboard rule."
    assert c.post("/api/david-rules", json={"text": "Rule kappa: a fake dashboard rule."}).json()["added"] is False
    e = c.put("/api/david-rules/1", json={"text": "Rule kappa: an edited fake rule."}).json()
    assert e["rules"][0]["text"] == "Rule kappa: an edited fake rule."
    assert c.put("/api/david-rules/5", json={"text": "Rule lambda: not there."}).status_code == 400
    assert c.post("/api/david-rules", json={"text": "no"}).status_code == 400
    assert c.delete("/api/david-rules/1").json() == {"rules": []}
    db.expire_all()
    tools = [x["tool"] for x in json.loads(SystemConfig.get(db, "mcp_change_log", "[]"))]
    assert tools == ["teach_david", "edit_david_rule", "forget_david_rule"]

    other = _app_as("someone")
    assert other.get("/api/david-rules").status_code == 403
    assert other.post("/api/david-rules", json={"text": "Rule mu: should be refused."}).status_code == 403
