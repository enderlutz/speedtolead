"""The three numbers, every day, and the money watch (Alan, 2026-10-29)."""
import json
import uuid
from datetime import date, datetime, timezone

import pytest

from database import (BankAccount, BankItem, BankTransaction, CompanyCamJob, DailyScore, Estimate, Lead, PayLink,
                      SystemConfig, User)
from services import scoreboard as sb


def _lead(db, name):
    l = Lead(id=str(uuid.uuid4()), contact_name=name, contact_phone="+17135550000", ghl_contact_id="g-" + name,
             pipeline_version="v2", status="new", created_at="2026-10-01T00:00:00Z", is_test=False)
    db.add(l)
    db.commit()
    return l


def _sent(db, lead, day):
    db.add(Estimate(id=str(uuid.uuid4()), lead_id=lead.id, service_type="fence_staining", status="sent",
                    sent_at=f"{day}T15:00:00+00:00", created_at=f"{day}T15:00:00+00:00", tiers="{}"))


def _paid(db, lead, day, amount, total):
    db.add(PayLink(token=str(uuid.uuid4())[:20], lead_id=lead.id, kind="deposit", amount_cents=int(amount * 100),
                   job_total_cents=int(total * 100), status="paid", paid_at=f"{day}T16:00:00+00:00",
                   created_at=f"{day}T15:00:00+00:00"))


def _spend(db, day, category, amount):
    db.add(BankTransaction(transaction_id=str(uuid.uuid4()), account_id="a1", date=day, name="x", amount=amount,
                           pending=False, category=category))


def _setup(db):
    db.add(User(id="u1", username="Chris", display_name="Chris Moran", password_hash="x", role="worker",
                permissions="{}", hourly_rate=16, created_at=""))
    a, b, c, d = (_lead(db, n) for n in ("Ann", "Bob", "Cid", "Dee"))
    for l in (a, b, c, d):
        _sent(db, l, "2026-10-20")
    _paid(db, a, "2026-10-21", 250, 1500)       # a new customer worth $1,500
    _paid(db, b, "2026-08-01", 250, 900)        # paid long ago: not new this window
    _spend(db, "2026-10-22", "Meta ads", 600)
    _spend(db, "2026-10-23", "Other marketing", 0)
    _spend(db, "2026-10-23", "Stain & materials", 999)   # the bank's check, not split per job
    _spend(db, "2026-08-01", "Meta ads", 5000)  # outside the window
    # A finished job: $1,500, Chris flat $100 cleaning + an hourly staining day with no clock-in, 6 gallons.
    db.add(CompanyCamJob(id=str(uuid.uuid4()), lead_id=a.id, completed_at="2026-10-25T20:00:00+00:00", final_price_cents=150000,
                         gallons_needed=6.0, crew_json=json.dumps([
                             {"username": "Chris", "date": "2026-10-24", "task": "cleaning", "pay_type": "flat", "pay": 100},
                             {"username": "Chris", "date": "2026-10-25", "task": "staining", "pay_type": "hourly", "pay": 16}])))
    db.commit()


def test_the_three_numbers(db):
    _setup(db)
    s = sb.compute(db, date(2026, 10, 29))
    assert (s["since"], s["until"]) == ("2026-09-30", "2026-10-29")
    # Cost to get a customer: the bank's ad charges in the window ÷ new paying customers.
    assert s["ad_spend"] == 600 and s["ad_spend_source"] == "bank" and s["new_customers"] == 1 and s["cac"] == 600
    # Close rate: new paying customers ÷ estimates sent.
    assert s["estimates_sent"] == 4 and s["close_rate"] == 25.0
    # Profit per job: $1,500 − crew ($100 flat + 8 h × $16 with no clock-in) − 6 gal × $45 − 3% card fees.
    job = s["jobs"][0]
    assert job["crew"] == 228 and job["materials"] == 270 and job["fees"] == 45
    assert s["profit_per_job"] == 957 and s["profit_per_job_after_ads"] == 357
    assert s["bank"]["stain_materials"] == 999
    # It says what it had to guess.
    assert any("no clock-in" in g for g in s["gaps"]) and any("$45 a gallon" in g for g in s["gaps"])
    # The real stain cost per gallon, once set, replaces the guess.
    SystemConfig.set(db, sb.STAIN_COST_KEY, "38")
    assert sb.compute(db, date(2026, 10, 29))["jobs"][0]["materials"] == 228


