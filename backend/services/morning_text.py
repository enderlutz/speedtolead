"""Alan's 7:30 AM text (2026-10-31: "go ahead and implement the 7:30 a.m.
text"), the morning partner of the 9 PM brief. Built from the records, no AI,
so it is the same every day and never makes anything up:

  today's jobs (crew, deposit, color), tomorrow's, the week's holds with no
  deposit or no crew, jobs done but not invoiced, bills that need a friendly
  reminder, and how many tasks from his recordings are still open.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import Column, Text

from database import Base, Booking, CompanyCamJob, Idea, Lead, PayLink, User, get_db

logger = logging.getLogger(__name__)
HOU = ZoneInfo("America/Chicago")
SEND_AT = (7, 30)


class MorningText(Base):
    __tablename__ = "morning_texts"

    day = Column(Text, primary_key=True)       # YYYY-MM-DD, Houston
    body = Column(Text, default="")
    sent_at = Column(Text, default="")


def _first(name: str) -> str:
    return ((name or "").strip().split() or [""])[0].title()


def _jobs(db, day: str) -> list[dict]:
    names = {u.username: (u.display_name or u.username) for u in db.query(User).all()}
    out = []
    for b in db.query(Booking).filter(Booking.date == day, Booking.status != "cancelled").all():
        lead = db.query(Lead).filter(Lead.id == b.lead_id).first()
        if not lead:
            continue
        job = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == b.lead_id).first()
        try:
            crew = json.loads(job.crew_json or "[]") if job else []
        except ValueError:
            crew = []
        who = sorted({_first(names.get(c.get("username"), c.get("username") or "")) for c in crew
                      if c.get("username") and c.get("date") in (day, "")})
        links = db.query(PayLink).filter(PayLink.lead_id == b.lead_id, PayLink.status != "void",
                                         PayLink.kind.in_(("deposit", "full"))).all()
        deposit = "paid" if any(l.status == "paid" for l in links) else "sent" if links else "none"
        color = ((job.final_color or job.color) if job else "") or b.color or ""
        out.append({"name": (lead.contact_name or "").strip().title() or "No name", "tier": (b.tier or "").title(),
                    "color": color.split("·")[0].strip(), "crew": who, "deposit": deposit,
                    "done": bool(job and job.completed_at)})
    return out


def _line(j: dict) -> str:
    bits = [j["name"]]
    if j["tier"]:
        c = j["color"]
        picked_later = not c or c.lower().startswith("tbd")
        bits.append(j["tier"] + (", color picked at cleaning" if picked_later else f", {c}"))
    bits.append(" + ".join(j["crew"]) if j["crew"] else "NO CREW")
    if j["deposit"] != "paid":
        bits.append("NO DEPOSIT" if j["deposit"] == "none" else "deposit not paid")
    return "• " + " · ".join(bits)


def build(db, now: datetime | None = None) -> str:
    now = (now or datetime.now(timezone.utc)).astimezone(HOU)
    today = now.date()
    d = lambda n: (today + timedelta(days=n)).isoformat()  # noqa: E731
    parts = [f"Good morning Alan ☀️ {now.strftime('%A %b')} {today.day}"]

    tj = _jobs(db, d(0))
    parts.append("TODAY: " + ("nothing booked" if not tj else f"{len(tj)} job{'s' if len(tj) > 1 else ''}"))
    parts += [_line(j) for j in tj]
    mj = _jobs(db, d(1))
    if mj:
        parts.append("TOMORROW:")
        parts += [_line(j) for j in mj]

    week = [(d(n), j) for n in range(2, 8) for j in _jobs(db, d(n))]
    no_dep = [f"{j['name']} ({datetime.fromisoformat(day).strftime('%a')})" for day, j in week if j["deposit"] != "paid"]
    no_crew = sum(1 for _, j in week if not j["crew"])
    if week:
        parts.append(f"THIS WEEK: {len(week)} more job{'s' if len(week) > 1 else ''}"
                     + (f", {no_crew} with no crew" if no_crew else ""))
        if no_dep:
            parts.append("No deposit yet: " + ", ".join(no_dep))

    try:
        from api.invoice_queue import stage_rows
        from services.pay_reminders import needs_reminder
        rows = stage_rows(db)
        ready = [r["name"].title() for r in rows if r["stage"] == "ready"]
        if ready:
            parts.append("Done, not invoiced: " + ", ".join(ready))
        nudge = []
        for r in rows:
            if r["stage"] != "invoice_sent":
                continue
            bills = [l for l in db.query(PayLink).filter(PayLink.lead_id == r["lead_id"], PayLink.status == "open").all()
                     if needs_reminder(l)]
            if bills:
                nudge.append(f"{r['name'].title()} ${r['due']:,.0f}")
        if nudge:
            parts.append("Unpaid, ready for a friendly reminder: " + ", ".join(nudge))
    except Exception as e:  # noqa: BLE001 — the jobs part still goes
        logger.warning("morning text: invoice part failed: %s", e)

    open_tasks = db.query(Idea).filter(Idea.timeframe == "week", Idea.stage.in_(("idea", "working"))).count()
    if open_tasks:
        parts.append(f"{open_tasks} tasks for this week on Ideas/Tasks.")
    return "\n".join(parts)


def run(now: datetime | None = None, send=None) -> str | None:
    """Send today's text once, at or after 7:30 AM Houston (until 11)."""
    now = now or datetime.now(timezone.utc)
    local = now.astimezone(HOU)
    if (local.hour, local.minute) < SEND_AT or local.hour >= 11:
        return None
    day = local.date().isoformat()
    db = get_db()
    try:
        if db.query(MorningText).filter(MorningText.day == day).first():
            return None
        body = build(db, now)
        db.add(MorningText(day=day, body=body, sent_at=now.isoformat()))
        db.commit()
    finally:
        db.close()
    if send is None:
        from services.after_pay_hooks import alert_alan as send
    send(body)
    return body
