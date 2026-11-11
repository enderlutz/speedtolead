"""David's rulebook (Alan, 2026-11-11): the rules Alan teaches David, the AI
Project Manager, kept on the server the same way Stella's playbook is.

One system_config row, "david_playbook", holding a JSON list of
{"text": ..., "added": "YYYY-MM-DD"} (Houston date). No table of its own.
Every place David shows up reads it from here: the Claude app (MCP tools and
the instructions sent when it connects), the dashboard (Documents ->
David's rules) and the 9 PM job check ("Learned today").

Rule numbers are 1-based everywhere a person sees them.
"""
from __future__ import annotations

import json

from clock import now_ct

PLAYBOOK_KEY = "david_playbook"
MAX_RULE = 1000
MIN_RULE = 8


class RuleError(ValueError):
    """A bad rule or rule number, worded for Alan."""


def _today() -> str:
    return now_ct().strftime("%Y-%m-%d")


def rules(db) -> list[dict]:
    """Every rule, oldest first: [{"n": 1, "text": ..., "added": "YYYY-MM-DD"}]."""
    from database import SystemConfig
    try:
        raw = json.loads(SystemConfig.get(db, PLAYBOOK_KEY, "") or "[]")
    except ValueError:
        raw = []
    out = []
    for r in raw if isinstance(raw, list) else []:
        if isinstance(r, str):
            r = {"text": r, "added": ""}
        if isinstance(r, dict) and (r.get("text") or "").strip():
            out.append({"n": len(out) + 1, "text": r["text"].strip(), "added": r.get("added") or ""})
    return out


def _save(db, items: list[dict]) -> None:
    from database import SystemConfig
    SystemConfig.set(db, PLAYBOOK_KEY, json.dumps(
        [{"text": r["text"], "added": r.get("added", "")} for r in items], ensure_ascii=False))


def _clean(text: str) -> str:
    t = " ".join((text or "").split())
    if len(t) < MIN_RULE:
        raise RuleError("Write the rule out in a full sentence.")
    if len(t) > MAX_RULE:
        raise RuleError(f"Too long ({len(t)} characters); keep a rule under {MAX_RULE}.")
    return t


def _index(items: list[dict], n) -> int:
    try:
        i = int(n)
    except (TypeError, ValueError):
        raise RuleError("Use the rule number, e.g. 3.")
    if not 1 <= i <= len(items):
        raise RuleError(f"No rule {n}. David has {len(items)} rule(s).")
    return i - 1


def teach(db, rule: str) -> dict:
    """Add one rule, dated today (Houston). The same words twice = no new rule.
    Returns {"rule": {...}, "added": bool}."""
    t = _clean(rule)
    items = rules(db)
    for r in items:
        if r["text"].lower() == t.lower():
            return {"rule": r, "added": False}
    new = {"n": len(items) + 1, "text": t, "added": _today()}
    _save(db, items + [new])
    return {"rule": new, "added": True}


def forget(db, n) -> dict:
    """Remove rule number n (1-based); returns the removed rule."""
    items = rules(db)
    gone = items.pop(_index(items, n))
    _save(db, items)
    return gone


def edit(db, n, text: str) -> dict:
    """Reword rule number n; it keeps its original date."""
    items = rules(db)
    i = _index(items, n)
    t = _clean(text)
    if any(j != i and r["text"].lower() == t.lower() for j, r in enumerate(items)):
        raise RuleError("David already has that rule.")
    before = items[i]["text"]
    items[i]["text"] = t
    _save(db, items)
    return {"n": i + 1, "before": before, "text": t, "added": items[i]["added"]}


def learned_on(db, day: str) -> list[dict]:
    """The rules added on that Houston date (YYYY-MM-DD)."""
    return [r for r in rules(db) if r["added"] == day]


def playbook_text(db) -> str:
    """The rules as numbered plain text ('' when David has none)."""
    items = rules(db)
    if not items:
        return ""
    lines = ["DAVID'S RULES (Project Manager, taught by Alan)"]
    lines += [f"{r['n']}. {r['text']}" + (f" ({r['added']})" if r["added"] else "") for r in items]
    return "\n".join(lines)
