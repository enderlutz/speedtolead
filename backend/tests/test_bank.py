"""Bank (Plaid, read-only) on Where the money went: rules first, Claude for
the rest with its answer held to our list, /transactions/sync paging with
added/modified/removed, spending that leaves transfers and money in out,
and owner-only."""
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jose import jwt

from config import get_settings
from database import BankAccount, BankItem, BankRule, BankTransaction
from services import bank
from services import plaid_client as plaid


@pytest.fixture
def plaid_on(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "plaid_client_id", "cid-test")
    monkeypatch.setattr(s, "plaid_secret", "secret-test")
    monkeypatch.setattr(s, "plaid_env", "sandbox")
    monkeypatch.setenv("QB_TOKEN_SECRET", "test-token-secret")


def _tx(db, tid, amount, name="", merchant="", category=None, source="", reviewed=False, date="2026-10-05"):
    t = BankTransaction(transaction_id=tid, account_id="acc1", date=date, name=name, merchant_name=merchant,
                        amount=amount, pending=False, category=category, category_source=source, reviewed=reviewed)
    db.add(t)
    return t


# ── Rules ──────────────────────────────────────────────────────────────

def test_rules_sort_unsorted_lines_and_never_touch_a_hand_fix(db):
    db.add(BankRule(id="r1", match="sherwin", category="Stain & materials"))
    db.add(BankRule(id="r2", match="home depot", category="Stain & materials"))
    db.add(BankRule(id="r3", match="home depot tool rental", category="Equipment & tools"))
    _tx(db, "a", 120, name="SHERWIN-WILLIAMS #1234")
    _tx(db, "b", 80, merchant="The Home Depot Tool Rental")
    _tx(db, "c", 40, merchant="Home Depot", category="Other", source="manual", reviewed=True)
    _tx(db, "d", 15, name="Starbucks")
    db.commit()
    assert bank.apply_rules(db) == 2
    a, b, c, d = (db.get(BankTransaction, k) for k in "abcd")
    assert (a.category, a.category_source, a.reviewed) == ("Stain & materials", "rule", True)
    assert b.category == "Equipment & tools"          # the longest match wins
    assert c.category == "Other" and c.category_source == "manual"
    assert d.category is None


def test_a_remembered_fix_becomes_a_rule_and_moves_the_unchecked_ones(db):
    _tx(db, "a", 300, name="ZELLE TO JUAN PEREZ", category="Other", source="claude", reviewed=False)
    _tx(db, "b", 250, name="ZELLE TO JUAN PEREZ", category="Other", source="claude", reviewed=False)
    _tx(db, "c", 200, name="ZELLE TO JUAN PEREZ", category="Owner draw", source="manual", reviewed=True)
    db.commit()
    out = bank.set_category(db, "a", "Crew pay", remember=True, user="alanbonner")
    assert out["also_moved"] == 1
    assert db.get(BankTransaction, "b").category == "Crew pay"
    assert db.get(BankTransaction, "c").category == "Owner draw"
    rule = db.query(BankRule).one()
    assert (rule.match, rule.category, rule.created_by) == ("zelle to juan perez", "Crew pay", "alanbonner")
    with pytest.raises(ValueError):
        bank.set_category(db, "a", "Beer")


# ── Claude ─────────────────────────────────────────────────────────────

def test_parse_keeps_our_categories_only():
    ids = {"a", "b", "c", "d"}
    raw = json.dumps({"results": [
        {"transaction_id": "a", "category": "Meta ads", "confidence": 0.97},
        {"transaction_id": "b", "category": "Beer money", "confidence": 0.99},
        {"transaction_id": "c", "category": "Fuel", "confidence": 7},
        {"transaction_id": "zzz", "category": "Fuel", "confidence": 1},
    ]})
    got = bank.parse_results(raw, ids)
    assert got["a"] == ("Meta ads", 0.97)
    assert got["b"] == ("Other", 0.0)                 # not on the list -> Other, to be looked at
    assert got["c"] == ("Fuel", 1.0)                  # clamped
    assert "d" not in got and "zzz" not in got
    assert bank.parse_results([{"transaction_id": "a", "category": "Taxes", "confidence": 0.8}], ids) == {"a": ("Taxes", 0.8)}
    assert bank.parse_results("not json", ids) == {}


