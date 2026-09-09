"""Walking a GHL conversation past its first page.

The 20-message fetch was fine for spotting a new call, but a real text thread
runs longer than that and the front of it is where the customer said what
they wanted. Pages chain on `lastMessageId`; `nextPage` says when to stop.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from services import ghl  # noqa: E402


class _Resp:
    def __init__(self, payload, fail=False):
        self._payload = payload
        self._fail = fail

    def raise_for_status(self):
        if self._fail:
            raise RuntimeError("HTTP 500")

    def json(self):
        return self._payload


class _Client:
    def __init__(self, pages):
        self.pages = list(pages)
        self.calls: list[dict] = []

    def get(self, url, headers=None, params=None, timeout=None):
        self.calls.append(dict(params or {}))
        page = self.pages.pop(0)
        if page == "boom":
            return _Resp({}, fail=True)
        return _Resp(page)


def _page(ids, *, more, last=None):
    return {"messages": {
        "messages": [{"id": i, "body": i} for i in ids],
        "nextPage": more,
        **({"lastMessageId": last} if last else {}),
    }}


@pytest.fixture
def client(monkeypatch):
    def _install(pages):
        c = _Client(pages)
        monkeypatch.setattr(ghl, "_client", c)
        return c
    return _install


def test_pages_are_chained_on_the_last_message_id(client):
    c = client([_page(["m1", "m2"], more=True, last="m2"), _page(["m3"], more=False)])
    got = ghl.get_conversation_messages_all("convo-1")
    assert [m["id"] for m in got] == ["m1", "m2", "m3"]
    assert c.calls[1]["lastMessageId"] == "m2"
    assert "lastMessageId" not in c.calls[0]


def test_it_stops_when_there_is_no_next_page(client):
    c = client([_page(["m1"], more=False)])
    assert len(ghl.get_conversation_messages_all("convo-1")) == 1
    assert len(c.calls) == 1


def test_the_page_cap_holds(client):
    """One runaway thread must not spend the whole rate budget."""
    c = client([_page([f"m{i}"], more=True, last=f"m{i}") for i in range(20)])
    got = ghl.get_conversation_messages_all("convo-1", max_pages=3)
    assert len(got) == 3
    assert len(c.calls) == 3


def test_a_failed_page_returns_what_was_fetched(client):
    client([_page(["m1", "m2"], more=True, last="m2"), "boom"])
    assert [m["id"] for m in ghl.get_conversation_messages_all("convo-1")] == ["m1", "m2"]


def test_a_missing_cursor_falls_back_to_the_last_id_on_the_page(client):
    c = client([_page(["m1", "m2"], more=True), _page(["m3"], more=False)])
    ghl.get_conversation_messages_all("convo-1")
    assert c.calls[1]["lastMessageId"] == "m2"
