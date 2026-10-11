"""Test fixtures.

The app resolves its database from DATABASE_URL at import time, so that is set
to SQLite before anything from the app is imported. Keeps the suite hermetic
and stops a stray test from ever reaching production.

A file-backed temp database rather than ":memory:" — init_db() and the
migration backfills open their own sessions, and an in-memory SQLite database
is per-connection.
"""
import os
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

_DB_FILE = Path(tempfile.mkdtemp(prefix="attest-")) / "test.db"
os.environ["DATABASE_URL"] = f"sqlite:///{_DB_FILE}"
os.environ.setdefault("AUTH_SECRET", "test-secret")

import pytest  # noqa: E402


@pytest.fixture
def db():
    """A session against a schema rebuilt fresh for each test."""
    import database

    if database._engine is None:
        database.init_db()

    database.Base.metadata.drop_all(bind=database._engine)
    database.Base.metadata.create_all(bind=database._engine)

    session = database._SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture(autouse=True)
def _no_real_ghl(monkeypatch):
    """No test may text, tag or note a real contact.

    The settings read the real backend/.env, keys and Alan's contact id
    included, so a new code path that reaches GHL sends for real. It did
    once (2026-10-10, the after-payment hooks). Tests that care about these
    calls monkeypatch the same names themselves; theirs win."""
    import services.ghl as ghl

    monkeypatch.setattr(ghl, "_send_message", lambda *a, **k: True)
    monkeypatch.setattr(ghl, "add_contact_tag", lambda *a, **k: True)
    monkeypatch.setattr(ghl, "add_contact_note", lambda *a, **k: "note-stub")
