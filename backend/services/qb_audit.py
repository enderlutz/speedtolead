"""Where the money went (Alan, 2026-10-17: "I started the month with about
$70,000 and now I have $73,000 — audit my transactions, what's taking up
all my profit"). Read-only: pulls the month's money movements out of
QuickBooks (card and bank spending, deposits, transfers, bill payments,
customer payments) and the bank and card balances, and boils them down.

Only what QuickBooks has *accepted* shows here. Bank-feed lines still
sitting in "For review" aren't in QuickBooks' API yet, so the count of
those is the first thing to check when the totals look thin.
"""
from __future__ import annotations

from collections import defaultdict

from services import quickbooks_client as qb


def _query(entity: str, where: str = "") -> list[dict]:
    t = qb.ensure_valid_access_token()
    if not t:
        raise PermissionError("Not connected to QuickBooks — reconnect required")
    out: list[dict] = []
    start = 1
    while True:
        q = f"SELECT * FROM {entity}{(' WHERE ' + where) if where else ''} STARTPOSITION {start} MAXRESULTS 1000"
        res = qb.qbo_request("GET", f"/v3/company/{t.realm_id}/query", params={"query": q})
        page = ((res.get("QueryResponse") or {}).get(entity)) or []
        out += page
        if len(page) < 1000:
            return out
        start += 1000


def _name(ref: dict | None) -> str:
    return ((ref or {}).get("name") or "").strip()


def _lines(t: dict) -> list[str]:
    cats = []
    for ln in t.get("Line") or []:
        d = ln.get("AccountBasedExpenseLineDetail") or ln.get("DepositLineDetail") or {}
        n = _name(d.get("AccountRef"))
        if n and n not in cats:
            cats.append(n)
        if not n and ln.get("ItemBasedExpenseLineDetail"):
            cats.append("Items: " + _name(ln["ItemBasedExpenseLineDetail"].get("ItemRef")))
    return cats


def pull(start: str, end: str) -> dict:
    when = f"TxnDate >= '{start}' AND TxnDate <= '{end}'"
    rows: list[dict] = []

    for p in _query("Purchase", when):
        amt = float(p.get("TotalAmt") or 0)
        refund = bool(p.get("Credit"))       # a card refund comes back as a Purchase with Credit=true
        rows.append({
            "date": p.get("TxnDate"), "type": "Refund" if refund else "Spend",
            "direction": "in" if refund else "out", "amount": amt,
            "account": _name(p.get("AccountRef")), "pay_type": p.get("PaymentType") or "",
            "payee": _name(p.get("EntityRef")), "category": ", ".join(_lines(p)) or "Uncategorized",
            "memo": (p.get("PrivateNote") or "")[:200],
        })
    for d in _query("Deposit", when):
        rows.append({
            "date": d.get("TxnDate"), "type": "Deposit", "direction": "in", "amount": float(d.get("TotalAmt") or 0),
            "account": _name(d.get("DepositToAccountRef")), "pay_type": "",
            "payee": ", ".join(sorted({_name((l.get("DepositLineDetail") or {}).get("Entity")) for l in d.get("Line") or []} - {""})),
            "category": ", ".join(_lines(d)) or "Deposit", "memo": (d.get("PrivateNote") or "")[:200],
        })
    for t in _query("Transfer", when):
        rows.append({
            "date": t.get("TxnDate"), "type": "Transfer", "direction": "move", "amount": float(t.get("Amount") or 0),
            "account": f"{_name(t.get('FromAccountRef'))} → {_name(t.get('ToAccountRef'))}", "pay_type": "",
            "payee": "", "category": "Transfer", "memo": (t.get("PrivateNote") or "")[:200],
        })
    for b in _query("BillPayment", when):
        acct = _name(((b.get("CheckPayment") or {}).get("BankAccountRef")) or ((b.get("CreditCardPayment") or {}).get("CCAccountRef")))
        rows.append({
            "date": b.get("TxnDate"), "type": "Bill paid", "direction": "out", "amount": float(b.get("TotalAmt") or 0),
            "account": acct, "pay_type": b.get("PayType") or "", "payee": _name(b.get("VendorRef")),
            "category": "Bill payment", "memo": (b.get("PrivateNote") or "")[:200],
        })
    for p in _query("Payment", when):
        rows.append({
            "date": p.get("TxnDate"), "type": "Customer payment", "direction": "in", "amount": float(p.get("TotalAmt") or 0),
            "account": _name(p.get("DepositToAccountRef")) or "Undeposited Funds", "pay_type": "",
            "payee": _name(p.get("CustomerRef")), "category": "Sales", "memo": "",
        })
    for s in _query("SalesReceipt", when):
        rows.append({
            "date": s.get("TxnDate"), "type": "Sales receipt", "direction": "in", "amount": float(s.get("TotalAmt") or 0),
            "account": _name(s.get("DepositToAccountRef")) or "Undeposited Funds", "pay_type": "",
            "payee": _name(s.get("CustomerRef")), "category": "Sales", "memo": "",
        })

    accounts = [{
        "name": a.get("Name"), "type": a.get("AccountType"), "subtype": a.get("AccountSubType") or "",
        "balance": float(a.get("CurrentBalance") or 0),
    } for a in _query("Account", "Active = true") if a.get("AccountType") in ("Bank", "Credit Card")]

    rows.sort(key=lambda r: (r["date"] or "", -r["amount"]))
    return {"start": start, "end": end, "rows": rows, "accounts": accounts, "summary": summarize(rows)}


def summarize(rows: list[dict]) -> dict:
    spend = [r for r in rows if r["direction"] == "out"]
    money_in = [r for r in rows if r["direction"] == "in"]
    by_cat: dict[str, float] = defaultdict(float)
    by_payee: dict[str, float] = defaultdict(float)
    by_acct: dict[str, float] = defaultdict(float)
    for r in spend:
        by_cat[r["category"]] += r["amount"]
        by_payee[r["payee"] or "(no payee)"] += r["amount"]
        by_acct[r["account"] or "(no account)"] += r["amount"]
    top = lambda d, n: [{"name": k, "amount": round(v, 2)} for k, v in sorted(d.items(), key=lambda kv: -kv[1])[:n]]
    return {
        "spent": round(sum(r["amount"] for r in spend), 2),
        "came_in": round(sum(r["amount"] for r in money_in if r["type"] != "Refund"), 2),
        "refunds": round(sum(r["amount"] for r in money_in if r["type"] == "Refund"), 2),
        "transfers": round(sum(r["amount"] for r in rows if r["direction"] == "move"), 2),
        "uncategorized": round(sum(r["amount"] for r in spend if r["category"] == "Uncategorized"), 2),
        "by_category": top(by_cat, 40), "by_payee": top(by_payee, 60), "by_account": top(by_acct, 20),
        "count": len(rows),
    }
