"""Identity regressions, from the people and customers this actually happened to.

Three employees are called "Chris" — Chris, Christian, Cris. Two different
customers are called Micheal. The system's job is not to be clever about these;
it is to notice and ask.
"""
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from services import identity  # noqa: E402
from services.name_match import normalize_name, phone_key, phonetic_key  # noqa: E402


# ── fixtures ──────────────────────────────────────────────────────────

def make_employee(db, first, last="", *, aliases=(), role="crew", language="en"):
    from database import Employee
    emp = Employee(
        id=str(uuid.uuid4()), first_name=first, last_name=last,
        display_name=f"{first} {last}".strip(), role=role, pay_rate=0,
        status="active", identity_aliases=json.dumps(list(aliases)),
        preferred_language=language, language_override="{}",
    )
    identity.stamp_employee_keys(emp)
    db.add(emp); db.commit()
    return emp


def make_lead(db, name, address="", phone="", *, aliases=(), duplicate_of=""):
    from database import Lead
    lead = Lead(
        id=str(uuid.uuid4()), contact_name=name, address=address,
        contact_phone=phone, identity_aliases=json.dumps(list(aliases)),
        duplicate_of=duplicate_of, division="fence",
    )
    identity.stamp_lead_keys(lead)
    db.add(lead); db.commit()
    return lead


# ── Chris / Christian / Cris ──────────────────────────────────────────

def test_chris_is_ambiguous_and_returns_no_person(db):
    """The headline. Three people answer to "Chris"; picking one is the bug."""
    make_employee(db, "Chris", "Boyd", aliases=["Chris"])
    make_employee(db, "Christian", "Reyes", aliases=["Christian", "Chris T"])
    make_employee(db, "Cris", "Delgado", aliases=["Cris"])

    r = identity.resolve_employee(db, "Chris")
    assert r.status == "ambiguous"
    assert r.person is None, "a best guess here is exactly how the wrong Chris gets the job"
    assert len(r.candidates) >= 2
    assert "Chris" in r.question


def test_the_full_name_resolves_cleanly(db):
    """Ambiguity must not be contagious — an exact name is still an answer."""
    make_employee(db, "Chris", "Boyd", aliases=["Chris"])
    christian = make_employee(db, "Christian", "Reyes", aliases=["Christian"])
    make_employee(db, "Cris", "Delgado", aliases=["Cris"])

    r = identity.resolve_employee(db, "Christian")
    assert r.status == "resolved"
    assert r.person.id == christian.id


def test_two_spellings_of_a_query_never_resolve_to_different_people(db):
    """Cris/Chris must not each confidently resolve to a different person."""
    make_employee(db, "Chris", "Boyd", aliases=["Chris"])
    make_employee(db, "Cris", "Delgado", aliases=["Cris"])

    a = identity.resolve_employee(db, "Chris")
    b = identity.resolve_employee(db, "Cris")
    if a.status == "resolved" and b.status == "resolved":
        assert a.person.id == b.person.id, (
            "two spellings of one spoken name resolved to two different people"
        )


def test_a_lone_employee_named_chris_resolves(db):
    """With no collision there is nothing to ask about."""
    chris = make_employee(db, "Chris", "Boyd", aliases=["Chris"])
    r = identity.resolve_employee(db, "Chris")
    assert r.status == "resolved" and r.person.id == chris.id


def test_inactive_crew_are_not_candidates(db):
    from database import Employee
    make_employee(db, "Chris", "Boyd")
    gone = make_employee(db, "Chris", "Older")
    db.query(Employee).filter(Employee.id == gone.id).update({"status": "inactive"})
    db.commit()
    r = identity.resolve_employee(db, "Chris Boyd")
    assert r.status == "resolved"


# ── The two Micheals ──────────────────────────────────────────────────

def test_two_customers_named_micheal_never_collapse(db):
    """9403 Calwood Cir and 19802 Laguna Hills Ct are different people."""
    make_lead(db, "Micheal", "9403 Calwood Cir")
    make_lead(db, "Micheal Jessop", "19802 Laguna Hills Ct")

    r = identity.resolve_customer(db, "Micheal")
    assert r.status == "ambiguous"
    assert r.person is None


def test_the_address_hint_disambiguates_the_micheals(db):
    """"Micheal on Calwood" is a complete instruction."""
    calwood = make_lead(db, "Micheal", "9403 Calwood Cir")
    make_lead(db, "Micheal Jessop", "19802 Laguna Hills Ct")

    r = identity.resolve_customer(db, "Micheal", address_hint="Calwood")
    assert r.status == "resolved"
    assert r.person.id == calwood.id


def test_the_fuller_name_resolves_to_jessop(db):
    make_lead(db, "Micheal", "9403 Calwood Cir")
    jessop = make_lead(db, "Micheal Jessop", "19802 Laguna Hills Ct")

    r = identity.resolve_customer(db, "Micheal Jessop")
    assert r.status == "resolved"
    assert r.person.id == jessop.id


