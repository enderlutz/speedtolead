"""Customers who wanted Legacy and didn't pay: Alan's call-backs to close (Alan, 2026-11-08).

Alan: "if she sees any call where the customer mentions they want legacy, and
we don't close them on the spot, then those customers are important customers
that I have to call back and close, because I'll negotiate them down to the
signature price."

Why it pays: a solid (Legacy) stain is the fastest to put on and lasts the
longest, so Legacy done for the Signature price still makes more than
Signature itself, and far more than an oil Signature job.

The rules, from the same conversation:
- Stella flags it; only Alan makes the offer. VAs never quote it.
- Never on the first call. It's for the call-back, after they've seen the
  Legacy price.
- Always with a condition: on the schedule within two weeks.
- Valspar solids only. A Sherwin-Williams solid costs far more, so it gets a
  smaller discount Alan names, never the Signature price.
- Every offer is logged on the lead, so the list can show what it closed.

Where it lives: lead.form_data["legacy_interest"] =
    {"at", "recording_id", "quote", "call_at", "by"}
and lead.form_data["legacy_offer"] = {"outcome", "at", "by"}.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

KEY = "legacy_interest"
OFFER_KEY = "legacy_offer"
CHECKED_KEY = "legacy_checked"  # recording ids Stella has already read for this
BACKFILL_DONE_KEY = "stella_legacy_backfill_done"
BACKFILL_DAYS = 60
OFFER_DAYS = 14
OUTCOMES = {"offered": "Offered", "took_it": "Took it", "said_no": "Said no"}

# A cheap first pass so Stella only reads calls that could be about Legacy.
WORDS = re.compile(r"\b(legacy|solid)\b", re.I)

OFFER_LINE = (f"Legacy for the Signature price, if we get you on the schedule "
              f"in the next {OFFER_DAYS // 7} weeks.")
# Valspar solids only (Alan, 2026-11-08). A Sherwin-Williams solid costs us far
# more: a smaller discount Alan names, never down to the Signature price.
OFFER_NOTE = ("Valspar solid colors only. If they want a Sherwin-Williams solid, offer the closest "
              "Valspar match first; a Sherwin-Williams solid gets a smaller discount, never the Signature price.")

TASK = """Read this phone call with a fence staining customer. Our packages: Essential = clear coat, Signature = semi-transparent, Legacy = solid color (lasts the longest).

Question: did the CUSTOMER show real interest in Legacy or a solid color for their own fence? Yes if they said they want it, are leaning to it, liked it, asked its price to consider it, or said it's a little too much. No if only our side described it, or they said they don't want solid, or "darker but not solid".

Also: did the customer insist on a solid from ANOTHER brand or a specific outside color (Behr, Sherwin-Williams, a paint-store color like Black Fox, "our own stain")? Only if they pushed for it; liking a color we can match on our Valspar line doesn't count.

