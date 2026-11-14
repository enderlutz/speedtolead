"""The owner's command center: the Dashboard tab (Alan, 2026-11-14: "when the
owner opens this page, they should understand the state of the business in
about 10 seconds").

Read-only. Every number comes from something the app already keeps; when a
number isn't kept anywhere yet (crew capacity, a job's start time) the
section says so instead of guessing:

  scorecard   booked / collected / goal / owed: services.money_overview
  actions     what needs a person now: new leads nobody has called, call-backs
              due, leads who texted back or opened their price with no talk
              since (On call's bucket A), held days with no deposit, open
              balance links, requotes, go-backs, crew finished but no "Job done"
  today       the crew days on today (PM HQ's calendar rows), one card a job
  pipeline    new → priced → opened → waiting on us → booked → done
  marketing   Meta spend + leads, and what our own records say those leads did
  week        the next 7 days: jobs, crew, value starting, held unpaid days
  collections deposits due, open balance links, QuickBooks balances
  alerts      exceptions only, worst first

Each section is worked out on its own, so one failing (Meta down) leaves the
rest of the page up. The whole answer is kept 60 s; Meta's numbers 15 min.
"""
from __future__ import annotations

import json
import logging
import re
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from clock import add_days_iso, day_bounds_utc, parse_iso, today_ct, weekday_label

logger = logging.getLogger(__name__)

CACHE_SECONDS = 60
META_CACHE_SECONDS = 15 * 60
CALL_WITHIN_MIN = 15          # a new lead nobody has called after this is red
PRICE_WITHIN_H = 24           # priced the same day (Alan's attack order)
PRICE_LIST_DAYS = 7           # new/unpriced leads older than this leave the Action Center
NEW_LEAD_DAYS = 21            # older un-priced leads belong to LATER, not today's list
FOLLOW_UP_DAYS = 3           # replies/opens older than this live on On call, not here
OVERDUE_DAYS = 7              # a balance link unpaid this long is overdue
CPL_WATCH = 45.0              # Erhan's test rule: over $45 a lead, kill or fix
SKIP_LOCATIONS = {"painting upsell"}

_cache: dict = {"at": 0.0, "data": None}
_meta_cache: dict = {"key": "", "at": 0.0, "data": None}


# ── small helpers ────────────────────────────────────────────────────────

def _t(s) -> datetime | None:
    d = parse_iso(s) if s else None
    if d and d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d


def _hours(since: datetime | None, now: datetime) -> float | None:
    return round((now - since).total_seconds() / 3600, 2) if since else None


def _sig(tiers: str | None) -> float:
    try:
        return float((json.loads(tiers or "{}") or {}).get("signature") or 0)
    except (TypeError, ValueError, AttributeError):
        return 0.0


def _day_label(d: str) -> str:
    return f"{weekday_label(d, short=True)} {int(d[5:7])}/{int(d[8:10])}"


def _money(v: float) -> str:
    return f"${v:,.0f}"


def _section(name: str, fn, *args):
    try:
        return fn(*args)
    except Exception as e:  # noqa: BLE001
        logger.exception("command center: %s failed", name)
        return {"error": f"{type(e).__name__}: {e}"[:200]}