def test_categorize_batches_and_sends_unsure_ones_to_needs_a_look(db, monkeypatch):
    monkeypatch.setattr(bank, "BATCH", 2)
    for i in range(5):
        _tx(db, f"t{i}", 10 + i, name=f"LINE {i}")
    db.commit()
    seen = []

    def fake(lines):
        seen.append(len(lines))
        return {"results": [{"transaction_id": ln["transaction_id"], "category": "Fuel",
                             "confidence": 0.9 if ln["amount"] % 2 == 0 else 0.4} for ln in lines]}

    assert bank.categorize(db, classify=fake) == 5
    assert seen == [2, 2, 1]
    rows = {t.transaction_id: t for t in db.query(BankTransaction).all()}
    assert rows["t0"].reviewed is True and rows["t1"].reviewed is False
    assert all(t.category == "Fuel" and t.category_source == "claude" for t in rows.values())
    assert [t["transaction_id"] for t in bank.transactions(db, needs_review=True)] == ["t3", "t1"]


def test_a_failed_claude_call_leaves_lines_unsorted(db):
    _tx(db, "a", 10)
    _tx(db, "b", 20)
    db.commit()

    def boom(lines):
        raise RuntimeError("credit balance is too low")

    assert bank.categorize(db, classify=boom) == 0
    assert db.query(BankTransaction).filter(BankTransaction.category.is_(None)).count() == 2


# ── /transactions/sync ─────────────────────────────────────────────────

class _Resp:
    def __init__(self, status, data):
        self.status_code, self._d = status, data

    def json(self):
        return self._d


def _plaid_tx(tid, amount, name, pending=False, pending_id=None):
    return {"transaction_id": tid, "account_id": "acc1", "amount": amount, "date": "2026-10-03",
            "authorized_date": "2026-10-02", "name": name, "merchant_name": name.title(), "pending": pending,
            "pending_transaction_id": pending_id,
            "personal_finance_category": {"primary": "GENERAL_MERCHANDISE", "detailed": "GENERAL_MERCHANDISE_OTHER"}}


def test_sync_pages_added_modified_removed_and_keeps_the_cursor(db, plaid_on, monkeypatch):
    item = BankItem(id="i1", item_id="item-1", institution_name="Chase",
                    access_token_enc=bank._encrypt("access-sandbox-1"), cursor="c0")
    db.add(item)
    _tx(db, "old", 5, name="TO BE REMOVED")
    _tx(db, "pend", 42, name="SHELL PENDING", category="Fuel", source="manual", reviewed=True)
    db.commit()
    assert item.access_token_enc != "access-sandbox-1"

    pages = {
        "c0": {"added": [_plaid_tx("n1", 99.5, "SHERWIN WILLIAMS")], "modified": [], "removed": [],
               "next_cursor": "c1", "has_more": True},
        "c1": {"added": [_plaid_tx("n2", 42, "SHELL", pending_id="pend")],
               "modified": [{**_plaid_tx("old", 7, "RENAMED")}],
               "removed": [{"transaction_id": "pend"}], "next_cursor": "c2", "has_more": False},
    }
    calls = []

    def fake_post(url, json=None, timeout=None):
        calls.append((url, json))
        assert json["client_id"] == "cid-test" and json["secret"] == "secret-test"
        if url.endswith("/transactions/sync"):
            assert json["access_token"] == "access-sandbox-1"
            return _Resp(200, pages[json["cursor"]])
        if url.endswith("/accounts/get"):
            return _Resp(200, {"accounts": [{"account_id": "acc1", "name": "Business Checking", "mask": "1234",
                                             "type": "depository", "subtype": "checking",
                                             "balances": {"current": 73000.0, "available": 72500.0}}]})
        raise AssertionError(url)

    monkeypatch.setattr(plaid.httpx, "post", fake_post)
    out = bank.sync_all(db, classify=lambda lines: {"results": []})
    assert out["items"]["Chase"] == {"added": 2, "modified": 1, "removed": 1}
    assert all(u.startswith("https://sandbox.plaid.com/") for u, _ in calls)
    db.expire_all()
    assert db.get(BankItem, "i1").cursor == "c2" and db.get(BankItem, "i1").error == ""
    assert db.get(BankTransaction, "pend") is None
    assert db.get(BankTransaction, "old").amount == 7 and db.get(BankTransaction, "old").name == "RENAMED"
    n2 = db.get(BankTransaction, "n2")
    assert (n2.category, n2.category_source) == ("Fuel", "manual")     # carried over from its pending line
    assert db.get(BankTransaction, "n1").plaid_category == "GENERAL_MERCHANDISE/GENERAL_MERCHANDISE_OTHER"
    assert db.get(BankAccount, "acc1").current_balance == 73000.0


