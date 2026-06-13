"""Hard-mode persona generator — the "grill call".

Per user spec (2026-06-12): a picky-customer trainer. The persona
asks questions from a curated 141-question bank across 11 categories.
Behavior rules baked into the backstory:

  - Natural conversation, not an interview. Curious customer tone.
  - If the rep sounds hesitant → passive-aggressive tone.
  - If hesitant → ask the same question again (one retry).
  - If still hesitant after the retry → move on to the next question.
    Do NOT try a third time.

Each call randomizes the persona's name, city, fence shape, and the
specific bundle of questions they'll work through. So the same person
can't memorize a script — they have to actually know the material.

Personas are EPHEMERAL — generated on demand, stored only as the
persona_snapshot_json on a TrainingSession row.
"""
from __future__ import annotations
import random
import uuid

from services.training_question_bank import (
    QUESTION_BANK as _QUESTION_BANK,
    STALLING_BEHAVIORS as _STALLING_BEHAVIORS,
)


# Plausible Houston-area names. Mixed first names so the gender heuristic
# in elevenlabs_client can pick the right voice pool.
_FIRST_NAMES_MALE = [
    "James", "Robert", "Michael", "David", "Richard", "Thomas",
    "Charles", "Steven", "Kenneth", "Edward", "Brian", "Ronald",
    "Anthony", "Kevin", "Jason", "Jeffrey", "Ryan", "Stephen",
    "Frank", "Gregory",
]
_FIRST_NAMES_FEMALE = [
    "Patricia", "Linda", "Barbara", "Elizabeth", "Susan", "Nancy",
    "Karen", "Lisa", "Carol", "Sandra", "Margaret", "Sharon",
    "Donna", "Michelle", "Laura", "Cynthia", "Pamela", "Christine",
    "Helen", "Catherine",
]
_LAST_INITIALS = [
    "K.", "P.", "M.", "S.", "T.", "B.", "L.", "G.", "H.", "C.",
    "W.", "R.", "D.", "F.", "J.",
]

_HOUSTON_CITIES = [
    "Cypress", "Katy", "Spring", "The Woodlands", "Sugar Land",
    "Pearland", "Tomball", "Conroe", "Kingwood", "Magnolia",
    "Stafford", "Missouri City",
]

_FENCE_SHAPES = [
    "~180 ft of cedar privacy fence, ~6 years old, mostly weathered gray with a few warped pickets",
    "~240 ft of cedar privacy fence on a corner lot, ~9 years old, never stained",
    "~120 ft of cedar privacy fence around the back yard only, ~4 years old, lightly faded",
    "~300 ft of cedar privacy fence wrapping the whole property, ~7 years old, partial mildew on the north side",
    "~150 ft of cedar privacy fence, ~3 years old, sealed once when the house was new — wants to extend that",
    "~200 ft of cedar privacy fence next to a pool, ~5 years old, chlorine exposure on one side",
]



def build_grill_persona(
    coaching_notes: list[str] | None = None,
    baseline_excerpts: list[str] | None = None,
) -> dict:
    """Generate a fresh challenging-customer persona. Ephemeral — caller
    persists it on the TrainingSession row, doesn't add to the bank.

    Args:
      coaching_notes: accumulated "corvette sandwich" notes from prior
        sessions. Injected into the persona's backstory so the customer
        knows what behaviors an A-rep should demonstrate, and into the
        post-call grading prompt downstream.
      baseline_excerpts: short excerpts from Alan's gold-standard calls
        on the SAME questions, when available. Helps the persona react
        more authentically to the kinds of answers Alan actually gives.
    """
    coaching_notes = [n.strip() for n in (coaching_notes or []) if n and n.strip()]
    baseline_excerpts = [e.strip() for e in (baseline_excerpts or []) if e and e.strip()]

    gender = random.choice(("male", "female"))
    first = random.choice(
        _FIRST_NAMES_MALE if gender == "male" else _FIRST_NAMES_FEMALE
    )
    last_initial = random.choice(_LAST_INITIALS)
    name = f"{first} {last_initial}"

    city = random.choice(_HOUSTON_CITIES)
    fence_shape = random.choice(_FENCE_SHAPES)

    # Per user (2026-06-12): the rep must demonstrate diverse knowledge,
    # so EVERY call must touch all 11 categories. Pick one random question
    # per category (10 askable categories), then shuffle the order so the
    # conversation doesn't march through them predictably.
    questions: list[tuple[str, str]] = []
    for cat, bank in _QUESTION_BANK.items():
        questions.append((cat, random.choice(bank)))
    random.shuffle(questions)

    # Category 11 — silence/stalling behavior. Picked once per call and
    # injected as an instruction in the backstory, not as a question.
    stalling_behavior = random.choice(_STALLING_BEHAVIORS)

    age = random.randint(35, 65)
    voice_id = _voice_for_gender(gender)

    return {
        "id": f"grill:{uuid.uuid4().hex[:10]}",
        "name": name,
        "headline": "Hard mode — picky customer with a list of questions",
        "age": age,
        "gender": gender,
        "location": city,
        "fence_context": fence_shape,
        "backstory": _build_backstory(
            name, fence_shape, questions, stalling_behavior,
            coaching_notes, baseline_excerpts,
        ),
        "traits": [
            "picky",
            "curious",
            "asks one question from every category",
            "passive-aggressive when answers are vague",
            "moves on after one retry",
        ],
        "default_mood": "skeptical",
        "available_moods": ["friendly", "busy", "skeptical"],
        "voice_id": voice_id,
        "source": "grill",
        "grill_question_categories": [cat for cat, _ in questions],
        "grill_questions": [q for _, q in questions],
        "grill_stalling_behavior": stalling_behavior,
        "grill_coaching_notes": coaching_notes,
        "grill_baseline_excerpts": baseline_excerpts,
    }