class _Ctx:
    """What several sections share, read once."""

    def __init__(self, db, now: datetime):
        from database import Estimate, Lead
        from services.booked import booked_customers
        self.db, self.now = db, now
        self.today = today_ct().isoformat()
        self.leads = {l.id: l for l in db.query(Lead).filter(Lead.is_test.is_(False)).all()}
        self.customers = booked_customers(db)
        self.paid_ids = {r["lead_id"] for r in self.customers if r.get("lead_id")}
        self.value = {r["lead_id"]: r["value"] for r in self.customers if r.get("lead_id")}
        self.price: dict[str, float] = {}
        self.sent_at: dict[str, datetime] = {}
        for lid, tiers, sent in (db.query(Estimate.lead_id, Estimate.tiers, Estimate.sent_at)
                                 .order_by(Estimate.created_at).all()):
            if lid not in self.leads:
                continue
            if (s := _sig(tiers)):
                self.price[lid] = s
            if (d := _t(sent)) and (lid not in self.sent_at or d > self.sent_at[lid]):
                self.sent_at[lid] = d
        self._paid_by_lead = None
        from database import Booking
        # A lead with a day held (or given) is past "new": it had a price and a talk.
        self.booked_ids = {lid for (lid,) in db.query(Booking.lead_id).filter(Booking.status != "cancelled").all()}
        self._buckets = None
        self._owed = None
        self._scheduled = None
        self._jobs: dict | None = None

    def owed(self) -> dict:
        """Money owed on finished jobs only (services.money_overview.owed)."""
        if self._owed is None:
            from services.money_overview import owed
            self._owed = owed(self.db)
        return self._owed

    def scheduled(self) -> list[dict]:
        if self._scheduled is None:
            from services.booked import scheduled_customers
            self._scheduled = scheduled_customers(self.db, self.customers)
        return self._scheduled

    def cc_job(self, lead_id: str):
        if self._jobs is None:
            from database import CompanyCamJob
            self._jobs = {j.lead_id: j for j in self.db.query(CompanyCamJob).all()}
        return self._jobs.get(lead_id)

    def buckets(self) -> dict:
        if self._buckets is None:
            from services.lead_buckets import buckets
            self._buckets = buckets(self.db, self.now)
        return self._buckets

    def live(self, lead) -> bool:
        return (lead.status or "") not in ("archived", "contact") and (lead.pipeline_version or "") != "contact" \
            and (lead.division or "fence") != "brick" and not lead.do_not_contact \
            and (lead.location_label or "").strip().lower() not in SKIP_LOCATIONS

    def name(self, lid: str) -> str:
        l = self.leads.get(lid)
        return ((l.contact_name if l else "") or "").strip() or "No name"

    def paid_by_lead(self) -> dict[str, float]:
        """Money in per lead: Stripe payments + what QuickBooks marks paid."""
        if self._paid_by_lead is None:
            from database import CustomerPayment, QuickbooksInvoice
            out: dict[str, float] = defaultdict(float)
            for lid, c in self.db.query(CustomerPayment.lead_id, CustomerPayment.amount_cents).all():
                out[lid] += (c or 0) / 100
            for lid, paid in (self.db.query(QuickbooksInvoice.lead_id, QuickbooksInvoice.amount_paid)
                              .filter(QuickbooksInvoice.status != "void").all()):
                if lid:
                    out[lid] += float(paid or 0)
            self._paid_by_lead = out
        return self._paid_by_lead

    def came_in(self, lead) -> datetime | None:
        a, b = _t(lead.created_at), _t(lead.oncall_at)
        return max([x for x in (a, b) if x], default=None)


# ── 1. Scorecard ─────────────────────────────────────────────────────────

def scorecard(ctx: _Ctx) -> dict:
    from database import SystemConfig
    from services.booked import GOAL_KEY
    from services.money_overview import overview
    ov = overview(ctx.db)
    m = ov["month"]
    booked, goal = float(m["booked"] or 0), float(m["goal"] or 0)
    jobs = int(m["jobs"] or 0)
    # Last month to the same day, so "vs last month" is fair on the 14th.
    t = date.fromisoformat(ctx.today)
    last_end = t.replace(day=1) - timedelta(days=1)
    last_start = last_end.replace(day=1)
    same_day = last_start.replace(day=min(t.day, last_end.day)).isoformat()
    last_to_date = [r for r in ctx.customers if last_start.isoformat() <= r["first_paid"] <= same_day]
    ltd = round(sum(r["value"] for r in last_to_date), 2)
    from services.money_overview import collected
    last_coll = collected(ctx.db, last_start.isoformat(), same_day)["total"]
    return {
        "month": m["start"][:7],
        "booked": booked, "booked_last_to_date": ltd, "jobs": jobs, "jobs_last_to_date": len(last_to_date),
        "collected": m["collected"]["total"], "collected_last_to_date": last_coll,
        "goal": goal, "goal_set": bool((SystemConfig.get(ctx.db, GOAL_KEY, "") or "").strip()),
        "goal_pct": round(booked / goal * 100, 1) if goal else None,
        "pace": m["pace"], "last_month": m["last_month"],
        "owed": ov["owed"]["total"],
        "avg_job": round(booked / jobs, 2) if jobs else None,
        # What's behind each number, for the tiles' "what is this" panel.
        "booked_list": sorted(
            [{"lead_id": r["lead_id"], "name": r["name"], "date": r["first_paid"], "amount": r["value"]}
             for r in ctx.customers if m["start"] <= r["first_paid"] <= ctx.today],
            key=lambda r: r["date"], reverse=True),
        "collected_list": _collected_list(ctx, m["start"], ctx.today),
        "owed_list": [{"lead_id": r["lead_id"], "name": r["name"], "date": r["since"], "amount": r["amount"],
                       "note": " + ".join(r["sources"])} for r in ctx.owed()["rows"]],
        "unmatched_quickbooks": ctx.owed().get("unmatched_quickbooks", 0.0),
        "collected_stripe": m["collected"]["stripe"], "collected_quickbooks": m["collected"]["quickbooks"],
        **_pw_month(ctx, m["start"]),
    }


_MONEY = re.compile(r"\$\s?([\d,]+(?:\.\d{2})?)")
_TOTAL = re.compile(r"total[^$\n]{0,20}\$\s?([\d,]+(?:\.\d{2})?)", re.I)


