"""The contact mirror has to be complete, deduped, and silent.

Background: lead intake walks opportunity cards, so a GHL contact with no
card never became a row anywhere — 469 of 1,972 contacts on 2026-09-29. Every
"who haven't we contacted?" list was therefore drawn from a subset of the
customer base without saying so.

What these pin:
  * every GHL contact becomes exactly one row, re-runs included
  * a contact already in the pipeline is linked, never duplicated — by GHL id
    first, then by phone, so the same person across two GHL accounts lands on
    one lead
  * GHL wins on names, but an empty GHL name never blanks a real one
  * contacts without a phone do not all collapse onto each other
  * the lead rows created here are INERT: no estimate, no sequence enrolment,
    and invisible to the boards, the Hit List, the call list and the nudge
    loop. Importing history must never text a customer.

GHL is stubbed at the `services.ghl` seam.
"""
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from database import Contact, Lead  # noqa: E402
from services import contact_mirror  # noqa: E402


def _contact(cid, name, phone="", added="2026-09-01T00:00:00Z", **kw):
    first, _, last = name.partition(" ")
    base = {
        "id": cid,
        "firstNameRaw": first,
        "lastNameRaw": last,
        "contactName": name.lower(),
        "phone": phone,
        "dateAdded": added,
        "tags": [],
    }
    base.update(kw)
    return base


@pytest.fixture
def fake_ghl(monkeypatch):
    """Serve a fixed contact list; record how many times GHL was read."""
    state = {"contacts": [], "calls": 0}

    def get_contacts(location_id, max_contacts=10000):
        state["calls"] += 1
        return list(state["contacts"])

    monkeypatch.setattr(contact_mirror, "get_contacts", get_contacts)
    monkeypatch.setattr(
        contact_mirror, "get_settings",
        lambda: type("S", (), {"ghl_location_id": "LOC1", "ghl_location_1_label": "Cypress"})(),
    )
    return state


def _mk_lead(db, name, phone, **kw):
    from services.identity import stamp_lead_keys
    lead = Lead(
        id=str(uuid.uuid4()),
        contact_name=name,
        contact_phone=phone,
        created_at=kw.pop("created_at", "2026-01-01T00:00:00Z"),
        pipeline_version=kw.pop("pipeline_version", "v2"),
        status=kw.pop("status", "new"),
        **kw,
    )
    stamp_lead_keys(lead)
    db.add(lead)
    db.commit()
    return lead


# ── completeness ─────────────────────────────────────────────────────

def test_every_contact_is_mirrored(db, fake_ghl):
    fake_ghl["contacts"] = [
        _contact("c1", "Amy May", "+15202359067", added="2026-09-30T01:55:00Z"),
        _contact("c2", "Anthony Ellis", "+12397786716", added="2026-09-29T15:43:00Z"),
        _contact("c3", "Hiram Rivera", "+17876723630", added="2026-04-29T21:39:00Z"),
    ]
    stats = contact_mirror.sync_contacts("LOC1", "Cypress")

    assert stats["fetched"] == 3
    assert stats["created"] == 3
    assert db.query(Contact).count() == 3


def test_ordering_matches_the_ghl_contact_list(db, fake_ghl):
    """Newest added first — Amy May at the top, Hiram Rivera at the bottom."""
    fake_ghl["contacts"] = [
        _contact("c3", "Hiram Rivera", "+17876723630", added="2026-04-29T21:39:00Z"),
        _contact("c1", "Amy May", "+15202359067", added="2026-09-30T01:55:00Z"),
        _contact("c2", "Anthony Ellis", "+12397786716", added="2026-09-29T15:43:00Z"),
    ]
    contact_mirror.sync_contacts("LOC1", "Cypress")

    names = [
        c.name for c in
        db.query(Contact).order_by(Contact.date_added.desc().nullslast()).all()
    ]
    assert names == ["Amy May", "Anthony Ellis", "Hiram Rivera"]


def test_resync_updates_in_place_and_never_duplicates(db, fake_ghl):
    fake_ghl["contacts"] = [_contact("c1", "Amy May", "+15202359067")]
    contact_mirror.sync_contacts("LOC1", "Cypress")
    second = contact_mirror.sync_contacts("LOC1", "Cypress")

    assert second["created"] == 0
    assert second["updated"] == 1
    assert db.query(Contact).count() == 1
    assert db.query(Lead).count() == 1


