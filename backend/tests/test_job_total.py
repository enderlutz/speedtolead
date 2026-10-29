"""The bill follows the total texted to the customer; a quick $250 gets a
job total guessed from the call (Alan, 2026-10-29)."""
import json
import uuid

from database import CallRecording, CallTranscript, Estimate, Lead, Message
from services import job_total as jt

FINAL = """Hi Mr. Smith, it's Alan with Sterling Fence Staining. Thank you for today. Here's your final total with everything we added:
• Cleaning and staining, Cabot Semi-Solid Cordovan Leather, 2 coats: $1,994.40
• 30 cedar pickets at $10: $300
• 7 rails at $75: $525
• 1 post replacement: $225
• 5.5 more 2x4 rails added today at $75: $412.50 (5 full and 1 half)
Total: $3,456.90. Your $250 deposit comes off, so $3,206.90 is due when the job is done."""

FIRST = """Here is your full quote:

• Fence cleaning and staining (Cabot Semi-Solid Cordovan Leather, 2 coats): $1,994.40
• 30 pine treated pickets at $10: $300
• 7 rails at $75: $525
• 1 post replacement: $225. We break up and remove the old concrete.

Total: $3,044.40. Your $250 deposit comes off."""


def _lead(db, name="Customer A"):
    l = Lead(id=str(uuid.uuid4()), contact_name=name, contact_phone="+17135550000", ghl_contact_id="g-" + name,
             pipeline_version="v2", status="new", created_at="2026-10-01T00:00:00Z")
    db.add(l)
    db.commit()
    return l


def _msg(db, lead, body, at, direction="outbound"):
    db.add(Message(id=str(uuid.uuid4()), lead_id=lead.id, ghl_contact_id=lead.ghl_contact_id, direction=direction,
                   body=body, message_type="TYPE_SMS", created_at=at))
    db.commit()


def test_parse_reads_only_quotes_that_add_up():
    q = jt.parse_quote(FINAL)
    assert q["total"] == 3456.9 and len(q["lines"]) == 5
    assert q["lines"][4] == {"name": "5.5 more 2x4 rails added today at $75", "amount": 412.5}
    assert jt.parse_quote(FIRST)["total"] == 3044.4
    assert jt.parse_quote("• Staining: $1,000\nTotal: $1,500") is None   # lines don't add up
    assert jt.parse_quote("Your total is about $1,500") is None


def test_the_latest_texted_total_wins(db):
    l = _lead(db)
    _msg(db, l, FIRST, "2026-10-27T00:25:37Z")
    _msg(db, l, FINAL, "2026-10-28T00:17:25Z")
    _msg(db, l, "Total: $9,999 is what I'd pay", "2026-10-28T01:00:00Z", direction="inbound")
    q = jt.texted_quote(db, l.id)
    assert q["total"] == 3456.9 and q["sent_at"].startswith("2026-10-28")


def test_quick_250_job_total_from_the_call(db):
    l = _lead(db)
    db.add(Estimate(id=str(uuid.uuid4()), lead_id=l.id, service_type="fence_staining", status="sent",
                    created_at="2026-10-20T00:00:00Z", tiers=json.dumps({"essential": 900, "signature": 1100, "legacy": 1400})))
    db.commit()
    # No call yet: their estimate's Signature price, said to be a guess.
    g = jt.guess_total(db, l.id)
    assert g["total"] == 1100 and "No package named" in g["why"]
    rec = CallRecording(id=str(uuid.uuid4()), lead_id=l.id, created_at="2026-10-21T00:00:00Z")
    db.add(rec)
    db.add(CallTranscript(id=str(uuid.uuid4()), recording_id=rec.id,
                          full_text="We have Signature, the semi-transparent... I think we'll go with the Legacy, the solid color."))
    db.commit()
    g = jt.guess_total(db, l.id)
    assert (g["total"], g["tier"]) == (1400, "legacy")
    assert jt.tier_from_text("we're clear on that, solid work") == ""


def test_texted_lines_become_real_invoice_lines():
    items = jt.quote_items(jt.parse_quote(FINAL)["lines"], "Legacy Finish- Fence Staining")
    assert items == [
        {"name": "Legacy Finish- Fence Staining", "qty": 1, "unit_price": 1994.4,
         "description": "Cleaning & staining of the fence · Cabot Semi-Solid Cordovan Leather, 2 coats"},
        {"name": "Picket Replacement (Cedar)", "qty": 30, "unit_price": 10.0, "description": ""},
        {"name": "2x4 Rails", "qty": 12.5, "unit_price": 75.0, "description": ""},
        {"name": "Post Replacement", "qty": 1, "unit_price": 225.0, "description": ""},
    ]
    assert round(sum(i["qty"] * i["unit_price"] for i in items), 2) == 3456.9
    first = jt.quote_items(jt.parse_quote(FIRST)["lines"])
    assert first[0]["name"] == "Legacy Finish- Fence Staining" and first[1]["name"] == "Picket Replacement (Pine)"
    # A line that isn't a known item stays as texted.
    odd = jt.quote_items([{"name": "Gate hinge swap", "amount": 40.0}])
    assert odd == [{"name": "Gate hinge swap", "qty": 1, "unit_price": 40.0, "description": ""}]
