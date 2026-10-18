"""Company Cam — the job-site record the crew works from.

Background: the crew fields already existed on ScheduledJob (color_choice,
gallons_estimate, inspection_notes) alongside a job_photos table with
inspection/post_cleanup/post_staining categories. None of it was adopted —
58 scheduled jobs, 0 completed, 3 with gallons, and job_photos holds 0 rows
against 2,420 leads. So this hangs off the lead instead, which is also what
Alan asked for.

What these pin:
  * stain quantity is square footage / 165, rounded UP to the half gallon —
    you cannot buy 3.07 gallons and a crew arriving short is the worse failure
  * the record seeds itself from the latest sent estimate, ONCE. A later
    estimate revision must never silently overwrite a number the crew
    corrected while standing at the fence
  * correcting the footage moves the stain order with it, unless somebody
    overrode the gallons directly
  * the fence scope drawing imports itself, and only once
  * a scope photo OR a written scope is required — Alan's rule, so nobody
    arrives not knowing what is included
  * the almost-finished text cannot be sent to an opted-out customer, and
    cannot be sent twice by a crew refreshing the page
"""
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from database import CompanyCamJob, CompanyCamPhoto, Estimate, Lead  # noqa: E402
from api import company_cam as cc  # noqa: E402
from services.company_cam import SQFT_PER_GALLON, gallons_for, upsell_options  # noqa: E402
import services.company_cam as cc_svc  # noqa: E402

USER = {"sub": "alanbonner", "name": "Alan", "role": "admin"}


def _lead(db, **kw):
    lead = Lead(
        id=str(uuid.uuid4()),
        contact_name=kw.pop("name", "Test Customer"),
        contact_phone=kw.pop("phone", "+17135551234"),
        ghl_contact_id=kw.pop("ghl_contact_id", "ghl-abc"),
        pipeline_version="v2",
        status="new",
        created_at="2026-10-01T00:00:00Z",
        **kw,
    )
    db.add(lead)
    db.commit()
    return lead


def _estimate(db, lead, *, linear_feet=159, height="7ft", sqft=None, tier=""):
    import json
    inputs = {"linear_feet": linear_feet, "fence_height": height}
    if sqft is not None:
        inputs["_sqft"] = sqft
    est = Estimate(
        id=str(uuid.uuid4()),
        lead_id=lead.id,
        status="sent",
        sent_at="2026-10-02T12:00:00Z",
        inputs=json.dumps(inputs),
        tiers="{}",
        closed_tier=tier,
        created_at="2026-10-02T11:00:00Z",
    )
    db.add(est)
    db.commit()
    return est


# --- the stain maths ---

def test_gallons_is_sqft_over_165():
    assert SQFT_PER_GALLON == 165.0
    assert gallons_for(165) == 1.0
    assert gallons_for(330) == 2.0


@pytest.mark.parametrize("sqft,expected", [
    (0, 0.0), (None, 0.0), (-50, 0.0),
    (100, 1.0),      # 0.61 -> 1.0
    (1113, 7.0),     # 6.745 -> 7.0
    (2000, 12.5),    # 12.12 -> 12.5
])
def test_gallons_rounds_up_to_the_half(sqft, expected):
    """Never round down: a crew that runs out mid-fence has to come back."""
    assert gallons_for(sqft) == expected


# --- seeding ---

def test_record_seeds_square_footage_from_the_estimate(db):
    lead = _lead(db)
    _estimate(db, lead, sqft=1113)
    out = cc.get_company_cam(lead.id, user=USER)
    assert out["job"]["sqft"] == 1113
    assert out["job"]["gallons_needed"] == 7.0


def test_footage_falls_back_to_linear_feet_times_height(db):
    """Older estimates predate the computed _sqft field."""
    lead = _lead(db)
    _estimate(db, lead, linear_feet=159, height="7ft", sqft=None)
    out = cc.get_company_cam(lead.id, user=USER)
    assert out["job"]["sqft"] == 1113.0


def test_a_later_estimate_does_not_overwrite_a_crew_correction(db):
    """The whole reason seeding happens once. The crew is at the fence."""
    lead = _lead(db)
    _estimate(db, lead, sqft=1000)
    cc.get_company_cam(lead.id, user=USER)
    cc.update_company_cam(lead.id, cc.CompanyCamPatch(sqft=1400), user=USER)
    # A revised estimate lands afterwards.
    _estimate(db, lead, sqft=900)
    out = cc.get_company_cam(lead.id, user=USER)
    assert out["job"]["sqft"] == 1400
    assert out["job"]["sqft_edited"] is True


def test_no_estimate_yet_is_not_an_error(db):
    """Every lead gets a record, priced or not."""
    lead = _lead(db)
    out = cc.get_company_cam(lead.id, user=USER)
    assert out["job"]["sqft"] == 0
    assert out["job"]["gallons_needed"] == 0
    assert any("square footage" in b for b in out["blockers"])


# --- footage and gallons stay in step ---

def test_fixing_the_footage_moves_the_stain_order(db):
    lead = _lead(db)
    _estimate(db, lead, sqft=1000)
    cc.get_company_cam(lead.id, user=USER)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(sqft=1650), user=USER)
    assert r["job"]["gallons_needed"] == 10.0


def test_an_explicit_gallon_override_survives_a_footage_edit(db):
    """Someone who typed a gallon count knows something the maths doesn't."""
    lead = _lead(db)
    _estimate(db, lead, sqft=1000)
    cc.get_company_cam(lead.id, user=USER)
    cc.update_company_cam(lead.id, cc.CompanyCamPatch(gallons_needed=9), user=USER)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(sqft=1650), user=USER)
    assert r["job"]["gallons_needed"] == 9.0
    assert r["job"]["gallons_edited"] is True


# --- scope ---

def test_scope_drawing_imports_itself_once(db):
    lead = _lead(db, has_fence_scope_export=True, fence_scope_export_image=b"PNGDATA")
    cc.get_company_cam(lead.id, user=USER)
    cc.get_company_cam(lead.id, user=USER)
    cc.get_company_cam(lead.id, user=USER)
    photos = db.query(CompanyCamPhoto).filter(
        CompanyCamPhoto.lead_id == lead.id,
        CompanyCamPhoto.section == "fence_scope").all()
    assert len(photos) == 1
    assert photos[0].uploaded_by == "auto:fence-scope"