# ── dedupe against existing leads ────────────────────────────────────

def test_links_to_existing_lead_by_ghl_id(db, fake_ghl):
    lead = _mk_lead(db, "Amy May", "+15202359067", ghl_contact_id="c1")
    fake_ghl["contacts"] = [_contact("c1", "Amy May", "+15202359067")]

    stats = contact_mirror.sync_contacts("LOC1", "Cypress")

    assert stats["linked_by_ghl_id"] == 1
    assert stats["leads_created"] == 0
    row = db.query(Contact).one()
    assert row.lead_id == lead.id
    assert row.link_method == "ghl_id"


def test_links_by_phone_when_the_ghl_id_is_new(db, fake_ghl):
    """The same person re-created in a newer GHL account must not double up.

    This is the real case: 396 leads in the database came from two GHL
    accounts that were abandoned in April 2026, and those people were
    re-created in the live account with fresh contact ids.
    """
    lead = _mk_lead(db, "Hiram Rivera", "+1 (787) 672-3630", ghl_contact_id="old-id")
    fake_ghl["contacts"] = [_contact("new-id", "Hiram Rivera", "+17876723630")]

    stats = contact_mirror.sync_contacts("LOC1", "Cypress")

    assert stats["linked_by_phone"] == 1
    assert stats["leads_created"] == 0
    assert db.query(Lead).count() == 1
    assert db.query(Contact).one().lead_id == lead.id


def test_phoneless_contacts_do_not_collapse_together(db, fake_ghl):
    """An empty phone key must never match another empty phone key.

    Joseph Cardello — the newest Woodlands contact on 2026-09-29 — had no
    phone at all. If a blank key matched, every phoneless contact would be
    linked to the same arbitrary lead.
    """
    _mk_lead(db, "Someone Else", "")
    fake_ghl["contacts"] = [
        _contact("c1", "Joseph Cardello", ""),
        _contact("c2", "Dante Randle", ""),
    ]

    stats = contact_mirror.sync_contacts("LOC1", "Cypress")

    assert stats["linked_by_phone"] == 0
    assert stats["no_phone"] == 2
    assert stats["leads_created"] == 2
    lead_ids = {c.lead_id for c in db.query(Contact).all()}
    assert len(lead_ids) == 2  # two distinct new leads, not one shared


def test_newest_lead_wins_when_several_share_a_phone(db, fake_ghl):
    _mk_lead(db, "Old Row", "+12815550000", created_at="2026-01-01T00:00:00Z")
    newer = _mk_lead(db, "Newer Row", "+12815550000", created_at="2026-08-01T00:00:00Z")
    fake_ghl["contacts"] = [_contact("c1", "Real Name", "+12815550000")]

    contact_mirror.sync_contacts("LOC1", "Cypress")

    assert db.query(Contact).one().lead_id == newer.id


# ── names ────────────────────────────────────────────────────────────

def test_ghl_name_overwrites_the_dashboard_name(db, fake_ghl):
    lead = _mk_lead(db, "wrong name", "+15202359067", ghl_contact_id="c1")
    fake_ghl["contacts"] = [_contact("c1", "Amy May", "+15202359067")]

    stats = contact_mirror.sync_contacts("LOC1", "Cypress")

    assert stats["names_corrected"] == 1
    db.refresh(lead)
    assert lead.contact_name == "Amy May"
    # Derived lookup keys must move with the name or the voice matcher and
    # the duplicate finder keep resolving the old one.
    assert lead.name_key == "amy may"


def test_an_empty_ghl_name_never_blanks_a_real_one(db, fake_ghl):
    lead = _mk_lead(db, "Amy May", "+15202359067", ghl_contact_id="c1")
    fake_ghl["contacts"] = [{
        "id": "c1", "phone": "+15202359067", "dateAdded": "2026-09-01T00:00:00Z",
    }]

    stats = contact_mirror.sync_contacts("LOC1", "Cypress")

    assert stats["names_corrected"] == 0
    db.refresh(lead)
    assert lead.contact_name == "Amy May"


