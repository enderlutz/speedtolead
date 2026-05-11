"""
Follow-up AI — body personalization + opt-out detection.

Two independent capabilities:
  1. `personalize(template, lead, estimate)` — Claude rewrites a follow-up
     message body so it reads natural for THIS customer, using lead +
     estimate context. Falls back to template-variable substitution when
     Claude isn't available.
  2. `detect_opt_out(body)` — Claude classifies whether an inbound message
     is asking us to stop texting. Returns (is_opt_out, confidence,
     reason). Keyword pre-check first to avoid an LLM call on the
     90%-obvious "STOP" reply.

Both gracefully degrade — the follow-up engine never crashes if Claude
is offline.
"""
from __future__ import annotations
import json
import logging
import re
from typing import Any

from config import get_settings

logger = logging.getLogger(__name__)


# -----------------------------------------------------------------------
# Template variables
# -----------------------------------------------------------------------

_VAR_PATTERN = re.compile(r"\{\{\s*(\w+)\s*\}\}")


def _build_vars(lead: Any, estimate: Any | None = None) -> dict[str, str]:
    """Extract substitution vars from a Lead (+ optional Estimate) row."""
    fd: dict = {}
    try:
        if getattr(lead, "form_data", None):
            fd = json.loads(lead.form_data) if isinstance(lead.form_data, str) else (lead.form_data or {})
    except Exception:
        fd = {}
    name = (lead.contact_name or "there").strip()
    first = name.split()[0] if name else "there"
    est_low = float(getattr(estimate, "estimate_low", 0) or 0) if estimate else 0
    est_high = float(getattr(estimate, "estimate_high", 0) or 0) if estimate else 0
    return {
        "customer_name": name,
        "customer_first_name": first,
        "first_name": first,
        "address": (lead.address or "").strip(),
        "zip_code": (lead.zip_code or "").strip(),
        "fence_height": str(fd.get("fence_height", "")),
        "fence_age": str(fd.get("fence_age", "")),
        "linear_feet": str(fd.get("linear_feet", "")),
        "previously_stained": str(fd.get("previously_stained", "")),
        "service_timeline": str(fd.get("service_timeline", "")),
        "estimate_low": f"${est_low:,.0f}" if est_low else "",
        "estimate_high": f"${est_high:,.0f}" if est_high else "",
        "brand": "Sterling Fence Staining",
    }


def render_template(template: str, vars_: dict[str, str]) -> str:
    """Substitute `{{var}}` placeholders. Missing vars render as ''."""
    return _VAR_PATTERN.sub(lambda m: vars_.get(m.group(1), ""), template or "")


# -----------------------------------------------------------------------
# Personalization
# -----------------------------------------------------------------------

_PERSONALIZE_SYSTEM = """You rewrite follow-up SMS bodies for Sterling Fence Staining, a Texas home services company. The owner wants their messages to feel like a human just typed them — casual but professional, short, no corporate stiffness.

Rules:
- Keep it under 320 characters (fits in 2 SMS segments).
- Use the customer's first name once if it fits naturally; don't shoehorn.
- Don't add emojis, hashtags, or signatures — those are added separately.
- Don't make up details (price, dates) that aren't in the context.
- Preserve the intent and tone of the original template. You're polishing, not rewriting from scratch.
- Return ONLY the message body. No quotes, no commentary, no markdown.

If the template has nothing worth personalizing for this lead, return the rendered template verbatim."""


