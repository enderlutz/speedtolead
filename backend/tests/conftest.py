"""Test fixtures.

The app resolves its database from DATABASE_URL at import time, so that is set
to an in-memory SQLite before anything from the app is imported. Keeps the
suite hermetic and stops a stray test from ever reaching production.
"""
import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

# Must be set before importing database/config.
os.environ["DATABASE_URL"] = "sqlite://"
os.environ.setdefault("AUTH_SECRET", "test-secret")

import pytest  # noqa: E402


@pytest.fixture
def db():
    """A fresh in-memory database per test."""
    from database import Base, engine, SessionLocal
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)
