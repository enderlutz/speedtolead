"""The Invoice Queue (Alan, 2026-10-23): every customer with money in
motion, in five stages left to right.

  1. Deposit sent, not paid  - an open $250 link, made in the last 30 days.
  2. Deposit paid, waiting   - the $250 (or the whole job) is in; the crew
                               hasn't finished.
  3. Ready for invoice       - the crew tapped "I'm finished". The main
                               trigger: a finished job lands here whether or
                               not the $250 was ever paid (some customers are
                               scared to pay up front).
  4. Invoice sent            - a balance / paid-in-full / extra link is out
                               and not paid.
  5. Paid & closed           - the bill was paid through Stripe, or the
                               office closed it out as paid another way
                               (cash, check, Zelle, QuickBooks).

Nothing here is stored as a stage: it's worked out from the pay links, the
Stripe payments and the crew's "Job done" stamp each time it's opened, so
nothing has to remember to move a card.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.permissions import require_perm
from database import get_db, Booking, CompanyCamJob, CustomerPayment, Lead, PayLink
from services import after_pay_hooks as hooks
from services.activity_log import log_event

logger = logging.getLogger(__name__)
router = APIRouter()

STAGES = ("deposit_sent", "deposit_paid", "ready", "invoice_sent", "closed")
BILL_KINDS = ("balance", "full", "extra")
DEPOSIT_SENT_DAYS = 30
CLOSED_DAYS = 60
CLOSE_HOW = {"cash": "Cash", "check": "Check", "zelle": "Zelle", "quickbooks": "QuickBooks",
             "card": "Card in person", "other": "Other"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ts(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _actor(user: dict) -> str:
    return user.get("name") or user.get("sub") or ""


def _extras_cents(job: CompanyCamJob | None) -> int:
    if not job:
        return 0
    try:
        from services.company_cam import site_extras
        return int(site_extras(job).get("total_cents") or 0)
    except Exception:  # noqa: BLE001 — a bad extras row never hides the queue
        return 0


def qb_paid_cents(db, lead_ids) -> dict[str, int]:
    """Money paid on QuickBooks invoices, per lead: the $250 deposits taken
    before Stripe (Christopher's #1111, Oct 6). QuickBooks never holds a copy
    of a Stripe payment, so the two add up without counting anything twice."""
    from database import QuickbooksInvoice
    ids = [i for i in lead_ids if i]
    if not ids:
        return {}
    out: dict[str, int] = {}
    for q in (db.query(QuickbooksInvoice)
              .filter(QuickbooksInvoice.lead_id.in_(ids), QuickbooksInvoice.status.in_(("paid", "partial"))).all()):
        out[q.lead_id] = out.get(q.lead_id, 0) + int(round(float(q.amount_paid or 0) * 100))
    return out


def _link(l: PayLink) -> dict:
    return {
        "token": l.token, "kind": l.kind, "status": l.status,
        "amount": (l.amount_cents or 0) / 100,
        "created_at": l.created_at or "", "sent_at": l.sent_at or "", "paid_at": l.paid_at or "",
        "view_count": l.view_count or 0, "last_viewed_at": l.last_viewed_at or "",
        "expired": hooks.deposit_link_expired(l),
    }


def stage_rows(db, now: datetime | None = None) -> list[dict]:
    """One row per customer in the queue, with its stage. Shared by the page
    and the tests."""
    now = now or datetime.now(timezone.utc)
    links = (db.query(PayLink)
             .filter(PayLink.kind.in_(("deposit", "full", "balance", "extra", "done")), PayLink.status != "void")
             .order_by(PayLink.created_at.asc()).all())
    by_lead: dict[str, list[PayLink]] = {}
    for l in links:
        by_lead.setdefault(l.lead_id, []).append(l)
    done_jobs = {j.lead_id: j for j in db.query(CompanyCamJob)
                 .filter(CompanyCamJob.completed_at.isnot(None), CompanyCamJob.completed_at != "").all()}
    lead_ids = set(by_lead) | set(done_jobs)
    if not lead_ids:
        return []
    jobs = dict(done_jobs)
    missing = [i for i in lead_ids if i not in jobs]
    if missing:
        jobs.update({j.lead_id: j for j in db.query(CompanyCamJob).filter(CompanyCamJob.lead_id.in_(missing)).all()})
    leads = {l.id: l for l in db.query(Lead).filter(Lead.id.in_(lead_ids)).all()}
    pays: dict[str, list[CustomerPayment]] = {}
    for p in db.query(CustomerPayment).filter(CustomerPayment.lead_id.in_(lead_ids)).all():
        pays.setdefault(p.lead_id, []).append(p)
    qb = qb_paid_cents(db, lead_ids)
    bookings: dict[str, Booking] = {}
    for b in (db.query(Booking).filter(Booking.lead_id.in_(lead_ids), Booking.status != "cancelled")
              .order_by(Booking.created_at.asc()).all()):
        bookings[b.lead_id] = b      # the latest one wins

    out = []
    for lid in lead_ids:
        lead = leads.get(lid)
        if not lead:
            continue
        ls = by_lead.get(lid, [])
        job = jobs.get(lid)
        b = bookings.get(lid)
        done_at = (job.completed_at if job else "") or ""
        closed_at = (job.closed_at if job else "") or ""
        paid_cents = sum(p.amount_cents or 0 for p in pays.get(lid, [])) + qb.get(lid, 0)
        deposits = [l for l in ls if l.kind == "deposit"]
        dep_paid = next((l for l in reversed(deposits) if l.status == "paid"), None)
        dep_paid_any = dep_paid is not None or any(p.kind == "deposit" for p in pays.get(lid, [])) or qb.get(lid, 0) > 0
        dep_open = next((l for l in reversed(deposits) if l.status == "open"), None)
        bills = [l for l in ls if l.kind in BILL_KINDS]
        # A "pay in full" link the customer made from the proposal and never
        # paid is an offer, not a bill the office sent (exolei's sat open
        # after she paid the $250 instead).
        open_bills = [l for l in bills if l.status == "open" and not (l.kind == "full" and l.created_by == "customer")]
        paid_bills = [l for l in bills if l.status == "paid"]
        full_paid = any(l.kind in ("full", "balance") for l in paid_bills)
        # A paid balance is the final bill: the job is closed even when the
        # crew never tapped "I'm finished" (jobs from before that button).
        balance_paid = any(l.kind == "balance" for l in paid_bills)
        # "done" = "you're all paid up" texted after a payment some other way.
        settled = next((l for l in ls if l.kind == "done" and l.status == "paid"), None)

        total_cents = ((b.total_cents if b else 0)
                       or next((l.job_total_cents for l in reversed(deposits) if l.job_total_cents), 0)
                       or next((l.job_total_cents for l in reversed(bills) if l.kind == "full" and l.job_total_cents), 0)
                       or (job.final_price_cents if job else 0) or 0)
        extras_cents = _extras_cents(job)

        if closed_at or ((balance_paid or (done_at and (full_paid or settled))) and not open_bills):
            stage = "closed"
            when = closed_at or max([l.paid_at or "" for l in paid_bills] + [settled.paid_at if settled else ""] + [done_at])
            if (_ts(when) or now) < now - timedelta(days=CLOSED_DAYS):
                continue
        elif done_at and any(l.sent_at for l in open_bills):
            stage, when = "invoice_sent", max(l.sent_at or l.created_at or "" for l in open_bills)
        elif done_at:
            # A bill made but never texted is still waiting on us: it stays in
            # Ready, with the bill on the card (Alan, 2026-10-26, Donnie Beasley).
            stage, when = "ready", done_at
        elif dep_paid_any or full_paid:
            stage, when = "deposit_paid", (b.date if b else "") or (dep_paid.paid_at if dep_paid else "") or ""
        elif dep_open or any(l.kind == "full" and l.status == "open" for l in bills):
            dep_open = dep_open or next(l for l in reversed(bills) if l.kind == "full" and l.status == "open")
            created = _ts(dep_open.created_at)
            if created and created < now - timedelta(days=DEPOSIT_SENT_DAYS):
                continue
            stage, when = "deposit_sent", dep_open.sent_at or dep_open.created_at or ""
        else:
            continue

        # The latest itemized total we texted them wins over the records
        # (Alan, 2026-10-29: the job said $3,044.40, the text said $3,456.90).
        # A $250 with no job total (the quick $250) gets a guess from the call.
        # Closed jobs are left as they were.
        total_source, total_why = ("booking" if total_cents else ""), ""
        if stage != "closed":
            from services.job_total import guess_total, texted_quote
            tq = texted_quote(db, lid)
            if tq and abs(tq["total"] * 100 - (total_cents + max(0, extras_cents))) > 50:
                total_cents, extras_cents = int(round(tq["total"] * 100)), 0
                total_source, total_why = "texted", f"From the total texted {tq['sent_at'][:10]}"
            elif not total_cents and stage in ("deposit_sent", "deposit_paid"):
                g = guess_total(db, lid)
                if g:
                    total_cents, total_source, total_why = int(round(g["total"] * 100)), "guess", g["why"]

        due_cents = max(0, total_cents + max(0, extras_cents) - paid_cents) if total_cents else 0
        if stage == "invoice_sent" or (stage == "ready" and open_bills):
            due_cents = sum(l.amount_cents or 0 for l in open_bills)
        elif stage == "closed":
            due_cents = 0
        out.append({
            "lead_id": lid,
            "stage": stage,
            "when": when,
            "name": (lead.contact_name or "").strip() or "No name",
            "address": lead.address or "",
            "phone": lead.contact_phone or "",
            "total": total_cents / 100,
            "total_source": total_source,   # booking | texted | guess | ""
            "total_why": total_why,
            "quick": any((l.description or "") == "Quick $250 to lock in the date" for l in deposits),
            "extras": extras_cents / 100,
            "paid": paid_cents / 100,
            "due": due_cents / 100,
            "deposit": ("paid" if dep_paid_any else "open" if dep_open else "none"),
            "deposit_link": _link(dep_paid or dep_open) if (dep_paid or dep_open) else None,
            "bill": _link((open_bills or paid_bills)[-1]) if (open_bills or paid_bills) else None,
            "booked_date": (b.date if b else "") or "",
            "done_at": done_at,
            "done_by": (job.completed_by if job else "") or "",
            "closed_at": closed_at,
            "closed_by": (job.closed_by if job else "") or "",
            "closed_how": CLOSE_HOW.get((job.closed_how if job else "") or "", (job.closed_how if job else "") or ""),
            "paid_in_full_up_front": full_paid and not done_at,
        })
    return out


def _sort(rows: list[dict], stage: str) -> list[dict]:
    # Waiting longest on top where it costs us money (ready, invoice sent);
    # the next job first while waiting; the newest first elsewhere.
    asc = stage in ("ready", "invoice_sent", "deposit_paid")
    return sorted(rows, key=lambda r: r["when"] or ("9" if asc else ""), reverse=not asc)


@router.get("/invoice-queue")
def invoice_queue(user: dict = Depends(require_perm("invoice_queue"))):
    del user
    db = get_db()
    try:
        rows = stage_rows(db)
        stages = []
        for key in STAGES:
            rs = _sort([r for r in rows if r["stage"] == key], key)
            money = sum(r["paid"] if key == "closed" else r["due"] if key != "deposit_sent" else r["total"] for r in rs)
            stages.append({"key": key, "count": len(rs), "money": round(money, 2), "rows": rs})
        return {"stages": stages, "close_how": [{"key": k, "label": v} for k, v in CLOSE_HOW.items()]}
    finally:
        db.close()


class CloseBody(BaseModel):
    how: str


@router.post("/invoice-queue/{lead_id}/close")
def close_out(lead_id: str, body: CloseBody, user: dict = Depends(require_perm("invoice_queue"))):
    """Paid some other way: the job moves to Paid & closed."""
    how = (body.how or "").strip().lower()
    if how not in CLOSE_HOW:
        raise HTTPException(400, "Paid how? Cash, check, Zelle, QuickBooks, card in person or other")
    db = get_db()
    try:
        from api.company_cam import _get_or_create, _lead_or_404
        lead = _lead_or_404(db, lead_id)
        job = _get_or_create(db, lead)
        job.closed_at = _now()
        job.closed_by = _actor(user)
        job.closed_how = how
        job.updated_at = _now()
        db.commit()
        # An open bill gets marked paid the same way, so the receipt page
        # works and nothing stays "Invoice sent".
        from api.stripe_pay import mark_paid_offline
        for l in db.query(PayLink).filter(PayLink.lead_id == lead_id, PayLink.kind.in_(BILL_KINDS), PayLink.status == "open").all():
            mark_paid_offline(db, l, how, _actor(user))
        log_event(lead_id, "invoice_closed", f"Paid & closed ({CLOSE_HOW[how]}) by {job.closed_by}")
        return {"ok": True}
    finally:
        db.close()


@router.post("/invoice-queue/{lead_id}/reopen")
def reopen(lead_id: str, user: dict = Depends(require_perm("invoice_queue"))):
    """Undo a close-out done by mistake."""
    db = get_db()
    try:
        job = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead_id).first()
        if job and job.closed_at:
            job.closed_at = job.closed_by = job.closed_how = ""
            job.updated_at = _now()
            db.commit()
            log_event(lead_id, "invoice_reopened", f"Reopened by {_actor(user)}")
        return {"ok": True}
    finally:
        db.close()


def ready_alert(db, lead: Lead, job: CompanyCamJob, note: str = "", what: str = "fence") -> str:
    """The text Alan and Olga get when a finished job lands in Ready for
    invoice: who, where, and what's left to collect."""
    row = next((r for r in stage_rows(db) if r["lead_id"] == lead.id), None)
    name = (lead.contact_name or "").strip() or "A customer"
    street = (lead.address or "").split(",")[0].strip()
    who = f"{name} ({street})" if street else name
    by = job.completed_by or "the crew"
    if row and row["due"] > 0:
        dep = " after the $250 deposit" if row["deposit"] == "paid" else ", no deposit was paid"
        left = f" {hooks.money(row['due'])} left to collect{dep}."
    elif row and row["deposit"] != "paid":
        left = " No deposit was paid."
    else:
        left = ""
    note = f" {note.strip()}" if note.strip() else ""
    return f"{who}: the {what} is done ({by}) and ready for the invoice.{note}{left} Invoice Queue → Ready for invoice."


def alert_ready(lead_id: str, note: str = "", what: str = "fence", db=None) -> None:
    """Text Alan and WhatsApp Olga. Never raises. `db` is the caller's
    session when it has one."""
    from config import get_settings
    from services.ghl import send_whatsapp
    own = db is None
    db = db or get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        job = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead_id).first()
        if not lead or not job:
            return
        msg = ready_alert(db, lead, job, note, what)
    except Exception as e:  # noqa: BLE001
        logger.warning("ready alert: could not build for %s: %s", lead_id, e)
        return
    finally:
        if own:
            db.close()
    hooks.alert_alan(msg)
    olga = (get_settings().olga_ghl_contact_id or "").strip()
    if olga:
        try:
            send_whatsapp(olga, msg)
        except Exception as e:  # noqa: BLE001
            logger.warning("ready alert to Olga failed: %s", e)



