"""
Call analysis service using Claude.
Evaluates Olga's lead intake calls against the call coach rubric.
"""
from __future__ import annotations
import json
import logging
from pathlib import Path
from config import get_settings

logger = logging.getLogger(__name__)


def _load_rubric() -> str:
    """The rubric lives next to this file as call_coach_rubric.md so the
    team can edit it without touching code."""
    rubric_path = Path(__file__).parent / "call_coach_rubric.md"
    try:
        return rubric_path.read_text(encoding="utf-8")
    except Exception as e:
        logger.error(f"Failed to read call coach rubric: {e}")
        return ""


_RUBRIC = _load_rubric()


_ANALYSIS_PROMPT = f"""You are the AI Call Coach for A&T's Fence Staining. Olga is the VA who runs intake calls. Your job is to evaluate one of Olga's recorded calls against the rubric below.

This is NOT a sales call. It is a 3–5 minute warm intake call to gather/confirm the info needed to send a written estimate. Do NOT grade her on closing skill, objection handling, or pitching — those are wrong frames here.

=== RUBRIC ===

{_RUBRIC}

=== END RUBRIC ===

Return a JSON object with this exact schema. Be specific — quote moments from the transcript when possible. No markdown, no commentary outside the JSON.

{{
  "summary": "2-3 sentence summary of how the call went, framed by the rubric (not by sales metrics).",
  "stage_evaluation": [
    {{
      "stage": "1. Greeting",
      "status": "passed | missed | skipped_okay",
      "evidence": "Direct quote or paraphrase from the transcript that justifies the status.",
      "feedback": "Optional — only fill if there's something specific Olga should adjust here."
    }},
    {{ "stage": "2. Address Confirmation", "status": "...", "evidence": "...", "feedback": "" }},
    {{ "stage": "3a. Fence Height/Age/Stained", "status": "...", "evidence": "...", "feedback": "" }},
    {{ "stage": "3b. Fence Sides Confirmed + Read Back", "status": "...", "evidence": "...", "feedback": "" }},
    {{ "stage": "4. Cleaning Lead-In", "status": "...", "evidence": "...", "feedback": "" }},
    {{ "stage": "5. Package Walkthrough (Offered, not forced)", "status": "...", "evidence": "...", "feedback": "" }},
    {{ "stage": "6. Set Estimate Expectations", "status": "...", "evidence": "...", "feedback": "" }},
    {{ "stage": "7. Goodbye", "status": "...", "evidence": "...", "feedback": "" }}
  ],
  "boundary_violations": [
    {{ "type": "price_quoted | date_committed | guessed_answer | forced_packages | other", "evidence": "Direct quote from the transcript.", "severity": "high | medium | low" }}
  ],
  "what_went_well": "One specific thing Olga did well in this call — quote the moment.",
  "next_action": "ONE specific, actionable thing Olga should do differently on her next call. Not a list.",
  "summary_one_line": "A single line Alan can scan in 2 seconds to know what this call was.",
  "sentiment": "positive | neutral | negative",
  "customer_sentiment": "positive | neutral | hesitant | negative",
  "objections": ["any concerns the customer raised — usually empty for intake calls"],
  "key_topics": ["main subjects covered, e.g. 'fence sides', 'package preview'"],
  "customer_data_extracted": {{
    "address_confirmed": true,
    "fence_height": "if mentioned",
    "fence_age": "if mentioned",
    "previously_stained": "if mentioned",
    "fence_sides_confirmed": ["the sides they want stained"],
    "package_explanation_requested": true,
    "questions_for_pm": "any unknowns Olga escalated to the project manager"
  }},
  "call_score": 8,
  "close_likelihood": "intake_complete | needs_followup | off_script"
}}

SCORING:
- call_score is 1-10 based on rubric adherence (not closing skill).
  - 9-10: All stages hit, sides confirmed and read back, no boundary violations, warm and natural.
  - 6-8: Most stages hit, minor misses or stiffness, no boundary violations.
  - 3-5: Critical misses (sides not confirmed, OR boundary violations like quoting price).
  - 1-2: Many critical misses or major boundary violations.

STATUS DEFINITIONS:
- passed: Olga clearly executed this stage.
- missed: This stage should have happened and didn't.
- skipped_okay: Stage was skipped appropriately (e.g., customer said "just send the estimate" so the package walkthrough was skipped — not a miss).

CLOSE_LIKELIHOOD:
- intake_complete: All needed info gathered, ready to send estimate.
- needs_followup: Missing critical info (e.g., no sides confirmed, no address).
- off_script: Olga drifted into pitching/closing territory (boundary violations present).

next_action: ONE thing. Not a list. Make it specific and quote the moment from the call when relevant.
"""


