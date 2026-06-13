"""Build training personas from REAL successful customer journeys.

Per client direction (2026-06-12): instead of curated archetypes, the
simulator now pulls personas from leads that actually converted.

Selection criteria — all three must be true:
  1. At least one CallTranscript on file (we have the customer's words)
  2. At least one Estimate with sent_at populated (estimate went out)
  3. At least one ScheduledJob (they booked — the conversion happened)

For each qualifying lead we send the call transcript + estimate +
scheduled-job context to Claude and ask it to extract a persona that
captures the customer's tone, questions, objections, and what closed
them. Persona uses the real customer's name + city — internal training
only, no PII leaves the dashboard.

Re-runnable: every seed wipes the existing TrainingPersonaBank first
so admins can pull fresh data anytime new conversions land.
"""
from __future__ import annotations
import json
import logging
import uuid
import re
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import desc

from config import get_settings
from database import Lead, Estimate, CallTranscript, ScheduledJob, TrainingPersonaBank

logger = logging.getLogger(__name__)


# Voice pools by gender heuristic. Same catalog keys as elevenlabs_client.VOICE_CATALOG.
FEMALE_FIRST_NAMES = {
    "mary", "jennifer", "linda", "patricia", "elizabeth", "barbara", "susan",
    "jessica", "sarah", "karen", "lisa", "nancy", "betty", "sandra", "ashley",
    "kimberly", "donna", "emily", "michelle", "carol", "amanda", "melissa",
    "deborah", "stephanie", "rebecca", "laura", "sharon", "cynthia", "kathleen",
    "amy", "shirley", "angela", "anna", "brenda", "pamela", "nicole", "samantha",
    "katherine", "christine", "helen", "debra", "rachel", "carolyn", "janet",
    "maria", "diana", "olga", "marcia",
}
VOICE_POOL_MALE = ["adam_mature", "antoni_warm", "sam_young"]
VOICE_POOL_FEMALE = ["domi_midage", "bella_busy"]

# Transcript text cap — long calls get truncated to keep Claude's input
# under control. 12k chars covers most calls; the rest gets summarized
# during Claude's analysis pass anyway.
MAX_TRANSCRIPT_CHARS = 12000


def seed_persona_bank(db, target_count: int = 15) -> dict:
    """Wipe + re-seed the bank from real conversions. Returns counts
    for the admin UI.

    target_count caps how many personas we attempt; if fewer leads
    qualify, we build personas from whatever's available."""
    settings = get_settings()
    if not settings.anthropic_api_key:
        return {"created": 0, "skipped": 0, "errors": ["ANTHROPIC_API_KEY not set"]}

    db.query(TrainingPersonaBank).delete()
    db.commit()

    leads = _pick_converted_leads(db, target_count)
    if not leads:
        return {
            "created": 0,
            "skipped": 0,
            "errors": [
                "No leads found matching all three criteria (call transcript + "
                "estimate sent + scheduled job)"
            ],
        }

    created = 0
    skipped = 0
    errors: list[str] = []
    now = datetime.now(timezone.utc).isoformat()

    for lead in leads:
        try:
            persona = _build_persona_from_conversion(db, lead)
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


def _pick_converted_leads(db, target: int) -> list[Lead]:
    """Return up to `target` leads that satisfy all three criteria,
    most-recently-scheduled first.

    We start from ScheduledJob (most restrictive of the three) and walk
    backward to Lead, then filter to those that also have a transcript
    and an estimate-sent on file."""
    # Most-recently-scheduled jobs first. Pull a wider pool than `target`
    # because some leads will fail the other two checks (no transcript,
    # no estimate sent) and we want to backfill from the next-most-recent.
    candidate_jobs = (
        db.query(ScheduledJob)
        .filter(ScheduledJob.status != "cancelled")
        .order_by(desc(ScheduledJob.job_date), desc(ScheduledJob.created_at))
        .limit(target * 4)
        .all()
    )
    seen_lead_ids: set[str] = set()
    picked: list[Lead] = []
    for job in candidate_jobs:
        if not job.lead_id or job.lead_id in seen_lead_ids:
            continue
        # Criterion 1: at least one transcript with text
        has_transcript = (
            db.query(CallTranscript)
            .filter(CallTranscript.lead_id == job.lead_id)
            .filter(CallTranscript.full_text != "")
            .first()
            is not None
        )
        if not has_transcript:
            continue
        # Criterion 2: at least one estimate sent
        has_estimate = (
            db.query(Estimate)
            .filter(Estimate.lead_id == job.lead_id)
            .filter(Estimate.sent_at != None)  # noqa: E711
            .first()
            is not None
        )
        if not has_estimate:
            continue
        # All three met — pull the Lead row
        lead = db.query(Lead).filter(Lead.id == job.lead_id).first()
        if not lead:
            continue
        seen_lead_ids.add(job.lead_id)
        picked.append(lead)
        if len(picked) >= target:
            break
    return picked


