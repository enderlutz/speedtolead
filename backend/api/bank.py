"""Owner-only: the bank lines from Plaid, read-only, sorted into categories
(Alan, 2026-10-17). Lives on the "Where the money went" page."""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel

from api.auth import require_revenue
from database import BankItem, get_db
from services import bank
from services import plaid_client as plaid

router = APIRouter()


class LinkTokenBody(BaseModel):
    item_id: str = ""            # set to log back in to a bank that stopped syncing


class ExchangeBody(BaseModel):
    public_token: str
    institution_name: str = ""


class CategoryBody(BaseModel):
    category: str
    remember: bool = False


def _plaid_http(e: plaid.PlaidError) -> HTTPException:
    if e.code in ("NOT_CONFIGURED", "NO_ENCRYPTION"):
        return HTTPException(409, e.message)
    return HTTPException(502, f"Plaid said no: {e.message}")


@router.get("/bank/status")
def bank_status(user: dict = Depends(require_revenue)):
    db = get_db()
    try:
        return bank.status(db)
    finally:
        db.close()


@router.post("/bank/link-token")
def bank_link_token(body: LinkTokenBody | None = None, user: dict = Depends(require_revenue)):
    access = ""
    if body and body.item_id:
        db = get_db()
        try:
            item = db.query(BankItem).filter(BankItem.id == body.item_id).first()
            if not item:
                raise HTTPException(404, "That bank isn't connected")
            access = bank.access_token(item)
        finally:
            db.close()
    try:
        return {"link_token": plaid.create_link_token(user.get("sub") or "owner", access)}
    except plaid.PlaidError as e:
        raise _plaid_http(e)


@router.post("/bank/exchange")
def bank_exchange(body: ExchangeBody, user: dict = Depends(require_revenue)):
    db = get_db()
    try:
        try:
            item = bank.connect(db, body.public_token, body.institution_name)
        except plaid.PlaidError as e:
            raise _plaid_http(e)
        return {"id": item.id, "institution_name": item.institution_name}
    finally:
        db.close()


def _sort_in_background() -> None:
    db = get_db()
    try:
        bank.categorize(db)
    finally:
        db.close()


@router.post("/bank/sync")
def bank_sync(tasks: BackgroundTasks, user: dict = Depends(require_revenue)):
    """Pull now. Rules sort straight away; Claude sorts the rest in the
    background (a first pull is up to a year of lines), and the page checks
    back while `unsorted` is above zero."""
    if not plaid.is_configured():
        raise HTTPException(409, "Plaid isn't set up yet")
    db = get_db()
    try:
        out = bank.sync_all(db, sort=False)
    finally:
        db.close()
    if out.get("unsorted"):
        tasks.add_task(_sort_in_background)
    return out


@router.get("/bank/summary")
def bank_summary(start: str = "", end: str = "", user: dict = Depends(require_revenue)):
    today = date.today()
    start = start or today.replace(day=1).isoformat()
    end = end or today.isoformat()
    db = get_db()
    try:
        return bank.summary(db, start, end)
    finally:
        db.close()


@router.get("/bank/transactions")
def bank_transactions(start: str = "", end: str = "", category: str = "", needs_review: bool = False,
                      user: dict = Depends(require_revenue)):
    db = get_db()
    try:
        return bank.transactions(db, start, end, category, needs_review)
    finally:
        db.close()


@router.patch("/bank/transactions/{transaction_id}")
def bank_set_category(transaction_id: str, body: CategoryBody, user: dict = Depends(require_revenue)):
    db = get_db()
    try:
        return bank.set_category(db, transaction_id, body.category, body.remember, user.get("sub") or "")
    except ValueError as e:
        raise HTTPException(400, str(e))
    except LookupError as e:
        raise HTTPException(404, str(e))
    finally:
        db.close()


@router.delete("/bank/items/{item_id}")
def bank_remove(item_id: str, user: dict = Depends(require_revenue)):
    db = get_db()
    try:
        if not bank.remove_item(db, item_id):
            raise HTTPException(404, "That bank isn't connected")
        return {"ok": True}
    finally:
        db.close()
