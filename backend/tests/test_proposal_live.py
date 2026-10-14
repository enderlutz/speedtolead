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


STAFF = {"sub": "alanbonner", "name": "Alan", "role": "admin"}


def test_one_proposal_two_options_each_frozen_with_its_own_drawing(db, quiet):
    from database import PayLink, Estimate
    lead = _lead(db)
    lead.has_fence_scope_export, lead.fence_scope_export_image, lead.fence_scope_export_mime = True, b"DRAWING-ONE", "image/png"
    est = _estimate(db, lead, {"essential": 836.28, "signature": 935.64, "legacy": 1142.64}, status="pending")
    est.inputs = json.dumps({"linear_feet": "138", "fence_sides": ["Inside Back", "Inside Left", "Outside Front"]})
    db.commit()
    one = pl.save_option(lead.id, pl.OptionBody(label="Your side only", note="Inside plus the front sides"), STAFF)
    assert one["tiers"]["signature"] == 935.64 and one["feet"] == 138 and one["has_scope"] and one["proposal_id"] is None

    # Option 2: the estimate and drawing change; option 1 keeps what it saved.
    est.tiers = json.dumps({"essential": 1259.0, "signature": 1457.0, "legacy": 1871.0})
    lead.fence_scope_export_image = b"DRAWING-TWO"
    db.commit()
    two = pl.save_option(lead.id, pl.OptionBody(label="Both sides"), STAFF)
    listed = pl.list_options(lead.id, STAFF)
    assert [d["label"] for d in listed["drafts"]] == ["Your side only", "Both sides"] and listed["drafts"][0]["tiers"]["signature"] == 935.64

    # The interactive send freezes both onto the proposal.
    p = _proposal(db, lead, est)
    assert pl.attach_draft_options(db, lead.id, p.id) == 2
    db.commit()
    with pytest.raises(HTTPException):
        pl.delete_option(one["id"], STAFF)

    st = pl.get_live(p.token, _Req())
    assert [o["label"] for o in st["options"]] == ["Your side only", "Both sides"]
    assert st["tiers"]["signature"] == 935.64  # option 1 stands in for the single price
    assert st["options"][1]["tiers"]["signature"] == 1457.0
    assert bytes(pl.get_live_scope(p.token, option=one["id"]).body) == b"DRAWING-ONE"
    assert bytes(pl.get_live_scope(p.token, option=two["id"]).body) == b"DRAWING-TWO"

    # Later estimate changes reach neither option.
    db.query(Estimate).filter(Estimate.id == est.id).update({"tiers": json.dumps({"essential": 1, "signature": 2, "legacy": 3})})
    db.commit()
    assert pl.get_live(p.token, _Req())["options"][0]["tiers"]["signature"] == 935.64

    # Her pick: option 2 Signature, financed at option 2's price.
    pl.finance(p.token, pl.DoorBody(tier="signature", option_id=two["id"]), _Req())
    link = db.query(PayLink).filter(PayLink.lead_id == lead.id, PayLink.kind == "full").one()
    assert link.amount_cents == 145700 and link.option_id == two["id"] and "Both sides" in link.description
    assert any(k == "alan" and "(Both sides)" in m for k, m in quiet)
    with pytest.raises(HTTPException):
        pl.reserve(p.token, pl.DoorBody(tier="signature", option_id="nope"), _Req())