def analyze_call(
    transcript_text: str,
    lead_context: dict | None = None,
    coaching_profile_text: str | None = None,
    recent_reviews: list[dict] | None = None,
) -> dict:
    """
    Analyze a call transcript using Claude Sonnet against the intake-call
    rubric. The static rubric is the primary guide; the optional coaching
    profile + recent reviews are the LIVING calibration overlay so the AI
    coach gets sharper as Alan reviews more calls.

    Returns dict with stage-by-stage evaluation, boundary checks, one-line
    summary, ONE next action, plus the original sentiment/score fields for
    backward compatibility.
    """
    settings = get_settings()
    if not settings.anthropic_api_key:
        logger.warning("ANTHROPIC_API_KEY not configured")
        return _empty_analysis()

    if not transcript_text or len(transcript_text.strip()) < 50:
        logger.warning("Transcript too short for analysis")
        return _empty_analysis()

    import anthropic

    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

    # Build context about the lead if available
    context = ""
    if lead_context:
        name = lead_context.get("contact_name", "Unknown")
        address = lead_context.get("address", "")
        context = f"\n\nCUSTOMER CONTEXT:\nName: {name}\nAddress: {address}"

    # Build the live calibration overlay — profile + recent specific reviews.
    # Kept in the user message (not the cached system prompt) since this
    # changes between calls; the rubric stays cached.
    calibration = ""
    if coaching_profile_text and coaching_profile_text.strip():
        calibration += f"\n\n=== ALAN'S COACHING CALIBRATION (learned from past reviews) ===\n{coaching_profile_text.strip()}\n"
    if recent_reviews:
        calibration += "\n=== RECENT SPECIFIC EXAMPLES OF ALAN'S COACHING ===\n"
        for r in recent_reviews:
            calibration += f"\n[{r.get('created_at', '')}] {r.get('reviewer', 'Admin')}: {r.get('text', '')}\n"
        calibration += "\nUse the profile + recent examples to calibrate your tone, focus, and severity. The static rubric still defines the structure of your response.\n"

    try:
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1500,
            system=[{"type": "text", "text": _ANALYSIS_PROMPT, "cache_control": {"type": "ephemeral"}}],
            messages=[{
                "role": "user",
                "content": f"CALL TRANSCRIPT:{context}{calibration}\n\n{transcript_text}",
            }],
        )

        text = response.content[0].text if response.content else ""

        usage = response.usage
        cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
        cache_create = getattr(usage, "cache_creation_input_tokens", 0) or 0
        logger.info(
            f"Call analysis | input={usage.input_tokens} | output={usage.output_tokens} "
            f"| cache_read={cache_read} | cache_write={cache_create}"
        )

        try:
            clean = text.strip()
            if clean.startswith("```"):
                clean = clean.split("\n", 1)[1] if "\n" in clean else clean
                clean = clean.rsplit("```", 1)[0]
            result = json.loads(clean)

            # Build coaching_tips for backward compat: collapse stage misses
            # + boundary violations into the existing tips array so older
            # UI code keeps rendering useful info.
            tips: list[str] = []
            for stage in result.get("stage_evaluation", []):
                if stage.get("status") == "missed" and stage.get("feedback"):
                    tips.append(f"[Stage {stage.get('stage', '')}] {stage['feedback']}")
            for bv in result.get("boundary_violations", []):
                tips.append(f"[Boundary: {bv.get('type', '')}] {bv.get('evidence', '')}")
            if result.get("next_action"):
                tips.append(f"Next time: {result['next_action']}")

            return {
                "summary": result.get("summary", ""),
                "summary_one_line": result.get("summary_one_line", ""),
                "stage_evaluation": result.get("stage_evaluation", []),
                "boundary_violations": result.get("boundary_violations", []),
                "what_went_well": result.get("what_went_well", ""),
                "next_action": result.get("next_action", ""),
                "coaching_tips": tips,
                "sentiment": result.get("sentiment", "neutral"),
                "customer_sentiment": result.get("customer_sentiment", "neutral"),
                "objections": result.get("objections", []),
                "key_topics": result.get("key_topics", []),
                "customer_data_extracted": result.get("customer_data_extracted", {}),
                "call_score": int(result.get("call_score", 0)),
                "close_likelihood": result.get("close_likelihood", "unknown"),
            }
        except (json.JSONDecodeError, ValueError) as e:
            logger.error(f"Failed to parse analysis JSON: {e}")
            return {
                **_empty_analysis(),
                "summary": text[:500],
            }

    except Exception as e:
        logger.error(f"Call analysis failed: {e}")
        return _empty_analysis()


def _empty_analysis() -> dict:
    return {
        "summary": "",
        "summary_one_line": "",
        "stage_evaluation": [],
        "boundary_violations": [],
        "what_went_well": "",
        "next_action": "",
        "coaching_tips": [],
        "sentiment": "neutral",
        "customer_sentiment": "neutral",
        "objections": [],
        "key_topics": [],
        "customer_data_extracted": {},
        "call_score": 0,
        "close_likelihood": "unknown",
    }
