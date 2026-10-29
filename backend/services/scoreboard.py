"""The three numbers, every day (Alan, 2026-10-29: "know three numbers every
Monday… let's master this right now, making sure we can capture this every
single day from now on").

    Cost to get a customer  Meta ad spend ÷ new paying customers
    Close rate              new paying customers ÷ estimates sent
    Profit per job          what a finished job left after crew, stain,
                            bleach, supplies and card fees (and after its
                            share of the ads)

All three over the 30 days ending on the day, so one slow day doesn't swing
them. A row is saved for every day (daily_scores), so a Monday can be read
against the Monday before and nothing has to be remembered.

The money watch rides along: what's sitting in Stripe, when the last payout
reached the bank, and whether Stripe wants anything. $28,800 sat in Stripe
for weeks in October 2026 without anyone noticing; it shouldn't again.

Where each number comes from:
  New paying customers  services/booked.py (each customer once, the day
                        they first paid anything, deposits and QuickBooks)
  Estimates sent        estimates.sent_at (test leads left out)
  Ad spend              what the bank was charged for Meta ads and other
                        marketing (Plaid categories); Meta's own report
                        when the bank isn't linked
  Finished jobs         company_cam_jobs.completed_at
  Job price             the job's final price, else what the customer was
                        booked at
  Crew                  flat lines; hourly lines priced from the worker's
                        clock-in hours that day split across their jobs,
                        or a full 8-hour day when there's no clock-in; a
                        line with no pay set uses the worker's hourly rate
                        (both flagged, so the number says it's estimated)
  Stain & materials     what the job logged; when it logged nothing, its
                        gallons (used, else needed) × the stain cost per
                        gallon (a setting, $45 until Alan changes it).
                        The bank's real stain spend sits beside it as a
                        check (it includes the HOA and anything not in
                        Company Cam, so it can't be split per job)
"""
from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from database import (BankTransaction, CompanyCamJob, DailyScore, Estimate, Lead, MaterialPurchase,
                      StainInventoryItem, User, WorkerShift)
from services.booked import CT, booked_customers

logger = logging.getLogger(__name__)

WINDOW_DAYS = 30
NO_CLOCK_HOURS = 8.0          # an hourly day with no clock-in counts as a full day
STAIN_COST_KEY = "stain_cost_per_gallon"
STAIN_COST_DEFAULT = 45.0     # until Alan sets the real number
STRIPE_STUCK_DOLLARS = 1000.0  # more than this sitting in Stripe…
STRIPE_STUCK_DAYS = 3          # …with no payout for this many days → tell Alan


def _window(day: date, days: int = WINDOW_DAYS) -> tuple[str, str]:
    return (day - timedelta(days=days - 1)).isoformat(), day.isoformat()


def _ct_day(iso: str) -> str:
    s = (iso or "").strip()
    if len(s) == 10:
        return s
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(CT).date().isoformat()
    except ValueError:
        return s[:10]


AD_CATEGORIES = ("Meta ads", "Other marketing")
MATERIAL_CATEGORIES = ("Stain & materials",)
CREW_CATEGORIES = ("Crew pay", "Payroll & contractors")


def bank_spend(db, since: str, until: str, categories: tuple[str, ...]) -> float | None:
    """Money out of the bank on [since, until] in these categories; None
    when no bank is linked."""
    if not db.query(BankTransaction.transaction_id).limit(1).first():
        return None
    rows = (db.query(BankTransaction.amount).filter(BankTransaction.date >= since, BankTransaction.date <= until,
                                                    BankTransaction.category.in_(categories)).all())
    return round(sum(float(a or 0) for (a,) in rows), 2)


# ── 1. Cost to get a customer ────────────────────────────────────────────
def ad_spend(since: str, until: str) -> float | None:
    """Meta spend on [since, until]; None when Meta isn't connected or fails."""
    from services import meta_ads
    if not meta_ads.is_configured():
        return None
    try:
        return round(sum(r["spend"] for r in meta_ads.insights("campaign", since, until)), 2)
    except Exception as e:  # noqa: BLE001
        logger.warning("scoreboard: Meta spend failed: %s", e)
        return None


def _estimates_sent(db, since: str, until: str) -> int:
    lo = datetime.fromisoformat(since).replace(tzinfo=CT).astimezone(timezone.utc).isoformat()
    hi = (datetime.fromisoformat(until).replace(tzinfo=CT) + timedelta(days=1)).astimezone(timezone.utc).isoformat()
    return (db.query(Estimate).join(Lead, Estimate.lead_id == Lead.id)
            .filter(Lead.is_test.is_(False), Estimate.sent_at >= lo, Estimate.sent_at < hi).count())


