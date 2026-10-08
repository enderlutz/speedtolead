"""The objection scanner.

What these pin, from what Alan asked for on 2026-10-08:
  * every objection the customer gives is ticked, several per customer
  * before/after the estimate comes from the timestamps, never the model —
    including a call where the estimate went out mid-call, which GHL stamps
    at the moment the call STARTED
  * each text and call is read once, and a removed tag never comes back
  * the model can only tag what it was asked about
"""
import json
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from database import CallRecording, CallTranscript, Estimate, Lead, LeadObjection, Message  # noqa: E402
from services import objections as ob  # noqa: E402
from api import leads as leads_api  # noqa: E402

T0 = datetime(2026, 10, 8, 18, 0, tzinfo=timezone.utc)
USER = {"sub": "alanbonner", "name": "Alan"}


def _lead(db):
    lead = Lead(id=str(uuid.uuid4()), contact_name="Obj Customer", contact_phone="+17135550002",
                ghl_contact_id="ghl-ob", pipeline_version="v2", status="new", created_at=T0.isoformat())
    db.add(lead)
    db.commit()
    return lead


def _sent(db, lead, at):
    db.add(Estimate(id=str(uuid.uuid4()), lead_id=lead.id, status="sent", sent_at=at.isoformat(),
                    inputs="{}", breakdown="[]", tiers="{}", created_at=at.isoformat()))
    db.commit()


def _text(db, lead, at, body, direction="inbound"):
    m = Message(id=str(uuid.uuid4()), lead_id=lead.id, direction=direction, body=body,
                created_at=at.isoformat())
    db.add(m)
    db.commit()
    return m


def _call(db, lead, start, seconds, lines):
    rec = CallRecording(id=str(uuid.uuid4()), lead_id=lead.id, duration_seconds=seconds,
                        created_at=start.isoformat(), status="transcribed")
    db.add(rec)
    db.add(CallTranscript(id=str(uuid.uuid4()), recording_id=rec.id, lead_id=lead.id,
                          segments=json.dumps([{"speaker": 1, "text": t, "start": s, "end": s + 3}
                                               for s, t in lines]),
                          speaker_map='{"0": "Team", "1": "Customer"}', created_at=start.isoformat()))
    db.commit()
    return rec


def _fake(tags):
    seen = []

    def classify(conversation):
        seen.append(conversation)
        return tags
    classify.seen = seen
    return classify


def test_one_text_can_carry_two_objections(db):
    lead = _lead(db)
    _sent(db, lead, T0)
    m = _text(db, lead, T0 + timedelta(hours=2), "I have to talk to my wife and also it's not the time yet")
    r = ob.scan_lead(db, lead.id, classify=_fake([
        {"category": "spouse_family", "source": "text", "source_id": m.id, "line": None,
         "quote": "I have to talk to my wife", "confidence": "high"},
        {"category": "timing", "source": "text", "source_id": m.id, "line": None,
         "quote": "it's not the time yet", "confidence": "high"},
    ]))
    assert r["found"] == 2
    rows = db.query(LeadObjection).filter(LeadObjection.lead_id == lead.id).all()
    assert {x.category for x in rows} == {"spouse_family", "timing"}
    assert all(x.timing == "after_estimate" for x in rows)


def test_a_call_that_started_before_the_send_still_counts_as_after(db):
    """Alan's case: call starts 2:00, estimate goes out 2:03:30 while on the
    phone, customer objects 4m10s in. GHL stamps the call at 2:00."""
    lead = _lead(db)
    start = T0
    _sent(db, lead, start + timedelta(minutes=3, seconds=30))
    rec = _call(db, lead, start, 600, [(60, "It's not a good time right now"),
                                       (250, "Honestly that's more than I wanted to spend")])
    ob.scan_lead(db, lead.id, classify=_fake([
        {"category": "timing", "source": "call", "source_id": rec.id, "line": 0,
         "quote": "It's not a good time right now", "confidence": "high"},
        {"category": "price", "source": "call", "source_id": rec.id, "line": 1,
         "quote": "more than I wanted to spend", "confidence": "high"},
    ]))
    rows = {x.category: x for x in db.query(LeadObjection).filter(LeadObjection.lead_id == lead.id)}
    # Alan's rule: the estimate went out during this call, so everything
    # said on it counts as after — even the line before the send.
    assert rows["timing"].timing == "after_estimate"
    assert rows["price"].timing == "after_estimate"
    assert rows["price"].mid_call_send and rows["timing"].mid_call_send


def test_ring_time_grace_puts_an_objection_right_at_the_send_after_it(db):
    lead = _lead(db)
    _sent(db, lead, T0 + timedelta(minutes=3))
    rec = _call(db, lead, T0, 600, [(150, "That's too much")])   # 30s before the send
    ob.scan_lead(db, lead.id, classify=_fake([
        {"category": "price", "source": "call", "source_id": rec.id, "line": 0,
         "quote": "That's too much", "confidence": "high"}]))
    assert db.query(LeadObjection).filter(LeadObjection.lead_id == lead.id).one().timing == "after_estimate"


def test_with_no_estimate_sent_everything_is_before(db):
    lead = _lead(db)
    m = _text(db, lead, T0, "sounds expensive")
    ob.scan_lead(db, lead.id, classify=_fake([
        {"category": "price", "source": "text", "source_id": m.id, "line": None,
         "quote": "sounds expensive", "confidence": "low"}]))
    assert db.query(LeadObjection).filter(LeadObjection.lead_id == lead.id).one().timing == "before_estimate"


