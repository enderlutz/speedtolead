"""What a job really comes to, for the bill and the Invoice Queue.

1. The total we texted (Alan, 2026-10-29): a job record
   still had the first quote ($3,044.40) after Alan texted the customer a
   final total with 5.5 more rails ($3,456.90). "If I would have had an
   employee doing it, they would have sent out the wrong one." So the latest
   itemized total texted to the customer is read back: bullet lines, each
   ending in a dollar amount, plus a "Total: $X" line, and only trusted when
   the lines add up to the total. When it differs from what the records
   say, the bill is built from the text.

2. A quick $250's job (Alan, 2026-10-29): a quick $250 has no package, so
   the Deposit sent column had no job total. The guess: the package last
   named on the customer's most recent call, priced from their estimate.
   No call, or no package named: their estimate's Signature price, marked
   as a guess.
"""
from __future__ import annotations

import json
import re

from database import CallRecording, CallTranscript, Estimate, Message

_BULLET = re.compile(r"^\s*[•\-\*·]\s*(.+?):\s*\$([\d,]+(?:\.\d{1,2})?)", re.M)
_TOTAL = re.compile(r"\bTotal:\s*\$([\d,]+(?:\.\d{1,2})?)", re.I)


def _dollars(s: str) -> float:
    return float(s.replace(",", ""))


def parse_quote(body: str) -> dict | None:
    """{"total", "lines": [{"name", "amount"}]} when the text is an itemized
    total whose lines add up; else None."""
    m = _TOTAL.search(body or "")
    if not m:
        return None
    total = _dollars(m.group(1))
    lines = [{"name": n.strip(), "amount": _dollars(a)} for n, a in _BULLET.findall(body[:m.start()])]
    if not lines or abs(sum(l["amount"] for l in lines) - total) > 0.5:
        return None
    return {"total": round(total, 2), "lines": lines}


# A texted line becomes a real invoice line (Alan, 2026-10-29: "that's how
# you make a real invoice"): the item as named in Quick add, how many, and
# the price each. "30 cedar pickets at $10" → Picket Replacement (Cedar),
# 30 × $10; "5.5 more 2x4 rails" joins the 7 rails → 2x4 Rails, 12.5 × $75.
_QTY = re.compile(r"^\s*(\d+(?:\.\d+)?)\s+(?:more\s+)?", re.I)
_EACH = re.compile(r"\bat\s+\$([\d,]+(?:\.\d{1,2})?)", re.I)
_ITEMS = [
    (re.compile(r"picket", re.I), lambda t: "Picket Replacement (Pine)" if re.search(r"\bpine\b", t, re.I) else "Picket Replacement (Cedar)"),
    (re.compile(r"\b(rails?|2x4s?)\b", re.I), lambda t: "2x4 Rails"),
    (re.compile(r"\bposts?\b", re.I), lambda t: "Post Replacement"),
    (re.compile(r"\brot ?boards?\b", re.I), lambda t: "Rotboard"),
    (re.compile(r"\bcaps?\b", re.I), lambda t: "Top Of Caps"),
]
_STAIN_WORDS = re.compile(r"^\s*(?:fence\s+)?cleaning\s+(?:and|&)\s+staining\b[\s,:(-]*", re.I)


def _num(q: float) -> float | int:
    return int(q) if float(q).is_integer() else round(q, 2)


def _fence_name(text: str) -> str:
    t = text.lower()
    if "solid" in t:          # solid and semi-solid = Legacy
        return "Legacy Finish- Fence Staining"
    if re.search(r"transparent|\boil\b|signature", t):
        return "Signature Finish- Fence Staining"
    if "essential" in t:
        return "Essential Finish- Fence Staining"
    return "Fence Staining"


def quote_items(lines: list[dict], fence_name: str = "") -> list[dict]:
    """[{"name", "qty", "unit_price", "description"}] from a texted quote's
    lines, same items merged. fence_name: the staining line's name from the
    job's records, so the package matches."""
    out: list[dict] = []
    for l in lines:
        text, amount = l["name"], float(l["amount"])
        if re.search(r"\bstain", text, re.I) and not any(rx.search(text) for rx, _ in _ITEMS[:3]):
            rest = _STAIN_WORDS.sub("", text).strip(" ()")
            desc = " · ".join(b for b in ["Cleaning & staining of the fence", rest] if b)
            out.append({"name": fence_name or _fence_name(text), "qty": 1, "unit_price": round(amount, 2), "description": desc})
            continue
        name = next((f(text) for rx, f in _ITEMS if rx.search(text)), None)
        q = _QTY.match(text)
        qty = float(q.group(1)) if q else 1.0
        each = _EACH.search(text)
        unit = _dollars(each.group(1)) if each else (amount / qty if qty else amount)
        if not name or not qty or abs(qty * unit - amount) > 0.01:
            out.append({"name": text, "qty": 1, "unit_price": round(amount, 2), "description": ""})
            continue
        same = next((o for o in out if o["name"] == name and abs(o["unit_price"] - unit) < 0.005), None)
        if same:
            same["qty"] = _num(same["qty"] + qty)
        else:
            out.append({"name": name, "qty": _num(qty), "unit_price": round(unit, 2), "description": ""})
    return out


def texted_quote(db, lead_id: str) -> dict | None:
    """The latest itemized total texted to the customer, or None."""
    rows = (db.query(Message.body, Message.created_at)
            .filter(Message.lead_id == lead_id, Message.direction == "outbound", Message.body.ilike("%Total:%"))
            .order_by(Message.created_at.desc()).limit(20).all())
    for body, at in rows:
        q = parse_quote(body or "")
        if q:
            return {**q, "sent_at": at or ""}
    return None


_TIER_WORDS = {
    "legacy": re.compile(r"\b(legacy|solid (?:colou?r|stain))\b", re.I),
    "signature": re.compile(r"\b(signature|semi[- ]?transparent|semi)\b", re.I),
    "essential": re.compile(r"\bessential\b", re.I),
}


def tier_from_text(text: str) -> str:
    """The package named last in a conversation, or ""."""
    best, pos = "", -1
    for tier, rx in _TIER_WORDS.items():
        for m in rx.finditer(text or ""):
            if m.start() > pos:
                best, pos = tier, m.start()
    return best


def guess_total(db, lead_id: str) -> dict | None:
    """{"total", "tier", "why"} for a job with no total on record, or None."""
    est = (db.query(Estimate).filter(Estimate.lead_id == lead_id, Estimate.tiers.isnot(None))
           .order_by(Estimate.created_at.desc()).first())
    try:
        tiers = json.loads(est.tiers or "{}") if est else {}
    except (TypeError, ValueError):
        tiers = {}
    tiers = {k: float(v or 0) for k, v in tiers.items() if k in _TIER_WORDS and float(v or 0) > 0}
    if not tiers:
        return None
    rec = (db.query(CallTranscript.full_text).join(CallRecording, CallTranscript.recording_id == CallRecording.id)
           .filter(CallRecording.lead_id == lead_id, CallTranscript.full_text.isnot(None))
           .order_by(CallRecording.created_at.desc()).first())
    tier = tier_from_text(rec[0]) if rec else ""
    if tier in tiers:
        return {"total": round(tiers[tier], 2), "tier": tier, "why": f"{tier.title()} was the package talked about on the last call"}
    if "signature" in tiers:
        return {"total": round(tiers["signature"], 2), "tier": "signature",
                "why": "No package named on a call yet; their estimate's Signature price"}
    return None
