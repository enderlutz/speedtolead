"""Alan's ideas playbook (2026-10-30)."""
import pytest
from fastapi import HTTPException

from api import ideas as ia

ALAN = {"sub": "alanbonner", "name": "Alan", "role": "admin"}


def test_only_alan():
    with pytest.raises(HTTPException):
        ia.require_alan({"sub": "olga", "role": "va"})
    with pytest.raises(HTTPException):
        ia.require_alan({"sub": "alanbonner", "impersonated_by": {"sub": "fragne"}})
    assert ia.require_alan(ALAN) == ALAN


def test_add_log_move_and_list(db):
    i = ia.add_idea(ia.IdeaBody(title="Call 5 HOA managers", area="hoa", timeframe="week"), ALAN)
    assert i["stage"] == "idea" and i["timeframe"] == "week"
    out = ia.add_log(i["id"], ia.LogBody(body="Called 2, one wants a quote"), ALAN)
    assert out["stage"] == "working" and out["logs"][0]["body"] == "Called 2, one wants a quote"
    out = ia.edit_idea(i["id"], ia.IdeaBody(stage="done"), ALAN)
    assert out["stage"] == "done" and any(l["stage"] == "done" for l in out["logs"])
    listed = ia.list_ideas(ALAN)
    assert len(listed["ideas"]) == 1 and len(listed["areas"]) == 11
    with pytest.raises(HTTPException):
        ia.edit_idea(i["id"], ia.IdeaBody(area="nope"), ALAN)
    ia.delete_idea(i["id"], ALAN)
    assert ia.list_ideas(ALAN)["ideas"] == []
