"""Spitfire-round persona — rapid-fire Q&A drill.

Per user (2026-06-13): "We have to create a mode that just asks them
all the 100-something questions, so they can practice answering and
hear themselves answering. Just like a spitfire round."

Goal: not a conversation, not an evaluation — just rapid Q -> rep
answers -> next Q. The rep gets to practice all ~130 questions in one
sitting, hear themselves answer them, and listen back via the per-turn
audio recordings the existing pipeline already saves.

What this is NOT:
  - Not graded (Claude doesn't judge the answers)
  - Not conversational (no objections, no passive-aggression, no
    follow-ups — that's grill mode's job)
  - Not random — the same full list is asked in shuffled order, so
    after a few runs the rep has seen every question.

Behavior contract baked into the backstory:
  - Read one question at a time. ONE.
  - When the rep finishes answering, give a 1-word transition ("Next.",
    "Got it.", "Moving on.") and ask the NEXT question on the list.
  - Don't evaluate, don't correct, don't follow up. Just keep moving.
  - When the list is exhausted, say "Drill complete — good practice"
    and stop initiating new questions.
"""
from __future__ import annotations
import random
import uuid

from services.training_question_bank import QUESTION_BANK, total_question_count


# Quiet, evenly-paced male voice — a "coach" feel. Sticking with the
# same voice catalog as the other modes so ElevenLabs maps it correctly.
_COACH_VOICE_ID = "adam_mature"


def build_spitfire_persona() -> dict:
    """Build the spitfire coach persona. The full question bank is baked
    into the backstory in shuffled order so the rep doesn't memorize
    sequence — they have to actually answer each one cold."""
    questions = _shuffled_full_bank()
    total = len(questions)

    return {
        "id": f"spitfire:{uuid.uuid4().hex[:10]}",
        "name": "Coach",
        "headline": f"Spitfire round — answer all {total} customer questions",
        "age": 0,
        "gender": "neutral",
        "location": "",
        "fence_context": "",
        "backstory": _build_backstory(questions),
        "traits": [
            "rapid Q&A",
            "no evaluation",
            "no follow-up",
            "moves on every turn",
        ],
        "default_mood": "neutral",
        "available_moods": ["neutral"],
        "voice_id": _COACH_VOICE_ID,
        "source": "spitfire",
        "spitfire_questions": [q for _, q in questions],
        "spitfire_categories": [cat for cat, _ in questions],
        "spitfire_total": total,
    }


def _shuffled_full_bank() -> list[tuple[str, str]]:
    """Flatten the bank into (category, question) tuples in random order.

    We shuffle within the FLAT list — not within each category — so the
    rep gets jolted between topics. (Cleaning chemicals → price objection
    → color choice → trap question.) That mimics how real calls jump
    around rather than letting the rep settle into one mode.
    """
    flat: list[tuple[str, str]] = []
    for cat, questions in QUESTION_BANK.items():
        for q in questions:
            flat.append((cat, q))
    random.shuffle(flat)
    return flat


def _build_backstory(questions: list[tuple[str, str]]) -> str:
    """Compose the spitfire backstory: the full numbered list + tight
    pacing rules. Claude is told explicitly to track which question it's
    on and never repeat or skip."""
    numbered = "\n".join(
        f"  {i+1}. {q}" for i, (_, q) in enumerate(questions)
    )
    total = len(questions)
    return (
        "You are a sales coach running a SPITFIRE ROUND with a fence-staining sales rep. "
        "This is a rapid Q&A drill — the rep is practicing their answers to a complete bank "
        "of real customer questions. Your ONLY job is to read the next question and let them "
        "answer.\n\n"
        f"THE FULL LIST OF {total} QUESTIONS (ask them IN THIS EXACT ORDER, never skip, never "
        f"repeat, never reword):\n"
        f"{numbered}\n\n"
        "STRICT BEHAVIOR RULES:\n"
        "1. Open the call with: \"Alright, spitfire round — I'll fire questions, you answer "
        "the way you would on a real call. Here we go. Question 1: <question 1 text>\"\n"
        "2. After the rep finishes answering, respond with EXACTLY ONE short transition "
        "(rotate between: \"Next.\" / \"Got it.\" / \"Mhm.\" / \"Moving on.\" / \"Okay.\" / "
        "\"Question N: ...\") then immediately read the NEXT question on the list verbatim.\n"
        "3. DO NOT evaluate the rep's answer. Don't say \"good\", don't say \"that was vague\", "
        "don't correct them. Even if they fumble badly. Just move on.\n"
        "4. DO NOT ask follow-up questions. Don't probe. Don't push back. This is NOT grill "
        "mode.\n"
        "5. DO NOT add commentary, anecdotes, or examples. Read the question, hear the answer, "
        "next question. That's the whole loop.\n"
        "6. If the rep asks YOU something mid-drill (\"can you repeat that?\", \"what number "
        "are we on?\"), answer briefly (repeat the question, or say the count) then continue.\n"
        "7. When you've asked ALL " + str(total) + " questions and the rep has answered the "
        "last one, say: \"That's all of them. Drill complete — good practice.\" Then STOP. "
        "Don't ask anything else. Wait for them to end the call.\n\n"
        "TONE:\n"
        "- Steady, professional, even-paced. You're a coach, not a customer.\n"
        "- Each question is ONE LINE. Don't elaborate.\n"
        "- No filler words, no 'um', no warm-up — this is a drill, not a chat.\n"
        "- Speak the questions clearly enough that a transcript would be unambiguous.\n\n"
        "REMEMBER THE STATE: you must track WHICH question you just asked. Look at the "
        "transcript so far to count how many questions you've already asked, and ask the "
        "next one in the list. Never re-ask a question that's already in the transcript."
    )
