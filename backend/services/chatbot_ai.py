"""
Chatbot AI service — Claude Haiku integration for Amy chatbot.
Uses prompt caching to minimize cost on repeated context.
"""
from __future__ import annotations
import logging
from config import get_settings

logger = logging.getLogger(__name__)

# --- System prompt (static, cached) ---
_SYSTEM_BASE = """You are Amy, a friendly and professional customer service assistant for A&T Fence Restoration, a fence staining and restoration company based in Cypress, TX.

ROLE:
- You help customers who have received a proposal/estimate understand their options
- You answer questions about the staining process, pricing tiers, timeline, and what to expect
- You are warm, helpful, and concise — like texting with a knowledgeable team member
- You represent A&T positively but honestly

WHAT YOU KNOW:
- A&T offers fence staining and restoration services in the Houston/Cypress TX area
- The proposal the customer received has pricing tiers (Essential, Signature, Legacy)
- Essential: standard quality stain, great value
- Signature: premium stain with enhanced durability and richer color
- Legacy: top-tier stain with the longest lifespan and deepest color penetration
- Staining typically takes 1-2 days depending on fence size
- A&T uses professional-grade stains applied by experienced crews
- Results typically last 2-4 years depending on the tier chosen

RULES:
- Keep responses SHORT (2-4 sentences max). This is a chat widget, not email.
- Be conversational and friendly, not formal or salesy
- If the customer asks about specific pricing, refer to the numbers in their proposal (provided in context)
- If you genuinely cannot answer a question (scheduling specifics, custom requests, complaints, warranty claims), respond with EXACTLY this prefix: "[ESCALATE]" followed by a brief friendly message saying someone from the team will follow up
- NEVER make up information about scheduling dates, specific warranty terms, or anything not in your context
- NEVER mention that you are an AI or chatbot. You are Amy from A&T.
- Do not use emojis excessively — one per message max, if any
"""


def _build_context_block(customer_name: str, address: str, tiers: dict, breakdown: list) -> str:
    """Build the customer-specific context string."""
    parts = [f"CUSTOMER: {customer_name}", f"ADDRESS: {address}"]

    if tiers:
        parts.append("\nPROPOSAL PRICING:")
        for tier_name, tier_data in tiers.items():
            if isinstance(tier_data, dict):
                price = tier_data.get("total") or tier_data.get("price", "N/A")
                parts.append(f"  {tier_name}: ${price}")
            else:
                parts.append(f"  {tier_name}: {tier_data}")

    if breakdown:
        parts.append("\nBREAKDOWN:")
        for item in breakdown[:10]:  # Cap to avoid huge context
            if isinstance(item, dict):
                desc = item.get("description", item.get("item", ""))
                qty = item.get("sqft", item.get("qty", ""))
                parts.append(f"  - {desc}: {qty} sqft")

    return "\n".join(parts)


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
    Generate a response using Claude Haiku 4.5.

    Returns: (response_text, needs_escalation)
    """
    settings = get_settings()
    if not settings.anthropic_api_key:
        logger.warning("ANTHROPIC_API_KEY not configured — returning fallback")
        return (
            "Thanks for your question! Let me connect you with our team. "
            "Someone will follow up shortly.",
            True,
        )

    import anthropic

    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

    # Build system prompt with caching — static part + customer context
    context_block = _build_context_block(customer_name, address, tiers, breakdown)
    full_system = f"{_SYSTEM_BASE}\n\n{context_block}"

    # Use prompt caching: system prompt is cached across turns
    system_messages = [
        {
            "type": "text",
            "text": full_system,
            "cache_control": {"type": "ephemeral"},
        }
    ]

    # If there's an admin-configured system prompt addition, append it
    if system_prompt and system_prompt.strip():
        system_messages.append({
            "type": "text",
            "text": f"\nADDITIONAL INSTRUCTIONS:\n{system_prompt.strip()}",
        })

    # Build conversation messages from history
    messages = []
    for msg in history[-18:]:  # Keep last 18 messages to stay under limits
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role in ("assistant", "human"):
            messages.append({"role": "assistant", "content": content})
        else:
            messages.append({"role": "user", "content": content})

    # Add the current question
    messages.append({"role": "user", "content": question})

    # Ensure messages alternate properly (Claude requires user/assistant alternation)
    messages = _fix_message_alternation(messages)

    try:
        response = client.messages.create(
            model="claude-sonnet-4-6-20250514",
            max_tokens=300,
            system=system_messages,
            messages=messages,
        )

        text = response.content[0].text if response.content else ""

        # Log token usage for cost monitoring
        usage = response.usage
        logger.info(
            f"Chatbot AI | customer={customer_name} | "
            f"input={usage.input_tokens} | output={usage.output_tokens} | "
            f"cache_read={getattr(usage, 'cache_read_input_tokens', 0)} | "
            f"cache_create={getattr(usage, 'cache_creation_input_tokens', 0)}"
        )

        # Check for escalation signal
        needs_escalation = text.strip().startswith("[ESCALATE]")
        if needs_escalation:
            text = text.replace("[ESCALATE]", "").strip()

        return (text, needs_escalation)

    except anthropic.RateLimitError:
        logger.error("Claude API rate limit hit")
        return (
            "I'm a bit busy right now! Someone from our team will get back to you shortly.",
            True,
        )
    except Exception as e:
        logger.error(f"Claude API error: {e}")
        return (
            "Thanks for your question! Let me connect you with our team. "
            "Someone will follow up shortly.",
            True,
        )


def _fix_message_alternation(messages: list[dict]) -> list[dict]:
    """
    Ensure messages strictly alternate user/assistant.
    Claude API requires this. Consecutive same-role messages get merged.
    """
    if not messages:
        return messages

    fixed = [messages[0]]
    for msg in messages[1:]:
        if msg["role"] == fixed[-1]["role"]:
            # Merge consecutive same-role messages
            fixed[-1]["content"] += "\n" + msg["content"]
        else:
            fixed.append(msg)

    # Must start with "user"
    if fixed and fixed[0]["role"] != "user":
        fixed.insert(0, {"role": "user", "content": "(conversation started)"})

    return fixed
