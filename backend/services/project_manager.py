"""David, the AI Project Manager: runs on the server, so it works with Alan's
computer off (Alan, 2026-11-06).

First job: the 9 PM job check, texted to Alan. Plain checks on the job
records, no model call, so it can't make anything up:

  1. Tomorrow and the next two days: someone on every job day, nobody on a
     day off (Brent never works Mondays; Christian usually doesn't, so ask),
     the colour confirmed before staining, and the stain lined up (gallons
     rounded up to 5s, on hand, a pickup in the notes).
  2. Today: each worker's check-in photo, check-out, hours, and the after
     photos for the work they were on.
  3. Crew finished but the job not closed (after photos in, no "Job done").
  4. Customers on these jobs who texted and got no answer.

What it can't see yet: the crew's own texts. They live on Alan's phone
(Brent SMS, Christian iMessage, Jose and Chris WhatsApp) until the crew line
moves to Twilio.

Switch: system_config pm_on ("0" turns it off). Last problem: pm_last_error.
"""

from __future__ import annotations

import json
import logging
import math
import re
from datetime import timedelta

from clock import ct_date_of, now_ct, to_ct, weekday_label

logger = logging.getLogger(__name__)

NAME = "David"                    # the Project Manager (Alan named him 2026-11-06)
SWITCH_KEY = "pm_on"
DAY_KEY = "pm_nightly_day"        # the Houston date the 9 PM check last went out
ERROR_KEY = "pm_last_error"
DAYS_OFF_KEY = "pm_days_off"      # JSON override of DAYS_OFF
CHECK_HOUR = 21                   # 9 PM Houston
LOOK_AHEAD = 3                    # today + the next 2 days
TEXT_LIMIT = 1000                 # GHL rejects over 1,600 and emojis count double

# username (lowercase) -> {"never": [weekdays], "ask": [weekdays]}, Monday = 0.
# Alan, 2026-11-06: "Brent always has Mondays off", "I usually don't work
# Christian on Mondays either".
DAYS_OFF = {
    "brentbrown": {"never": [0]},
    "christiangarza": {"ask": [0]},
}

AFTER_SECTION = {"cleaning": "clean_after", "staining": "stain_after"}


# ── Small pure helpers (tested) ──────────────────────────────────────────

def buy_in_fives(gallons: float) -> int:
    """Stain is bought in 5-gallon buckets: 8 -> 10, 13.5 -> 15, 0 -> 0."""
    if not gallons or gallons <= 0:
        return 0
    return int(math.ceil(gallons / 5.0) * 5)


def day_off_problem(username: str, day: str, rules: dict | None = None) -> str:
    """'never' / 'ask' / '' for this worker on this YYYY-MM-DD."""
    from datetime import date
    r = (rules if rules is not None else DAYS_OFF).get((username or "").lower(), {})
    wd = date.fromisoformat(day).weekday()
    if wd in r.get("never", []):
        return "never"
    if wd in r.get("ask", []):
        return "ask"
    return ""


