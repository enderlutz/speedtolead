"""Did they leave the Google review? (Alan, 2026-10-31: "I just like to
mark if that customer left a review or not", and the second ask is a
button he presses and a text he can edit, never automatic: "if it's
done on a certain basis, it's gonna not be done right").

The mark lives on the lead (form_data["google_review"]), one per
customer, not per pay link. The text goes out through GHL like every
other customer text, and each send is written down here."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from config import proposal_base
from database import Lead, PayLink

STATUSES = ("", "not_yet", "posted")

# The person the text comes from. Olga texts customers as Amy (booking.py).
SENDER = {"olga": "Amy", "amy": "Amy"}
DEFAULT_SENDER = "Alan"


def _data(lead: Lead) -> dict:
    try:
        d = json.loads(lead.form_data or "{}")
    except (TypeError, ValueError):
        d = {}
    return d if isinstance(d, dict) else {}


def state(lead: Lead) -> dict:
    d = _data(lead)
    g = d.get("google_review") or {}
    if not isinstance(g, dict):
        g = {}
    reminders = g.get("reminders") if isinstance(g.get("reminders"), list) else []
    # Posted means the shared key is set (the lead page's journey tick writes
    # and clears that same key), so the two marks can never disagree.
    if d.get("google_review_left_at"):
        return {"status": "posted", "marked_by": d.get("google_review_marked_by") or g.get("marked_by") or "",
                "marked_at": d["google_review_left_at"], "reminders": reminders}
    not_yet = g.get("status") == "not_yet"
    return {
        "status": "not_yet" if not_yet else "",
        "marked_by": (g.get("marked_by") or "") if not_yet else "",
        "marked_at": (g.get("marked_at") or "") if not_yet else "",
        "reminders": reminders,
    }


def _save(db, lead: Lead, g: dict) -> None:
    d = _data(lead)
    d["google_review"] = g
    # Keep the older keys in step, for anything still reading them.
    if g.get("status") == "posted":
        d["google_review_left_at"] = g.get("marked_at") or d.get("google_review_left_at")
        d["google_review_marked_by"] = g.get("marked_by") or ""
    else:
        d.pop("google_review_left_at", None)
        d.pop("google_review_marked_by", None)
    lead.form_data = json.dumps(d)
    db.commit()


def set_status(db, lead: Lead, status: str, by: str) -> dict:
    if status not in STATUSES:
        raise ValueError("posted, not_yet or blank")
    s = state(lead)
    g = {"status": status, "marked_by": by if status else "", "reminders": s["reminders"],
         "marked_at": datetime.now(timezone.utc).isoformat() if status else ""}
    _save(db, lead, g)
    return state(lead)


def add_reminder(db, lead: Lead, by: str, message: str) -> dict:
    s = state(lead)
    s["reminders"].append({"at": datetime.now(timezone.utc).isoformat(), "by": by, "message": message})
    g = {"status": s["status"], "marked_by": s["marked_by"], "marked_at": s["marked_at"], "reminders": s["reminders"][-20:]}
    _save(db, lead, g)
    return state(lead)


def after_url(db, lead_id: str) -> str:
    """The paid-in-full page: their fence photos, the one-tap save and the
    Google button. The newest paid final bill wins; nothing paid, no link."""
    links = (db.query(PayLink).filter(PayLink.lead_id == lead_id, PayLink.status == "paid",
                                      PayLink.kind.in_(("balance", "full", "done")))
             .order_by(PayLink.paid_at.desc()).all())
    return f"{proposal_base()}/after/{links[0].token}" if links else ""


def sender_name(user: dict | None) -> str:
    sub = ((user or {}).get("sub") or "").lower()
    return SENDER.get(sub, DEFAULT_SENDER)


def draft(lead: Lead, url: str, sender: str = DEFAULT_SENDER) -> str:
    """The second ask, in Alan's words, with the photos page so they land on
    the same screen as the first time. He edits it before it goes."""
    first = (lead.contact_name or "").strip().split(" ")[0] or "there"
    where = f" Your fence photos and the link are here: {url}" if url else ""
    return f"Hey {first}, it's {sender} with Sterling. Did you get a chance to post that Google review? It would mean a lot to the crew.{where}"


def clicked(links: list[PayLink]) -> bool:
    """They tapped the Google button on the paid-in-full page."""
    for l in links:
        try:
            a = json.loads(l.answers or "{}")
        except (TypeError, ValueError):
            continue
        if isinstance(a, dict) and a.get("review_clicked") is True:
            return True
    return False
