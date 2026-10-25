"""Both boards (2026-10-24): one person with a card on A&T's ads board and
on Sterling's board is found by GHL contact or by phone, and flagged when
both cards sit in a column where GHL is texting them."""
import services.ghl as ghl
import api.followups as fu

PIPES = [
    {"id": fu.AT_ADS_PIPELINE_ID, "stages": [
        {"id": "a-new", "name": "New Lead"}, {"id": "a-sent", "name": "ESTIMATE SENT"},
        {"id": "a-closed", "name": "CLOSED & SCHEDULED"}, {"id": "a-rltn", "name": "Responded to long term nurture"}]},
    {"id": fu.STERLING_PIPELINE_ID, "stages": [
        {"id": "s-sent", "name": "ESTIMATE SENT"}, {"id": "s-ltn", "name": "LONG TERM NURTURE"},
        {"id": "s-closed", "name": "CLOSED & SCHEDULED"}]},
]


def opp(oid, cid, name, phone, stage, status="open"):
    return {"id": oid, "contactId": cid, "pipelineStageId": stage, "status": status,
            "contact": {"id": cid, "name": name, "phone": phone}}


AT = [
    opp("o1", "c1", "Ann", "+17135550001", "a-sent"),      # same contact, both texting
    opp("o2", "c2", "Bob", "(713) 555-0002", "a-closed"),  # other contact, same phone
    opp("o3", "c3", "Cy", "+17135550003", "a-new"),        # only on A&T's board
    opp("o4", "c4", "Di", "+17135550004", "a-rltn"),       # replied column is not texting
]
STERLING = [
    opp("s1", "c1", "Ann", "+17135550001", "s-ltn"),
    opp("s2", "c9", "Bob", "7135550002", "s-sent"),
    opp("s4", "c4", "Di", "+17135550004", "s-closed"),
]


def test_board_overlap(monkeypatch):
    fu._overlap_cache.update(at=0.0, data=None)
    monkeypatch.setattr(ghl, "get_pipelines", lambda loc: PIPES)
    monkeypatch.setattr(ghl, "get_opportunities",
                        lambda loc, pid, *a, **k: AT if pid == fu.AT_ADS_PIPELINE_ID else STERLING)
    d = fu.board_overlap(refresh=True, user={})
    assert d["counts"] == {"both": 3, "both_texting": 1, "one_texting": 1, "two_contacts_one_phone": 1}
    first = d["both"][0]
    assert first["name"] == "Ann" and first["risk"] == "both_texting" and first["same_contact"]
    bob = next(b for b in d["both"] if b["name"] == "Bob")
    assert bob["risk"] == "one_texting" and not bob["same_contact"]
    di = next(b for b in d["both"] if b["name"] == "Di")
    assert di["risk"] == "quiet"
    assert d["boards"]["at"]["total"] == 4 and d["boards"]["at"]["texting"] == 2
