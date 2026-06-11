"""Generate training personas from real (anonymized) leads.

The seeder picks a sample of real leads across pipeline stages, scrubs
PII (real name → anonymized initial-only handle, phone gone, address
fuzzed down to area), then asks Claude to invent a plausible homeowner
consistent with the fence shape on file. Output gets persisted in
TrainingPersonaBank rows.

Run via POST /api/training/personas/seed-from-db (admin only). Designed
to be re-runnable — each call wipes the existing bank and re-seeds, so
admins can roll a fresh set whenever the real-lead landscape shifts.
"""
from __future__ import annotations
import json
import logging
import uuid
import random
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import or_
from config import get_settings
from database import Lead, TrainingPersonaBank

logger = logging.getLogger(__name__)


# Voice pool we round-robin through when assigning voices to bank
# personas. Same catalog keys as services.elevenlabs_client.VOICE_CATALOG.
VOICE_POOL_MALE = ["adam_mature", "antoni_warm", "sam_young"]
VOICE_POOL_FEMALE = ["domi_midage", "bella_busy"]


def seed_persona_bank(db, target_count: int = 30) -> dict:
    """Wipe + re-seed the persona bank from a sample of real leads.

    Returns {"created": N, "skipped": N, "errors": [...]} for the admin UI.
    """
    settings = get_settings()
    if not settings.anthropic_api_key:
        return {"created": 0, "skipped": 0, "errors": ["ANTHROPIC_API_KEY not set"]}

    # Wipe existing bank — we always start fresh so admins can re-roll
    db.query(TrainingPersonaBank).delete()
    db.commit()

    leads = _pick_diverse_leads(db, target_count)
    if not leads:
        return {"created": 0, "skipped": 0, "errors": ["No suitable leads found in DB"]}

    created = 0
    skipped = 0
    errors: list[str] = []
    now = datetime.now(timezone.utc).isoformat()

    for lead in leads:
        try:
            persona = _generate_persona_from_lead(lead)
            if not persona:
                skipped += 1
                continue
            row = TrainingPersonaBank(
                id=str(uuid.uuid4()),
                created_at=now,
                source_lead_id=lead.id,
                name=persona.get("name", "Customer"),
                headline=persona.get("headline", ""),
                age=int(persona.get("age", 0) or 0),
                gender=persona.get("gender", ""),
                location=persona.get("location", ""),
                fence_context=persona.get("fence_context", ""),
                backstory=persona.get("backstory", ""),
                traits_json=json.dumps(persona.get("traits", [])),
                default_mood=persona.get("default_mood", "friendly"),
                available_moods_json=json.dumps(
                    persona.get("available_moods", ["friendly", "busy", "skeptical"])
                ),
                voice_id=persona.get("voice_id", "default"),
                active=True,
            )
            db.add(row)
            db.commit()
            created += 1
        except Exception as e:
            db.rollback()
            errors.append(f"lead {lead.id[:8]}: {e}")
            logger.warning(f"Persona seed failed for lead {lead.id}: {e}")

    return {"created": created, "skipped": skipped, "errors": errors}


