"""The interactive proposal: served by token, two doors, a 30-day price,
7-day deposit links, and the office's switch and extension."""
import json
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from api import proposal_live as pl  # noqa: E402
from api import stripe_pay as sp  # noqa: E402
from services import after_pay_hooks as hooks  # noqa: E402


class _Req:
    """A customer's browser: a real user agent, no staff cookie."""
    def __init__(self, ua="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1"):
        self.headers = {"user-agent": ua}
        self.cookies = {}


def _iso(dt):
    return dt.isoformat()


def _lead(db, **kw):
    from database import Lead
    lead = Lead(id=str(uuid.uuid4()), contact_name=kw.pop("contact_name", "Pat Customer"), address="1 Main St",
                division="fence", status="sent", ghl_contact_id=f"c-{uuid.uuid4()}",
                form_data=json.dumps(kw.pop("form_data", {"linear_feet": 200, "fence_sides": ["Inside Front"]})), **kw)
    db.add(lead)
    db.commit()
    return lead


def _estimate(db, lead, tiers=None, status="sent"):
    from database import Estimate
    est = Estimate(id=str(uuid.uuid4()), lead_id=lead.id, status=status,
                   tiers=json.dumps(tiers or {"essential": 1000.0, "signature": 1200.0, "legacy": 1500.0}),
                   created_at=_iso(datetime.now(timezone.utc)), sent_at=_iso(datetime.now(timezone.utc)))
    db.add(est)
    db.commit()
    return est


def _proposal(db, lead, est, version="interactive", days_ago=0):
    from database import Proposal
    created = datetime.now(timezone.utc) - timedelta(days=days_ago)
    p = Proposal(id=str(uuid.uuid4()), token=f"tok-{uuid.uuid4().hex[:12]}", estimate_id=est.id, lead_id=lead.id,
                 status="sent", proposal_version=version, proposal_seq=4500, created_at=_iso(created))
    db.add(p)
    db.commit()
    return p


@pytest.fixture
def quiet(monkeypatch):
    """No texts to Alan, no notes, no GHL; just the calls, for inspection."""
    sent = []
    monkeypatch.setattr(hooks, "alert_alan", lambda msg: sent.append(("alan", msg)))
    monkeypatch.setattr(hooks, "_note", lambda lead, body: sent.append(("note", body)))
    monkeypatch.setattr(pl, "track_view", lambda db, p, lead, request, preview=False: True)
    return sent


def test_only_an_interactive_proposal_is_served(db, quiet):
    lead = _lead(db)
    est = _estimate(db, lead)
    pdf = _proposal(db, lead, est, version="pdf")
    with pytest.raises(HTTPException) as e:
        pl.get_live(pdf.token, _Req())
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        pl.get_live("nope", _Req())
    assert e.value.status_code == 404

    live = _proposal(db, lead, est)
    out = pl.get_live(live.token, _Req())
    assert out["name"] == "Pat Customer"
    assert out["number"] == f"SF-{datetime.now(timezone.utc).year}-04500"
    assert out["tiers"]["signature"] == 1200.0
    assert out["regular"]["signature"] == 1500.0
    assert out["price_days"] == 30
    assert out["expired"] is False
    assert out["reserved"] is None and out["open_link"] is None


def test_the_price_ends_after_30_days_and_the_office_can_extend_it(db, quiet):
    lead = _lead(db)
    est = _estimate(db, lead)
    p = _proposal(db, lead, est, days_ago=31)
    assert pl.expired(p) is True
    out = pl.get_live(p.token, _Req())
    assert out["expired"] is True
    # The come-back text, once.
    assert any(k == "alan" and "after the price ended" in m for k, m in quiet)

    state = pl.extend_price(lead.id, pl.ExtendBody(days=7), {"name": "Olga"})
    assert state["proposal"]["expired"] is False
    db.expire_all()
    p2 = db.query(type(p)).filter_by(id=p.id).first()
    assert pl.good_through(p2) > datetime.now(timezone.utc) + timedelta(days=6)


def test_reserve_makes_one_deposit_link_for_the_tier_and_texts_alan(db, quiet):
    from database import PayLink
    lead = _lead(db)
    est = _estimate(db, lead)
    p = _proposal(db, lead, est)
    out = pl.reserve(p.token, pl.DoorBody(tier="signature"), _Req())
    assert out["reserved"] is False and "/pay/" in out["url"]
    links = db.query(PayLink).filter(PayLink.lead_id == lead.id).all()
    assert len(links) == 1
    link = links[0]
    assert link.kind == "deposit" and link.amount_cents == 25000
    assert link.job_tier == "signature" and link.job_total_cents == 120000
    assert link.created_by == "customer"
    assert any(k == "alan" and "Signature Finish" in m and "$250 deposit" in m for k, m in quiet)

    # Tapping again reuses the link; switching the package updates it.
    again = pl.reserve(p.token, pl.DoorBody(tier="legacy"), _Req())
    assert again["url"] == out["url"]
    db.expire_all()
    assert db.query(PayLink).filter(PayLink.lead_id == lead.id).count() == 1
    assert db.query(PayLink).filter(PayLink.lead_id == lead.id).first().job_tier == "legacy"

    with pytest.raises(HTTPException) as e:
        pl.reserve(p.token, pl.DoorBody(tier="platinum"), _Req())
    assert e.value.status_code == 400