class _FakeStripe:
    def __init__(self, ready, payouts, enabled=True, due=()):
        self._ready, self._payouts, self._enabled, self._due = ready, payouts, enabled, list(due)
        outer = self

        class Balance:
            @staticmethod
            def retrieve():
                return {"available": [{"amount": int(outer._ready * 100), "currency": "usd"}],
                        "pending": [{"amount": 24245, "currency": "usd"}]}

        class Account:
            @staticmethod
            def retrieve():
                return {"payouts_enabled": outer._enabled, "requirements": {"currently_due": outer._due}}

        class Payout:
            @staticmethod
            def list(limit=10):
                return {"data": outer._payouts}
        self.Balance, self.Account, self.Payout = Balance, Account, Payout


def _ts(day):
    return int(datetime.fromisoformat(day + "T18:00:00+00:00").timestamp())


def test_money_sitting_in_stripe_is_called_out():
    today = date(2026, 10, 29)
    # October 2026: $27k in Stripe, never paid out.
    w = sb.stripe_watch(_FakeStripe(27446.85, []))
    assert w["ready"] == 27446.85 and w["last_payout"] is None
    assert sb.money_problems(w, today) == ["$27,446.85 is sitting in Stripe and it has never paid out."]
    # Paid out yesterday: nothing to say.
    ok = sb.stripe_watch(_FakeStripe(1500, [{"amount": 100000, "status": "paid", "created": _ts("2026-10-28"),
                                             "arrival_date": _ts("2026-10-30")}]))
    assert sb.money_problems(ok, today) == []
    # Stripe asking for something, payouts off, a failed payout.
    bad = sb.stripe_watch(_FakeStripe(10, [{"amount": 5000, "status": "failed", "created": _ts("2026-10-27"),
                                            "arrival_date": _ts("2026-10-29"), "failure_message": "account closed"}],
                                      enabled=False, due=["individual.ssn_last_4"]))
    msgs = sb.money_problems(bad, today)
    assert any("switched off" in m for m in msgs) and any("wants 1 thing" in m for m in msgs)
    assert any("$50.00 payout failed: account closed" in m for m in msgs)


def test_it_saves_every_day_and_texts_once(db, monkeypatch):
    _setup(db)
    import config
    monkeypatch.setattr(config.get_settings(), "owner_ghl_contact_id", "alan-contact", raising=False)
    real_watch = sb.stripe_watch
    monkeypatch.setattr(sb, "stripe_watch", lambda *a, **k: real_watch(_FakeStripe(27446.85, [])))
    import database
    monkeypatch.setattr(database, "get_db", lambda: db)
    db.close = lambda: None
    sent = []
    send = lambda to, msg: sent.append((to, msg)) or True  # noqa: E731
    # Monday Nov 2, 9:30 AM Houston: saves Sunday and today, money text + Monday text, once each.
    monday = datetime(2026, 11, 2, 15, 30, tzinfo=timezone.utc)
    done = sb.run_daily(monday, send=send)
    assert done["saved"] == ["2026-11-01", "2026-11-02"] and done["texted"] == ["money", "monday"]
    assert sent[0][1].startswith("Money check:") and "$27,446.85 is sitting in Stripe" in sent[0][1]
    assert sent[1][1].startswith("Sterling, last 30 days:") and "Close rate:" in sent[1][1]
    assert sb.run_daily(monday, send=send)["texted"] == []   # not twice the same day
    assert db.get(DailyScore, "2026-11-02").close_rate is not None
    # Tuesday: no Monday text.
    assert "monday" not in sb.run_daily(datetime(2026, 11, 3, 15, 30, tzinfo=timezone.utc), send=send)["texted"]


def test_monday_text_compares_with_the_week_before():
    msg = sb.monday_message({"cac": 249, "close_rate": 12.9, "profit_per_job": 734, "profit_per_job_after_ads": 485},
                            {"cac": 200, "close_rate": 10.0, "profit_per_job": 800})
    assert "Cost to get a customer: $249 (up from $200, watch it)" in msg
    assert "Close rate: 12.9% (up from 10%)" in msg
    assert "Profit per job: $734 (down from $800, watch it), $485 after ads" in msg
