"""
Call analysis service using Claude.
Post-call coaching, sentiment analysis, objection detection, and scoring.
"""
from __future__ import annotations
import json
import logging
from config import get_settings

logger = logging.getLogger(__name__)

_ANALYSIS_PROMPT = """You are an expert sales coach for a fence staining company (A&T Pressure Washing, Cypress TX). Analyze this sales call transcript and provide actionable coaching.

The company offers 3 fence staining packages: Essential Seal (entry), Signature Finish (most popular), and Legacy Finish (premium). They serve the Houston area.

Analyze the transcript and return a JSON object with these fields:

{
  "summary": "2-3 sentence summary of the call",
  "coaching_tips": ["tip 1", "tip 2", "tip 3"],
  "sentiment": "positive|neutral|negative",
  "customer_sentiment": "positive|neutral|hesitant|negative",
  "objections": ["objection 1", "objection 2"],
  "key_topics": ["topic 1", "topic 2"],
  "customer_data_extracted": {
    "timeline": "when they want the work done (if mentioned)",
    "budget_concern": true/false,
    "decision_makers": "who else is involved in the decision",
    "fence_condition": "what they said about their fence",
    "competitor_mentions": "any other companies mentioned",
    "referral_potential": "did they mention neighbors or friends who might need service"
  },
  "call_score": 7,
  "close_likelihood": "high|medium|low|lost"
}

COACHING GUIDELINES:
- Score 1-10 based on: rapport building, objection handling, value communication, closing technique, listening skills
- Be specific in coaching tips, not generic. Reference exact moments from the transcript.
- Identify missed opportunities (e.g., customer mentioned neighbor but rep didn't ask about referral)
- Note what went WELL too, not just improvements
- close_likelihood: "high" if customer expressed clear intent, "medium" if interested but undecided, "low" if significant objections, "lost" if customer declined

Return ONLY the JSON object, no markdown formatting, no explanation."""


def analyze_call(transcript_text: str, lead_context: dict | None = None) -> dict:
    """
    Analyze a call transcript using Claude Sonnet.

    Returns dict with summary, coaching_tips, sentiment, objections,
    key_topics, customer_data_extracted, call_score, close_likelihood.
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
        tiers = lead_context.get("tiers", {})
        context = f"\n\nCUSTOMER CONTEXT:\nName: {name}\nAddress: {address}"
        if tiers:
            context += f"\nPricing: Essential ${tiers.get('essential', 'N/A')}, Signature ${tiers.get('signature', 'N/A')}, Legacy ${tiers.get('legacy', 'N/A')}"

    try:
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=800,
            system=[{"type": "text", "text": _ANALYSIS_PROMPT}],
            messages=[{
                "role": "user",
                "content": f"CALL TRANSCRIPT:{context}\n\n{transcript_text}",
            }],
        )

        text = response.content[0].text if response.content else ""

        usage = response.usage
        logger.info(
            f"Call analysis | input={usage.input_tokens} | output={usage.output_tokens}"
        )

        # Parse JSON response
        try:
            # Strip any markdown code block wrapping
            clean = text.strip()
            if clean.startswith("```"):
                clean = clean.split("\n", 1)[1] if "\n" in clean else clean
                clean = clean.rsplit("```", 1)[0]
            result = json.loads(clean)
            return {
                "summary": result.get("summary", ""),
                "coaching_tips": result.get("coaching_tips", []),
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
                "summary": text[:500],
                "coaching_tips": [],
                "sentiment": "neutral",
                "customer_sentiment": "neutral",
                "objections": [],
                "key_topics": [],
                "customer_data_extracted": {},
                "call_score": 0,
                "close_likelihood": "unknown",
            }

    except Exception as e:
        logger.error(f"Call analysis failed: {e}")
        return _empty_analysis()


def _empty_analysis() -> dict:
    return {
        "summary": "",
        "coaching_tips": [],
        "sentiment": "neutral",
        "customer_sentiment": "neutral",
        "objections": [],
        "key_topics": [],
        "customer_data_extracted": {},
        "call_score": 0,
        "close_likelihood": "unknown",
    }
