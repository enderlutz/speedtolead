"""
Workflow Compiler — natural-language instruction → structured sequence diff.

Admin types (or dictates via Web Speech API): "After 24h with no reply,
send 'Hey Joe, checking in on that quote' from the iMessage number. If
they reply, stop."

Claude returns a structured proposal describing the *intended* state of
the sequence after the change. We compute the diff against the current
state, present it to admin, and only apply on explicit confirm. Never
auto-applies.

This module is pure planning — it does NOT write to the DB. The
api/followups.py PUT-sequence endpoints handle persistence after admin
confirms the proposal.
"""
from __future__ import annotations
import json
import logging
from typing import Any

from config import get_settings

logger = logging.getLogger(__name__)


_COMPILER_SYSTEM = """You translate natural-language workflow instructions from an admin into a structured follow-up sequence plan for a Texas home-services SMS engine. Output strict JSON, no markdown fence.

The current sequence's state is provided. You return a complete REPLACEMENT plan — every step the sequence should have AFTER the admin's instruction is applied. The system will diff your output against the current state and present the diff to the admin for confirmation.

Schema:
{
  "sequence_name": "<string — keep current unless admin renamed>",
  "sequence_description": "<string — keep current unless admin updated>",
  "trigger_event": "<string — empty if manual, or one of: lead_created, kanban_changed:estimate_sent, kanban_changed:hot_lead>",
  "pause_on_events": "<comma-separated list, e.g. 'customer_replied'>",
  "steps": [
    {
      "position": 0,
      "delay_hours": 24,
      "channel": "sms",
      "message_template": "<the SMS body, may include {{customer_first_name}}, {{address}}, {{fence_height}}, etc.>",
      "use_ai_personalization": <bool — true if message should be polished by Claude at send time>
    },
    ...
  ],
  "reasoning": "<one short sentence — why this plan reflects the admin's intent>"
}

Rules:
- Positions are sequential starting at 0.
- delay_hours is hours since the PRIOR step's send (or since run start for step 0).
- Keep message bodies short (under 320 chars, fits in 2 SMS segments).
- Allowed template variables: {{customer_name}}, {{customer_first_name}}, {{first_name}}, {{address}}, {{zip_code}}, {{fence_height}}, {{fence_age}}, {{linear_feet}}, {{previously_stained}}, {{service_timeline}}, {{estimate_low}}, {{estimate_high}}, {{brand}}. Anything else will render as empty string.
- When admin says "personalize" or "AI", set use_ai_personalization=true on that step.
- Channel: "sms" is the only supported channel for now. Don't add other channels.
- If admin's instruction is ambiguous, make the safest interpretation and explain in "reasoning".
- Preserve existing steps not mentioned by the admin's instruction.
- NEVER ADD STEPS the admin didn't ask for.

Return ONLY the JSON object."""


def _fallback_plan(current: dict, instruction: str) -> dict:
    """Used when Claude is unavailable — returns the current state unchanged
    plus a note explaining why nothing happened."""
    return {
        "sequence_name": current.get("sequence_name", ""),
        "sequence_description": current.get("sequence_description", ""),
        "trigger_event": current.get("trigger_event", ""),
        "pause_on_events": current.get("pause_on_events", "customer_replied"),
        "steps": current.get("steps", []),
        "reasoning": "Compiler offline (no ANTHROPIC_API_KEY). No changes proposed.",
        "_compiler_unavailable": True,
        "_instruction": instruction,
    }


