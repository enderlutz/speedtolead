"""Reading a text thread — and the two facts the model is never asked for.

`awaiting_reply` and the callback basis date are computed from the messages
here, not read out of Claude's answer. A wrong "they're waiting on you" sends
Alan to text someone who isn't; a callback date resolved against today rather
than the day it was written puts every historical "next Tuesday" on the wrong
Tuesday.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from services import call_intent, thread_intent  # noqa: E402


def m(i, direction, body, when, mtype="TYPE_SMS"):
    return {"id": f"m{i}", "direction": direction, "body": body,
            "created_at": when, "message_type": mtype}


def _install_fake_claude(monkeypatch, payload: str):
    class _S:
        anthropic_api_key = "sk-test"
    monkeypatch.setattr(call_intent, "get_settings", lambda: _S())

    class _Block:
        def __init__(self, text): self.text = text

    class _Resp:
        def __init__(self, text): self.content = [_Block(text)]

    captured = {}

    class _Messages:
        def create(self, **kw):
            captured.update(kw)
            return _Resp(payload)

    class _Fake:
        def __init__(self, *a, **k): self.messages = _Messages()

    import anthropic
    monkeypatch.setattr(anthropic, "Anthropic", _Fake)
    return captured


# ── What counts as chat ───────────────────────────────────────────────

@pytest.mark.parametrize("mtype,expected", [
    ("TYPE_SMS", True), ("SMS", True), ("TYPE_FACEBOOK", True),
    ("TYPE_WHATSAPP", True), ("", True), (None, True),
    ("TYPE_ACTIVITY_OPPORTUNITY", False), ("TYPE_CALL", False),
    ("TYPE_EMAIL", False), ("TYPE_SMS_REACTION", False),
    ("TYPE_INTERNAL_COMMENT", False), ("TYPE_SMS_REVIEW_REQUEST", False),
])
def test_only_person_to_person_messages_are_chat(mtype, expected):
    assert thread_intent.is_chat(mtype) is expected


def test_the_thread_is_chat_only_and_oldest_first():
    rows = thread_intent.chat_messages([
        m(3, "inbound", "yes", "2026-09-03T15:00:00Z"),
        m(9, "outbound", "Opportunity updated", "2026-09-04T15:00:00Z", "TYPE_ACTIVITY_OPPORTUNITY"),
        m(1, "outbound", "hi", "2026-09-01T15:00:00Z"),
    ])
    assert [r["id"] for r in rows] == ["m1", "m3"]


# ── Facts computed from the messages ──────────────────────────────────

def test_awaiting_reply_when_their_text_is_the_last_one():
    facts = thread_intent.thread_facts(thread_intent.chat_messages([
        m(1, "outbound", "Estimate attached", "2026-09-01T15:00:00Z"),
        m(2, "inbound", "Can you do Thursday?", "2026-09-02T15:00:00Z"),
    ]))
    assert facts["awaiting_reply"] is True
    assert facts["last_inbound_at"] == "2026-09-02T15:00:00Z"
    assert facts["through_message_id"] == "m2"


def test_not_awaiting_reply_once_we_answered():
    facts = thread_intent.thread_facts(thread_intent.chat_messages([
        m(1, "inbound", "Can you do Thursday?", "2026-09-02T15:00:00Z"),
        m(2, "outbound", "Thursday it is", "2026-09-02T16:00:00Z"),
    ]))
    assert facts["awaiting_reply"] is False
    assert facts["inbound_count"] == 1
    assert facts["message_count"] == 2


def test_an_activity_row_after_their_text_does_not_count_as_our_reply():
    """"Opportunity updated" is the system talking, not us answering."""
    facts = thread_intent.thread_facts(thread_intent.chat_messages([
        m(1, "inbound", "Can you do Thursday?", "2026-09-02T15:00:00Z"),
        m(2, "outbound", "Opportunity updated", "2026-09-02T16:00:00Z", "TYPE_ACTIVITY_OPPORTUNITY"),
    ]))
    assert facts["awaiting_reply"] is True


# ── Rendering ─────────────────────────────────────────────────────────

def test_the_thread_is_rendered_with_sides_and_houston_days():
    text = thread_intent.render_thread(thread_intent.chat_messages([
        m(1, "outbound", "Your  estimate\nis attached", "2026-09-02T01:00:00Z"),  # 8pm Sep 1 Houston
        m(2, "inbound", "Thanks", "2026-09-02T15:00:00Z"),
    ]))
    assert text.splitlines() == [
        "[2026-09-01] Sterling: Your estimate is attached",
        "[2026-09-02] Customer: Thanks",
    ]


def test_a_long_thread_keeps_its_tail():
    msgs = [m(i, "outbound", f"message number {i}",
              f"2026-01-01T{i // 60:02d}:{i % 60:02d}:00Z")
            for i in range(300)]
    text = thread_intent.render_thread(thread_intent.chat_messages(msgs), max_messages=50)
    assert "message number 299" in text
    assert "message number 0\n" not in text


# ── End to end, with the model faked ──────────────────────────────────

def test_a_full_read_round_trips_and_resolves_the_date_against_their_message(monkeypatch):
    _install_fake_claude(monkeypatch, """{
      "wanted": "Back fence, both sides", "blocker": "timing",
      "blocker_detail": "Travelling until the weekend.",
      "commitment": "I'll confirm when I'm back",
      "callback_phrase": "text me tomorrow", "temperature": "warm",
      "one_line": "Wants it done, back this weekend.", "quoted_price_mentioned": false
    }""")
    out = thread_intent.extract_thread_intent([
        m(1, "outbound", "Estimate attached", "2026-09-01T15:00:00Z"),
        m(2, "inbound", "text me tomorrow", "2026-09-02T15:00:00Z"),   # Wed Sep 2 Houston
    ])
    assert out["ok"] is True
    assert out["temperature"] == "warm"
    assert out["awaiting_reply"] is True
    # "tomorrow" from the day THEY wrote it, not from today.
    assert out["callback_at"] == "2026-09-03"


def test_a_thread_with_nothing_to_read_is_ok_and_needs_no_retry():
    out = thread_intent.extract_thread_intent([
        m(1, "outbound", "Opportunity updated", "2026-09-01T15:00:00Z", "TYPE_ACTIVITY_OPPORTUNITY"),
    ])
    assert out["ok"] is True
    assert out["temperature"] == "unknown"
    assert out["message_count"] == 0


def test_a_claude_failure_is_not_ok_so_the_thread_is_retried(monkeypatch):
    class _S:
        anthropic_api_key = "sk-test"
    monkeypatch.setattr(call_intent, "get_settings", lambda: _S())
    import anthropic
    def boom(*a, **k):
        raise RuntimeError("credit balance is too low")
    monkeypatch.setattr(anthropic, "Anthropic", boom)

    out = thread_intent.extract_thread_intent([m(1, "inbound", "hi", "2026-09-02T15:00:00Z")])
    assert out["ok"] is False
    assert "credit balance" in out["one_line"]
    # The facts still come through, so the caller can see the thread state.
    assert out["awaiting_reply"] is True


def test_the_model_sees_their_last_message_date(monkeypatch):
    captured = _install_fake_claude(monkeypatch, '{"temperature": "warm"}')
    thread_intent.extract_thread_intent([m(1, "inbound", "hello", "2026-09-02T15:00:00Z")])
    assert "CUSTOMER'S LAST MESSAGE" in captured["messages"][0]["content"]
    assert "Customer: hello" in captured["messages"][0]["content"]


def test_the_thread_reader_is_not_the_coach():
    prompt = thread_intent._THREAD_PROMPT.lower()
    assert "customer" in prompt
    for coaching_word in ("rubric", "score her", "coaching", "olga"):
        assert coaching_word not in prompt
