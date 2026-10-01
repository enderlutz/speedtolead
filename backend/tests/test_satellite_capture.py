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
    """A bad client value is clamped here rather than becoming an opaque 400
    from Google. 22, not 21: Google's satellite basemap only allows zooming
    as far as imagery exists, so the interactive map's ceiling is the real
    one and ours must not be the binding constraint."""
    lead = _lead(db)

    _capture(api_client, lead.id, zoom=99)
    assert "zoom=22" in api_client.google_calls[-1]

    _capture(api_client, lead.id, zoom=-5)
    assert "zoom=1" in api_client.google_calls[-1]


def test_a_clamped_zoom_is_reported_not_hidden(db, api_client):
    """Capturing below the framed zoom means a wider, coarser image than was
    measured. The response has to make that visible — detail is the only
    part of imagery quality we actually control, since Google exposes no
    imagery-date parameter at all."""
    lead = _lead(db)

    r = _capture(api_client, lead.id, zoom=30).json()
    assert (r["requested_zoom"], r["zoom"]) == (30, 22)

    ok = _capture(api_client, lead.id, zoom=20).json()
    assert (ok["requested_zoom"], ok["zoom"]) == (20, 20)


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


# --- several views per job -------------------------------------------------
#
# A job often needs more than one view: all the insides in one, the back run
# in another. Each is measured separately and the footage is the sum. The old
# single-image column replaced itself, which lost the earlier shot and meant
# re-measuring from scratch to check anything.

def test_each_capture_is_kept_and_numbered(db, api_client):
    from database import LeadMeasurement
    lead = _lead(db)

    first = _capture(api_client, lead.id, linear_feet=300).json()
    second = _capture(api_client, lead.id, linear_feet=120).json()

    assert (first["seq"], first["label"]) == (1, "Photo 1")
    assert (second["seq"], second["label"]) == (2, "Photo 2")

    db.expire_all()
    rows = (
        db.query(LeadMeasurement)
        .filter(LeadMeasurement.lead_id == lead.id)
        .order_by(LeadMeasurement.seq).all()
    )
    assert [r.seq for r in rows] == [1, 2]
    assert [r.linear_feet for r in rows] == [300.0, 120.0]
    # The earlier photo's bytes survive — that is the whole point.
    assert all(r.image_data == PNG for r in rows)


def test_linear_feet_is_the_sum_of_the_views(db, api_client):
    """Measure the insides, then the back run; the estimator input gets the
    total without anyone adding it up."""
    lead = _lead(db)

    assert _capture(api_client, lead.id, linear_feet=300).json()["total_linear_feet"] == 300
    r = _capture(api_client, lead.id, linear_feet=120.4)
    assert r.json()["linear_feet"] == 120      # this view
    assert r.json()["total_linear_feet"] == 420  # the job

    db.expire_all()
    fd = json.loads(db.query(Lead).filter(Lead.id == lead.id).one().form_data or "{}")
    assert fd["linear_feet"] == "420"


def test_re_shooting_a_view_replaces_it_rather_than_double_counting(db, api_client):
    """Re-framing a run already measured must correct it, not add to it."""
    from database import LeadMeasurement
    lead = _lead(db)
    first = _capture(api_client, lead.id, linear_feet=300).json()

    again = _capture(api_client, lead.id, linear_feet=340,
                     replace_id=first["measurement_id"])
    assert again.json()["seq"] == 1, "a re-shoot keeps the photo's number"
    assert again.json()["total_linear_feet"] == 340, "340, not 640"

    db.expire_all()
    assert db.query(LeadMeasurement).filter(
        LeadMeasurement.lead_id == lead.id).count() == 1


def test_replacing_a_photo_that_is_gone_is_refused(db, api_client):
    lead = _lead(db)
    r = _capture(api_client, lead.id, linear_feet=100, replace_id="not-a-real-id")
    assert r.status_code == 404