def test_same_name_same_address_is_not_forced_ambiguous(db):
    """The rule keys on (name, address). One address, one person."""
    only = make_lead(db, "Micheal", "9403 Calwood Cir")
    r = identity.resolve_customer(db, "Micheal")
    assert r.status == "resolved" and r.person.id == only.id


# ── Transcription variants ────────────────────────────────────────────

def test_an_alias_resolves_a_mangled_transcription(db):
    """"Nalonso" for Nolasco is beyond any phonetic key — see name_match.

    The mechanism is an alias recorded once, and this proves it works.
    """
    nolasco = make_lead(db, "Nolasco", "123 Elm St", aliases=["Nalonso"])
    r = identity.resolve_customer(db, "Nalonso")
    assert r.status == "resolved"
    assert r.person.id == nolasco.id


def test_without_an_alias_a_mangled_name_asks_rather_than_guesses(db):
    """The honest behaviour before anyone has recorded the alias."""
    make_lead(db, "Nolasco", "123 Elm St")
    r = identity.resolve_customer(db, "Nalonso")
    assert r.status != "resolved"
    assert r.person is None


def test_an_alias_on_the_wrong_record_cannot_be_used_by_another(db):
    """Aliases attach to one record; a second Nolasco makes it ambiguous."""
    make_lead(db, "Nolasco", "123 Elm St", aliases=["Nalonso"])
    make_lead(db, "Nalonso", "999 Oak Dr")
    r = identity.resolve_customer(db, "Nalonso")
    assert r.status == "ambiguous", "two records answer to this name"
    assert r.person is None


def test_syfuentes_surfaces_cifuentes_as_a_question_not_a_match(db):
    """A phonetic equivalence the key DOES reach — but only scores 0.80.

    Below the accept threshold on purpose. The value of the phonetic key here
    is getting the right record into the question ("did you mean Cifuentes?")
    rather than answering "I don't know that name" — not auto-deciding.
    """
    lead = make_lead(db, "Cifuentes", "500 Pine St")
    r = identity.resolve_customer(db, "Syfuentes")
    assert r.status == "not_found"
    assert r.person is None
    assert [c.id for c in r.candidates] == [lead.id]
    assert "Cifuentes" in r.question


def test_confirming_that_suggestion_once_makes_it_resolve_thereafter(db):
    """And the alias is how a human's confirmation is made permanent."""
    lead = make_lead(db, "Cifuentes", "500 Pine St", aliases=["Syfuentes"])
    r = identity.resolve_customer(db, "Syfuentes")
    assert r.status == "resolved" and r.person.id == lead.id


def test_mccollum_and_mcconnell_do_not_collapse(db):
    """Similar-looking, genuinely different families."""
    make_lead(db, "McCollum", "1 A St")
    make_lead(db, "McConnell", "2 B St")
    r = identity.resolve_customer(db, "McCollum")
    assert r.status == "resolved", "an exact name should still resolve"
    assert r.person.display == "McCollum"


def test_weighed_does_not_silently_become_wade(db):
    """Wade/"Weighed" scores 0.36 — far too low to act on.

    The right outcome is a question, not a match.
    """
    make_lead(db, "Wade Miller", "77 Forest Side Dr")
    r = identity.resolve_customer(db, "Weighed")
    assert r.status != "resolved"
    assert r.person is None
    assert r.question


def test_phone_beats_everything(db):
    lead = make_lead(db, "Whoever", "1 A St", phone="+18326039349")
    r = identity.resolve_customer(db, "totally wrong name",
                                  phone_hint="(832) 603-9349")
    assert r.status == "resolved" and r.person.id == lead.id


# ── duplicate_of ──────────────────────────────────────────────────────

def test_a_confirmed_duplicate_follows_through_to_the_canonical_row(db):
    canonical = make_lead(db, "Dale Pawlak", "10 Main St")
    make_lead(db, "Dale Pawlak", "10 Main St", duplicate_of=canonical.id)
    r = identity.resolve_customer(db, "Dale Pawlak", address_hint="Main")
    assert r.status == "resolved"
    assert r.person.id == canonical.id


def test_a_duplicate_cycle_cannot_hang_the_request(db):
    from database import Lead
    a = make_lead(db, "Loop A", "1 A St")
    b = make_lead(db, "Loop B", "2 B St", duplicate_of=a.id)
    db.query(Lead).filter(Lead.id == a.id).update({"duplicate_of": b.id})
    db.commit()
    r = identity.resolve_customer(db, "Loop A")     # must return, not spin
    assert r.status in {"resolved", "ambiguous", "not_found"}


# ── Empty and junk input ──────────────────────────────────────────────

@pytest.mark.parametrize("junk", ["", "   ", None])
def test_empty_input_asks_and_never_resolves(db, junk):
    make_employee(db, "Chris", "Boyd")
    r = identity.resolve_employee(db, junk)
    assert r.status == "not_found" and r.person is None and r.question