def test_scope_photo_clears_the_scope_blocker(db):
    lead = _lead(db, has_fence_scope_export=True, fence_scope_export_image=b"PNGDATA")
    out = cc.get_company_cam(lead.id, user=USER)
    assert not any("Fence scope" in b for b in out["blockers"])


def test_without_a_drawing_a_written_scope_is_accepted_instead(db):
    """Alan's rule: a photo, or failing that an explanation. One or the other."""
    lead = _lead(db)
    out = cc.get_company_cam(lead.id, user=USER)
    assert any("Fence scope" in b for b in out["blockers"])
    r = cc.update_company_cam(
        lead.id,
        cc.CompanyCamPatch(scope_explanation="Inside only, skip the gate, 6ft cedar."),
        user=USER)
    assert not any("Fence scope" in b for b in r["blockers"])


# --- upsells ---

def test_upsell_list_covers_what_alan_named(db):
    keys = {o["key"] for o in upsell_options()}
    for wanted in ("exterior_window_cleaning", "driveway_walkway_cleaning",
                   "house_washing", "roof_washing", "gutter_cleaning",
                   "sprinkler_repair", "landscaping", "fence_replacement"):
        assert wanted in keys, wanted


def test_staining_tiers_are_not_offered_as_upsells(db):
    """Essential/Signature/Legacy are the job, not an add-on."""
    keys = {o["key"] for o in upsell_options()}
    assert not ({"essential", "signature", "legacy"} & keys)


def test_unknown_upsell_keys_are_rejected_not_stored(db):
    lead = _lead(db)
    cc.get_company_cam(lead.id, user=USER)
    r = cc.update_company_cam(
        lead.id,
        cc.CompanyCamPatch(upsells=["roof_washing", "time_travel"]),
        user=USER)
    assert r["job"]["upsells"] == ["roof_washing"]


# --- photos ---

def test_unknown_photo_section_is_refused(db):
    import asyncio

    class _F:
        content_type = "image/jpeg"
        async def read(self): return b"JPEGDATA"

    lead = _lead(db)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(cc.upload_photo(lead.id, file=_F(), section="during_lunch",
                                    side="", note="", is_damage=False, user=USER))
    assert exc.value.status_code == 400


def test_photos_number_themselves_per_section(db):
    import asyncio

    class _F:
        content_type = "image/jpeg"
        async def read(self): return b"JPEGDATA"

    lead = _lead(db)
    # side/note/is_damage passed explicitly: calling the handler directly
    # bypasses FastAPI's Form() resolution, which a real request performs.
    for side in ("left", "right", "back"):
        asyncio.run(cc.upload_photo(lead.id, file=_F(), section="clean_before",
                                    side=side, note="", is_damage=False, user=USER))
    asyncio.run(cc.upload_photo(lead.id, file=_F(), section="stain_after",
                                side="left", note="", is_damage=False, user=USER))
    rows = db.query(CompanyCamPhoto).filter(CompanyCamPhoto.lead_id == lead.id).all()
    before = sorted(p.seq for p in rows if p.section == "clean_before")
    after = sorted(p.seq for p in rows if p.section == "stain_after")
    assert before == [1, 2, 3]
    assert after == [1]


# --- the almost-finished text ---

def test_almost_done_refuses_an_opted_out_customer(db):
    """The last gate before a message leaves, not the disabled button."""
    lead = _lead(db, do_not_contact=True)
    with pytest.raises(HTTPException) as exc:
        cc.send_almost_done(lead.id, user=USER)
    assert exc.value.status_code == 400
    assert "not to be contacted" in exc.value.detail


def test_almost_done_refuses_a_lead_with_no_phone(db):
    lead = _lead(db, phone="")
    with pytest.raises(HTTPException) as exc:
        cc.send_almost_done(lead.id, user=USER)
    assert exc.value.status_code == 400


def test_almost_done_cannot_be_sent_twice(db, monkeypatch):
    """A crew refreshing the page must not text the customer again."""
    from services import ghl
    monkeypatch.setattr(ghl, "send_sms", lambda *a, **k: True)

    lead = _lead(db)
    first = cc.send_almost_done(lead.id, user=USER)
    assert first["ok"] is True
    with pytest.raises(HTTPException) as exc:
        cc.send_almost_done(lead.id, user=USER)
    assert exc.value.status_code == 400
    assert "Already sent" in exc.value.detail


def test_almost_done_can_be_reset_for_a_second_visit(db, monkeypatch):
    from services import ghl
    monkeypatch.setattr(ghl, "send_sms", lambda *a, **k: True)

    lead = _lead(db)
    cc.send_almost_done(lead.id, user=USER)
    cc.reset_almost_done(lead.id, user=USER)
    assert cc.send_almost_done(lead.id, user=USER)["ok"] is True


def test_almost_done_uses_the_customers_first_name(db, monkeypatch):
    sent = {}
    from services import ghl
    monkeypatch.setattr(ghl, "send_sms",
                        lambda cid, msg, **k: sent.update(msg=msg) or True)

    lead = _lead(db, name="Michele Horton")
    cc.send_almost_done(lead.id, user=USER)
    assert sent["msg"].startswith("Hey Michele,")
    assert "videos of the finished fence" in sent["msg"]


def test_almost_done_handles_a_nameless_lead(db, monkeypatch):
    sent = {}
    from services import ghl
    monkeypatch.setattr(ghl, "send_sms",
                        lambda cid, msg, **k: sent.update(msg=msg) or True)

    lead = _lead(db, name="")
    cc.send_almost_done(lead.id, user=USER)
    assert sent["msg"].startswith("Hey there,")


def test_a_failed_send_does_not_mark_it_sent(db, monkeypatch):
    """Otherwise the customer never hears from us and nobody can retry."""
    from services import ghl
    monkeypatch.setattr(ghl, "send_sms", lambda *a, **k: False)

    lead = _lead(db)
    with pytest.raises(HTTPException) as exc:
        cc.send_almost_done(lead.id, user=USER)
    assert exc.value.status_code == 502
    job = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead.id).first()
    assert not (job.almost_done_sent_at or "")


# --- colour ---

def test_colour_shown_is_tracked_apart_from_colour_confirmed(db):
    """Confirmed means we have one on file. Shown means somebody held it up
    at the fence — Alan wants that done even when it is already confirmed."""
    lead = _lead(db)
    cc.update_company_cam(
        lead.id, cc.CompanyCamPatch(color="Canyon Brown", color_confirmed=True), user=USER)
    out = cc.get_company_cam(lead.id, user=USER)
    assert out["job"]["color_confirmed"] is True
    assert out["job"]["color_shown_at"] == ""

    r = cc.mark_color_shown(lead.id, user=USER)
    assert r["job"]["color_shown_at"]
    assert r["job"]["color_shown_by"] == "Alan"