def _pw_price(summary: str, description: str) -> float | None:
    """The job's price from its calendar event: a "total $X" line, else the
    biggest $ in the title. None when the event has no price."""
    for text in (description or "", summary or ""):
        m = _TOTAL.search(text)
        if m:
            return float(m.group(1).replace(",", ""))
    vals = [float(v.replace(",", "")) for v in _MONEY.findall(summary or "")]
    if vals:
        return max(vals)
    notes = {float(v.replace(",", "")) for v in _MONEY.findall(description or "")}
    return notes.pop() if len(notes) == 1 else None


def _pw_month(ctx: _Ctx, start: str) -> dict:
    """A&T pressure washing / window jobs this month (Alan, 2026-11-14: "a
    little red section" on Booked). Read from the red (tomato) A&T events on
    the Google Calendar, kept apart from the fence numbers."""
    from calendar import monthrange
    y, mth = int(start[:4]), int(start[5:7])
    end = f"{start[:8]}{monthrange(y, mth)[1]:02d}"
    try:
        from services.google_calendar import list_events
        evs = list_events(ctx.db, time_min=f"{start}T00:00:00-06:00", time_max=f"{end}T23:59:59-06:00")
    except Exception as e:  # noqa: BLE001
        logger.warning("command center: calendar read failed: %s", e)
        return {"pw_list": [], "pw_total": 0.0, "pw_known": False}
    rows = []
    for ev in evs:
        if ev.get("status") == "cancelled":
            continue
        if ev.get("color_id") != "11" and ev.get("service_type") != "power_washing":
            continue
        title = (ev.get("summary") or "").replace("A&T's Pressure Washing · ", "")
        price = _pw_price(ev.get("summary") or "", ev.get("description") or "")
        rows.append({"lead_id": "", "name": title[:90], "date": (ev.get("start") or "")[:10],
                     "amount": price or 0.0, "note": "price not on the event" if price is None else ""})
    rows.sort(key=lambda r: r["date"])
    return {"pw_list": rows, "pw_total": round(sum(r["amount"] for r in rows), 2), "pw_known": True}


def _collected_list(ctx: _Ctx, start: str, end: str) -> list[dict]:
    """Every payment counted in "Collected this month", newest first."""
    from database import CustomerPayment, QuickbooksInvoice
    lo, _ = day_bounds_utc(start)
    _, hi = day_bounds_utc(end)
    out = []
    for p in ctx.db.query(CustomerPayment).filter(CustomerPayment.created_at >= lo, CustomerPayment.created_at < hi).all():
        if p.lead_id not in ctx.leads:
            continue
        kind = {"deposit": "Deposit", "balance": "Final balance", "full": "Paid in full", "extra": "Extra"}.get(p.kind, p.kind or "Payment")
        out.append({"lead_id": p.lead_id, "name": ctx.name(p.lead_id), "date": (p.created_at or "")[:10],
                    "amount": round((p.amount_cents or 0) / 100, 2), "note": f"{kind} · {p.method or 'card'} · Stripe"})
    for i in (ctx.db.query(QuickbooksInvoice).filter(QuickbooksInvoice.status != "void",
                                                     QuickbooksInvoice.txn_date >= start, QuickbooksInvoice.txn_date <= end).all()):
        paid = float(i.amount_paid if i.amount_paid is not None else (i.total_amount or 0) - (i.balance or 0))
        if paid > 0.005:
            out.append({"lead_id": i.lead_id or "", "name": i.customer_name or "", "date": (i.txn_date or "")[:10],
                        "amount": round(paid, 2), "note": "QuickBooks invoice (by invoice date)"})
    return sorted(out, key=lambda r: r["date"], reverse=True)


# ── 2. Action center ─────────────────────────────────────────────────────

def _item(kind, title, lead_id="", who="", amount=None, since=None, priority="amber", action="Open", href="",
          detail="", now=None):
    return {"kind": kind, "title": title, "lead_id": lead_id, "who": who, "amount": amount,
            "since": since.isoformat() if since else "", "waiting_hours": _hours(since, now) if since and now else None,
            "priority": priority, "action": action, "href": href or (f"/leads/{lead_id}" if lead_id else ""),
            "detail": detail}


