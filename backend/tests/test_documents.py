"""Documents: upload, list newest first, open, rename, archive; owner-only;
only real document types; titles read from the file name."""
import asyncio
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException, UploadFile  # noqa: E402
from starlette.datastructures import Headers  # noqa: E402

from api import documents as docs  # noqa: E402
from api.auth import require_revenue  # noqa: E402

ALAN = {"sub": "alanbonner", "name": "Alan", "role": "admin"}


def _file(name, data=b"%PDF-1.4 hello", mime="application/pdf"):
    return UploadFile(file=io.BytesIO(data), filename=name, headers=Headers({"content-type": mime}))


def test_titles_read_from_the_file_name():
    assert docs.title_from("Sterling-5-Week-Plan-2026-10-16.pdf") == "Sterling 5 Week Plan 2026-10-16"
    assert docs.title_from("VA_Training.pdf") == "VA Training"
    assert docs.title_from("") == "Untitled"


def test_upload_list_open_rename_archive(db):
    r = asyncio.run(docs.upload_documents([_file("Plan-A.pdf"), _file("Numbers.pdf", b"%PDF numbers")], ALAN))
    ids = [d["id"] for d in r["documents"]]
    listed = docs.list_documents(ALAN)["documents"]
    assert {d["title"] for d in listed} == {"Plan A", "Numbers"} and "data" not in listed[0]
    assert docs.list_documents(ALAN)["categories"][0]["label"] == "Start here"
    f = docs.open_document(ids[1], ALAN)
    assert f.body == b"%PDF numbers" and f.media_type == "application/pdf" and "inline" in f.headers["content-disposition"]
    assert docs.rename_document(ids[0], {"title": "The plan"}, ALAN)["title"] == "The plan"
    docs.remove_document(ids[0], ALAN)
    assert [d["id"] for d in docs.list_documents(ALAN)["documents"]] == [ids[1]]
    with pytest.raises(HTTPException):
        docs.open_document(ids[0], ALAN)


def test_refuses_odd_files_and_non_owners(db):
    with pytest.raises(HTTPException):
        asyncio.run(docs.upload_documents([_file("x.exe", b"MZ", "application/x-msdownload")], ALAN))
    with pytest.raises(HTTPException):
        asyncio.run(docs.upload_documents([_file("empty.pdf", b"")], ALAN))
    with pytest.raises(HTTPException):
        require_revenue({"sub": "olga", "role": "va"})


def test_known_pdfs_land_in_their_section_and_a_new_copy_replaces_the_old(db):
    assert docs.classify("Sterling-5-Week-Plan-2026-10-16.pdf")[:2] == ("start", "5-Week Game Plan")
    assert docs.classify("Sterling-VA-Training-2026-10-16.pdf")[0] == "va"
    assert docs.classify("Sterling-Customers-2026-10-16.pdf")[0] == "marketing"
    assert docs.classify("Sterling-Where-We-Are-2026-10-16.pdf")[0] == "older"
    assert docs.classify("random scan.pdf") == ("other", "random scan", "")
    asyncio.run(docs.upload_documents([_file("Sterling-5-Week-Plan-2026-10-16.pdf")], ALAN))
    asyncio.run(docs.upload_documents([_file("Sterling-5-Week-Plan-2026-10-23.pdf", b"%PDF v2")], ALAN))
    listed = docs.list_documents(ALAN)["documents"]
    assert len(listed) == 1 and listed[0]["category"] == "start" and listed[0]["blurb"]
    assert docs.open_document(listed[0]["id"], ALAN).body == b"%PDF v2"
    d = docs.rename_document(listed[0]["id"], {"category": "older"}, ALAN)
    assert d["category"] == "older"
    with pytest.raises(HTTPException):
        docs.rename_document(listed[0]["id"], {"category": "nope"}, ALAN)
