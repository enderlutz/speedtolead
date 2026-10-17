"""Cost to get a paying customer, per Meta ad (Alan, 2026-10-17: "for each
ad, find my cost per acquisition, my CAC").

Spend comes from Meta (services/meta_ads). Customers come from us: every
QuickBooks payment matched to the GHL contact it belongs to, and that
contact's ad (contacts.ad_id, mirrored off GHL's attribution: the same Meta
id the Insights API returns).

Only 4 in 10 payments carry a lead id, so a payment matches on, in order:
the lead id, then an email only one contact has, then a name only one
contact has. That finds the customer for ~97% of payments.

Cohort by lead date: an ad's customers are the people whose lead came in
during the window, whenever they paid. Recent leads haven't had time to pay
yet, so a short window reads high.
"""
from __future__ import annotations

import re
from collections import defaultdict

from database import Contact, QuickbooksInvoice


def _norm_name(s: str | None) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z ]", "", (s or "").lower())).strip()


def paid_by_contact(db) -> dict[str, float]:
    """contact id → money paid, all time."""
    contacts = db.query(Contact.id, Contact.lead_id, Contact.email, Contact.name).all()
    by_lead, by_email, by_name = {}, defaultdict(list), defaultdict(list)
    for cid, lid, email, name in contacts:
        if lid:
            by_lead[lid] = cid
        if (email or "").strip():
            by_email[email.strip().lower()].append(cid)
        if _norm_name(name):
            by_name[_norm_name(name)].append(cid)

    paid: dict[str, float] = defaultdict(float)
    rows = (db.query(QuickbooksInvoice.lead_id, QuickbooksInvoice.customer_email,
                     QuickbooksInvoice.customer_name, QuickbooksInvoice.amount_paid)
            .filter(QuickbooksInvoice.amount_paid > 0).all())
    for lid, email, name, amount in rows:
        cid = by_lead.get(lid) if lid else None
        if not cid:
            hits = by_email.get((email or "").strip().lower()) or []
            cid = hits[0] if len(hits) == 1 else None
        if not cid:
            hits = by_name.get(_norm_name(name)) or []
            cid = hits[0] if len(hits) == 1 else None
        if cid:
            paid[cid] += float(amount or 0)
    return paid


def outcomes_by_ad(db, since: str, until: str) -> dict[str, dict]:
    """ad id → {leads, customers, revenue, ad, campaign} for ad leads that
    came in on [since, until] (YYYY-MM-DD)."""
    paid = paid_by_contact(db)
    out: dict[str, dict] = {}
    rows = (db.query(Contact.id, Contact.ad_id, Contact.ad_name, Contact.ad_campaign, Contact.date_added)
            .filter(Contact.ad_id != "", Contact.ad_id.isnot(None)).all())
    for cid, ad_id, ad_name, campaign, added in rows:
        day = (added or "")[:10]
        if not (since <= day <= until):
            continue
        o = out.setdefault(ad_id, {"leads": 0, "customers": 0, "revenue": 0.0,
                                   "ad": ad_name or "", "campaign": campaign or ""})
        o["leads"] += 1
        if paid.get(cid):
            o["customers"] += 1
            o["revenue"] += paid[cid]
    return out
