"""Listen button: the customer's name and address read out loud for the VAs
before they dial (2026-11-11). Every name and address here is made up."""

import json
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jose import jwt

from config import get_settings
from database import Lead
from services import say_it


def _lead(name="jane doe", address="", form=None, id="x"):
    return Lead(id=id, contact_name=name, address=address,
                form_data=json.dumps(form) if form is not None else None)


# ── House numbers ─────────────────────────────────────────────────────

@pytest.mark.parametrize("digits,spoken", [
    ("7", "seven"),
    ("42", "forty-two"),
    ("542", "five forty-two"),
    ("500", "five hundred"),
    ("4914", "forty-nine fourteen"),
    ("4900", "forty-nine hundred"),
    ("4905", "forty-nine oh five"),
    ("2000", "two thousand"),
    ("23010", "twenty-three oh ten"),
    ("23000", "twenty-three thousand"),
    ("12345", "twelve three forty-five"),
    ("123456", "one two three four five six"),
])
def test_house_numbers_the_american_way(digits, spoken):
    assert say_it.say_number(digits) == spoken


# ── Addresses ─────────────────────────────────────────────────────────

def test_all_caps_address_is_cleaned_and_expanded():
    assert say_it.speak_address("23010 OAK RIDGE LN, CYPRESS, TX 77429, USA") == \
        "twenty-three oh ten Oak Ridge Lane, Cypress"


def test_lowercase_address_with_direction_and_unit():
    assert say_it.speak_address("4914 n main st apt 3, houston, texas 77001") == \
        "forty-nine fourteen North Main Street, Houston"


@pytest.mark.parametrize("raw,spoken", [
    ("8 Elm Ct.", "eight Elm Court"),
    ("10 Pine Dr", "ten Pine Drive"),
    ("11 Cedar Rd", "eleven Cedar Road"),
    ("12 Maple Blvd", "twelve Maple Boulevard"),
    ("13 Birch Cir", "thirteen Birch Circle"),
    ("14 Willow Pkwy", "fourteen Willow Parkway"),
    ("15 Aspen Ave", "fifteen Aspen Avenue"),
    ("16 Fox Trl", "sixteen Fox Trail"),
    ("17 Hollow Cv", "seventeen Hollow Cove"),
    ("18 Quail Pl", "eighteen Quail Place"),
    ("19 Hwy 290 W", "nineteen Highway two ninety West"),
    ("542 St Andrews Dr", "five forty-two Saint Andrews Drive"),
])
def test_street_abbreviations(raw, spoken):
    assert say_it.speak_address(raw) == spoken


def test_no_commas_drops_state_zip_and_country():
    assert say_it.speak_address("23010 Oak Ridge Ln Cypress TX 77429-1234 United States") == \
        "twenty-three oh ten Oak Ridge Lane Cypress"
    assert say_it.speak_address("9 Bayou Rd #12, Spring, TX 77373, United States") == "nine Bayou Road, Spring"
    assert say_it.speak_address("") == ""


def test_unit_word_does_not_eat_real_words():
    assert say_it.speak_address("5 Lotus Ln Unit B") == "five Lotus Lane"


# ── Names ─────────────────────────────────────────────────────────────

def test_known_salutation_says_mister_or_missus():
    assert say_it.speak_name(_lead("jane doe", form={"salutation": "Mrs."})) == "Missus Doe"
    assert say_it.speak_name(_lead("JOHN Q PUBLIC", form={"salutation": "Mr."})) == "Mister Public"


def test_no_salutation_says_the_first_name_only():
    assert say_it.speak_name(_lead("JANE DOE")) == "Jane"
    assert say_it.speak_name(_lead("jane doe", form={"salutation": "none"})) == "Jane"
    assert say_it.speak_name(_lead("jane McDoe")) == "Jane"


def test_typed_label_counts():
    assert say_it.speak_name(_lead("Mrs. Doe")) == "Missus Doe"


# ── Whole sentence + overrides ────────────────────────────────────────

def test_parts_join_name_then_address():
    p = say_it.parts(_lead("jane doe", "4914 ELM ST, KATY, TX 77494", {"salutation": "Mrs."}))
    assert p["name"] == "Missus Doe"
    assert p["address"] == "forty-nine fourteen Elm Street, Katy"
    assert p["text"] == "Missus Doe. forty-nine fourteen Elm Street, Katy."
    assert '<break' in say_it.tts_text(p["name"], p["address"])


def test_say_it_like_overrides_replace_each_part():
    lead = _lead("zed quux", "1 Odd Ln", {"say_name": "zed KWOOKS"})
    p = say_it.parts(lead)
    assert p["name"] == "zed KWOOKS"
    assert p["address"] == "one Odd Lane"
    lead = _lead("zed quux", "1 Odd Ln", {"say_address": "one ODD lane"})
    assert say_it.parts(lead)["address"] == "one ODD lane"
    assert say_it.parts(lead)["name"] == "Zed"