def _words(s: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", (s or "").lower())


def match_stock(color: str, stock: list[dict]) -> dict | None:
    """The inventory row whose colour name is all inside the job's colour
    ("Ranchero Red" in "Rancho Red (SW 3044 Ranchero Red, WoodScapes solid)").
    The longest name wins, so "Dark Walnut" beats "Walnut"."""
    have = set(_words(color))
    best = None
    for s in stock:
        w = _words(s.get("color_name", ""))
        if w and all(x in have for x in w):
            if best is None or len(w) > len(_words(best["color_name"])):
                best = s
    return best


def pickup_planned(*notes: str) -> bool:
    text = " ".join(n or "" for n in notes).lower()
    return any(k in text for k in ("pick up", "pickup", "pick-up", "grab", "buy ", "order"))


def split_texts(header: str, sections: list[str], limit: int = TEXT_LIMIT) -> list[str]:
    """Pack sections into as few texts as fit under the limit, each with the header."""
    out: list[str] = []
    cur = header
    for s in sections:
        s = s.strip()
        if not s:
            continue
        if len(cur) + 2 + len(s) > limit and cur != header:
            out.append(cur)
            cur = header
        cur = (cur + "\n\n" + s)[: limit]
    if cur != header:
        out.append(cur)
    if len(out) > 1:
        out = [f"{t}\n({i}/{len(out)})" for i, t in enumerate(out, 1)]
    return out


# ── Reading the jobs ─────────────────────────────────────────────────────

def _rules(db) -> dict:
    from database import SystemConfig
    try:
        v = json.loads(SystemConfig.get(db, DAYS_OFF_KEY, "") or "{}")
        if isinstance(v, dict) and v:
            return {k.lower(): v[k] for k in v}
    except ValueError:
        pass
    return DAYS_OFF


def _stock(db) -> list[dict]:
    from database import StainInventoryItem as StainInventory
    return [r.to_dict() for r in db.query(StainInventory).filter(StainInventory.active.is_(True)).all()]


def _short(name: str) -> str:
    return (name or "").split(" ")[0] or "?"


def _customer(name: str) -> str:
    # First name + last initial: enough for Alan, short for a text.
    parts = (name or "").split()
    if len(parts) >= 2:
        return f"{parts[0]} {parts[1][0]}."
    return name or "?"


def upcoming(db, today: str) -> list[str]:
    """Problems on the job days from tomorrow to LOOK_AHEAD-1 days out."""
    from api.pm_calendar import _rows
    from database import CompanyCamJob
    from clock import add_days_iso
    start, end = add_days_iso(today, 1), add_days_iso(today, LOOK_AHEAD - 1)
    rows = [r for r in _rows(db, start, end) if not r["completed_at"]]
    rules, stock = _rules(db), _stock(db)
    lines: list[str] = []
    seen_stain: set[str] = set()
    for r in rows:
        day = f"{weekday_label(r['date'], short=True)} {r['date'][5:].replace('-', '/')}"
        who, cust = _short(r["person"]), _customer(r["name"])
        off = day_off_problem(r["username"], r["date"], rules)
        if off == "never":
            lines.append(f"🚫 {day} {cust}: {who} is on, but he's always off that day")
        elif off == "ask":
            lines.append(f"❓ {day} {cust}: {who} is on. He usually has that day off, OK?")
        if r["task"] != "staining" or r["helper"] or r["lead_id"] in seen_stain:
            continue
        seen_stain.add(r["lead_id"])
        job = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == r["lead_id"]).first()
        if job is None:
            continue
        color = job.final_color or job.color or ""
        if not color.strip() or not job.color_confirmed:
            lines.append(f"🎨 {day} {cust}: color not confirmed yet")
            continue
        need = float(job.gallons_needed or 0)
        buy = buy_in_fives(need)
        s = match_stock(color, stock)
        on_hand = float(s["gallons"]) if s else 0.0
        planned = pickup_planned(job.staining_notes, job.briefing)
        if need <= 0:
            lines.append(f"🪣 {day} {cust}: no gallons on the job, can't check stain")
        elif on_hand < need and not planned:
            lines.append(f"🪣 {day} {cust}: needs ~{need:g} gal, app shows {on_hand:g} on hand. "
                         f"Buy {buy} and set who picks it up")
        elif on_hand < need and planned:
            lines.append(f"🪣 {day} {cust}: pickup in the notes. Needs ~{need:g} gal (buy in 5s: {buy})")
    return lines


def today_check(db, today: str) -> tuple[list[str], list[str]]:
    """(problems, done) for the crew days on today."""
    from api.pm_calendar import _rows
    from database import CompanyCamPhoto, HoursLog, JobVisit
    rows = _rows(db, today, today)
    problems, done = [], []
    for r in rows:
        who, cust, user = _short(r["person"]), _customer(r["name"]), r["username"]
        photos = (db.query(CompanyCamPhoto.section, CompanyCamPhoto.uploaded_sub,
                           CompanyCamPhoto.taken_at, CompanyCamPhoto.uploaded_at)
                  .filter(CompanyCamPhoto.lead_id == r["lead_id"]).all())
        todays = [p for p in photos if ct_date_of(p[2] or p[3]) == today]
        mine = [p for p in todays if (p[1] or "").lower() == user.lower()]
        missing = []
        if not any(p[0].endswith("before") for p in mine):
            missing.append("check-in photo")
        if not db.query(JobVisit).filter(JobVisit.lead_id == r["lead_id"], JobVisit.username == user,
                                         JobVisit.work_date == today).first():
            missing.append("check-out")
        if not db.query(HoursLog).filter(HoursLog.username == user, HoursLog.work_date == today).first():
            missing.append("hours")
        sec = AFTER_SECTION.get(r["task"])
        if sec and not r["helper"] and not any(p[0] == sec for p in todays):
            missing.append("after photos")
        if missing:
            problems.append(f"⚠️ {who} at {cust} ({r['task'] or 'job'}): no {', no '.join(missing)}")
        else:
            done.append(f"{who} {cust}")
    return problems, done


def waiting_on_ok(db) -> list[str]:
    """Stain-after photos in, no "Job done": crew finished, Alan's OK + bill."""
    from database import CompanyCamJob, CompanyCamPhoto, Lead
    ids = {x[0] for x in db.query(CompanyCamPhoto.lead_id).filter(CompanyCamPhoto.section == "stain_after").distinct()}
    if not ids:
        return []
    jobs = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id.in_(ids)).all()
    open_ids = [j.lead_id for j in jobs if not (j.completed_at or "").strip()]
    if not open_ids:
        return []
    names = {l.id: l.contact_name for l in db.query(Lead).filter(Lead.id.in_(open_ids)).all()}
    return [f"✅ {_customer(names.get(i, ''))}: after photos in, not marked done. Inspect + bill"
            for i in open_ids][:8]


