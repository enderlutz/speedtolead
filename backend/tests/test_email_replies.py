"""A customer's emailed reply comes in whole.

Alan, 2026-10-08: Liza Reheiser emailed "Definitely will go with your
company. I close on the 30th…" and all we stored was our own estimate email,
because GHL shows a thread by its first email. These pin the fix: each email
in the thread is fetched by id and cut at the quoted part.
"""
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from database import Lead, Message, ObjectionScan  # noqa: E402
from services import email_replies as er  # noqa: E402
from services import ghl  # noqa: E402

OURS = ("Hey Liza,\n\nHere's your estimate from Sterling Fence Staining — three finish options "
        "laid out so you can pick what fits:\n\n— Sterling Fence Staining")
LIZA_HTML = (
    "<div dir=\"ltr\">Definitely will go with your company. I close on the 30th and move in on the 31. "
    "I will call you when I’m ready ok. Thank you!</div><div dir=\"ltr\"><br>Sent from my iPhone</div>"
    "<div dir=\"ltr\"><br><blockquote type=\"cite\">On Oct 6, 2026, at 5:59 PM, Sterling Fence Staining "
    "&lt;x@mail.msgsndrroute.com&gt; wrote:<br><br>Hey Liza,<br>Here's your estimate…</blockquote></div>"
)
LIZA_SAID = ("Definitely will go with your company. I close on the 30th and move in on the 31. "
             "I will call you when I’m ready ok. Thank you!")


def test_reply_text_from_iphone_html():
    assert er.reply_text(LIZA_HTML, "text/html") == LIZA_SAID


def test_reply_text_from_plain_text_with_a_wrapped_on_wrote_line():
    body = (LIZA_SAID + "\n\nSent from my iPhone\n\nOn Oct 6, 2026, at 5:59 PM, Sterling Fence Staining "
            "<alanjoshuabonner+icloud.com@mail.msgsndrroute.com> wrote:\n\n\nHey Liza,\n")
    assert er.reply_text(body, "text/plain") == LIZA_SAID


def test_reply_text_gmail_and_outlook():
    gmail = 'Sounds good, Tuesday works.<div class="gmail_quote">On Mon, Oct 5 … wrote:<br>old</div>'
    assert er.reply_text(gmail, "text/html") == "Sounds good, Tuesday works."
    outlook = "Too much for us right now.\n\n-----Original Message-----\nFrom: Sterling\n"
    assert er.reply_text(outlook) == "Too much for us right now."


def _setup(db, monkeypatch, *, direction="inbound", emails=None):
    lead = Lead(id=str(uuid.uuid4()), contact_name="Liza Reheiser", ghl_contact_id=str(uuid.uuid4()),
                pipeline_version="v2", status="new", created_at="2026-10-06T01:05:49Z")
    row = Message(id=str(uuid.uuid4()), lead_id=lead.id, ghl_contact_id=lead.ghl_contact_id,
                  direction=direction, body=OURS, message_type="TYPE_EMAIL",
                  ghl_message_id="dNJZ" + uuid.uuid4().hex[:8], created_at="2026-10-07T01:05:11.708Z")
    db.add_all([lead, row])
    db.commit()
    emails = emails if emails is not None else {
        "ours": {"direction": "outbound", "dateAdded": "2026-10-06T22:59:40Z", "body": OURS},
        "hers": {"direction": "inbound", "dateAdded": "2026-10-07T01:05:11Z", "body": LIZA_HTML,
                 "contentType": "text/html"},
    }
    monkeypatch.setattr(ghl, "get_message", lambda mid, loc=None: {
        "dateAdded": row.created_at, "meta": {"email": {"messageIds": list(emails)}}})
    monkeypatch.setattr(ghl, "get_email_message", lambda eid, loc=None: emails.get(eid, {}))
    monkeypatch.setattr("services.event_bus.publish", lambda *a, **k: None)
    return lead, row


def test_liza_reply_replaces_our_quoted_text(db, monkeypatch):
    lead, row = _setup(db, monkeypatch)
    db.add(ObjectionScan(source_key=f"text:{row.id}", lead_id=lead.id, scanned_at="x"))
    db.commit()

    res = er.recover_message(db, row)
    db.commit()

    assert res == {"ok": True, "updated": True, "added": 0}
    assert row.body == LIZA_SAID
    assert row.email_checked_at
    db.expire_all()
    assert db.query(Lead).get(lead.id).customer_response_text == LIZA_SAID
    # The scanner read our text before; it must read hers now.
    assert db.query(ObjectionScan).filter_by(source_key=f"text:{row.id}").count() == 0


def test_a_reply_hidden_in_an_outbound_thread_gets_its_own_row(db, monkeypatch):
    lead, row = _setup(db, monkeypatch, direction="outbound")
    er.recover_message(db, row)
    db.commit()
    assert row.body == OURS                     # our email stays ours
    added = db.query(Message).filter(Message.lead_id == lead.id, Message.id != row.id).all()
    assert [(m.direction, m.body, m.ghl_message_id) for m in added] == [("inbound", LIZA_SAID, "email:hers")]
    # Reading it again adds nothing twice.
    assert er.recover_message(db, row)["added"] == 0


def test_ghl_down_leaves_it_to_retry(db, monkeypatch):
    _, row = _setup(db, monkeypatch)
    monkeypatch.setattr(ghl, "get_email_message", lambda eid, loc=None: None)
    assert er.recover_message(db, row)["ok"] is False
    assert not row.email_checked_at
    assert row.body == OURS


def test_due_picks_old_unread_inbound_and_recent_threads(db, monkeypatch):
    _, row = _setup(db, monkeypatch)
    old = Message(id=str(uuid.uuid4()), lead_id=row.lead_id, direction="outbound", body=OURS,
                  message_type="TYPE_EMAIL", ghl_message_id="old" + uuid.uuid4().hex[:6],
                  created_at="2026-05-01T00:00:00Z")
    db.add(old)
    db.commit()
    ids = {m.id for m in er.due(db)}
    assert row.id in ids                         # inbound, never read: any age
    assert old.id not in ids                     # outbound and months old: no
    row.email_checked_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    assert row.id not in {m.id for m in er.due(db)}