# ── The bill, filled in (Alan, 2026-10-23) ───────────────────────────────
# "I click Itemized invoice and it's already itemized": the lines come from
# what was sold (the booking, else the $250 link's job total and what the
# crew did), the repairs counted on site, and what they already paid.

TIER_NAMES = {"essential": "Essential", "signature": "Signature", "legacy": "Legacy"}


def _line(name: str, price: float, qty: float = 1, description: str = "", discount: float = 0, discount_label: str = "") -> dict:
    q = float(qty or 1) if float(qty or 1) > 0 else 1.0
    out = {"name": name, "description": description, "qty": int(q) if q.is_integer() else round(q, 2), "unit_price": round(float(price), 2)}
    if discount > 0:
        out.update(discount=round(discount, 2), discount_label=discount_label or "Discount")
    return out


def _fence_line(tier: str, color: str, price: float, **kw) -> dict:
    """"Signature Finish- Fence Staining", as on Alan's saved quick-add
    lines (2026-10-23: never a bare "Fence staining")."""
    t = TIER_NAMES.get((tier or "").lower())
    name = f"{t} Finish- Fence Staining" if t else "Fence Staining"
    return _line(name, price, description=" · ".join(b for b in ["Cleaning & staining of the fence", color.strip()] if b), **kw)


