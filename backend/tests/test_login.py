"""Logging in: the username as typed, or close enough for a phone keyboard."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import bcrypt  # noqa: E402
import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from api import auth  # noqa: E402
from database import User  # noqa: E402


def test_a_phone_keyboards_version_of_the_username_still_logs_in(db, monkeypatch):
    """Alan, 2026-10-21: Jose couldn't log in. His username is "Jose Arthur";
    "jose arthur", "JoseArthur" and "Jose Arthur " all reach the same account.
    The password is never forgiven, and the token carries the real username."""
    monkeypatch.setattr(auth, "get_db", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    import api.permissions as perms
    monkeypatch.setattr(perms, "perms_for_user", lambda d, u: ["my_schedule"])
    db.add(User(id="u-jose", username="Jose Arthur", display_name="Jose Arthur", role="worker",
                password_hash=bcrypt.hashpw(b"pintura1", bcrypt.gensalt(4)).decode(), spanish=True))
    db.add(User(id="u-josea", username="josea", display_name="Other", role="worker",
                password_hash=bcrypt.hashpw(b"zzz", bcrypt.gensalt(4)).decode()))
    db.commit()
    for typed in ("Jose Arthur", "jose arthur", "JoseArthur", " Jose Arthur ", "JOSE ARTHUR"):
        out = auth.login(auth.LoginRequest(username=typed, password="pintura1"))
        assert out["user"]["username"] == "Jose Arthur" and out["user"]["role"] == "worker"
    for typed, pw in (("Jose Arthur", "Pintura1"), ("Jose Arthur", ""), ("Jose", "pintura1"), ("josea", "pintura1")):
        with pytest.raises(HTTPException) as exc:
            auth.login(auth.LoginRequest(username=typed, password=pw))
        assert exc.value.status_code == 401