def _voice_for_gender(gender: str) -> str:
    """Pick a voice that fits the persona's inferred gender. Same pools
    as the conversion seeder so the catalog is consistent."""
    if gender == "female":
        return random.choice(["domi_midage", "bella_busy"])
    return random.choice(["adam_mature", "antoni_warm", "sam_young"])


def _build_backstory(
    name: str,
    fence_shape: str,
    questions: list[tuple[str, str]],
    stalling_behavior: str,
    coaching_notes: list[str] | None = None,
    baseline_excerpts: list[str] | None = None,
) -> str:
    """Compose a backstory that explicitly tells Claude how to behave —
    the system prompt builder embeds the backstory verbatim, so this is
    where the grill personality + question bank gets seeded."""
    question_list = "\n".join(
        f"  {i+1}. ({cat.replace('_', ' ')}) {q}"
        for i, (cat, q) in enumerate(questions)
    )
    first = name.split()[0]

    # Optional injection blocks — leadership coaching notes ("corvette
    # sandwich") and excerpts from Alan's gold-standard calls. Both
    # appear only when the caller passed them.
    extras = ""
    if coaching_notes:
        bullets = "\n".join(f"  - {n}" for n in coaching_notes)
        extras += (
            f"\n\nLEADERSHIP COACHING NOTES (rules from prior calls — a great rep "
            f"will demonstrate these without prompting):\n{bullets}\n"
            f"Push harder if the rep ignores or contradicts these.\n"
        )
    if baseline_excerpts:
        bullets = "\n".join(f"  - {e}" for e in baseline_excerpts)
        extras += (
            f"\n\nHOW A GOLD-STANDARD REP HAS ANSWERED SIMILAR QUESTIONS IN THE PAST "
            f"(reference only — do NOT recite these to the rep; use them to know what "
            f"a confident, specific answer sounds like):\n{bullets}\n"
        )

    return (
        f"You are {first}. You called A&T's Fence Staining because you need work done on your fence "
        f"({fence_shape}). You're a brand-new customer, you've never used this company before, and "
        f"you're picky. You have a specific list of questions you want answered before you'll book.\n\n"
        f"YOUR QUESTIONS FOR THIS CALL — there is ONE from each of 11 different categories, and you "
        f"MUST ask all of them by the end of the call. The category is shown in parentheses for your "
        f"context — do NOT say the category name out loud:\n"
        f"{question_list}\n\n"
        f"HOW TO ASK THEM:\n"
        f"- This is a NORMAL PHONE CONVERSATION, not an interview. Don't list questions one after "
        f"another like a checklist. Weave them in naturally — react to the rep's answer, make a small "
        f"comment, then bring up the next one. Mix the order based on the flow of the conversation.\n"
        f"- Be curious. Phrase questions like a real picky person would: 'Oh, and what about...', "
        f"'Wait, before I forget...', 'Hmm — what if...', 'One more thing...'.\n\n"
        f"HOW TO REACT TO ANSWERS — THIS IS CRITICAL:\n"
        f"1. If the rep gives a CONFIDENT, SPECIFIC answer → react positively ('okay, that makes "
        f"sense', 'gotcha', 'alright'), then move to the next question.\n"
        f"2. If the rep sounds HESITANT — vague answer, 'uh', 'um', dodges the question, gives a "
        f"generic non-answer, says they'll 'find out and get back to you' — then turn PASSIVE-AGGRESSIVE. "
        f"Sigh. Say things like: 'Hmm, okay...', 'I see...', 'That's not really what I asked.', "
        f"'You don't know?', 'Really? You guys do this every day, right?'\n"
        f"3. After the passive-aggressive reaction, ASK THE SAME QUESTION AGAIN — slightly reworded, "
        f"giving them one more shot. ('Let me try that again — what I'm really asking is...').\n"
        f"4. If they STILL can't answer it confidently on that second attempt — DO NOT ask a third "
        f"time. Just say something disappointed like 'Okay... we'll come back to that' or 'Alright, "
        f"moving on.' and pivot to the NEXT question on your list. Hold the dissatisfaction silently.\n"
        f"5. If the rep keeps stumbling across multiple questions, you grow more skeptical, mention "
        f"that you're getting other quotes, and lean toward not booking.\n"
        f"6. If the rep handles most questions well, you warm up by the end and consider booking.\n\n"
        f"TONE:\n"
        f"- Polite on the surface — you're not yelling, you're not cussing. You're a picky customer "
        f"who's evaluating them carefully.\n"
        f"- Passive-aggressive only when they fumble — 'okay...', 'hmm', sighs, 'sure', dry 'thanks'.\n"
        f"- Don't reveal you have a list. The rep should feel like you just keep thinking of things "
        f"to ask, not like you're working through a scorecard.\n"
        f"- Behave like a real person on a real phone call. Use filler words, pauses, partial "
        f"sentences. Don't be robotic.\n\n"
        f"ONE MID-CALL CURVEBALL — you also need to test if the rep can read the room. ONCE "
        f"during this call, somewhere in the middle (NOT in the first two turns, NOT at the very end), "
        f"do this:\n"
        f"  → {stalling_behavior}\n"
        f"Only do this ONCE. After they react, go back to working through your questions normally."
        f"{extras}"
    )
