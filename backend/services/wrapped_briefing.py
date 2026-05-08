"""
Wolf-of-Wall-Street style weekly/monthly briefing for the Wrapped digest.

Claude takes the raw aggregated data + bottleneck info and produces a
structured JSON briefing the frontend renders as separate slides:
  - opening: the headline read on the period
  - situation: why the numbers landed the way they did
  - action: ONE recommended thing to do this week
  - watch: what to keep an eye on next period
  - profanity_used: did we use celebratory profanity? (UI badge)

Voice rules baked into the system prompt (see _SYSTEM_PROMPT below):
  - Direct, blunt, hedge-fund-manager energy
  - Mild celebratory profanity (fuck yeah, beautiful) ALLOWED on real wins
  - Never profane AT the user, ever
  - Sarcasm OK on misses but not insulting
  - Reference real names + numbers, no generic advice
  - Short punchy sentences

The action's deep-link is computed deterministically from the bottleneck
+ outstanding info — Claude only writes the human-readable text. We don't
trust Claude to fabricate URLs.
"""
from __future__ import annotations
import json
import logging
from datetime import datetime, timezone
from typing import Any
from config import get_settings

logger = logging.getLogger(__name__)


_SYSTEM_PROMPT = """You are Alan's fractional COO writing his weekly business briefing. Alan owns Sterling Fence Staining, a home-services company in Texas. He's a serious operator who wants the truth, not corporate fluff.

VOICE — non-negotiable:
- Direct, blunt, hedge-fund-manager energy. Like Jordan Belfort coaching the founder, not the salesman.
- Short punchy sentences. Each paragraph max 3 sentences.
- Address Alan by first name.
- Reference SPECIFIC numbers and names from the data. No generic advice. If you can't reference a real number or name in a sentence, cut the sentence.
- For real wins worth celebrating, mild celebratory profanity is allowed and welcome ("fuck yeah", "beautiful", "now that's a number", "good shit"). Use sparingly — has to feel earned. MAX 2 instances per briefing. NEVER profane AT Alan.
- For misses: sharp but never insulting. Sarcasm is OK ("Three leads in 'Asking for Address' since Tuesday. What are we doing here."). Never curse at him on misses.
- No corporate-speak. No "moving forward", "circle back", "synergy", "low-hanging fruit", "leverage". You'll be fired.

OUTPUT — strict JSON only, this exact schema, nothing else:

{
  "opening": "string — 1-2 sentence top-of-the-week read. The headline.",
  "situation": "string — 1 paragraph, max 3 sentences. What happened, why it probably happened. Reference real numbers and names.",
  "action": "string — ONE recommended action for the coming week. Single sentence imperative. Specific. References real leads/people if applicable.",
  "watch": "string — 1 sentence. What to keep an eye on next period.",
  "profanity_used": boolean
}

Set profanity_used=true if you used celebratory profanity in opening or situation. False otherwise.

Output the JSON object and nothing else. No preamble, no markdown fences, no commentary."""


def _build_user_message(digest: dict[str, Any]) -> str:
    """Format the raw digest into a compact message for Claude."""
    lines: list[str] = []
    lines.append(f"PERIOD: {digest.get('label', '')}  ({digest.get('start')} → {digest.get('end')})")
    lines.append(f"CADENCE: {digest.get('cadence', 'weekly')}")
    lines.append("")

    score = digest.get("score") or {}
    if score:
        lines.append(f"SCORE: {score.get('grade', '?')} ({score.get('value', 0)}/100) — {score.get('reason', '')}")
        lines.append("")

    rev = digest.get("revenue") or 0
    rev_change = digest.get("revenue_change_pct")
    rev_change_str = f"{'+' if (rev_change or 0) >= 0 else ''}{rev_change:.0f}% vs prior" if rev_change is not None else "no prior comparison"
    lines.append(f"REVENUE: ${rev:,.2f} ({rev_change_str})")
    lines.append(f"  prior period: ${digest.get('prev_revenue', 0):,.2f}")
    lines.append(f"  outstanding A/R: ${digest.get('outstanding_total', 0):,.2f} across {digest.get('outstanding_count', 0)} job(s)")
    lines.append("")

    lines.append(f"PIPELINE:")
    lines.append(f"  new leads: {digest.get('new_leads', 0)} ({digest.get('new_leads_change_pct', 'n/a') if digest.get('new_leads_change_pct') is not None else 'n/a'} vs prior)")
    lines.append(f"  estimates sent: {digest.get('estimates_sent', 0)}")
    lines.append(f"  close rate: {digest.get('close_rate', 0)}%")
    lines.append(f"  jobs completed: {digest.get('jobs_completed', 0)}")
    lines.append(f"  jobs scheduled: {digest.get('jobs_scheduled', 0)}")
    lines.append("")

    if digest.get("top_employee"):
        e = digest["top_employee"]
        lines.append(f"TOP CREW: {e['name']} — {e['hours']:.1f}h, ${e['labor_cost']:,.2f} earned")
    if digest.get("top_source"):
        s = digest["top_source"]
        lines.append(f"TOP LEAD SOURCE: {s.get('key')} — {s.get('count', 0)} lead(s)")
    if digest.get("biggest_deal"):
        d = digest["biggest_deal"]
        lines.append(f"BIGGEST DEAL: {d.get('customer_name', '?')} — ${d.get('amount', 0):,.2f} ({d.get('tier') or 'no tier'})")
    if digest.get("most_profitable_job"):
        p = digest["most_profitable_job"]
        lines.append(f"MOST PROFITABLE: {p.get('customer_name', '?')} — ${p.get('profit', 0):,.2f} profit on ${p.get('revenue', 0):,.2f} ({p.get('margin_pct', 0)}% margin)")
    if digest.get("busiest_day"):
        b = digest["busiest_day"]
        lines.append(f"BUSIEST DAY: {b['date']} — {b['jobs']} jobs")
    lines.append("")

    bn = digest.get("bottleneck") or {}
    if bn:
        lines.append(f"BOTTLENECK: {bn.get('stage_label', '?')}")
        lines.append(f"  severity: {bn.get('severity', 'low')}")
        lines.append(f"  evidence: {bn.get('evidence', '')}")
        stuck = bn.get("stuck_leads") or []
        if stuck:
            lines.append("  stuck leads:")
            for sl in stuck[:5]:
                lines.append(f"    - {sl.get('name', '?')} ({sl.get('days_stuck', 0)}d in stage)")
        lines.append("")

    anomalies = digest.get("anomalies") or []
    if anomalies:
        lines.append("WATCH-OUTS:")
        for a in anomalies[:4]:
            lines.append(f"  - {a.get('title', '')} — {a.get('detail', '')}")
        lines.append("")

    return "\n".join(lines)


