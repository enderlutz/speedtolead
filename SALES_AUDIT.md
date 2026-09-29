# Sterling Fence Staining — Sales Process Audit (measured)

Continues Alan's ChatGPT handoff of 2026-09-28. Everything below is measured
from the production database unless marked ASSUMPTION or UNVERIFIED.

Cohort used for funnel numbers: **leads created 2026-07-01 → 2026-09-01**
(matured enough to have finished converting). n = 556.

---

## 1. The funnel, measured

| Stage | Count | of leads | of previous |
|---|---|---|---|
| Leads created | 556 | 100% | — |
| Estimate sent | 460 | 83% | 83% |
| Opened the proposal | 428 | 77% | 93% |
| Deposit paid | 47 | 8.5% | 11% |

All-time deposit rate: 64 of 1,894 leads = **3.4%**.

**The proposal is not the problem.** 93% of people who receive one open it.
The loss is entirely after that.

## 2. Confirmed: the proposal has no way to say yes

`frontend/src/pages/ProposalView.tsx` — every interactive element on the page
a customer lands on:

1. A phone icon (`tel:` link)
2. A "Request a side change" form
3. Close buttons

There is **no package selection, no accept, no deposit, no booking**. The PDF
explains three packages and the page ends.

The deposit link is created manually: a staff member clicks it in the
dashboard, which raises a QuickBooks invoice and texts a link
(`backend/api/quickbooks.py:82` `_text_deposit_link`). Nothing generates or
sends it automatically.

So the path from "customer is sold" to "customer pays" requires the customer
to initiate contact, and then a human to act.

## 3. Follow-up after the proposal correlates hard with payment

Leads who opened a proposal, Jun–Aug, counting only outbound SMS/calls in the
**72h after they opened it**, and for buyers only those sent **before** they
paid — so this is not just "buyers get more messages":

| Touches in first 72h | n | Deposits | Rate |
|---|---|---|---|
| 0 | 81 | 0 | 0.0% |
| 1 | 85 | 1 | 1.2% |
| 2–3 | 133 | 2 | 1.5% |
| **4+** | **119** | **19** | **16.0%** |

Speed of the first touch after opening:

| First touch | n | Rate |
|---|---|---|
| <1h | 230 | 7.8% |
| 1–4h | 12 | 8.3% |
| 4–24h | 54 | 1.9% |
| 1–3 days | 44 | 4.5% |
| 3+ days or never | 78 | 0.0% |

**Caveat, important:** still correlational. An engaged customer replies, which
produces more outbound messages. What is *not* ambiguous is the floor —
**166 leads (40% of proposal-openers) received 0 or 1 touch in 72 hours and
produced 1 deposit between them.**

## 4. The follow-up engine is built and switched off

`backend/services/followup_engine.py` runs on every boot
(`main.py:522`). The database holds **14 designed sequences and 33 written
steps**, including one named **"P1: Sterling Estimate Sent"**.

`followup_sequences.active`:

- `True` — only "iMessage → SMS fallback test"
- `False` — P0 Intake, **P1 Estimate Sent**, P02a–d Ad Tag, P03 Address
  Confirmation, U01, U02 and the rest

All 8 `followup_runs` belong to a single test lead and stopped **2026-05-14**.
The engine has never processed a real customer.

**Nuance, not yet verified:** the "estimate sent" GHL tag fires P1/P04
workflows *inside GHL*. So follow-up is likely happening there, and this
dashboard engine is a dormant parallel copy. Confirm which system is actually
messaging customers before switching anything on — running both would double-text
every customer.

## 5. Reply rate cannot currently be measured

| | |
|---|---|
| Leads with conversation history stored | 268 (48%) |
| Leads with no messages stored at all | 288 (52%) |
| Replied, among those we have history for | 240/268 = **89.6%** |
| Replied, as a share of all leads | 240/556 = **43.2%** |

The missing half is not dead weight — they convert slightly *better* (9.4% vs
7.5% deposit), so they are not simply non-responders. **True reply rate is
between 43% and 90% and the data cannot narrow it.**

Alan's screenshot-based impression of ~90% is accurate *for threads that were
synced*, and those are a biased sample.

## 6. Ad attribution does not exist in practice

`lead_source` = `"ad"` for 1,893 of 1,894 leads. One row says `"other"`.

There is a `backend/services/ad_attribution.py`, but nothing in the data
distinguishes which ad, hook, or offer produced a lead. **"Which hook books
the most jobs" is unanswerable today** regardless of ad performance data.

## 7. Corrections to the handoff

- **The aerial scope tool is far newer than assumed.** Only 22 leads have ever
  been sent one, all in September 2026. The Jul–Aug funnel above predates it.
  Too early to judge its effect (22 sent, 0 deposits so far — not meaningful).