# ── 3. Profit per job ────────────────────────────────────────────────────
def _hours_by_worker_day(db, since: str, until: str) -> dict[tuple[str, str], float]:
    """(username lower, day) → clocked hours."""
    emp_to_user = {u.employee_id: u.username.lower() for u in db.query(User).filter(User.employee_id.isnot(None)).all()
                   if u.employee_id}
    out: dict[tuple[str, str], float] = defaultdict(float)
    for s in db.query(WorkerShift).filter(WorkerShift.work_date >= since, WorkerShift.work_date <= until).all():
        user = emp_to_user.get(s.employee_id)
        if not user or not s.clock_in or not s.clock_out:
            continue
        try:
            a = datetime.fromisoformat(s.clock_in.replace("Z", "+00:00"))
            b = datetime.fromisoformat(s.clock_out.replace("Z", "+00:00"))
        except ValueError:
            continue
        hrs = (b - a).total_seconds() / 3600
        if 0 < hrs < 16:
            out[(user, s.work_date)] += hrs
    return out


def stain_cost_per_gallon(db) -> tuple[float, bool]:
    """(dollars, set by Alan?)."""
    from database import SystemConfig
    try:
        v = float(SystemConfig.get(db, STAIN_COST_KEY, "") or 0)
    except ValueError:
        v = 0.0
    return (v, True) if v > 0 else (STAIN_COST_DEFAULT, False)


def job_profits(db, since: str, until: str, values: dict[str, float]) -> list[dict]:
    """Every job finished on [since, until] (Houston days) with what it left."""
    from api.company_cam import _crew_entries
    from api.materials import CARD_FEE_RATE, _bleach_item
    lo = (datetime.fromisoformat(since).replace(tzinfo=CT) - timedelta(days=1)).astimezone(timezone.utc).isoformat()
    jobs = [j for j in db.query(CompanyCamJob).filter(CompanyCamJob.completed_at >= lo).all()
            if since <= _ct_day(j.completed_at or "") <= until]
    if not jobs:
        return []
    test = {i for (i,) in db.query(Lead.id).filter(Lead.is_test.is_(True)).all()}
    jobs = [j for j in jobs if j.lead_id not in test]
    names = {l.id: l.contact_name for l in db.query(Lead.id, Lead.contact_name).filter(Lead.id.in_([j.lead_id for j in jobs])).all()}
    items = {i.id: i for i in db.query(StainInventoryItem).all()}
    bleach = _bleach_item(db)

    # Hourly lines: the worker's clocked hours that day, split across their hourly lines that day.
    all_lines = []
    for j in jobs:
        for e in _crew_entries(j):
            all_lines.append((j.lead_id, e))
    days = sorted({e["date"] for _, e in all_lines if e.get("date")}) or [since]
    hours = _hours_by_worker_day(db, days[0], days[-1])
    per_day: dict[tuple[str, str], int] = defaultdict(int)
    for _, e in all_lines:
        if e.get("pay_type") == "hourly" and e.get("date"):
            per_day[(e["username"].lower(), e["date"])] += 1

    # Shop supplies bought in the window, shared evenly across its jobs.
    supplies = sum(float(p.total_cost or 0) for p in db.query(MaterialPurchase).filter(
        MaterialPurchase.category == "supplies", MaterialPurchase.purchased_on >= since,
        MaterialPurchase.purchased_on <= until).all())
    share = supplies / len(jobs) if jobs else 0.0

    rates = {u.username.lower(): float(u.hourly_rate or 0) for u in db.query(User).all()}
    # Stain each job logged; the ones that came to $0 share the bank's stain
    # spend for the window, weighted by gallons (used, else needed, else equal).
    own: dict[str, tuple[float, float]] = {}
    for j in jobs:
        if j.materials_logged_at:
            own[j.lead_id] = (float(j.stain_cost or 0), float(j.bleach_cost or 0))
        else:
            st = items.get(j.final_stain_id or "")
            own[j.lead_id] = (float(j.stain_gallons_used or 0) * float(st.avg_cost or 0) if st else 0.0,
                              float(j.bleach_gallons_used or 0) * float(bleach.avg_cost or 0) if bleach else 0.0)
    per_gal, _ = stain_cost_per_gallon(db)
    rows = []
    for j in jobs:
        price = (j.final_price_cents or 0) / 100
        price_source = "final price"
        if price <= 0:
            price = float(values.get(j.lead_id) or 0)
            price_source = "booked value" if price else "missing"
        crew = 0.0
        guessed: list[str] = []
        for e in _crew_entries(j):
            kind, pay = e.get("pay_type"), float(e.get("pay") or 0)
            if kind == "flat":
                crew += pay
            elif kind == "hourly":
                key = (e["username"].lower(), e.get("date") or "")
                h = hours.get(key)
                if h:
                    crew += pay * h / max(1, per_day.get(key, 1))
                else:
                    crew += pay * NO_CLOCK_HOURS
                    guessed.append(f"{e['username']} {e.get('date') or 'no day'}")
            elif kind == "":
                # No pay set: the worker's hourly rate for a clocked or full day.
                key = (e["username"].lower(), e.get("date") or "")
                crew += rates.get(e["username"].lower(), 0.0) * (hours.get(key) or NO_CLOCK_HOURS)
                guessed.append(f"{e['username']} {e.get('date') or 'no day'} (no pay set)")
        stain, bl = own[j.lead_id]
        materials_source = "logged"
        if stain <= 0:
            gal = float(j.stain_gallons_used or 0) or float(j.gallons_needed or 0)
            stain = gal * per_gal
            materials_source = "per gallon" if gal else "no gallons"
        fees = price * CARD_FEE_RATE
        profit = price - crew - stain - bl - share - fees
        rows.append({"lead_id": j.lead_id, "customer": names.get(j.lead_id, ""), "finished": _ct_day(j.completed_at),
                     "price": round(price, 2), "price_source": price_source, "crew": round(crew, 2),
                     "materials": round(stain + bl, 2), "materials_source": materials_source,
                     "supplies": round(share, 2), "fees": round(fees, 2),
                     "profit": round(profit, 2), "guessed_crew": guessed})
    return rows


