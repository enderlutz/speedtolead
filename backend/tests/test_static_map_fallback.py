"""The capture must try every key we hold before giving up.

Background: the capture read only the server key, on the stated assumption
that the browser key is referer-restricted and therefore useless
server-side. The two keys can sit on different Cloud projects with different
billing, and the server key's project was unbilled — so Google refused every
capture while the interactive map carried on working from the browser key.
Zero captures had ever succeeded.

What these pin:
  * the server key is still preferred
  * a refusal falls through to the browser key instead of failing
  * a success on either key returns the bytes
  * when both are refused the error names BOTH attempts, so the fix is aimed
    at the right project
  * a 200 that isn't an image counts as a refusal, not a captured photo
  * the same key is never tried twice when both env vars hold it
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

import api.leads as leads  # noqa: E402


class _Resp:
    def __init__(self, status=200, content=b"PNGBYTES", ctype="image/png", text=""):
        self.status_code = status
        self.content = content
        self.headers = {"content-type": ctype}
        self.text = text


def _client_returning(by_key: dict):
    """Stub httpx.Client so each key gets its own scripted response."""
    calls: list[str] = []

    class _C:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url):
            key = url.split("key=")[-1]
            calls.append(key)
            r = by_key.get(key)
            if r is None:
                raise RuntimeError("network down")
            return r
    return _C, calls


def _run(monkeypatch, by_key, server="SERVERKEY", browser="BROWSERKEY"):
    import httpx
    C, calls = _client_returning(by_key)
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: C())
    out = leads._fetch_static_map(
        lambda k: f"https://maps.googleapis.com/maps/api/staticmap?key={k}",
        server, browser, "lead-1",
    )
    return out, calls


BILLING = _Resp(status=403, content=b"", ctype="text/html",
                text="You must enable Billing on the Google Cloud Project")


def test_server_key_is_tried_first_and_used_when_it_works(monkeypatch):
    out, calls = _run(monkeypatch, {
        "SERVERKEY": _Resp(content=b"FROMSERVER"),
        "BROWSERKEY": _Resp(content=b"FROMBROWSER"),
    })
    assert out == b"FROMSERVER"
    assert calls == ["SERVERKEY"]


def test_a_billing_refusal_falls_back_to_the_browser_key(monkeypatch):
    """The actual production failure. This is what unblocks the capture."""
    out, calls = _run(monkeypatch, {
        "SERVERKEY": BILLING,
        "BROWSERKEY": _Resp(content=b"FROMBROWSER"),
    })
    assert out == b"FROMBROWSER"
    assert calls == ["SERVERKEY", "BROWSERKEY"]


def test_both_refused_names_both_in_the_error(monkeypatch):
    """So the fix is aimed at the right project instead of guessed at."""
    import httpx
    C, _ = _client_returning({
        "SERVERKEY": BILLING,
        "BROWSERKEY": _Resp(status=403, content=b"", ctype="text/html",
                            text="API keys with referer restrictions cannot be used"),
    })
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: C())
    with pytest.raises(HTTPException) as exc:
        leads._fetch_static_map(lambda k: f"?key={k}", "SERVERKEY", "BROWSERKEY", "lead-1")
    assert exc.value.status_code == 502
    assert "server key" in exc.value.detail
    assert "browser key" in exc.value.detail
    assert "enable Billing" in exc.value.detail
    assert "referer restrictions" in exc.value.detail


def test_a_200_that_is_not_an_image_is_a_refusal(monkeypatch):
    """Google answers some refusals with 200 and an HTML page. Storing that
    would save a broken photo and call it a success."""
    out, calls = _run(monkeypatch, {
        "SERVERKEY": _Resp(status=200, content=b"<html>sorry</html>",
                           ctype="text/html", text="<html>sorry</html>"),
        "BROWSERKEY": _Resp(content=b"FROMBROWSER"),
    })
    assert out == b"FROMBROWSER"
    assert calls == ["SERVERKEY", "BROWSERKEY"]


def test_a_network_error_on_the_first_key_still_tries_the_second(monkeypatch):
    out, calls = _run(monkeypatch, {"BROWSERKEY": _Resp(content=b"FROMBROWSER")})
    assert out == b"FROMBROWSER"
    assert calls == ["SERVERKEY", "BROWSERKEY"]


def test_one_key_in_both_env_vars_is_only_tried_once(monkeypatch):
    """Otherwise every failure doubles the requests and the error repeats
    itself for no reason."""
    import httpx
    C, calls = _client_returning({"SAMEKEY": BILLING})
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: C())
    with pytest.raises(HTTPException):
        leads._fetch_static_map(lambda k: f"?key={k}", "SAMEKEY", "SAMEKEY", "lead-1")
    assert calls == ["SAMEKEY"]


def test_only_a_browser_key_configured_still_works(monkeypatch):
    out, calls = _run(monkeypatch, {"BROWSERKEY": _Resp(content=b"FROMBROWSER")},
                      server="")
    assert out == b"FROMBROWSER"
    assert calls == ["BROWSERKEY"]


def test_no_keys_at_all_is_a_clear_error(monkeypatch):
    with pytest.raises(HTTPException) as exc:
        leads._fetch_static_map(lambda k: f"?key={k}", "", "", "lead-1")
    assert "no key configured" in exc.value.detail
