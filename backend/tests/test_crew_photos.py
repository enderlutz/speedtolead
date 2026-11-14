"""Photos on the crew line (2026-11-13)."""
import io
from types import SimpleNamespace

from PIL import Image

from services import crew_photos


def _jpeg(w, h):
    buf = io.BytesIO()
    Image.effect_noise((w, h), 80).convert("RGB").save(buf, "JPEG", quality=98)
    return buf.getvalue()


def test_shrink_fits_a_text():
    out = crew_photos.shrink(_jpeg(4000, 3000))
    img = Image.open(io.BytesIO(out))
    assert max(img.size) <= crew_photos.MAX_SIDE and img.format == "JPEG"
    assert len(out) <= crew_photos.MAX_BYTES


def test_only_our_photos_get_sent(monkeypatch):
    import services.supabase_storage as st
    monkeypatch.setattr(st, "get_settings", lambda: SimpleNamespace(supabase_url="https://x.supabase.co"))
    assert crew_photos.is_ours("https://x.supabase.co/storage/v1/object/public/crew-line/photos/w/a.jpg")
    assert not crew_photos.is_ours("https://evil.example/a.jpg")
    assert not crew_photos.is_ours("https://x.supabase.co/storage/v1/object/public/proposal-pages/lead1/a.jpg")


def test_copy_from_twilio_keeps_twilio_link_on_failure(monkeypatch):
    import httpx

    def boom(*a, **k):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(httpx, "get", boom)
    assert crew_photos.copy_from_twilio(["https://api.twilio.com/m/1"], "w") == ["https://api.twilio.com/m/1"]


def test_copy_from_twilio_stores_our_copy(monkeypatch):
    import httpx
    data = _jpeg(800, 600)
    monkeypatch.setattr(httpx, "get", lambda *a, **k: httpx.Response(200, content=data, headers={"content-type": "image/jpeg"}, request=httpx.Request("GET", "https://t")))
    monkeypatch.setattr(crew_photos, "store", lambda d, e: f"https://ours/{e}.jpg")
    assert crew_photos.copy_from_twilio(["https://api.twilio.com/m/1"], "jose") == ["https://ours/jose.jpg"]


def test_videos_are_kept_as_videos(monkeypatch):
    import httpx
    monkeypatch.setattr(httpx, "get", lambda *a, **k: httpx.Response(200, content=b"\x00\x00\x00 ftypmp42", headers={"content-type": "video/mp4"}, request=httpx.Request("GET", "https://t")))
    seen = {}
    monkeypatch.setattr(crew_photos, "store", lambda d, e, ext="jpg", ct="image/jpeg": seen.update(ext=ext, ct=ct) or f"https://ours/{e}.{ext}")
    assert crew_photos.copy_from_twilio(["https://api.twilio.com/m/2"], "jose") == ["https://ours/jose.mp4"]
    assert seen == {"ext": "mp4", "ct": "video/mp4"}


def test_our_links_are_not_copied_again(monkeypatch):
    import httpx
    monkeypatch.setattr(httpx, "get", lambda *a, **k: (_ for _ in ()).throw(AssertionError("fetched")))
    assert crew_photos.copy_from_twilio(["https://x.supabase.co/a.jpg"], "w") == ["https://x.supabase.co/a.jpg"]