# ── The day's scores ─────────────────────────────────────────────────────
def compute(db, day: date | None = None, spend: float | None | bool = False) -> dict:
    """The three numbers for the 30 days ending on `day` (Houston). Pass
    `spend` to skip the Meta call (tests); False means look it up."""
    day = day or datetime.now(CT).date()
    since, until = _window(day)
    customers = booked_customers(db)
    new = [c for c in customers if since <= c["first_paid"] <= until]
    values = {c["lead_id"]: c["value"] for c in customers if c.get("lead_id")}
    sent = _estimates_sent(db, since, until)
    bank_ads = bank_spend(db, since, until, AD_CATEGORIES)
    bank_mat = bank_spend(db, since, until, MATERIAL_CATEGORIES)
    bank_crew = bank_spend(db, since, until, CREW_CATEGORIES)
    if spend is not False:
        spend_v, spend_source = spend, "given"
    elif bank_ads is not None:
        spend_v, spend_source = bank_ads, "bank"
    else:
        spend_v, spend_source = ad_spend(since, until), "meta"
    jobs = job_profits(db, since, until, values)
    per_gal, per_gal_set = stain_cost_per_gallon(db)
    priced = [j for j in jobs if j["price"] > 0]

    cac = round(spend_v / len(new), 2) if spend_v is not None and new else None
    close_rate = round(len(new) / sent * 100, 1) if sent else None
    ppj = round(sum(j["profit"] for j in priced) / len(priced), 2) if priced else None
    ppj_after_ads = round(ppj - cac, 2) if ppj is not None and cac is not None else None
    gaps = []
    if spend_v is None:
        gaps.append("Ad spend couldn't be read (no bank linked and Meta didn't answer), so cost per customer is missing.")
    missing_price = [j["customer"] for j in jobs if j["price_source"] == "missing"]
    if missing_price:
        gaps.append(f"{len(missing_price)} finished job(s) have no price: " + ", ".join(missing_price[:5]))
    guessed = sum(len(j["guessed_crew"]) for j in jobs)
    if guessed:
        gaps.append(f"{guessed} crew day(s) had no clock-in or no pay set; those were counted as {NO_CLOCK_HOURS:g} hours at the worker's rate.")
    est = sum(1 for j in jobs if j.get("materials_source") == "per gallon")
    if est:
        gaps.append(f"{est} job(s) have no stain receipt logged, so stain is gallons × ${per_gal:g} a gallon"
                    + ("" if per_gal_set else " (a starting guess: set the real cost per gallon)") + ".")
    nogal = [j["customer"] for j in jobs if j.get("materials_source") == "no gallons"]
    if nogal:
        gaps.append(f"{len(nogal)} job(s) have no gallons at all, so no stain cost: " + ", ".join(nogal[:5]))
    return {
        "day": day.isoformat(), "since": since, "until": until,
        "cac": cac, "ad_spend": spend_v, "ad_spend_source": spend_source, "new_customers": len(new),
        "close_rate": close_rate, "estimates_sent": sent,
        "profit_per_job": ppj, "profit_per_job_after_ads": ppj_after_ads,
        "jobs_finished": len(jobs), "revenue_finished": round(sum(j["price"] for j in priced), 2),
        "booked_value": round(sum(c["value"] for c in new), 2),
        "bank": {"ads": bank_ads, "stain_materials": bank_mat, "crew": bank_crew},
        "stain_per_gallon": per_gal, "stain_per_gallon_set": per_gal_set,
        "jobs": jobs, "gaps": gaps,
    }


