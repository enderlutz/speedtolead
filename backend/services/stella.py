"""Stella, the AI Sales Manager (Alan, 2026-11-06).

Stella runs on the server around the clock and owns the sales side up to the
$250: she reviews every call, keeps customer profiles up to date from what
customers text, schedules Alan's call-backs, coaches the VAs, and makes sure
no new lead goes a day without a price. Alan closes; customer texts stay his
to send.

Alan trains her. Everything she knows about how Alan wants things done lives
in one playbook (system_config "stella_playbook"), plus the call reviews Alan
writes in the dashboard. Change the playbook and her next call, text or check
follows it, with no deploy.

Pieces:
- calls: services/callback_reminder.py (runs after each call is analyzed)
- texts: read_new_texts(), every 2 minutes
- prices: no_price_check(), once a day at 5:30 PM Houston
Off switch for all of her: system_config stella_on = "0".
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone

from clock import now_ct, to_ct

logger = logging.getLogger(__name__)

NAME = "Stella"
MODEL = "claude-sonnet-5-5"
SWITCH_KEY = "stella_on"
PLAYBOOK_KEY = "stella_playbook"
TEXTS_SEEN_KEY = "stella_texts_seen_at"
PRICE_CHECK_KEY = "stella_price_check_day"
SKIP_STATUSES = {"closed", "archived"}

# What Alan has taught so far. The live copy is the system_config row; this
# is only the starting point when that row is empty.
DEFAULT_PLAYBOOK = """STELLA'S PLAYBOOK (trained by Alan)

Who we are: Sterling Fence Staining, Houston. Alan is the owner and closes every deal. VAs: Amy (Olga) and Lily (Gioconda).

Packages: Essential = clear coat (2-3 yrs, newer fences). Signature = semi-transparent (4-5 yrs, most popular, wood grain shows). Legacy = solid (lasts the LONGEST, 5-8 yrs, covers imperfections). Redwood Naturaltone is a Signature color.
Oil-based is on its way out (uses far more gallons, unprofitable): never push or write Ready Seal colors (Pecan, Redwood, Dark Walnut) into notes, bookings or drafts. Steer to water-based Valspar browns (Chocolate Chips, Reindeer, Cowboy Suede). Only if the customer insists, flag it for Alan.
Customers pick the color on cleaning day from sample sticks on their fence.
The deal: second coat free through Thanksgiving, every board back-brushed. NEVER "20% off" or a "normal price". No discount without a real reason (referral: $100 off for them and $100 off the neighbor). Same price cash or card, tax included.
Repairs: never ask for photos or board counts. Picket $14, rot board $50, cap $85, rail $75. Count and confirm on cleaning day. Loose boards get screwed in free.
$250 holds the day, the rest when we finish.

VA call order (not word for word, but this order): intro, confirm address, confirm sides, main reason, fence age + "probably some gray and sprinkler stains", the whole process (clean day soft wash, then stain day; usually one coat, second coat free through Thanksgiving; back-brushed), what look/color, send the proposal and walk all three packages, Signature semi vs Legacy solid, a day, the $250.
Flag: skipped or out-of-order steps, a color that doesn't fit the package, "yes sir" to a woman, the fake 20% off, asking for photos, letting "I'm getting another bid" go unanswered (answer: what to compare: 2 coats, back-brushed, soft wash, warranty, tax included).

Always read the WHOLE file (every call, every text, the estimate, the booking) before deciding anything. Flag anything that doesn't match (sides said on a call vs sides on the estimate, color vs package, a held day they said not to hold).

Texts to Alan: short lines, emojis for sections, no phone numbers, no links (he works from the GHL contact).
Call-back reminders start "📞 CALL NOW ❗❗❗" then the name only.
Texts written for Alan to send: sound like Alan, never put the person's name in, super simple. Crew texts: no names, short plain lines.
"""


def on(db) -> bool:
    from database import SystemConfig
    return SystemConfig.get(db, SWITCH_KEY, "1") != "0"


def playbook(db) -> str:
    """Everything Alan has taught Stella, plus his latest call reviews."""
    from database import SystemConfig
    text = SystemConfig.get(db, PLAYBOOK_KEY, "") or DEFAULT_PLAYBOOK
    try:
        from services.coaching_profile import fetch_recent_reviews
        reviews = fetch_recent_reviews(db, limit=5)
    except Exception:  # noqa: BLE001
        reviews = []
    if reviews:
        text += "\nALAN'S LATEST CALL REVIEWS (follow how he thinks):\n"
        for r in reviews:
            text += f"- {r.get('created_at', '')[:10]}: {r.get('text', '')[:500]}\n"
    return text


def teach(db, lesson: str) -> str:
    """Add one lesson from Alan to the playbook and return the new playbook."""
    from database import SystemConfig
    current = SystemConfig.get(db, PLAYBOOK_KEY, "") or DEFAULT_PLAYBOOK
    stamp = now_ct().strftime("%Y-%m-%d")
    updated = current.rstrip() + f"\n- ({stamp}) {lesson.strip()}\n"
    SystemConfig.set(db, PLAYBOOK_KEY, updated)
    db.commit()
    return updated


def ask(db, task: str, file_text: str, max_tokens: int = 1500) -> dict | None:
    """One question to Stella: her playbook + the task, JSON back."""
    from config import get_settings
    key = get_settings().anthropic_api_key
    if not key:
        return None
    import anthropic
    client = anthropic.Anthropic(api_key=key)
    resp = client.messages.create(
        model=MODEL, max_tokens=max_tokens,
        system=[{"type": "text", "text": f"You are {NAME}, the Sales Manager at Sterling Fence Staining.\n\n{playbook(db)}"},
                {"type": "text", "text": task, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": file_text}],
    )
    text = (resp.content[0].text if resp.content else "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0]
    return json.loads(text)


def text_alan(message: str, scheduled_at: int | None = None) -> bool:
    from config import get_settings
    from services import ghl
    owner = (get_settings().owner_ghl_contact_id or "").strip()
    if not owner:
        return False
    return ghl.send_sms(owner, message[:1100], scheduled_at=scheduled_at)


# ── Texts: keep every customer's profile up to date ──────────────────────

TEXT_TASK = """A customer just texted us. You get their whole file. Do two things.