def compile_instruction(current: dict, instruction: str) -> dict:
    """Translate `instruction` into a proposed sequence plan.

    `current` shape:
      {
        "sequence_name": str, "sequence_description": str,
        "trigger_event": str, "pause_on_events": str,
        "steps": [{position, delay_hours, channel, message_template,
                   use_ai_personalization}, ...]
      }

    Returns the same shape, possibly modified. Never raises — failures
    fall back to current state with `_compiler_unavailable: true` flag.
    """
    settings = get_settings()
    if not settings.anthropic_api_key:
        return _fallback_plan(current, instruction)

    user_msg = (
        "CURRENT SEQUENCE STATE:\n"
        + json.dumps(current, indent=2)
        + "\n\nADMIN INSTRUCTION:\n"
        + instruction.strip()[:2000]
        + "\n\nReturn the COMPLETE new sequence plan as JSON."
    )

    try:
        import anthropic
        client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
        # Sonnet for this — instruction parsing benefits from a stronger
        # model. Output is small and we run it once per edit, so cost
        # is negligible.
        response = client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=2000,
            temperature=0.2,
            system=[{"type": "text", "text": _COMPILER_SYSTEM, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user_msg}],
        )
        text = (response.content[0].text if response.content else "").strip()
        if text.startswith("```"):
            text = text.strip("`")
            if text.startswith("json"):
                text = text[4:]
        try:
            plan = json.loads(text)
        except json.JSONDecodeError as e:
            logger.error(f"workflow_compiler JSON parse failed: {e}; raw: {text[:300]}")
            return _fallback_plan(current, instruction) | {"_parse_error": str(e)}

        # Defensive: ensure required keys exist + types coerced.
        out: dict[str, Any] = {
            "sequence_name": str(plan.get("sequence_name") or current.get("sequence_name") or ""),
            "sequence_description": str(plan.get("sequence_description") or current.get("sequence_description") or ""),
            "trigger_event": str(plan.get("trigger_event") or current.get("trigger_event") or ""),
            "pause_on_events": str(plan.get("pause_on_events") or current.get("pause_on_events") or "customer_replied"),
            "reasoning": str(plan.get("reasoning") or "")[:500],
            "steps": [],
        }
        steps_raw = plan.get("steps") or []
        if not isinstance(steps_raw, list):
            steps_raw = []
        for i, s in enumerate(steps_raw):
            if not isinstance(s, dict):
                continue
            out["steps"].append({
                "position": int(s.get("position", i)),
                "delay_hours": float(s.get("delay_hours", 24)),
                "channel": (str(s.get("channel") or "sms").lower())[:16] or "sms",
                "message_template": str(s.get("message_template") or "")[:1200],
                "use_ai_personalization": bool(s.get("use_ai_personalization", False)),
            })
        # Re-index positions to guarantee 0..N-1 sequential.
        for idx, s in enumerate(out["steps"]):
            s["position"] = idx
        return out
    except Exception as e:
        logger.error(f"workflow_compiler failed: {e}")
        return _fallback_plan(current, instruction) | {"_error": str(e)}


def compute_diff(current: dict, proposed: dict) -> list[dict]:
    """Compute a step-level diff between current + proposed sequences.

    Returns list of {kind: 'added'|'removed'|'changed'|'unchanged',
                     position: int, before?: step, after?: step,
                     changes?: list[str]}.
    Caller renders this in the admin confirmation UI.
    """
    cur_steps = {s["position"]: s for s in (current.get("steps") or [])}
    new_steps = {s["position"]: s for s in (proposed.get("steps") or [])}
    all_positions = sorted(set(cur_steps.keys()) | set(new_steps.keys()))

    diff: list[dict] = []
    for pos in all_positions:
        before = cur_steps.get(pos)
        after = new_steps.get(pos)
        if before and not after:
            diff.append({"kind": "removed", "position": pos, "before": before})
        elif after and not before:
            diff.append({"kind": "added", "position": pos, "after": after})
        else:
            assert before and after
            changes: list[str] = []
            for k in ("delay_hours", "channel", "message_template", "use_ai_personalization"):
                if str(before.get(k)) != str(after.get(k)):
                    changes.append(k)
            if changes:
                diff.append({"kind": "changed", "position": pos, "before": before, "after": after, "changes": changes})
            else:
                diff.append({"kind": "unchanged", "position": pos, "after": after})

    # Sequence-level changes (name, trigger, etc.) — emit a "meta" pseudo-row.
    meta_changes: list[str] = []
    for k in ("sequence_name", "sequence_description", "trigger_event", "pause_on_events"):
        if str(current.get(k, "")) != str(proposed.get(k, "")):
            meta_changes.append(k)
    if meta_changes:
        diff.insert(0, {
            "kind": "meta",
            "changes": meta_changes,
            "before": {k: current.get(k, "") for k in meta_changes},
            "after": {k: proposed.get(k, "") for k in meta_changes},
        })

    return diff
