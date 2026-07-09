"""
QuickBooks Invoices → Leads.

Pulls every invoice from the connected QBO company into a local mirror
(`quickbooks_invoices`) so we can see who paid, how much, and what's
outstanding, and manually attach each invoice to a lead (by name search, like
the Google-Calendar lead picker).

This is the read/assign surface. It's separate from api/quickbooks.py's
invoice *creation* + payment webhook, which stay the source of truth for the
invoices WE generate. On sync we auto-link only invoices whose PrivateNote
carries a valid `Lead ID:` (ones we generated) — everything else is manual.
"""
from __future__ import annotations
import re
import uuid
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from pydantic import BaseModel
from sqlalchemy import or_, func

from database import get_db, QuickbooksInvoice, Lead
from api.auth import require_staff
import services.quickbooks_client as qb

router = APIRouter()
logger = logging.getLogger(__name__)

_LEAD_ID_RE = re.compile(r"Lead ID:\s*([0-9a-fA-F-]{36})")
_PAGE_SIZE = 1000

# Single uvicorn worker → module-level sync status is safe (mirrors the
# opportunity-value backfill pattern).
_SYNC_STATUS: dict = {"status": "never_run"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _num(v) -> float:
    try:
        return float(v) if v is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def _derive_status(total: float, balance: float) -> str:
    if total <= 0:
        return "void"          # QBO zeroes TotalAmt on void (heuristic)
    if balance <= 0.005:
        return "paid"
    if balance < total:
        return "partial"
    return "unpaid"


def _parse_invoice(inv: dict) -> dict:
    total = _num(inv.get("TotalAmt"))
    balance = _num(inv.get("Balance"))
    cust = inv.get("CustomerRef") or {}
    email = ((inv.get("BillEmail") or {}).get("Address")) or ""
    return {
        "qb_invoice_id": str(inv.get("Id") or ""),
        "doc_number": str(inv.get("DocNumber") or ""),
        "customer_ref_id": str(cust.get("value") or ""),
        "customer_name": str(cust.get("name") or ""),
        "customer_email": email,
        "total_amount": total,
        "balance": balance,
        "amount_paid": round(total - balance, 2),
        "status": _derive_status(total, balance),
        "txn_date": str(inv.get("TxnDate") or ""),
        "due_date": str(inv.get("DueDate") or ""),
        "private_note": str(inv.get("PrivateNote") or ""),
    }


def _upsert(db, parsed: dict, now: str) -> tuple[bool, bool]:
    """Insert or update one invoice. Returns (is_new, auto_linked)."""
    row = (db.query(QuickbooksInvoice)
             .filter(QuickbooksInvoice.qb_invoice_id == parsed["qb_invoice_id"])
             .first())
    is_new = row is None
    if is_new:
        row = QuickbooksInvoice(
            id=str(uuid.uuid4()),
            qb_invoice_id=parsed["qb_invoice_id"],
            created_at=now,
        )
        db.add(row)
    for k, v in parsed.items():
        if k == "qb_invoice_id":
            continue
        setattr(row, k, v)
    row.synced_at = now
    row.updated_at = now

    # Auto-link only our own invoices (exact Lead ID in the private note), and
    # only when still unassigned — never override a manual assignment.
    auto_linked = False
    if not row.lead_id:
        m = _LEAD_ID_RE.search(parsed.get("private_note") or "")
        if m:
            lid = m.group(1)
            if db.query(Lead.id).filter(Lead.id == lid).first():
                row.lead_id = lid
                row.assigned_by = "auto (invoice note)"
                row.assigned_at = now
                auto_linked = True
    return is_new, auto_linked


def _run_sync() -> None:
    global _SYNC_STATUS
    _SYNC_STATUS = {
        "status": "running", "synced": 0, "new": 0, "auto_linked": 0,
        "started_at": _now(), "completed_at": None, "error": None,
    }
    db = get_db()
    try:
        start = 1
        while True:
            invoices = qb.query_invoices(start_position=start, max_results=_PAGE_SIZE)
            if not invoices:
                break
            now = _now()
            for inv in invoices:
                parsed = _parse_invoice(inv)
                if not parsed["qb_invoice_id"]:
                    continue
                is_new, auto_linked = _upsert(db, parsed, now)
                _SYNC_STATUS["synced"] += 1
                if is_new:
                    _SYNC_STATUS["new"] += 1
                if auto_linked:
                    _SYNC_STATUS["auto_linked"] += 1
            db.commit()
            if len(invoices) < _PAGE_SIZE:
                break
            start += _PAGE_SIZE
        _SYNC_STATUS["status"] = "completed"
        _SYNC_STATUS["completed_at"] = _now()
        logger.info(f"QB invoice sync done: {_SYNC_STATUS['synced']} synced, "
                    f"{_SYNC_STATUS['new']} new, {_SYNC_STATUS['auto_linked']} auto-linked")
    except PermissionError:
        db.rollback()
        _SYNC_STATUS["status"] = "error"
        _SYNC_STATUS["error"] = "Not connected to QuickBooks — reconnect in Settings."
    except Exception as e:
        db.rollback()
        _SYNC_STATUS["status"] = "error"
        _SYNC_STATUS["error"] = str(e)[:300]
        logger.exception("QB invoice sync failed")
    finally:
        db.close()


@router.post("/quickbooks/invoices/sync")
def sync_invoices(background: BackgroundTasks, user: dict = Depends(require_staff)):
    """Kick off a full pull of every QBO invoice into the local mirror.
    Idempotent (upsert by QBO id; preserves manual assignments). Runs in the
    background — poll /quickbooks/invoices/sync-status for progress."""
    del user
    if _SYNC_STATUS.get("status") == "running":
        return {"status": "already_running"}
    background.add_task(_run_sync)
    return {"status": "started"}


@router.get("/quickbooks/invoices/sync-status")
def sync_status(user: dict = Depends(require_staff)):
    del user
    return _SYNC_STATUS


def _unassigned_clause():
    return or_(QuickbooksInvoice.lead_id.is_(None), QuickbooksInvoice.lead_id == "")


@router.get("/quickbooks/invoices")
def list_invoices(
    filter: str = "all",
    q: str = "",
    limit: int = 100,
    offset: int = 0,
    user: dict = Depends(require_staff),
):
    """Paginated invoice list for the Revenue page, plus company-wide rollups
    (invoiced / collected / outstanding / unassigned) computed over the full
    dataset regardless of the current filter."""
    del user
    db = get_db()
    try:
        query = db.query(QuickbooksInvoice)
        f = (filter or "all").lower()
        if f == "unassigned":
            query = query.filter(_unassigned_clause())
        elif f == "assigned":
            query = query.filter(QuickbooksInvoice.lead_id.isnot(None), QuickbooksInvoice.lead_id != "")
        elif f == "paid":
            query = query.filter(QuickbooksInvoice.status == "paid")
        elif f == "outstanding":
            query = query.filter(QuickbooksInvoice.status.in_(["unpaid", "partial"]))

        qq = (q or "").strip()
        if qq:
            like = f"%{qq}%"
            query = query.filter(or_(
                QuickbooksInvoice.customer_name.ilike(like),
                QuickbooksInvoice.doc_number.ilike(like),
            ))

        total = query.count()
        rows = (query.order_by(QuickbooksInvoice.txn_date.desc())
                     .offset(max(0, offset))
                     .limit(min(max(1, limit), 500))
                     .all())

        # Attach lead display names for the assigned rows.
        lead_ids = [r.lead_id for r in rows if r.lead_id]
        names: dict[str, str] = {}
        if lead_ids:
            for lid, name in db.query(Lead.id, Lead.contact_name).filter(Lead.id.in_(lead_ids)).all():
                names[lid] = name or ""
        out = []
        for r in rows:
            d = r.to_dict()
            d["lead_name"] = names.get(r.lead_id or "", "")
            out.append(d)

        agg = db.query(
            func.coalesce(func.sum(QuickbooksInvoice.total_amount), 0),
            func.coalesce(func.sum(QuickbooksInvoice.amount_paid), 0),
            func.coalesce(func.sum(QuickbooksInvoice.balance), 0),
        ).one()
        unassigned = db.query(QuickbooksInvoice).filter(_unassigned_clause()).count()

        return {
            "invoices": out,
            "total": total,
            "rollup": {
                "invoiced": _num(agg[0]),
                "collected": _num(agg[1]),
                "outstanding": _num(agg[2]),
                "unassigned": unassigned,
            },
        }
    finally:
        db.close()


class AssignBody(BaseModel):
    lead_id: str


@router.post("/quickbooks/invoices/{qb_invoice_id}/assign")
def assign_invoice(qb_invoice_id: str, body: AssignBody, user: dict = Depends(require_staff)):
    db = get_db()
    try:
        inv = (db.query(QuickbooksInvoice)
                 .filter(QuickbooksInvoice.qb_invoice_id == qb_invoice_id)
                 .first())
        if not inv:
            raise HTTPException(404, "Invoice not found")
        lead = db.query(Lead).filter(Lead.id == body.lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")
        inv.lead_id = lead.id
        inv.assigned_by = (user.get("name") or user.get("sub") or "").strip()
        inv.assigned_at = _now()
        inv.updated_at = _now()
        db.commit()
        d = inv.to_dict()
        d["lead_name"] = lead.contact_name or ""
        return d
    finally:
        db.close()


@router.post("/quickbooks/invoices/{qb_invoice_id}/unassign")
def unassign_invoice(qb_invoice_id: str, user: dict = Depends(require_staff)):
    del user
    db = get_db()
    try:
        inv = (db.query(QuickbooksInvoice)
                 .filter(QuickbooksInvoice.qb_invoice_id == qb_invoice_id)
                 .first())
        if not inv:
            raise HTTPException(404, "Invoice not found")
        inv.lead_id = None
        inv.assigned_by = ""
        inv.assigned_at = ""
        inv.updated_at = _now()
        db.commit()
        return inv.to_dict()
    finally:
        db.close()


@router.get("/quickbooks/leads/{lead_id}/invoices")
def lead_invoices(lead_id: str, user: dict = Depends(require_staff)):
    """Invoices assigned to one lead + a paid/total/balance rollup, for the
    Lead Detail Payments section."""
    del user
    db = get_db()
    try:
        rows = (db.query(QuickbooksInvoice)
                  .filter(QuickbooksInvoice.lead_id == lead_id)
                  .order_by(QuickbooksInvoice.txn_date.desc())
                  .all())
        invoices = [r.to_dict() for r in rows]
        return {
            "invoices": invoices,
            "rollup": {
                "paid": round(sum(i["amount_paid"] for i in invoices), 2),
                "total": round(sum(i["total_amount"] for i in invoices), 2),
                "balance": round(sum(i["balance"] for i in invoices), 2),
                "count": len(invoices),
            },
        }
    finally:
        db.close()
