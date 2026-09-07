"""Resolving a spoken or typed name to a stable id — or refusing to.

Three employees are called "Chris": Chris, Christian, and Cris. On one evening
the same person was written "Cris" and then "Chris" while being given different
assignments. Two different customers are called Micheal — one on Calwood Cir,
one named Micheal Jessop on Laguna Hills Ct — and they were nearly merged into
a single record.

The contract that makes this safe is one rule, and it is the most important
line in this module:

    When two or more candidates are plausible, `person` is None.

Never a best guess alongside a candidate list. A caller handed both will use
the guess, and that is precisely how the wrong Chris gets the job. Ambiguity is
a normal outcome here, not an error — the HTTP layer returns 200 for it, so
nobody is tempted to write `except: pick_first()`.

What resolves a name, in order of strength:

  1. an exact phone match (customers) — unambiguous
  2. an exact normalized name
  3. an alias a human recorded against that record
  4. a phonetic key match
  5. a similarity score

Badly mangled transcription ("Waiks" for Wade) is NOT reachable by 4 or 5 —
see services/name_match.phonetic_key for the measurements. Those need an alias
recorded once. Until then this says "I don't know that name" and asks, which
is the right answer: a confident wrong match costs far more than a question.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

from database import Employee, Lead
from services.name_match import (
    address_tokens,
    name_key,
    normalize_name,
    phone_key,
    phonetic_key,
    similarity,
    street_number,
)

logger = logging.getLogger(__name__)

# A single candidate must clear ACCEPT to resolve.
ACCEPT = 0.88
# Below ACCEPT but worth naming in a question ("did you mean…?").
CONSIDER = 0.62
# Two candidates this close are a tie, however high they score. Without this,
# Chris at 0.93 and Cris at 0.91 would silently resolve to Chris.
TIE_MARGIN = 0.08


@dataclass(frozen=True)
class Candidate:
    kind: str          # "employee" | "customer"
    id: str
    display: str
    detail: str        # what tells two same-named people apart, for the question
    score: float
    matched_on: str    # "exact" | "alias" | "phonetic" | "similar" | "phone"

    def to_dict(self) -> dict:
        return {
            "kind": self.kind, "id": self.id, "display": self.display,
            "detail": self.detail, "score": round(self.score, 3),
            "matched_on": self.matched_on,
        }


@dataclass(frozen=True)
class Resolution:
    status: str                              # resolved | ambiguous | not_found
    person: Candidate | None = None          # non-None IFF status == "resolved"
    candidates: list[Candidate] = field(default_factory=list)
    query: str = ""
    question: str = ""                       # "" unless the caller must ask

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "person": self.person.to_dict() if self.person else None,
            "candidates": [c.to_dict() for c in self.candidates],
            "query": self.query,
            "question": self.question,
        }


def _aliases(raw: str | None) -> list[str]:
    try:
        parsed = json.loads(raw or "[]")
        return [str(a) for a in parsed] if isinstance(parsed, list) else []
    except (ValueError, TypeError):
        return []


def _score(spoken: str, display: str, aliases: list[str], stored_phonetic: str) -> tuple[float, str]:
    """Best score for one record, plus which signal produced it."""
    q_norm = normalize_name(spoken)
    if not q_norm:
        return 0.0, ""

    if q_norm == normalize_name(display):
        return 1.0, "exact"
    for alias in aliases:
        if q_norm == normalize_name(alias):
            return 0.98, "alias"

    q_phon = phonetic_key(spoken)
    if q_phon and q_phon == (stored_phonetic or phonetic_key(display)):
        return 0.80, "phonetic"

    ratio = similarity(spoken, display)
    for alias in aliases:
        ratio = max(ratio, similarity(spoken, alias))

    # A first name matching a fuller name is capped: "Chris" against
    # "Christian Reyes" must never look certain.
    if q_norm in normalize_name(display).split(" "):
        return min(0.70, max(ratio, 0.66)), "first_name_only"

    return ratio, "similar"


def _decide(spoken: str, scored: list[Candidate], noun: str) -> Resolution:
    """Turn scored candidates into resolved / ambiguous / not_found."""
    ranked = sorted(scored, key=lambda c: c.score, reverse=True)
    accepted = [c for c in ranked if c.score >= ACCEPT]

    if len(accepted) == 1:
        # Even a lone acceptor is ambiguous if a runner-up is within the tie
        # margin — Chris at 0.93 next to Cris at 0.91 is not a decision.
        runner_up = next((c for c in ranked if c.id != accepted[0].id), None)
        if runner_up and (accepted[0].score - runner_up.score) < TIE_MARGIN:
            close = [accepted[0], runner_up]
            return Resolution(
                status="ambiguous", person=None, candidates=close, query=spoken,
                question=_ask(spoken, close, noun),
            )
        return Resolution(status="resolved", person=accepted[0],
                          candidates=[accepted[0]], query=spoken)

    if len(accepted) > 1:
        return Resolution(
            status="ambiguous", person=None, candidates=accepted, query=spoken,
            question=_ask(spoken, accepted, noun),
        )

    near = [c for c in ranked if c.score >= CONSIDER][:3]
    return Resolution(
        status="not_found", person=None, candidates=near, query=spoken,
        question=(
            f"I don't know a {noun} called \"{spoken}\". "
            + (f"Did you mean {_join([c.display for c in near])}?" if near
               else "Pick them from the list.")
        ),
    )


def _join(names: list[str]) -> str:
    if len(names) == 1:
        return names[0]
    return ", ".join(names[:-1]) + f" or {names[-1]}"


def _ask(spoken: str, candidates: list[Candidate], noun: str) -> str:
    """One phrasing, built server-side, so every consumer asks identically."""
    listed = _join([f"{c.display} ({c.detail})" if c.detail else c.display
                    for c in candidates])
    return f'Which {noun} do you mean by "{spoken}" — {listed}?'


# ──────────────────────────────────────────────────────────────────────
# Employees
# ──────────────────────────────────────────────────────────────────────

def resolve_employee(db, spoken: str, *, active_only: bool = True) -> Resolution:
    """Resolve a crew member's name to an Employee id, or ask.

    The crew is under fifteen people, so this loads them all and scores in
    Python. That also keeps matching identical on SQLite and Postgres, which
    disagree about how `ilike` folds case.
    """
    if not (spoken or "").strip():
        return Resolution(status="not_found", query=spoken or "",
                          question="Who do you mean?")

    q = db.query(Employee)
    if active_only:
        q = q.filter(Employee.status == "active")

    scored: list[Candidate] = []
    for emp in q.all():
        display = (emp.display_name or f"{emp.first_name or ''} {emp.last_name or ''}").strip()
        if not display:
            continue
        score, how = _score(spoken, display, _aliases(emp.identity_aliases), emp.phonetic_key or "")
        if score <= 0:
            continue
        scored.append(Candidate(
            kind="employee", id=emp.id, display=display,
            detail=(emp.role or "crew"), score=score, matched_on=how,
        ))
    return _decide(spoken.strip(), scored, "crew member")


# ──────────────────────────────────────────────────────────────────────
# Customers
# ──────────────────────────────────────────────────────────────────────

def resolve_customer(db, spoken: str, *, address_hint: str = "",
                     phone_hint: str = "") -> Resolution:
    """Resolve a customer's name to a Lead id, or ask.

    A hard rule sits ahead of the scorer, so no amount of threshold tuning can
    defeat it: the customer identity key is the (name, address) PAIR, never the
    name alone. If a name-only query matches two leads at different addresses,
    the answer is ambiguous at any score. That is what keeps Micheal on Calwood
    Cir and Micheal Jessop on Laguna Hills Ct apart permanently.

    Supply address_hint and a dictated "Micheal on Calwood" resolves cleanly.
    """
    spoken = (spoken or "").strip()
    if not spoken:
        return Resolution(status="not_found", query="",
                          question="Which customer do you mean?")

    # An exact phone match is unambiguous — take it and stop.
    pk = phone_key(phone_hint)
    if pk:
        hit = db.query(Lead).filter(Lead.phone_key == pk).first()
        if hit:
            hit = _canonical(db, hit)
            return Resolution(
                status="resolved", query=spoken,
                person=Candidate(kind="customer", id=hit.id,
                                 display=hit.contact_name or "(no name)",
                                 detail=hit.address or "", score=1.0,
                                 matched_on="phone"),
            )

    nk = name_key(spoken)
    pkey = phonetic_key(spoken)
    # Narrow in SQL on the indexed keys, then score the shortlist in Python.
    #
    # The alias clause is load-bearing, not an optimisation: a recorded alias
    # is the ONLY way a badly mangled transcription ("Nalonso" for Nolasco)
    # reaches the right record, and the key columns by definition don't match
    # it. Without this the alias would be stored but unreachable.
    # The prefix clause matters as much as the exact one: a first-name query
    # ("Micheal") has to see the longer name too ("Micheal Jessop"), or the
    # two never appear side by side and the ambiguity is invisible. A prefix
    # LIKE still uses idx_leads_name_key.
    from sqlalchemy import func as _func
    rows = (
        db.query(Lead)
        .filter(
            (Lead.name_key == nk)
            | (Lead.name_key.like(f"{nk} %"))
            | (Lead.phonetic_key == pkey)
            | (_func.lower(Lead.identity_aliases).like(f'%"{nk}"%'))
        )
        .limit(200)
        .all()
    )
    if not rows:
        rows = _shortlist_by_first_token(db, spoken)

    hint_tokens = address_tokens(address_hint)
    hint_number = street_number(address_hint)

    # Score each row, then fold it onto its canonical record. Two rows a human
    # has confirmed are the same person must present as ONE candidate, or the
    # confirmation buys nothing and they read as an ambiguity forever.
    best: dict[str, Candidate] = {}
    for lead in rows:
        display = (lead.contact_name or "").strip()
        if not display:
            continue
        score, how = _score(spoken, display, _aliases(lead.identity_aliases),
                            lead.phonetic_key or "")
        if score <= 0:
            continue
        # The address hint is a tie-breaker, never a match on its own.
        if hint_tokens or hint_number:
            addr = lead.address or ""
            if (hint_number and hint_number == street_number(addr)) or \
               (hint_tokens and hint_tokens & address_tokens(addr)):
                score = min(1.0, score + 0.25)
                how = f"{how}+address"

        target = _canonical(db, lead) or lead
        if target.id != lead.id:
            how = f"{how}+merged"
        prior = best.get(target.id)
        if prior is None or score > prior.score:
            best[target.id] = Candidate(
                kind="customer", id=target.id,
                display=(target.contact_name or display).strip(),
                detail=target.address or "", score=score, matched_on=how,
            )

    scored = list(best.values())
    resolution = _decide(spoken, scored, "customer")

    # The (name, address) rule, applied after scoring so no threshold tuning
    # can defeat it. Two people the query could equally mean, living at
    # different addresses, is never a decision — even when one is an exact
    # match and the other only shares a first name. That asymmetry is exactly
    # the "Micheal" / "Micheal Jessop" case that was nearly merged.
    if resolution.status == "resolved" and not (hint_tokens or hint_number):
        q_tokens = set(normalize_name(spoken).split(" "))
        rivals = [
            c for c in scored
            if q_tokens and q_tokens <= set(normalize_name(c.display).split(" "))
        ]
        addresses = {(c.detail or "").strip().lower() for c in rivals}
        if len(rivals) > 1 and len(addresses) > 1:
            return Resolution(
                status="ambiguous", person=None,
                candidates=sorted(rivals, key=lambda c: c.score, reverse=True),
                query=spoken, question=_ask(spoken, rivals, "customer"),
            )

    return resolution


def _shortlist_by_first_token(db, spoken: str) -> list[Lead]:
    """Fallback when the keys miss: leads sharing the first word of the query."""
    first = (normalize_name(spoken).split(" ") or [""])[0]
    if len(first) < 3:
        return []
    return (
        db.query(Lead)
        .filter(Lead.name_key.like(f"%{first}%"))
        .limit(200)
        .all()
    )


def _canonical(db, lead: Lead | None) -> Lead | None:
    """Follow duplicate_of to the row a human marked canonical.

    Bounded: a mis-entered cycle must not hang a request.
    """
    seen: set[str] = set()
    while lead and (lead.duplicate_of or "").strip() and lead.id not in seen:
        seen.add(lead.id)
        nxt = db.query(Lead).filter(Lead.id == lead.duplicate_of.strip()).first()
        if not nxt:
            break
        lead = nxt
    return lead


# ──────────────────────────────────────────────────────────────────────
# Keeping the lookup keys fresh
# ──────────────────────────────────────────────────────────────────────

def stamp_lead_keys(lead: Lead) -> None:
    """Recompute a lead's lookup keys. Call after any name/phone write."""
    name = lead.contact_name or ""
    lead.name_key = name_key(name) or "-"
    lead.phonetic_key = phonetic_key(name)
    lead.phone_key = phone_key(lead.contact_phone or "")


def stamp_employee_keys(emp: Employee) -> None:
    display = (emp.display_name or f"{emp.first_name or ''} {emp.last_name or ''}").strip()
    emp.phonetic_key = phonetic_key(display) or "-"


# ──────────────────────────────────────────────────────────────────────
# Language
# ──────────────────────────────────────────────────────────────────────

def language_for(emp: Employee, *, today: str) -> tuple[str, bool]:
    """The language to write this person's messages in.

    Returns (language, override_active). An override must carry a scope:
      "message" — applies to the next message, then is cleared by the sender
      "until"   — applies through until_date, then expires on its own

    An unbounded override is rejected at the API, because the one time it was
    done informally nobody could say how long it applied.
    """
    base = (emp.preferred_language or "en").strip().lower() or "en"
    try:
        ov = json.loads(emp.language_override or "{}")
    except (ValueError, TypeError):
        return base, False
    if not isinstance(ov, dict) or not ov.get("language"):
        return base, False

    scope = (ov.get("scope") or "").strip()
    if scope == "message":
        return str(ov["language"]), True
    if scope == "until":
        until = str(ov.get("until_date") or "")
        if until and today <= until:
            return str(ov["language"]), True
    return base, False
