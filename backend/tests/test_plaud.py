"""Alan's Plaud recordings → dashboard → nightly brief (2026-10-31)."""
from datetime import datetime

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import plaud as pa
from database import Idea, get_db
from plaud_models import PlaudBrief, PlaudNote
from services import plaud_brief as pb

ALAN = {"sub": "alanbonner", "name": "Alan", "role": "admin"}


def _client():
    app = FastAPI()
    app.include_router(pa.router, prefix="/api")
    return TestClient(app)


def test_wrong_key_refused(db):
    pa.recordings(ALAN)
    assert _client().post("/api/plaud/in/nope", json={"transcript": "x"}).status_code == 404


def test_recording_comes_in_scrubbed_and_once(db):
    addr = pa.recordings(ALAN)["address"]
    key = addr.rsplit("/", 1)[-1]
    body = {"Title": "Call with Chris", "Transcript": "card 4111 1111 1111 1111, switch to Legacy",
            "Summary": "Scope change", "ID": "rec1", "start time ": "2026-10-31T20:00:00Z"}
    c = _client()
    assert c.post(f"/api/plaud/in/{key}", json=body).status_code == 200
    assert c.post(f"/api/plaud/in/{key}", json=body).status_code == 200
    again = {**body, "Summary": "Scope change, redone", "ID": ""}
    assert c.post(f"/api/plaud/in/{key}", json=again).status_code == 200
    notes = pa.recordings(ALAN)["notes"]
    assert notes[0]["summary"] == "Scope change, redone"
    assert len(notes) == 1 and "[number]" in notes[0]["transcript"] and "4111" not in notes[0]["transcript"]
    assert notes[0]["title"] == "Call with Chris" and notes[0]["at"].startswith("2026-10-31T20:00:00-05:00")


def test_nightly_brief_once_with_tasks(db, monkeypatch):
    s = get_db()
    s.add(PlaudNote(id="n1", plaud_id="p1", title="Walk", recorded_at="2026-10-31T23:00:00+00:00",
                    transcript="I need to call the HOA manager", summary=""))
    s.commit()
    s.close()
    monkeypatch.setattr(pb, "_ask", lambda notes: {"text": "Call the HOA manager", "brief": "Decided today: …",
                                                   "tasks": [{"title": "Call the HOA manager", "area": "hoa"}]})
    sent = []
    assert pb.run("2026-10-31", send=sent.append)["notes"] == 1
    assert pb.run("2026-10-31", send=sent.append) is None
    assert len(sent) == 1 and "Call the HOA manager" in sent[0]
    s = get_db()
    assert s.query(Idea).filter(Idea.source == "plaud").count() == 1
    assert s.query(PlaudBrief).count() == 1
    s.close()


def test_scrub_grouped_card_and_plaud_time():
    out = pb.scrub("card is 4111, 1111, 1111, 1111 exp 12 29 and 4111 1111 1111 1111")
    assert "1111" not in out
    assert pb.scrub("we did 15 pickets at $12") == "we did 15 pickets at $12"
    assert pb.plaud_time("2026-10-28T13:09:29Z").startswith("2026-10-28T13:09:29-05:00")
    assert pb.houston_day(pb.plaud_time("2026-10-29T23:12:18Z")) == "2026-10-29"


def test_houston_day():
    assert pb.houston_day("2026-11-01T02:00:00Z") == "2026-10-31"
