"""Meta ads service: token in the header (never the URL), lead counting, paging."""
import httpx

from services import meta_ads


class _Resp:
    def __init__(self, body, status=200):
        self._b, self.status_code = body, status
        self.headers = {"content-type": "application/json"}

    def json(self):
        return self._b


def test_not_configured(monkeypatch):
    monkeypatch.delenv("META_ACCESS_TOKEN", raising=False)
    assert not meta_ads.is_configured()


def test_insights_pages_and_counts_leads(monkeypatch):
    monkeypatch.setenv("META_ACCESS_TOKEN", "SECRET")
    monkeypatch.setenv("META_AD_ACCOUNT_ID", "act_123")
    calls = []
    pages = [
        {"data": [{"campaign_id": "1", "campaign_name": "A", "spend": "100",
                   "actions": [{"action_type": "lead", "value": "4"},
                               {"action_type": "link_click", "value": "50"}]}],
         "paging": {"cursors": {"after": "X"}, "next": "https://…"}},
        {"data": [{"campaign_id": "2", "campaign_name": "B", "spend": "30"}], "paging": {}},
    ]

    def fake_get(url, params=None, headers=None, timeout=None):
        calls.append((url, params, headers))
        return _Resp(pages[len(calls) - 1])

    monkeypatch.setattr(httpx, "get", fake_get)
    rows = meta_ads.insights("campaign", "2026-10-01", "2026-10-17")
    assert [r["leads"] for r in rows] == [4, 0]
    assert rows[0]["cost_per_lead"] == 25.0 and rows[1]["cost_per_lead"] is None
    assert len(calls) == 2 and calls[1][1]["after"] == "X"
    assert "/act_123/insights" in calls[0][0]
    for url, params, headers in calls:
        assert "SECRET" not in url and "SECRET" not in str(params)
        assert headers["Authorization"] == "Bearer SECRET"


def test_error_message_surfaces(monkeypatch):
    monkeypatch.setenv("META_ACCESS_TOKEN", "SECRET")
    monkeypatch.setenv("META_AD_ACCOUNT_ID", "123")
    monkeypatch.setattr(httpx, "get", lambda *a, **k: _Resp({"error": {"message": "bad perms"}}, 400))
    try:
        meta_ads.account_info()
        assert False
    except meta_ads.MetaError as e:
        assert "bad perms" in str(e) and "SECRET" not in str(e)
