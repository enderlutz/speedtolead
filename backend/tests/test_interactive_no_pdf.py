"""An interactive proposal is only the interactive page (Alan, 2026-10-18):
no PDF made at send, the text still goes out, and the customer can't get a PDF."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from api import estimates as E  # noqa: E402
from api import proposals as P  # noqa: E402
from database import Estimate, Lead, Proposal  # noqa: E402


def _seed(db, version):
    db.add(Lead(id="L", contact_name="Test Person", address="1 Oak", contact_phone="+15555550100",
                ghl_contact_id="g1", status="new"))
    db.add(Estimate(id="E", lead_id="L", service_type="fence_staining", status="pending",
                    tiers='{"essential": 1000, "signature": 1200, "legacy": 1500}'))
    db.add(Proposal(id="P", token="tok12345abcd", estimate_id="E", lead_id="L", status="sent",
                    proposal_version=version, pdf_data=None, pdf_page_count=0, created_at="2026-10-18T12:00:00"))
    db.commit()


def test_interactive_send_makes_no_pdf_and_still_texts(db, monkeypatch):
    _seed(db, "interactive")
    monkeypatch.setattr(E, "get_db", lambda: db); monkeypatch.setattr(db, "close", lambda: None)
    made, texts = [], []
    monkeypatch.setattr(E, "get_cached_template", lambda: {"pdf_data": b"x", "field_map": "{}"})
    monkeypatch.setattr(E, "generate_filled_pdf", lambda *a, **k: made.append(1) or b"%PDF")
    monkeypatch.setattr(E, "send_sms", lambda cid, msg, loc=None: texts.append(msg) or True)
    E._approve_estimate_background(proposal_id="P", token="tok12345abcd", estimate_id="E", lead_id="L",
                                   body_field_overrides=None, body_extra_fields=None, send_sms_flag=True,
                                   also_email_flag=False, scheduled_send_at=None, apply_tag=False)
    assert made == []
    assert len(texts) == 1 and "/p/tok12345abcd" in texts[0]
    assert db.query(Proposal).filter_by(id="P").first().pdf_data is None


def test_the_customer_cant_get_a_pdf_of_an_interactive_proposal(db, monkeypatch):
    _seed(db, "interactive")
    monkeypatch.setattr(P, "get_db", lambda: db); monkeypatch.setattr(db, "close", lambda: None)
    with pytest.raises(HTTPException) as e:
        P.get_proposal_pdf("tok12345abcd")
    assert e.value.status_code == 404
    with pytest.raises(HTTPException):
        P.get_proposal_page("tok12345abcd", 0)


def test_an_old_pdf_proposal_still_serves_its_pdf(db, monkeypatch):
    _seed(db, "pdf")
    db.query(Proposal).filter_by(id="P").update({"pdf_data": b"%PDF-1.4 test"}); db.commit()
    monkeypatch.setattr(P, "get_db", lambda: db); monkeypatch.setattr(db, "close", lambda: None)
    assert P.get_proposal_pdf("tok12345abcd").body == b"%PDF-1.4 test"
