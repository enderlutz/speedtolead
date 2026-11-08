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
