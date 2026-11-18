"""The sales audit: a batch of lead journeys plus funnel numbers, for ChatGPT /
Claude to study how leads become $250 deposits (Alan, 2026-11-18, after
ChatGPT's "GHL MCP integration plan").

Everything comes from tables the dashboard already fills (GHL calls, texts and
our own transcripts are mirrored here), so this makes no GHL calls at all.

No names, phone numbers, emails or street addresses go out: each lead is a
short hash plus its lead_id and zip. Transcript excerpts are off by default;
when asked for, they are short, cut around the sales moments, with names and
long digit runs blanked.

Anything that is a guess is named as one: "asked_for_date" and
"asked_for_deposit" are keyword checks on the transcripts (inference), and
objections are the AI call reviews' tags (inference).
"""
from __future__ import annotations

import hashlib
import json
import re
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from clock import now_ct

MAX_LIMIT = 100
EXCERPT_CHARS = 300
CLOSE_BUCKETS = [(1, "same day"), (2, "next day"), (4, "2-3 days"), (8, "4-7 days"),
                 (15, "8-14 days"), (31, "15-30 days"), (61, "31-60 days"), (10**9, "60+ days")]

_DAYS = r"(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|this week)"
_DATE_ASK = re.compile(_DAYS + r".{0,80}(work|good|open|available|hold|better|schedule|put you|get you)"
                       r"|(work|good|open|available|hold|better|schedule|put you|get you).{0,80}" + _DAYS, re.I | re.S)
_DEPOSIT_ASK = re.compile(r"\b(250|two fifty|two hundred (and )?fifty|deposit|reserve (your|the) (spot|day))\b", re.I)
_EXCERPT_HITS = re.compile(r"\b(250|deposit|price|expensive|budget|wife|husband|think about|other quotes?|bids?|"
                           r"hoa|color|schedule|monday|tuesday|wednesday|thursday|friday|saturday)\b", re.I)
_DIGITS = re.compile(r"\d[\d\s\-().]{6,}\d")
_STAFF = {"amy", "olga", "lily", "gioconda", "geoconda", "alan", "chris", "jose", "brent", "christian", "alfredo"}


def _ts(v) -> datetime | None:
    if not v:
        return None
    if isinstance(v, datetime):
        d = v
    else:
        try:
            d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except ValueError:
            return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _iso(d: datetime | None) -> str:
    return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if d else ""


def _mins(a: datetime | None, b: datetime | None) -> float | None:
    if not a or not b or b < a:
        return None
    return round((b - a).total_seconds() / 60, 1)


def _ref(lead_id: str) -> str:
    return hashlib.sha256(lead_id.encode()).hexdigest()[:8]


def _json(raw, default):
    if not raw:
        return default
    if isinstance(raw, (dict, list)):
        return raw
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return default


def _bucket(days: float) -> str:
    return next(label for top, label in CLOSE_BUCKETS if days < top)


def redact(text: str, names: list[str]) -> str:
    """Blank customer names, staff names and long digit runs (phones, cards)."""
    out = _DIGITS.sub("[NUMBER]", text or "")
    for n in sorted({w for w in names if len(w) >= 3}, key=len, reverse=True):
        out = re.sub(rf"\b{re.escape(n)}\b", "[CUSTOMER]", out, flags=re.I)
    return re.sub(r"\b(" + "|".join(sorted(_STAFF)) + r")\b", "[STAFF]", out, flags=re.I)