def actions(ctx: _Ctx) -> list[dict]:
    from database import Booking, CompanyCamJob, CompanyCamPhoto, EstimateCorrectionRequest, FixJob, PayLink
    db, now = ctx.db, ctx.now
    out: list[dict] = []

    # New leads: nobody has called, or called and not priced.
    for l in ctx.leads.values():
        if not ctx.live(l) or l.id in ctx.paid_ids or l.id in ctx.sent_at or l.id in ctx.booked_ids:
            continue
        came = ctx.came_in(l)
        if not came or now - came > timedelta(days=NEW_LEAD_DAYS):
            continue
        if not (l.first_call_at or "").strip() and not (l.added_by or "").strip():
            if now - came > timedelta(days=PRICE_LIST_DAYS):
                continue   # older: the pipeline's "New, not priced" count
            mins = (now - came).total_seconds() / 60
            out.append(_item("new_lead", "New lead, nobody has called", l.id, ctx.name(l.id), since=came,
                             priority="red" if mins > CALL_WITHIN_MIN else "amber", action="Call now", now=now,
                             detail=l.address or "No address yet"))
        elif not (l.address or "").strip():
            out.append(_item("need_address", "Can't price yet: no address", l.id, ctx.name(l.id), since=came,
                             priority="amber", action="Get address", now=now))
        else:
            if now - came > timedelta(days=PRICE_LIST_DAYS):
                continue   # older un-priced leads: the pipeline's "New, not priced" count
            late = now - came > timedelta(hours=PRICE_WITHIN_H)
            out.append(_item("price_it", "Called, no price sent yet", l.id, ctx.name(l.id), since=came,
                             priority="red" if late else "amber", action="Send estimate", now=now, detail=l.address))

    # Call-backs promised, due by tonight (the last 3 days still count).
    end_today = _t(day_bounds_utc(ctx.today)[1])
    for l in ctx.leads.values():
        cb = _t(l.callback_at)
        if not cb or l.id in ctx.paid_ids or not ctx.live(l) or cb > end_today or now - cb > timedelta(days=3):
            continue
        out.append(_item("callback", "Call-back due" + (f": {l.callback_note}" if l.callback_note else ""),
                         l.id, ctx.name(l.id), amount=ctx.price.get(l.id) or None, since=cb,
                         priority="red" if cb < now else "amber", action="Call back", now=now))

    # Texted back or opened their price, nobody has talked to them since.
    for r in ctx.buckets().get("a", []):
        if r["lead_id"] not in ctx.leads or not ctx.live(ctx.leads[r["lead_id"]]):
            continue
        since = _t(r.get("last_text_at")) if r["why"].startswith("Texted") else _t(r.get("viewed_at"))
        if not since or now - since > timedelta(days=FOLLOW_UP_DAYS):
            continue   # older ones stay on On call's list and the pipeline count
        late = since and now - since > timedelta(hours=24)
        out.append(_item("follow_up", r["why"].split(" · ")[0], r["lead_id"], r["name"] or "No name",
                         amount=r.get("price") or None, since=since, priority="red" if late else "amber",
                         action="Follow up", now=now, detail=(r.get("last_text") or "")[:120]))

    # Held days, no deposit yet.
    for b in db.query(Booking).filter(Booking.status == "held", Booking.date >= ctx.today).all():
        if b.lead_id in ctx.paid_ids or b.lead_id not in ctx.leads:
            continue
        soon = b.date[:10] <= add_days_iso(ctx.today, 3)
        out.append(_item("deposit", f"Day held ({_day_label(b.date[:10])}), no $250 yet", b.lead_id,
                         ctx.name(b.lead_id), amount=(b.total_cents or 0) / 100 or None,
                         since=_t(b.sent_at or b.created_at), priority="red" if soon else "amber",
                         action="Collect deposit", now=now))

    # Money owed on a FINISHED job (never a deposit or financing link, never
    # a job that hasn't happened: Alan, 2026-11-14).
    for r in ctx.owed()["rows"]:
        since = _t(r["since"] + "T12:00:00+00:00") if r.get("since") else None
        old = since and now - since > timedelta(days=OVERDUE_DAYS)
        out.append(_item("balance", "Job done, balance not paid" + (" (overdue)" if old else ""), r["lead_id"],
                         r["name"] or ctx.name(r["lead_id"]), amount=r["amount"], since=since,
                         priority="red" if old else "amber", action="Collect payment", now=now,
                         detail=" + ".join(r["sources"])))

    # Requote asked for on the proposal.
    for c in db.query(EstimateCorrectionRequest).filter(EstimateCorrectionRequest.resolved_at.is_(None)).all():
        if c.lead_id not in ctx.leads:
            continue
        out.append(_item("requote", "Customer asked for a requote", c.lead_id, ctx.name(c.lead_id),
                         since=_t(c.requested_at), priority="red", action="Fix estimate", now=now,
                         detail=(c.text or "")[:120]))

    # Go-backs (Jobs to fix). Alan's rule: we do them when a crew is already
    # in the area, never out of the way, so they're information, not urgent.
    for f in db.query(FixJob).filter((FixJob.done_at.is_(None)) | (FixJob.done_at == "")).all():
        out.append(_item("go_back", "Go-back: " + ((f.description or "something to fix")[:80]), f.lead_id or "",
                         (ctx.name(f.lead_id) if f.lead_id in ctx.leads else (f.name or "")), since=_t(f.created_at),
                         priority="blue", action="View go-backs", href="/pm-hq", now=now,
                         detail=f"On {_day_label(f.date)}" if f.date else "Do it when a crew is in the area"))

    # Crew finished (stain-after photos in) and nobody tapped "Job done".
    ids = {x for (x,) in db.query(CompanyCamPhoto.lead_id).filter(CompanyCamPhoto.section == "stain_after").distinct()}
    if ids:
        for j in db.query(CompanyCamJob).filter(CompanyCamJob.lead_id.in_(ids)).all():
            if (j.completed_at or "").strip() or j.lead_id not in ctx.leads:
                continue
            out.append(_item("inspect", "Crew finished: inspect, mark done, bill", j.lead_id, ctx.name(j.lead_id),
                             amount=ctx.value.get(j.lead_id), since=_t(j.updated_at), priority="amber",
                             action="View job", href=f"/company-cam/{j.lead_id}", now=now))

    rank = {"red": 0, "amber": 1, "blue": 2}
    out.sort(key=lambda i: (rank.get(i["priority"], 3), -(i["waiting_hours"] or 0)))
    return out