# ── The money watch ──────────────────────────────────────────────────────
def stripe_watch(stripe_mod=None) -> dict:
    """What's in Stripe and when it last reached the bank. Never raises."""
    try:
        if stripe_mod is None:
            from api.stripe_pay import _stripe
            stripe_mod = _stripe()
        bal = stripe_mod.Balance.retrieve()
        acct = stripe_mod.Account.retrieve()
        payouts = stripe_mod.Payout.list(limit=10)["data"]
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)[:200]}
    usd = lambda rows: round(sum(r["amount"] for r in rows or [] if r.get("currency") == "usd") / 100, 2)  # noqa: E731
    day = lambda ts: datetime.fromtimestamp(int(ts), tz=timezone.utc).astimezone(CT).date().isoformat() if ts else ""  # noqa: E731
    paid = [p for p in payouts if p["status"] in ("paid", "in_transit", "pending")]
    last = max(paid, key=lambda p: p["created"]) if paid else None
    req = acct.get("requirements") or {}
    return {
        "ok": True, "ready": usd(bal.get("available")), "on_the_way": usd(bal.get("pending")),
        "last_payout": ({"amount": round(last["amount"] / 100, 2), "status": last["status"],
                         "sent": day(last["created"]), "arrives": day(last["arrival_date"])} if last else None),
        "failed_payouts": [{"amount": round(p["amount"] / 100, 2), "why": p.get("failure_message") or ""}
                           for p in payouts if p["status"] == "failed"],
        "payouts_enabled": bool(acct.get("payouts_enabled")),
        "stripe_needs": (req.get("currently_due") or []) + (req.get("past_due") or []),
    }


def bank_balances(db) -> list[dict]:
    from database import BankAccount
    return [{"name": a.name, "mask": a.mask, "balance": a.current_balance, "updated": a.updated_at}
            for a in db.query(BankAccount).order_by(BankAccount.mask).all()]


def money_problems(watch: dict, today: date) -> list[str]:
    """Plain sentences for anything that needs Alan. Empty = all good."""
    if not watch.get("ok"):
        return [f"Couldn't read Stripe: {watch.get('error', '')}"]
    out = []
    if not watch["payouts_enabled"]:
        out.append("Stripe payouts are switched off. Open Stripe and finish what it asks for.")
    if watch["stripe_needs"]:
        out.append(f"Stripe wants {len(watch['stripe_needs'])} thing(s) before it pays out. Open Stripe → Setup guide.")
    for f in watch["failed_payouts"]:
        out.append(f"A ${f['amount']:,.2f} payout failed{': ' + f['why'] if f['why'] else ''}.")
    last = watch.get("last_payout")
    days_since = (today - date.fromisoformat(last["sent"])).days if last else None
    if watch["ready"] >= STRIPE_STUCK_DOLLARS and (days_since is None or days_since >= STRIPE_STUCK_DAYS):
        when = "has never paid out" if last is None else f"last paid out {days_since} days ago"
        out.append(f"${watch['ready']:,.2f} is sitting in Stripe and it {when}.")
    return out


