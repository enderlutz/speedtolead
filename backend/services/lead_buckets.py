"""Every priced lead in one of five buckets (Alan, 2026-11-01: "the big
thing here is the bucket"), shown on the On call page.

  A  Call today  texted back in the last 14 days with no talk since, or
                 opened the proposal in the last 14 days and nobody has
                 talked to them since ("only if we didn't already have a
                 call with them while they opened the proposal")
  B  Warm        sent in the last 60 days, not in A: one call, then a text
                 with two real days
  C  Cold        sent more than 60 days ago: a reason-based text a month,
                 a reply moves them to A
  D  Done        said no, did it themselves, hired someone, texted STOP or
                 do-not-contact. STOP is automatic; the rest the office
                 confirms from a suggestion read off their last text
  Customers      paid anything

Leads with no estimate yet stay on the Now tab's lists. A talk is a call of
30 seconds or more that wasn't a voicemail."""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone

A_DAYS = 14
WARM_DAYS = 60
TALK_SECONDS = 30
# A talk just before the open is the same conversation (walking them
# through the page on the phone).
OPEN_GRACE = timedelta(minutes=30)
DONE_REASONS = {
    "said_no": "Said no",
    "did_it_themselves": "Did it themselves",
    "hired_someone": "Hired someone else",
    "moved": "Moved or sold the house",
    "other": "Other",
}
# Their last text, read for a "Done?" suggestion the office confirms.
_DONE_HINTS = [
    ("hired_someone", re.compile(r"\b(went|going|gone|go) with (another|someone|a different|a nother|other)|\bhired (someone|another|a different)|\bfound (someone|another)|\balready (hired|booked|have someone)|\bchose (another|someone)", re.I)),
    ("did_it_themselves", re.compile(r"\b(do|did|doing) it (my ?self|our ?selves|myself)|\bdiy\b|\bstain(ed|ing)? it (my ?self|our ?selves)", re.I)),
    ("moved", re.compile(r"\b(sold|selling) (the|my|our) (house|home)|\bmoved (out|away)\b|\bno longer (live|own)", re.I)),
    ("said_no", re.compile(r"\bnot interested\b|\bno,? thank(s| you)\b|\bdecided not to\b|\bwe('| a)?re (good|all set)\b|\bpass(ing)? (for now|on this)\b|\bremove me\b|\bplease cancel\b|\bcancel (it|the|my)\b|\bdon'?t (contact|text|call) me\b", re.I)),
]


