"""The bank lines themselves, sorted into plain categories (Alan, 2026-10-17).

QuickBooks only shows what has been accepted out of "For review", so the
money audit can look thin. This pulls every bank and card line straight from
Plaid (read-only), then sorts each one:

1. A saved rule ("anything with 'sherwin' in it is Stain & materials") wins.
2. Whatever is left goes to Claude, about a hundred at a time. Claude may
   only answer with a category from the list below. A guess it isn't sure of
   (under 0.7) lands in "Needs a look" for Alan to tap the right one.
3. A fix by hand is final. Saved with "remember", it becomes a rule and
   re-sorts every other line from the same merchant that nobody has checked.

If Claude can't be reached the lines stay unsorted and the next sync tries
again; a sync never fails because of it.
"""
from __future__ import annotations

import json
import logging
import threading
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Callable

from config import get_settings
from database import BankAccount, BankItem, BankRule, BankTransaction
from services import plaid_client as plaid
# The same Fernet helper that keeps the QuickBooks tokens encrypted at rest
# (QB_TOKEN_SECRET). Read-only use; nothing in QuickBooks is touched.
from services.quickbooks_client import _decrypt, _encrypt, _fernet

logger = logging.getLogger(__name__)

MODEL = "claude-opus-5-5"
BATCH = 100
# A first pull is up to a year of lines. Capped per run so one sync can't run
# away with the API credit; whatever is left is sorted on the next sync.
MAX_PER_RUN = 2000
SURE = 0.7

TRANSFER = "Transfer (not spending)"
MONEY_IN = "Customer payment / payout (money in)"
REFUND = "Refund"
CATEGORIES = [
    "Meta ads", "Google ads", "Other marketing", "Stain & materials", "Equipment & tools",
    "Crew pay", "Payroll & contractors", "Fuel", "Vehicle", "Software & subscriptions",
    "Insurance", "Rent & utilities", "Phone & internet", "Meals", "Fees & bank charges",
    "Taxes", "Owner draw", "Loan payment", TRANSFER, MONEY_IN, REFUND, "Other",
]
NOT_SPENDING = {TRANSFER, MONEY_IN}
UNSORTED = "Not sorted yet"

# Two syncs at once (the daily loop and a tap on "Sync") would insert the
# same lines twice.
_sync_lock = threading.Lock()
# Same for the Claude half: two at once would pay to sort the same lines twice.
_sort_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Connecting ─────────────────────────────────────────────────────────

def connect(db, public_token: str, institution_name: str = "") -> BankItem:
    # A bank's access token is never stored in plain text: no encryption key
    # in Railway, no connecting (QuickBooks falls back to plain; this doesn't).
    if _fernet() is None:
        raise plaid.PlaidError("NO_ENCRYPTION", "The server has no encryption key set (QB_TOKEN_SECRET), so the bank can't be connected safely. Ask Fragne to set it.")
    access_token, item_id = plaid.exchange_public_token(public_token)
    item = db.query(BankItem).filter(BankItem.item_id == item_id).first()
    if not item:
        item = BankItem(id=str(uuid.uuid4()), item_id=item_id, created_at=_now(), cursor="")
        db.add(item)
    item.access_token_enc = _encrypt(access_token)
    item.institution_name = (institution_name or item.institution_name or "")[:120]
    item.error = ""
    db.commit()
    return item


def access_token(item: BankItem) -> str:
    return _decrypt(item.access_token_enc or "")


def remove_item(db, item_id: str) -> bool:
    """Disconnect a bank: tell Plaid to drop it, then forget its accounts
    and lines here. Rules are kept."""
    item = db.query(BankItem).filter(BankItem.id == item_id).first()
    if not item:
        return False
    try:
        plaid.item_remove(access_token(item))
    except plaid.PlaidError as e:
        # Already gone at Plaid's end, or Plaid is down. Forget it here either way.
        logger.warning("Plaid item remove failed (%s); removing locally", e.code)
    acct_ids = [a.account_id for a in db.query(BankAccount).filter(BankAccount.item_id == item.item_id).all()]
    if acct_ids:
        db.query(BankTransaction).filter(BankTransaction.account_id.in_(acct_ids)).delete(synchronize_session=False)
    db.query(BankAccount).filter(BankAccount.item_id == item.item_id).delete(synchronize_session=False)
    db.delete(item)
    db.commit()
    return True


# ── Pulling ────────────────────────────────────────────────────────────