def suggest_invoice(db, lead_id: str) -> dict:
    """{items, credit, whole_discount}: the itemized invoice as it should
    read, for the builder to start from. Empty items = nothing to go on."""
    import json as _json
    from api.booking import _active, _repairs, _services, services_only
    from services.company_cam import PW_SERVICE_LABELS, site_extras
    lead = db.query(Lead).filter(Lead.id == lead_id).first()
    job = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead_id).first()
    b = _active(db, lead_id)
    links = db.query(PayLink).filter(PayLink.lead_id == lead_id, PayLink.status != "void").all()
    credit = (sum(p.amount_cents or 0 for p in db.query(CustomerPayment).filter(CustomerPayment.lead_id == lead_id).all())
              + qb_paid_cents(db, [lead_id]).get(lead_id, 0)) / 100
    color = ((job.final_color or job.color) if job else "") or ((b.color or "") if b else "")
    ex = site_extras(job) if job else {"lines": []}
    counted = bool(ex.get("final"))
    items: list[dict] = []
    whole = None

    if b is not None:
        if not services_only(b) and (b.price_cents or b.total_cents):
            items.append(_fence_line(b.tier, color, (b.price_cents or b.total_cents) / 100,
                                     discount=(b.discount_cents or 0) / 100, discount_label=b.discount_label or ""))
        if not counted:
            items += [_line(r["name"], r["unit_price"], r["qty"]) for r in _repairs(b) if r["qty"] and r["unit_price"]]
            if b.repairs_discount_cents:
                whole = {"label": b.repairs_discount_label or "Repairs discount", "amount": b.repairs_discount_cents / 100}
        items += [_line(s["name"], s["price"], description=s["description"]) for s in _services(b) if s["price"]]
    else:
        total = next((l.job_total_cents for l in sorted(links, key=lambda l: l.created_at or "", reverse=True)
                      if l.kind in ("deposit", "full") and l.job_total_cents), 0) / 100
        tier = next((l.job_tier for l in links if l.kind in ("deposit", "full") and l.job_tier and l.job_tier != "custom"), "") or (job.package if job else "")
        if (tier or "").lower() not in TIER_NAMES:
            c = color.lower()
            tier = "legacy" if "solid" in c else "signature" if ("semi" in c or "oil" in c or "transparent" in c) else tier
        try:
            draft = _json.loads(lead.form_data or "{}").get("booking_draft") or {} if lead else {}
        except (TypeError, ValueError):
            draft = {}
        draft_services = [s for s in draft.get("services") or [] if isinstance(s, dict) and s.get("name") and s.get("price")]
        try:
            pw = [PW_SERVICE_LABELS.get(k, k) for k in _json.loads(job.pw_services_json or "[]")] if job else []
        except (TypeError, ValueError):
            pw = []
        services_sum = sum(float(s["price"]) for s in draft_services)
        # A services-only job (Teila's house wash): the draft's lines are the
        # whole bill. Otherwise the fence is the first line and any services
        # on the draft go under it.
        services_only = bool(draft_services) and not (draft.get("tier") or "") and (not total or abs(services_sum - total) < 0.01)
        if services_only:
            items += [_line(s["name"], float(s["price"]), description=s.get("description") or "") for s in draft_services]
        elif total and pw and not draft_services:
            items.append(_line(pw[0] if len(pw) == 1 else "Pressure washing", total, description="" if len(pw) == 1 else ", ".join(pw)))
        elif total:
            items.append(_fence_line(tier, color, total))
        elif job and job.final_price_cents:
            items.append(_fence_line(tier, color, job.final_price_cents / 100))
        else:
            # Nothing booked or paid (Harold): the sent estimate's price for
            # the package, read from the stain when no package was set.
            t = (tier or "").lower()
            if t not in TIER_NAMES:
                c = color.lower()
                t = "legacy" if "solid" in c else "signature" if c else ""
            price = hooks.tier_price(db, lead_id, t) if t else None
            if price:
                items.append(_fence_line(t, color, float(price)))
        if draft_services and not services_only:
            items += [_line(s["name"], float(s["price"]), description=s.get("description") or "") for s in draft_services]

    # What the crew counted with the customer replaces the repairs on the
    # booking; the old add-on way adds on top.
    items += [_line(l["name"], l["unit_cents"] / 100, l["qty"], "Counted on site with you" if counted else "Agreed on site")
              for l in ex.get("lines", []) if l.get("unit_cents", 0) > 0]
    # Built from the records, but the customer was texted a different total:
    # the text is what they agreed to, so the bill follows it (Alan,
    # 2026-10-29: 5.5 extra rails agreed by text never reached the job).
    from services.job_total import quote_items, texted_quote
    built = sum(i["unit_price"] * i["qty"] - i.get("discount", 0) for i in items) - (whole or {}).get("amount", 0)
    tq = texted_quote(db, lead_id)
    source = None
    if tq and abs(tq["total"] - built) > 0.5:
        source = {"kind": "texted", "sent_at": tq["sent_at"], "total": tq["total"], "records_total": round(built, 2)}
        fence = next((i["name"] for i in items if "Finish- Fence Staining" in i["name"]), "")
        items = [_line(l["name"], l["unit_price"], l["qty"], l["description"]) for l in quote_items(tq["lines"], fence)]
        whole = None
    return {"items": items, "credit": round(credit, 2), "whole_discount": whole, "source": source}