def test_unknown_lead_is_a_404(db):
    with pytest.raises(HTTPException) as exc:
        cc.get_company_cam("no-such-lead", user=USER)
    assert exc.value.status_code == 404


def test_a_gallon_override_can_be_dropped_again(db):
    """The reset button next to the gallon field. Without a real flag the
    override would stick forever and a footage fix would not move the stain
    order — which is the bug that button was pretending to fix."""
    lead = _lead(db)
    _estimate(db, lead, sqft=1650)
    cc.get_company_cam(lead.id, user=USER)
    cc.update_company_cam(lead.id, cc.CompanyCamPatch(gallons_needed=3), user=USER)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(recalc_gallons=True), user=USER)
    assert r["job"]["gallons_edited"] is False
    assert r["job"]["gallons_needed"] == 10.0


# --- colour: where the customer actually is, per area of the fence ---

def test_colour_can_differ_by_area(db):
    """Alan's real case: front gates settled, insides still between three.
    A single colour field could not say this at all."""
    lead = _lead(db)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(color_plan=[
        {"area": "Front gates", "status": "confirmed", "colors": ["Canyon Brown"]},
        {"area": "Inside fences", "status": "choosing",
         "colors": ["Canyon Brown", "October Brown", "Chocolate"]},
    ]), user=USER)
    plan = r["job"]["color_plan"]
    assert len(plan) == 2
    assert plan[0]["status"] == "confirmed"
    assert plan[1]["colors"] == ["Canyon Brown", "October Brown", "Chocolate"]


def test_the_plan_becomes_the_cleaners_instructions(db):
    """The point of the structure — Alan called it "the next step for the
    cleaner", not a record of a decision."""
    lead = _lead(db)
    cc.update_company_cam(lead.id, cc.CompanyCamPatch(color_plan=[
        {"area": "Front gates", "status": "confirmed", "colors": ["Canyon Brown"]},
        {"area": "Inside fences", "status": "choosing", "colors": ["October Brown", "Chocolate"]},
        {"area": "Outside back", "status": "not_chosen", "colors": []},
    ]), user=USER)
    actions = cc.get_company_cam(lead.id, user=USER)["cleaner_actions"]
    joined = " ".join(actions)
    # Nothing to do where it is settled.
    assert "Front gates" not in joined
    assert "Inside fences: show October Brown, Chocolate" in joined
    assert "Outside back: no colour chosen" in joined


def test_confirmed_with_no_colour_written_down_is_flagged(db):
    """Someone ticked confirmed and moved on. The crew needs to know."""
    lead = _lead(db)
    cc.update_company_cam(lead.id, cc.CompanyCamPatch(color_plan=[
        {"area": "Whole fence", "status": "confirmed", "colors": []},
    ]), user=USER)
    actions = cc.get_company_cam(lead.id, user=USER)["cleaner_actions"]
    assert any("no colour written down" in a for a in actions)


def test_a_colour_still_being_chosen_is_not_a_blocker(db):
    """It is a legitimate state the cleaner resolves on site, so it belongs in
    the action list, not in "still needed"."""
    lead = _lead(db)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(color_plan=[
        {"area": "Whole fence", "status": "choosing", "colors": ["A", "B"]},
    ]), user=USER)
    assert not any("colour" in b.lower() for b in r["blockers"])


def test_a_bogus_colour_status_falls_back_rather_than_storing(db):
    lead = _lead(db)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(color_plan=[
        {"area": "Whole fence", "status": "whatever", "colors": ["A"]},
    ]), user=USER)
    assert r["job"]["color_plan"][0]["status"] == "not_chosen"


# --- colour rows are sets of sides, the same eight the estimator uses ---

def test_a_fresh_row_with_only_sides_is_kept(db):
    """The bug Alan hit: "Add a part of the fence" created a row with no
    name and no colour, the server threw it away, and the row vanished
    before anybody could type in it. A row with sides is a row."""
    lead = _lead(db)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(color_plan=[
        {"sides": ["Inside Front"], "status": "not_chosen", "colors": []},
    ]), user=USER)
    plan = r["job"]["color_plan"]
    assert len(plan) == 1
    assert plan[0]["sides"] == ["Inside Front"]
    assert plan[0]["area"] == "Inside: Front"


def test_a_row_that_says_nothing_is_still_dropped(db):
    lead = _lead(db)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(color_plan=[
        {"sides": [], "area": "", "status": "not_chosen", "colors": []},
    ]), user=USER)
    assert r["job"]["color_plan"] == []


@pytest.mark.parametrize("sides,label", [
    (["Inside Front", "Inside Left", "Inside Back", "Inside Right"], "All insides"),
    (["Inside Front", "Inside Left", "Outside Back"], "Inside: Front, Left · Outside: Back"),
    (list(cc_svc.FENCE_SIDE_KEYS), "Whole fence"),
])
def test_the_rows_name_comes_from_its_sides(sides, label):
    assert cc_svc.sides_label(sides) == label


def test_unknown_sides_are_dropped_not_stored(db):
    lead = _lead(db)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(color_plan=[
        {"sides": ["Inside Front", "The pool bit", "Outside Back"], "status": "confirmed",
         "colors": ["October Brown"]},
    ]), user=USER)
    assert r["job"]["color_plan"][0]["sides"] == ["Inside Front", "Outside Back"]


def test_a_side_belongs_to_one_row(db):
    """Insides brown, outsides the HOA colour: a side cannot be both. The
    first row to claim it keeps it."""
    lead = _lead(db)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(color_plan=[
        {"sides": ["Inside Front", "Inside Back"], "status": "confirmed", "colors": ["October Brown"]},
        {"sides": ["Inside Back", "Outside Front"], "status": "confirmed", "colors": ["Cedar Naturaltone"]},
    ]), user=USER)
    plan = r["job"]["color_plan"]
    assert plan[0]["sides"] == ["Inside Front", "Inside Back"]
    assert plan[1]["sides"] == ["Outside Front"]


def test_a_row_written_before_the_sides_map_keeps_its_name(db):
    """Old rows only had free text. They carry on until somebody picks sides."""
    lead = _lead(db)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(color_plan=[
        {"area": "Front gates", "status": "confirmed", "colors": ["Classic Mahogany"]},
    ]), user=USER)
    row = r["job"]["color_plan"][0]
    assert row["area"] == "Front gates"
    assert row["sides"] == []