def _plain_error(e: plaid.PlaidError) -> str:
    if e.code in ("ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION", "PENDING_DISCONNECT"):
        return "The bank wants you to log in again. Tap Reconnect."
    return f"Couldn't pull from the bank: {e.message}"[:300]


def _pfc(t: dict) -> str:
    p = t.get("personal_finance_category") or {}
    return "/".join(x for x in (p.get("primary"), p.get("detailed")) if x)


def _fill(row: BankTransaction, t: dict) -> None:
    row.account_id = t.get("account_id") or row.account_id
    row.date = t.get("date") or ""
    row.authorized_date = t.get("authorized_date") or ""
    row.name = (t.get("name") or "")[:300]
    row.merchant_name = (t.get("merchant_name") or "")[:200]
    row.amount = float(t.get("amount") or 0)
    row.pending = bool(t.get("pending"))
    row.plaid_category = _pfc(t)
    row.updated_at = _now()


def apply_sync_page(db, added: list[dict], modified: list[dict], removed: list[dict]) -> dict:
    """Write one finished /transactions/sync pull. A posted line that
    replaces a pending one keeps whatever category the pending one had."""
    n_add = n_mod = n_rem = 0
    for t in added + modified:
        tid = t.get("transaction_id")
        if not tid:
            continue
        row = db.get(BankTransaction, tid)
        if not row:
            row = BankTransaction(transaction_id=tid, created_at=_now(), reviewed=False)
            prev = db.get(BankTransaction, t.get("pending_transaction_id")) if t.get("pending_transaction_id") else None
            if prev and prev.category:
                row.category, row.category_source = prev.category, prev.category_source
                row.confidence, row.reviewed = prev.confidence, prev.reviewed
            db.add(row)
            n_add += 1
        else:
            n_mod += 1
        _fill(row, t)
    db.flush()
    for t in removed:
        row = db.get(BankTransaction, t.get("transaction_id") or "")
        if row:
            db.delete(row)
            n_rem += 1
    return {"added": n_add, "modified": n_mod, "removed": n_rem}


def _pull(token: str, cursor: str) -> tuple[list, list, list, str]:
    """Page /transactions/sync to the end. Plaid says to start the whole
    pull over from the first cursor if the data changes mid-way."""
    for _ in range(3):
        added, modified, removed, cur = [], [], [], cursor
        try:
            while True:
                page = plaid.transactions_sync(token, cur)
                added += page.get("added") or []
                modified += page.get("modified") or []
                removed += page.get("removed") or []
                cur = page.get("next_cursor") or cur
                if not page.get("has_more"):
                    return added, modified, removed, cur
        except plaid.PlaidError as e:
            if e.code != "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION":
                raise
    raise plaid.PlaidError("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", "the bank kept changing during the pull")


def _save_accounts(db, item: BankItem, accounts: list[dict]) -> None:
    for a in accounts:
        aid = a.get("account_id")
        if not aid:
            continue
        row = db.get(BankAccount, aid)
        if not row:
            row = BankAccount(account_id=aid)
            db.add(row)
        bal = a.get("balances") or {}
        row.item_id = item.item_id
        row.name = (a.get("name") or a.get("official_name") or "")[:120]
        row.mask = a.get("mask") or ""
        row.type = str(a.get("type") or "")
        row.subtype = str(a.get("subtype") or "")
        row.current_balance = bal.get("current")
        row.available_balance = bal.get("available")
        row.updated_at = _now()


def sync_item(db, item: BankItem) -> dict:
    token = access_token(item)
    try:
        added, modified, removed, cursor = _pull(token, item.cursor or "")
        counts = apply_sync_page(db, added, modified, removed)
        item.cursor = cursor
        _save_accounts(db, item, plaid.accounts_get(token))
        item.error = ""
        item.last_synced_at = _now()
        db.commit()
        return counts
    except plaid.PlaidError as e:
        db.rollback()
        item.error = _plain_error(e)
        db.commit()
        logger.warning("Bank sync failed for %s: %s", item.institution_name or item.id, e.code)
        return {"error": item.error}


