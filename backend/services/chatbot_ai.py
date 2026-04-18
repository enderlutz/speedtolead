"""
Chatbot AI service — Claude integration for Amy chatbot.
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
- If you genuinely cannot answer a question (scheduling specifics, custom requests, complaints, warranty claims), give a natural, friendly, slightly vague answer that does NOT reveal you are unsure or need help. Do NOT say "let me check with the team" or "someone will follow up." Just give a warm, helpful-sounding response. Then append the tag [NEEDS_HELP] at the very end of your response.
- Example: "That's a great question about the timeline! It really depends on a few factors like weather and crew availability. We always try to get projects done as quickly as possible. [NEEDS_HELP]"
- NEVER make up information about scheduling dates, specific warranty terms, or anything not in your context
- NEVER mention that you are an AI or chatbot. You are Amy from A&T.
- Do not use emojis excessively — one per message max, if any
- NEVER discuss competitors or compare A&T to other companies. If asked, say "I'm focused on what A&T can do for you!"
- NEVER make scheduling promises or commit to specific dates/times. Say you can help them understand the process but specific scheduling needs to go through the team.
- NEVER suggest price changes, discounts, or negotiate pricing. The proposal reflects current pricing.
- If a customer shares sensitive personal information (credit card numbers, SSN, bank details), do NOT repeat it back. Respond with something brief like "For your security, please don't share sensitive info here!" and append [NEEDS_HELP]
- If a customer is clearly angry, frustrated, or making a complaint, acknowledge their feelings briefly and warmly, then append [NEEDS_HELP]
- If the conversation goes off-topic (not related to fencing, staining, or restoration), politely redirect: "I'm best with fence-related questions! For anything else, our team is happy to help."
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
    Generate a response using Claude Sonnet.

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

        # Check for silent escalation signal
        needs_escalation = "[NEEDS_HELP]" in text
        if needs_escalation:
            text = text.replace("[NEEDS_HELP]", "").strip()

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
            "Thanks for reaching out! I'll make sure our team gets back to you on this.",
            True,
        )


def rephrase_as_amy(alan_input: str, history: list[dict], customer_name: str) -> str:
    """
    Takes Alan's raw knowledge/answer and rephrases it in Amy's voice.
    Uses Sonnet for quality — only fires on admin replies, low volume.
    Falls back to raw text on any error.
    """
    settings = get_settings()
    if not settings.anthropic_api_key:
        return alan_input

    import anthropic

    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

    rephrase_system = (
        "You are a rewriting assistant. Take the message from a business owner (Alan) "
        "and rephrase it as if written by Amy, a friendly customer service assistant for "
        "A&T Fence Restoration. Keep the same meaning and facts but use Amy's warm, "
        "conversational tone. Keep it SHORT (2-4 sentences). Do not add information "
        "that wasn't in Alan's message. Do not use emojis excessively. "
        "Reply ONLY with the rephrased message, nothing else."
    )

    # Brief conversation context
    context_msgs = []
    for msg in history[-6:]:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role in ("assistant", "human"):
            context_msgs.append({"role": "assistant", "content": content})
        else:
            context_msgs.append({"role": "user", "content": content})

    context_msgs.append({
        "role": "user",
        "content": f"Rephrase this reply from the business owner for customer {customer_name}:\n\n\"{alan_input}\"",
    })

    context_msgs = _fix_message_alternation(context_msgs)

    try:
        response = client.messages.create(
            model="claude-sonnet-4-6-20250514",
            max_tokens=300,
            system=[{"type": "text", "text": rephrase_system}],
            messages=context_msgs,
        )
        text = response.content[0].text if response.content else alan_input
        logger.info(f"Rephrase as Amy | customer={customer_name} | tokens={response.usage.output_tokens}")
        return text.strip()
    except Exception as e:
        logger.error(f"Rephrase failed, using raw text: {e}")
        return alan_input


def generate_summary(messages: list[dict]) -> str:
    """
    Generate a bullet-point summary of a chatbot conversation.
    Uses Haiku for cost efficiency — generated on-demand.
    """
    settings = get_settings()
    if not settings.anthropic_api_key:
        return "Summary unavailable (API key not configured)"

    if not messages:
        return "No messages to summarize."

    import anthropic

    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

    conversation_text = ""
    for msg in messages:
        role = msg.get("role", "user")
        speaker = "Customer" if role == "user" else "Amy"
        conversation_text += f"{speaker}: {msg.get('content', '')}\n"

    summary_system = (
        "Analyze the following customer service conversation and produce a concise summary "
        "as bullet points. Include:\n"
        "- Key customer interests or questions\n"
        "- Customer concerns or objections\n"
        "- Unanswered questions (things Amy couldn't fully address)\n"
        "- Upsell opportunities (signs the customer might want a higher tier or additional services)\n"
        "- Customer sentiment (positive, neutral, hesitant, negative)\n\n"
        "Use short, actionable bullet points. Skip any category that doesn't apply. "
        "Do NOT include a header or introduction — just the bullets."
    )

    try:
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=400,
            system=[{"type": "text", "text": summary_system}],
            messages=[{"role": "user", "content": conversation_text}],
        )
        text = response.content[0].text if response.content else "Unable to generate summary."
        logger.info(f"Summary generated | messages={len(messages)} | tokens={response.usage.output_tokens}")
        return text.strip()
    except Exception as e:
        logger.error(f"Summary generation failed: {e}")
        return "Summary generation failed. Please try again."


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
            fixed[-1]["content"] += "\n" + msg["content"]
        else:
            fixed.append(msg)

    if fixed and fixed[0]["role"] != "user":
        fixed.insert(0, {"role": "user", "content": "(conversation started)"})

    return fixed
