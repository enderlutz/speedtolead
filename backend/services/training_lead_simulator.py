"""Build a per-call training persona from a real lead.

Mode 1 of the simulator: rep is staring at lead Diana Smith in the
dashboard and wants to practice the call before dialing her for real.
The persona that picks up the phone is Diana — she knows her own name
and address and what fence she actually has — but the rep still has
to *discover* which sides she wants stained, how urgent it is, her
current mood, and whether she's gotten other quotes. That's the
sales muscle we're training.

Unlike the pre-generated TrainingPersonaBank (anonymized, batched
from a sample), this is built fresh per session and uses the lead's
real identity. Costs nothing if Claude is unavailable — falls back
to a deterministic backstory built from the lead's fields directly.
"""
from __future__ import annotations
import json
import logging
import random
from typing import Optional

from database import Lead
from config import get_settings

logger = logging.getLogger(__name__)


# Voice pools by gender-inferred-from-first-name. Coarse but works for
# the common Texas first-name distribution.
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


# Universal discovery dimensions the persona has decided on (but won't
# volunteer unprompted). The rep has to ask. Phrased so they feel like
# something a real homeowner would have rattling in their head.
URGENCY_OPTIONS = [
    {"label": "asap", "text": "You want this done as soon as possible — your in-laws are visiting in about 3 weeks and your wife wants the back fence presentable."},
    {"label": "soon", "text": "You'd like it done within the next month or two but you're not in a huge rush."},
    {"label": "no_rush", "text": "No real timeline. You're just gathering information right now, might book sometime later this year."},
    {"label": "this_week", "text": "You want it done THIS WEEK if possible — the HOA sent you a friendly reminder about the fence looking weathered."},
    {"label": "spring", "text": "You're thinking sometime in the next month, before the heat really hits."},
]

SIDES_OPTIONS = [
    {"label": "back_only", "text": "Just the back fence — that's the one that looks the worst and faces your patio."},
    {"label": "back_and_one_side", "text": "The back and one of the sides — the side that faces the neighbor's driveway."},
    {"label": "back_and_both_sides", "text": "The back and both sides — everything except the front."},
    {"label": "all_four", "text": "All four sides of the fence. You want it all done."},
    {"label": "sides_only", "text": "Just the two side fences — you share the back with the neighbor and it's their responsibility."},
]

QUOTES_OPTIONS = [
    {"label": "none", "text": "You haven't gotten any other quotes yet. This is the first company you've called."},
    {"label": "one_quote", "text": "You got one other quote already. It was around $1,400. You won't volunteer this unless asked."},
    {"label": "two_quotes", "text": "You already have two quotes: $1,250 and $1,675. You're price-shopping and will ask the rep to beat the lower one."},
    {"label": "called_friend", "text": "A neighbor recommended this company. You haven't gotten other quotes and probably won't."},
]

DECISION_AUTHORITY = [
    {"label": "solo", "text": "You're the decision-maker. You can commit on the call."},
    {"label": "check_with_spouse", "text": "You'll need to check with your spouse before signing anything. You're the gatherer of info, they sign off on the spend."},
    {"label": "wife_called", "text": "Your wife is the one who really wants this done — you're calling on her behalf and don't have strong opinions."},
]

DEFAULT_MOODS = ["friendly", "busy", "skeptical"]


