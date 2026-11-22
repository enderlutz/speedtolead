"""Job Margins: one row per job with what it brought in, what it cost and
what it left, every number tagged with how sure we are (Alan, 2026-11-19,
from the ChatGPT spec "Job Margins & P4P data foundation", Phase 1).

Alan's rule: every box gets a number. Anything we don't know for sure gets
our best guess and is marked "unconfirmed" — never left blank, never $0.

Tags:
  confirmed   typed by the office or logged by the crew (final price, Crew
              hours, measured footage, a flat pay line)
  worked out  computed from confirmed records (payments add up to the
              price, gallons × the shelf's own cost)
  unconfirmed a best guess (estimate footage, hours from photo times, the
              standard stain/bleach price, 3% card fee, overhead share)
  missing     not even a guess is possible

Read-only: nothing here writes. History starts when job cards started
(2026-10-17); older QuickBooks invoices have no costs behind them.

Coats: every job is two coats (Alan, 2026-11-19). Confirmed square footage
already counts every stained face; it is never doubled.
"""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from database import (BankTransaction, CompanyCamJob, CompanyCamPhoto, CrewReimbursement, CustomerPayment,
                      HoursLog, Lead, MaterialPurchase, QuickbooksInvoice, StainInventoryItem, StainMovement, User)

CT = ZoneInfo("America/Chicago")
HISTORY_START = "2026-10-17"
COATS = 2
BLEACH_PER_GALLON = 2.80        # Alan's estimate, not a receipt (spec §6)
BLEACH_GUESS_GALLONS = 10.0     # what a cleaning job brings (crew plan rule)
NO_HOURS_GUESS = 8.0            # an hourly day with no hours and no photos
CARD_FEE_RATE = 0.03            # Stripe's real fee isn't stored yet
VA_PAY_PER_WEEK = 400.0         # the VAs' base pay, per week (Oct 2026)
# Bank categories that are running the business, not a job (60-day review).
OVERHEAD_CATEGORIES = ("Software & subscriptions", "Rent & utilities", "Insurance", "Fees & bank charges",
                       "Vehicle", "Fuel", "Loan payment", "Equipment & tools", "Other marketing")
AD_CATEGORIES = ("Meta ads",)
TAGS = ("confirmed", "worked out", "unconfirmed", "missing")


def _v(value, tag: str, note: str = "") -> dict:
    return {"value": None if value is None else round(float(value), 2), "tag": tag, "note": note}


def _weakest(*tags: str) -> str:
    return max(tags, key=TAGS.index) if tags else "missing"


