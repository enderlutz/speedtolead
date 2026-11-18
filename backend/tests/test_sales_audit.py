"""The sales_audit MCP tool: lead journeys + funnel, no names or phones, Sterling only."""
import json
import uuid

from services import mcp_tools
from services.sales_audit import redact


def _lead(db, name, created, **kw):
    from database import Lead
    lead = Lead(id=str(uuid.uuid4()), contact_name=name, contact_phone="+17135550100", contact_email="x@y.com",
                address="123 Fake St", zip_code="77493", service_type="fence_staining", status=kw.pop("status", "sent"),
                kanban_column="new_lead", priority="HIGH", form_data=json.dumps({"fence_age": "1-6 years"}),
                created_at=created, updated_at=created, ghl_location_id=kw.pop("loc", "LOC"), lead_source="ad", **kw)
    db.add(lead)
    return lead


def _call(db, lead, at, secs, text, who="", vm=False):
    from database import CallRecording, CallTranscript
    rid = str(uuid.uuid4())
    db.add(CallRecording(id=rid, lead_id=lead.id, created_at=at, duration_seconds=secs, recorded_by=who,
                         is_voicemail=vm, has_recording_data=False))
    if text:
        db.add(CallTranscript(id=str(uuid.uuid4()), recording_id=rid, lead_id=lead.id, full_text=text))


def _setup(db, monkeypatch):
    from database import CustomerPayment, Estimate, Message, PayLink, User
    import config
    monkeypatch.setattr(config.get_settings(), "ghl_location_id_at", "AT-LOC", raising=False)
    db.add(User(id=str(uuid.uuid4()), username="olga", display_name="Olga", role="va", ghl_user_id="U-OLGA", password_hash="x"))
    # Won by card, same day: Olga asks for Friday and the $250.
    a = _lead(db, "Mary Jones", "2026-11-02T15:00:00+00:00")
    db.add(Message(id="m1", lead_id=a.id, direction="outbound", body="Hi Mary! this is Amy", created_at="2026-11-02T15:01:00+00:00"))
    db.add(Message(id="m2", lead_id=a.id, direction="inbound", body="Inside only please", created_at="2026-11-02T15:20:00+00:00"))
    _call(db, a, "2026-11-02T15:30:00+00:00", 420,
          "Hi Mary, this is Amy with Sterling. I have Friday open, does that work for you? "
          "It's just $250 to hold the day. My number is 713 555 0100.", who="U-OLGA")
    db.add(Estimate(id=str(uuid.uuid4()), lead_id=a.id, service_type="fence_staining", status="sent",
                    inputs=json.dumps({"linear_feet": "200"}), tiers=json.dumps({"essential": 1000, "signature": 1200, "legacy": 1500}),
                    created_at="2026-11-02T15:25:00+00:00", sent_at="2026-11-02T15:26:00+00:00"))
    db.add(PayLink(token="t-a", lead_id=a.id, kind="deposit", amount_cents=25000, status="paid", answers="{}",
                   created_at="2026-11-02T15:40:00+00:00", paid_at="2026-11-02T16:00:00+00:00",
                   job_tier="legacy", job_total_cents=150000))
    db.add(CustomerPayment(id="cp1", lead_id=a.id, pay_link_token="t-a", kind="deposit", amount_cents=25000,
                           currency="usd", method="link", created_at="2026-11-02T16:00:00+00:00"))
    # Won by bank, 6 days later; Geoconda's call has no GHL user, but she says "this is Lily".
    b = _lead(db, "Bob Smith", "2026-11-03T15:00:00+00:00")
    _call(db, b, "2026-11-03T16:00:00+00:00", 200, "Hello Bob, this is Lily from Sterling.")
    db.add(PayLink(token="t-b", lead_id=b.id, kind="deposit", amount_cents=25000, status="paid", answers="{}",
                   created_at="2026-11-03T16:00:00+00:00", paid_at="2026-11-09T16:00:00+00:00"))
    # Open: a voicemail, never transcribed.
    c = _lead(db, "Cara Lee", "2026-11-04T15:00:00+00:00")
    _call(db, c, "2026-11-04T15:05:00+00:00", 30, "", who="U-OLGA", vm=True)
    # Excluded: a test lead and an A&T lead.
    _lead(db, "Test Lead", "2026-11-05T15:00:00+00:00", is_test=True)
    _lead(db, "AT Person", "2026-11-05T15:00:00+00:00", loc="AT-LOC")
    db.commit()
    return a, b, c