def test_leaning_a_direction_reaches_the_cleaner(db):
    """"Haven't chosen, but something in the browns" is a real answer and the
    cleaner should arrive knowing it."""
    lead = _lead(db)
    cc.update_company_cam(lead.id, cc.CompanyCamPatch(color_plan=[
        {"sides": ["Inside Front", "Inside Left", "Inside Back", "Inside Right"],
         "status": "not_chosen", "colors": [], "leaning": "browns, nothing reddish"},
    ]), user=USER)
    actions = cc.get_company_cam(lead.id, user=USER)["cleaner_actions"]
    assert "All insides: no colour chosen — they're leaning towards browns, nothing reddish" in " ".join(actions)


def test_leaning_is_only_kept_while_no_colour_is_chosen(db):
    lead = _lead(db)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(color_plan=[
        {"sides": ["Inside Front"], "status": "confirmed", "colors": ["Pine Bark"],
         "leaning": "browns"},
    ]), user=USER)
    assert r["job"]["color_plan"][0]["leaning"] == ""


def test_colour_chips_are_inventory_stains_with_brand_and_opacity(db):
    """A colour name alone is never enough (Alan, 2026-10-15): each chip is
    colour · brand · opacity, straight from Stain Inventory, active only."""
    from database import StainInventoryItem
    db.add(StainInventoryItem(id="s1", brand="Valspar", finish_type="solid", color_name="Chocolate Chip", gallons=5, active=True))
    db.add(StainInventoryItem(id="s2", brand="Valspar", finish_type="semi_transparent", color_name="Chocolate Chip", gallons=0, active=True))
    db.add(StainInventoryItem(id="s3", brand="Cabot", color_name="Retired Red", gallons=0, active=False))
    db.commit()
    lead = _lead(db)
    opts = cc.get_company_cam(lead.id, user=USER)["color_options"]
    assert opts == ["Chocolate Chip · Valspar · Semi-transparent", "Chocolate Chip · Valspar · Solid"]


def test_one_stain_on_every_side_fills_the_colour_plan(db):
    import json
    from database import StainInventoryItem
    db.add(StainInventoryItem(id="ob", brand="Valspar", finish_type="solid", color_name="October Brown", gallons=13.5, active=True))
    db.commit()
    lead = _lead(db, form_data=json.dumps({"fence_sides": ["Inside Front", "Inside Back"]}))
    cc.get_company_cam(lead.id, user=USER)
    cc.update_company_cam(lead.id, cc.CompanyCamPatch(final_stain_id="ob"), user=USER)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(color_all_sides="yes"), user=USER)
    plan = r["job"]["color_plan"]
    assert len(plan) == 1 and plan[0]["status"] == "confirmed" and plan[0]["colors"] == ["October Brown · Valspar · Solid"]
    assert sorted(plan[0]["sides"]) == ["Inside Back", "Inside Front"]
    assert r["job"]["color_all_sides"] == "yes"


def test_the_colour_map_knows_which_sides_were_bought(db):
    """The estimator's sides, so the map can light them up."""
    import json
    lead = _lead(db, form_data=json.dumps({"fence_sides": ["Inside Front", "Inside Back", "bogus"]}))
    assert cc.get_company_cam(lead.id, user=USER)["estimate_sides"] == ["Inside Front", "Inside Back"]


def test_bought_sides_fall_back_to_the_sent_estimate(db):
    import json
    lead = _lead(db)
    _estimate(db, lead)
    est = db.query(Estimate).filter(Estimate.lead_id == lead.id).first()
    est.inputs = json.dumps({"linear_feet": 159, "fence_height": "7ft",
                             "fence_sides": "Outside Front, Outside Left"})
    db.commit()
    assert cc.get_company_cam(lead.id, user=USER)["estimate_sides"] == ["Outside Front", "Outside Left"]


# --- money ---

def test_final_price_is_stored_as_cents_and_never_sent_to_the_screen(db):
    """Money is integer cents — Numeric degrades to float on SQLite. The crew
    works from this screen, so the price isn't in what it loads (Alan,
    2026-10-15)."""
    lead = _lead(db)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(final_price=1831.57), user=USER)
    assert "final_price" not in r["job"]
    assert "final_price" not in cc.get_company_cam(lead.id, user=USER)["job"]
    row = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead.id).first()
    assert row.final_price_cents == 183157


# --- what actually happened ---

def test_actuals_are_kept_apart_from_the_estimates(db):
    """The gap between them is the number worth having."""
    lead = _lead(db)
    _estimate(db, lead, sqft=1113)
    cc.get_company_cam(lead.id, user=USER)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(
        actual_sqft=1260, stain_gallons_used=8, stain_gallons_bought=3,
        bleach_gallons_used=2.5, final_color="Canyon Brown",
    ), user=USER)
    j = r["job"]
    assert j["sqft"] == 1113 and j["actual_sqft"] == 1260
    assert j["gallons_needed"] == 7.0 and j["stain_gallons_used"] == 8
    assert j["stain_gallons_bought"] == 3 and j["bleach_gallons_used"] == 2.5
    assert j["final_color"] == "Canyon Brown"


def test_negative_actuals_are_clamped(db):
    lead = _lead(db)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(
        actual_sqft=-5, stain_gallons_used=-1), user=USER)
    assert r["job"]["actual_sqft"] == 0
    assert r["job"]["stain_gallons_used"] == 0


# --- checklists ---

def test_checklists_accept_only_known_items(db):
    """A stale client must not be able to store junk as a completed step."""
    lead = _lead(db)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(
        cleaner_checklist=["rocks_pulled", "made_it_up"],
        stainer_checklist=["two_coats", "rocks_pulled"],
    ), user=USER)
    assert r["job"]["cleaner_checklist"] == ["rocks_pulled"]
    # rocks_pulled is a cleaner item, so it is not valid on the stainer list.
    assert r["job"]["stainer_checklist"] == ["two_coats"]


def test_both_checklists_are_offered_with_their_items(db):
    lead = _lead(db)
    out = cc.get_company_cam(lead.id, user=USER)
    cleaner = {i["key"] for i in out["cleaner_checklist"]}
    stainer = {i["key"] for i in out["stainer_checklist"]}
    assert {"rocks_pulled", "plants_watered", "fence_rinsed", "hose_rolled"} <= cleaner
    assert {"two_coats", "hinges_clean", "under_rails", "rocks_back", "lights_back",
            "trash_picked_up", "four_walkarounds", "customer_satisfied"} <= stainer
    # The cleaner pulls the rocks away; putting them back is the stainer's job.
    assert "rocks_back" not in cleaner and "two_walkarounds" not in stainer


