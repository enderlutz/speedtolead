"""Per-session brain for the voice training simulator.

The orchestrator handles one back-and-forth turn:
  rep_text -> persona_text

Conversation history is owned by the caller (the WS handler in
api/training.py), which keeps this module stateless and easy to unit
test. The model is Claude Sonnet 4.6 to match the rest of the codebase.

When ANTHROPIC_API_KEY is missing the function returns a polite
fallback line so the loop never deadlocks — Phase 2 will surface the
config gap in the UI.
"""
from __future__ import annotations
import logging
from typing import Optional
from config import get_settings
from services.training_personas import build_system_prompt

logger = logging.getLogger(__name__)


CLAUDE_MODEL = "claude-sonnet-4-6"
MAX_TOKENS_PER_TURN = 220  # Persona replies are 1-3 sentences — generous ceiling


def generate_opening_line(persona: dict, mood: str = "") -> str:
    """First thing the persona says when the call connects.

    Short, in-character greeting. The rep will respond, then the
    conversation continues via `respond_to_rep`.
    """
    history = [
        {
            "role": "user",
            "content": "[The phone just rang and you answered. Give your opening greeting only — one short line.]",
        }
    ]
    return _claude_turn(persona, mood, history) or _fallback_opening(persona)


def respond_to_rep(
    persona: dict,
    history: list[dict],
    rep_text: str,
    mood: str = "",
) -> str:
    """Return the persona's reply to the rep's latest utterance.

    `history` is the full conversation so far in Anthropic-shape:
        [{"role": "assistant", "content": "Hello?"},
         {"role": "user", "content": "Hi Roy, this is Alan from Sterling Fence..."},
         ...]
    The orchestrator appends the new rep_text as a `user` turn and asks
    Claude for the next `assistant` turn. The caller is responsible for
    appending both turns to its own log after this returns.
    """
    appended = list(history) + [{"role": "user", "content": rep_text}]
    return _claude_turn(persona, mood, appended) or _fallback_reply()


def _claude_turn(persona: dict, mood: str, history: list[dict]) -> Optional[str]:
    settings = get_settings()
    if not settings.anthropic_api_key:
        logger.warning("ANTHROPIC_API_KEY not configured — training orchestrator falling back")
        return None

    try:
        import anthropic
        client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
        resp = client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=MAX_TOKENS_PER_TURN,
            system=build_system_prompt(persona, mood),
            messages=history,
        )
        if resp.content and len(resp.content) > 0:
            text = resp.content[0].text.strip()
            return text or None
        return None
    except Exception as e:
        logger.error(f"Claude turn failed in training orchestrator: {e}")
        return None


def _fallback_opening(persona: dict) -> str:
    name = (persona.get("name") or "").split()[0] or "Hello"
    return f"Hello?"


def _fallback_reply() -> str:
    return "Sorry, can you repeat that? My phone cut out for a second."


SCORING_DIMENSIONS = [
    ("discovery", "Asking qualifying questions, surfacing the customer's needs/timeline/budget"),
    ("rapport", "Tone, warmth, mirroring, building trust"),
    ("objection_handling", "Pushing back on price/skepticism/competitor quotes effectively"),
    ("closing", "Asking for the deal, creating urgency, locking in next steps"),
    ("confidence", "Posture, command of pricing, recovering from being thrown off"),
]


