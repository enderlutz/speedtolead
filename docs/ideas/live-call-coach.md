# Live call coach: our own phone line with AI telling the VA what to say

Alan, 2026-11-07 evening: "move the phone number off GoHighLevel onto our dashboard, so when we're calling a customer, AI gives the VA real-time data on what to say. They're just reading it off."

## What it is
- Calls run on our own number (Twilio, the same path as the crew line in `docs/ideas/on-call.md` and the Twilio crew-line work), recorded, with live transcription.
- While the VA talks, a side panel on the lead page shows the next line to say, built from the customer's file (address, sides, estimate, prior calls, texts, held day) and the first-call SOP order (intro, address, sides, reason, age, process, look, packages, semi vs solid, day, $250).
- The customer's answers update the panel in real time: an objection gets its answer, a named color gets its package check, a day gets the hold-and-$250 ask.
- Stella's review happens live instead of after the call, so a skipped step gets a nudge while it still matters.

## Pieces we already have
- Twilio account + number (crew line), call recording, Deepgram transcription, Gemini call-tone listener, Stella's call review prompt and playbook, the first-call SOP text (`frontend/src/content/call-script.ts`), the customer file builder (`backend/services/callback_reminder.build_file`).

## Pieces missing
1. Browser softphone for the VA (Twilio Voice SDK) or forward-to-cell with the panel on the lead page.
2. Streaming transcription (Deepgram live) wired to a per-call websocket.
3. A "next line" model call every few seconds with the file + transcript so far; output is one line, 15 words max, plus a flag when a step was skipped.
4. Number porting plan: GHL's SMS workflows and the inbound texting path depend on the GHL number, so the voice line moves first (new number, GHL number forwards), SMS stays on GHL until the follow-up engine is safe.

## Order
Voice first on a second number for one VA, Stella in the panel, measure close rate against GHL-dialed calls for two weeks, then decide on porting.

## Open questions for Alan
- Softphone in the browser, or the VA keeps dialing from her phone with the panel open on the laptop?
- Spanish lines for Gioconda?
- Does the customer hear a recording notice (Texas is one-party consent, so optional)?

## Added 2026-11-08 (Alan, after the call with the agency friend): voice, and where this ends up
Parked on purpose. The step-by-step comes first: a process Alan can teach, one overseas closer on it, Stella scoring every call. These are the later stages, written down so they are not lost.

### Stage 2: the VA's voice
- Accent conversion is a real product category, not science fiction: Sanas (agent-side, sold to call centers through Talkdesk and others) and Krisp (agent-side since 2024, listener-side added March 2026) change an accent to neutral American English in real time while keeping the person's own voice. Pricing is quote-based; Krisp has a free trial on its meeting plans.
- Where it helps us: the "is this a scam" objection is partly a clarity problem. Clearer speech on the first call is worth testing on one VA for two weeks against her own close rate.
- Not doing: changing the voice or accent to match a guess about the customer's ethnicity or name. That is discrimination with a paper trail, and it would end the brand faster than any 1-star. The product is one clear voice for everyone.

### Stage 3: the AI agent
- The order is fixed by what is proven: Stella scores calls (now) → Stella coaches live in the panel (this doc) → the AI takes first contact after hours and on weekends when nobody is on call, reading the same script, booking the same two days, asking the same $250 → the AI runs first calls in daytime too, with a person on escalations.
- Each hand-off needs its own 30-day test against the human close rate, same as the closer hire. Nothing moves to the machine on a hunch.
- Rules that come with it: the AI says it is an AI when asked and never claims to be Alan; outbound AI-voice calls need the customer's prior consent under the FCC's 2024 TCPA ruling, so the AI answers and returns form leads, it does not cold-call. Recordings stay the training data for tone, patterns and what closes, which is the point of recording every call today.
- Multilingual: Spanish first (Gioconda's leads), as a line the AI or a bilingual rep takes, chosen by the customer's own language, never by their name.

## Added 2026-11-10: Cluely as the fast path (after the script is mastered)
Alan: once the VAs have mastered the v4 script (Call script tab, "Call script 1 · New leads"), (1) move the phone number off GoHighLevel onto our dashboard, and (2) integrate Cluely (cluely.com) so while the AI listens to the customer it tells the VA what to say. Mainly for closing.
- Cluely runs on the VA's computer, listens to the call audio, and shows answers on screen. It can be loaded with our own material: the v4 script, the objection answers, packages, prices, and the customer's file.
- Fast path: Cluely on the VA's laptop with the calls going through the laptop (softphone), so it hears both sides. No phone-system build needed to test it.
- Long path (above): our own Twilio line + live Deepgram + Stella in a side panel. More control, data stays ours, scores every call.
- Test: one VA, two weeks, close rate vs normal calls. Check Cluely's business plan, what it stores, and that customer data on its servers is OK with Alan.
- Order: master the script first -> number off GHL -> live coach (Cluely test, then decide build vs buy).
