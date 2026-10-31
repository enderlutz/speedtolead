"""The Google review mark and the hand-pressed reminder (Alan, 2026-10-31)."""
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import google_review as gr  # noqa: E402


def _lead(db, name="Dana Fields", cid="c1"):
    from database import Lead
    lead = Lead(id=str(uuid.uuid4()), contact_name=name, address="1 Main St", division="fence", status="new",
                contact_phone="+15550001111", ghl_contact_id=cid, form_data=json.dumps({"fence_sides": ["back"]}))
    db.add(lead)
    db.commit()
    return lead


def _paid_balance(db, lead, answers=None):
    from database import PayLink
    l = PayLink(token=f"tok-{uuid.uuid4()}", lead_id=lead.id, kind="balance", amount_cents=149000, status="paid",
                created_at="2026-10-31T20:00:00+00:00", paid_at="2026-10-31T21:00:00+00:00", answers=json.dumps(answers or {}))
    db.add(l)
    db.commit()
    return l


def test_mark_keeps_the_rest_of_form_data(db):
    lead = _lead(db)
    assert gr.state(lead)["status"] == ""
    s = gr.set_status(db, lead, "posted", "Alan")
    assert s["status"] == "posted" and s["marked_by"] == "Alan" and s["marked_at"]
    assert json.loads(lead.form_data)["fence_sides"] == ["back"]
    s = gr.set_status(db, lead, "", "Alan")
    assert s["status"] == "" and s["marked_by"] == ""


def test_draft_points_at_the_photos_page_and_counts_reminders(db):
    lead = _lead(db)
    assert gr.after_url(db, lead.id) == ""
    link = _paid_balance(db, lead)
    url = gr.after_url(db, lead.id)
    assert url.endswith(f"/after/{link.token}")
    d = gr.draft(lead, url)
    assert d.startswith("Hey Dana, it's Alan with Sterling.") and url in d
    assert gr.draft(lead, url, gr.sender_name({"sub": "olga"})).startswith("Hey Dana, it's Amy")
    s = gr.add_reminder(db, lead, "Alan", d)
    assert len(s["reminders"]) == 1 and s["reminders"][0]["by"] == "Alan"


def test_clicked_reads_the_after_page_answers(db):
    lead = _lead(db)
    a = _paid_balance(db, lead, {"review_clicked": True})
    assert gr.clicked([a]) is True
    b = _paid_balance(db, _lead(db, "Other", "c2"), {})
    assert gr.clicked([b]) is False


def test_queue_row_carries_the_review(db):
    from api import invoice_queue as iq
    lead = _lead(db)
    _paid_balance(db, lead, {"review_clicked": True})
    gr.set_status(db, lead, "not_yet", "Alan")
    row = next(r for r in iq.stage_rows(db) if r["lead_id"] == lead.id)
    assert row["stage"] == "closed"
    assert row["review"] == {"status": "not_yet", "marked_by": "Alan", "marked_at": row["review"]["marked_at"], "reminded": 0, "clicked": True}


def test_remind_endpoint_sends_once_and_writes_it_down(db, monkeypatch):
    from api import customer_upsell as cu
    lead = _lead(db)
    _paid_balance(db, lead)
    sent = []
    monkeypatch.setattr(cu.ghl, "send_sms", lambda cid, msg, location_id=None: sent.append((cid, msg)) or True)
    monkeypatch.setattr(cu, "get_db", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    out = cu.remind_review(lead.id, cu.ReviewRemindBody(message="Hey Dana, did you post it?"), user={"sub": "alanbonner", "name": "Alan"})
    assert sent == [("c1", "Hey Dana, did you post it?")]
    assert len(out["reminders"]) == 1 and out["after_url"] and out["clicked"] is False
    out = cu.set_review(lead.id, cu.ReviewStatusBody(status="posted"), user={"sub": "alanbonner", "name": "Alan"})
    assert out["status"] == "posted"


def test_the_lead_page_tick_and_the_queue_mark_agree(db, monkeypatch):
    """The journey strip's Google review tick (api/leads.py) and the queue's
    mark read and write the same key, so neither can show the other wrong."""
    from api import leads as leads_api
    lead = _lead(db)
    monkeypatch.setattr(leads_api, "get_db", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    leads_api.set_google_review(lead.id, leads_api.GoogleReviewBody(left=True), user={"sub": "alanbonner", "name": "Alan"})
    assert gr.state(lead)["status"] == "posted" and gr.state(lead)["marked_by"] == "Alan"
    gr.set_status(db, lead, "not_yet", "Alan")
    assert json.loads(lead.form_data).get("google_review_left_at") is None
    gr.set_status(db, lead, "posted", "Alan")
    assert json.loads(lead.form_data)["google_review_left_at"]
    leads_api.set_google_review(lead.id, leads_api.GoogleReviewBody(left=False), user={"sub": "alanbonner"})
    assert gr.state(lead)["status"] == ""
