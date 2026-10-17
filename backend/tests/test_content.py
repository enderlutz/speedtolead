"""Social media content: the row, the tag to a customer with the job's
details, the price only for the owners, and no upload without storage."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from api import content as cc  # noqa: E402
from database import CompanyCamJob, ContentItem, Estimate, Lead  # noqa: E402

ALAN = {"sub": "alanbonner", "name": "Alan", "role": "admin"}
VA = {"sub": "olga", "name": "Olga", "role": "va"}


def _seed(db):
    lead = Lead(id="L1", contact_name="Yogi Bear", address="1 Picnic Ln, Cypress", status="new")
    db.add(lead)
    db.add(Estimate(id="E1", lead_id="L1", closed_tier="legacy", closed_price=1840.80, created_at="2026-10-01T00:00:00"))
    db.add(CompanyCamJob(id="J1", lead_id="L1", final_color="Darkest Night"))
    db.add(ContentItem(id="C1", kind="video", filename="black-fence.mov", mime="video/quicktime", size=900_000_000,
                       storage_path="2026-10-17/C1-black-fence.mov", storage_url="https://x/content/2026-10-17/C1-black-fence.mov",
                       uploaded=True, shot_on="2026-10-17", status="raw", created_at="2026-10-17T18:00:00"))
    db.add(ContentItem(id="C2", kind="photo", filename="pending.jpg", uploaded=False, created_at="2026-10-17T18:01:00"))
    db.commit()


def test_tag_shows_the_job_and_hides_price_from_the_va(db):
    _seed(db)
    out = cc.update_content("C1", cc.ContentPatch(lead_id="L1", note="Came out beautiful"), user=ALAN)
    assert out["lead"]["name"] == "Yogi Bear"
    assert out["lead"]["package"] == "Legacy" and out["lead"]["color"] == "Darkest Night"
    assert out["lead"]["price"] == 1840.80 and out["note"] == "Came out beautiful"
    listed = cc.list_content(user=VA)
    assert [i["id"] for i in listed["items"]] == ["C1"]          # the unfinished upload stays hidden
    assert listed["items"][0]["lead"]["price"] is None and listed["can_see_price"] is False


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
