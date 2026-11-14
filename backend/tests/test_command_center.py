"""The Dashboard command center (services/command_center.py): every section
comes back, and the main cases land where the owner will look."""
from datetime import datetime, timedelta, timezone

from database import Booking, CompanyCamJob, Lead, PayLink


def _iso(dt):
    return dt.isoformat()


def test_empty_database_every_section_loads(db):
    from services.command_center import build
    d = build(db, fresh=True)
    for key in ("scorecard", "actions", "today_jobs", "pipeline", "marketing", "week", "collections", "alerts"):
        assert not (isinstance(d[key], dict) and "error" in d[key]), (key, d[key])
    assert d["actions"] == []
    assert len(d["week"]["days"]) == 7
    assert d["marketing"]["spend"] is None   # Meta isn't connected in tests: no made-up number


def test_actions_and_alerts(db):
    from clock import add_days_iso, today_ct
    from services.command_center import build
    now = datetime.now(timezone.utc)
    today = today_ct().isoformat()
    # A new lead an hour old that nobody has called.
    db.add(Lead(id="new1", contact_name="Pat Newlead", address="1 Oak St", created_at=_iso(now - timedelta(hours=1))))
    # A day held in two days with no deposit.
    db.add(Lead(id="held1", contact_name="Hal Held", address="2 Elm St", created_at=_iso(now - timedelta(days=5))))
    db.add(Booking(token="b1", lead_id="held1", date=add_days_iso(today, 2), tier="signature",
                   total_cents=180000, status="held", created_at=_iso(now - timedelta(days=1))))
    # A balance link sent ten days ago and not paid.
    db.add(Lead(id="bal1", contact_name="Bea Balance", address="3 Ash St", created_at=_iso(now - timedelta(days=30))))
    db.add(PayLink(token="p1", lead_id="bal1", kind="balance", amount_cents=95000, status="open",
                   created_at=_iso(now - timedelta(days=10)), sent_at=_iso(now - timedelta(days=10))))
    db.add(CompanyCamJob(id="cj1", lead_id="bal1", completed_at=_iso(now - timedelta(days=11))))   # the job is done
    # Not owed (Alan, 2026-11-14): a financing / pay-in-full link, and a
    # balance on a job that hasn't happened yet.
    db.add(Lead(id="fin1", contact_name="Fran Finance", address="4 Fir St", created_at=_iso(now - timedelta(days=30))))
    db.add(PayLink(token="p2", lead_id="fin1", kind="full", amount_cents=150000, status="open",
                   created_at=_iso(now - timedelta(days=20)), sent_at=_iso(now - timedelta(days=20))))
    db.add(Lead(id="early1", contact_name="Ed Early", address="5 Elm St", created_at=_iso(now - timedelta(days=30))))
    db.add(PayLink(token="p3", lead_id="early1", kind="balance", amount_cents=80000, status="open",
                   created_at=_iso(now - timedelta(days=20)), sent_at=_iso(now - timedelta(days=20))))
    # A test lead never shows.
    db.add(Lead(id="t1", contact_name="Test Person", address="9 Test", is_test=True, created_at=_iso(now)))
    db.commit()

    d = build(db, fresh=True)
    kinds = {(a["kind"], a["lead_id"]): a for a in d["actions"]}
    assert kinds[("new_lead", "new1")]["priority"] == "red"      # over 15 minutes, nobody called
    assert kinds[("deposit", "held1")]["priority"] == "red"      # held within 3 days, unpaid
    assert kinds[("balance", "bal1")]["priority"] == "red"       # 10 days > 7: overdue
    assert not any(a["lead_id"] in ("t1", "fin1", "early1") for a in d["actions"])
    assert d["scorecard"]["owed"] == 950.0
    assert d["actions"][0]["priority"] == "red"

    c = d["collections"]
    assert c["overdue_total"] == 950.0
    assert [r["lead_id"] for r in c["deposits"]] == ["held1"]

    texts = " | ".join(a["text"] for a in d["alerts"])
    assert "1 new lead not called" in texts
    assert "$950 in balances overdue" in texts
    held_day = next(x for x in d["week"]["days"] if x["date"] == add_days_iso(today, 2))
    assert held_day["held_unpaid"] == ["Hal Held"]


def test_pressure_washing_price_from_the_calendar_event():
    from services.command_center import _pw_price
    assert _pw_price("A&T · House, windows & driveway · Elmo", "Thank you! Your price: $1,125. Card fee waived.") == 1125.0
    assert _pw_price("Jennie | Gutters $275 + rinse driveway", "tipped $204 on $796 in May") == 275.0
    assert _pw_price("Window job", "Total: $640 (windows $400 + screens $240)") == 640.0
    assert _pw_price("Kristen- Thomas window cleaning job", "") is None
