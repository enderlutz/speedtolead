"""Alan, 2026-10-15: deleted Eduardo's account in Settings and it came back
ten minutes later, because a start-up seed re-creates it on every deploy."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from database import User  # noqa: E402
from api import auth, permissions as perms  # noqa: E402

ADMIN = {"sub": "alanbonner", "name": "Alan", "role": "admin"}


def test_a_deleted_seeded_account_is_not_recreated_on_restart(db, monkeypatch):
    monkeypatch.setattr(perms, "get_db", lambda: db)
    monkeypatch.setattr(auth, "get_db", lambda: db)
    db.close = lambda: None
    db.add(User(id="alan", username="alanbonner", display_name="Alan", password_hash="x", role="admin", created_at=""))
    db.commit()
    auth.seed_eduardo_user()
    u = db.query(User).filter(User.username == "EduardoElvir").first()
    assert u is not None
    perms.delete_user(u.id, user=ADMIN)
    assert db.query(User).filter(User.username == "EduardoElvir").first() is None
    auth.seed_eduardo_user()  # the next deploy
    assert db.query(User).filter(User.username == "EduardoElvir").first() is None
    # Making it again by hand brings it back for good.
    perms.create_user(perms.CreateUserBody(username="EduardoElvir", password="x1234567", role="worker"), user=ADMIN)
    assert not auth.was_deleted(db, "EduardoElvir")
