"""The greeting on bill texts: Good morning/afternoon/evening in Houston
time, Mr./Mrs. plus the last name only when the call or a person said so,
and just the first name whenever there's any doubt (Alan, 2026-11-06)."""

import json
from datetime import datetime, timezone

from database import Lead
from services import greeting as g


def _lead(name="ana tran", form=None):
    return Lead(id="x", contact_name=name, form_data=json.dumps(form) if form is not None else None)


def test_time_of_day_in_houston():
    assert g.time_greeting(datetime(2026, 11, 6, 11, 59, tzinfo=g.HOUSTON)) == "Good morning"
    assert g.time_greeting(datetime(2026, 11, 6, 12, 0, tzinfo=g.HOUSTON)) == "Good afternoon"
    assert g.time_greeting(datetime(2026, 11, 6, 16, 59, tzinfo=g.HOUSTON)) == "Good afternoon"
    assert g.time_greeting(datetime(2026, 11, 6, 17, 0, tzinfo=g.HOUSTON)) == "Good evening"
    # 02:38 UTC is 8:38 PM in Houston.
    assert g.time_greeting(datetime(2026, 11, 7, 2, 38, tzinfo=timezone.utc)) == "Good evening"


def test_no_label_is_guessed_from_the_name():
    eve = datetime(2026, 11, 6, 20, 38, tzinfo=g.HOUSTON)
    assert g.greet(_lead("ana tran"), eve) == "Good evening Ana"
    assert g.greet(_lead("Michael Smith"), eve) == "Good evening Michael"
    assert g.greet(_lead("mary"), eve) == "Good evening Mary"
    assert g.greet(_lead(""), eve) == "Good evening"
    assert g.greet(None, eve) == "Good evening"


def test_the_call_said_how_they_sound():
    eve = datetime(2026, 11, 6, 20, 38, tzinfo=g.HOUSTON)
    lead = _lead("ana tran")
    assert g.heard_voice(lead, {"customer_voice": "a woman"}) == "Mrs."
    assert g.greet(lead, eve) == "Good evening Mrs. Tran"
    assert json.loads(lead.form_data)[g.FROM_KEY] == "call"
    # A later call that can't tell leaves it alone; one that hears a man moves it.
    assert g.heard_voice(lead, {"customer_voice": "can't tell"}) == ""
    assert g.greet(lead, eve) == "Good evening Mrs. Tran"
    assert g.heard_voice(lead, {"customer_voice": "a man"}) == "Mr."
    assert g.greet(lead, eve) == "Good evening Mr. Tran"
    assert g.heard_voice(lead, {"skip": True}) == "" and g.heard_voice(lead, None) == ""


def test_a_persons_word_beats_the_call():
    eve = datetime(2026, 11, 6, 20, 38, tzinfo=g.HOUSTON)
    lead = _lead("ana tran")
    g.set_label(lead, "none")
    assert g.heard_voice(lead, {"customer_voice": "a woman"}) == ""
    assert g.greet(lead, eve) == "Good evening Ana"
    g.set_label(lead, "Ms")
    assert g.greet(lead, eve) == "Good evening Ms. Tran"
    assert g.heard_voice(lead, {"customer_voice": "a man"}) == ""
    assert g.greet(lead, eve) == "Good evening Ms. Tran"


def test_a_label_the_customer_typed_and_odd_names():
    eve = datetime(2026, 11, 6, 20, 38, tzinfo=g.HOUSTON)
    assert g.greet(_lead("Mrs. Jones"), eve) == "Good evening Mrs. Jones"   # she typed it herself
    assert g.greet(_lead("Mrs. Jones", {"salutation": "none"}), eve) == "Good evening"
    assert g.greet(_lead("mr. bob jones jr."), eve) == "Good evening Mr. Jones"
    assert g.greet(_lead("d'angelo o'brien-smith", {"salutation": "Mr."}), eve) == "Good evening Mr. O'Brien-Smith"
    assert g.greet(_lead("Ana Tran", {"salutation": "Mrs."}), eve) == "Good evening Mrs. Tran"
    assert g.greet(_lead("Ana", {"salutation": "Mrs."}), eve) == "Good evening Ana"   # no last name: no label
    assert g.greet_name("Sam Smith", eve) == "Good evening Sam"
    assert g.greet_name("", eve) == "Good evening"
    assert g.names("JOSE DE LA CRUZ") == ("Jose", "Cruz")
