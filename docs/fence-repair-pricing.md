# Sterling Fence Staining — Fence Repair Pricing

Supplied by Alan, 2026-09-29. **Reference only** — deliberately not wired into
the estimate calculator or the service catalog yet.

Two uses it is being kept for:

1. **The technician**, tallying replacements on site during the cleaning visit.
2. **Sales / VAs**, quoting repair costs over the phone before a customer books.

Use 2 is why the numbers below need to be answerable in a few seconds while
someone is on the line.

## Picket replacement — per picket

| Material | Height | Price |
|---|---|---|
| Pressure-treated pine | 6 ft | $12 |
| Pressure-treated pine | 8 ft | $14 |
| Cedar | 6 ft | $15 |
| Cedar | 8 ft | $17 |

### Quick math for the phone

| Pickets | PT pine 6ft | PT pine 8ft | Cedar 6ft | Cedar 8ft |
|---|---|---|---|---|
| 1 | $12 | $14 | $15 | $17 |
| 2 | $24 | $28 | $30 | $34 |
| 3 | $36 | $42 | $45 | $51 |
| 4 | $48 | $56 | $60 | $68 |
| 5 | $60 | $70 | $75 | $85 |
| 10 | $120 | $140 | $150 | $170 |
| 15 | $180 | $210 | $225 | $255 |
| 20 | $240 | $280 | $300 | $340 |

## Other component replacement

| Component | Price | Unit |
|---|---|---|
| 2×4 rail | $75 | **per 5-foot section** — confirmed 2026-09-29 |
| Rot board | $50 | section length to be confirmed |
| Cap | $85 | section length to be confirmed |

**Still open:** rot board and cap have a price but no section length, so
neither can be quoted on the phone or added up on site. $50 for a rot board
reads very differently as per-board, per-8-ft or per-linear-foot — on a
typical fence those differ by roughly 10×.

### 2×4 rail — quick math

$75 per 5-foot section = **$15 per foot**. Round part-sections up.

| Run | Sections | Price |
|---|---|---|
| 5 ft | 1 | $75 |
| 10 ft | 2 | $150 |
| 15 ft | 3 | $225 |
| 20 ft | 4 | $300 |
| 40 ft | 8 | $600 |

## 4×4 post replacement — per post

Priced by the existing fence configuration, because what has to be dismantled
and rebuilt around the post is what drives the labour.

| Configuration | Price |
|---|---|
| No rot board, no cap | $225 |
| Rot board, no cap | $255 |
| Rot board and cap | $350 |

## Repair assessment

During the fence-cleaning visit the technician:

1. Identifies damaged pickets
2. Marks them with red spray paint
3. Tallies the replacements needed

### This is not the only way to quote a repair

Alan, 2026-09-29: *"this does not mean that we can't give the customer these
prices beforehand or confirm these things before coming."*

That matters. Customers ask about repair cost **before** they book, and today
the answer is effectively "we'll see when we get there" — which asks someone
to commit to an unknown number on top of a known one. Derek Danielson asked
exactly this and did not book.

So the marking-and-tallying visit is the way the **final** count is agreed, not
a gate on giving a price range up front.

## Where this touches customers today

Repairs surface constantly in real threads and calls:

- *"How much does the cost increase if some boards need me to repaired or replaced?"* — Derek Danielson, never booked
- *"Deal breaker ... unless I buy the pickets from my source."* — Carl Robert Hiller
- *"I believe it's 4 planks"* — Nicole Rose
- *"Customer's concern was fence repair (loose pickets, gaps), not staining — misaligned service"* — Farida, call analysis
- *"yes sir we are doing the repairs on the rot board and picket right now"* — to Patrick Murphy

The follow-up templates already promise repairs in words —
`services/followup_engine.py:1160`: *"We swap broken pickets and posts if
needed"* — with no prices behind the promise anywhere in the system.