# ── Saving a day ─────────────────────────────────────────────────────────
def save_day(db, day: date | None = None) -> DailyScore:
    """Work the day out and keep it. Saving the same day again replaces it."""
    day = day or datetime.now(CT).date()
    s = compute(db, day)
    watch = stripe_watch()
    s["money"] = {"stripe": watch, "bank": bank_balances(db), "problems": money_problems(watch, day)}
    row = db.get(DailyScore, day.isoformat())
    if row is None:
        row = DailyScore(day=day.isoformat())
        db.add(row)
    row.cac, row.close_rate, row.profit_per_job = s["cac"], s["close_rate"], s["profit_per_job"]
    row.data_json = json.dumps(s, default=str)
    row.saved_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    return row


def history(db, days: int = 60) -> list[dict]:
    rows = db.query(DailyScore).order_by(DailyScore.day.desc()).limit(days).all()
    out = []
    for r in rows:
        try:
            d = json.loads(r.data_json or "{}")
        except ValueError:
            d = {}
        d.pop("jobs", None)
        out.append({"day": r.day, "cac": r.cac, "close_rate": r.close_rate, "profit_per_job": r.profit_per_job,
                    "saved_at": r.saved_at, **{k: d.get(k) for k in ("ad_spend", "new_customers", "estimates_sent",
                    "jobs_finished", "profit_per_job_after_ads", "booked_value")}})
    return out


# ── Every day, by itself ─────────────────────────────────────────────────
MONEY_TEXT_KEY = "scoreboard_money_texted"
MONDAY_TEXT_KEY = "scoreboard_monday_texted"


def _money(v: float | None) -> str:
    return "—" if v is None else f"${v:,.0f}"


def _pct(v: float | None) -> str:
    return "—" if v is None else f"{v:g}%"


def monday_message(now_row: dict, week_ago: dict | None) -> str:
    def move(key: str, fmt, better_up: bool) -> str:
        a, b = now_row.get(key), (week_ago or {}).get(key)
        if a is None or b is None or a == b:
            return ""
        up = a > b
        arrow = "up" if up else "down"
        good = up == better_up
        return f" ({arrow} from {fmt(b)}{'' if good else ', watch it'})"
    return ("Sterling, last 30 days:\n"
            f"Cost to get a customer: {_money(now_row.get('cac'))}{move('cac', _money, False)}\n"
            f"Close rate: {_pct(now_row.get('close_rate'))}{move('close_rate', _pct, True)}\n"
            f"Profit per job: {_money(now_row.get('profit_per_job'))}{move('profit_per_job', _money, True)}"
            f", {_money(now_row.get('profit_per_job_after_ads'))} after ads\n"
            "Details: Money → Overview")


def run_daily(now: datetime | None = None, send=None) -> dict:
    """Hourly tick. Saves yesterday once it's over (and today, so the page is
    fresh), texts Alan at 9 AM if money is stuck, and the three numbers on
    Monday at 8 AM. Each text goes once a day at most."""
    from config import get_settings
    from database import SystemConfig, get_db
    now = (now or datetime.now(timezone.utc)).astimezone(CT)
    today = now.date()
    done = {"saved": [], "texted": []}
    db = get_db()
    try:
        y = today - timedelta(days=1)
        if db.get(DailyScore, y.isoformat()) is None:
            save_day(db, y)
            done["saved"].append(y.isoformat())
        row = db.get(DailyScore, today.isoformat())
        if row is None or (row.saved_at or "") < (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat():
            row = save_day(db, today)
            done["saved"].append(today.isoformat())
        data = json.loads(row.data_json or "{}")
        owner = get_settings().owner_ghl_contact_id
        if send is None:
            from services.ghl import send_sms as send
        stamp = today.isoformat()
        problems = (data.get("money") or {}).get("problems") or []
        if owner and now.hour >= 9 and problems and SystemConfig.get(db, MONEY_TEXT_KEY, "") != stamp:
            if send(owner, "Money check:\n" + "\n".join("• " + p for p in problems)):
                SystemConfig.set(db, MONEY_TEXT_KEY, stamp)
                done["texted"].append("money")
        if owner and today.weekday() == 0 and now.hour >= 8 and SystemConfig.get(db, MONDAY_TEXT_KEY, "") != stamp:
            prev = db.get(DailyScore, (today - timedelta(days=7)).isoformat())
            prev_d = json.loads(prev.data_json) if prev and prev.data_json else None
            if send(owner, monday_message(data, prev_d)):
                SystemConfig.set(db, MONDAY_TEXT_KEY, stamp)
                done["texted"].append("monday")
        db.commit()
        return done
    finally:
        db.close()
