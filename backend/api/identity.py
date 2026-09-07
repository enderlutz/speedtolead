"""Resolving what a human said into something unambiguous.

Two kinds of thing get said out loud and then typed wrong: a date ("tomorrow",
which is only meaningful against a Houston clock) and a name ("Chris", of whom
there are three). Both resolve here, and both follow the same rule — when the
answer isn't certain, say so and ask, rather than pick.

Ambiguity returns HTTP 200. It is a normal outcome, not an error. A 409 would
tempt a caller into `except: pick_first()`, which is the failure this whole
module exists to prevent.
"""

from __future__ import annotations

import json
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

import clock
from api.auth import require_admin, require_staff
from database import Employee, IdentityDistinct, Lead, get_db
from services import identity

router = APIRouter()
logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────
# Dates
# ──────────────────────────────────────────────────────────────────────

@router.get("/time/today")
def time_today(user: dict = Depends(require_staff)):
    """Today in Houston, with the weekday derived from it."""
    del user
    today = clock.today_ct_iso()
    return {
        "date": today,
        "weekday": clock.weekday_label(today),
        "label": clock.echo_day(today),
        "now_iso": clock.now_iso(),
        "timezone": clock.BUSINESS_TZ_NAME,
    }


@router.get("/time/resolve-day")
def time_resolve_day(phrase: str = Query(...), user: dict = Depends(require_staff)):
    """Turn "tomorrow" into an absolute date, against the Houston clock.

    Returns confident=false with NO date when the phrase doesn't parse — the
    caller must ask rather than assume. "Sometime next week" has no answer.

    `conflict` is true when the phrase also named a weekday that disagrees with
    the date it resolved to. A typed weekday is a checksum here, never a source
    of truth: a schedule labelled "Friday" over a Thursday date cost a full
    crew day.
    """
    del user
    resolved = clock.resolve_relative_day(phrase)
    if resolved is None:
        return {
            "confident": False,
            "date": None,
            "phrase": phrase,
            "basis_date": clock.today_ct_iso(),
            "question": f'I can\'t turn "{phrase}" into a date. Which day do you mean?',
        }
    return {
        "confident": True,
        "date": resolved.date,
        "weekday": resolved.weekday,
        "label": resolved.label,
        "phrase": resolved.source_phrase,
        "basis_date": resolved.basis_date,
        "conflict": resolved.conflict,
        "question": (
            f'You said "{phrase}", which is {resolved.label}. Is that right?'
            if resolved.conflict else ""
        ),
    }


# ──────────────────────────────────────────────────────────────────────
# Names
# ──────────────────────────────────────────────────────────────────────

class ResolveBody(BaseModel):
    kind: str                    # "employee" | "customer"
    text: str
    address_hint: str = ""
    phone_hint: str = ""


@router.post("/identity/resolve")
def resolve_name(body: ResolveBody, user: dict = Depends(require_staff)):
    """Resolve a spoken or typed name to a stable id, or return a question.

    status is one of:
      resolved   — exactly one confident match; `person` is set
      ambiguous  — two or more plausible; `person` is null, ask the question
      not_found  — none confident; `person` is null, `candidates` may hold
                   near-misses purely so the question can name them

    `person` is non-null ONLY when status is "resolved". Never read a candidate
    as an answer.
    """
    del user
    kind = (body.kind or "").strip().lower()
    if kind not in ("employee", "customer"):
        raise HTTPException(400, 'kind must be "employee" or "customer"')

    db = get_db()
    try:
        if kind == "employee":
            result = identity.resolve_employee(db, body.text)
        else:
            result = identity.resolve_customer(
                db, body.text,
                address_hint=body.address_hint, phone_hint=body.phone_hint,
            )
        return result.to_dict()
    finally:
        db.close()


class AliasBody(BaseModel):
    alias: str


@router.post("/identity/leads/{lead_id}/aliases")
def add_lead_alias(lead_id: str, body: AliasBody, user: dict = Depends(require_staff)):
    """Record a spelling that means this customer.

    This is the mechanism for transcription that no matcher can reach —
    "Nalonso" for Nolasco, "Waiks" for Wade. Confirmed once by a human, it
    resolves exactly from then on.
    """
    alias = (body.alias or "").strip()
    if not alias:
        raise HTTPException(400, "alias cannot be empty")

    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")
        try:
            aliases = json.loads(lead.identity_aliases or "[]")
            if not isinstance(aliases, list):
                aliases = []
        except (ValueError, TypeError):
            aliases = []
        if alias.lower() not in {str(a).lower() for a in aliases}:
            aliases.append(alias)
            lead.identity_aliases = json.dumps(aliases)
            lead.updated_at = clock.now_iso()
            db.commit()
        return {"lead_id": lead.id, "aliases": aliases}
    finally:
        db.close()


