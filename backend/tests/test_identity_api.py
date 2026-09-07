"""The HTTP contract a future dictation pipeline will consume.

Pinned now, while it's cheap to change, because the pipeline will be written
against whatever this returns.
"""
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

import clock  # noqa: E402
from api import identity as api_identity  # noqa: E402

ADMIN = {"sub": "alanbonner", "name": "Alan", "role": "admin"}


def _lead(db, name, address="", phone="", aliases=()):
    from database import Lead
    lead = Lead(id=str(uuid.uuid4()), contact_name=name, address=address,
                contact_phone=phone, division="fence", status="new",
                identity_aliases=json.dumps(list(aliases)))
    db.add(lead); db.commit()
    return lead


def _employee(db, first, last="", language="en"):
    from database import Employee
    emp = Employee(id=str(uuid.uuid4()), first_name=first, last_name=last,
                   display_name=f"{first} {last}".strip(), pay_rate=0,
                   status="active", preferred_language=language)
    db.add(emp); db.commit()
    return emp


# ── Dates ─────────────────────────────────────────────────────────────

def test_resolve_day_returns_an_absolute_date_and_a_derived_weekday(db):
    r = api_identity.time_resolve_day(phrase="tomorrow", user=ADMIN)
    assert r["confident"] is True
    assert r["date"] == clock.add_days_iso(clock.today_ct_iso(), 1)
    assert r["weekday"] == clock.weekday_label(r["date"])
    assert r["date"] in r["label"] or r["weekday"] in r["label"]


def test_a_vague_phrase_returns_no_date_and_a_question(db):
    """The contract that stops a caller assuming today."""
    r = api_identity.time_resolve_day(phrase="sometime next week", user=ADMIN)
    assert r["confident"] is False
    assert r["date"] is None
    assert r["question"]


def test_a_contradictory_weekday_is_flagged_for_confirmation(db):
    """A typed weekday is a checksum, not data."""
    today = clock.today_ct_iso()
    tomorrow = clock.add_days_iso(today, 1)
    wrong = "Monday" if clock.weekday_label(tomorrow) != "Monday" else "Tuesday"
    r = api_identity.time_resolve_day(phrase=f"tomorrow, {wrong}", user=ADMIN)
    assert r["confident"] is True
    assert r["conflict"] is True
    assert r["weekday"] == clock.weekday_label(tomorrow)   # derived, not typed
    assert r["question"]


def test_time_today_reports_houston(db):
    r = api_identity.time_today(user=ADMIN)
    assert r["date"] == clock.today_ct_iso()
    assert r["timezone"] == "America/Chicago"


# ── Names ─────────────────────────────────────────────────────────────

def test_ambiguity_is_a_200_not_an_error(db):
    """A 4xx here would tempt a caller into `except: pick_first()`."""
    _employee(db, "Chris", "Boyd")
    _employee(db, "Cris", "Delgado")
    body = api_identity.ResolveBody(kind="employee", text="Chris")
    r = api_identity.resolve_name(body, user=ADMIN)     # must not raise
    assert r["status"] in ("ambiguous", "resolved")
    if r["status"] == "ambiguous":
        assert r["person"] is None
        assert r["question"]


def test_person_is_null_unless_resolved(db):
    """The single most important line of the contract."""
    _lead(db, "Micheal", "9403 Calwood Cir")
    _lead(db, "Micheal Jessop", "19802 Laguna Hills Ct")
    body = api_identity.ResolveBody(kind="customer", text="Micheal")
    r = api_identity.resolve_name(body, user=ADMIN)
    assert r["status"] == "ambiguous"
    assert r["person"] is None
    assert len(r["candidates"]) >= 2


def test_an_address_hint_resolves_it(db):
    calwood = _lead(db, "Micheal", "9403 Calwood Cir")
    _lead(db, "Micheal Jessop", "19802 Laguna Hills Ct")
    body = api_identity.ResolveBody(kind="customer", text="Micheal",
                                    address_hint="Calwood")
    r = api_identity.resolve_name(body, user=ADMIN)
    assert r["status"] == "resolved"
    assert r["person"]["id"] == calwood.id


def test_an_unknown_kind_is_rejected(db):
    body = api_identity.ResolveBody(kind="dog", text="Rex")
    with pytest.raises(HTTPException) as e:
        api_identity.resolve_name(body, user=ADMIN)
    assert e.value.status_code == 400