1. Pull out anything NEW they told us that belongs in their profile: street address, zip, email, which sides, color, package, who referred them, timing/when they want it, a spouse deciding, anything a crew or Alan must know. Only things the customer actually said in these new texts. Don't repeat what's already in the notes.

2. Decide if Alan should hear about it right now: they want to book or pay, picked a day, asked a question nobody answered, are upset, said they're going with someone else, or a hot deal is moving. Routine answers ("just the inside", "ok thanks") are NOT urgent. If urgent, write a short reply Alan could send (sounds like Alan, no names, super simple).

Reply with JSON only:
{"address": "" , "zip": "", "email": "", "note": "<one or two short lines of new facts, or empty>", "urgent": true|false, "why": "<one short line>", "reply": "<draft reply or empty>"}"""


def _texts_file(db, lead, new_msgs) -> str:
    from database import Booking, Estimate, Message
    fd = {}
    try:
        fd = json.loads(lead.form_data or "{}")
    except Exception:  # noqa: BLE001
        pass
    for k in ("booking_draft", "invite_from_call", "callback_reminders"):
        fd.pop(k, None)
    est = (db.query(Estimate).filter(Estimate.lead_id == lead.id)
           .order_by(Estimate.created_at.desc()).first())
    bk = db.query(Booking).filter(Booking.lead_id == lead.id).first()
    lines = [
        f"TODAY (Houston): {now_ct():%A %Y-%m-%d %I:%M %p}",
        f"CUSTOMER: {lead.contact_name} · {lead.address} {lead.zip_code or ''} · email {lead.contact_email or ''} · status {lead.status}",
        f"NOTES: {json.dumps(fd)[:2000]}",
        f"ESTIMATE: {est.tiers if est is not None else 'none yet'}",
    ]
    if bk is not None:
        lines.append(f"BOOKING: {bk.date} · {bk.tier} · {bk.color} · ${(bk.total_cents or 0) / 100:,.2f} · {bk.status} · paid {'yes' if (bk.sent_by or '') == 'paid' else 'no'}")
    older = (db.query(Message).filter(Message.lead_id == lead.id, Message.created_at < new_msgs[0].created_at)
             .order_by(Message.created_at.desc()).limit(12).all())
    lines.append("EARLIER TEXTS:")
    for m in reversed(older):
        b = (m.body or "").strip()
        if b and not b.startswith("Opportunity "):
            lines.append(f"  {m.created_at[:16]} {m.direction}: {b[:300]}")
    lines.append("NEW TEXTS FROM THE CUSTOMER:")
    for m in new_msgs:
        lines.append(f"  {m.created_at[:16]}: {(m.body or '').strip()[:600]}")
    return "\n".join(lines)


def _apply(db, lead, out: dict) -> list[str]:
    """Write what the customer told us into the lead and the GHL contact."""
    from services import ghl
    changed: list[str] = []
    fd = {}
    try:
        fd = json.loads(lead.form_data or "{}")
    except Exception:  # noqa: BLE001
        fd = {}
    addr, zip_code, email = (out.get("address") or "").strip(), (out.get("zip") or "").strip(), (out.get("email") or "").strip()
    if addr and addr.lower() != (lead.address or "").lower():
        lead.address = addr
        changed.append("address")
    if zip_code and zip_code != (lead.zip_code or ""):
        lead.zip_code = zip_code
        fd["zip_code"] = zip_code
        changed.append("zip")
    if email and "@" in email and email.lower() != (lead.contact_email or "").lower():
        lead.contact_email = email
        changed.append("email")
    note = (out.get("note") or "").strip()
    if note:
        stamp = now_ct().strftime("%b %-d")
        prior = (fd.get("additional_notes") or "").strip()
        fd["additional_notes"] = (prior + " | " if prior else "") + f"{stamp} (Stella, from their text): {note}"
        changed.append("notes")
    if changed:
        lead.form_data = json.dumps(fd)
        db.commit()
        if lead.ghl_contact_id and any(c in changed for c in ("address", "zip", "email")):
            try:
                ghl.update_contact_core_fields(
                    lead.ghl_contact_id,
                    address=lead.address if "address" in changed else None,
                    zip_code=lead.zip_code if "zip" in changed else None,
                    email=lead.contact_email if "email" in changed else None,
                    location_id=getattr(lead, "ghl_location_id", None) or None,
                )
            except Exception as e:  # noqa: BLE001
                logger.warning("Stella GHL contact update failed for %s: %s", lead.id, e)
    return changed


def read_new_texts(db, limit_leads: int = 15) -> dict:
    """Every customer text that came in since the last look, grouped by
    customer: update their profile, and text Alan when it can't wait."""
    from database import Lead, Message, SystemConfig
    if not on(db):
        return {"skipped": "off"}
    since = SystemConfig.get(db, TEXTS_SEEN_KEY, "")
    if not since:
        # First run: start from now, never replay history.
        SystemConfig.set(db, TEXTS_SEEN_KEY, datetime.now(timezone.utc).isoformat())
        db.commit()
        return {"started": True}
    msgs = (db.query(Message).filter(Message.direction == "inbound", Message.lead_id.isnot(None),
                                     Message.created_at > since)
            .order_by(Message.created_at.asc()).limit(200).all())
    if not msgs:
        return {"texts": 0}
    by_lead: dict[str, list] = {}
    for m in msgs:
        if (m.body or "").strip():
            by_lead.setdefault(m.lead_id, []).append(m)
    done, alerts, newest = 0, 0, since
    for lead_id, group in list(by_lead.items())[:limit_leads]:
        newest = max(newest, group[-1].created_at)
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if lead is None or (lead.status or "") in SKIP_STATUSES:
            continue
        try:
            out = ask(db, TEXT_TASK, _texts_file(db, lead, group), max_tokens=700)
        except Exception as e:  # noqa: BLE001
            logger.warning("Stella text read failed for %s: %s", lead_id, e)
            continue
        if not out:
            break
        changed = _apply(db, lead, out)
        done += 1
        if out.get("urgent"):
            said = " / ".join((m.body or "").strip()[:160] for m in group[-2:])
            msg = f"💬 {lead.contact_name} texted ❗\n\n\"{said}\"\n\n📋 {out.get('why', '')}"
            if changed:
                msg += f"\n✏️ Updated: {', '.join(changed)}"
            if (out.get("reply") or "").strip():
                msg += f"\n\n✍️ Reply:\n{out['reply'].strip()}"
            msg += f"\n\n— {NAME}"
            text_alan(msg)
            alerts += 1
    # Move the bookmark past everything handled (texts beyond limit_leads
    # wait for the next pass).
    if len(by_lead) <= limit_leads:
        newest = max(newest, msgs[-1].created_at)
    SystemConfig.set(db, TEXTS_SEEN_KEY, newest)
    db.commit()
    return {"texts": len(msgs), "customers": done, "alerts": alerts}