@router.delete("/identity/leads/{lead_id}/aliases/{alias}")
def remove_lead_alias(lead_id: str, alias: str, user: dict = Depends(require_staff)):
    del user
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")
        try:
            aliases = [a for a in json.loads(lead.identity_aliases or "[]")
                       if str(a).lower() != alias.strip().lower()]
        except (ValueError, TypeError):
            aliases = []
        lead.identity_aliases = json.dumps(aliases)
        lead.updated_at = clock.now_iso()
        db.commit()
        return {"lead_id": lead.id, "aliases": aliases}
    finally:
        db.close()


# ──────────────────────────────────────────────────────────────────────
# Duplicate review
# ──────────────────────────────────────────────────────────────────────

@router.get("/identity/duplicates")
def list_duplicates(limit: int = Query(50, ge=1, le=200),
                    user: dict = Depends(require_staff)):
    """Customers that look like the same person. Read-only — nothing merges."""
    del user
    db = get_db()
    try:
        groups = identity.find_duplicate_groups(db, limit=limit)
        return {"count": len(groups), "groups": groups}
    finally:
        db.close()


class SamePersonBody(BaseModel):
    canonical_id: str            # the record to keep
    duplicate_id: str            # the record that points at it


@router.post("/identity/duplicates/same-person")
def mark_same_person(body: SamePersonBody, user: dict = Depends(require_admin)):
    """Confirm two records are one person.

    Writes a soft pointer only. Nothing is moved, nothing is deleted, and the
    decision is reversible — which is why a human makes it and the matcher
    never does.
    """
    if body.canonical_id == body.duplicate_id:
        raise HTTPException(400, "A record cannot be a duplicate of itself")

    db = get_db()
    try:
        canonical = db.query(Lead).filter(Lead.id == body.canonical_id).first()
        duplicate = db.query(Lead).filter(Lead.id == body.duplicate_id).first()
        if not canonical or not duplicate:
            raise HTTPException(404, "Lead not found")
        # Would create a cycle: A already points at B, now B would point at A.
        if (canonical.duplicate_of or "") == duplicate.id:
            raise HTTPException(400, "Those two already point at each other")

        duplicate.duplicate_of = canonical.id
        duplicate.updated_at = clock.now_iso()
        db.commit()
        logger.info(
            f"identity: {duplicate.id} marked a duplicate of {canonical.id} "
            f"by {user.get('sub', '')}"
        )
        return {"canonical_id": canonical.id, "duplicate_id": duplicate.id}
    finally:
        db.close()


class DifferentPeopleBody(BaseModel):
    lead_id_a: str
    lead_id_b: str
    note: str = ""


@router.post("/identity/duplicates/different-people")
def mark_different_people(body: DifferentPeopleBody, user: dict = Depends(require_admin)):
    """Record that two look-alike records are NOT the same person.

    Does double duty, which is the point: the review list stops raising the
    pair, and the resolver reads it as proof they must never collapse. The two
    Micheals will look like duplicates to any matcher forever; the durable fix
    is the recorded human judgment.
    """
    a, b = IdentityDistinct.pair(body.lead_id_a, body.lead_id_b)
    if a == b:
        raise HTTPException(400, "Those are the same record")

    db = get_db()
    try:
        for lead_id in (a, b):
            if not db.query(Lead).filter(Lead.id == lead_id).first():
                raise HTTPException(404, f"Lead {lead_id} not found")

        existing = (
            db.query(IdentityDistinct)
            .filter(IdentityDistinct.lead_id_a == a, IdentityDistinct.lead_id_b == b)
            .first()
        )
        if not existing:
            db.add(IdentityDistinct(
                id=str(uuid.uuid4()), lead_id_a=a, lead_id_b=b,
                confirmed_by=user.get("sub", ""), confirmed_at=clock.now_iso(),
                note=(body.note or "").strip(),
            ))
            db.commit()
        return {"lead_id_a": a, "lead_id_b": b, "recorded": True}
    finally:
        db.close()


