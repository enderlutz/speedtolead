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

USER = {"sub": "alanbonner", "name": "Alan"}


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


def test_colour_chips_start_with_what_is_on_the_shelf(db):
    """Inventory first, then the usual list, one chip per colour whatever the
    capitalisation."""
    from database import StainInventoryItem
    db.add(StainInventoryItem(id="s1", brand="Ready Seal", color_name="pine bark",
                              gallons=5, active=True))
    db.add(StainInventoryItem(id="s2", brand="Cabot", color_name="Bleached Oak",
                              gallons=2, active=True))
    db.add(StainInventoryItem(id="s3", brand="Cabot", color_name="Retired Red",
                              gallons=0, active=False))
    db.commit()
    lead = _lead(db)
    opts = cc.get_company_cam(lead.id, user=USER)["color_options"]
    assert opts[:2] == ["Bleached Oak", "pine bark"]
    assert "Pine Bark" not in opts          # the shelf's spelling wins
    assert "Retired Red" not in opts        # inactive stays off the screen
    assert "October Brown" in opts          # the usual list follows


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

def test_final_price_is_stored_as_cents(db):
    """Money is integer cents — Numeric degrades to float on SQLite."""
    lead = _lead(db)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(final_price=1831.57), user=USER)
    assert r["job"]["final_price"] == 1831.57
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
        cleaner_checklist=["rocks_back", "made_it_up"],
        stainer_checklist=["two_coats", "rocks_back"],
    ), user=USER)
    assert r["job"]["cleaner_checklist"] == ["rocks_back"]
    # rocks_back is a cleaner item, so it is not valid on the stainer list.
    assert r["job"]["stainer_checklist"] == ["two_coats"]


def test_both_checklists_are_offered_with_their_items(db):
    lead = _lead(db)
    out = cc.get_company_cam(lead.id, user=USER)
    cleaner = {i["key"] for i in out["cleaner_checklist"]}
    stainer = {i["key"] for i in out["stainer_checklist"]}
    assert {"rocks_back", "plants_watered", "fence_rinsed", "hose_rolled"} <= cleaner
    assert {"two_coats", "hinges_clean", "under_rails",
            "two_walkarounds", "customer_satisfied"} <= stainer


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