def _ct(iso: str) -> datetime | None:
    try:
        d = datetime.fromisoformat((iso or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(CT)


def _ct_day(iso: str) -> str:
    d = _ct(iso)
    return d.strftime("%Y-%m-%d") if d else ""


def split_day(total_h: float, onsite: dict[str, float]) -> dict[str, float]:
    """A worker's day across their jobs (Alan's rule, 2026-10-29): on-site
    time goes to its job, everything off-site is split evenly. `onsite` is
    {lead_id: hours seen on site}; zero when unknown. The shares always add
    back up to the day."""
    if not onsite:
        return {}
    seen = sum(onsite.values())
    if seen > total_h > 0:   # photos span more than the logged day: scale down
        return {k: total_h * v / seen for k, v in onsite.items()}
    rest = max(0.0, total_h - seen) / len(onsite)
    return {k: v + rest for k, v in onsite.items()}


def opacity_of(*texts: str) -> str:
    """The stain's opacity from its product/colour text: solid, semi-solid,
    semi-transparent, clear, or "" when it doesn't say (Alan, 2026-11-22:
    metrics and budgeted hours will be built per opacity). A job with a solid
    and a clear side counts as solid: that's the paint on most of it."""
    t = " ".join(x or "" for x in texts).lower().replace("_", " ").replace("-", " ")
    if "semi solid" in t:
        return "semi-solid"
    if "solid" in t:
        return "solid"
    # Ready Seal / Cabot oil are semi-transparent toners.
    if "semi transparent" in t or "semi trans" in t or " semi" in f" {t}" or "oil" in t:
        return "semi-transparent"
    if "clear" in t:
        return "clear"
    return ""


def overhead_rates(db, today: date) -> dict:
    """Per-job overhead and ads from the bank's last 30 days over the jobs
    finished in the same 30 days (Alan, 2026-11-21: overhead is always the
    last 30 days, never another window). Unconfirmed: it's a share, not a
    bill the job caused."""
    since = (today - timedelta(days=30)).isoformat()
    rows = (db.query(BankTransaction.category, BankTransaction.amount)
            .filter(BankTransaction.date >= since, BankTransaction.date <= today.isoformat(),
                    BankTransaction.amount > 0, BankTransaction.pending.is_(False)).all())
    by: dict[str, float] = defaultdict(float)
    for cat, amt in rows:
        by[cat or ""] += float(amt or 0)
    fixed = {c: round(by.get(c, 0.0), 2) for c in OVERHEAD_CATEGORIES}
    va = round(VA_PAY_PER_WEEK * 52 / 12, 2)
    ads = round(sum(by.get(c, 0.0) for c in AD_CATEGORIES), 2)
    lo = (datetime.combine(today - timedelta(days=30), datetime.min.time(), CT)).astimezone(timezone.utc).isoformat()
    test = {i for (i,) in db.query(Lead.id).filter(Lead.is_test.is_(True)).all()}
    jobs = sum(1 for (lid,) in db.query(CompanyCamJob.lead_id).filter(CompanyCamJob.completed_at >= lo).all()
               if lid not in test)
    monthly = round(sum(fixed.values()) + va, 2)
    return {"monthly_overhead": monthly, "monthly_ads": ads, "jobs_last_30_days": jobs,
            "overhead_per_job": round(monthly / jobs, 2) if jobs else None,
            "ads_per_job": round(ads / jobs, 2) if jobs else None,
            "breakdown": {**fixed, "VA base pay": va}, "bank_linked": bool(rows)}


def build(db, since: str = HISTORY_START, until: str = "", today: date | None = None) -> dict:
    from api.company_cam import _crew_entries
    from services.booked import booked_customers
    from services.company_cam import fence_age
    from services.scoreboard import stain_cost_per_gallon

    today = today or datetime.now(CT).date()
    until = until or today.isoformat()
    test = {i for (i,) in db.query(Lead.id).filter(Lead.is_test.is_(True)).all()}

    # The jobs: finished in the window, or worked in it and not finished yet.
    jobs = []
    for j in db.query(CompanyCamJob).all():
        if j.lead_id in test:
            continue
        crew = _crew_entries(j)
        days = sorted(e["date"] for e in crew if e.get("date"))
        done = _ct_day(j.completed_at or "")
        day = done or (days[-1] if days else "")
        if not day or not (since <= day <= until) or (not done and days and days[0] > today.isoformat()):
            continue
        jobs.append((j, crew, done, day))
    if not jobs:
        return {"since": since, "until": until, "jobs": [], "overhead": overhead_rates(db, today), "totals": {}}
    ids = [j.lead_id for j, *_ in jobs]
    leads = {l.id: l for l in db.query(Lead).filter(Lead.id.in_(ids)).all()}
    users = {u.username.lower(): u for u in db.query(User).all()}
    items = {i.id: i for i in db.query(StainInventoryItem).all()}
    per_gal, per_gal_set = stain_cost_per_gallon(db)
    booked = {c["lead_id"]: c["value"] for c in booked_customers(db) if c.get("lead_id")}
    oh = overhead_rates(db, today)
    # Alan's own stain price (Money → Overview) is his number; the built-in
    # default is a guess.
    std_tag = "worked out" if per_gal_set else "unconfirmed"
    std_note = f"your ${per_gal:.2f}/gal stain price" if per_gal_set else f"${per_gal:.2f}/gal guessed"

    # Every dated crew line in the window, all jobs, so a day is split right.
    lines_by_day: dict[tuple[str, str], list[tuple[str, dict]]] = defaultdict(list)
    all_days: set[str] = set()
    for j, crew, *_ in jobs:
        for e in crew:
            if e.get("date"):
                lines_by_day[(e["username"].lower(), e["date"])].append((j.lead_id, e))
                all_days.add(e["date"])
    # Other jobs those workers were on the same days count in the split too.
    if all_days:
        for other in db.query(CompanyCamJob).filter(CompanyCamJob.crew_json.like("%-%")).all():
            if other.lead_id in ids or other.lead_id in test:
                continue
            for e in _crew_entries(other):
                k = (e["username"].lower(), e.get("date") or "")
                if k in lines_by_day:
                    lines_by_day[k].append((other.lead_id, e))
    d0, d1 = (min(all_days), max(all_days)) if all_days else (since, until)
    logged = {(h.username.lower(), h.work_date): (h.minutes or 0) / 60
              for h in db.query(HoursLog).filter(HoursLog.work_date >= d0, HoursLog.work_date <= d1).all()}
    # Photo times: (worker, day) → overall first/last, and per job.
    lo = (datetime.fromisoformat(d0).replace(tzinfo=CT) - timedelta(days=1)).astimezone(timezone.utc).isoformat()
    span_day: dict[tuple[str, str], list[datetime]] = defaultdict(list)
    span_job: dict[tuple[str, str, str], list[datetime]] = defaultdict(list)
    for lid, sub, at in (db.query(CompanyCamPhoto.lead_id, CompanyCamPhoto.uploaded_sub, CompanyCamPhoto.taken_at)
                         .filter(CompanyCamPhoto.taken_at >= lo).all()):
        t = _ct(at or "")
        if not t or not sub:
            continue
        k = (sub.lower(), t.strftime("%Y-%m-%d"))
        span_day[k].append(t)
        span_job[(*k, lid)].append(t)

    def hours_of(ts: list[datetime]) -> float:
        return (max(ts) - min(ts)).total_seconds() / 3600 if len(ts) >= 2 else 0.0

    # One worker-day → each job's share of the paid hours, and how sure.
    share_cache: dict[tuple[str, str], tuple[dict[str, float], str, str]] = {}

    def day_share(user: str, day: str) -> tuple[dict[str, float], str, str]:
        k = (user, day)
        if k in share_cache:
            return share_cache[k]
        paid = [(lid, e) for lid, e in lines_by_day.get(k, []) if e.get("pay_type") in ("hourly", "")]
        if k in logged:
            total, tag, note = logged[k], "confirmed", "Crew hours"
        elif hours_of(span_day.get(k, [])) >= 1:
            total, tag, note = hours_of(span_day[k]), "unconfirmed", "first to last photo that day"
        else:
            total, tag, note = NO_HOURS_GUESS, "unconfirmed", "no hours and no photos: a full day guessed"
        onsite = {lid: hours_of(span_job.get((user, day, lid), [])) for lid, _ in paid}
        share_cache[k] = (split_day(total, onsite), tag, note)
        return share_cache[k]

    # Stain used per job, per product, from the shelf's moves.
    moves: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0]))
    for m in db.query(StainMovement).filter(StainMovement.lead_id.in_(ids),
                                            StainMovement.action.in_(("used", "returned"))).all():
        it = items.get(m.stain_id)
        if it and (it.finish_type or "") == "bleach":
            continue   # bleach comes off the same shelf; it has its own column
        x = moves[m.lead_id][m.stain_id]
        g = -float(m.delta_gallons or 0)
        x[0] += g
        if m.action == "used" and float(m.unit_cost or 0) > 0:
            x[1] = float(m.unit_cost)
    receipts = defaultdict(float)
    for r in db.query(CrewReimbursement).filter(CrewReimbursement.lead_id.in_(ids)).all():
        if (r.created_by or "") != "tip":
            receipts[r.lead_id] += float(r.amount or 0)
    supplies = defaultdict(float)
    for p in db.query(MaterialPurchase).filter(MaterialPurchase.lead_id.in_(ids),
                                               MaterialPurchase.category == "supplies").all():
        supplies[p.lead_id] += float(p.total_cost or 0)
    collected = defaultdict(float)
    for p in db.query(CustomerPayment).filter(CustomerPayment.lead_id.in_(ids)).all():
        collected[p.lead_id] += (p.amount_cents or 0) / 100
    for i in db.query(QuickbooksInvoice).filter(QuickbooksInvoice.lead_id.in_(ids)).all():
        if i.status != "void":
            collected[i.lead_id] += float(i.amount_paid or 0)

    def name_of(u: str) -> str:
        x = users.get(u.lower())
        return (x.display_name or x.username) if x else u

    rows = []
    for j, crew, done, day in jobs:
        lead = leads.get(j.lead_id)
        qs: list[dict] = []

        # Revenue
        if (j.final_price_cents or 0) > 0:
            revenue = _v(j.final_price_cents / 100, "confirmed", "final price on the job card")
        elif booked.get(j.lead_id):
            revenue = _v(booked[j.lead_id], "worked out", "from what the customer paid and was billed")
            qs.append({"field": "revenue", "q": f"Is ${booked[j.lead_id]:,.0f} the full price of this job?"})
        else:
            revenue = _v(None, "missing", "no price, payment or booking")
            qs.append({"field": "revenue", "q": "What was the full price of this job?"})
        price = revenue["value"] or 0.0

        # Footage
        sqft = float(j.actual_sqft or 0) or float(j.sqft or 0)
        if j.actual_sqft or j.measure_confirmed_at:
            sq = _v(sqft, "confirmed", "measured")
        elif sqft:
            sq = _v(sqft, "unconfirmed", "from the estimate, not measured")
            qs.append({"field": "sqft", "q": "Measure it: is the estimate's footage right?"})
        else:
            sq = _v(None, "missing", "no footage")
            qs.append({"field": "sqft", "q": "How many square feet did we stain?"})

        # Labor
        labor_lines, labor_tags, labor_total, hours_total = [], [], 0.0, 0.0
        for e in crew:
            kind, pay = e.get("pay_type") or "", float(e.get("pay") or 0)
            who = name_of(e["username"])
            base = {"who": who, "date": e.get("date") or "", "task": e.get("task") or "", "kind": kind or "not set"}
            if kind == "flat":
                labor_lines.append({**base, "hours": None, "rate": None, "cost": round(pay, 2), "tag": "confirmed",
                                    "note": "flat pay"})
                labor_tags.append("confirmed")
                labor_total += pay
                continue
            if kind == "included":
                labor_lines.append({**base, "hours": None, "rate": None, "cost": 0.0, "tag": "confirmed",
                                    "note": "inside another line's flat"})
                continue
            if not e.get("date"):
                labor_lines.append({**base, "hours": None, "rate": None, "cost": 0.0, "tag": "missing",
                                    "note": "line has no day"})
                labor_tags.append("missing")
                qs.append({"field": "labor", "q": f"{who} has a line with no day: which day, or delete it?"})
                continue
            rate = pay if (kind == "hourly" and pay > 0) else float(getattr(users.get(e["username"].lower()), "hourly_rate", 0) or 0)
            shares, htag, hnote = day_share(e["username"].lower(), e["date"])
            h = shares.get(j.lead_id, 0.0)
            tag = htag if kind == "hourly" else "unconfirmed"
            note = hnote if kind == "hourly" else f"no pay set: {hnote}, at their usual rate"
            n_jobs = len(shares)
            if n_jobs > 1:
                note += f"; day shared by {n_jobs} jobs"
            cost = h * rate
            labor_lines.append({**base, "hours": round(h, 2), "rate": rate, "cost": round(cost, 2), "tag": tag, "note": note})
            labor_tags.append(tag)
            labor_total += cost
            hours_total += h
            if tag != "confirmed":
                qs.append({"field": "labor", "q": f"{who} on {e['date']}: what time did they start and finish?"
                           + ("" if kind else " And is it hourly or a flat?")})
        if not crew:
            qs.append({"field": "labor", "q": "Who worked this job, which days, and how were they paid?"})
        labor = _v(labor_total if crew else None, _weakest(*labor_tags) if crew else "missing",
                   f"{len(crew)} crew line(s)")

        # Stain: each product on its own line.
        stain_lines, stain_tags, stain_total = [], [], 0.0
        used = {k: v for k, v in moves.get(j.lead_id, {}).items() if v[0] > 0.01}
        if not used and float(j.stain_gallons_used or 0) > 0:
            used = {j.final_stain_id or "": [float(j.stain_gallons_used), 0.0]}
        for sid, (gal, unit) in used.items():
            it = items.get(sid)
            label = " ".join(x for x in ((it.brand, it.color_name, (it.finish_type or "").replace("_", " ")) if it else
                                         (j.final_color or j.color or "stain",)) if x)
            if unit > 0:
                u, tag, note = unit, "worked out", "shelf cost when it was used"
            elif it and float(it.avg_cost or 0) > 0:
                u, tag, note = float(it.avg_cost), "worked out", "shelf average cost"
            else:
                u, tag, note = per_gal, std_tag, f"no price on the shelf: {std_note}"
            stain_lines.append({"product": label, "gallons": round(gal, 2), "unit": round(u, 2),
                                "cost": round(gal * u, 2), "tag": tag, "note": note})
            stain_tags.append(tag)
            stain_total += gal * u
        stain_gal = sum(x["gallons"] for x in stain_lines)
        if not stain_lines:
            gal = float(j.gallons_needed or 0) or (round(sqft / 140, 1) if sqft else 0.0)
            if gal:
                stain_lines.append({"product": j.final_color or j.color or "stain", "gallons": round(gal, 2), "unit": per_gal,
                                    "cost": round(gal * per_gal, 2), "tag": "unconfirmed",
                                    "note": "gallons the job needed, not what was used"})
                stain_tags.append("unconfirmed")
                stain_total, stain_gal = gal * per_gal, gal
            qs.append({"field": "stain", "q": "How many gallons of stain were used, and which color(s)?"})
        stain = _v(stain_total if stain_lines else None, _weakest(*stain_tags) if stain_lines else "missing")

        # Bleach
        bl_gal = float(j.bleach_gallons_used or 0) or float(j.pw_bleach_gallons or 0)
        if bl_gal:
            bleach = {**_v(bl_gal * BLEACH_PER_GALLON, "unconfirmed", f"{bl_gal:g} gal × ${BLEACH_PER_GALLON:.2f} standard"),
                      "gallons": bl_gal}
        elif j.no_cleaning:
            bleach = {**_v(0, "confirmed", "no cleaning on this job"), "gallons": 0.0}
        else:
            g = float(j.bleach_gallons_to_bring or 0) or BLEACH_GUESS_GALLONS
            bleach = {**_v(g * BLEACH_PER_GALLON, "unconfirmed", f"{g:g} gal guessed × ${BLEACH_PER_GALLON:.2f}"), "gallons": g}
            qs.append({"field": "bleach", "q": "How many gallons of bleach were used?"})

        other = receipts.get(j.lead_id, 0.0) + supplies.get(j.lead_id, 0.0)
        fees = _v(price * CARD_FEE_RATE, "unconfirmed", "3% card fee estimate") if price else _v(0, "missing")
        parts = [labor, stain, bleach, fees]
        direct = sum(p["value"] or 0 for p in parts) + other
        contribution = price - direct if price else None
        oh_job, ads_job = oh["overhead_per_job"], oh["ads_per_job"]
        after = contribution - (oh_job or 0) - (ads_job or 0) if contribution is not None else None
        tags = [revenue["tag"], labor["tag"], stain["tag"]]

        stain_item = items.get(j.final_stain_id or "")
        cleaning = sorted({e["date"] for e in crew if e.get("task") == "cleaning" and e.get("date")})
        staining = sorted({e["date"] for e in crew if e.get("task") == "staining" and e.get("date")})
        stain_text = (" ".join(x for x in (stain_item.brand, stain_item.color_name, stain_item.finish_type or "") if x)
                      if stain_item else (j.final_color or j.color or ""))
        opacity = opacity_of(stain_text, *(x["product"] for x in stain_lines))
        rows.append({
            "lead_id": j.lead_id, "customer": (lead.contact_name if lead else "") or "",
            "opacity": opacity,
            # A solid on a Signature sale stays Signature: the customer pays
            # the Signature price, the crew lays a solid (Alan, 2026-11-22).
            "solid_upsell": (j.package or "") == "signature" and opacity == "solid",
            "status": "finished" if done else "in progress", "date": day, "finished": done,
            "service": "pressure washing" if (j.pw_services_json or "[]") not in ("[]", "") and not staining else "staining",
            "package": j.package or "", "cleaning_days": cleaning, "staining_days": staining,
            "crew": sorted({name_of(e["username"]) for e in crew}),
            "coats": COATS, "sqft": sq, "previously_stained": j.previously_stained or "",
            "wood_type": j.wood_type or "", "fence_age": (fence_age(db, lead) if lead else "") or "",
            "stain_product": (" ".join(x for x in (stain_item.brand, stain_item.color_name,
                                                   (stain_item.finish_type or "").replace("_", " ")) if x)
                              if stain_item else (j.final_color or j.color or "")),
            "revenue": revenue, "collected": round(collected.get(j.lead_id, 0.0), 2),
            "outstanding": round(max(0.0, price - collected.get(j.lead_id, 0.0)), 2) if price else None,
            "labor": labor, "labor_lines": labor_lines, "hours": round(hours_total, 2),
            "stain": stain, "stain_lines": stain_lines, "stain_gallons": round(stain_gal, 2),
            "bleach": bleach, "other": round(other, 2), "fees": fees,
            "direct_cost": round(direct, 2),
            "contribution": None if contribution is None else round(contribution, 2),
            "contribution_pct": round(contribution / price * 100, 1) if contribution is not None and price else None,
            "overhead": oh_job, "ads": ads_job,
            "after_overhead": None if after is None else round(after, 2),
            "after_overhead_pct": round(after / price * 100, 1) if after is not None and price else None,
            "sqft_per_hour": round(sqft / hours_total, 1) if sqft and hours_total else None,
            "labor_per_sqft": round(labor_total / sqft, 3) if sqft and crew else None,
            "profit_per_sqft": round(contribution / sqft, 3) if sqft and contribution is not None else None,
            "gal_per_1000": round(stain_gal / sqft * 1000, 1) if sqft and stain_gal else None,
            "sure": _weakest(*tags), "questions": qs,
        })
    rows.sort(key=lambda r: r["date"], reverse=True)
    # Totals only count jobs with a price, labor and stain: a job with no
    # costs at all (the HOA's $34,916 with no crew lines) would read as 97%.
    counted = [r for r in rows if r["revenue"]["value"] and r["labor"]["tag"] != "missing"
               and r["stain"]["tag"] != "missing"]
    for r in rows:
        r["in_totals"] = r in counted
    tot = {k: round(sum((r[k]["value"] if isinstance(r[k], dict) else r[k]) or 0 for r in counted), 2)
           for k in ("revenue", "labor", "stain", "bleach", "fees", "other", "direct_cost", "contribution",
                     "after_overhead", "collected")}
    tot["contribution_pct"] = round(tot["contribution"] / tot["revenue"] * 100, 1) if tot["revenue"] else None
    tot["after_overhead_pct"] = round(tot["after_overhead"] / tot["revenue"] * 100, 1) if tot["revenue"] else None
    tot["jobs"], tot["counted"] = len(rows), len(counted)
    tot["all_confirmed"] = sum(1 for r in rows if r["sure"] == "confirmed")
    return {"since": since, "until": until, "jobs": rows, "overhead": oh, "totals": tot,
            "stain_per_gallon": per_gal, "stain_per_gallon_set": per_gal_set, "bleach_per_gallon": BLEACH_PER_GALLON}
