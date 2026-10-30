"""The calendar invite says what the call settled, and nothing made up
(Alan, 2026-10-30)."""
import json
import uuid

from database import Booking, CallRecording, CallTranscript, Estimate, Lead, Message, PayLink
from services import invite_from_call as icf

CALL = ("Right now we actually have next Saturday available. Can we possibly do it on the fourteenth. "
        "That would be Saturday the fourteenth. Chris, our cleaner, will stop by that day between about nine to 10AM. "
        "Are you usually home in the mornings on a Saturday? I will be because I'm unpacking. "
        "We'll bring the samples that day, the signature and the legacy. We charge $12 for pine and then $14 for cedar. "
        "Then Sunday, we can get it stained. ") * 3


def _setup(db):
    lead = Lead(id=str(uuid.uuid4()), contact_name="Robin Test", contact_phone="+17135550123", ghl_contact_id="g-rt",
                status="new", form_data=json.dumps({"fence_sides": ["Inside Back"]}), address="1 Oak St")
    db.add(lead)
    rec = CallRecording(id=str(uuid.uuid4()), lead_id=lead.id, created_at="2026-10-30T19:39:00Z")
    db.add(rec)
    db.add(CallTranscript(id=str(uuid.uuid4()), recording_id=rec.id, lead_id=lead.id, full_text=CALL, created_at="2026-10-30T20:00:00Z"))
    db.add(Message(id=str(uuid.uuid4()), lead_id=lead.id, ghl_contact_id="g-rt", direction="inbound",
                   body="All that are within my property side", message_type="TYPE_SMS", created_at="2026-10-30T03:41:00Z"))
    db.add(Estimate(id=str(uuid.uuid4()), lead_id=lead.id, service_type="fence_staining", status="sent",
                    tiers=json.dumps({"essential": 1617.0, "signature": 1848.0, "legacy": 2329.25}), created_at="2026-10-30T19:40:00Z"))
    db.commit()
    return lead


GOOD = {
    "visits": [{"date": "2026-11-14", "what": "Chris cleans the fence and shows you the stain samples", "window": "9 to 10 AM",
                "quote": "Chris, our cleaner, will stop by that day"},
               {"date": "2026-11-15", "what": "We stain the fence", "window": "", "quote": "Then Sunday, we can get it stained"}],
    "home": {"value": "yes", "text": "You'll be home Saturday morning to pick the color", "quote": "I will be because I'm unpacking"},
    "package": {"choices": ["signature", "legacy"], "text": "Signature or Legacy, you pick from the samples", "quote": "the signature and the legacy"},
    "color": {"text": "A muted medium walnut", "quote": "a muted medium walnut I like"},       # not in the call → dropped
    "talked_about": [{"text": "Boards replaced: $12 pine, $14 cedar", "quote": "We charge $12 for pine and then $14 for cedar"},
                     {"text": "Free gutter cleaning", "quote": "we clean your gutters for free"}],  # made up → dropped
}


def test_only_lines_backed_by_the_call_are_kept(db):
    lead = _setup(db)
    calls, texts = icf.sources(db, lead.id)
    f = icf.verify(GOOD, calls, texts)
    assert [v["date"] for v in f["visits"]] == ["2026-11-14", "2026-11-15"]
    assert f["home"]["value"] == "yes" and f["package"]["choices"] == ["signature", "legacy"]
    assert "color" not in f
    assert [t["text"] for t in f["talked_about"]] == ["Boards replaced: $12 pine, $14 cedar"]


def test_the_customer_invite_reads_the_call(db, monkeypatch):
    from api import booking as bk
    lead = _setup(db)
    b = Booking(token=uuid.uuid4().hex[:22], lead_id=lead.id, date="2026-11-14", tier="signature", color="tbd",
                notes="choosing between signature and legacy", total_cents=184800, price_cents=184800, status="held",
                created_at="2026-10-30T19:56:00Z")
    db.add(b)
    paid = PayLink(token=uuid.uuid4().hex[:20], lead_id=lead.id, kind="deposit", amount_cents=25000, status="paid",
                   paid_at="2026-10-30T19:57:00Z", created_at="2026-10-30T19:56:00Z")
    db.add(paid)
    db.commit()
    monkeypatch.setattr(icf, "_ask", lambda day, calls, texts: GOOD)
    icf.build(db, lead, b.date)
    _, text = bk._customer_text(db, lead, b, paid)
    assert "a day or two before" not in text and "No need to be home" not in text
    assert "Saturday, November 14, 9 to 10 AM: Chris cleans the fence and shows you the stain samples" in text
    assert "Sunday, November 15: We stain the fence" in text
    assert "You'll be home Saturday morning to pick the color" in text
    assert "Price: Signature Finish $1,848 or Legacy Finish $2,329.25" in text or "Price: Signature $1,848 or Legacy $2,329.25" in text
    assert "WHAT WE TALKED ABOUT" in text and "$12 pine, $14 cedar" in text and "gutter" not in text


def test_nothing_said_keeps_the_usual_invite(db, monkeypatch):
    from api import booking as bk
    lead = _setup(db)
    b = Booking(token=uuid.uuid4().hex[:22], lead_id=lead.id, date="2026-11-14", tier="signature", color="Pecan",
                total_cents=184800, price_cents=184800, status="held", created_at="2026-10-30T19:56:00Z")
    paid = PayLink(token=uuid.uuid4().hex[:20], lead_id=lead.id, kind="deposit", amount_cents=25000, status="paid",
                   paid_at="2026-10-30T19:57:00Z", created_at="2026-10-30T19:56:00Z")
    db.add_all([b, paid])
    db.commit()
    monkeypatch.setattr(icf, "_ask", lambda day, calls, texts: {})
    icf.build(db, lead, b.date)
    _, text = bk._customer_text(db, lead, b, paid)
    assert "a day or two before" in text and "Signature Finish package in Pecan" in text