def generate_briefing(digest: dict[str, Any]) -> dict[str, Any]:
    """Call Claude to produce the briefing. Returns a dict matching the
    schema in _SYSTEM_PROMPT, plus token-usage metadata.

    Falls back to a deterministic stub when ANTHROPIC_API_KEY isn't set
    so the dashboard never breaks in dev or before the secret is wired."""
    settings = get_settings()
    if not settings.anthropic_api_key:
        logger.warning("Wrapped briefing skipped — no ANTHROPIC_API_KEY; returning fallback")
        return _fallback_briefing(digest)

    user_message = _build_user_message(digest)
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
        # Haiku is plenty for this — short structured output, no vision.
        # Tokens are cheap enough we can splurge on temperature for voice.
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=600,
            temperature=0.85,
            system=[{"type": "text", "text": _SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user_message}],
        )
        text = response.content[0].text if response.content else "{}"
        usage = response.usage
        logger.info(f"Wrapped briefing | input={usage.input_tokens} | output={usage.output_tokens}")

        parsed = _parse_briefing(text)
        parsed["_input_tokens"] = usage.input_tokens
        parsed["_output_tokens"] = usage.output_tokens
        return parsed
    except Exception as e:
        logger.error(f"Wrapped briefing generation failed: {e}")
        return _fallback_briefing(digest)


def _parse_briefing(text: str) -> dict[str, Any]:
    """Strip any markdown fences then JSON-parse. If parsing fails, fall
    back to the stub — better to ship a bland briefing than a broken one."""
    cleaned = text.strip()
    # Sometimes models still wrap in ```json ... ``` despite instructions
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
    try:
        obj = json.loads(cleaned)
    except json.JSONDecodeError:
        logger.warning("Wrapped briefing JSON parse failed; using fallback shape with raw text")
        return {"opening": cleaned[:200], "situation": "", "action": "", "watch": "", "profanity_used": False}
    # Defensive defaults
    return {
        "opening": str(obj.get("opening") or "").strip(),
        "situation": str(obj.get("situation") or "").strip(),
        "action": str(obj.get("action") or "").strip(),
        "watch": str(obj.get("watch") or "").strip(),
        "profanity_used": bool(obj.get("profanity_used", False)),
    }


def _fallback_briefing(digest: dict[str, Any]) -> dict[str, Any]:
    """Deterministic placeholder when Claude isn't available. Plain
    English — we don't try to fake the Wolf voice without Claude."""
    rev = digest.get("revenue", 0)
    leads = digest.get("new_leads", 0)
    completed = digest.get("jobs_completed", 0)
    bn = (digest.get("bottleneck") or {}).get("stage_label", "")
    return {
        "opening": f"${rev:,.0f} closed. {completed} jobs done. {leads} new leads.",
        "situation": "Briefing AI is offline — set ANTHROPIC_API_KEY to get the full read.",
        "action": f"Review the {bn} stage" if bn else "Open the Operations tab for the deeper view.",
        "watch": "Outstanding A/R + close rate trend.",
        "profanity_used": False,
        "_input_tokens": 0,
        "_output_tokens": 0,
    }