# ── 3. Today's jobs + 6. next 7 days ─────────────────────────────────────

def _job_rows(ctx: _Ctx, start: str, end: str) -> list[dict]:
    from api.pm_calendar import _rows
    return _rows(ctx.db, start, end)


def _job_value(ctx: _Ctx, lead_id: str) -> float:
    if lead_id in ctx.value:
        return ctx.value[lead_id]
    from services.booked import _unpaid_value
    j = ctx.cc_job(lead_id)
    return _unpaid_value(ctx.db, j) if j else 0.0


def today_jobs(ctx: _Ctx) -> list[dict]:
    rows = _job_rows(ctx, ctx.today, ctx.today)
    jobs: dict[str, dict] = {}
    for r in rows:
        j = jobs.setdefault(r["lead_id"], {
            "lead_id": r["lead_id"], "name": r["name"] or "No name", "address": r["address"], "order": r["order"],
            "crew": [], "tasks": [], "color": r["color"], "stage": (r["progress"] or {}).get("stage", ""),
            "percent": (r["progress"] or {}).get("percent", 0), "done": bool(r["completed_at"]),
            "needs_day": bool(r.get("needs_day")), "services": r.get("pw_services") or [],
        })
        j["crew"].append({"person": r["person"], "task": r["task"], "helper": bool(r["helper"])})
        if r["task"] and r["task"] not in j["tasks"]:
            j["tasks"].append(r["task"])
        if r["order"] and (not j["order"] or r["order"] < j["order"]):
            j["order"] = r["order"]
    paid = ctx.paid_by_lead()
    for lid, j in jobs.items():
        value = _job_value(ctx, lid)
        got = round(paid.get(lid, 0.0), 2)
        j["value"], j["paid"] = value, got
        j["left"] = round(max(value - got, 0), 2) if value else None
        blockers = []
        if not j["crew"] or all(c["helper"] for c in j["crew"]):
            blockers.append("No crew lead on it")
        if got <= 0:
            blockers.append("No deposit")
        if "staining" in j["tasks"]:
            cj = ctx.cc_job(lid)
            if cj is not None and (not (j["color"] or "").strip() or not cj.color_confirmed):
                blockers.append("Color not confirmed")
        if not (j["address"] or "").strip():
            blockers.append("No address")
        if j["needs_day"]:
            blockers.append("Needs another day")
        j["blockers"] = blockers
        j["status"] = "Done" if j["done"] else (j["stage"] or "Scheduled")
    return sorted(jobs.values(), key=lambda j: (j["done"], j["order"] or 99, j["name"].lower()))


def week(ctx: _Ctx) -> dict:
    from database import Booking, SystemConfig
    end = add_days_iso(ctx.today, 6)
    rows = _job_rows(ctx, ctx.today, end)
    starts = defaultdict(float)
    sched_by_day = defaultdict(list)
    for r in ctx.scheduled():
        if ctx.today <= r["scheduled_on"] <= end:
            starts[r["scheduled_on"]] += float(r["value"] or 0)
            sched_by_day[r["scheduled_on"]].append(r)
    held = defaultdict(list)
    for b in ctx.db.query(Booking).filter(Booking.status == "held", Booking.date >= ctx.today, Booking.date <= end).all():
        if b.lead_id not in ctx.paid_ids and b.lead_id in ctx.leads:
            held[b.date[:10]].append(ctx.name(b.lead_id))
    try:
        capacity = int(SystemConfig.get(ctx.db, "daily_job_capacity", "") or 0) or None
    except ValueError:
        capacity = None
    days = []
    for i in range(7):
        d = add_days_iso(ctx.today, i)
        mine = [r for r in rows if r["date"] == d]
        leads = {r["lead_id"] for r in mine}
        crew = sorted({r["person"] for r in mine})
        # Closed and on the calendar this day, but no crew on it yet.
        no_crew = [r["name"] or "No name" for r in sched_by_day.get(d, []) if r["lead_id"] not in leads
                   and not any(x["lead_id"] == r["lead_id"] for x in rows)]
        dow = date.fromisoformat(d).weekday()
        days.append({
            "date": d, "label": _day_label(d), "jobs": len(leads) + len(no_crew), "crew": crew, "no_crew": no_crew,
            "tasks": sorted({r["task"] for r in mine if r["task"]}),
            "value_starting": round(starts.get(d, 0.0), 2), "held_unpaid": held.get(d, []),
            "capacity": capacity, "utilization": round((len(leads) + len(no_crew)) / capacity * 100) if capacity else None,
            "empty": not leads and not no_crew, "sunday": dow == 6,
        })
    return {"days": days, "capacity_known": capacity is not None}