# ── Prices: no lead goes a day without one ───────────────────────────────

def leads_without_price(db, day_start_utc: str) -> list:
    """Leads that came in since `day_start_utc` and still have no estimate sent."""
    from database import Estimate, Lead
    sent = {r[0] for r in db.query(Estimate.lead_id).filter(Estimate.status == "sent").all()}
    rows = (db.query(Lead).filter(Lead.created_at >= day_start_utc,
                                  Lead.status.notin_(list(SKIP_STATUSES) + ["sent"]))
            .order_by(Lead.created_at.asc()).all())
    return [l for l in rows if l.id not in sent]


def no_price_check(db) -> dict:
    """At 5:30 PM Houston: every lead from the last day with no price yet."""
    from database import SystemConfig
    if not on(db):
        return {"skipped": "off"}
    now = now_ct()
    today = now.strftime("%Y-%m-%d")
    if now.hour * 60 + now.minute < 17 * 60 + 30 or SystemConfig.get(db, PRICE_CHECK_KEY, "") == today:
        return {"skipped": "not time"}
    SystemConfig.set(db, PRICE_CHECK_KEY, today)
    db.commit()
    since = (now - timedelta(days=1)).replace(hour=18, minute=0, second=0).astimezone(timezone.utc).isoformat()
    missing = leads_without_price(db, since)
    if not missing:
        return {"missing": 0}
    names = "\n".join(f"• {l.contact_name}" for l in missing[:15])
    text_alan(f"💰 NO PRICE YET ❗\n\nThese leads still don't have an estimate. Send before 6:\n{names}\n\n— {NAME}")
    return {"missing": len(missing)}


def tick(db) -> dict:
    """One pass of Stella's background work."""
    out = {}
    try:
        out["texts"] = read_new_texts(db)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        logger.warning("Stella texts pass failed: %s", e)
    try:
        out["prices"] = no_price_check(db)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        logger.warning("Stella price check failed: %s", e)
    return out