def test_numbered_drawings_are_picked_per_option_and_sent_proposals_stay_frozen(db, quiet, monkeypatch):
    from api import fence_scope as fs
    from database import FenceScopeVersion
    monkeypatch.setattr(fs, "_announce", lambda *a: None)
    monkeypatch.setattr(fs, "build_mms_image", lambda b: (b + b"-mms", "image/jpeg"))
    lead = _lead(db)
    lead.has_fence_scope_export, lead.fence_scope_export_image = True, b"DRAWING-1"
    lead.has_fence_scope_ai, lead.fence_scope_ai_image, lead.fence_scope_use_ai = True, b"DRONE-1", True
    est = _estimate(db, lead, {"essential": 836.28, "signature": 935.64, "legacy": 1142.64})

    # An interactive proposal sent the old way: it reads the live drawing.
    old = _proposal(db, lead, est)
    # Drawing 1 is filed; drawing 2 starts from a new photo.
    r = fs.new_fence_scope_drawing(lead.id, fs.NewDrawingBody(new_photo=True), STAFF)
    assert r == {**r, "filed_drawing_no": 1, "editing_drawing_no": 2}
    db.expire_all()
    v1 = db.query(FenceScopeVersion).filter_by(lead_id=lead.id).one()
    assert bytes(v1.mms_image) == b"DRAWING-1-mms"
    from database import Lead
    lead = db.query(Lead).get(lead.id)
    assert not lead.has_fence_scope_export and not lead.has_fence_scope_ai and not lead.fence_scope_use_ai
    # The old proposal was frozen with the drawing it showed.
    assert bytes(pl.get_live_scope(old.token, option=pl.get_live(old.token, _Req())["options"][0]["id"]).body) == b"DRAWING-1"

    # Drawing 2 gets made; option 1 picks drawing 1, option 2 the current one.
    lead.has_fence_scope_export, lead.fence_scope_export_image = True, b"DRAWING-2"
    db.commit()
    o1 = pl.save_option(lead.id, pl.OptionBody(label="Your side only", drawing=v1.id), STAFF)
    est.tiers = json.dumps({"essential": 1259.0, "signature": 1457.0, "legacy": 1871.0})
    db.commit()
    o2 = pl.save_option(lead.id, pl.OptionBody(label="Both sides", drawing="current"), STAFF)
    p = _proposal(db, lead, est)
    assert pl.freeze_on_send(db, lead, est, p.id, "current") == 2
    db.commit()
    assert bytes(pl.get_live_scope(p.token, option=o1["id"]).body) == b"DRAWING-1-mms"
    assert bytes(pl.get_live_scope(p.token, option=o2["id"]).body) == b"DRAWING-2"
    with pytest.raises(HTTPException):
        pl.save_option(lead.id, pl.OptionBody(drawing="not-a-drawing"), STAFF)


def test_a_plain_interactive_send_freezes_the_confirmed_drawing_and_price(db, quiet, monkeypatch):
    from api import fence_scope as fs
    lead = _lead(db)
    lead.has_fence_scope_export, lead.fence_scope_export_image = True, b"THE-DRAWING"
    est = _estimate(db, lead)
    p = _proposal(db, lead, est)
    assert pl.freeze_on_send(db, lead, est, p.id, "current") == 1
    db.commit()
    est.tiers = json.dumps({"essential": 1, "signature": 2, "legacy": 3})
    lead.fence_scope_export_image = b"CHANGED"
    db.commit()
    st = pl.get_live(p.token, _Req())
    assert st["tiers"]["signature"] == 1200.0 and len(st["options"]) == 1
    assert bytes(pl.get_live_scope(p.token, option=st["options"][0]["id"]).body) == b"THE-DRAWING"
    del fs


def test_a_new_photo_clears_the_old_drone_view(db, monkeypatch):
    import asyncio
    from api import fence_scope as fs
    from database import Lead
    monkeypatch.setattr(fs, "_announce", lambda *a: None)
    lead = _lead(db)
    lead.has_fence_scope_ai, lead.fence_scope_ai_image, lead.fence_scope_use_ai = True, b"DRONE-OF-PHOTO-1", True
    db.commit()

    class F:
        content_type = "image/png"
        async def read(self):
            return b"PHOTO-2"
    asyncio.run(fs.upload_fence_scope_source(lead.id, F(), STAFF))
    db.expire_all()
    lead = db.query(Lead).get(lead.id)
    assert not lead.has_fence_scope_ai and not lead.fence_scope_use_ai and lead.fence_scope_ai_image is None