def _p(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def done_hint(text: str) -> str:
    for key, rx in _DONE_HINTS:
        if rx.search(text or ""):
            return key
    return ""


def _form(lead) -> dict:
    try:
        d = json.loads(lead.form_data or "{}")
    except (TypeError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def buckets(db, now: datetime | None = None) -> dict:
    from api.contacts import _stops
    from database import CallRecording, Estimate, Lead, Message, PayLink, Proposal
    from sqlalchemy import or_
    from sqlalchemy.orm import defer
    now = now or datetime.now(timezone.utc)
    leads = (db.query(Lead).filter(Lead.status.notin_(("archived", "contact")), Lead.pipeline_version != "contact",
                                   or_(Lead.division.is_(None), Lead.division != "brick")).all())
    ids = [l.id for l in leads]
    if not ids:
        return {k: [] for k in ("a", "b", "c", "d", "customers")}

    sent: dict[str, dict] = {}
    for p in db.query(Proposal).options(defer(Proposal.pdf_data)).filter(Proposal.lead_id.in_(ids)).all():
        s = sent.setdefault(p.lead_id, {"last": None, "viewed": None, "views": 0, "token": ""})
        at, v = _p(p.created_at), _p(p.last_viewed_at)
        if at and (not s["last"] or at > s["last"]):
            s["last"], s["token"] = at, p.token
        if v and (not s["viewed"] or v > s["viewed"]):
            s["viewed"] = v
        s["views"] += int(p.view_count or 0)

    paid: dict[str, datetime] = {}
    for lid, at in db.query(PayLink.lead_id, PayLink.paid_at).filter(PayLink.lead_id.in_(ids), PayLink.status == "paid").all():
        d = _p(at) or now
        if lid not in paid or d > paid[lid]:
            paid[lid] = d

    talks: dict[str, list[datetime]] = {}
    for lid, at in (db.query(CallRecording.lead_id, CallRecording.created_at)
                    .filter(CallRecording.lead_id.in_(ids), CallRecording.duration_seconds >= TALK_SECONDS,
                            or_(CallRecording.is_voicemail.is_(None), CallRecording.is_voicemail.is_(False))).all()):
        if (d := _p(at)):
            talks.setdefault(lid, []).append(d)

    last_in: dict[str, tuple[datetime, str]] = {}
    for lid, at, body in (db.query(Message.lead_id, Message.created_at, Message.body)
                          .filter(Message.lead_id.in_(ids), Message.direction == "inbound")
                          .order_by(Message.created_at.desc()).all()):
        if lid not in last_in and (d := _p(at)) and (body or "").strip():
            last_in[lid] = (d, " ".join(body.split()))

    prices: dict[str, float] = {}
    for lid, tiers, at in (db.query(Estimate.lead_id, Estimate.tiers, Estimate.created_at)
                           .filter(Estimate.lead_id.in_(ids)).order_by(Estimate.created_at).all()):
        try:
            sig = float((json.loads(tiers or "{}") or {}).get("signature") or 0)
        except (TypeError, ValueError, AttributeError):
            sig = 0
        if sig:
            prices[lid] = sig

    stops, dnc = _stops(db, ids)
    out: dict[str, list] = {k: [] for k in ("a", "b", "c", "d", "customers")}
    for l in leads:
        s = sent.get(l.id)
        if l.id not in paid and not s:
            continue  # no estimate yet: the Now tab's lists
        fd = _form(l)
        t = sorted(talks.get(l.id, []))
        last_talk = t[-1] if t else None
        inbound = last_in.get(l.id)
        row = {"lead_id": l.id, "name": l.contact_name or "", "phone": l.contact_phone or "",
               "address": l.address or "", "price": prices.get(l.id, 0),
               "sent_at": s["last"].isoformat() if s and s["last"] else "",
               "viewed_at": s["viewed"].isoformat() if s and s["viewed"] else "", "views": s["views"] if s else 0,
               "last_talk": last_talk.isoformat() if last_talk else "",
               "last_text": inbound[1][:160] if inbound else "", "last_text_at": inbound[0].isoformat() if inbound else "",
               "why": "", "hint": "", "done": None, "sort": 0.0}
        if l.id in paid:
            row["why"] = f"Paid {paid[l.id].strftime('%b')} {paid[l.id].day}"
            row["sort"] = paid[l.id].timestamp()
            g = fd.get("google_review") if isinstance(fd.get("google_review"), dict) else {}
            row["review"] = "posted" if fd.get("google_review_left_at") else (g.get("status") or "")
            out["customers"].append(row)
            continue
        done = fd.get("bucket_done") if isinstance(fd.get("bucket_done"), dict) else None
        if l.id in stops or l.id in dnc or done:
            row["done"] = done or {"reason": "stop", "label": "Texted STOP" if l.id in stops else "Do not contact"}
            row["why"] = row["done"].get("label") or DONE_REASONS.get(row["done"].get("reason", ""), "Done")
            row["sort"] = (_p((done or {}).get("at")) or s["last"] or now).timestamp()
            out["d"].append(row)
            continue
        hint = done_hint(inbound[1]) if inbound else ""
        if hint and fd.get("bucket_hint_dismissed") != (inbound[0].isoformat() if inbound else ""):
            row["hint"] = hint
        replied = inbound and now - inbound[0] <= timedelta(days=A_DAYS) and not (last_talk and last_talk >= inbound[0])
        opened = s["viewed"] and now - s["viewed"] <= timedelta(days=A_DAYS) \
            and not any(d >= s["viewed"] - OPEN_GRACE for d in t)
        if replied or opened:
            if replied:
                row["why"] = "Texted back · nobody has talked to them since"
                row["sort"] = 2e10 + inbound[0].timestamp()
            else:
                row["why"] = f"Opened it {s['views']}× · nobody has talked to them since" if s["views"] > 1 \
                    else "Opened it · nobody has talked to them since"
                row["sort"] = 1e10 + s["viewed"].timestamp()
            out["a"].append(row)
        elif s["last"] and now - s["last"] <= timedelta(days=WARM_DAYS):
            row["why"] = ("Opened it, no reply" if s["viewed"] else "Hasn't opened it") + \
                (" · talked to them" if last_talk and last_talk >= s["last"] else " · no call since the price")
            row["sort"] = (s["viewed"] or s["last"]).timestamp()
            out["b"].append(row)
        else:
            row["why"] = "Priced over 60 days ago" + (" · opened it" if s["viewed"] else "")
            row["sort"] = (s["last"] or now).timestamp()
            out["c"].append(row)
    for rows in out.values():
        rows.sort(key=lambda r: -r["sort"])
        for r in rows:
            r.pop("sort", None)
    return out


def mark_done(db, lead, reason: str, by: str) -> None:
    if reason not in DONE_REASONS:
        raise ValueError("unknown reason")
    fd = _form(lead)
    fd["bucket_done"] = {"reason": reason, "label": DONE_REASONS[reason], "by": by,
                         "at": datetime.now(timezone.utc).isoformat()}
    lead.form_data = json.dumps(fd)
    db.commit()


def undo_done(db, lead) -> None:
    fd = _form(lead)
    fd.pop("bucket_done", None)
    lead.form_data = json.dumps(fd)
    db.commit()


def dismiss_hint(db, lead, text_at: str) -> None:
    """'Not done': the suggestion stays off until they text again."""
    fd = _form(lead)
    fd["bucket_hint_dismissed"] = text_at
    lead.form_data = json.dumps(fd)
    db.commit()
