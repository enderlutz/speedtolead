"""Fence Photos → By customer (2026-10-25): every customer with crew photos,
newest first, with an after-staining cover; one customer's photos in job
order, each labelled."""
import uuid
import api.fence_photos as fp
from database import CompanyCamPhoto, Lead


def _lead(db, name):
    l = Lead(id=str(uuid.uuid4()), contact_name=name, contact_phone="+17135550000", ghl_contact_id="g" + name,
             pipeline_version="v2", status="new", created_at="2026-10-01T00:00:00Z", address="1 Main St")
    db.add(l)
    return l


def _photo(db, lead, section, seq, when, url=""):
    db.add(CompanyCamPhoto(id=str(uuid.uuid4()), lead_id=lead.id, section=section, seq=seq,
                           uploaded_at=when, storage_url=url))


def test_by_customer(db, monkeypatch):
    monkeypatch.setattr(fp, "get_db", lambda: db)
    db.close = lambda: None
    a, b = _lead(db, "Ann"), _lead(db, "Bob")
    _photo(db, a, "stain_after", 1, "2026-10-20T15:00:00Z", "https://x/a-after.jpg")
    _photo(db, a, "clean_before", 1, "2026-10-19T15:00:00Z", "https://x/a-before.jpg")
    _photo(db, b, "clean_before", 1, "2026-10-22T15:00:00Z")
    db.commit()
    out = fp.fence_photo_customers(user={})["customers"]
    assert [c["name"] for c in out] == ["Bob", "Ann"]
    ann = out[1]
    assert ann["count"] == 2 and ann["cover"] == "https://x/a-after.jpg"
    assert {k["label"] for k in ann["kinds"]} == {"After staining", "Before cleaning"}
    one = fp.fence_photo_customer(a.id, user={})
    assert [p["label"] for p in one["photos"]] == ["Before cleaning", "After staining"]
    assert out[0]["cover"].startswith("/api/company-cam/")
