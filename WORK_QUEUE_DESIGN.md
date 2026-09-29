# Work Queue — grouping customers by what they need next

Design agreed with Alan, 2026-09-29. Not built yet.

## What this is

Not a dashboard and not a morning report. It is a way of grouping every open
customer by **the single next thing needed to move them forward**, so a VA can
pick a lane and work it without deciding anything first.

A separate page. The Hit List stays as it is.

## Why the existing lists don't do this

The Hit List buckets by **GHL pipeline stage** — which is only ever as accurate
as whoever last dragged the card. That is exactly how a lead slips: nobody
moved it, so nobody sees it.

Every lane here derives from **what actually happened** — a message that
arrived, an estimate that sent, an AI read of the thread — or from an explicit
human flag. Never from a card position.

## The lanes

Named for the action, in priority order. Counts are open leads as of
2026-09-29 (not archived, not opted out, no deposit paid).

| # | Lane | Who is in it | Now | Source |
|---|---|---|---|---|
| 1 | **Needs an answer** | They texted, nobody replied | 389 | fact (`awaiting_reply`) |
| 2 | **Needs a scope corrected** | They said the scope is wrong | 88 | AI (`scope_unclear`) + 7 form requests |
| 3 | **Needs a fence video** | We can't see their fence line | ? | **human flag — does not exist yet** |
| 4 | **Needs a scope sent** | No scope has gone out | 202 | fact |
| 5 | **Needs an estimate** | Scope sent, no price yet | 7 | fact |
| 6 | **Still looking, gone quiet** | Opened the proposal 10×+, never replied | 197 | fact |
| 7 | **Needs a rebuttal handled** | They objected, we answered, still open | 439 | AI (`blocker`) |
| 8 | **Needs a follow-up** | Estimate sent, silence, low interest | 291 | fact |

**Five of the eight are pure facts** (1, 4, 5, 6, 8) — no model, no cost, never
wrong. AI is needed only for lanes 2 and 7, and for ranking. So facts decide
*where someone sits*; AI decides *who is first*. Most of the board therefore
works even while the reader is down.

Lane 6 exists because of the proposal-opens evidence below. Someone who opened
their proposal ten or more times and never said a word is showing it to
somebody. They close at **21.3%**, against 5.0% baseline. Chasing them is a
different job — different script, different urgency — from lane 8, where almost
nobody buys. It is cleanly exclusive of lanes 1 and 7 by definition, since both
of those require the customer to have spoken.

Lane 7 splits by what they actually said:

```
timing 173 · price 166 · waiting_on_us 164 · scope_unclear 88
competitor 78 · spouse_or_partner 71
```

## One customer, one lane

**Agreed: a customer appears exactly once**, in the lane for the most urgent
thing. The order above is the precedence — highest number wins ties going up.

Why it matters:

- Clearing a lane actually clears it. The count means something.
- Two VAs never work the same person on the same morning.
- Lane totals add up to the open lead count, so nothing is invisible.

Note the interaction: **lane 1 absorbs most of lane 7.** If a customer raised
an objection and we never replied, the action is *answer them*, not *handle the
rebuttal*. Lane 7 is therefore "they objected, we did reply, and it is still
unresolved" — the persuasion lane, not the inbox.

## Precedence, and why this order

1. **Needs an answer** — they raised their hand and got silence. Actively
   damaging, and the cheapest thing in the business to fix.
2. **Needs a scope corrected** — they told us we got their property wrong.
   Since 2026-09-28 this is seconds of work ("Correct & resend" reuses the
   drone render), so there is no reason for it to sit.
3. **Needs a fence video** — completely blocked; we cannot quote at all.
4. **Needs a scope sent** — the thing that starts the conversation.
5. **Needs an estimate** — scope is out, they are waiting on a price.
6. **Still looking, gone quiet** — highest close rate of any silent group
   (21.3%). They are deciding right now.
7. **Needs a rebuttal handled** — engaged, objecting. Warm.
8. **Needs a follow-up** — estimate out, little interest shown. Coldest,
   biggest, and the lane where almost nobody buys.

## Lane 3 — just ask for the video

**Corrected 2026-09-29 by Alan.** No capture link. The video-estimate tool
stays hidden and should not be revived: the link itself was the friction, not
the lack of a trigger. Customers would not do the guided-capture flow because
it was extra work. A customer who is serious will just film their fence and
text it back.

So lane 3 is a plain ask — "could you send us a quick video of your fence?" —
and the lead sits there until the video arrives.

Two things follow.

### It needs a human flag to enter

Nothing in the data separates "I looked and could not see their fence" from
"nobody has got to it yet." Both look like an empty scope. So the scope editor
needs a **"Can't see the fence line"** button that files the lead into lane 3
and offers the text.

### We currently cannot tell when the video arrives

Verified against the live GHL API on 2026-09-29. Every message comes back with
an `attachments` array:

```json
{ "direction": "inbound", "body": "Have you arrived", "attachments": [], ... }
```

`services/poller.py:803` stores `body` and discards everything else, so:

- 0 stored messages carry any media reference
- the only empty-body inbound rows are `TYPE_CALL`, never MMS
- exactly one customer ever *mentioned* sending video — Carrie Lai, 3 Sep, and
  she sent it to Gmail

