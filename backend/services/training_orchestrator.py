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


def score_call(transcript: list[dict], persona: dict) -> dict:
    """Phase 4 — placeholder. Returns an empty score envelope for now.

    Once the coaching layer ships, this returns:
      {
        "dimensions": {"discovery": 7, "rapport": 8, "objection_handling": 5,
                        "closing": 6, "confidence": 7},
        "summary": "Strong opening but missed the buying signal at 02:14...",
        "highlights": [{"turn_index": 4, "kind": "good", "note": "..."}],
        "next_time": ["Ask for the close after the price reveal", ...],
      }
    """
    return {
        "dimensions": {},
        "summary": "",
        "highlights": [],
        "next_time": [],
    }
