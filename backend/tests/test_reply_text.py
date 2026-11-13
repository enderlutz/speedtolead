"""A bill's text written from what the customer just said (2026-11-13)."""
from types import SimpleNamespace as NS

from services import reply_text


def m(direction, body, at):
    return NS(direction=direction, body=body, created_at=at)


NOW = reply_text._ts("2026-11-13T16:00:00+00:00")


def test_unanswered_customer_text_counts():
    msgs = [m("outbound", "Bill link", "2026-11-03T22:41:00+00:00"),
            m("outbound", "We'll be by tomorrow", "2026-11-11T23:43:00+00:00"),
            m("inbound", "Ok", "2026-11-12T00:50:00+00:00"),
            m("inbound", "Please send an invoice so I can pay you", "2026-11-13T15:08:00+00:00")]
    got = reply_text.new_words(msgs, since="2026-11-03T22:41:44+00:00", now=NOW)
    assert [x.body for x in got] == ["Ok", "Please send an invoice so I can pay you"]


def test_answered_text_does_not_count():
    msgs = [m("inbound", "When can you come?", "2026-11-05T20:24:00+00:00"),
            m("outbound", "Let me check", "2026-11-06T17:31:00+00:00")]
    assert reply_text.new_words(msgs, now=NOW) == []


def test_old_text_does_not_count():
    msgs = [m("inbound", "Thanks", "2026-10-01T20:24:00+00:00")]
    assert reply_text.new_words(msgs, now=NOW) == []


def test_text_before_the_bill_does_not_count_for_a_reminder():
    msgs = [m("inbound", "Looks great", "2026-11-10T20:00:00+00:00")]
    assert reply_text.new_words(msgs, since="2026-11-11T00:00:00+00:00", now=NOW) == []


def test_no_texts_means_no_draft(monkeypatch):
    monkeypatch.setattr(reply_text, "thread", lambda db, lead: [])
    assert reply_text.draft(None, NS(id="x"), "https://x/pay/T", "$10", "bill", "Good morning") is None


def test_draft_without_the_link_falls_back(monkeypatch):
    monkeypatch.setattr(reply_text, "thread", lambda db, lead: [m("inbound", "send the bill", "2099-01-01T00:00:00+00:00")])
    monkeypatch.setattr(reply_text, "new_words", lambda msgs, since=None: msgs)
    monkeypatch.setattr(reply_text, "_ask", lambda s, u: "Good morning, here you go!")
    assert reply_text.draft(None, NS(id="x"), "https://x/pay/T", "$10", "bill", "Good morning") is None


def test_draft_keeps_link_and_their_words(monkeypatch):
    monkeypatch.setattr(reply_text, "thread", lambda db, lead: [m("inbound", "send the bill", "2099-01-01T00:00:00+00:00")])
    monkeypatch.setattr(reply_text, "new_words", lambda msgs, since=None: msgs)
    monkeypatch.setattr(reply_text, "_ask", lambda s, u: "Good morning, here it is: $10 https://x/pay/T")
    out = reply_text.draft(None, NS(id="x"), "https://x/pay/T", "$10", "bill", "Good morning")
    assert out == {"message": "Good morning, here it is: $10 https://x/pay/T", "their_words": ["send the bill"]}
