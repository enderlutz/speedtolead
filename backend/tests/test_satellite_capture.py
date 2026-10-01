"""Capturing the satellite view in-app, instead of in another browser tab.

The loop this replaces, per lead: open maps.google.com in a new tab, find the
house, measure with Google's tool, screenshot, save to disk, come back, pick
the file, upload — then upload the same image again for the fence scope.

Google serves map tiles cross-origin, so the browser cannot screenshot its
own map (the canvas taints and toDataURL throws). The capture is therefore
taken server-side from the Static Maps API at the centre and zoom the VA
framed. Google is stubbed here — the point is what we store and what we
refuse, not what Google draws.
"""
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import json  # noqa: E402
import pytest  # noqa: E402

import clock  # noqa: E402
from database import Lead  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + b"fake-satellite-bytes" * 8


class _Resp:
    def __init__(self, status=200, content=PNG, text=""):
        self.status_code = status
        self.content = content
        self.text = text
        self.headers = {"content-type": "image/png"}


@pytest.fixture
def api_client(db, monkeypatch):
    """TestClient with auth and the Maps key stubbed, Google faked."""
    from fastapi.testclient import TestClient
    import api.leads as leads_api
    from api.auth import get_current_user
    import main

    calls: list[str] = []
    # Held in the fixture's closure, not on the client object: `_Client.get`
    # closes over this name, so a test mutating it is actually seen.
    nxt: dict = {}

    class _Client:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url):
            calls.append(url)
            return _Resp(**nxt)

    import httpx
    monkeypatch.setattr(httpx, "Client", _Client)

    settings = leads_api.get_settings()
    monkeypatch.setattr(settings, "google_maps_api_key", "test-key", raising=False)

    main.app.dependency_overrides[get_current_user] = lambda: {
        "sub": "olga", "name": "Olga", "role": "va",
    }
    client = TestClient(main.app)
    client.google_calls = calls                                   # type: ignore[attr-defined]
    client.set_google = lambda **kw: nxt.update(kw)                # type: ignore[attr-defined]
    try:
        yield client
    finally:
        main.app.dependency_overrides.clear()


def _lead(db, **kw) -> Lead:
    lead = Lead(
        id=str(uuid.uuid4()),
        contact_name=kw.pop("name", "Patrick Murphy"),
        contact_phone="+15708998258",
        address="1 Test Lane",
        status="new",
        created_at=clock.now_iso(),
        updated_at=clock.now_iso(),
        **kw,
    )
    db.add(lead)
    db.commit()
    return lead


def _capture(client, lead_id, **body):
    payload = {"lat": 29.9847, "lng": -95.6319, "zoom": 20}
    payload.update(body)
    return client.post(f"/api/leads/{lead_id}/measurement/capture", json=payload)


def test_one_press_fills_the_measurement_and_the_scope_source(db, api_client):
    """The whole point: the VA is left ready to draw the scope, with no file
    ever touching their disk."""
    lead = _lead(db)

    r = _capture(api_client, lead.id)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["measurement_uploaded"] is True
    assert body["scope_source_set"] is True

    db.expire_all()
    row = db.query(Lead).filter(Lead.id == lead.id).one()
    assert row.measurement_image_data == PNG
    assert row.has_measurement_image is True
    assert row.measurement_mime == "image/png"
    # The same bytes land in the fence-scope slot, which is the step that
    # used to need a second manual upload.
    assert row.fence_scope_source_image == PNG
    assert row.has_fence_scope_source is True


def test_the_measured_footage_lands_in_the_estimator_input(db, api_client):
    """Traced footage goes straight into linear_feet so nobody retypes it."""
    lead = _lead(db)

    r = _capture(api_client, lead.id, linear_feet=412.6)
    assert r.json()["linear_feet"] == 413   # rounded to the foot

    db.expire_all()
    fd = json.loads(db.query(Lead).filter(Lead.id == lead.id).one().form_data or "{}")
    assert fd["linear_feet"] == "413"
    # Recorded so a later audit can tell a satellite trace from a typed guess.
    assert fd["linear_feet_source"] == "satellite_measure"


def test_capturing_without_measuring_does_not_blank_existing_footage(db, api_client):
    """A VA may capture the image first and measure after. That must not wipe
    a linear_feet already on the lead."""
    lead = _lead(db, form_data=json.dumps({"linear_feet": "250"}))

    r = _capture(api_client, lead.id)
    assert r.json()["linear_feet"] is None

    db.expire_all()
    fd = json.loads(db.query(Lead).filter(Lead.id == lead.id).one().form_data or "{}")
    assert fd["linear_feet"] == "250"