def _build_persona_from_conversion(db, lead: Lead) -> Optional[dict]:
    """Pull every relevant data point for one lead and ask Claude to
    extract a persona from the call transcript + estimate + job context."""
    settings = get_settings()
    if not settings.anthropic_api_key:
        return None

    # Gather context
    transcripts = (
        db.query(CallTranscript)
        .filter(CallTranscript.lead_id == lead.id)
        .filter(CallTranscript.full_text != "")
        .order_by(CallTranscript.created_at)
        .all()
    )
    transcript_text = _flatten_transcripts(transcripts)
    if not transcript_text:
        return None

    latest_estimate = (
        db.query(Estimate)
        .filter(Estimate.lead_id == lead.id)
        .filter(Estimate.sent_at != None)  # noqa: E711
        .order_by(desc(Estimate.sent_at))
        .first()
    )
    job = (
        db.query(ScheduledJob)
        .filter(ScheduledJob.lead_id == lead.id)
        .order_by(desc(ScheduledJob.job_date))
        .first()
    )

    real_name = (lead.contact_name or "").strip() or "Customer"
    first_name = real_name.split()[0] if real_name else "Customer"
    gender = "female" if first_name.lower() in FEMALE_FIRST_NAMES else "male"
    voice_pool = VOICE_POOL_FEMALE if gender == "female" else VOICE_POOL_MALE
    import random as _random
    voice_id = _random.choice(voice_pool) if voice_pool else "default"

    city_or_area = _extract_city(lead.address or "", lead.zip_code or "")

    try:
        form = json.loads(lead.form_data or "{}")
    except Exception:
        form = {}
    fence_summary = _summarize_fence(form)

    estimate_block = ""
    if latest_estimate:
        try:
            tiers = json.loads(latest_estimate.tiers or "{}")
        except Exception:
            tiers = {}
        estimate_block = (
            f"Estimate sent: signature ${tiers.get('signature', '?')}, "
            f"essential ${tiers.get('essential', '?')}, "
            f"legacy ${tiers.get('legacy', '?')}. "
            f"Sent at {latest_estimate.sent_at}."
        )

    job_block = ""
    if job:
        job_block = f"Scheduled job: {job.job_date}."

    prompt = f"""Build a sales-training persona from this REAL successful customer journey.

This customer received an estimate, scheduled the job, and the call(s) below are what they sounded like during the sales process. Capture their personality so a new sales rep can practice against an accurate simulation.

# Customer
Name: {real_name}
Location: {city_or_area}
Fence on file: {fence_summary}
{estimate_block}
{job_block}

# Call transcript(s)
{transcript_text}

# Your task
Output a JSON persona that captures HOW THIS CUSTOMER ACTUALLY BEHAVED on the call. Pay attention to:
- Their tone (rushed, careful, warm, skeptical, etc.)
- The kinds of questions they asked
- Objections they raised and how they got resolved
- What language patterns or phrases stand out
- What ultimately pushed them to convert
- Any quirks worth practicing against

# Output (JSON only — no prose, no backticks)
{{
  "name": "{first_name} {real_name.split()[-1][0] if len(real_name.split()) > 1 else ''}.",
  "headline": "<one-line summary: who they are as a buyer + what closed them>",
  "age": <plausible integer 28-78>,
  "gender": "{gender}",
  "location": "{city_or_area}",
  "fence_context": "<one sentence on the fence shape they have>",
  "backstory": "<3-4 sentences: their situation, what they wanted, how they decided, what objections they raised, what closed them. Stay faithful to the transcript.>",
  "traits": ["<3-5 short trait phrases drawn from the transcript>"],
  "default_mood": "friendly" | "busy" | "skeptical",
  "available_moods": ["friendly", "busy", "skeptical"]
}}

Output ONLY the JSON. No backticks, no commentary."""

    try:
        import anthropic
        client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
        resp = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=900,
            messages=[{"role": "user", "content": prompt}],
        )
        text = resp.content[0].text.strip() if resp.content else ""
        if text.startswith("```"):
            text = text.strip("`")
            if text.startswith("json"):
                text = text[4:].strip()
        persona = json.loads(text)
    except Exception as e:
        logger.warning(f"Claude persona-from-conversion failed for lead {lead.id}: {e}")
        return None

    # Lock in deterministic fields
    persona["voice_id"] = voice_id
    persona["available_moods"] = [
        m for m in persona.get("available_moods", []) if m in ("friendly", "busy", "skeptical")
    ] or ["friendly", "busy", "skeptical"]
    if persona.get("default_mood") not in persona["available_moods"]:
        persona["default_mood"] = persona["available_moods"][0]
    return persona


