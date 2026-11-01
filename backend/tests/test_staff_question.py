"""Alan's yes/no question to one person (2026-11-01)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from api import staff_question as sq  # noqa: E402


def test_seen_and_answered_each_text_alan_once(db, monkeypatch):
    from database import User
    monkeypatch.setattr(sq, "get_db", lambda: db)
    sent = []
    monkeypatch.setattr(sq, "_alert", sent.append)
    db.add(User(id="v1", username="va1", display_name="Pat", password_hash="x", role="va", permissions="{}", created_at=""))
    db.commit()
    admin = {"sub": "alanbonner", "role": "admin"}

    assert sq.mine({"sub": "va1"}) == {"question": None}
    q = sq.ask(sq.AskBody(username="va1", question="Are you going to call the leads today?"), admin)

    # Viewing as them never sets it off.
    assert sq.mine({"sub": "va1", "impersonated_by": admin}) == {"question": None}
    assert sent == []

    got = sq.mine({"sub": "va1"})["question"]
    assert got == {"id": q["id"], "question": "Are you going to call the leads today?"}
    sq.mine({"sub": "va1"})
    assert len(sent) == 1 and "Pat just opened the dashboard" in sent[0]

    with pytest.raises(HTTPException):
        sq.answer(sq.AnswerBody(id=q["id"], answer="maybe"), {"sub": "va1"})
    sq.answer(sq.AnswerBody(id=q["id"], answer="yes", note="Starting at 10"), {"sub": "va1"})
    assert len(sent) == 2 and "Pat answered: YES" in sent[1] and "Starting at 10" in sent[1]

    # Answered: the card is gone, a second answer texts nobody.
    assert sq.mine({"sub": "va1"}) == {"question": None}
    sq.answer(sq.AnswerBody(id=q["id"], answer="no"), {"sub": "va1"})
    assert len(sent) == 2
    assert sq.status("va1", admin)["question"]["answer"] == "yes"