# ── 4. Pipeline ──────────────────────────────────────────────────────────

def pipeline(ctx: _Ctx) -> dict:
    from database import CompanyCamJob
    now = ctx.now
    b = ctx.buckets()

    def stage(key, label, rows, since_key, href, action):
        vals = [float(r.get("price") or r.get("value") or 0) for r in rows]
        ages = [(now - d).total_seconds() / 86400 for r in rows if (d := _t(r.get(since_key)))]
        return {"key": key, "label": label, "count": len(rows), "value": round(sum(vals), 2),
                "avg_days": round(sum(ages) / len(ages), 1) if ages else None, "href": href, "action": action}

    new_rows = []
    for l in ctx.leads.values():
        if not ctx.live(l) or l.id in ctx.paid_ids or l.id in ctx.sent_at or l.id in ctx.booked_ids:
            continue
        came = ctx.came_in(l)
        if came and now - came <= timedelta(days=NEW_LEAD_DAYS):
            new_rows.append({"since": came.isoformat()})
    warm = [r for r in b.get("b", []) if r["lead_id"] in ctx.leads and ctx.live(ctx.leads[r["lead_id"]])]
    not_opened = [r for r in warm if not r.get("viewed_at")]
    opened = [r for r in warm if r.get("viewed_at")]
    waiting = [r for r in b.get("a", []) if r["lead_id"] in ctx.leads and ctx.live(ctx.leads[r["lead_id"]])]
    for r in waiting:
        r["since"] = r.get("last_text_at") or r.get("viewed_at")
    booked = [dict(r) for r in ctx.scheduled() if r["scheduled_on"] >= ctx.today]
    for r in booked:
        r["since"] = r.get("first_paid") or ""
    m_start = ctx.today[:8] + "01"
    done = []
    for j in ctx.db.query(CompanyCamJob).filter(CompanyCamJob.completed_at >= m_start).all():
        if j.lead_id in ctx.leads:
            done.append({"value": _job_value(ctx, j.lead_id), "since": j.completed_at})

    stages = [
        stage("new", "New, not priced", new_rows, "since", "/on-call", "Price them"),
        stage("not_opened", "Priced, not opened", not_opened, "sent_at", "/on-call", "Call them"),
        stage("opened", "Opened, no decision", opened, "viewed_at", "/on-call", "Follow up"),
        stage("waiting", "Waiting on us", waiting, "since", "/on-call", "Follow up today"),
        stage("booked", "Booked, job ahead", booked, "since", "/pm-hq", "View jobs"),
        stage("done", "Done this month", done, "since", "/pm-hq", "View jobs"),
    ]
    # The bottleneck: the deciding stage holding the most money.
    open_stages = [s for s in stages if s["key"] in ("not_opened", "opened", "waiting")]
    worst = max(open_stages, key=lambda s: s["value"]) if open_stages else None
    bottleneck = None
    if worst and worst["count"]:
        words = {"not_opened": "have a price they haven't opened",
                 "opened": "opened their price and haven't decided",
                 "waiting": "are waiting on us (texted back or opened, nobody has talked to them)"}[worst["key"]]
        bottleneck = {"key": worst["key"], "text": f"{worst['count']} leads {words}: {_money(worst['value'])} in play.",
                      "href": worst["href"], "action": worst["action"]}
    return {"stages": stages, "bottleneck": bottleneck,
            "note": "Priced stages cover the last 60 days (On call's Warm list). Older prices sit in Cold."}


# ── 5. Marketing ─────────────────────────────────────────────────────────