def test_prefers_the_raw_cased_name_over_ghls_lowercased_one(db, fake_ghl):
    fake_ghl["contacts"] = [_contact("c1", "Amy May", "+15202359067")]
    contact_mirror.sync_contacts("LOC1", "Cypress")
    assert db.query(Contact).one().name == "Amy May"


# ── the created lead rows must be inert ──────────────────────────────

def test_created_leads_are_invisible_to_boards_and_nudges(db, fake_ghl):
    """The safety property. These rows exist so texts and calls can be
    pulled; they must not reach a customer or a screen.

    * boards / Hit List / call list filter pipeline_version in (v2, v2b)
    * the nudge loop selects status in ("new", "estimated") with NO version
      filter, so 469 imports as "new" would fire 469 nudges
    """
    fake_ghl["contacts"] = [_contact("c1", "Susan Junco", "+12818890950")]
    contact_mirror.sync_contacts("LOC1", "Cypress")

    lead = db.query(Lead).one()
    assert lead.pipeline_version == "contact"
    assert lead.pipeline_version not in ("v2", "v2b")
    assert lead.status not in ("new", "estimated")
    assert lead.ghl_contact_id == "c1"
    assert lead.contact_phone == "+12818890950"


def test_import_creates_no_estimate_and_sends_nothing(db, fake_ghl, monkeypatch):
    """No Estimate row, and on_lead_created — which enrols SMS sequences —
    is never called."""
    from database import Estimate

    called = []
    import services.followup_engine as fe
    monkeypatch.setattr(
        fe, "on_lead_created",
        lambda *a, **k: called.append(a), raising=False,
    )

    fake_ghl["contacts"] = [_contact("c1", "Susan Junco", "+12818890950")]
    contact_mirror.sync_contacts("LOC1", "Cypress")

    assert db.query(Estimate).count() == 0
    assert called == []


def test_ghl_dnd_carries_onto_the_lead(db, fake_ghl):
    """A contact GHL has marked do-not-disturb must arrive already blocked,
    not wait for someone to reply "stop" to us."""
    fake_ghl["contacts"] = [_contact("c1", "Richard Allen", "+12546243304", dnd=True)]
    contact_mirror.sync_contacts("LOC1", "Cypress")

    assert db.query(Contact).one().dnd is True
    assert db.query(Lead).one().do_not_contact is True


def test_create_leads_false_mirrors_without_touching_leads(db, fake_ghl):
    fake_ghl["contacts"] = [_contact("c1", "Susan Junco", "+12818890950")]
    stats = contact_mirror.sync_contacts("LOC1", "Cypress", create_leads=False)

    assert stats["no_lead"] == 1
    assert stats["leads_created"] == 0
    assert db.query(Lead).count() == 0
    assert db.query(Contact).one().lead_id is None


# ── failure handling ─────────────────────────────────────────────────

def test_a_failed_ghl_read_reports_and_changes_nothing(db, fake_ghl, monkeypatch):
    """A short or failed read must not look like "all contacts deleted"."""
    _mk_lead(db, "Amy May", "+15202359067", ghl_contact_id="c1")

    def boom(location_id, max_contacts=10000):
        raise RuntimeError("401 Unauthorized")

    monkeypatch.setattr(contact_mirror, "get_contacts", boom)
    stats = contact_mirror.sync_contacts("LOC1", "Cypress")

    assert "error" in stats
    assert stats["fetched"] == 0
    assert db.query(Contact).count() == 0
    assert db.query(Lead).count() == 1  # untouched


def test_contacts_missing_from_a_sweep_are_reported_not_deleted(db, fake_ghl):
    fake_ghl["contacts"] = [
        _contact("c1", "Amy May", "+15202359067"),
        _contact("c2", "Gone Away", "+12815551234"),
    ]
    contact_mirror.sync_contacts("LOC1", "Cypress")

    fake_ghl["contacts"] = [_contact("c1", "Amy May", "+15202359067")]
    stats = contact_mirror.sync_contacts("LOC1", "Cypress")

    assert stats["not_seen_this_sweep"] == 1
    assert db.query(Contact).count() == 2  # still there — never auto-deleted
