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

The current sequence's COMPLETE state is provided — every step, every field. You return a complete REPLACEMENT plan that represents the FULL desired state after the admin's instruction is applied. The system will diff your output against the current state and present the diff to the admin for confirmation.

CRITICAL PRESERVATION RULE: For any step or field the admin's instruction does NOT explicitly change, return it EXACTLY as it was in the current state. Do not "tidy up", "improve", reformat, simplify, or strip data. If a step has variants, wait_kind, action_kind=add_tag, etc. — keep all of that intact unless the admin specifically asks to change it. The admin trusts you to be a precise editor, not a redesigner.

Sequence-level schema:
{
  "sequence_name": "<keep current unless admin renamed it>",
  "sequence_description": "<keep current unless admin updated it>",
  "trigger_event": "<keep current unless admin changed the trigger. Format: 'tag_added:<tag name>' (e.g. 'tag_added:estimate sent') or empty for manual-only>",
  "pause_on_events": "<comma-separated list, e.g. 'customer_replied'>",
  "send_window_start_hour": <int 0-23 — sequence-default earliest send hour in local timezone>,
  "send_window_end_hour": <int 0-23 — sequence-default latest send hour>,
  "timezone": "<IANA tz, e.g. 'America/Chicago' — keep current unless admin changed it>",
  "steps": [ <see step schema below> ],
  "reasoning": "<one short sentence — why this plan reflects the admin's intent>"
}

Step schema — every step is one of three action_kinds:

(A) action_kind="send_message" — sends an SMS (or branched SMS):
{
  "position": 0,
  "action_kind": "send_message",
  "wait_kind": "minutes" | "hours" | "calendar_day",
  "delay_hours": <number; for wait_kind=minutes it's MINUTES; for hours it's HOURS; for calendar_day it's NUMBER OF DAYS (1=next day, 2=+2 days, etc.)>,
  "window_start_hour": <optional int 0-23, overrides sequence default for THIS step>,
  "window_start_minute": <optional int 0-59>,
  "window_end_hour": <optional int>,
  "window_end_minute": <optional int>,
  "channel": "sms",
  "message_template": "<SMS body. May include {{customer_first_name}}, {{address}}, etc.>",
  "use_ai_personalization": <bool>,
  "branch_field": "<optional — lead field to branch on, e.g. 'fence_age'. Empty for a single non-branched message>",
  "variants": { "branch_value": "message body for this branch", "_default": "fallback body" },
  "tag_value": "",
  "column_value": ""
}

(B) action_kind="add_tag" — adds a tag in GHL + locally. No customer-facing send:
{
  "position": 3,
  "action_kind": "add_tag",
  "wait_kind": "hours",
  "delay_hours": 0,
  "channel": "sms",
  "tag_value": "<the tag, e.g. 'estimate-followup-continue'>",
  "message_template": "", "use_ai_personalization": false,
  "branch_field": "", "variants": {}, "column_value": ""
}

(C) action_kind="move_column" — moves the lead to a different GHL pipeline stage. No customer-facing send:
{
  "position": 9,
  "action_kind": "move_column",
  "wait_kind": "hours",
  "delay_hours": 0,
  "channel": "sms",
  "column_value": "<GHL pipeline stage ID — preserve the current value unless admin explicitly asks to move to a different stage by name>",
  "message_template": "", "use_ai_personalization": false,
  "branch_field": "", "variants": {}, "tag_value": ""
}

Rules:
- Positions are sequential starting at 0. If you remove a step, re-number.
- Keep message bodies under 320 chars when possible (2 SMS segments).
- Allowed template variables: {{customer_name}}, {{customer_first_name}}, {{first_name}}, {{address}}, {{zip_code}}, {{fence_height}}, {{fence_age}}, {{linear_feet}}, {{previously_stained}}, {{service_timeline}}, {{estimate_low}}, {{estimate_high}}, {{brand}}. Anything else renders empty.
- When admin says "personalize" or "AI polish", set use_ai_personalization=true on that step. Default is false (deterministic templating).
- Channel is "sms" for now. Don't introduce other channels.
- For calendar_day waits, delay_hours is the DAY COUNT (1=next day at window_start, 2=+2 days, etc.).
- For branched messages: branch_field names the lead field to read; variants is a map from value to body; "_default" is the fallback. To convert a branched step to single-message, clear branch_field, empty variants, put body in message_template.
- For add_tag and move_column steps: leave delay_hours=0 unless admin specifically wants a delay before the bookkeeping action. These don't send a customer message and are window-exempt.
- If the admin's instruction is ambiguous, make the safest interpretation and explain in "reasoning". When in doubt, change LESS, not more.
- Do NOT add or remove steps unless the admin asked. Adding a "summary" step or "wait" step on your own is forbidden.
- Do NOT change tag_value or column_value unless admin explicitly named the new tag/column.