Reply with JSON only:
{"legacy": true|false, "quote": "<the customer's own words that show it, under 160 characters, or empty>", "own_brand": "<the brand or outside color they insisted on, or empty>"}"""


def _form(lead) -> dict:
    try:
        fd = json.loads(lead.form_data or "{}")
    except Exception:  # noqa: BLE001
        return {}
    return fd if isinstance(fd, dict) else {}


def mark(db, lead, recording_id: str, quote: str, call_at: str = "", by: str = "Stella",
         own_brand: str = "") -> None:
    """Write the flag on the lead. The newest call wins. `own_brand` is set
    when the customer insisted on another brand's solid (Alan, 2026-11-08: a
    customer wanted Legacy but ended up on a Behr solid); those get a smaller
    discount Alan names, never the Signature price."""
    fd = _form(lead)
    fd[KEY] = {"at": datetime.now(timezone.utc).isoformat(), "recording_id": recording_id,
               "quote": (quote or "").strip()[:200], "call_at": call_at, "by": by,
               "own_brand": (own_brand or "").strip()[:80]}
    lead.form_data = json.dumps(fd)
    db.commit()


def _checked(db, lead, recording_id: str) -> None:
    fd = _form(lead)
    seen = fd.get(CHECKED_KEY) if isinstance(fd.get(CHECKED_KEY), list) else []
    if recording_id not in seen:
        fd[CHECKED_KEY] = (seen + [recording_id])[-30:]
        lead.form_data = json.dumps(fd)
        db.commit()


def set_offer(db, lead, outcome: str, by: str) -> dict:
    if outcome not in OUTCOMES:
        raise ValueError(outcome)
    fd = _form(lead)
    fd[OFFER_KEY] = {"outcome": outcome, "at": datetime.now(timezone.utc).isoformat(), "by": by}
    lead.form_data = json.dumps(fd)
    db.commit()
    return fd[OFFER_KEY]


def _prices(db, lead_id: str) -> tuple[float, float]:
    from database import Estimate
    est = (db.query(Estimate).filter(Estimate.lead_id == lead_id)
           .order_by(Estimate.created_at.desc()).first())
    if est is None:
        return 0.0, 0.0
    try:
        tiers = json.loads(est.tiers or "{}")
    except Exception:  # noqa: BLE001
        return 0.0, 0.0
    try:
        return float(tiers.get("signature") or 0), float(tiers.get("legacy") or 0)
    except (TypeError, ValueError):
        return 0.0, 0.0


def _paid_ids(db) -> set[str]:
    from database import CustomerPayment, PayLink
    ids = {r[0] for r in db.query(CustomerPayment.lead_id).filter(CustomerPayment.lead_id.isnot(None)).all()}
    ids |= {r[0] for r in db.query(PayLink.lead_id).filter(PayLink.status == "paid").all()}
    return ids


def listing(db) -> dict:
    """Every flagged lead. Open = not paid and not marked done; closed = paid
    after the flag (what the list has made so far)."""
    from database import Lead
    paid = _paid_ids(db)
    rows = db.query(Lead).filter(Lead.form_data.like(f'%"{KEY}"%')).all()
    open_, closed = [], []
    for l in rows:
        fd = _form(l)
        li = fd.get(KEY) if isinstance(fd.get(KEY), dict) else None
        if not li:
            continue
        sig, leg = _prices(db, l.id)
        offer = fd.get(OFFER_KEY) if isinstance(fd.get(OFFER_KEY), dict) else None
        row = {"lead_id": l.id, "name": l.contact_name or "", "phone": l.contact_phone or "",
               "address": l.address or "", "quote": li.get("quote", ""), "call_at": li.get("call_at", ""), "own_brand": li.get("own_brand", ""),
               "signature": sig, "legacy": leg, "offer": offer}
        if l.id in paid or (l.deposit_status or "") == "paid":
            closed.append(row)
        elif not (isinstance(fd.get("bucket_done"), dict) and fd.get("bucket_done")) and not l.do_not_contact \
                and (l.status or "") not in ("archived",):
            open_.append(row)
    # Newest call first: the interest is freshest.
    open_.sort(key=lambda r: r["call_at"] or "", reverse=True)
    closed.sort(key=lambda r: r["call_at"] or "", reverse=True)
    return {"open": open_, "closed": closed, "offer_line": OFFER_LINE, "offer_note": OFFER_NOTE,
            "offers": sum(1 for r in open_ + closed if r["offer"]),
            "offers_closed": sum(1 for r in closed if r["offer"])}


def backfill(db, limit: int = 3) -> dict:
    """Stella reads the last BACKFILL_DAYS of calls for Legacy interest, a
    few per tick, until every candidate is read once."""
    from database import CallIntent, CallRecording, CallTranscript, Lead, SystemConfig
    from services.stella import ask, on
    if not on(db) or SystemConfig.get(db, BACKFILL_DONE_KEY, "") == "1":
        return {"skipped": True}
    since = (datetime.now(timezone.utc) - timedelta(days=BACKFILL_DAYS)).isoformat()
    paid = _paid_ids(db)
    recs = (db.query(CallRecording.id, CallRecording.lead_id, CallRecording.created_at, CallTranscript.full_text)
            .join(CallTranscript, CallTranscript.recording_id == CallRecording.id)
            .filter(CallRecording.created_at >= since, CallRecording.lead_id.isnot(None),
                    CallRecording.is_voicemail.isnot(True), CallRecording.duration_seconds >= 60)
            .order_by(CallRecording.created_at.desc()).all())
    intents = {r[0]: f"{r[1] or ''} {r[2] or ''}" for r in
               db.query(CallIntent.recording_id, CallIntent.wanted, CallIntent.blocker_detail).all()}
    read = 0
    for rid, lead_id, created, text in recs:
        if lead_id in paid or not (WORDS.search(text or "") or WORDS.search(intents.get(rid, ""))):
            continue
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if lead is None:
            continue
        fd = _form(lead)
        if rid in (fd.get(CHECKED_KEY) or []):
            continue
        if read >= limit:
            return {"read": read, "more": True}
        out = ask(db, TASK, (text or "")[:14000], max_tokens=300)
        read += 1
        if out is None:
            return {"read": read, "skipped": "no model"}
        if out.get("legacy"):
            li = fd.get(KEY) if isinstance(fd.get(KEY), dict) else None
            # Keep the newest call's words when a lead has several.
            if li is None or (li.get("call_at") or "") < (created or ""):
                mark(db, lead, rid, out.get("quote", ""), call_at=created or "", own_brand=out.get("own_brand") or "")
        _checked(db, lead, rid)
    SystemConfig.set(db, BACKFILL_DONE_KEY, "1")
    db.commit()
    return {"read": read, "done": True}
