# Contractor / partner accounts: one contact, many job addresses

**Asked:** 2026-11-07 (Alan), while a landscaping partner waited two days on a quote for a second address.

## The problem today
- A lead row is the unit of everything (address, scope drawing, estimate, proposal, booking, invoice), and the database allows **one lead per GHL contact** (`leads.ghl_contact_id` is unique).
- A partner (landscaper, builder, property manager) or a repeat homeowner brings a **new address** each time. Today the only options are to overwrite the address on their old lead (history gets muddled) or to make a second GHL contact (duplicates, wrong texts).
- The scope drawing, the "sides" and the price all hang off that one address, so two open jobs for one partner cannot coexist.

## What Alan wants
- Open the partner's page, add a job address, trace the fence on satellite, price it, send the scope + price. Next month, same page, next address. All jobs stay listed under the partner.
- Two scopes with two prices for the same address when the end customer is undecided (e.g. "inside only" vs "both sides"), each with its own drawing, so the partner confirms the sides before any price goes out.

## Proposed build (about half a day)
1. **Jobs under a contact.** Keep one GHL contact. Relax the unique rule to `(ghl_contact_id, job_no)`; every lead row gets `job_no` (1 for everything that exists today). "+ New job address" on the lead page creates job 2 for the same contact: fresh address, drawing, estimate, booking, invoice; name shown as "Partner · 334 Example St".
2. **Contacts page groups by contact.** One row per person, expandable to their jobs, newest first. The next-step column reads from the newest open job.
3. **Partner flag.** `is_partner` on the contact: skips the homeowner nurture texts, shows "normal price, +10% for Cabot" style notes on every new job, and the pay-after-job rule.
4. **Two scopes, one address.** Each estimate already carries its own drawing and link (the 2026-11-01 rule: a second price is its own estimate). Add a label on the estimate ("Inside only" / "Both sides") that prints on the scope share and the proposal title.
5. **GHL notes** get the job address as a prefix so the one contact's notes stay readable.

## Open questions
- Does a partner job show on the On call board like a homeowner lead (yes, but tagged partner, no VA call)?
- Invoicing: partner pays Sterling (today) vs end customer pays. Keep partner-pays as the default.
