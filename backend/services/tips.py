"""Tips on the final bill (Alan, 2026-11-18: "add a way for customers to tip
on the invoice", "after the job is done only").

The tip is offered only on a balance link, the bill sent once the job is
finished, never on the $250 deposit. The customer picks No tip (the
default), $25, $50, $100 or types an amount. Stripe charges it as its own
line, "Tip for your crew". When the payment lands, the tip is kept out of
the job's revenue, because it's the crew's money, and split evenly between
everyone on the job's staining day, as a line on Crew hours next to that
week's pay. The office pays it out with the week, like a receipt.

Off for customers until the owner switches `tips_live` to "1" in
system_config. Staff previewing their own link (?preview=1) always see it,
so the page can be tried on a phone first.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from database import CompanyCamJob, CrewReimbursement, PayLink, SystemConfig, User

LIVE_KEY = "tips_live"
TIP_KINDS = ("balance",)
CHOICES = (2500, 5000, 10000)
MAX_TIP_CENTS = 100000          # $1,000: a typo guard, not a judgement
WHAT = "Customer tip"


def live(db) -> bool:
    return SystemConfig.get(db, LIVE_KEY, "") == "1"


def offered(db, link: PayLink, preview: bool = False) -> bool:
    """Does this link's pay page show the tip choices?"""
    if link.kind not in TIP_KINDS or link.status != "open" or (getattr(link, "brand", "") or "") == "at":
        return False
    return preview or live(db)


def clean_tip(db, link: PayLink, tip_cents: int | None, preview: bool = False) -> int:
    """The tip to charge: whole cents, never negative, never more than the
    cap, and zero on any link that doesn't offer one."""
    try:
        cents = int(tip_cents or 0)
    except (TypeError, ValueError):
        return 0
    if cents <= 0 or not offered(db, link, preview):
        return 0
    return min(cents, MAX_TIP_CENTS)


def _stain_crew(job: CompanyCamJob | None) -> tuple[list[str], str]:
    """Everyone on the job's staining days, and the last staining day."""
    if not job:
        return [], ""
    try:
        crew = json.loads(job.crew_json or "[]")
    except (TypeError, ValueError):
        return [], ""
    lines = [c for c in crew if (c.get("task") or "") == "staining" and c.get("username") and c.get("date")]
    if not lines:
        return [], ""
    names: list[str] = []
    for c in sorted(lines, key=lambda c: (c.get("date") or "", bool(c.get("helper")))):
        if c["username"] not in names:
            names.append(c["username"])
    return names, max(c["date"] for c in lines)


def split(total_cents: int, people: int) -> list[int]:
    """Even shares in cents; the leftover cents go to the first names."""
    if people <= 0 or total_cents <= 0:
        return []
    base, extra = divmod(total_cents, people)
    return [base + (1 if i < extra else 0) for i in range(people)]


def record(db, link: PayLink, tip_cents: int) -> list[CrewReimbursement]:
    """Put a paid tip on Crew hours, split evenly between the staining crew.
    Nothing is committed here. Returns the rows (empty when nobody was on
    the staining day; the caller logs that so the office can sort it)."""
    if tip_cents <= 0:
        return []
    job = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == link.lead_id).first()
    names, day = _stain_crew(job)
    if not names:
        return []
    shares = split(tip_cents, len(names))
    display = {u.username: (u.display_name or u.username) for u in db.query(User).filter(User.username.in_(names)).all()}
    now = datetime.now(timezone.utc).isoformat()
    note = WHAT if len(names) == 1 else f"{WHAT} (${tip_cents / 100:,.2f} split {len(names)} ways)"
    rows = [CrewReimbursement(id=str(uuid.uuid4()), username=u, name=display.get(u, u), work_date=day,
                              amount=round(cents / 100, 2), what=note, lead_id=link.lead_id,
                              paid_at="", created_at=now, created_by="tip")
            for u, cents in zip(names, shares)]
    for r in rows:
        db.add(r)
    return rows