THANKS = re.compile(r"^\W*(thank(s| you)?( so much)?|ok(ay)?|great|perfect|sounds good|awesome|👍|🙏)+\W*$", re.I)


def unanswered_customers(db, today: str) -> list[str]:
    """Customers with a job in the window whose last text is theirs, over an
    hour old and from the last 3 days. Not counted as waiting: a thank-you, a
    text answered by a call back, a payment after it, or a job finished after
    it (the crew showing up was the answer)."""
    from api.pm_calendar import _rows
    from database import CompanyCamJob, Lead, Message, PayLink
    from clock import add_days_iso, now_utc
    ids = {r["lead_id"] for r in _rows(db, add_days_iso(today, -1), add_days_iso(today, LOOK_AHEAD - 1))}
    out = []
    for lid in ids:
        # A call back counts as an answer; "Opportunity updated" rows don't.
        last = (db.query(Message).filter(Message.lead_id == lid, Message.message_type.notlike("TYPE_ACTIVITY%"))
                .order_by(Message.created_at.desc()).first())
        if not last or last.direction != "inbound" or "CALL" in (last.message_type or ""):
            continue
        t = to_ct(last.created_at)
        if t is None or (now_utc() - t) < timedelta(hours=1) or (now_utc() - t) > timedelta(days=3):
            continue
        body = (last.body or "").strip().replace("\n", " ")
        if THANKS.match(body):
            continue
        if not body and (last.attachments_json or "[]") != "[]":
            body = "[photo]"
        if db.query(PayLink).filter(PayLink.lead_id == lid, PayLink.paid_at > last.created_at).first():
            continue
        job = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lid).first()
        if job and (job.completed_at or "") > last.created_at:
            continue
        lead = db.get(Lead, lid)
        when = t.strftime('%-I:%M %p') if t.strftime('%Y-%m-%d') == today else t.strftime('%a %-m/%-d %-I:%M %p')
        out.append(f"💬 {_customer(lead.contact_name if lead else '')} texted {when}, no answer: \"{body[:80]}\"")
    return out


# ── The nightly text ─────────────────────────────────────────────────────

def nightly_report(db, today: str | None = None) -> list[str]:
    today = today or now_ct().strftime("%Y-%m-%d")
    sections = []
    ahead = upcoming(db, today)
    sections.append("📅 NEXT 2 DAYS\n" + ("\n".join(ahead) if ahead else "All set: crew, colors, stain"))
    problems, done = today_check(db, today)
    if problems or done:
        t = "🧰 TODAY\n" + "\n".join(problems)
        if done:
            t += ("\n" if problems else "") + "All in: " + ", ".join(done)
        sections.append(t)
    ok = waiting_on_ok(db)
    if ok:
        sections.append("🏁 WAITING ON YOU\n" + "\n".join(ok))
    msgs = unanswered_customers(db, today)
    if msgs:
        sections.append("📲 CUSTOMERS\n" + "\n".join(msgs))
    header = f"🗂️ DAVID · 9 PM JOB CHECK ({weekday_label(today, short=True)} {today[5:].replace('-', '/')})"
    return split_texts(header, sections)


def on(db) -> bool:
    from database import SystemConfig
    return SystemConfig.get(db, SWITCH_KEY, "1") != "0"


def note_error(db, what: str) -> None:
    try:
        from database import SystemConfig
        from clock import now_iso
        SystemConfig.set(db, ERROR_KEY, f"{now_iso()} | {what}"[:900])
        db.commit()
    except Exception:  # noqa: BLE001
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


def tick(db) -> dict:
    """Called every few minutes. Sends the 9 PM check once a day."""
    if not on(db):
        return {}
    from database import SystemConfig
    now = now_ct()
    today = now.strftime("%Y-%m-%d")
    if now.hour < CHECK_HOUR or SystemConfig.get(db, DAY_KEY, "") == today:
        return {}
    # Mark first, so a crash mid-send never texts Alan twice.
    SystemConfig.set(db, DAY_KEY, today)
    db.commit()
    try:
        texts = nightly_report(db, today)
        from services.stella import text_alan
        sent = sum(1 for t in texts if text_alan(t))
        return {"nightly": sent}
    except Exception as e:  # noqa: BLE001
        db.rollback()
        logger.exception("PM nightly check failed")
        note_error(db, f"nightly: {e!r}")
        return {"error": str(e)}
