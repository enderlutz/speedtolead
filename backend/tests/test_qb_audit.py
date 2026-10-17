"""Money audit: the month's QuickBooks money boiled down, refunds and
transfers kept out of spend."""
from services import qb_audit


def test_summary_sorts_spend_and_keeps_transfers_and_refunds_out():
    rows = [
        {"date": "2026-10-02", "type": "Spend", "direction": "out", "amount": 400, "account": "Amex", "payee": "Home Depot", "category": "Materials"},
        {"date": "2026-10-03", "type": "Spend", "direction": "out", "amount": 100, "account": "Chase", "payee": "Meta", "category": "Advertising"},
        {"date": "2026-10-04", "type": "Spend", "direction": "out", "amount": 50, "account": "Chase", "payee": "", "category": "Uncategorized"},
        {"date": "2026-10-05", "type": "Refund", "direction": "in", "amount": 30, "account": "Amex", "payee": "Home Depot", "category": "Materials"},
        {"date": "2026-10-06", "type": "Deposit", "direction": "in", "amount": 2000, "account": "Chase", "payee": "Yogi", "category": "Sales"},
        {"date": "2026-10-07", "type": "Transfer", "direction": "move", "amount": 5000, "account": "Chase → Amex", "payee": "", "category": "Transfer"},
    ]
    s = qb_audit.summarize(rows)
    assert s["spent"] == 550 and s["came_in"] == 2000 and s["refunds"] == 30 and s["transfers"] == 5000
    assert s["uncategorized"] == 50
    assert s["by_category"][0] == {"name": "Materials", "amount": 400}
    assert s["by_payee"][-1]["name"] == "(no payee)"
