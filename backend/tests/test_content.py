"""Social media content: the row, the tag to a customer with the job's
details, the price only for the owners, and no upload without storage."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from api import content as cc  # noqa: E402
from database import CompanyCamJob, ContentItem, Estimate, Lead, ScheduledJob  # noqa: E402

ALAN = {"sub": "alanbonner", "name": "Alan", "role": "admin"}
VA = {"sub": "olga", "name": "Olga", "role": "va"}


def _seed(db):
    lead = Lead(id="L1", contact_name="Yogi Bear", address="1 Picnic Ln, Cypress", status="new")
    db.add(lead)
    db.add(Estimate(id="E1", lead_id="L1", closed_tier="legacy", closed_price=1840.80, created_at="2026-10-01T00:00:00"))
    db.add(CompanyCamJob(id="J1", lead_id="L1", final_color="Darkest Night"))
    db.add(ScheduledJob(id="S1", lead_id="L1", job_date="2026-10-17", package_tier="legacy", closed_price=1840.80))
    db.add(ContentItem(id="C1", kind="video", filename="black-fence.mov", mime="video/quicktime", size=900_000_000,
                       storage_path="2026-10-17/C1-black-fence.mov", storage_url="https://x/content/2026-10-17/C1-black-fence.mov",
                       uploaded=True, shot_on="2026-10-17", status="raw", created_at="2026-10-17T18:00:00"))
    db.add(ContentItem(id="C2", kind="photo", filename="pending.jpg", uploaded=False, created_at="2026-10-17T18:01:00"))
    db.commit()


def test_tag_fills_the_card_from_the_job_and_hides_price_from_the_va(db):
    _seed(db)
    out = cc.update_content("C1", cc.ContentPatch(lead_id="L1", note="Came out beautiful"), user=ALAN)
    assert out["lead"]["name"] == "Yogi Bear" and out["lead"]["job_date"] == "2026-10-17"
    # The editor's copy, filled from the job: name, package, colour, price, and the calendar day.
    assert out["customer_name"] == "Yogi Bear" and out["address"] == "1 Picnic Ln, Cypress" and out["package"] == "Legacy"
    assert out["color"] == "Darkest Night" and out["sold_for"] == 1840.80
    assert out["shot_on"] == "2026-10-17" and out["note"] == "Came out beautiful"
    # Editable without touching the real job.
    out = cc.update_content("C1", cc.ContentPatch(package="Signature", color="Pecan", sold_for=1500, address="2 Picnic Ln"), user=ALAN)
    assert (out["package"], out["color"], out["sold_for"], out["address"]) == ("Signature", "Pecan", 1500.0, "2 Picnic Ln")
    assert db.query(ScheduledJob).filter(ScheduledJob.id == "S1").first().package_tier == "legacy"
    # And back to the job's details on request.
    out = cc.update_content("C1", cc.ContentPatch(reset_from_job=True), user=ALAN)
    assert out["package"] == "Legacy" and out["sold_for"] == 1840.80
    # The VA can edit the words but never sees or sets the money.
    listed = cc.list_content(user=VA)
    assert [i["id"] for i in listed["items"]] == ["C1"]          # the unfinished upload stays hidden
    assert listed["items"][0]["sold_for"] is None and "price" not in listed["items"][0]["lead"]
    out = cc.update_content("C1", cc.ContentPatch(sold_for=5), user=VA)
    assert out["sold_for"] is None
    assert db.query(ContentItem).filter(ContentItem.id == "C1").first().sold_for == 1840.80


def test_bad_tag_and_bad_status_are_refused(db):
    _seed(db)
    with pytest.raises(HTTPException) as e:
        cc.update_content("C1", cc.ContentPatch(lead_id="nope"), user=ALAN)
    assert e.value.status_code == 404
    with pytest.raises(HTTPException):
        cc.update_content("C1", cc.ContentPatch(status="draft"), user=ALAN)
    assert cc.update_content("C1", cc.ContentPatch(status="posted"), user=ALAN)["status"] == "posted"


def test_no_storage_no_upload(db, monkeypatch):
    monkeypatch.setattr(cc.storage, "ensure_bucket", lambda *a, **k: False)
    cc._bucket_ready = False
    with pytest.raises(HTTPException) as e:
        cc.sign_upload(cc.SignBody(filename="a.mov", mime="video/quicktime", size=10), user=ALAN)
    assert e.value.status_code == 503


def test_sign_makes_the_row_and_the_link(db, monkeypatch):
    monkeypatch.setattr(cc.storage, "ensure_bucket", lambda *a, **k: True)
    monkeypatch.setattr(cc.storage, "signed_upload", lambda b, p: {"url": f"https://x/sign/{p}?token=t", "public_url": f"https://x/{b}/{p}"})
    monkeypatch.setattr(cc.storage, "object_exists", lambda b, p: True)
    out = cc.sign_upload(cc.SignBody(filename="my clip (1).MOV", mime="video/quicktime", size=10, shot_on="2026-10-17"), user=ALAN)
    assert out["upload_url"].startswith("https://x/sign/2026-10-17/") and "my-clip-1-.MOV" in out["upload_url"] or "my-clip" in out["upload_url"]
    row = db.query(ContentItem).filter(ContentItem.id == out["id"]).first()
    assert row.kind == "video" and row.uploaded is False
    done = cc.mark_uploaded(out["id"], cc.UploadedBody(width=3840, height=2160, duration_seconds=12.5), user=ALAN)
    assert done["width"] == 3840 and done["url"] == out["public_url"]
    assert [i["id"] for i in cc.list_content(user=ALAN)["items"]] == [out["id"]]


def test_social_role_sees_only_the_library_and_fence_photos():
    from api.permissions import ROLE_BASELINE, VALID_ROLES, role_defaults
    assert "social" in VALID_ROLES
    assert ROLE_BASELINE["social"] == {"social_media", "fence_photos"}
    d = role_defaults("social", None)
    assert d["social_media"] and d["fence_photos"]
    assert not d["leads"] and not d["see_prices"] and not d["calendar"] and not d["dashboard"]


def test_customer_picker_gives_name_and_address_only(db):
    _seed(db)
    out = cc.content_customers(q="yogi", user=ALAN)
    assert out["results"] == [{"id": "L1", "name": "Yogi Bear", "address": "1 Picnic Ln, Cypress"}]
    assert cc.content_customers(q="nobody", user=ALAN)["results"] == []


def test_a_photo_tagged_before_the_card_existed_still_reads_the_job(db):
    _seed(db)
    row = db.query(ContentItem).filter(ContentItem.id == "C1").first()
    row.lead_id = "L1"          # tagged the old way: no card of its own
    db.commit()
    out = cc.list_content(user=ALAN)["items"][0]
    assert out["customer_name"] == "Yogi Bear" and out["address"] == "1 Picnic Ln, Cypress"
    assert out["package"] == "Legacy" and out["color"] == "Darkest Night"
    assert out["sold_for"] is None      # money is never guessed; "use the job's details" fills it
    assert set(out["lead"].keys()) == {"id", "name", "address", "job_date"}


def test_only_the_owner_can_remove(db):
    _seed(db)
    alec = {"sub": "alecw", "name": "Alec", "role": "social"}
    with pytest.raises(HTTPException) as e:
        cc.remove_content("C1", user=alec)
    assert e.value.status_code == 403
    with pytest.raises(HTTPException):
        cc.remove_content("C1", user=VA)
    assert db.query(ContentItem).filter(ContentItem.id == "C1").first().archived is False
    assert cc.remove_content("C1", user=ALAN) == {"ok": True}


class _Resp:
    def __init__(self, status, text=""):
        self.status_code = status
        self.text = text
        self.is_success = 200 <= status < 300


def _fake_client(get_status, post_resp, calls):
    class C:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url, headers=None):
            calls.append(("GET", url)); return _Resp(get_status)
        def post(self, url, headers=None, json=None):
            calls.append(("POST", url)); return post_resp
    return C


def _keys(monkeypatch):
    from services import supabase_storage as ss
    monkeypatch.setattr(ss, "_enabled", lambda: True)
    monkeypatch.setattr(ss, "get_settings", lambda: type("S", (), {"supabase_url": "https://x.supabase.co", "supabase_service_key": "k"})())
    return ss


def test_a_bucket_that_already_exists_is_ready_without_creating_it(monkeypatch):
    """What Alan hit: the bucket existed, the keys were set, and every upload
    after a restart said storage wasn't set up."""
    ss = _keys(monkeypatch); calls = []
    monkeypatch.setattr(ss.httpx, "Client", _fake_client(200, _Resp(500), calls))
    assert ss.ensure_bucket("content") is True
    assert [c[0] for c in calls] == ["GET"]


def test_supabase_duplicate_answer_counts_as_ready(monkeypatch):
    ss = _keys(monkeypatch); calls = []
    dup = _Resp(400, '{"statusCode":"409","error":"Duplicate","message":"The resource already exists"}')
    monkeypatch.setattr(ss.httpx, "Client", _fake_client(404, dup, calls))
    assert ss.ensure_bucket("content") is True


def test_a_real_storage_error_is_not_called_missing_keys(db, monkeypatch):
    monkeypatch.setattr(cc.storage, "ensure_bucket", lambda *a, **k: False)
    monkeypatch.setattr(cc.storage, "_enabled", lambda: True)
    cc._bucket_ready = False
    with pytest.raises(HTTPException) as e:
        cc.sign_upload(cc.SignBody(filename="a.mov", mime="video/quicktime", size=10), user=ALAN)
    assert e.value.status_code == 502