def build_persona_from_lead(lead: Lead, mood: Optional[str] = None) -> dict:
    """Compose the persona Claude will inhabit for this practice call.

    `mood`: optional override. If None, picked randomly from
    {friendly, busy, skeptical} so the rep doesn't know what they're
    walking into.
    """
    real_name = (lead.contact_name or "").strip() or "the homeowner"
    first_name = real_name.split()[0] if real_name else "the homeowner"
    gender = "female" if first_name.lower() in FEMALE_FIRST_NAMES else "male"
    voice_pool = VOICE_POOL_FEMALE if gender == "female" else VOICE_POOL_MALE
    voice_id = random.choice(voice_pool) if voice_pool else "default"

    address = (lead.address or "").strip()
    zip_code = (lead.zip_code or "").strip()
    location_label = address or zip_code or "your area"

    try:
        form = json.loads(lead.form_data or "{}")
    except Exception:
        form = {}
    fence_summary = _summarize_fence(form)

    chosen_mood = mood if mood in DEFAULT_MOODS else random.choice(DEFAULT_MOODS)
    urgency = random.choice(URGENCY_OPTIONS)
    sides = random.choice(SIDES_OPTIONS)
    quotes = random.choice(QUOTES_OPTIONS)
    decider = random.choice(DECISION_AUTHORITY)

    backstory = _build_backstory(
        first_name=first_name,
        urgency=urgency,
        sides=sides,
        quotes=quotes,
        decider=decider,
    )

    headline = (
        f"Real lead from your CRM. They know who they are; you have to discover the rest."
    )

    # Traits seed Claude with shorthand consistent with the discovery facts
    traits = ["real customer", chosen_mood]
    if quotes["label"].startswith("two") or quotes["label"] == "one_quote":
        traits.append("price-shopping")
    if decider["label"] != "solo":
        traits.append("not sole decision-maker")
    if urgency["label"] in ("asap", "this_week"):
        traits.append("urgency on their side")
    elif urgency["label"] == "no_rush":
        traits.append("low urgency — needs nudging")

    return {
        "id": f"live:{lead.id}",
        "name": real_name,
        "headline": headline,
        "age": _infer_age(form),
        "gender": gender,
        "location": location_label,
        "fence_context": fence_summary,
        "backstory": backstory,
        "default_mood": chosen_mood,
        "available_moods": DEFAULT_MOODS,
        "traits": traits,
        "voice_id": voice_id,
        "source": "real_lead_live",
        # Discovery facts the persona "knows" but won't volunteer — Claude
        # uses these via the system prompt to answer truthfully when asked.
        # Kept on the persona dict so the score_call coach can reference them.
        "discovery": {
            "sides": sides,
            "urgency": urgency,
            "quotes": quotes,
            "decider": decider,
        },
    }


def _build_backstory(first_name, urgency, sides, quotes, decider) -> str:
    """Compose a 4-line backstory Claude can stay grounded in."""
    parts = [
        f"You are {first_name}. You called Sterling Fence Staining because you need work done on your fence.",
        f"What you want done (don't volunteer this — answer when asked): {sides['text']}",
        f"Your timeline (don't volunteer — answer when asked): {urgency['text']}",
        f"Other quotes: {quotes['text']}",
        f"Decision authority: {decider['text']}",
        "Behave like a real homeowner — be guarded about info you'd normally hold back, and don't dump everything at once. If the rep asks good qualifying questions, share. If they don't ask, don't tell.",
    ]
    return "\n".join(parts)


def _summarize_fence(form: dict) -> str:
    parts = []
    sqft = form.get("sqft") or form.get("square_footage")
    linear = form.get("linear_feet") or form.get("fence_linear_feet")
    if linear:
        parts.append(f"about {linear} linear ft of fence")
    elif sqft:
        parts.append(f"about {sqft} sq ft of fence")
    age = form.get("fence_age") or form.get("age_years")
    if age:
        parts.append(f"roughly {age} years old")
    condition = form.get("condition") or form.get("fence_condition")
    if condition:
        parts.append(f"condition described as '{condition}'")
    material = form.get("material") or form.get("fence_material") or "cedar"
    parts.append(f"{material} privacy fence")
    if not parts:
        return "A standard cedar privacy fence. The rep should ask about size and age."
    return ". ".join(parts) + "."


def _infer_age(form: dict) -> int:
    """Best-effort age inference from form_data. Falls back to a random
    plausible homeowner age band when nothing is on file."""
    age = form.get("age") or form.get("customer_age")
    if isinstance(age, (int, float)) and 20 < age < 95:
        return int(age)
    # Lead form age not captured anywhere reliable — randomize within a
    # realistic homeowner band for the Houston suburbs (mostly 35-65).
    return random.choice([34, 38, 42, 46, 51, 55, 59, 62, 68])
