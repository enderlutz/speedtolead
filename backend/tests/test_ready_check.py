"""Rolling deploys (2026-11-21): Railway's healthcheck asks /ready, which says
no until the database is set up, so a new deploy only takes traffic once it
can serve it and the old one keeps serving meanwhile."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main  # noqa: E402


def test_ready_waits_for_the_database(monkeypatch):
    monkeypatch.setattr(main, "_db_ready", False)
    r = main.ready()
    assert r.status_code == 503
    monkeypatch.setattr(main, "_db_ready", True)
    assert main.ready() == {"status": "ready"}


def test_railway_checks_ready_and_drains():
    cfg = json.loads((Path(main.__file__).parent / "railway.json").read_text())["deploy"]
    assert cfg["healthcheckPath"] == "/ready"
    assert cfg["healthcheckTimeout"] >= 120 and cfg["drainingSeconds"] > 0