# --- the referral ---

def test_a_neighbour_is_captured_as_a_lead_not_as_prose(db):
    """Alan calls these. A name and a number is what makes that possible."""
    lead = _lead(db)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(
        neighbor_interested=True,
        neighbor_first_name="Dave", neighbor_last_name="Mendez",
        neighbor_phone="(713) 555-0101",
        neighbor_project="Back fence, maybe the gates",
        neighbor_notes="House to the left, grey truck. Call after 5.",
    ), user=USER)
    j = r["job"]
    assert j["neighbor_first_name"] == "Dave"
    assert j["neighbor_phone"] == "(713) 555-0101"
    assert j["neighbor_project"] == "Back fence, maybe the gates"


# --- the editable almost-done text ---

def test_the_crew_can_edit_the_text_before_it_sends(db, monkeypatch):
    sent = {}
    from services import ghl
    monkeypatch.setattr(ghl, "send_sms", lambda cid, msg, **k: sent.update(msg=msg) or True)

    lead = _lead(db, name="Michele Horton")
    cc.send_almost_done(lead.id, body=cc.AlmostDoneBody(
        message="Hi Michele, finishing up in about 20 minutes — come take a look!"),
        user=USER)
    assert sent["msg"] == "Hi Michele, finishing up in about 20 minutes — come take a look!"


def test_an_empty_edit_falls_back_to_the_preset(db, monkeypatch):
    sent = {}
    from services import ghl
    monkeypatch.setattr(ghl, "send_sms", lambda cid, msg, **k: sent.update(msg=msg) or True)

    lead = _lead(db, name="Michele Horton")
    cc.send_almost_done(lead.id, body=cc.AlmostDoneBody(message="   "), user=USER)
    assert sent["msg"].startswith("Hey Michele,")


def test_the_preset_is_offered_with_the_customers_name(db):
    lead = _lead(db, name="Michele Horton")
    out = cc.get_company_cam(lead.id, user=USER)
    assert out["almost_done_default"].startswith("Hey Michele,")


def test_the_job_box_pulls_fence_age_and_package_and_learns_coverage(db):
    import json
    from database import PayLink
    lead = _lead(db, form_data=json.dumps({"fence_age": "1-6 years"}))
    est = _estimate(db, lead, sqft=1288)
    est.inputs = json.dumps({**json.loads(est.inputs), "fence_age": "6-15 years"})
    db.add(PayLink(token="t" * 27, lead_id=lead.id, kind="deposit", amount_cents=25000, status="paid", job_tier="signature", created_at="2026-10-03"))
    db.commit()
    out = cc.get_company_cam(lead.id, user=USER)
    assert out["fence_age"] == "6-15 years"  # the priced estimate wins over the form
    assert out["job"]["package"] == "signature"
    assert out["coverage"]["all_jobs"] == 0
    assert [o["sqft"] for o in out["estimate_options"]] == [1288]
    cc.update_company_cam(lead.id, cc.CompanyCamPatch(sqft=1288, stain_gallons_used=8), user=USER)
    other = _lead(db, ghl_contact_id="ghl-other", form_data=json.dumps({"fence_age": "brand new"}))
    cc.get_company_cam(other.id, user=USER)
    cc.update_company_cam(other.id, cc.CompanyCamPatch(sqft=1000, stain_gallons_used=4), user=USER)
    cov = cc.get_company_cam(lead.id, user=USER)["coverage"]
    assert cov["all_jobs"] == 2 and cov["all_avg"] == round((161 + 250) / 2)
    assert cov["age_jobs"] == 1 and cov["age_avg"] == 161


def test_any_photo_we_hold_can_be_dropped_into_a_section(db):
    from database import LeadMeasurement
    lead = _lead(db)
    lead.fence_scope_export_image = b"PNGDATA"
    lead.has_fence_scope_export = True
    lead.fence_scope_export_mime = "image/png"
    db.add(LeadMeasurement(id="m1", lead_id=lead.id, seq=1, image_data=b"SAT", has_image=True, mime="image/png"))
    db.commit()
    lib = cc.photo_library(lead.id, user=USER)
    keys = [i["key"] for i in lib]
    assert "scope:export" in keys and "meas:m1" in keys
    p = cc.photo_from_library(lead.id, cc.FromLibraryBody(key="meas:m1", section="fence_scope"), user=USER)
    assert p["note"].startswith("Measure & capture")
    with pytest.raises(HTTPException):
        cc.photo_from_library(lead.id, cc.FromLibraryBody(key="meas:nope", section="fence_scope"), user=USER)


def test_everything_the_crew_fills_in_saves_and_comes_back(db):
    """Alan, 2026-10-15: make sure all of it saves. Each field the crew can
    touch, written once, then read back from a fresh load."""
    from services.company_cam import CLEANER_CHECKLIST, STAINER_CHECKLIST
    lead = _lead(db)
    cc.get_company_cam(lead.id, user=USER)
    up = upsell_options()[0]["key"]
    patch = cc.CompanyCamPatch(
        scope_explanation="Inside sides only", cleaning_notes="Dog in the yard", staining_notes="Two coats on the gate",
        cleaner_checklist=[CLEANER_CHECKLIST[0]["key"]], stainer_checklist=[STAINER_CHECKLIST[0]["key"]],
        upsells=[up], upsell_notes="Wants the driveway done", package="signature", sqft=1288,
        stain_gallons_used=8, stain_gallons_bought=2, bleach_gallons_used=3, bleach_gallons_to_bring=4,
    )
    cc.update_company_cam(lead.id, patch, user=USER)
    job = cc.get_company_cam(lead.id, user=USER)["job"]
    assert job["scope_explanation"] == "Inside sides only" and job["cleaning_notes"] == "Dog in the yard"
    assert job["staining_notes"] == "Two coats on the gate" and job["upsell_notes"] == "Wants the driveway done"
    assert job["cleaner_checklist"] == [CLEANER_CHECKLIST[0]["key"]] and job["stainer_checklist"] == [STAINER_CHECKLIST[0]["key"]]
    assert job["upsells"] == [up] and job["package"] == "signature" and job["sqft"] == 1288
    assert job["stain_gallons_used"] == 8 and job["stain_gallons_bought"] == 2 and job["bleach_gallons_used"] == 3
    assert job["bleach_gallons_to_bring"] == 4
    assert job["gallons_needed"] == 8  # 1288 / 165, rounded up, follows the footage


