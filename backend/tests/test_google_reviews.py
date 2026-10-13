"""Google reviews on the proposal: pulled in pages, five-star only on the
page, the four-star one off (Alan, 2026-10-12)."""
import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from database import GoogleReview  # noqa: E402
from services import google_reviews as gr  # noqa: E402
from api import reviews as reviews_api  # noqa: E402

ADMIN = {"sub": "alanbonner", "name": "Alan", "role": "admin"}


def _fake_serpapi(monkeypatch, pages, search=None):
    calls = []

    class R:
        def __init__(self, data):
            self._d = data
        def raise_for_status(self):
            pass
        def json(self):
            return self._d

    def get(url, params=None, timeout=None):
        calls.append(params)
        if params["engine"] == "google_maps":
            return R(search or {"place_results": {"data_id": "0xabc:0xdef"}})
        idx = int(params.get("next_page_token") or 0)
        return R(pages[idx])
    monkeypatch.setattr(gr.httpx, "get", get)
    monkeypatch.setattr(gr, "get_settings", lambda: SimpleNamespace(serpapi_key="k", google_place_data_id="", google_place_query="Sterling Fence Staining Cypress TX"))
    return calls


def _review(rid, name, rating, text, date="2026-09-01T00:00:00Z", rel="a month ago"):
    return {"review_id": rid, "user": {"name": name, "thumbnail": f"https://img/{rid}.jpg"}, "rating": rating,
            "snippet": text, "iso_date": date, "date": rel, "link": f"https://maps/{rid}"}


def test_reviews_are_pulled_in_pages_and_only_five_stars_reach_the_page(db, monkeypatch):
    pages = [
        {"place_info": {"rating": 4.9, "reviews": 41}, "reviews": [
            _review("r1", "Ana", 5, "Fence looks brand new.", "2026-10-01T00:00:00Z", "a week ago"),
            _review("r2", "Bo", 4, "Good but late.", "2026-09-20T00:00:00Z"),
        ], "serpapi_pagination": {"next_page_token": "1"}},
        {"reviews": [
            _review("r3", "Cy", 5, "", "2026-09-10T00:00:00Z"),            # no words: not shown
            _review("r4", "Di", 5, "Crew kept the hinges clean.", "2026-08-01T00:00:00Z"),
        ]},
    ]
    calls = _fake_serpapi(monkeypatch, pages)
    out = gr.refresh(db)
    assert out["five_star"] == 3 and out["total"] == 41 and out["rating"] == 4.9
    assert calls[0]["engine"] == "google_maps"                # found the listing once
    assert [c.get("next_page_token") for c in calls[1:]] == [None, "1"]
    pub = gr.public_reviews(db)
    assert [r["author"] for r in pub["reviews"]] == ["Ana", "Di"]   # 5-star, with words, newest first
    assert pub["five_star"] == 3 and pub["total"] == 41 and "hidden" not in pub["reviews"][0]
    # The second pull updates rather than duplicates, and the listing id is remembered.
    calls.clear()
    gr.refresh(db)
    assert db.query(GoogleReview).count() == 4 and calls[0]["engine"] == "google_maps_reviews"


def test_the_office_can_hide_one_and_the_endpoints_say_why_when_the_key_is_missing(db, monkeypatch):
    _fake_serpapi(monkeypatch, [{"reviews": [_review("r9", "Ed", 5, "Great job")]}])
    gr.refresh(db)
    assert len(gr.public_reviews(db)["reviews"]) == 1
    out = reviews_api.hide_review("r9", reviews_api.HideBody(hidden=True), ADMIN)
    assert out["hidden"] is True and gr.public_reviews(db)["reviews"] == []
    listed = reviews_api.list_reviews({"name": "Olga"})
    assert listed["reviews"][0]["hidden"] is True and listed["configured"] is True
    monkeypatch.setattr(gr, "get_settings", lambda: SimpleNamespace(serpapi_key="", google_place_data_id="", google_place_query="x"))
    with pytest.raises(Exception) as e:
        reviews_api.refresh_reviews(ADMIN)
    assert "SERPAPI_KEY" in str(e.value.detail)


def test_reviews_pasted_by_hand_show_up_with_the_counts_set_by_hand(db):
    text = """Matt Shivers | 5 | 7 weeks ago
Awesome crew to work with and very pleased with the result! Definitely recommend!

Michael Parr | 5 stars | 7 weeks ago
avatar: https://lh3/a.jpg
photo: https://lh3/p1.jpg
My fence has never looked better!
You won't be disappointed

Second paragraph of the same review.
photo: https://lh3/p2.jpg

Some Critic | 4 | a year ago
Fine."""
    assert gr.add_manual(db, text) == 3
    assert gr.add_manual(db, text) == 0                     # pasted twice: no doubles
    pub = gr.public_reviews(db)
    assert [r["author"] for r in pub["reviews"]] == ["Matt Shivers", "Michael Parr"]
    assert pub["reviews"][1]["text"] == "My fence has never looked better! You won't be disappointed\n\nSecond paragraph of the same review."
    assert pub["reviews"][0]["when"] == "7 weeks ago" and pub["reviews"][0]["date"]
    assert pub["reviews"][1]["photo"] == "https://lh3/a.jpg" and pub["reviews"][1]["photos"] == ["https://lh3/p1.jpg", "https://lh3/p2.jpg"]
    assert pub["reviews"][0]["photos"] == []
    out = reviews_api.set_summary(reviews_api.SummaryBody(rating=5.0, total=41, five_star=40), ADMIN)
    assert out["five_star"] == 40 and out["total"] == 41
    pub = gr.public_reviews(db)
    assert pub["five_star"] == 40 and pub["total"] == 41 and pub["rating"] == 5.0
    assert reviews_api.add_manual_reviews(reviews_api.ManualBody(text="Only Name"), ADMIN)["parsed"] == 1
    with pytest.raises(Exception):
        reviews_api.add_manual_reviews(reviews_api.ManualBody(text="   "), ADMIN)
    assert gr._when_to_iso("a month ago") and gr._when_to_iso("last week") == ""


def test_the_pulled_set_loads_once_into_an_empty_table(db, monkeypatch, tmp_path):
    seed = tmp_path / "seed.json"
    seed.write_text(json.dumps({"summary": {"rating": 5.0, "total": 40, "five_star": 39}, "reviews": [
        {"id": "abc", "author": "Doug Becker", "rating": 5, "when": "a month ago", "text": "Great experience!",
         "avatar": "https://lh3/a.png", "photos": ["https://lh3/p.jpg"]},
        {"id": "def", "author": "Henry", "rating": 4, "when": "a month ago", "text": "Happy."},
    ]}), encoding="utf-8")
    monkeypatch.setattr(gr, "SEED_PATH", seed)
    out = gr.seed_if_empty(db)
    assert out["five_star"] == 39 and out["total"] == 40
    pub = gr.public_reviews(db)
    assert [r["author"] for r in pub["reviews"]] == ["Doug Becker"] and pub["reviews"][0]["photos"] == ["https://lh3/p.jpg"]
    assert gr.seed_if_empty(db) is None                      # not empty any more: left alone
    assert reviews_api.import_seed(ADMIN)["five_star"] == 39  # loading again changes nothing
    assert db.query(GoogleReview).count() == 2