- The video-estimate feature was hidden 2026-09-28: 3 submissions ever, none
  completed by a real customer.

---

## 8. BIGGEST FINDING: conversion is roughly double what the dashboard shows

The dashboard measures "became a job" with `deposit_paid_at` — the paid $250
**deposit invoice**. Most customers never pay that invoice. They pay the **job
invoice** instead, and that invoice is usually not linked to their lead.

`quickbooks_invoices`, all time:

| | Invoices | Amount paid |
|---|---|---|
| Linked to a lead, paid | 68 | $101,690 |
| **NOT linked to a lead, paid** | **124** | **$176,083** |

**63% of collected revenue cannot be traced to the lead that produced it.**

Matching those unlinked paid invoices back to leads by first+last name,
deduplicated to distinct leads, ambiguous names excluded:

| | |
|---|---|
| Unlinked paid invoices | 124 |
| Skipped — name matches 2+ leads, not guessed | 7 |
| Resolved to distinct leads | 74 (worth $121,451) |
| Already counted as converted | 4 |
| **Newly identified as converted** | **70** |

| Conversion, all leads | |
|---|---|
| Dashboard reports | 64/1,894 = **3.4%** |
| Actual (estimated) | 134/1,894 = **7.1%** |

**CAVEAT:** first+last name matching, 75 ambiguous names excluded. Treat 7.1%
as an estimate to confirm, not a final figure. The direction is not in doubt.

Concrete examples previously scored as "never paid":

- **Adam Wenck** — said "Paid. Thanks again"; paid **$1,000.80** on 24 Sep
- **Aisha Williams** — said "Paid. Thank you again"; paid **$1,262.00** on 10 Sep
- **Julie Meyer Pierson** — paid **$1,345.50** on 27 Sep
- **Ronnie Stoute** — paid **$1,296.00** on 27 Sep
- **Val Aldred** — paid **$988.65** on 25 Sep via Affirm

The deposit invoices for these customers are still sitting open and unpaid in
QuickBooks. That is a second, separate problem: **32 orphaned $250 deposit
invoices ($8,000) that will never be paid** because the customer paid the full
job invoice instead. They should be voided or reconciled.

### Two distinct causes

1. **Missing link.** The job invoice is raised in QuickBooks without a
   `lead_id`, so nothing ties the money back to the lead. 124 invoices.
2. **Wrong success signal.** `deposit_paid_at` is the wrong field to measure
   conversion. "Any paid QuickBooks invoice for this lead" is the right one.

There is also **no lead status meaning "won"** — `leads.status` is only
`sent / new / archived / estimated / active / closed` (1 lead is `closed`),
and `closed_tier` is `legacy_import` for 30 of 31 records, so **which package
customers buy is not recorded either.**

**Consequence:** every conversion number in this document, and every number in
the dashboard, understates reality by roughly 2x. No change to the proposal,
the follow-up or the ads can be measured until the link is fixed.

## 9. Why customers actually don't buy (read, not inferred)

The last message from 45 customers who opened a proposal and never paid.
Qualitative and indicative, not statistical — but consistent:

| Reason | ~count | Examples |
|---|---|---|
| **Not now / timing** | ~10 | "In about 3 months" · "hold off until November" · "check back mid October" · "too soon" · "still finishing my backyard" |
| Talking to spouse | 4 | "Let me get with my bride" · "husband wants to see if you've done classic mahogany" |
| Comparing quotes | 3 | "I am getting three estimates" · "some companies offer lower prices" |
| Price objection | 3 | "not going to spend that kind of money on an old fence" · "too rich for me" |
| **Ready, stuck on package/payment** | 2 | "Trying to decide between signature and legacy" · "I like the premium package **if I can pay it monthly**" |
| Scope unclear from the estimate | 2 | "I couldn't tell from your estimate. Was this both inside of my fence…" · "just making sure it is a quote and not an invoice" |
| **Over-contacted** | 1 | "Damn! Will you PLEASE stop badgering me! When I'm ready I will let you know" |

**This is the answer to "button or conversation".** A pay-now button on the
proposal would have helped roughly **2 of 45**. Timing objections — customers
who want to buy in 1–3 months — are **five times more common**, and no button
addresses those.

Note the counterweight to §3: David Johnson's "stop badgering me" is a real
cost of more follow-up. The correlation between touches and payment is not a
licence to increase volume indiscriminately.

## Open questions, in priority order

1. Does closing stay conversation-led, or should the proposal itself let a
   customer choose a package and pay? *(asked)*
2. Which system actually messages customers after the estimate — GHL's P1/P04,
   or nothing? Needed before touching the dormant engine.
3. What does P1 send, and on what schedule?
4. Why do 52% of leads never get conversation history stored?