def test_footage_choices_include_unsent_estimates_and_measure_and_capture(db):
    import json
    from database import LeadMeasurement
    lead = _lead(db)
    _estimate(db, lead, linear_feet=360, height="7ft")
    draft = _estimate(db, lead, linear_feet=529, height="6ft standard")
    draft.status, draft.sent_at, draft.created_at = "pending", None, "2026-10-15T20:00:00Z"
    draft.inputs = json.dumps({"linear_feet": 529, "fence_height": "6ft standard"})
    db.add(LeadMeasurement(id="m9", lead_id=lead.id, seq=1, linear_feet=529, has_image=True))
    db.commit()
    out = cc.get_company_cam(lead.id, user=USER)
    opts = out["estimate_options"]
    assert [(o["sqft"], o["sent"]) for o in opts] == [(3174, False), (2520, True)]  # newest first
    assert out["measure_options"]["captures"][0]["linear_feet"] == 529
    assert out["measure_options"]["height_ft"] == 6.0


def test_the_coverage_file_groups_by_stain_wood_age_and_prior_stain(db):
    import json
    from database import StainInventoryItem
    db.add(StainInventoryItem(id="ob", brand="Valspar", finish_type="solid", color_name="October Brown", gallons=13.5, active=True))
    db.commit()
    yogi = _lead(db, form_data=json.dumps({"fence_age": "6-15 years", "previously_stained": "No"}))
    other = _lead(db, ghl_contact_id="ghl-2", form_data=json.dumps({"fence_age": "6-15 years", "previously_stained": "No"}))
    loose = _lead(db, ghl_contact_id="ghl-3", form_data=json.dumps({"fence_age": "1-6 years"}))
    for lead, sqft, gal in ((yogi, 3439, 20), (other, 1000, 5), (loose, 900, 4)):
        cc.get_company_cam(lead.id, user=USER)
        cc.update_company_cam(lead.id, cc.CompanyCamPatch(sqft=sqft, stain_gallons_used=gal), user=USER)
    for lead in (yogi, other):
        r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(final_stain_id="ob", wood_type="pine"), user=USER)
        assert r["job"]["final_color"] == "October Brown · Valspar · Solid"
    cc.update_company_cam(yogi.id, cc.CompanyCamPatch(previously_stained="no"), user=USER)
    with pytest.raises(HTTPException):
        cc.update_company_cam(yogi.id, cc.CompanyCamPatch(final_stain_id="nope"), user=USER)
    with pytest.raises(HTTPException):
        cc.update_company_cam(yogi.id, cc.CompanyCamPatch(wood_type="oak"), user=USER)
    f = cc.stain_coverage(user=USER)
    assert len(f["rows"]) == 1
    row = f["rows"][0]
    assert row["stain"] == "October Brown · Valspar · Solid" and row["wood_type"] == "pine"
    assert row["fence_age"] == "6-15 years" and row["previously_stained"] == "no"
    assert len(row["jobs"]) == 2 and row["gallons"] == 25 and row["sqft"] == 4439
    assert row["sqft_per_gallon"] == round(4439 / 25)  # weighted by job size
    assert [m["name"] for m in f["missing_stain"]] == ["Test Customer"] and f["missing_stain"][0]["sqft"] == 900
    page = cc.get_company_cam(yogi.id, user=USER)
    assert page["customer_previously_stained"] == "No"
    assert page["coverage"]["match_jobs"] == 2
    assert any(o["id"] == "ob" for o in page["stain_options"])


def test_almost_done_is_marked_walked_or_texted_without_sending(db):
    lead = _lead(db, name="Yogi Patel")
    out = cc.get_company_cam(lead.id, user=USER)
    assert out["almost_done_default"].startswith("Hey Yogi, this is the crew from Sterling Fence Staining")
    r = cc.mark_almost_done(lead.id, cc.AlmostDoneMarkBody(how="walked"), user=USER)
    assert r["job"]["almost_done_how"] == "walked" and r["job"]["almost_done_sent_at"]
    cc.reset_almost_done(lead.id, user=USER)
    r = cc.mark_almost_done(lead.id, cc.AlmostDoneMarkBody(how="texted"), user=USER)
    assert r["job"]["almost_done_how"] == "texted"
    with pytest.raises(HTTPException):
        cc.mark_almost_done(lead.id, cc.AlmostDoneMarkBody(how="ghl"), user=USER)


def test_repairs_and_the_crew_note_save_and_the_cleaner_marks_the_pickets(db):
    lead = _lead(db)
    cc.get_company_cam(lead.id, user=USER)
    job = cc.get_company_cam(lead.id, user=USER)["job"]
    assert job["repairs"]["counts"]["pickets"] == 0 and job["repair_notes"] == ""
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(
        repairs={"counts": {"pickets": 15, "bogus": 3}, "picket_type": "pine", "post_type": "nope"},
        repair_notes="A 2x4 needs screwing in on the back"), user=USER)
    assert r["job"]["repairs"] == {"counts": {"pickets": 15, "rotboard": 0, "cap": 0, "rail": 0, "posts": 0},
                                   "picket_type": "pine", "post_type": "post6"}
    assert r["job"]["repair_notes"] == "A 2x4 needs screwing in on the back"
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(pickets_marked=True), user=USER)
    assert r["job"]["pickets_marked_at"] and r["job"]["pickets_marked_by"]
    with pytest.raises(HTTPException):
        cc.update_company_cam(lead.id, cc.CompanyCamPatch(repairs={"counts": {"pickets": -1}}), user=USER)