def personalize(template: str, lead: Any, estimate: Any | None = None) -> str:
    """Personalize a message template for a specific lead.

    Strategy:
      1. Substitute `{{vars}}` first (cheap, deterministic).
      2. Ask Claude to polish, passing the substituted text + context.
      3. On any failure, return the substituted-but-unpolished text.

    Never raises — engine treats this as a pure string transform."""
    vars_ = _build_vars(lead, estimate)
    rendered = render_template(template, vars_)

    settings = get_settings()
    if not settings.anthropic_api_key:
        return rendered

    try:
        import anthropic
        client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
        # Build a compact context block — only non-empty fields.
        ctx_lines = [f"{k}: {v}" for k, v in vars_.items() if v]
        user_msg = (
            "Context (only use what's relevant):\n" + "\n".join(ctx_lines)
            + f"\n\nDraft to polish:\n{rendered}"
        )
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=200,
            temperature=0.6,
            system=[{"type": "text", "text": _PERSONALIZE_SYSTEM, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user_msg}],
        )
        text = response.content[0].text if response.content else rendered
        out = text.strip().strip('"').strip()
        # Sanity floor — if Claude returned something weird/short, prefer the rendered template.
        if not out or len(out) < 10:
            return rendered
        return out[:320]
    except Exception as e:
        logger.warning(f"followup_ai.personalize fell back to template render: {e}")
        return rendered


# -----------------------------------------------------------------------
# Opt-out / STOP detection
# -----------------------------------------------------------------------

# Keyword fast-path. Customer says "STOP" / "unsubscribe" / etc. → no LLM call.
_OPT_OUT_KEYWORDS = {
    "stop", "stop texting", "stop messaging", "stop contacting",
    "unsubscribe", "opt out", "opt-out",
    "remove me", "take me off", "do not contact", "don't contact",
    "leave me alone", "stop bothering",
    "quit texting", "no more texts",
    "wrong number",
}

_OPT_OUT_SYSTEM = """You determine whether a customer reply is asking to stop being contacted by a home-services company.

Return strict JSON, no markdown fence:
{"is_opt_out": <bool>, "confidence": <0-100>, "reason": "<short phrase>"}

True examples:
- "stop texting me"
- "please remove me from your list"
- "I'm not interested anymore stop messaging"
- "wrong number stop"

False examples (NOT opt-out):
- "stop by tomorrow" (asking us to visit)
- "I'll stop by your office" (asking to come in)
- "had to stop, will call back" (busy)
- "not interested" alone is NOT opt-out — they just declined the service. Only flag opt-out when they're asking to stop being CONTACTED."""


def _keyword_opt_out(body: str) -> bool:
    if not body:
        return False
    lower = body.lower().strip()
    # Tight match for "STOP" as a standalone reply (per carrier convention).
    if lower in ("stop", "stop.", "stop!", "stop please", "please stop"):
        return True
    for kw in _OPT_OUT_KEYWORDS:
        if kw in lower:
            return True
    return False


def detect_opt_out(body: str) -> tuple[bool, int, str]:
    """Returns (is_opt_out, confidence_pct, reason).

    Keyword pre-check first — if a clear opt-out keyword matches, we
    return immediately. Otherwise we ask Claude for nuanced cases
    ("just text me later please" — NOT opt-out vs. "leave me alone" — IS).

    Never raises. On Claude failure, returns (False, 0, "ai_unavailable")
    so the engine errs on the side of continuing the cadence (admin can
    manually pause if needed)."""
    if not body or not body.strip():
        return (False, 0, "empty")

    if _keyword_opt_out(body):
        return (True, 95, "keyword_match")

    settings = get_settings()
    if not settings.anthropic_api_key:
        return (False, 0, "ai_unavailable")

    try:
        import anthropic
        client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=120,
            temperature=0.0,
            system=[{"type": "text", "text": _OPT_OUT_SYSTEM, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": body.strip()[:500]}],
        )
        text = (response.content[0].text if response.content else "").strip()
        # strip possible fence
        if text.startswith("```"):
            text = text.strip("`")
            if text.startswith("json"):
                text = text[4:]
        obj = json.loads(text)
        return (
            bool(obj.get("is_opt_out", False)),
            int(obj.get("confidence", 0) or 0),
            str(obj.get("reason", ""))[:120],
        )
    except Exception as e:
        logger.warning(f"detect_opt_out fell through: {e}")
        return (False, 0, "ai_unavailable")