def test_an_unknown_name_returns_no_person(db):
    make_employee(db, "Chris", "Boyd")
    r = identity.resolve_employee(db, "Zebediah")
    assert r.status == "not_found" and r.person is None


# ── Language ──────────────────────────────────────────────────────────

def test_language_is_a_property_of_the_person(db):
    luis = make_employee(db, "Luis", "Castillejo", language="es")
    brent = make_employee(db, "Brent", "Brown", language="en")
    assert identity.language_for(luis, today="2026-09-06") == ("es", False)
    assert identity.language_for(brent, today="2026-09-06") == ("en", False)


def test_a_message_scoped_override_applies(db):
    """"Put Luis in English" — for the next message only."""
    luis = make_employee(db, "Luis", "Castillejo", language="es")
    luis.language_override = json.dumps(
        {"language": "en", "scope": "message", "reason": "one-off",
         "set_by": "alan", "set_at": "2026-09-06T00:00:00+00:00"})
    lang, active = identity.language_for(luis, today="2026-09-06")
    assert (lang, active) == ("en", True)


def test_an_until_override_expires_on_its_own(db):
    luis = make_employee(db, "Luis", "Castillejo", language="es")
    luis.language_override = json.dumps(
        {"language": "en", "scope": "until", "until_date": "2026-09-10"})
    assert identity.language_for(luis, today="2026-09-09")[0] == "en"
    assert identity.language_for(luis, today="2026-09-10")[0] == "en"   # inclusive
    assert identity.language_for(luis, today="2026-09-11") == ("es", False)


def test_an_override_with_no_scope_is_ignored(db):
    """The exact ambiguity that cost days: an override with no stated end."""
    luis = make_employee(db, "Luis", "Castillejo", language="es")
    luis.language_override = json.dumps({"language": "en"})
    assert identity.language_for(luis, today="2026-09-06") == ("es", False)


def test_malformed_override_json_falls_back_to_the_base_language(db):
    luis = make_employee(db, "Luis", "Castillejo", language="es")
    luis.language_override = "{not json"
    assert identity.language_for(luis, today="2026-09-06") == ("es", False)


# ── Key stamping ──────────────────────────────────────────────────────

def test_stamping_is_idempotent_and_survives_a_rename(db):
    lead = make_lead(db, "Nolasco", "123 Elm St", phone="+18325551234")
    assert lead.phone_key == "8325551234"
    first = lead.phonetic_key
    identity.stamp_lead_keys(lead)
    assert lead.phonetic_key == first

    lead.contact_name = "Nolasco Peña"
    identity.stamp_lead_keys(lead)
    assert lead.name_key == normalize_name("Nolasco Peña")
    assert lead.phonetic_key == phonetic_key("Nolasco Peña")


def test_a_nameless_lead_gets_a_sentinel_not_an_empty_key(db):
    """An empty key would make the backfill re-select the row forever."""
    lead = make_lead(db, "", "123 Elm St")
    assert lead.name_key == "-"


def test_phone_key_ignores_formatting(db):
    for fmt in ["+18326039349", "(832) 603-9349", "832.603.9349", "1-832-603-9349"]:
        assert phone_key(fmt) == "8326039349"


# ── Keys stay fresh without anyone remembering ────────────────────────

def test_keys_are_stamped_on_insert_without_an_explicit_call(db):
    """Leads are created from the webhook, the poller and the editor.

    A mapper listener stamps the keys so the next write path added can't
    silently skip it and leave a customer unfindable.
    """
    from database import Lead
    lead = Lead(id=str(uuid.uuid4()), contact_name="Nolasco",
                contact_phone="+18325551234", division="fence")
    db.add(lead); db.commit(); db.refresh(lead)
    assert lead.name_key == "nolasco"
    assert lead.phone_key == "8325551234"
    assert lead.phonetic_key == phonetic_key("Nolasco")


def test_keys_follow_a_rename_without_an_explicit_call(db):
    lead = make_lead(db, "Nolasco", "123 Elm St")
    lead.contact_name = "Cifuentes"
    db.commit(); db.refresh(lead)
    assert lead.name_key == "cifuentes"
    assert lead.phonetic_key == phonetic_key("Cifuentes")


def test_a_renamed_lead_is_findable_under_the_new_name(db):
    """The end-to-end point of the listener."""
    lead = make_lead(db, "Nolasco", "123 Elm St")
    lead.contact_name = "Cifuentes"
    db.commit()
    r = identity.resolve_customer(db, "Cifuentes")
    assert r.status == "resolved" and r.person.id == lead.id


def test_employee_keys_are_stamped_on_insert(db):
    from database import Employee
    emp = Employee(id=str(uuid.uuid4()), first_name="Christian", last_name="Reyes",
                   display_name="Christian Reyes", pay_rate=0, status="active")
    db.add(emp); db.commit(); db.refresh(emp)
    assert emp.phonetic_key == phonetic_key("Christian Reyes")