def test_extras_agreed_on_site_are_confirmed_priced_and_alan_is_told(db, monkeypatch):
    told = []
    monkeypatch.setattr("services.after_pay_hooks.alert_alan", lambda m: told.append(m))
    lead = _lead(db, name="Yogi Patel")
    cc.get_company_cam(lead.id, user=USER)
    with pytest.raises(HTTPException):
        cc.update_company_cam(lead.id, cc.CompanyCamPatch(extras_confirmed=True), user=USER)
    cc.update_company_cam(lead.id, cc.CompanyCamPatch(extras={"counts": {"pickets": 5}, "picket_type": "pine"}), user=USER)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(extras_confirmed=True), user=USER)
    assert r["job"]["extras_confirmed_at"] and r["job"]["extras"]["counts"]["pickets"] == 5
    assert len(told) == 1 and "5 × Picket replacement (Pine) @ $12" in told[0] and "$60" in told[0]
    from services.company_cam import site_extras
    from database import CompanyCamJob
    job = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead.id).first()
    assert site_extras(job)["total_cents"] == 6000
    from api import stripe_pay as sp
    assert sp.list_pay_links(lead.id, user=USER)["site_extras"] == [{"name": "Picket replacement (Pine)", "qty": 5, "unit_price": 12.0}]
    # Changing the count needs the customer's yes again.
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(extras={"counts": {"pickets": 6}, "picket_type": "pine"}), user=USER)
    assert r["job"]["extras_confirmed_at"] == ""


def test_the_crew_list_needs_the_company_cam_permission(db, monkeypatch):
    from database import User
    from api import permissions as perms
    monkeypatch.setattr(perms, "get_db", lambda: db)
    db.close = lambda: None
    db.add(User(id="w1", username="ChrisMoran", display_name="Chris Moran", password_hash="x", role="worker",
                permissions='{"company_cam": false}', created_at=""))
    db.commit()
    lead = _lead(db, name="Yogi Patel", address="2619 Lazy Vine Ln")
    crew = {"sub": "ChrisMoran", "role": "worker", "perms": []}
    with pytest.raises(HTTPException):
        cc.company_cam_jobs(user=crew)
    u = db.query(User).filter(User.id == "w1").first()
    u.permissions = '{"company_cam": true}'
    db.commit()
    # Not on the job yet: nothing in his list, even searching, and the job won't open.
    assert cc.company_cam_jobs(q="lazy vine", user=crew) == []
    monkeypatch.setattr(cc, "get_db", lambda: db)
    with pytest.raises(HTTPException):
        cc.crew_guard(lead.id, user=crew)
    other = _lead(db, ghl_contact_id="ghl-9", name="Someone Else")
    cc.get_company_cam(other.id, user=USER)
    cc.get_company_cam(lead.id, user=USER)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(crew=[{"username": "chrismoran", "date": "2026-10-16", "task": "cleaning"}, "nobody"]), user=USER)
    assert r["job"]["crew"] == [{"username": "ChrisMoran", "date": "2026-10-16", "task": "cleaning"}]
    rows = cc.company_cam_jobs(user=crew)
    assert [x["lead_id"] for x in rows] == [lead.id] and rows[0]["name"] == "Yogi Patel"
    assert rows[0]["date"] == "2026-10-16" and rows[0]["task"] == "cleaning"
    with pytest.raises(HTTPException):
        cc.update_company_cam(lead.id, cc.CompanyCamPatch(crew=[{"username": "ChrisMoran", "date": "Friday"}]), user=USER)
    assert cc.company_cam_jobs(q="someone", user=crew) == []
    assert cc.crew_guard(lead.id, user=crew) == crew
    with pytest.raises(HTTPException):
        cc.crew_guard(other.id, user=crew)
    with pytest.raises(HTTPException):
        cc.update_company_cam(lead.id, cc.CompanyCamPatch(crew=[]), user=crew)
    assert "price" not in str(rows).lower()


def test_the_office_changes_the_sides_from_company_cam(db):
    import json
    lead = _lead(db, form_data=json.dumps({"fence_sides": ["Inside Front", "Outside Front"], "fence_age": "6-15 years"}))
    cc.get_company_cam(lead.id, user=USER)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(fence_sides=["Inside Front", "Outside Front", "Outside Left", "bogus"]), user=USER)
    assert r["estimate_sides"] == ["Inside Front", "Outside Front", "Outside Left"]
    db.refresh(lead)
    fd = json.loads(lead.form_data)
    assert fd["fence_sides"] == ["Inside Front", "Outside Front", "Outside Left"] and fd["fence_age"] == "6-15 years"


def test_a_solid_stain_divides_by_175_the_rest_by_165(db):
    from database import StainInventoryItem
    db.add(StainInventoryItem(id="ob", brand="Valspar", finish_type="solid", color_name="October Brown", gallons=13.5, active=True))
    db.add(StainInventoryItem(id="cn", brand="Valspar", finish_type="semi_transparent", color_name="Cedar Natural Tone", gallons=4, active=True))
    db.commit()
    lead = _lead(db)
    cc.get_company_cam(lead.id, user=USER)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(sqft=3439), user=USER)
    assert r["job"]["gallons_needed"] == gallons_for(3439) and r["job"]["sqft_per_gallon"] == 165
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(final_stain_id="ob"), user=USER)
    assert r["job"]["sqft_per_gallon"] == 175 and r["job"]["gallons_needed"] == gallons_for(3439, 175)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(final_stain_id="cn"), user=USER)
    assert r["job"]["sqft_per_gallon"] == 165 and r["job"]["gallons_needed"] == gallons_for(3439)


def test_a_neighbour_or_friend_reaches_alan_with_or_without_details(db, monkeypatch):
    told = []
    monkeypatch.setattr("services.after_pay_hooks.alert_alan", lambda m: told.append(m))
    lead = _lead(db, name="Yogi Patel")
    cc.get_company_cam(lead.id, user=USER)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(neighbor_status="no_details"), user=USER)
    assert r["job"]["neighbor_status"] == "no_details" and r["job"]["neighbor_interested"] is True
    assert len(told) == 1 and "didn't get their info" in told[0] and "Yogi Patel" in told[0]
    with pytest.raises(HTTPException):
        cc.update_company_cam(lead.id, cc.CompanyCamPatch(neighbor_send=True), user=USER)
    cc.update_company_cam(lead.id, cc.CompanyCamPatch(neighbor_first_name="Angie", neighbor_phone="(713) 555-0199", neighbor_project="back fence"), user=USER)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(neighbor_send=True), user=USER)
    assert r["job"]["neighbor_status"] == "details" and r["job"]["neighbor_sent_at"]
    assert "Angie" in told[-1] and "back fence" in told[-1] and "Referrals" in told[-1]
    from database import ReferralClaim, Lead
    claim = db.query(ReferralClaim).filter(ReferralClaim.referrer_lead_id == lead.id).first()
    assert claim and db.query(Lead).filter(Lead.id == claim.lead_id).first().lead_source == "referral"