def test_finance_is_a_full_price_link_and_an_expired_price_charges_regular(db, quiet):
    from database import PayLink
    lead = _lead(db)
    est = _estimate(db, lead)
    p = _proposal(db, lead, est, days_ago=40)
    pl.finance(p.token, pl.DoorBody(tier="essential"), _Req())
    link = db.query(PayLink).filter(PayLink.lead_id == lead.id).first()
    assert link.kind == "full"
    assert link.amount_cents == 125000 and link.job_total_cents == 125000  # 1000 / 0.8


def test_a_paid_deposit_means_both_doors_go_to_the_after_page(db, quiet):
    from database import PayLink
    lead = _lead(db)
    est = _estimate(db, lead)
    p = _proposal(db, lead, est)
    paid = PayLink(token="paidpaidpaidpaidpaid", lead_id=lead.id, kind="deposit", amount_cents=25000, status="paid",
                   created_at=_iso(datetime.now(timezone.utc)), paid_at=_iso(datetime.now(timezone.utc)),
                   job_tier="signature", job_total_cents=120000, answers="{}")
    db.add(paid)
    db.commit()
    out = pl.get_live(p.token, _Req())
    assert out["reserved"]["tier"] == "signature" and "/after/" in out["reserved"]["after_url"]
    door = pl.reserve(p.token, pl.DoorBody(tier="legacy"), _Req())
    assert door["reserved"] is True and "/after/" in door["url"]
    assert db.query(PayLink).filter(PayLink.lead_id == lead.id).count() == 1


def test_a_deposit_link_dies_after_seven_days(db, quiet):
    from database import PayLink
    lead = _lead(db)
    old = PayLink(token="oldoldoldoldoldoldold", lead_id=lead.id, kind="deposit", amount_cents=25000, status="open",
                  created_at=_iso(datetime.now(timezone.utc) - timedelta(days=8)), answers="{}")
    fresh = PayLink(token="freshfreshfreshfresh", lead_id=lead.id, kind="deposit", amount_cents=25000, status="open",
                    created_at=_iso(datetime.now(timezone.utc) - timedelta(days=2)), answers="{}")
    db.add_all([old, fresh])
    db.commit()
    assert hooks.deposit_link_expired(old) is True
    assert hooks.deposit_link_expired(fresh) is False
    assert sp.link_dict(fresh)["expired"] is False and sp.link_dict(fresh)["expires_at"]

    rows = hooks.pending_deposit_rows(db)
    assert [r["token"] for r in rows] == ["freshfreshfreshfresh"]
    assert rows[0]["days_left"] in (4, 5) and rows[0]["source"] == "stripe"

    with pytest.raises(HTTPException) as e:
        sp._live_link(db, "oldoldoldoldoldoldold")
    assert e.value.status_code == 410
    db.expire_all()
    assert db.query(PayLink).filter(PayLink.token == "oldoldoldoldoldoldold").first().status == "void"


def test_the_admin_switch_flips_the_latest_proposal(db, quiet):
    lead = _lead(db)
    est = _estimate(db, lead)
    p = _proposal(db, lead, est, version="pdf")
    assert pl.lead_live(lead.id, {"name": "Olga"})["proposal"]["interactive"] is False
    state = pl.switch_interactive(lead.id, pl.SwitchBody(on=True), {"name": "Alan", "role": "admin"})
    assert state["proposal"]["interactive"] is True
    assert state["proposal"]["url"].endswith(f"/p/{p.token}")
    assert pl.get_live(p.token, _Req())["token"] == p.token
    pl.switch_interactive(lead.id, pl.SwitchBody(on=False), {"name": "Alan", "role": "admin"})
    with pytest.raises(HTTPException):
        pl.get_live(p.token, _Req())


def test_sharing_logs_every_time_and_texts_alan_once_in_12_hours(db, quiet):
    from database import AutomationLog
    lead = _lead(db, contact_name="Angel Ramos")
    p = _proposal(db, lead, _estimate(db, lead))
    assert pl.shared(p.token, pl.ShareBody(how="text"), _Req()) == {"ok": True}
    assert pl.shared(p.token, pl.ShareBody(how="copy"), _Req()) == {"ok": True}
    assert pl.shared(p.token, pl.ShareBody(how="nonsense"), _Req()) == {"ok": True}
    alan = [m for k, m in quiet if k == "alan"]
    assert len(alan) == 1 and "Angel Ramos sent their proposal to someone by text" in alan[0]
    assert len([m for k, m in quiet if k == "note"]) == 1
    logged = db.query(AutomationLog).filter(AutomationLog.lead_id == lead.id, AutomationLog.event_type == "proposal_shared").all()
    assert len(logged) == 3 and any("share" in r.detail for r in logged)
    with pytest.raises(HTTPException):
        pl.shared("nope", pl.ShareBody(how="text"), _Req())
