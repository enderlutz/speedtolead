"""CAC per ad: payments find their contact by lead id, unique email, then
unique name; customers are counted against the ad of the lead's contact."""
from database import Contact, QuickbooksInvoice
from services import ad_cac


def _c(db, cid, ad="A1", lead=None, email="", name="", day="2026-09-10"):
    db.add(Contact(id=cid, ghl_contact_id="g" + cid, ad_id=ad, ad_name="Ad " + ad, ad_campaign="Camp",
                   lead_id=lead, email=email, name=name, date_added=day + "T12:00:00Z"))


def _inv(db, n, amount, lead=None, email="", name=""):
    db.add(QuickbooksInvoice(id=f"i{n}", qb_invoice_id=f"q{n}", lead_id=lead, customer_email=email,
                             customer_name=name, amount_paid=amount, total_amount=amount, status="paid"))


def test_matching_and_counts(db):
    _c(db, "1", lead="L1")
    _c(db, "2", email="b@x.com")
    _c(db, "3", name="Cara Dee")
    _c(db, "4")                                   # a lead that never paid
    _c(db, "5", ad="A2", name="Same Name")
    _c(db, "6", ad="A2", name="Same Name")        # ambiguous name: no match
    _c(db, "7", day="2026-01-01", lead="L7")      # outside the window
    db.commit()
    _inv(db, 1, 1000, lead="L1")
    _inv(db, 2, 500, email="B@x.com")
    _inv(db, 3, 250, name="cara  dee")
    _inv(db, 4, 900, name="Same Name")
    _inv(db, 5, 800, lead="L7")
    db.commit()

    out = ad_cac.outcomes_by_ad(db, "2026-09-01", "2026-09-30")
    assert out["A1"]["leads"] == 4 and out["A1"]["customers"] == 3
    assert out["A1"]["revenue"] == 1750
    assert out["A2"] == {"leads": 2, "customers": 0, "revenue": 0.0, "ad": "Ad A2", "campaign": "Camp"}