def _pick_diverse_leads(db, target: int) -> list[Lead]:
    """Pull a varied sample from across the pipeline.

    Strategy: take roughly equal slices from closed-won, in-pipeline,
    declined, and cold buckets so the rep practices against the real
    distribution of customer types — not just the easy closes.
    """
    samples_per_bucket = max(2, target // 4)

    closed = (
        db.query(Lead)
        .filter(Lead.status != "archived")
        .filter(Lead.is_test == False)  # noqa: E712
        .filter(Lead.kanban_column.in_(["hot_lead", "address_correct"]))
        .order_by(Lead.created_at.desc())
        .limit(samples_per_bucket * 2)
        .all()
    )
    pipeline = (
        db.query(Lead)
        .filter(Lead.status != "archived")
        .filter(Lead.is_test == False)  # noqa: E712
        .filter(Lead.kanban_column.in_(["address_correct", "asking_for_address"]))
        .order_by(Lead.created_at.desc())
        .limit(samples_per_bucket * 2)
        .all()
    )
    new_leads = (
        db.query(Lead)
        .filter(Lead.status != "archived")
        .filter(Lead.is_test == False)  # noqa: E712
        .filter(Lead.kanban_column == "new_lead")
        .order_by(Lead.created_at.desc())
        .limit(samples_per_bucket * 2)
        .all()
    )
    review = (
        db.query(Lead)
        .filter(Lead.status != "archived")
        .filter(Lead.is_test == False)  # noqa: E712
        .filter(Lead.kanban_column == "needs_review")
        .order_by(Lead.created_at.desc())
        .limit(samples_per_bucket * 2)
        .all()
    )

    pool: list[Lead] = []
    seen: set[str] = set()
    for bucket in (closed, pipeline, new_leads, review):
        random.shuffle(bucket)
        for lead in bucket[:samples_per_bucket]:
            if lead.id in seen:
                continue
            seen.add(lead.id)
            pool.append(lead)

    if len(pool) < target:
        backfill = (
            db.query(Lead)
            .filter(Lead.status != "archived")
            .filter(Lead.is_test == False)  # noqa: E712
            .order_by(Lead.created_at.desc())
            .limit(target * 2)
            .all()
        )
        for lead in backfill:
            if lead.id in seen:
                continue
            seen.add(lead.id)
            pool.append(lead)
            if len(pool) >= target:
                break

    return pool[:target]


def _generate_persona_from_lead(lead: Lead) -> Optional[dict]:
    """Ask Claude to invent a plausible homeowner consistent with the lead's
    fence shape. Returns a persona dict in the same shape as curated personas.
    """
    settings = get_settings()
    if not settings.anthropic_api_key:
        return None

    try:
        form = json.loads(lead.form_data or "{}")
    except Exception:
        form = {}

    fence_summary = _summarize_fence(form)
    zip_code = (lead.zip_code or "").strip()
    area_hint = _zip_to_area(zip_code) or "the Houston area"

    prompt = f"""Invent a fictional homeowner persona who could plausibly be the owner of the fence described below. This persona will be used to train sales reps — so make the personality vivid and varied. Mix it up — don't always make the persona skeptical or busy.

# Fence on file
{fence_summary}

# Area
{area_hint}

# Output format (JSON only, no prose around it)
{{
  "name": "anonymized first name + initial, e.g. 'Marcus T.'",
  "headline": "one-line summary of who they are as a buyer",
  "age": <integer 28-78>,
  "gender": "male" or "female",
  "location": "{area_hint}",
  "fence_context": "<rewrite the fence shape in 1 sentence, natural language>",
  "backstory": "<2-3 sentences. Job, family, why they're getting a quote, what makes them quirky>",
  "traits": ["<3-5 short trait phrases>"],
  "default_mood": "friendly" | "busy" | "skeptical",
  "available_moods": ["friendly", "busy", "skeptical"]
}}

Output ONLY the JSON. No backticks, no commentary."""

    try:
        import anthropic
        client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
        resp = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
        )
        text = resp.content[0].text.strip() if resp.content else ""
        # Strip ``` fences if Claude adds them anyway
        if text.startswith("```"):
            text = text.strip("`")
            if text.startswith("json"):
                text = text[4:].strip()
        persona = json.loads(text)
    except Exception as e:
        logger.warning(f"Claude persona-gen failed for lead {lead.id}: {e}")
        return None

    # Assign voice_id by gender heuristic
    gender = (persona.get("gender") or "").lower()
    pool = VOICE_POOL_MALE if gender == "male" else VOICE_POOL_FEMALE
    persona["voice_id"] = random.choice(pool) if pool else "default"

    # Safety: clamp moods to known set
    persona["available_moods"] = [
        m for m in persona.get("available_moods", []) if m in ("friendly", "busy", "skeptical")
    ] or ["friendly", "busy", "skeptical"]
    if persona.get("default_mood") not in persona["available_moods"]:
        persona["default_mood"] = persona["available_moods"][0]

    return persona


def _summarize_fence(form: dict) -> str:
    """Boil a lead form_data blob down to a one-paragraph fence shape."""
    parts = []
    sqft = form.get("sqft") or form.get("square_footage")
    linear = form.get("linear_feet") or form.get("fence_linear_feet")
    if sqft:
        parts.append(f"~{sqft} sq ft of fence")
    elif linear:
        parts.append(f"~{linear} linear ft of fence")
    age = form.get("fence_age") or form.get("age_years")
    if age:
        parts.append(f"{age} years old")
    condition = form.get("condition") or form.get("fence_condition")
    if condition:
        parts.append(f"condition described as '{condition}'")
    material = form.get("material") or form.get("fence_material") or "cedar"
    parts.append(f"{material} fence")
    notes = form.get("notes") or form.get("customer_notes") or ""
    if notes and isinstance(notes, str) and len(notes) < 200:
        parts.append(f"notes: '{notes.strip()}'")
    if not parts:
        return "Generic cedar privacy fence, sqft unknown, age unknown."
    return ". ".join(parts) + "."


def _zip_to_area(zip_code: str) -> Optional[str]:
    """Soft zip → area label so personas don't leak street-level addresses.

    Only first-three-digit precision: enough to anchor the persona in a
    plausible Houston-metro neighborhood without identifying the real lead.
    """
    if not zip_code or len(zip_code) < 3:
        return None
    prefix = zip_code[:3]
    # Houston metro coarse map. Anything else → generic.
    bands = {
        "770": "the Houston area",
        "771": "Houston / Pasadena area",
        "772": "Pearland / Galveston area",
        "773": "Kingwood / Humble area",
        "774": "Spring / The Woodlands area",
        "775": "Cypress / Katy area",
        "776": "Sugar Land / Stafford area",
        "777": "Baytown area",
        "778": "Conroe / Magnolia area",
        "779": "Bryan / College Station area",
    }
    return bands.get(prefix, "the greater Houston area")