def test_the_list_comes_back_in_order_with_the_total(db, api_client):
    lead = _lead(db)
    _capture(api_client, lead.id, linear_feet=300)
    _capture(api_client, lead.id, linear_feet=120)

    body = api_client.get(f"/api/leads/{lead.id}/measurements").json()
    assert body["total_linear_feet"] == 420
    assert [m["label"] for m in body["measurements"]] == ["Photo 1", "Photo 2"]
    # Listing must not drag the image bytes along with it.
    assert all("image_data" not in m for m in body["measurements"])
    assert all(m["has_image"] for m in body["measurements"])


def test_each_photo_is_fetchable_on_its_own(db, api_client):
    lead = _lead(db)
    mid = _capture(api_client, lead.id, linear_feet=300).json()["measurement_id"]

    r = api_client.get(f"/api/leads/{lead.id}/measurements/{mid}/image")
    assert r.status_code == 200
    assert r.content == PNG
    assert r.headers["content-type"] == "image/png"


def test_deleting_a_photo_re_totals_the_lead(db, api_client):
    lead = _lead(db)
    _capture(api_client, lead.id, linear_feet=300)
    second = _capture(api_client, lead.id, linear_feet=120).json()

    r = api_client.delete(f"/api/leads/{lead.id}/measurements/{second['measurement_id']}")
    assert r.json()["total_linear_feet"] == 300

    db.expire_all()
    fd = json.loads(db.query(Lead).filter(Lead.id == lead.id).one().form_data or "{}")
    assert fd["linear_feet"] == "300"


def test_deleting_the_last_photo_clears_the_derived_footage(db, api_client):
    lead = _lead(db)
    only = _capture(api_client, lead.id, linear_feet=300).json()

    api_client.delete(f"/api/leads/{lead.id}/measurements/{only['measurement_id']}")

    db.expire_all()
    fd = json.loads(db.query(Lead).filter(Lead.id == lead.id).one().form_data or "{}")
    assert "linear_feet" not in fd, "a stale 300 would quietly price the job"


def test_deleting_a_photo_never_overwrites_a_hand_typed_figure(db, api_client):
    """If the VA typed Linear Feet themselves, it is their number. This flow
    only ever corrects a figure it put there itself."""
    lead = _lead(db, form_data=json.dumps({"linear_feet": "777"}))
    api_client.set_google()
    shot = _capture(api_client, lead.id).json()   # no footage traced

    api_client.delete(f"/api/leads/{lead.id}/measurements/{shot['measurement_id']}")

    db.expire_all()
    fd = json.loads(db.query(Lead).filter(Lead.id == lead.id).one().form_data or "{}")
    assert fd["linear_feet"] == "777"


def test_numbers_are_not_reshuffled_after_a_delete(db, api_client):
    """"Photo 3" has to keep meaning the same photo once Photo 2 is gone,
    otherwise a note referring to it silently points at something else."""
    lead = _lead(db)
    _capture(api_client, lead.id, linear_feet=100)
    second = _capture(api_client, lead.id, linear_feet=100).json()
    _capture(api_client, lead.id, linear_feet=100)

    api_client.delete(f"/api/leads/{lead.id}/measurements/{second['measurement_id']}")
    body = api_client.get(f"/api/leads/{lead.id}/measurements").json()
    assert [m["seq"] for m in body["measurements"]] == [1, 3]

    # And the next capture continues past the gap rather than reusing 2.
    assert _capture(api_client, lead.id, linear_feet=50).json()["seq"] == 4


def test_the_newest_capture_still_feeds_the_scope_and_the_old_card(db, api_client):
    """The legacy single-image columns mirror the most recent photo, so the
    Measurement card and the fence-scope source keep working untouched."""
    lead = _lead(db)
    _capture(api_client, lead.id, linear_feet=300)
    _capture(api_client, lead.id, linear_feet=120)

    db.expire_all()
    row = db.query(Lead).filter(Lead.id == lead.id).one()
    assert row.has_measurement_image is True
    assert "satellite-2" in row.measurement_filename
    assert row.fence_scope_source_image == PNG


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