def test_each_text_is_read_once(db):
    lead = _lead(db)
    _text(db, lead, T0, "not interested")
    first = _fake([])
    ob.scan_lead(db, lead.id, classify=first)
    second = _fake([])
    r = ob.scan_lead(db, lead.id, classify=second)
    assert len(first.seen) == 1 and second.seen == [] and r["scanned"] == 0


def test_the_model_cannot_tag_what_it_was_not_asked_about(db):
    """Staff texts and already-scanned texts are context only."""
    lead = _lead(db)
    staff = _text(db, lead, T0, "That'll be $1,500", direction="outbound")
    new = _text(db, lead, T0 + timedelta(minutes=5), "ok")
    r = ob.scan_lead(db, lead.id, classify=_fake([
        {"category": "price", "source": "text", "source_id": staff.id, "line": None,
         "quote": "$1,500", "confidence": "high"},
        {"category": "made_up", "source": "text", "source_id": new.id, "line": None,
         "quote": "ok", "confidence": "high"},
    ]))
    assert r["found"] == 0


def test_a_removed_tag_never_comes_back(db):
    lead = _lead(db)
    m = _text(db, lead, T0, "my HOA has to approve it")
    tag = {"category": "hoa", "source": "text", "source_id": m.id, "line": None,
           "quote": "my HOA has to approve it", "confidence": "high"}
    ob.scan_lead(db, lead.id, classify=_fake([tag]))
    row = db.query(LeadObjection).filter(LeadObjection.lead_id == lead.id).one()
    leads_api.remove_objection(lead.id, row.id, user=USER)
    assert leads_api.list_objections(lead.id, user=USER)["objections"] == []
    db.query(ob.__dict__.get("ObjectionScan") or __import__("database").ObjectionScan).delete()
    db.commit()
    ob.scan_lead(db, lead.id, classify=_fake([tag]))
    db.expire_all()
    assert db.query(LeadObjection).filter(LeadObjection.lead_id == lead.id).count() == 1


def test_the_automatic_sweep_only_reads_what_came_after_it_started(db):
    lead = _lead(db)
    _text(db, lead, T0 - timedelta(days=30), "too expensive")
    m = _text(db, lead, T0 + timedelta(minutes=1), "need to ask my husband")
    seen = _fake([])
    ob.scan_lead(db, lead.id, only_after=T0, classify=seen)
    assert f"id={m.id}" in seen.seen[0] and " NEW]" in seen.seen[0]
    assert seen.seen[0].count(" NEW]") == 1
    assert ob.leads_due(db, T0, 10) == []


def test_job_progress_is_read_only(db):
    """The lead page shows Company Cam progress (getting cleaned, getting
    stained) but opening a lead must never create a Company Cam record."""
    from database import CompanyCamJob, CompanyCamPhoto
    lead = _lead(db)
    db.add(CompanyCamPhoto(id=str(uuid.uuid4()), lead_id=lead.id, section="clean_before", seq=1,
                           uploaded_at=T0.isoformat()))
    db.add(CompanyCamPhoto(id=str(uuid.uuid4()), lead_id=lead.id, section="stain_before", seq=1,
                           uploaded_at=T0.isoformat()))
    db.commit()
    out = leads_api.get_lead(lead.id)
    assert out["job_progress"]["photos"] == {"clean_before": 1, "stain_before": 1}
    assert out["job_progress"]["color_rows"] == 0
    db.expire_all()
    assert db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead.id).count() == 0


def test_before_staining_is_a_photo_section_but_not_a_blocker():
    from services.company_cam import SECTION_KEYS
    assert SECTION_KEYS.index("clean_after") < SECTION_KEYS.index("stain_before") < SECTION_KEYS.index("stain_after")


def test_waiting_on_photos_is_a_category(db):
    lead = _lead(db)
    _sent(db, lead, T0)
    rec = _call(db, lead, T0 - timedelta(minutes=3), 1535, [(1526, "but I'll send you some pictures")])
    ob.scan_lead(db, lead.id, classify=_fake([
        {"category": "waiting_photos", "source": "call", "source_id": rec.id, "line": 0,
         "quote": "I'll send you some pictures", "confidence": "high"}]))
    row = db.query(LeadObjection).filter(LeadObjection.lead_id == lead.id).one()
    assert row.category == "waiting_photos" and row.timing == "after_estimate" and row.mid_call_send


def test_a_call_that_ended_before_the_send_stays_before(db):
    lead = _lead(db)
    _sent(db, lead, T0 + timedelta(hours=1))
    rec = _call(db, lead, T0, 300, [(100, "my wife decides")])
    ob.scan_lead(db, lead.id, classify=_fake([
        {"category": "spouse_family", "source": "call", "source_id": rec.id, "line": 0,
         "quote": "my wife decides", "confidence": "high"}]))
    row = db.query(LeadObjection).filter(LeadObjection.lead_id == lead.id).one()
    assert row.timing == "before_estimate" and not row.mid_call_send


def test_the_sweep_reaches_back_two_weeks(db, monkeypatch):
    """A call from the day before the scanner first ran still gets read."""
    from database import SystemConfig
    lead = _lead(db)
    _call(db, lead, T0 - timedelta(days=1), 858, [(400, "waiting on my neighbor")])
    db.merge(SystemConfig(key="objection_scan_started_at", value=T0.isoformat()))
    db.commit()
    start = ob.scanner_start(db) - timedelta(days=ob.BACKFILL_DAYS)
    assert lead.id in ob.leads_due(db, start, 10)