def test_job_done_stamps_once_and_tells_alan(db, monkeypatch):
    """The crew's last tap: ticks Job done on the journey and alerts Alan,
    once — a second tap neither restamps nor re-texts him."""
    from services import after_pay_hooks
    sent = []
    monkeypatch.setattr(after_pay_hooks, "alert_alan", lambda m: sent.append(m))
    lead = _lead(db)
    r = cc.mark_job_done(lead.id, user=USER)
    first = r["job"]["completed_at"]
    assert first and r["job"]["completed_by"]
    assert len(sent) == 1 and "invoice" in sent[0]
    r = cc.mark_job_done(lead.id, user=USER)
    assert r["job"]["completed_at"] == first and len(sent) == 1
    assert cc.reset_job_done(lead.id, user=USER)["job"]["completed_at"] == ""


def test_journey_reads_booking_photos_done_and_stripe_invoice(db, monkeypatch):
    """The lead page's job steps come from where the work happens now, not
    the old scheduled_jobs row (none of the October jobs have one)."""
    from services import after_pay_hooks
    from database import Booking, PayLink
    from api import leads as leads_api
    monkeypatch.setattr(after_pay_hooks, "alert_alan", lambda m: None)
    lead = _lead(db)
    db.add(Booking(token="b" + uuid.uuid4().hex, lead_id=lead.id, date="2026-10-20", tier="signature",
                   total_cents=150000, status="held", created_at="2026-10-10T00:00:00Z",
                   sent_at="2026-10-10T00:00:00Z"))
    db.add(CompanyCamPhoto(id=str(uuid.uuid4()), lead_id=lead.id, section="clean_before",
                           uploaded_at="2026-10-20T14:00:00Z"))
    db.commit()
    jp = leads_api.get_lead(lead.id)["job_progress"]
    assert jp["booking_date"] == "2026-10-20" and not jp["reserved"]
    assert jp["started_at"] == "2026-10-20T14:00:00Z"
    assert not jp["completed_at"] and not jp["invoiced"]

    cc.mark_job_done(lead.id, user=USER)
    db.add(PayLink(token="p" + uuid.uuid4().hex, lead_id=lead.id, kind="deposit", amount_cents=25000, status="paid"))
    db.add(PayLink(token="p" + uuid.uuid4().hex, lead_id=lead.id, kind="balance", amount_cents=125000, status="open"))
    db.commit()
    jp = leads_api.get_lead(lead.id)["job_progress"]
    assert jp["reserved"] and jp["completed_at"] and jp["invoiced"] and not jp["invoice_paid"]


def test_a_note_says_who_wrote_it(db):
    """Alan, 2026-10-17: when a crew member leaves a note on a photo, the
    office sees whose note it is, even when someone else took the photo."""
    import asyncio

    class _F:
        content_type = "image/jpeg"
        async def read(self): return b"JPEGDATA"

    lead = _lead(db)
    shot = asyncio.run(cc.upload_photo(lead.id, file=_F(), section="stain_after",
                                       side="", note="", is_damage=False, user={"sub": "chris", "name": "Chris Moran", "role": "worker"}))
    assert shot["note_by"] == ""
    jose = {"sub": "jose", "name": "Jose Arthur", "role": "worker"}
    out = cc.update_photo(lead.id, shot["id"], cc.PhotoPatch(note="Two pickets loose on the back"), user=jose)
    assert out["note"] == "Two pickets loose on the back"
    assert out["note_by"] == "Jose Arthur" and out["note_at"]
    assert out["uploaded_by"] == "Chris Moran"
    # Clearing the note clears whose it was.
    out = cc.update_photo(lead.id, shot["id"], cc.PhotoPatch(note=""), user=jose)
    assert out["note"] == "" and out["note_by"] == ""


def test_crew_pay_is_set_by_the_office_and_each_worker_sees_only_their_own(db, monkeypatch):
    # Alan (2026-10-17): "for that one I just told him $100", shown next to
    # the job on Brent's schedule, and nobody else's.
    from database import User
    from api import permissions as perms
    monkeypatch.setattr(perms, "get_db", lambda: db)
    monkeypatch.setattr(cc, "get_db", lambda: db)
    db.close = lambda: None
    for uid, name in (("w1", "BrentBrown"), ("w2", "JoseR")):
        db.add(User(id=uid, username=name, display_name=name, password_hash="x", role="worker",
                    permissions='{"company_cam": true}', created_at=""))
    db.commit()
    lead = _lead(db, name="Tayeb Diouri", address="4934 Morning Stream Dr")
    cc.get_company_cam(lead.id, user=USER)
    cc.update_company_cam(lead.id, cc.CompanyCamPatch(crew=[
        {"username": "BrentBrown", "date": "2026-10-18", "task": "staining"},
        {"username": "JoseR", "date": "2026-10-17", "task": "cleaning"}]), user=USER)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(crew_pay={"username": "brentbrown", "pay_type": "flat", "pay": 100}), user=USER)
    assert r["crew_pay"]["BrentBrown"] == {"pay_type": "flat", "pay": 100.0}
    cc.update_company_cam(lead.id, cc.CompanyCamPatch(crew_pay={"username": "JoseR", "pay_type": "hourly", "pay": 16}), user=USER)
    # The shared job never carries pay.
    assert "pay" not in str(r["job"]["crew"])
    brent = {"sub": "BrentBrown", "role": "worker", "perms": []}
    assert cc.get_company_cam(lead.id, user=brent)["crew_pay"] == {"BrentBrown": {"pay_type": "flat", "pay": 100.0}}
    row = cc.company_cam_jobs(user=brent)[0]
    assert row["pay_type"] == "flat" and row["pay"] == 100.0
    # Re-saving the crew list keeps everyone's pay.
    cc.update_company_cam(lead.id, cc.CompanyCamPatch(crew=[
        {"username": "BrentBrown", "date": "2026-10-19", "task": "staining"},
        {"username": "JoseR", "date": "2026-10-17", "task": "cleaning"}]), user=USER)
    assert cc.get_company_cam(lead.id, user=USER)["crew_pay"]["JoseR"] == {"pay_type": "hourly", "pay": 16.0}
    # The crew can't set pay, and pay needs them on the job.
    with pytest.raises(HTTPException):
        cc.update_company_cam(lead.id, cc.CompanyCamPatch(crew_pay={"username": "BrentBrown", "pay_type": "flat", "pay": 900}), user=brent)
    with pytest.raises(HTTPException):
        cc.update_company_cam(lead.id, cc.CompanyCamPatch(crew_pay={"username": "Nobody", "pay_type": "flat", "pay": 5}), user=USER)