def _excerpts(text: str, names: list[str], n: int = 3) -> list[str]:
    out, last = [], -10**9
    for m in _EXCERPT_HITS.finditer(text or ""):
        if m.start() - last < EXCERPT_CHARS:
            continue
        lo = max(0, m.start() - EXCERPT_CHARS // 2)
        out.append(redact(text[lo:lo + EXCERPT_CHARS].strip(), names))
        last = m.start()
        if len(out) >= n:
            break
    return out


_SPOKEN = [(re.compile(r"\b(this is|it's|it is|my name is)\s+amy\b", re.I), "Olga"),
           (re.compile(r"\b(this is|it's|it is|my name is)\s+lily\b", re.I), "Geoconda"),
           (re.compile(r"\b(this is|it's|it is|my name is)\s+alan\b", re.I), "Alan")]


def caller_of(call, staff: dict[str, str], transcript: str) -> str:
    """Who made the call: the GHL user on the recording, else the name they say
    in the first seconds ("This is Amy" = Olga, "Lily" = Geoconda), else unknown."""
    who = staff.get(getattr(call, "recorded_by", "") or "", "")
    if who:
        return who
    head = (transcript or "")[:400]
    return next((name for rx, name in _SPOKEN if rx.search(head)), "unknown")


def _staff_map(db) -> dict[str, str]:
    from database import User
    return {u.ghl_user_id: (u.display_name or u.username) for u in db.query(User).all()
            if getattr(u, "ghl_user_id", None)}


def _excluded_locations() -> set[str]:
    """A&T's GHL accounts: this audit is Sterling only."""
    try:
        from config import get_settings
        s = get_settings()
        return {x for x in (getattr(s, "ghl_location_id_at", ""), getattr(s, "ghl_location_id_at_woodlands", "")) if x}
    except Exception:  # noqa: BLE001
        return set()


def sales_audit(db, start: str = "", end: str = "", limit: int = 50, cursor: str = "",
                outcome: str = "all", va: str = "", include_excerpts: bool = False) -> dict:
    from database import (Booking, CallAnalysis, CallDisposition, CallIntent, CallRecording, CallTranscript,
                          CustomerPayment, Estimate, Lead, Message, PayLink, SalesEvent)
    today = now_ct().date()
    end_d = datetime.strptime(end, "%Y-%m-%d").date() if end else today
    start_d = datetime.strptime(start, "%Y-%m-%d").date() if start else end_d - timedelta(days=60)
    lo, hi = start_d.isoformat(), (end_d + timedelta(days=1)).isoformat()
    limit = max(1, min(int(limit or 50), MAX_LIMIT))
    offset = int(cursor) if str(cursor or "").isdigit() else 0
    outcome = (outcome or "all").lower()

    q = (db.query(Lead).filter(Lead.created_at >= lo, Lead.created_at < hi)
         .filter((Lead.is_test.is_(None)) | (Lead.is_test.is_(False))))
    bad_locs = _excluded_locations()
    if bad_locs:
        q = q.filter((Lead.ghl_location_id.is_(None)) | (~Lead.ghl_location_id.in_(bad_locs)))
    leads_all = q.order_by(Lead.created_at, Lead.id).all()
    leads_all = [lead for lead in leads_all if (getattr(lead, "division", None) or "fence") == "fence"]
    ids_all = [lead.id for lead in leads_all]
    staff = _staff_map(db)

    def by_lead(model, ids, order=None):
        out = defaultdict(list)
        for i in range(0, len(ids), 500):
            rows = db.query(model).filter(model.lead_id.in_(ids[i:i + 500]))
            if order is not None:
                rows = rows.order_by(order)
            for r in rows.all():
                out[r.lead_id].append(r)
        return out

    pays = by_lead(PayLink, ids_all)
    calls = by_lead(CallRecording, ids_all, CallRecording.created_at)

    def deposit_paid(lid):
        paid = [p for p in pays.get(lid, []) if p.kind == "deposit" and p.paid_at]
        return min((_ts(p.paid_at) for p in paid), default=None)

    def va_on(lid):
        return {staff.get(c.recorded_by or "", "") for c in calls.get(lid, [])} - {""}

    picked = []
    for lead in leads_all:
        won = deposit_paid(lead.id) is not None or bool(getattr(lead, "deposit_paid_at", None))
        if outcome == "won" and not won:
            continue
        if outcome == "lost_or_open" and won:
            continue
        if va and va.strip().lower() not in {v.lower() for v in va_on(lead.id)}:
            continue
        picked.append(lead)
    page = picked[offset:offset + limit]
    ids = [lead.id for lead in page]

    msgs = by_lead(Message, ids, Message.created_at)
    ests = by_lead(Estimate, ids, Estimate.created_at)
    events = by_lead(SalesEvent, ids)
    books = by_lead(Booking, ids)
    cpays = by_lead(CustomerPayment, ids)
    disp = by_lead(CallDisposition, ids)
    analyses = by_lead(CallAnalysis, ids)
    rec_ids = [c.id for lid in ids for c in calls.get(lid, [])]
    transcripts: dict[str, str] = {}
    intents: dict[str, list] = defaultdict(list)
    for i in range(0, len(rec_ids), 500):
        chunk = rec_ids[i:i + 500]
        for t in db.query(CallTranscript).filter(CallTranscript.recording_id.in_(chunk)).all():
            transcripts[t.recording_id] = t.full_text or ""
    for lid, rows in by_lead(CallIntent, ids).items():
        intents[lid] = rows

    out_leads = []
    for lead in page:
        came = _ts(getattr(lead, "ghl_created_at", None)) or _ts(lead.created_at)
        fd = _json(lead.form_data, {})
        names = [w for w in re.split(r"\W+", lead.contact_name or "") if w]
        lm = [m for m in msgs.get(lead.id, []) if (m.body or "").strip()
              and not (m.body or "").startswith("Opportunity ")]
        out_txt = [m for m in lm if m.direction == "outbound"]
        in_txt = [m for m in lm if m.direction == "inbound"]
        lc = calls.get(lead.id, [])
        live = [c for c in lc if not c.is_voicemail and (c.duration_seconds or 0) >= 60]
        first_out_txt = _ts(out_txt[0].created_at) if out_txt else None
        first_call = _ts(lc[0].created_at) if lc else None
        first_live = live[0] if live else None
        by_va = Counter(caller_of(c, staff, transcripts.get(c.id, "")) for c in lc)
        texts_all = " ".join(transcripts.get(c.id, "") for c in lc)

        sent_ev = [_ts(e.occurred_at) for e in events.get(lead.id, []) if e.event_type in ("estimate_sent", "scope_sent")]
        est_rows = ests.get(lead.id, [])
        sent_at = min([d for d in sent_ev if d] + [d for d in (_ts(e.sent_at) for e in est_rows) if d], default=None)
        est = est_rows[-1] if est_rows else None
        tiers = _json(est.tiers, {}) if est else {}
        inputs = _json(est.inputs, {}) if est else {}

        dep_at = deposit_paid(lead.id) or _ts(getattr(lead, "deposit_paid_at", None))
        dep_src = "stripe" if deposit_paid(lead.id) else ("quickbooks_or_manual" if dep_at else "")
        dep_methods = sorted({cp.method for cp in cpays.get(lead.id, []) if cp.kind == "deposit" and cp.method})
        deps = [p for p in pays.get(lead.id, []) if p.kind == "deposit" and p.paid_at]
        sold_tier = next((p.job_tier for p in deps if p.job_tier), "") or (est.closed_tier if est else "") or ""
        sold_total = next((p.job_total_cents / 100 for p in deps if p.job_total_cents), None)
        if sold_total is None and est is not None and est.closed_price:
            sold_total = float(est.closed_price)
        final_paid = any(p.kind in ("balance", "done", "full") and p.paid_at for p in pays.get(lead.id, []))
        book = sorted(books.get(lead.id, []), key=lambda b: b.created_at or "")
        objections: list[str] = []
        for a in analyses.get(lead.id, []):
            for o in _json(a.objections, []):
                if isinstance(o, str) and o[:120] not in objections:
                    objections.append(o[:120])
        disp_out = Counter(d.outcome for d in disp.get(lead.id, []) if d.outcome)
        temps = [i.temperature for i in intents.get(lead.id, []) if i.temperature and i.temperature != "unknown"]
        lost = bool(any(e.event_type == "lost" for e in events.get(lead.id, []))
                    or (lead.status or "").lower() in ("lost", "declined", "dead"))
        status = "won" if dep_at else ("lost" if lost else "open")

        row = {
            "lead_ref": _ref(lead.id), "lead_id": lead.id, "zip": lead.zip_code or "",
            "created_at": _iso(came), "source": lead.lead_source or "",
            "form": {k: fd.get(k) for k in ("fence_age", "fence_height", "fence_sides", "service_timeline",
                                            "previously_stained") if fd.get(k)},
            "first_text": {"minutes_after_lead": _mins(came, first_out_txt)},
            "first_call": {"minutes_after_lead": _mins(came, first_call)},
            "first_live_call": ({"minutes_after_lead": _mins(came, _ts(first_live.created_at)),
                                 "va": caller_of(first_live, staff, transcripts.get(first_live.id, "")),
                                 "seconds": first_live.duration_seconds} if first_live else None),
            "calls": {"total": len(lc), "live_60s_plus": len(live),
                      "voicemail": sum(1 for c in lc if c.is_voicemail), "by_va": dict(by_va),
                      "transcribed": sum(1 for c in lc if transcripts.get(c.id))},
            "texts": {"outbound": len(out_txt), "inbound": len(in_txt),
                      "first_customer_reply_minutes": _mins(came, _ts(in_txt[0].created_at)) if in_txt else None},
            "quote": ({"sent_minutes_after_lead": _mins(came, sent_at),
                       "essential": tiers.get("essential"), "signature": tiers.get("signature"),
                       "legacy": tiers.get("legacy"), "linear_feet": inputs.get("linear_feet"),
                       "sides": inputs.get("fence_sides")} if est else None),
            "proposal_views": getattr(lead, "proposal_view_count", None) or 0,
            "asked_for_date_inference": bool(_DATE_ASK.search(texts_all)) if texts_all else None,
            "asked_for_deposit_inference": bool(_DEPOSIT_ASK.search(texts_all)) if texts_all else None,
            "objections_ai": objections[:8],
            "call_outcomes": dict(disp_out),
            "temperature_ai": temps[-1] if temps else "",
            "deposit": ({"paid_at": _iso(dep_at), "days_after_lead": round((dep_at - came).total_seconds() / 86400, 1)
                         if came and dep_at >= came else None, "source": dep_src, "method": dep_methods}
                        if dep_at else None),
            "booked_date": book[-1].date if book else "",
            "package_sold": sold_tier, "sold_total": sold_total, "final_paid": final_paid,
            "status_now": status,
        }
        if include_excerpts:
            row["excerpts"] = _excerpts(texts_all, names)
        out_leads.append(row)

    return {
        "window": {"start": start_d.isoformat(), "end": end_d.isoformat()},
        "filters": {"outcome": outcome, "va": va or ""},
        "total_matching": len(picked),
        "returned": len(out_leads),
        "next_cursor": str(offset + limit) if offset + limit < len(picked) else "",
        "summary": _summary(out_leads),
        "leads": out_leads,
        "notes": [
            "Sterling only (A&T accounts and test leads excluded). No names, phones, emails or street addresses.",
            "summary covers the leads on this page only; page through with next_cursor for the whole window.",
            "asked_for_date_inference / asked_for_deposit_inference are keyword checks on transcripts (inference).",
            "objections_ai and temperature_ai are AI call-review tags (inference).",
            "Deposits before ~Oct 2026 were QuickBooks invoices (deposit.source quickbooks_or_manual): lower confidence.",
            "Transcripts exist from Apr 2026; GHL stage history is not stored.",
        ],
    }


def _summary(rows: list[dict]) -> dict:
    n = len(rows)

    def med(vals):
        vals = [v for v in vals if v is not None]
        return round(statistics.median(vals), 1) if vals else None

    reached = [r for r in rows if r["calls"]["live_60s_plus"] > 0]
    quoted = [r for r in rows if r["quote"]]
    won = [r for r in rows if r["status_now"] == "won"]
    date_asked = [r for r in rows if r["asked_for_date_inference"]]
    dep_asked = [r for r in rows if r["asked_for_deposit_inference"]]
    by_va: dict[str, dict] = defaultdict(lambda: Counter())
    for r in rows:
        vas = {v for v in r["calls"]["by_va"] if v != "unknown"}
        for v in vas:
            c = by_va[v]
            c["leads_called"] += 1
            c["calls"] += r["calls"]["by_va"][v]
            c["leads_reached_live"] += 1 if r["calls"]["live_60s_plus"] else 0
            c["asked_date"] += 1 if r["asked_for_date_inference"] else 0
            c["asked_deposit"] += 1 if r["asked_for_deposit_inference"] else 0
            c["won"] += 1 if r["status_now"] == "won" else 0
    objections = Counter(o for r in rows for o in r["objections_ai"])
    obj_won = Counter(o for r in won for o in r["objections_ai"])
    return {
        "leads": n,
        "funnel": {"reached_live": len(reached), "quoted": len(quoted), "date_asked_inference": len(date_asked),
                   "deposit_asked_inference": len(dep_asked), "deposit_paid": len(won),
                   "close_rate": round(len(won) / n, 3) if n else None},
        "speed_median_minutes": {
            "first_text": med(r["first_text"]["minutes_after_lead"] for r in rows),
            "first_call": med(r["first_call"]["minutes_after_lead"] for r in rows),
            "first_live_call": med((r["first_live_call"] or {}).get("minutes_after_lead") for r in rows),
            "quote_sent": med((r["quote"] or {}).get("sent_minutes_after_lead") for r in rows),
        },
        "close_timing": dict(Counter(_bucket(r["deposit"]["days_after_lead"]) for r in won
                                     if r["deposit"] and r["deposit"]["days_after_lead"] is not None)),
        "by_va": {v: dict(c) for v, c in by_va.items()},
        "objections_ai": [{"objection": o, "leads": k, "won": obj_won.get(o, 0)} for o, k in objections.most_common(15)],
        "data_quality": {
            "no_calls": sum(1 for r in rows if not r["calls"]["total"]),
            "calls_without_transcript": sum(r["calls"]["total"] - r["calls"]["transcribed"] for r in rows),
            "no_quote": sum(1 for r in rows if not r["quote"]),
            "deposit_not_stripe": sum(1 for r in won if (r["deposit"] or {}).get("source") != "stripe"),
        },
    }