def test_journeys_funnel_and_no_pii(db, monkeypatch):
    a, b, c = _setup(db, monkeypatch)
    out = mcp_tools.call_tool(db, "sales_audit", {"start": "2026-11-01", "end": "2026-11-10", "include_excerpts": True})
    assert out["total_matching"] == 3 and out["returned"] == 3 and out["next_cursor"] == ""
    rows = {r["lead_id"]: r for r in out["leads"]}
    ra, rb, rc = rows[a.id], rows[b.id], rows[c.id]
    assert ra["status_now"] == "won" and ra["deposit"]["days_after_lead"] == 0.0 and ra["deposit"]["method"] == ["link"]
    assert ra["first_text"]["minutes_after_lead"] == 1.0 and ra["quote"]["legacy"] == 1500
    assert ra["asked_for_date_inference"] is True and ra["asked_for_deposit_inference"] is True
    assert ra["calls"]["by_va"] == {"Olga": 1} and ra["package_sold"] == "legacy" and ra["sold_total"] == 1500
    assert rb["calls"]["by_va"] == {"Geoconda": 1} and rb["deposit"]["days_after_lead"] == 6.0
    assert rc["status_now"] == "open" and rc["calls"]["voicemail"] == 1 and rc["asked_for_date_inference"] is None
    s = out["summary"]
    assert s["funnel"]["deposit_paid"] == 2 and s["funnel"]["reached_live"] == 2 and s["funnel"]["quoted"] == 1
    assert s["close_timing"] == {"same day": 1, "4-7 days": 1}
    assert s["data_quality"]["calls_without_transcript"] == 1
    blob = json.dumps(out)
    for pii in ("Mary", "Jones", "Bob", "Smith", "Cara", "713", "555", "123 Fake", "x@y.com", "Test Lead", "AT Person"):
        assert pii not in blob, pii


def test_filters_and_paging(db, monkeypatch):
    a, b, c = _setup(db, monkeypatch)
    won = mcp_tools.call_tool(db, "sales_audit", {"start": "2026-11-01", "end": "2026-11-10", "outcome": "won"})
    assert won["total_matching"] == 2
    olga = mcp_tools.call_tool(db, "sales_audit", {"start": "2026-11-01", "end": "2026-11-10", "va": "olga"})
    assert {r["lead_id"] for r in olga["leads"]} == {a.id, c.id}
    p1 = mcp_tools.call_tool(db, "sales_audit", {"start": "2026-11-01", "end": "2026-11-10", "limit": 2})
    assert p1["returned"] == 2 and p1["next_cursor"] == "2"
    p2 = mcp_tools.call_tool(db, "sales_audit", {"start": "2026-11-01", "end": "2026-11-10", "limit": 2, "cursor": "2"})
    assert p2["returned"] == 1 and p2["next_cursor"] == ""
    assert "sales_audit" in {t["name"] for t in mcp_tools.list_tools()}
    assert next(t for t in mcp_tools.list_tools() if t["name"] == "sales_audit")["annotations"]["readOnlyHint"] is True


def test_redact_blanks_names_staff_and_numbers():
    out = redact("Hi Mary, this is Amy. Call 713-555-0100 or card 4242 4242 4242 4242.", ["Mary", "Jones"])
    assert "Mary" not in out and "Amy" not in out and "713" not in out and "4242" not in out
    assert "[CUSTOMER]" in out and "[STAFF]" in out and "[NUMBER]" in out