# ── Aliases ───────────────────────────────────────────────────────────

def test_recording_an_alias_makes_a_mangled_name_resolve(db):
    """The full loop: it can't be found, record the alias, now it can."""
    lead = _lead(db, "Nolasco", "123 Elm St")

    before = api_identity.resolve_name(
        api_identity.ResolveBody(kind="customer", text="Nalonso"), user=ADMIN)
    assert before["status"] != "resolved"

    api_identity.add_lead_alias(lead.id, api_identity.AliasBody(alias="Nalonso"), user=ADMIN)

    after = api_identity.resolve_name(
        api_identity.ResolveBody(kind="customer", text="Nalonso"), user=ADMIN)
    assert after["status"] == "resolved"
    assert after["person"]["id"] == lead.id


def test_adding_the_same_alias_twice_does_not_duplicate_it(db):
    lead = _lead(db, "Nolasco", "123 Elm St")
    api_identity.add_lead_alias(lead.id, api_identity.AliasBody(alias="Nalonso"), user=ADMIN)
    r = api_identity.add_lead_alias(lead.id, api_identity.AliasBody(alias="nalonso"), user=ADMIN)
    assert len(r["aliases"]) == 1


def test_an_empty_alias_is_rejected(db):
    lead = _lead(db, "Nolasco", "123 Elm St")
    with pytest.raises(HTTPException) as e:
        api_identity.add_lead_alias(lead.id, api_identity.AliasBody(alias="  "), user=ADMIN)
    assert e.value.status_code == 400


def test_an_alias_can_be_removed(db):
    lead = _lead(db, "Nolasco", "123 Elm St", aliases=["Nalonso"])
    r = api_identity.remove_lead_alias(lead.id, "Nalonso", user=ADMIN)
    assert r["aliases"] == []


# ── Duplicate review ──────────────────────────────────────────────────

def test_two_leads_sharing_a_phone_are_raised(db):
    _lead(db, "Dale Pawlak", "10 Main St", phone="+18325551111")
    _lead(db, "Dale Pawlack", "10 Main St", phone="(832) 555-1111")
    r = api_identity.list_duplicates(limit=50, user=ADMIN)
    assert r["count"] >= 1
    assert "phone" in r["groups"][0]["reason"]


def test_confirming_different_people_stops_the_pair_being_raised(db):
    """The two Micheals will look like duplicates to any matcher forever.

    Recording the judgment once is the durable fix.
    """
    a = _lead(db, "Micheal", "9403 Calwood Cir", phone="+18325552222")
    b = _lead(db, "Micheal Jessop", "9403 Calwood Cir", phone="+18325552222")

    before = api_identity.list_duplicates(limit=50, user=ADMIN)
    assert before["count"] == 1

    api_identity.mark_different_people(
        api_identity.DifferentPeopleBody(lead_id_a=a.id, lead_id_b=b.id,
                                         note="different households"),
        user=ADMIN)

    after = api_identity.list_duplicates(limit=50, user=ADMIN)
    assert after["count"] == 0


def test_recording_the_same_pair_twice_is_harmless(db):
    a = _lead(db, "A", "1 St", phone="+18325553333")
    b = _lead(db, "B", "1 St", phone="+18325553333")
    body = api_identity.DifferentPeopleBody(lead_id_a=a.id, lead_id_b=b.id)
    api_identity.mark_different_people(body, user=ADMIN)
    r = api_identity.mark_different_people(body, user=ADMIN)      # no crash
    assert r["recorded"] is True


def test_marking_same_person_points_the_duplicate_at_the_canonical(db):
    from database import Lead
    canonical = _lead(db, "Dale Pawlak", "10 Main St")
    dupe = _lead(db, "Dale Pawlak", "10 Main St")
    api_identity.mark_same_person(
        api_identity.SamePersonBody(canonical_id=canonical.id, duplicate_id=dupe.id),
        user=ADMIN)
    db.expire_all()
    assert db.query(Lead).filter(Lead.id == dupe.id).first().duplicate_of == canonical.id
    assert db.query(Lead).filter(Lead.id == canonical.id).first().duplicate_of == ""