@router.post("/identity/duplicates/undo-same-person/{lead_id}")
def undo_same_person(lead_id: str, user: dict = Depends(require_admin)):
    """Clear a duplicate pointer set by mistake."""
    del user
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")
        lead.duplicate_of = ""
        lead.updated_at = clock.now_iso()
        db.commit()
        return {"lead_id": lead.id, "duplicate_of": ""}
    finally:
        db.close()


# ──────────────────────────────────────────────────────────────────────
# Crew language
# ──────────────────────────────────────────────────────────────────────

class LanguageBody(BaseModel):
    """A crew member's language, or a bounded override of it."""
    preferred_language: str | None = None      # en | es — the standing setting
    override_language: str | None = None       # en | es — temporary
    scope: str | None = None                   # "message" | "until"
    until_date: str | None = None              # YYYY-MM-DD, required for "until"
    reason: str = ""
    clear_override: bool = False


_LANGUAGES = ("en", "es")


@router.put("/identity/employees/{employee_id}/language")
def set_employee_language(employee_id: str, body: LanguageBody,
                          user: dict = Depends(require_staff)):
    """Set the language a crew member's messages are written in.

    An override MUST state its scope. There is deliberately no unbounded
    option: the one time this was done informally — "put Luis in English" —
    nobody could say afterwards how long it was meant to apply, and it stayed
    ambiguous for days. Either it covers the next message, or it has an end
    date.
    """
    db = get_db()
    try:
        emp = db.query(Employee).filter(Employee.id == employee_id).first()
        if not emp:
            raise HTTPException(404, "Employee not found")

        if body.preferred_language is not None:
            lang = body.preferred_language.strip().lower()
            if lang not in _LANGUAGES:
                raise HTTPException(422, f"preferred_language must be one of {_LANGUAGES}")
            emp.preferred_language = lang

        if body.clear_override:
            emp.language_override = "{}"
        elif body.override_language is not None:
            lang = body.override_language.strip().lower()
            if lang not in _LANGUAGES:
                raise HTTPException(422, f"override_language must be one of {_LANGUAGES}")
            scope = (body.scope or "").strip().lower()
            if scope not in ("message", "until"):
                raise HTTPException(
                    422,
                    'An override needs a scope: "message" (the next message only) '
                    'or "until" with an until_date. An override with no end date '
                    "is what caused days of confusion last time.",
                )
            if scope == "until":
                until = (body.until_date or "").strip()
                if not clock.parse_iso(f"{until}T12:00:00+00:00"):
                    raise HTTPException(422, 'scope "until" needs until_date as YYYY-MM-DD')
                if until < clock.today_ct_iso():
                    raise HTTPException(422, "until_date is already in the past")
            emp.language_override = json.dumps({
                "language": lang,
                "scope": scope,
                "until_date": (body.until_date or "").strip(),
                "reason": (body.reason or "").strip(),
                "set_by": user.get("sub", ""),
                "set_at": clock.now_iso(),
            })

        emp.updated_at = clock.now_iso()
        db.commit()
        db.refresh(emp)

        language, override_active = identity.language_for(emp, today=clock.today_ct_iso())
        return {
            "employee_id": emp.id,
            "preferred_language": emp.preferred_language or "en",
            "effective_language": language,
            "override_active": override_active,
            "override": json.loads(emp.language_override or "{}"),
        }
    finally:
        db.close()


@router.post("/identity/employees/{employee_id}/consume-language-override")
def consume_language_override(employee_id: str, user: dict = Depends(require_staff)):
    """Clear a "next message only" override once that message has gone out.

    Called by whatever sends the message. A message-scoped override that is
    never consumed is just an unbounded one wearing a disguise.
    """
    del user
    db = get_db()
    try:
        emp = db.query(Employee).filter(Employee.id == employee_id).first()
        if not emp:
            raise HTTPException(404, "Employee not found")
        try:
            override = json.loads(emp.language_override or "{}")
        except (ValueError, TypeError):
            override = {}
        if isinstance(override, dict) and override.get("scope") == "message":
            emp.language_override = "{}"
            emp.updated_at = clock.now_iso()
            db.commit()
            return {"employee_id": emp.id, "consumed": True}
        return {"employee_id": emp.id, "consumed": False}
    finally:
        db.close()