def _flatten_transcripts(transcripts: list[CallTranscript]) -> str:
    """Concatenate transcripts in chronological order, prefer the
    formatted-segments view when available so speakers are clear,
    cap the total to MAX_TRANSCRIPT_CHARS."""
    parts: list[str] = []
    for t in transcripts:
        if not (t.full_text or "").strip():
            continue
        try:
            segments = json.loads(t.segments or "[]")
            speaker_map = json.loads(t.speaker_map or "{}")
        except Exception:
            segments = []
            speaker_map = {}

        if segments and isinstance(segments, list):
            lines = []
            for seg in segments:
                speaker_id = str(seg.get("speaker", 0))
                speaker_name = speaker_map.get(speaker_id) or f"Speaker {speaker_id}"
                text = (seg.get("text") or "").strip()
                if text:
                    lines.append(f"{speaker_name}: {text}")
            parts.append("\n".join(lines))
        else:
            parts.append(t.full_text)

    joined = "\n\n---\n\n".join(parts)
    if len(joined) > MAX_TRANSCRIPT_CHARS:
        joined = joined[:MAX_TRANSCRIPT_CHARS] + "\n[...transcript truncated...]"
    return joined


def _extract_city(address: str, zip_code: str) -> str:
    """Best-effort city extraction. Falls back to a ZIP-band region label
    so the persona always has somewhere to be from."""
    if address:
        # Common US format: "123 Main St, Cypress, TX 77433"
        parts = [p.strip() for p in address.split(",")]
        if len(parts) >= 2:
            # The part before the state/zip is usually the city
            return parts[1] if not re.search(r"\d", parts[1]) else parts[-2] if len(parts) >= 3 else parts[1]
    return _zip_to_area(zip_code) or "the Houston area"


def _summarize_fence(form: dict) -> str:
    parts = []
    sqft = form.get("sqft") or form.get("square_footage")
    linear = form.get("linear_feet") or form.get("fence_linear_feet")
    if linear:
        parts.append(f"~{linear} linear ft")
    elif sqft:
        parts.append(f"~{sqft} sq ft")
    age = form.get("fence_age") or form.get("age_years")
    if age:
        parts.append(f"{age} years old")
    material = form.get("material") or form.get("fence_material") or "cedar"
    parts.append(f"{material} fence")
    if not parts:
        return "Standard cedar privacy fence."
    return ". ".join(parts) + "."


def _zip_to_area(zip_code: str) -> Optional[str]:
    if not zip_code or len(zip_code) < 3:
        return None
    prefix = zip_code[:3]
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