Return ONLY the JSON object — no markdown fence, no surrounding prose."""


def _fallback_plan(current: dict, instruction: str) -> dict:
    """Used when Claude is unavailable — returns the current state unchanged
    plus a note explaining why nothing happened. Echoes the full current
    state including new fields so the diff shows zero changes (rather
    than spurious changes from stripped fields)."""
    return {
        "sequence_name": current.get("sequence_name", ""),
        "sequence_description": current.get("sequence_description", ""),
        "trigger_event": current.get("trigger_event", ""),
        "pause_on_events": current.get("pause_on_events", "customer_replied"),
        "send_window_start_hour": current.get("send_window_start_hour"),
        "send_window_end_hour": current.get("send_window_end_hour"),
        "timezone": current.get("timezone", "America/Chicago"),
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

        # Defensive: ensure required keys exist + types coerced. Sequence-
        # level windows/timezone default to the current state to prevent
        # accidental drift if Claude omits them.
        out: dict[str, Any] = {
            "sequence_name": str(plan.get("sequence_name") or current.get("sequence_name") or ""),
            "sequence_description": str(plan.get("sequence_description") or current.get("sequence_description") or ""),
            "trigger_event": str(plan.get("trigger_event") or current.get("trigger_event") or ""),
            "pause_on_events": str(plan.get("pause_on_events") or current.get("pause_on_events") or "customer_replied"),
            "send_window_start_hour": int(plan["send_window_start_hour"]) if plan.get("send_window_start_hour") is not None else current.get("send_window_start_hour"),
            "send_window_end_hour": int(plan["send_window_end_hour"]) if plan.get("send_window_end_hour") is not None else current.get("send_window_end_hour"),
            "timezone": str(plan.get("timezone") or current.get("timezone") or "America/Chicago"),
            "reasoning": str(plan.get("reasoning") or "")[:500],
            "steps": [],
        }
        steps_raw = plan.get("steps") or []
        if not isinstance(steps_raw, list):
            steps_raw = []
        # Index current steps by position so we can fall back to current
        # values when Claude omits a field — defense in depth against the
        # AI accidentally dropping structured data.
        current_by_pos: dict[int, dict] = {}
        for s in (current.get("steps") or []):
            try:
                current_by_pos[int(s.get("position", 0))] = s
            except Exception:
                pass

        for i, s in enumerate(steps_raw):
            if not isinstance(s, dict):
                continue
            pos = int(s.get("position", i))
            cur = current_by_pos.get(pos, {})
            variants_val = s.get("variants")
            if not isinstance(variants_val, dict):
                # Don't accept malformed variants — fall back to current
                # step's variants if present.
                variants_val = cur.get("variants") if isinstance(cur.get("variants"), dict) else {}
            out["steps"].append({
                "position": pos,
                "delay_hours": float(s.get("delay_hours", cur.get("delay_hours", 24))),
                "channel": (str(s.get("channel") or cur.get("channel") or "sms").lower())[:16] or "sms",
                "message_template": str(s.get("message_template") or cur.get("message_template") or "")[:1200],
                "use_ai_personalization": bool(s.get("use_ai_personalization", cur.get("use_ai_personalization", False))),
                "wait_kind": str(s.get("wait_kind") or cur.get("wait_kind") or "hours"),
                "window_start_hour": s.get("window_start_hour") if "window_start_hour" in s else cur.get("window_start_hour"),
                "window_start_minute": int(s.get("window_start_minute", cur.get("window_start_minute", 0)) or 0),
                "window_end_hour": s.get("window_end_hour") if "window_end_hour" in s else cur.get("window_end_hour"),
                "window_end_minute": int(s.get("window_end_minute", cur.get("window_end_minute", 0)) or 0),
                "action_kind": str(s.get("action_kind") or cur.get("action_kind") or "send_message"),
                "tag_value": str(s.get("tag_value") or cur.get("tag_value") or ""),
                "column_value": str(s.get("column_value") or cur.get("column_value") or ""),
                "branch_field": str(s.get("branch_field") or cur.get("branch_field") or ""),
                "variants": variants_val,
            })
        # Re-index positions to guarantee 0..N-1 sequential.
        for idx, s in enumerate(out["steps"]):
            s["position"] = idx
        return out
    except Exception as e:
        logger.error(f"workflow_compiler failed: {e}")
        return _fallback_plan(current, instruction) | {"_error": str(e)}


_STEP_DIFF_FIELDS = (
    "delay_hours", "channel", "message_template", "use_ai_personalization",
    "wait_kind", "window_start_hour", "window_start_minute",
    "window_end_hour", "window_end_minute",
    "action_kind", "tag_value", "column_value", "branch_field",
)


def _variants_differ(a: Any, b: Any) -> bool:
    """Compare variant dicts loosely — both empty/None are equal, key/value
    mismatches surface as differences."""
    a = a or {}
    b = b or {}
    if not isinstance(a, dict) or not isinstance(b, dict):
        return a != b
    if set(a.keys()) != set(b.keys()):
        return True
    return any(str(a.get(k, "")) != str(b.get(k, "")) for k in a.keys())


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
            for k in _STEP_DIFF_FIELDS:
                # None and "" are equivalent for our purposes (optional window).
                bv = before.get(k)
                av = after.get(k)
                if (bv or "") == "" and (av or "") == "":
                    continue
                if str(bv) != str(av):
                    changes.append(k)
            if _variants_differ(before.get("variants"), after.get("variants")):
                changes.append("variants")
            if changes:
                diff.append({"kind": "changed", "position": pos, "before": before, "after": after, "changes": changes})
            else:
                diff.append({"kind": "unchanged", "position": pos, "after": after})

    # Sequence-level changes (name, trigger, send window, etc.) — meta row.
    meta_changes: list[str] = []
    for k in ("sequence_name", "sequence_description", "trigger_event", "pause_on_events",
              "send_window_start_hour", "send_window_end_hour", "timezone"):
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