def test_nothing_is_deleted_when_two_records_are_merged(db):
    """A soft pointer, so the decision is reversible."""
    from database import Lead
    canonical = _lead(db, "Dale Pawlak", "10 Main St")
    dupe = _lead(db, "Dale Pawlak", "10 Main St")
    api_identity.mark_same_person(
        api_identity.SamePersonBody(canonical_id=canonical.id, duplicate_id=dupe.id),
        user=ADMIN)
    assert db.query(Lead).count() == 2

    api_identity.undo_same_person(dupe.id, user=ADMIN)
    db.expire_all()
    assert db.query(Lead).filter(Lead.id == dupe.id).first().duplicate_of == ""


def test_a_record_cannot_be_its_own_duplicate(db):
    lead = _lead(db, "Solo", "1 St")
    with pytest.raises(HTTPException) as e:
        api_identity.mark_same_person(
            api_identity.SamePersonBody(canonical_id=lead.id, duplicate_id=lead.id),
            user=ADMIN)
    assert e.value.status_code == 400


def test_a_two_record_cycle_is_refused(db):
    a = _lead(db, "A", "1 St")
    b = _lead(db, "B", "2 St")
    api_identity.mark_same_person(
        api_identity.SamePersonBody(canonical_id=a.id, duplicate_id=b.id), user=ADMIN)
    with pytest.raises(HTTPException) as e:
        api_identity.mark_same_person(
            api_identity.SamePersonBody(canonical_id=b.id, duplicate_id=a.id), user=ADMIN)
    assert e.value.status_code == 400


# ── Language ──────────────────────────────────────────────────────────

def test_an_override_with_no_scope_is_refused(db):
    """The exact ambiguity that cost days after "put Luis in English"."""
    luis = _employee(db, "Luis", "Castillejo", language="es")
    with pytest.raises(HTTPException) as e:
        api_identity.set_employee_language(
            luis.id, api_identity.LanguageBody(override_language="en"), user=ADMIN)
    assert e.value.status_code == 422
    assert "scope" in str(e.value.detail).lower()


def test_an_until_override_needs_a_date(db):
    luis = _employee(db, "Luis", "Castillejo", language="es")
    with pytest.raises(HTTPException) as e:
        api_identity.set_employee_language(
            luis.id,
            api_identity.LanguageBody(override_language="en", scope="until"),
            user=ADMIN)
    assert e.value.status_code == 422


def test_an_until_date_in_the_past_is_refused(db):
    luis = _employee(db, "Luis", "Castillejo", language="es")
    with pytest.raises(HTTPException) as e:
        api_identity.set_employee_language(
            luis.id,
            api_identity.LanguageBody(override_language="en", scope="until",
                                      until_date="2020-01-01"),
            user=ADMIN)
    assert e.value.status_code == 422


def test_a_message_scoped_override_applies_then_is_consumed(db):
    luis = _employee(db, "Luis", "Castillejo", language="es")
    r = api_identity.set_employee_language(
        luis.id,
        api_identity.LanguageBody(override_language="en", scope="message",
                                  reason="one-off"),
        user=ADMIN)
    assert r["effective_language"] == "en"
    assert r["override_active"] is True

    consumed = api_identity.consume_language_override(luis.id, user=ADMIN)
    assert consumed["consumed"] is True

    after = api_identity.set_employee_language(
        luis.id, api_identity.LanguageBody(), user=ADMIN)
    assert after["effective_language"] == "es"


def test_an_until_override_survives_consume(db):
    """Only "message" scope is consumed by sending."""
    luis = _employee(db, "Luis", "Castillejo", language="es")
    api_identity.set_employee_language(
        luis.id,
        api_identity.LanguageBody(override_language="en", scope="until",
                                  until_date=clock.add_days_iso(clock.today_ct_iso(), 5)),
        user=ADMIN)
    r = api_identity.consume_language_override(luis.id, user=ADMIN)
    assert r["consumed"] is False


def test_an_unknown_language_is_refused(db):
    luis = _employee(db, "Luis", "Castillejo")
    with pytest.raises(HTTPException) as e:
        api_identity.set_employee_language(
            luis.id, api_identity.LanguageBody(preferred_language="fr"), user=ADMIN)
    assert e.value.status_code == 422


def test_the_standing_language_can_be_changed(db):
    luis = _employee(db, "Luis", "Castillejo", language="en")
    r = api_identity.set_employee_language(
        luis.id, api_identity.LanguageBody(preferred_language="es"), user=ADMIN)
    assert r["preferred_language"] == "es"
    assert r["effective_language"] == "es"