def test_the_capture_is_credited_to_the_person_who_pressed_it(db, api_client):
    lead = _lead(db)

    _capture(api_client, lead.id)

    db.expire_all()
    row = db.query(Lead).filter(Lead.id == lead.id).one()
    # "sub", not "username" — the latter is not a JWT claim, which is how
    # this column recorded an empty string on every upload for months.
    assert row.measurement_uploaded_by == "olga"
    assert row.fence_scope_updated_by == "olga"
    assert row.measurement_uploaded_at


def test_the_requested_view_is_what_gets_asked_of_google(db, api_client):
    """WYSIWYG: ground coverage is set by `size`, so the frontend passes the
    map div's real pixel width. If this drifts, the saved image shows a
    different area than the VA measured."""
    lead = _lead(db)

    _capture(api_client, lead.id, zoom=19, size="520x520")

    url = api_client.google_calls[-1]
    assert "center=29.9847,-95.6319" in url
    assert "zoom=19" in url
    assert "size=520x520" in url
    assert "maptype=satellite" in url
    assert "scale=2" in url


def test_zoom_is_clamped_to_what_static_maps_accepts(db, api_client):
    """A bad client value should fail here with a clear message rather than
    as an opaque 400 from Google."""
    lead = _lead(db)

    _capture(api_client, lead.id, zoom=99)
    assert "zoom=21" in api_client.google_calls[-1]

    _capture(api_client, lead.id, zoom=-5)
    assert "zoom=1" in api_client.google_calls[-1]


def test_a_nonsense_size_is_refused_before_calling_google(db, api_client):
    lead = _lead(db)
    before = len(api_client.google_calls)

    r = _capture(api_client, lead.id, size="640")
    assert r.status_code == 400
    assert "640x640" in r.json()["detail"]
    assert len(api_client.google_calls) == before, "must not spend a Maps call"


def test_google_refusing_leaves_the_lead_untouched(db, api_client):
    """A failed capture must not half-write. Google puts the real reason in
    the body on a 4xx, so it is surfaced — "capture failed" with no cause is
    unactionable for whoever has to fix the key."""
    lead = _lead(db)
    api_client.set_google(
        status=403, content=b"",
        text="The Maps Static API has not been used in project 123 before or it is disabled.",
    )

    r = _capture(api_client, lead.id)
    assert r.status_code == 502
    assert "Maps Static API" in r.json()["detail"]

    db.expire_all()
    row = db.query(Lead).filter(Lead.id == lead.id).one()
    assert row.measurement_image_data is None
    assert not row.has_measurement_image
    assert row.fence_scope_source_image is None


def test_an_empty_body_from_google_counts_as_a_failure(db, api_client):
    """A 200 with no bytes would otherwise be stored as a zero-byte image
    and look like a successful capture."""
    lead = _lead(db)
    api_client.set_google(status=200, content=b"")

    assert _capture(api_client, lead.id).status_code == 502

    db.expire_all()
    assert db.query(Lead).filter(Lead.id == lead.id).one().measurement_image_data is None


def test_no_key_configured_says_so_plainly(db, api_client, monkeypatch):
    import api.leads as leads_api
    settings = leads_api.get_settings()
    monkeypatch.setattr(settings, "google_maps_api_key", "", raising=False)
    monkeypatch.setattr(settings, "google_maps_browser_key", "", raising=False)
    lead = _lead(db)

    r = _capture(api_client, lead.id)
    assert r.status_code == 503
    assert "Google Maps API key" in r.json()["detail"]


def test_a_missing_lead_404s_and_spends_nothing_further(db, api_client):
    r = _capture(api_client, "no-such-lead")
    assert r.status_code == 404


def test_scope_source_can_be_left_alone(db, api_client):
    """Re-capturing a measurement shouldn't have to clobber a scope source
    the VA has already drawn against."""
    lead = _lead(db)

    r = _capture(api_client, lead.id, also_scope=False)
    assert r.json()["scope_source_set"] is False

    db.expire_all()
    row = db.query(Lead).filter(Lead.id == lead.id).one()
    assert row.measurement_image_data == PNG
    assert row.fence_scope_source_image is None