**The system is blind to every photo and video a customer has ever sent.** That
is bigger than lane 3: customers send fence photos, damage close-ups and stain
colours they like, and none of it is stored, shown, or read by the AI — which
sees an empty message where a photo was.

Fix is small: add `attachments_json` to `Message`, store `m.get("attachments")`
in the poller. Then lane 3 clears itself when the video lands, and every other
lane gets the media it has been missing.

Until that exists, a VA marks the video received by hand.

## BLOCKER: the AI reader stopped on 18 September

Lanes 2 and 7 read from `thread_intents`. That table's last row is
**2026-09-18T01:32**, and `call_intents` stopped at 01:30 the same night.

What has been ruled out:

- **Not a code change.** No commit touched `call_intent.py`, `thread_intent.py`,
  `thread_drain.py`, `config.py` or `main.py` between 10 and 22 September.
- **Not a lack of input.** Messages are still arriving — 209 on 28 Sep, 33 so
  far on 29 Sep. The drain should have daily work.
- **Not disabled in code.** `enable_thread_intent_drain` defaults to `True`.

Both readers call `claude-sonnet-4-6` through the Anthropic API and both died
within two minutes of each other, which points at a shared external
dependency — an expired or exhausted API key, or a retired model ID.

**The answer is one line in the Railway logs.** The drain logs the real
exception class and message on purpose:

```
call_intent: Claude call failed: {ExceptionType}: {message}
```

Search Railway for `Claude call failed`.

Worth fixing regardless of cause: the drain status (`_status` in
`services/thread_drain.py`) is in-memory only and exposed nowhere, so this ran
dead for eleven days without anything saying so. It needs a visible
last-run/last-error, the same way the scheduled-send failures now alert.

## Ranking inside a lane — measured, not assumed

Alan currently calls leads by scrolling his GHL contact list in order, so the
best lead in the business gets the same attention as the worst. Ranking is
therefore the highest-leverage part of this, and it should be built on signals
that actually predict a sale.

Measured over 1,236 leads who were sent an estimate since 2026-05-01.
"Won" = deposit paid **or** any paid QuickBooks invoice linked to the lead.
Baseline close rate **5.0%**.

### Proposal opens — the strongest behavioural signal

| Times opened | n | Won |
|---|---|---|
| Never | 108 | **0.0%** |
| Once | 142 | **0.0%** |
| 2–4× | 453 | 0.7% |
| 5–9× | 336 | 5.1% |
| **10×+** | 197 | **21.3%** |

250 leads opened once or never and **not one bought**. 42 of the 62 wins came
from the 10×+ group. Someone opening a proposal ten times is showing it to
their spouse.

### Job size predicts nothing

| Signature price | n | Won |
|---|---|---|
| under $800 | 59 | 5.1% |
| $800–1,499 | 685 | 5.3% |
| $1,500–2,499 | 391 | 5.1% |
| $2,500+ | 69 | 4.3% |

Flat across the range. **The existing call list's "Priority tier for $1500+"
is sorting on a signal with no predictive power** (`backend/api/call_list.py`).
Job size belongs in the ranking as *value*, never as *likelihood* — rank on
probability, then break ties on size.

### The AI read is the best predictor

| Temperature | n | Won | | Blocker | n | Won |
|---|---|---|---|---|---|---|
| hot | 50 | **44.0%** | | none | 52 | 32.7% |
| warm | 359 | 4.7% | | **waiting_on_us** | 91 | **20.9%** |
| cold | 266 | 1.5% | | scope_unclear | 49 | 10.2% |
| | | | | spouse_or_partner | 30 | 6.7% |
| | | | | competitor | 41 | 4.9% |
| | | | | timing | 89 | 1.1% |
| | | | | **price** | 83 | **0.0%** |

**Caveat:** temperature and blocker are read from the thread *after* the
customer engaged, so they partly reflect what already happened rather than
causing it. Proposal views do not have that problem — pure customer behaviour,
nearly as strong. Treat these as predictive, not causal.

### Two findings that are not about ranking

1. **"Waiting on us" converts at 4× baseline** — 91 leads, 19 wins. The AI read
   these threads as the customer waiting on *us*. They are among the likeliest
   buyers in the database and we are dropping them.
2. **Price objections convert at 0.0%** — 83 leads, zero wins. Not low: none.
   Whatever is currently said to a price objection does not work. That is a
   content problem and needs its own work, not a better queue position.

### Proposed rank, inside each lane

1. AI temperature — hot first
2. AI blocker — `none` and `waiting_on_us` above everything else
3. Proposal opens — 10×+, then 5–9×
4. Days since we last touched them — older first, so nothing rots
5. Job size — **tiebreak only**, for expected value

## Build order

1. Diagnose and restart the AI reader — everything else reads from it.
2. Lanes 1, 4, 5, 6, 8 — pure facts, work today with no AI.
3. Lanes 2 and 7 — once the reader is back.
4. Lane 3 — the "can't see the fence line" flag plus the ask-for-video text.
5. Capture `attachments` in the poller, so lane 3 clears itself.