def sync_all(db, classify: Callable[[list[dict]], object] | None = None, sort: bool = True) -> dict:
    """Pull every connected bank, then sort what's new. No-op when Plaid
    isn't set up or nothing is connected. sort=False stops after the rules
    (the Sync button sends the Claude half to the background)."""
    if not plaid.is_configured():
        return {"skipped": "not configured"}
    if not _sync_lock.acquire(blocking=False):
        return {"skipped": "a sync is already running"}
    try:
        items = db.query(BankItem).all()
        if not items:
            return {"skipped": "no banks connected"}
        out: dict = {"items": {}}
        for item in items:
            out["items"][item.institution_name or item.item_id] = sync_item(db, item)
        out["by_rule"] = apply_rules(db)
        if sort:
            out["by_claude"] = categorize(db, classify=classify)
        out["unsorted"] = db.query(BankTransaction).filter(BankTransaction.category.is_(None)).count()
        return out
    finally:
        _sync_lock.release()


# ── Sorting ────────────────────────────────────────────────────────────

def _rule_for(rules: list[BankRule], t: BankTransaction) -> BankRule | None:
    hay = ((t.merchant_name or "").lower(), (t.name or "").lower())
    hits = [r for r in rules if r.match and any(r.match in h for h in hay)]
    # The longest match is the most specific ("home depot rental" over "home depot").
    return max(hits, key=lambda r: len(r.match)) if hits else None


def apply_rules(db, only_unreviewed: bool = False) -> int:
    """Sort lines by the saved rules. Touches lines nobody has sorted yet,
    or, with only_unreviewed, any line still waiting for a look. Never a
    hand-made fix."""
    rules = db.query(BankRule).all()
    if not rules:
        return 0
    q = db.query(BankTransaction).filter((BankTransaction.category_source != "manual") | (BankTransaction.category_source.is_(None)))
    q = q.filter(BankTransaction.reviewed.is_(False)) if only_unreviewed else q.filter(BankTransaction.category.is_(None))
    n = 0
    for t in q.all():
        r = _rule_for(rules, t)
        if r:
            t.category, t.category_source, t.confidence, t.reviewed = r.category, "rule", 1.0, True
            t.updated_at = _now()
            n += 1
    db.commit()
    return n


SYSTEM_PROMPT = """You sort bank and credit card lines for Sterling Fence Staining, a small fence cleaning and staining company in Houston, Texas. The owner wants to see where the money goes.

Each line has an amount. A positive amount is money OUT of the account; a negative amount is money IN.

Pick exactly one category per line, from this list and no other:
{categories}

How to tell:
- Facebook / Meta / "FACEBK" charges are Meta ads. "GOOGLE *ADS" is Google ads. Other advertising, yard signs, printing, lead services, Yelp, Angi, Thumbtack, GoHighLevel marketing spend: Other marketing.
- Paint and stain stores, Sherwin-Williams, Home Depot, Lowe's, Menards, hardware stores: Stain & materials, unless it is clearly a tool or machine (pressure washer, sprayer, ladder, tool rental): Equipment & tools.
- Money sent to a person by Zelle, Venmo, Cash App, PayPal or check, especially in round-ish amounts, is most likely Crew pay. Gusto, ADP, payroll services, 1099 contractors and staffing firms: Payroll & contractors.
- Gas stations: Fuel. Car payments, repairs, tires, tolls, registration, parking: Vehicle.
- Monthly apps and online services (QuickBooks, Google Workspace, OpenAI, Anthropic, Canva, CompanyCam, GoHighLevel subscription): Software & subscriptions.
- Card payments, moving money between the company's own accounts, "ONLINE TRANSFER", "PAYMENT THANK YOU" on a card: Transfer (not spending).
- Stripe payouts, deposits, customer checks, Zelle or Venmo money IN from a customer: Customer payment / payout (money in).
- A store giving money back for something bought: Refund.
- IRS, state comptroller, sales tax: Taxes. Withdrawals or transfers to the owner personally: Owner draw. Loan or line-of-credit payments, SBA: Loan payment.
- Bank fees, card processing fees, overdraft, interest charges: Fees & bank charges.
- If nothing fits, use Other.

confidence is how sure you are, from 0 to 1. Be honest: a person's name with no other clue is a guess, so give it under 0.7.

Answer with JSON only: {{"results": [{{"transaction_id": "...", "category": "...", "confidence": 0.0}}]}} with one entry for every line you were given."""

SCHEMA = {
    "type": "object",
    "properties": {"results": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "transaction_id": {"type": "string"},
            "category": {"type": "string", "enum": CATEGORIES},
            "confidence": {"type": "number"},
        },
        "required": ["transaction_id", "category", "confidence"],
        "additionalProperties": False,
    }}},
    "required": ["results"],
    "additionalProperties": False,
}


