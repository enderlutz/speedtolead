"""A space or line break pasted into Railway's Twilio settings must not break
the crew line (2026-11-13: test text failed with no reason)."""
from types import SimpleNamespace

from services import twilio_line as tw


def test_settings_are_cleaned(monkeypatch):
    fake = SimpleNamespace(twilio_account_sid=" AC123\n", twilio_auth_token="tok \n",
                           twilio_crew_number="(346) 220-2533\n")
    monkeypatch.setattr(tw, "get_settings", lambda: fake)
    assert tw._auth() == ("AC123", "tok")
    assert tw._sid() == "AC123"
    assert tw._from() == "+13462202533"


def test_send_uses_clean_values(monkeypatch):
    fake = SimpleNamespace(twilio_account_sid="AC123 ", twilio_auth_token=" tok", twilio_crew_number="+13462202533 ")
    monkeypatch.setattr(tw, "get_settings", lambda: fake)
    seen = {}

    class R:
        def raise_for_status(self):
            pass

        def json(self):
            return {"sid": "SM1"}

    def post(url, data, auth, timeout):
        seen.update(url=url, data=data, auth=auth)
        return R()

    monkeypatch.setattr(tw.httpx, "post", post)
    assert tw.send_sms("+18325550100", "hi")["sid"] == "SM1"
    assert seen["url"].endswith("/Accounts/AC123/Messages.json")
    assert seen["data"]["From"] == "+13462202533" and seen["auth"] == ("AC123", "tok")


def test_send_builds_a_real_request(monkeypatch):
    """The real httpx must be able to encode what we send (the TypeError bug)."""
    import httpx
    fake = SimpleNamespace(twilio_account_sid="AC1", twilio_auth_token="t", twilio_crew_number="+13462202533")
    monkeypatch.setattr(tw, "get_settings", lambda: fake)
    sent = {}

    def handler(request):
        sent["body"] = request.content.decode()
        return httpx.Response(201, json={"sid": "SM9"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(tw.httpx, "post", client.post)
    assert tw.send_sms("+18325550100", "hi there", media=["https://x/a.jpg", "https://x/b.jpg"])["sid"] == "SM9"
    assert "Body=hi+there" in sent["body"] and sent["body"].count("MediaUrl=") == 2
