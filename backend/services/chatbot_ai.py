"""
Chatbot AI service — placeholder for Claude integration.
Returns canned responses for now. Replace with Claude API calls later.
"""
from __future__ import annotations
import logging

logger = logging.getLogger(__name__)


def get_ai_response(
    customer_name: str,
    address: str,
    tiers: dict,
    breakdown: list,
    question: str,
    history: list[dict],
    system_prompt: str = "",
) -> tuple[str, bool]:
    """
    Generate a response to a customer question.

    Returns: (response_text, needs_escalation)
    - response_text: The chatbot's response
    - needs_escalation: True if the bot can't confidently answer
    """
    # Placeholder — return a friendly canned response
    # TODO: Replace with Claude API call using system_prompt + context
    return (
        "Thanks for your question! Let me look into that for you. "
        "One of our team members will follow up shortly.",
        True,  # Escalate everything for now until Claude is connected
    )