def score_call(transcript: list[dict], persona: dict, mood: str = "") -> dict:
    """Run Claude over the full transcript and return a coaching rubric.

    Output shape (also documented in `score_json` consumers):
      {
        "dimensions": {
          "discovery": {"score": 7, "note": "..."},
          "rapport": {"score": 8, "note": "..."},
          "objection_handling": {"score": 5, "note": "..."},
          "closing": {"score": 6, "note": "..."},
          "confidence": {"score": 7, "note": "..."}
        },
        "overall_score": 6.6,
        "summary": "Strong opening but missed the buying signal at turn 9...",
        "highlights": [{"turn_index": 4, "kind": "good"|"missed", "note": "..."}],
        "next_time": ["Ask for the close after the price reveal", ...]
      }

    On any failure (missing key, Claude error, JSON parse failure) returns
    a placeholder envelope so the caller can persist *something*.
    """
    settings = get_settings()
    if not settings.anthropic_api_key:
        return _empty_score("ANTHROPIC_API_KEY not set")
    if not transcript:
        return _empty_score("Empty transcript")

    # Renumber turns + flatten into a coach-friendly transcript
    lines = []
    for idx, turn in enumerate(transcript):
        role = turn.get("role", "")
        content = (turn.get("content") or "").strip()
        if not content:
            continue
        speaker = "REP" if role == "user" else persona.get("name", "PERSONA").upper()
        lines.append(f"[{idx}] {speaker}: {content}")
    flat = "\n".join(lines)

    dim_block = "\n".join(f"- {k}: {desc}" for k, desc in SCORING_DIMENSIONS)
    persona_summary = (
        f"{persona.get('name', 'Persona')} — {persona.get('headline', '')}\n"
        f"Backstory: {persona.get('backstory', '')}\n"
        f"Fence: {persona.get('fence_context', '')}\n"
        f"Mood during call: {mood or persona.get('default_mood', 'friendly')}"
    )

    prompt = f"""You are a senior sales coach reviewing a recorded practice call from a fence-staining sales rep. The persona is fictional — the rep was practicing against an AI homeowner.

# The persona
{persona_summary}

# The full transcript (turn indices in brackets)
{flat}

# Your job
Grade the REP (not the persona) across these 5 dimensions, each 1-10:
{dim_block}

For each dimension, write a 1-sentence note tied to specific turn indices.
Then surface 2-4 highlights — both "good" moments and "missed" moments — each with the turn index.
Finally, write 3 short "next time, try X" tips, concrete and actionable.

# Output (JSON only — no prose, no backticks)
{{
  "dimensions": {{
    "discovery": {{"score": <1-10>, "note": "..."}},
    "rapport": {{"score": <1-10>, "note": "..."}},
    "objection_handling": {{"score": <1-10>, "note": "..."}},
    "closing": {{"score": <1-10>, "note": "..."}},
    "confidence": {{"score": <1-10>, "note": "..."}}
  }},
  "summary": "<2-3 sentence overall verdict>",
  "highlights": [{{"turn_index": <int>, "kind": "good"|"missed", "note": "..."}}, ...],
  "next_time": ["...", "...", "..."]
}}

Be specific. Reference turn indices. Don't sugarcoat — short calls and rep mistakes deserve honest scores. If the call ended before any real conversation, score everything low and say so."""

    try:
        import anthropic
        client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
        resp = client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=1200,
            messages=[{"role": "user", "content": prompt}],
        )
        text = resp.content[0].text.strip() if resp.content else ""
        if text.startswith("```"):
            text = text.strip("`")
            if text.startswith("json"):
                text = text[4:].strip()
        parsed = _safe_json_loads(text)
        if not parsed:
            return _empty_score("Claude returned malformed JSON")
        return _finalize_score(parsed)
    except Exception as e:
        logger.error(f"Coaching score failed: {e}")
        return _empty_score(f"scoring error: {e}")


def _safe_json_loads(text: str) -> Optional[dict]:
    import json as _json
    try:
        return _json.loads(text)
    except Exception:
        # Try to grab JSON from inside a wrapper
        start = text.find("{")
        end = text.rfind("}")
        if 0 <= start < end:
            try:
                return _json.loads(text[start:end + 1])
            except Exception:
                return None
        return None


def _finalize_score(parsed: dict) -> dict:
    """Compute overall_score + clamp dimension scores into safe ranges."""
    dims = parsed.get("dimensions") or {}
    cleaned: dict = {}
    nums: list[int] = []
    for key, _desc in SCORING_DIMENSIONS:
        raw = dims.get(key) or {}
        score = raw.get("score")
        try:
            score = int(score)
        except Exception:
            score = 0
        score = max(0, min(10, score))
        cleaned[key] = {
            "score": score,
            "note": (raw.get("note") or "")[:400],
        }
        nums.append(score)
    overall = round(sum(nums) / len(nums), 1) if nums else 0.0
    highlights = parsed.get("highlights") or []
    if not isinstance(highlights, list):
        highlights = []
    next_time = parsed.get("next_time") or []
    if not isinstance(next_time, list):
        next_time = []
    return {
        "dimensions": cleaned,
        "overall_score": overall,
        "summary": (parsed.get("summary") or "")[:1000],
        "highlights": highlights[:6],
        "next_time": [str(t)[:300] for t in next_time[:5]],
        "status": "scored",
    }


def _empty_score(reason: str) -> dict:
    return {
        "dimensions": {},
        "overall_score": 0.0,
        "summary": "",
        "highlights": [],
        "next_time": [],
        "status": "skipped",
        "skip_reason": reason,
    }