def _call_model(lines: list[dict]) -> str:
    import anthropic

    client = anthropic.Anthropic(api_key=get_settings().anthropic_api_key)
    response = client.beta.messages.create(
        model=MODEL,
        max_tokens=16000,
        betas=["server-side-fallback-2026-07-01"],
        system=[{"type": "text", "text": SYSTEM_PROMPT.format(categories="\n".join(f"- {c}" for c in CATEGORIES)),
                 "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": json.dumps(lines)}],
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
        # Passed as raw body: the installed SDK predates the fallbacks field.
        extra_body={"fallbacks": "default"},
    )
    if response.stop_reason == "refusal":
        logger.warning("bank categorize refused")
        return "{}"
    return next((b.text for b in response.content if b.type == "text"), "") or "{}"


def parse_results(raw, ids: set[str]) -> dict[str, tuple[str, float]]:
    """Claude's answer -> {transaction_id: (category, confidence)}.
    Accepts the {"results": [...]} object or a bare list. Lines it didn't
    send back are left out (so they stay unsorted). A category not on the
    list becomes Other at confidence 0, so it lands in Needs a look."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return {}
    if isinstance(raw, dict):
        raw = raw.get("results")
    if not isinstance(raw, list):
        return {}
    out: dict[str, tuple[str, float]] = {}
    for r in raw:
        if not isinstance(r, dict) or r.get("transaction_id") not in ids:
            continue
        cat = r.get("category")
        try:
            conf = max(0.0, min(1.0, float(r.get("confidence"))))
        except (TypeError, ValueError):
            conf = 0.0
        if cat not in CATEGORIES:
            cat, conf = "Other", 0.0
        out[r["transaction_id"]] = (cat, conf)
    return out


def _line(t: BankTransaction, accts: dict[str, BankAccount]) -> dict:
    a = accts.get(t.account_id)
    return {
        "transaction_id": t.transaction_id, "date": t.date, "amount": t.amount,
        "name": t.name, "merchant": t.merchant_name, "bank_category": t.plaid_category,
        "account": f"{a.name} ({a.type})" if a else "",
    }


def categorize(db, classify: Callable[[list[dict]], object] | None = None) -> int:
    """Send unsorted lines to Claude a batch at a time. `classify` is
    injectable for tests. A failed call leaves its batch unsorted."""
    if classify is None:
        if not get_settings().anthropic_api_key:
            return 0
        classify = _call_model
    if not _sort_lock.acquire(blocking=False):
        return 0
    try:
        return _categorize(db, classify)
    finally:
        _sort_lock.release()


def _categorize(db, classify: Callable[[list[dict]], object]) -> int:
    todo = (db.query(BankTransaction).filter(BankTransaction.category.is_(None))
            .order_by(BankTransaction.date.desc()).limit(MAX_PER_RUN).all())
    if not todo:
        return 0
    accts = {a.account_id: a for a in db.query(BankAccount).all()}
    done = 0
    for i in range(0, len(todo), BATCH):
        batch = todo[i:i + BATCH]
        try:
            got = parse_results(classify([_line(t, accts) for t in batch]), {t.transaction_id for t in batch})
        except Exception as e:
            logger.warning("bank categorize batch failed: %s", type(e).__name__)
            continue
        for t in batch:
            if t.transaction_id in got:
                t.category, t.confidence = got[t.transaction_id]
                t.category_source = "claude"
                t.reviewed = t.confidence >= SURE
                t.updated_at = _now()
                done += 1
        db.commit()
    return done


def set_category(db, transaction_id: str, category: str, remember: bool = False, user: str = "") -> dict:
    """A fix by hand. With remember, every other line from the same merchant
    that nobody has checked follows it, and so will new ones."""
    if category not in CATEGORIES:
        raise ValueError("That category isn't on the list")
    t = db.get(BankTransaction, transaction_id)
    if not t:
        raise LookupError("No such transaction")
    t.category, t.category_source, t.confidence, t.reviewed = category, "manual", 1.0, True
    t.updated_at = _now()
    db.commit()
    moved = 0
    if remember:
        match = (t.merchant_name or t.name or "").strip().lower()
        if match:
            rule = db.query(BankRule).filter(BankRule.match == match).first()
            if not rule:
                rule = BankRule(id=str(uuid.uuid4()), match=match, created_by=user, created_at=_now())
                db.add(rule)
            rule.category = category
            db.commit()
            moved = apply_rules(db, only_unreviewed=True)
    return {"transaction": tx_dict(t, {}), "also_moved": moved}


# ── Reading ────────────────────────────────────────────────────────────

def tx_dict(t: BankTransaction, accts: dict[str, BankAccount]) -> dict:
    a = accts.get(t.account_id)
    return {
        "transaction_id": t.transaction_id, "account_id": t.account_id,
        "account": f"{a.name} ··{a.mask}" if a and a.mask else (a.name if a else ""),
        "date": t.date, "name": t.name, "merchant_name": t.merchant_name,
        "amount": t.amount, "pending": bool(t.pending), "plaid_category": t.plaid_category,
        "category": t.category, "category_source": t.category_source or "",
        "confidence": t.confidence, "reviewed": bool(t.reviewed),
    }


def _in_range(q, start: str, end: str):
    if start:
        q = q.filter(BankTransaction.date >= start)
    if end:
        q = q.filter(BankTransaction.date <= end)
    return q


def summarize(rows: list[dict]) -> dict:
    """Spending by category, biggest first. Transfers and money in never
    count as spending; refunds are kept apart from money in."""
    by_cat: dict[str, list] = defaultdict(lambda: [0.0, 0])
    spent = came_in = refunds = transfers = unsorted = 0.0
    for r in rows:
        amt, cat = float(r["amount"] or 0), r.get("category")
        if cat == TRANSFER:
            transfers += abs(amt)
        elif amt < 0:
            if cat == REFUND:
                refunds += -amt
            else:
                came_in += -amt
        elif amt > 0 and cat not in NOT_SPENDING:
            spent += amt
            key = cat or UNSORTED
            by_cat[key][0] += amt
            by_cat[key][1] += 1
            if not cat:
                unsorted += amt
    ranked = sorted(by_cat.items(), key=lambda kv: -kv[1][0])
    return {
        "spent": round(spent, 2), "came_in": round(came_in, 2), "refunds": round(refunds, 2),
        "transfers": round(transfers, 2), "unsorted": round(unsorted, 2),
        "by_category": [{"name": k, "amount": round(v[0], 2), "count": v[1]} for k, v in ranked],
        "count": len(rows),
    }


def _accounts_out(db) -> list[dict]:
    banks = {i.item_id: i.institution_name for i in db.query(BankItem).all()}
    return [{
        "account_id": a.account_id, "bank": banks.get(a.item_id, ""), "name": a.name, "mask": a.mask,
        "type": a.type, "subtype": a.subtype, "current_balance": a.current_balance,
        "available_balance": a.available_balance, "updated_at": a.updated_at,
    } for a in db.query(BankAccount).order_by(BankAccount.item_id, BankAccount.name).all()]


def summary(db, start: str, end: str) -> dict:
    rows = [{"amount": t.amount, "category": t.category} for t in _in_range(db.query(BankTransaction), start, end).all()]
    out = summarize(rows)
    out.update({
        "start": start, "end": end, "accounts": _accounts_out(db),
        "needs_review": db.query(BankTransaction).filter(BankTransaction.reviewed.is_(False)).count(),
    })
    return out


def transactions(db, start: str = "", end: str = "", category: str = "", needs_review: bool = False, limit: int = 2000) -> list[dict]:
    q = _in_range(db.query(BankTransaction), start, end)
    if category == UNSORTED:
        q = q.filter(BankTransaction.category.is_(None))
    elif category:
        q = q.filter(BankTransaction.category == category)
    if needs_review:
        q = q.filter(BankTransaction.reviewed.is_(False))
    accts = {a.account_id: a for a in db.query(BankAccount).all()}
    rows = q.order_by(BankTransaction.date.desc(), BankTransaction.amount.desc()).limit(limit).all()
    return [tx_dict(t, accts) for t in rows]


def status(db) -> dict:
    items = db.query(BankItem).order_by(BankItem.created_at).all()
    counts: dict[str, int] = defaultdict(int)
    for a in db.query(BankAccount).all():
        counts[a.item_id] += 1
    synced = [i.last_synced_at for i in items if i.last_synced_at]
    return {
        "configured": plaid.is_configured(),
        "env": plaid.env(),
        "categories": CATEGORIES,
        "items": [{
            "id": i.id, "institution_name": i.institution_name or "Bank", "created_at": i.created_at,
            "last_synced_at": i.last_synced_at, "error": i.error or "", "accounts": counts[i.item_id],
        } for i in items],
        "last_synced_at": max(synced) if synced else "",
    }