def _meta(since: str, until: str) -> dict | None:
    key = f"{since}:{until}"
    if _meta_cache["key"] == key and time.time() - _meta_cache["at"] < META_CACHE_SECONDS:
        return _meta_cache["data"]
    from services import meta_ads
    if not meta_ads.is_configured():
        return None
    try:
        rows = meta_ads.insights("campaign", since, until)
        data = {"spend": round(sum(r["spend"] for r in rows), 2), "leads": sum(r["leads"] for r in rows)}
    except Exception as e:  # noqa: BLE001
        logger.warning("command center: Meta failed: %s", e)
        data = None
    _meta_cache.update(key=key, at=time.time(), data=data)
    return data


def marketing(ctx: _Ctx) -> dict:
    from database import Contact
    from services.contact_mirror import at_location_ids
    since, until = ctx.today[:8] + "01", ctx.today
    meta = _meta(since, until)
    # Sterling's ad leads that came in this month (A&T has its own ads).
    rows = (ctx.db.query(Contact.id, Contact.lead_id).filter(Contact.ad_id.isnot(None), Contact.ad_id != "",
                                                              Contact.date_added >= since)
            .filter(~Contact.ghl_location_id.in_(at_location_ids())).all())
    our_leads = len(rows)
    lead_ids = {lid for _, lid in rows if lid}
    priced = sum(1 for lid in lead_ids if lid in ctx.sent_at)
    won = [lid for lid in lead_ids if lid in ctx.paid_ids]
    customers = len(won)
    revenue = round(sum(ctx.value.get(lid, 0.0) for lid in won), 2)
    spend = meta["spend"] if meta else None
    return {
        "since": since, "until": until, "meta_connected": meta is not None,
        "spend": spend, "meta_leads": meta["leads"] if meta else None,
        "leads": our_leads, "estimates": priced, "booked": customers,
        "cpl": round(spend / meta["leads"], 2) if meta and meta["leads"] else None,
        "conversion_pct": round(customers / our_leads * 100, 1) if our_leads else None,
        "cost_per_booked": round(spend / customers, 2) if spend is not None and customers else None,
        "booked_from_ads": revenue,
        "roas": round(revenue / spend, 2) if spend else None,
        "note": "Booked counts ad leads that came in this month and have paid (job value). "
                "Leads from earlier months who pay now aren't in it, so early in a month these run low.",
    }


# ── 7. Collections ───────────────────────────────────────────────────────

def collections(ctx: _Ctx) -> dict:
    from database import Booking, PayLink, QuickbooksInvoice
    deposits = []
    for b in ctx.db.query(Booking).filter(Booking.status == "held", Booking.date >= ctx.today).all():
        if b.lead_id in ctx.paid_ids or b.lead_id not in ctx.leads:
            continue
        deposits.append({"lead_id": b.lead_id, "name": ctx.name(b.lead_id), "amount": 250.0,
                         "job_value": (b.total_cents or 0) / 100, "due": b.date[:10], "status": "Day held, unpaid"})
    ow = ctx.owed()
    balances = []
    for r in ow["rows"]:
        d = r.get("since") or ""
        days = (date.fromisoformat(ctx.today) - date.fromisoformat(d)).days if d else None
        balances.append({"lead_id": r["lead_id"], "name": r["name"], "amount": r["amount"], "sent": d, "days": days,
                         "overdue": bool(days is not None and days > OVERDUE_DAYS), "status": " + ".join(r["sources"])})
    # QuickBooks balances not tied to anyone in the app: shown to check only.
    qb = []
    for i in ctx.db.query(QuickbooksInvoice).filter(QuickbooksInvoice.status != "void").all():
        bal = float(i.balance or 0)
        if bal <= 0.005 or i.lead_id:
            continue
        d = (i.txn_date or "")[:10]
        days = (date.fromisoformat(ctx.today) - date.fromisoformat(d)).days if d else None
        qb.append({"lead_id": "", "name": i.customer_name or "", "amount": round(bal, 2), "sent": d,
                   "days": days, "overdue": False, "status": "QuickBooks, not matched"})
    # Due this week: jobs on the calendar in the next 7 days with money left.
    paid = ctx.paid_by_lead()
    due_week = []
    end = add_days_iso(ctx.today, 6)
    for r in ctx.scheduled():
        if not (ctx.today <= r["scheduled_on"] <= end):
            continue
        left = round(float(r["value"] or 0) - paid.get(r["lead_id"], 0.0), 2)
        if left > 1:
            due_week.append({"lead_id": r["lead_id"], "name": r["name"], "amount": left, "due": r["scheduled_on"]})
    o = ow
    # QuickBooks balances are shown, not counted as overdue: billing moved to
    # Stripe in Oct 2026 and many old QuickBooks balances were paid another
    # way and never marked.
    overdue = round(sum(x["amount"] for x in balances if x["overdue"]), 2)
    return {
        "deposits": sorted(deposits, key=lambda x: x["due"]),
        "balances": sorted(balances, key=lambda x: -(x["days"] or 0)),
        "quickbooks": sorted(qb, key=lambda x: -(x["days"] or 0))[:25], "quickbooks_count": len(qb),
        "due_this_week": sorted(due_week, key=lambda x: x["due"]),
        "due_this_week_total": round(sum(x["amount"] for x in due_week), 2),
        "deposits_total": round(sum(x["amount"] for x in deposits), 2),
        "overdue_total": overdue, "owed_total": o["total"],
        "stripe_open_total": round(sum(x["amount"] for x in balances), 2),
        "quickbooks_open_total": round(sum(x["amount"] for x in qb), 2),
    }


