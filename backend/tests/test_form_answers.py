"""The customer's form answers reach the lead by name, not by GHL's field id.

Alan added "Repairs?" and "sides?" to the ad form on 2026-10-06. Their
answers came back from GHL as {id, value} with no name, were stored under
the raw id, and the lead page never showed them. Kayode Fakunle's "yes"
for sides was dropped outright: the value guesser took it for a second
previously-stained answer (2026-10-09).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from database import GhlFieldMapping  # noqa: E402
from services import form_answers as fa  # noqa: E402
from services.ghl import parse_webhook_payload  # noqa: E402

REPAIRS = "P5hpKBzBuNhdrNOSCQnY"
SIDES = "cuZxV9j226oKsg0ONWrM"
STAINED = "XVXq5qWcSiagRFIVjL4o"
LOC = "SuEQHXcGVGUP00p6r6ME"
YES_REPAIRS = "Yes — some boards, posts or a gate need attention"


@pytest.fixture(autouse=True)
def fresh_cache():
    fa.invalidate_field_mapping_cache()
    fa._learned_at.clear()
    yield
    fa.invalidate_field_mapping_cache()
    fa._learned_at.clear()


def _rows(db, *rows):
    for fid, key, name, our in rows:
        db.add(GhlFieldMapping(ghl_field_id=fid, ghl_field_key=key, ghl_field_name=name,
                               our_field_name=our, created_at="2026-10-09T00:00:00+00:00"))
    db.commit()


def test_named_by_ghl_key(db):
    _rows(db, (REPAIRS, "contact.repairs", "Repairs?", None),
          (SIDES, "contact.sides", "sides?", None),
          (STAINED, "contact.previously_stained", "Previously Stained", "previously_stained"))
    out = fa.resolve_custom_fields([
        {"id": STAINED, "value": "No"},
        {"id": REPAIRS, "value": "No, just staining"},
        {"id": SIDES, "value": "yes"},
    ], LOC)
    assert out == {"previously_stained": "No", "repairs": "No, just staining", "sides_wanted": "yes"}


def test_sides_yes_is_not_previously_stained(db):
    _rows(db, (SIDES, "contact.sides", "sides?", None))
    assert fa.resolve_custom_fields([{"id": SIDES, "value": "yes"}], LOC) == {"sides_wanted": "yes"}


def test_settings_mapping_beats_key_default(db):
    _rows(db, (SIDES, "contact.sides", "sides?", "additional_notes"))
    assert fa.resolve_custom_fields([{"id": SIDES, "value": "inside"}], LOC) == {"additional_notes": "inside"}


def test_unknown_field_is_learned_from_ghl_once(db, monkeypatch):
    calls: list[str] = []

    def fake(location_id):
        calls.append(location_id)
        return [
            {"id": REPAIRS, "fieldKey": "contact.repairs", "name": "Repairs?"},
            {"id": SIDES, "fieldKey": "contact.sides", "name": "sides?"},
        ]

    monkeypatch.setattr("services.ghl.get_custom_fields", fake)
    out = fa.resolve_custom_fields([{"id": REPAIRS, "value": YES_REPAIRS}], LOC)
    assert out == {"repairs": YES_REPAIRS}
    assert calls == [LOC]
    # Remembered for Settings, mapping left to the admin.
    row = db.query(GhlFieldMapping).filter(GhlFieldMapping.ghl_field_id == SIDES).first()
    assert row is not None and row.ghl_field_key == "contact.sides" and row.our_field_name is None
    # A field GHL doesn't know either: no second fetch within the hour, and
    # the old guess from the value still applies.
    out = fa.resolve_custom_fields([{"id": "z" * 20, "value": "7ft"}], LOC)
    assert out == {"fence_height": "7ft"}
    assert calls == [LOC]


def test_value_guess_still_covers_unnamed_fields(db, monkeypatch):
    monkeypatch.setattr("services.ghl.get_custom_fields", lambda loc: [])
    out = fa.resolve_custom_fields([
        {"id": "a" * 20, "value": "6ft (standard)"},
        {"id": "b" * 20, "value": "Yes"},
        {"id": "c" * 20, "value": "This month"},
    ], LOC)
    assert out == {"fence_height": "6ft (standard)", "previously_stained": "Yes", "service_timeline": "This month"}


def test_merge_keeps_estimator_edits_and_drops_raw_ids(db):
    _rows(db, (REPAIRS, "contact.repairs", "Repairs?", None),
          (SIDES, "contact.sides", "sides?", None),
          (STAINED, "contact.previously_stained", "Previously Stained", "previously_stained"))
    fd = {"fence_height": "7ft", "previously_stained": "No",
          REPAIRS: "No, just staining", "fence_sides": ["Inside Front"]}
    raw = [
        {"id": STAINED, "value": "Yes"},
        {"id": REPAIRS, "value": "No, just staining"},
        {"id": SIDES, "value": "Inside facing and gate outside"},
    ]
    # The mirror: customer-only answers, nothing the estimator typed.
    assert fa.merge_answers(fd, raw, LOC, only=fa.CUSTOMER_ONLY) is True
    assert fd == {
        "fence_height": "7ft", "previously_stained": "No",
        "repairs": "No, just staining", "sides_wanted": "Inside facing and gate outside",
        "fence_sides": ["Inside Front"],
    }
    assert fa.merge_answers(fd, raw, LOC, only=fa.CUSTOMER_ONLY) is False
    # The poller's full refresh takes GHL's value for the mapped fields too.
    assert fa.merge_answers(fd, raw, LOC) is True
    assert fd["previously_stained"] == "Yes"


def test_webhook_names_the_two_questions():
    parsed = parse_webhook_payload({"contact_id": "c1", "customFields": [
        {"key": "Repairs?", "value": "No, just staining"},
        {"key": "sides?", "value": "both"},
        {"key": "fence_sides", "value": "Inside Front"},
        {"key": "contact.timeframe", "value": "This month"},
    ]})
    fd = parsed["form_data"]
    assert fd["repairs"] == "No, just staining"
    assert fd["sides_wanted"] == "both"
    assert fd["fence_sides"] == "Inside Front"
    assert fd["service_timeline"] == "This month"