def test_a_bank_that_wants_a_new_login_is_marked_not_crashed(db, plaid_on, monkeypatch):
    db.add(BankItem(id="i1", item_id="item-1", institution_name="Chase", access_token_enc=bank._encrypt("tok"), cursor=""))
    db.commit()
    monkeypatch.setattr(plaid.httpx, "post", lambda url, json=None, timeout=None: _Resp(
        400, {"error_code": "ITEM_LOGIN_REQUIRED", "error_message": "the login details of this item have changed"}))
    out = bank.sync_all(db, classify=lambda lines: {"results": []})
    assert "log in again" in out["items"]["Chase"]["error"]
    db.expire_all()
    assert "Reconnect" in db.get(BankItem, "i1").error


def test_sync_is_a_no_op_when_plaid_isnt_set_up(db, monkeypatch):
    monkeypatch.setattr(get_settings(), "plaid_client_id", "")
    assert bank.sync_all(db) == {"skipped": "not configured"}


# ── Summary ────────────────────────────────────────────────────────────

def test_summary_ranks_spending_and_leaves_transfers_and_money_in_out(db):
    db.add(BankAccount(account_id="acc1", item_id="item-1", name="Checking", mask="1234", type="depository", current_balance=73000))
    _tx(db, "a", 400, category="Stain & materials")
    _tx(db, "b", 900, category="Meta ads")
    _tx(db, "c", 100, category="Stain & materials")
    _tx(db, "d", 5000, category=bank.TRANSFER)
    _tx(db, "e", -5000, category=bank.TRANSFER)
    _tx(db, "f", -2000, category=bank.MONEY_IN)
    _tx(db, "g", -30, category=bank.REFUND)
    _tx(db, "h", 60)
    _tx(db, "z", 777, category="Fuel", date="2026-09-30")    # outside the dates
    db.commit()
    s = bank.summary(db, "2026-10-01", "2026-10-31")
    assert s["spent"] == 1460 and s["came_in"] == 2000 and s["refunds"] == 30 and s["transfers"] == 10000
    assert s["unsorted"] == 60
    assert [c["name"] for c in s["by_category"]] == ["Meta ads", "Stain & materials", bank.UNSORTED]
    assert s["by_category"][1] == {"name": "Stain & materials", "amount": 500, "count": 2}
    assert s["accounts"][0]["current_balance"] == 73000
    assert s["needs_review"] == 9


# ── Owner-only ─────────────────────────────────────────────────────────

def _client():
    from api import bank as bank_api

    app = FastAPI()
    app.include_router(bank_api.router, prefix="/api")
    return TestClient(app), bank_api


def _bearer(sub):
    return {"Authorization": "Bearer " + jwt.encode({"sub": sub, "role": "admin"}, get_settings().auth_secret, algorithm="HS256")}


def test_every_bank_route_is_owner_only(db):
    from api.auth import require_revenue

    client, bank_api = _client()
    for r in bank_api.router.routes:
        assert any(d.call is require_revenue for d in r.dependant.dependencies), r.path
    assert client.get("/api/bank/status", headers=_bearer("olga")).status_code == 403
    assert client.get("/api/bank/summary").status_code in (401, 403)
    ok = client.get("/api/bank/status", headers=_bearer("alanbonner"))
    assert ok.status_code == 200 and "Meta ads" in ok.json()["categories"]


def test_no_encryption_key_means_no_connecting(db, monkeypatch):
    # A bank's access token is never stored in plain text.
    from services import plaid_client as plaid
    monkeypatch.delenv("QB_TOKEN_SECRET", raising=False)
    called = []
    monkeypatch.setattr(plaid, "exchange_public_token", lambda t: called.append(t) or ("access-x", "item-x"))
    with pytest.raises(plaid.PlaidError) as e:
        bank.connect(db, "public-x")
    assert e.value.code == "NO_ENCRYPTION" and called == []


def test_link_token_carries_the_oauth_redirect_in_production(plaid_on, monkeypatch):
    """Chase logs in through OAuth, so the link token has to say where the
    bank sends the customer back (2026-10-27, Plaid production approved)."""
    from config import get_settings
    from services import plaid_client as pc
    seen: dict = {}
    monkeypatch.setattr(pc, "_post", lambda path, body: seen.update(body) or {"link_token": "lt"})
    s = get_settings()
    monkeypatch.setattr(s, "proposal_base_url", "https://estimate.example.com")
    monkeypatch.setattr(s, "plaid_env", "production")
    assert pc.create_link_token("u1") == "lt"
    assert seen["redirect_uri"] == "https://estimate.example.com/money-audit"
    monkeypatch.setattr(s, "plaid_redirect_uri", "https://other.example.com/back")
    pc.create_link_token("u1")
    assert seen["redirect_uri"] == "https://other.example.com/back"
    seen.clear()
    monkeypatch.setattr(s, "plaid_redirect_uri", "")
    monkeypatch.setattr(s, "plaid_env", "sandbox")
    pc.create_link_token("u1")
    assert "redirect_uri" not in seen
