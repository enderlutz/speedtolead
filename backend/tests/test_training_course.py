"""The VA training course: seeded outline, VAs see only published modules and
never the answer key, quiz and checklist finish a module, and the AI draft is
read from a forced tool call (never a real Anthropic call in tests)."""
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from api import training_course as tc  # noqa: E402

ALAN = {"sub": "alanbonner", "name": "Alan", "role": "admin"}
VA = {"sub": "newva", "name": "Emily", "role": "va"}


def test_seeds_the_outline_once_as_drafts_hidden_from_vas(db):
    out = tc.list_course(ALAN)
    assert len(out["modules"]) == len(tc.SEED) and out["modules"][0]["title"] == "Your day as a Sterling VA"
    assert all(m["status"] == "draft" for m in out["modules"]) and out["modules"][0]["record_note"]
    assert tc.list_course(VA)["modules"] == []
    # Deleting everything doesn't bring the outline back.
    for m in out["modules"]:
        tc.update_module(m["id"], tc.ModuleBody(status="archived"), ALAN)
    assert tc.list_course(ALAN)["modules"] == []


def _published(db):
    m = tc.create_module(tc.ModuleBody(
        title="Measuring the fence", status="published",
        videos=[{"label": "Computer", "url": "https://www.loom.com/share/abc123"}],
        steps="Open the lead\nSay: Hi, this is Emily with Sterling", checklist=["Measured 2 fences", "Checked sides"],
        quiz=[{"q": "First thing?", "options": ["Call", "Open the lead", "Send"], "answer": 1},
              {"q": "Send before calling?", "options": ["Yes", "Never"], "answer": 1}]), ALAN)
    return m["id"]


def test_va_never_sees_the_answers_or_the_admin_notes(db):
    mid = _published(db)
    m = tc.get_module(mid, VA)
    assert m["quiz"] == [{"q": "First thing?", "options": ["Call", "Open the lead", "Send"]},
                         {"q": "Send before calling?", "options": ["Yes", "Never"]}]
    assert "record_note" not in m and "transcript" not in m
    assert "measured 2 fences" in tc.list_course(VA)["modules"][0]["search_text"]


def test_watch_tick_and_pass_finishes_the_module(db):
    mid = _published(db)
    r = tc.save_progress(mid, tc.ProgressBody(answers=[1, 0]), VA)
    assert r["quiz_result"] == {"score": 50, "wrong": [1]} and not r["progress"]["passed"]
    tc.save_progress(mid, tc.ProgressBody(answers=[1, 1]), VA)
    r = tc.save_progress(mid, tc.ProgressBody(checked=[0, 1, 7]), VA)
    assert r["progress"]["checked"] == [0, 1] and not r["progress"]["done"]  # video not watched yet
    r = tc.save_progress(mid, tc.ProgressBody(watched=True), VA)
    assert r["progress"]["done"]
    team = tc.team_progress(ALAN)
    assert team["total"] == 1 and team["people"][0]["user"] == "Emily" and team["people"][0]["done"] == 1


def test_bad_video_link_and_draft_modules_are_refused(db):
    with pytest.raises(HTTPException):
        tc.create_module(tc.ModuleBody(videos=[{"url": "javascript:alert(1)"}]), ALAN)
    m = tc.create_module(tc.ModuleBody(title="Not ready"), ALAN)
    with pytest.raises(HTTPException):
        tc.get_module(m["id"], VA)
    with pytest.raises(HTTPException):
        tc.save_progress(m["id"], tc.ProgressBody(watched=True), VA)


def test_draft_reads_the_tool_call(db, monkeypatch):
    m = tc.create_module(tc.ModuleBody(title="Measuring"), ALAN)
    with pytest.raises(HTTPException):  # no transcript yet
        tc.draft_module(m["id"], tc.DraftBody(), ALAN)

    seen = {}

    class FakeMessages:
        def create(self, **kw):
            seen.update(kw)
            return SimpleNamespace(stop_reason="tool_use", content=[SimpleNamespace(type="tool_use", input={
                "summary": "Measure right or the price is wrong.", "steps": ["Open the map", " ", "Say: Is it the back and sides?"],
                "mistakes": ["Counting the gate twice"], "checklist": ["Measured a fence"],
                "quiz": [{"q": "Gate?", "options": ["Once", "Twice"], "answer": 0}, {"q": "bad", "options": ["one"], "answer": 0}]})])

    monkeypatch.setattr(tc, "get_settings", lambda: SimpleNamespace(anthropic_api_key="k"))
    monkeypatch.setattr(tc.anthropic, "Anthropic", lambda api_key: SimpleNamespace(messages=FakeMessages()))
    out = tc.draft_module(m["id"], tc.DraftBody(transcript="so first I open the map " * 20), ALAN)
    assert out["steps"] == "Open the map\nSay: Is it the back and sides?"
    assert out["quiz"] == [{"q": "Gate?", "options": ["Once", "Twice"], "answer": 0}]
    assert seen["tool_choice"] == {"type": "tool", "name": "write_module"} and "Measuring" in seen["messages"][0]["content"]
    # Nothing saved until Alan saves.
    assert tc.get_module(m["id"], ALAN)["steps"] == ""