def test_cache_is_lru():
    say_it.cache_clear()
    old = say_it.CACHE_MAX
    say_it.CACHE_MAX = 2
    try:
        say_it.cache_put("a", b"1"); say_it.cache_put("b", b"2")
        assert say_it.cache_get("a") == b"1"        # a is now newest
        say_it.cache_put("c", b"3")                 # evicts b
        assert say_it.cache_get("b") is None
        assert say_it.cache_get("a") == b"1" and say_it.cache_get("c") == b"3"
    finally:
        say_it.CACHE_MAX = old
        say_it.cache_clear()


# ── Endpoint ──────────────────────────────────────────────────────────

def _client():
    from api import say_it as api_say
    app = FastAPI()
    app.include_router(api_say.router, prefix="/api")
    return TestClient(app), api_say


def _bearer(role):
    tok = jwt.encode({"sub": f"test-{role}", "role": role}, get_settings().auth_secret, algorithm="HS256")
    return {"Authorization": "Bearer " + tok}


def _saved_lead(db):
    lead = Lead(id=str(uuid.uuid4()), contact_name="jane doe", address="23010 OAK RIDGE LN, CYPRESS, TX 77429",
                division="fence", status="new", form_data=json.dumps({"salutation": "Mrs."}))
    db.add(lead); db.commit()
    return lead.id


def test_every_route_is_staff_only(db):
    from api.auth import require_staff
    client, api_say = _client()
    for r in api_say.router.routes:
        assert any(d.call is require_staff for d in r.dependant.dependencies), r.path
    lid = _saved_lead(db)
    assert client.get(f"/api/leads/{lid}/say-text").status_code in (401, 403)
    assert client.get(f"/api/leads/{lid}/say-text", headers=_bearer("worker")).status_code == 403
    assert client.get(f"/api/leads/{lid}/say", headers=_bearer("worker")).status_code == 403
    assert client.put(f"/api/leads/{lid}/say", json={"say_name": "x"}, headers=_bearer("worker")).status_code == 403
    assert client.get(f"/api/leads/{lid}/say-text", headers=_bearer("va")).status_code == 200


def test_no_voice_is_a_503_so_the_page_falls_back(db, monkeypatch):
    client, api_say = _client()
    monkeypatch.setattr(api_say.elevenlabs_client, "is_configured", lambda: False)
    lid = _saved_lead(db)
    r = client.get(f"/api/leads/{lid}/say", headers=_bearer("va"))
    assert r.status_code == 503
    t = client.get(f"/api/leads/{lid}/say-text", headers=_bearer("va")).json()
    assert t["text"] == "Missus Doe. twenty-three oh ten Oak Ridge Lane, Cypress."
    assert t["tts"] is False


def test_audio_is_generated_once_then_cached(db, monkeypatch):
    say_it.cache_clear()
    client, api_say = _client()
    calls = []
    monkeypatch.setattr(api_say.elevenlabs_client, "is_configured", lambda: True)
    monkeypatch.setattr(api_say.elevenlabs_client, "tts_to_mp3",
                        lambda text, *a, **k: calls.append(text) or b"ID3fake")
    lid = _saved_lead(db)
    for _ in range(2):
        r = client.get(f"/api/leads/{lid}/say", headers=_bearer("admin"))
        assert r.status_code == 200 and r.content == b"ID3fake"
        assert r.headers["content-type"] == "audio/mpeg"
    assert len(calls) == 1
    say_it.cache_clear()


def test_empty_audio_from_the_voice_is_a_503(db, monkeypatch):
    say_it.cache_clear()
    client, api_say = _client()
    monkeypatch.setattr(api_say.elevenlabs_client, "is_configured", lambda: True)
    monkeypatch.setattr(api_say.elevenlabs_client, "tts_to_mp3", lambda *a, **k: b"")
    lid = _saved_lead(db)
    assert client.get(f"/api/leads/{lid}/say", headers=_bearer("admin")).status_code == 503


def test_save_and_clear_overrides(db):
    client, _ = _client()
    lid = _saved_lead(db)
    r = client.put(f"/api/leads/{lid}/say", json={"say_name": "  jayn   DOH ", "say_address": "twenty three oh ten oak ridge"},
                   headers=_bearer("va"))
    assert r.status_code == 200
    assert r.json()["text"] == "jayn DOH. twenty three oh ten oak ridge."
    db.expire_all()
    fd = json.loads(db.get(Lead, lid).form_data)
    assert fd["say_name"] == "jayn DOH" and fd["salutation"] == "Mrs."   # other keys kept
    r = client.put(f"/api/leads/{lid}/say", json={"say_name": ""}, headers=_bearer("va"))
    assert r.json()["name"] == "Missus Doe"
    assert r.json()["say_address"] == "twenty three oh ten oak ridge"   # untouched
    assert client.get("/api/leads/nope/say-text", headers=_bearer("va")).status_code == 404