# ── 8. Alerts ────────────────────────────────────────────────────────────

def alerts(ctx: _Ctx, acts: list | dict, wk: dict, coll: dict, mk: dict, today: list | dict) -> list[dict]:
    out: list[dict] = []

    def add(level, text, href=""):
        out.append({"level": level, "text": text, "href": href})

    if isinstance(acts, list):
        uncalled = [a for a in acts if a["kind"] == "new_lead" and a["priority"] == "red"]
        if uncalled:
            add("red", f"{len(uncalled)} new lead{'s' if len(uncalled) > 1 else ''} not called after {CALL_WITHIN_MIN} min", "/on-call")
        unpriced = [a for a in acts if a["kind"] == "price_it" and a["priority"] == "red"]
        if unpriced:
            add("red", f"{len(unpriced)} called lead{'s' if len(unpriced) > 1 else ''} still without a price after a day", "/on-call")
        cb = [a for a in acts if a["kind"] == "callback" and a["priority"] == "red"]
        if cb:
            add("red", f"{len(cb)} call-back{'s' if len(cb) > 1 else ''} past the promised time", "/on-call")
    if isinstance(coll, dict) and coll.get("overdue_total"):
        add("red", f"{_money(coll['overdue_total'])} in balances overdue", "/money")
    if isinstance(wk, dict):
        tomorrow = add_days_iso(ctx.today, 1)
        for d in wk.get("days", []):
            if d["date"] == tomorrow and d["held_unpaid"]:
                add("red", f"Tomorrow has {len(d['held_unpaid'])} held day{'s' if len(d['held_unpaid']) > 1 else ''} with no deposit ({', '.join(d['held_unpaid'][:3])})", "/pm-hq")
        for d in wk.get("days", []):
            for n in d.get("no_crew", []):
                soon = d["date"] <= add_days_iso(ctx.today, 3)
                add("red" if soon else "amber", f"{d['label']}: {n} is booked, no crew on it yet", "/pm-hq")
        empty = [d["label"] for d in wk.get("days", []) if d["empty"] and not d["sunday"] and d["date"] != ctx.today]
        if empty:
            add("amber", f"Nothing booked: {', '.join(empty)}", "/pm-hq")
    if isinstance(today, list):
        for j in today:
            for b in j["blockers"]:
                if b in ("No crew lead on it", "Color not confirmed", "No address"):
                    add("red", f"Today, {j['name']}: {b.lower()}", f"/company-cam/{j['lead_id']}")
    try:
        from services.project_manager import missing_addresses, upcoming
        for line in upcoming(ctx.db, ctx.today) + missing_addresses(ctx.db, ctx.today):
            add("amber", line, "/pm-hq")
    except Exception as e:  # noqa: BLE001
        logger.warning("command center: PM checks failed: %s", e)
    if isinstance(mk, dict) and mk.get("cpl") and mk["cpl"] > CPL_WATCH:
        add("amber", f"Facebook cost per lead is {_money(mk['cpl'])} this month (watch line {_money(CPL_WATCH)})", "/marketing")
    rank = {"red": 0, "amber": 1, "blue": 2}
    out.sort(key=lambda a: rank.get(a["level"], 3))
    return out


# ── the whole page ───────────────────────────────────────────────────────

def build(db, now: datetime | None = None, fresh: bool = False) -> dict:
    if not fresh and _cache["data"] is not None and time.time() - _cache["at"] < CACHE_SECONDS:
        return _cache["data"]
    now = now or datetime.now(timezone.utc)
    ctx = _Ctx(db, now)
    sc = _section("scorecard", scorecard, ctx)
    acts = _section("actions", actions, ctx)
    td = _section("today", today_jobs, ctx)
    pl = _section("pipeline", pipeline, ctx)
    mk = _section("marketing", marketing, ctx)
    wk = _section("week", week, ctx)
    coll = _section("collections", collections, ctx)
    al = _section("alerts", alerts, ctx, acts, wk, coll, mk, td)
    data = {"generated_at": now.isoformat(), "today": ctx.today, "scorecard": sc, "actions": acts, "today_jobs": td,
            "pipeline": pl, "marketing": mk, "week": wk, "collections": coll, "alerts": al}
    _cache.update(at=time.time(), data=data)
    return data
