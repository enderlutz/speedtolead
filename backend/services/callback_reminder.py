"""Stella's calls: after every real call, review it and text Alan a call-back reminder.

Alan (2026-11-06): "can you automatically review any calls that happened and
automatically schedule a call back for me to do?" Callbacks are Alan's to
close, so every conversation with a customer who hasn't paid gets read in
full (this call, the calls before it, the texts, the estimate, the held
day), and if a call back is owed, a "📞 CALL NOW ❗❗❗" text is scheduled in
GHL to Alan's phone for the right time: the day agreed on the call if there
was one, never after a held day, always inside Alan's own phone hours.

A VA's call also gets a short review in Alan's call order, sent right away,
so he can coach the same day.

Best effort from end to end. Nothing here ever stops the transcript or the
analysis, and the off switch is system_config callback_reminders_on = "0".
"""
from __future__ import annotations

import json
import logging
import re
import threading
from datetime import datetime, timedelta, timezone

from clock import now_ct, to_ct

logger = logging.getLogger(__name__)

MODEL = "claude-sonnet-5-5"
SWITCH_KEY = "callback_reminders_on"
DONE_KEY = "callback_reminders"  # in lead.form_data: recording ids already handled

# Alan's own phone hours, every day (On call roles): 8-10, 12-2:30, 5-8.
WINDOWS = ((8 * 60, 10 * 60), (12 * 60, 14 * 60 + 30), (17 * 60, 20 * 60))
MIN_SECONDS = 60
# Every live call gets read, however short (Alan, 2026-11-08: a 44-second call
# where the customer said "call me back on Monday" and hung up got no
# reminder). The poller already drops anything under 5 seconds.
REVIEW_MIN_SECONDS = 1
# Every live VA call gets a review, however short (Alan, 2026-11-09: "a call
# under a minute could still be a real call", and he wants to grade those
# too). Stella skips it only when nobody but our side spoke.
VA_REVIEW_SECONDS = 1
# "We've talked to them" (for voicemail follow-ups) counts any live call this long.
TALK_SECONDS = 20
SKIP_STATUSES = {"closed", "archived"}


# Sundays: no customer call-backs before 9 AM or after 5 PM (Alan, 2026-11-08;
# it was 6 PM earlier the same day).
SUNDAY_WINDOWS = ((9 * 60, 10 * 60 + 30), (12 * 60, 14 * 60 + 30), (16 * 60, 17 * 60))
# Older customers go to bed earlier: never a call-back after 6 PM for anyone
# who sounds older (Alan, 2026-11-08, after an older customer's evening call).
OLDER_LAST_MINUTE = 18 * 60


def _windows(day: datetime, older: bool = False):
    base = SUNDAY_WINDOWS if day.weekday() == 6 else WINDOWS
    if not older:
        return base
    return tuple((s, min(e, OLDER_LAST_MINUTE)) for s, e in base if s < OLDER_LAST_MINUTE)


def pick_slot(want: datetime, now: datetime, older: bool = False) -> datetime:
    """The first moment at or after `want` (and at least 20 minutes from now)
    that falls inside one of Alan's phone windows. Both times are Houston."""
    t = max(want, now + timedelta(minutes=20)).replace(second=0, microsecond=0)
    for _ in range(14):
        mins = t.hour * 60 + t.minute
        for start, end in _windows(t, older):
            if mins < start:
                return t.replace(hour=start // 60, minute=start % 60)
            if start <= mins < end:
                return t
        t = (t + timedelta(days=1)).replace(hour=0, minute=0)
    return t


def callable_now(now: datetime, older: bool = False) -> bool:
    """Is right now inside Alan's phone hours for this customer?"""
    mins = now.hour * 60 + now.minute
    return any(s <= mins < e for s, e in _windows(now, older))


# A call that stops mid-sentence is a possible cut-off: 2026-11-07,
# a customer's 5-minute call dropped and Alan called straight back for 12 minutes; Stella
# scheduled from both. A call with no goodbye in its last lines waits
# CUTOFF_WAIT_MINUTES; a live call followed within SUPERSEDE_MINUTES by a
# longer one is never reviewed on its own.
GOODBYE = re.compile(r"\b(bye|goodbye|talk to you|have a (good|great|blessed|nice)|take care|thank you so much|"
                     r"thanks,? (man|alan|a lot)|appreciate it|sounds good,? thank)\b", re.I)
CUTOFF_WAIT_MINUTES = 15
OIL_KEY = "oil_interest"
CLOSE_NOW_MINUTES = 90  # an older "close now" is stale; the scheduled call-back covers it
SUPERSEDE_MINUTES = 20
# Someone who works and is only free in the evenings is never called before 5
# (Alan said "around 5-6 PM Wednesday"; Stella wrote 9 AM).
EVENINGS = re.compile(r"(only|usually|not)\s+(\w+\s+){0,3}(evening|after work|after five|after 5|after six|after 6)|evenings? only|in the evenings?", re.I)


def _parse_ts(ts: str | None):
    try:
        t = datetime.fromisoformat((ts or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def ended_cleanly(transcript: str) -> bool:
    """A goodbye somewhere in the last lines."""
    return bool(GOODBYE.search((transcript or "").strip()[-260:]))


def minutes_since_end(recording, now=None) -> float:
    start = _parse_ts(getattr(recording, "created_at", None))
    if start is None:
        return 10 ** 6
    end = start + timedelta(seconds=int(recording.duration_seconds or 0))
    return ((now or datetime.now(timezone.utc)) - end).total_seconds() / 60


def superseded_by(db, recording):
    """The longer live call to the same lead that started within
    SUPERSEDE_MINUTES after this one, or None."""
    from database import CallRecording
    start = _parse_ts(getattr(recording, "created_at", None))
    if start is None or not recording.lead_id:
        return None
    rows = (db.query(CallRecording).filter(CallRecording.lead_id == recording.lead_id, CallRecording.id != recording.id,
                                           CallRecording.is_voicemail.isnot(True), CallRecording.duration_seconds >= MIN_SECONDS)
            .all())
    for r in rows:
        t = _parse_ts(r.created_at)
        if t and start < t <= start + timedelta(minutes=SUPERSEDE_MINUTES):
            return r
    return None


def evenings_guard(transcript: str, slot: datetime, older: bool = False) -> datetime:
    if EVENINGS.search(transcript or "") and slot.hour < 17:
        # 5 PM can be past the Sunday cut-off; then it's the next day's 5 PM,
        # never a morning slot for someone who's only free evenings.
        t = slot.replace(hour=17, minute=0)
        for _ in range(7):
            got = pick_slot(t, t - timedelta(minutes=20), older)
            if got.hour >= 17:
                return got
            t = got.replace(hour=17, minute=0)
        return t
    return slot


REVIEWS_TO_VA_KEY = "stella_reviews_to_va"


def reviews_go_to(db, username: str) -> bool:
    """Does this VA get Stella's review of her own calls?"""
    from database import SystemConfig
    raw = (SystemConfig.get(db, REVIEWS_TO_VA_KEY, "0") or "0").strip().lower()
    if raw == "1":
        return True
    return (username or "").strip().lower() in {n.strip() for n in raw.split(",") if n.strip() and n.strip() != "0"}


def worth_reviewing(duration: int | None, is_voicemail: bool, lead_status: str | None) -> bool:
    """A real conversation with someone who isn't a finished customer."""
    if is_voicemail or (duration or 0) < REVIEW_MIN_SECONDS:
        return False
    return (lead_status or "") not in SKIP_STATUSES


PROMPT = """You work for Alan, the owner of Sterling Fence Staining in Houston. A phone call with a customer just ended. You get the WHOLE file: this call, earlier calls, the texts, the estimate, any held day. Read all of it before deciding anything.

Short calls count too: a customer who says "call me back Monday" and hangs up in 40 seconds still gets the call-back on the day they named (late morning if they gave no time). A call that is only a voicemail greeting is not a conversation.

Decide whether Alan owes this customer a call back. Callbacks are Alan's to close. A call back is owed when the customer has not paid and the deal is still alive: they want to think, are getting another quote, want to talk to a spouse, asked for a call on a certain day, didn't pick a day, or the call ended without the $250. NOT owed: they said a clear no, it was spam or a sales call, it was a wrong number, or they already paid / booked and paid.

Pick when. Work out "today", "tomorrow", "tonight", "this evening" from the TODAY line in the file and the call's date: on a Monday call, "tomorrow evening" is Tuesday 5 PM, never Monday. If a day or time was agreed on the call, use it. If ALAN names the day he will reach out ("I'll reach back out Wednesday", "I'll call you Monday afternoon"), that day is the call-back, never earlier, even if the customer said "I'll get back to you" first. Days mentioned for cleaning or staining are NOT call-back days. If a day is held for them, call before that day. If they are getting another quote, give them a day or two. Otherwise the next business day. If a time or window was named ("around five, six PM", "after work", "evenings", "in the morning"), use the START of that window (5:00 PM, 8:00 AM). Someone who works and is only free evenings is never scheduled before 5 PM. Give a time of day; it will be moved into Alan's phone hours (8-10 AM, 12-2:30 PM, 5-8 PM) for you.

Write the reminder text Alan will get on his phone. Plain words, short lines, no markdown, exactly these sections:
📞 CALL NOW ❗❗❗

👤 <customer name>

📋 WHAT IT'S ABOUT
<2-4 short lines: who talked to them and when, what they want, what's stopping them. Exact sides if it matters.>

💰 PRICE
<the package and price they were quoted, tax included>

📅 DAY
<held day or what day they want; real dates, never blanks>

🗣️ SAY
1️⃣ "Hi <Mr./Mrs. Lastname, or first name>, it's Alan with Sterling Fence Staining. How are you doing today?" (always this opener; never "calling you back like I said", never mention the promised call or the voicemail)
2️⃣ "<the main point, answering what's stopping them>"
3️⃣ "<the ask: a real day and the $250 to lock it in, rest when we finish>"

⚠️ IF THEY SAY
"<likely objection>" → "<answer>"
(2-3 of these)

📩 VOICEMAIL
"<short voicemail from Alan with a real day and 346-589-7877>"

Keep the whole reminder under 1,000 characters (GHL refuses texts over 1,600 and emojis count double): short lines, at most 2 objections. No phone number and no links anywhere in the reminder: Alan calls from the customer's GHL contact.

Rules for the words: sound like Alan, a friendly local guy. The opener is fixed (Alan, 2026-11-07): "Hi <name>, it's Alan with Sterling Fence Staining. How are you doing today?", then straight to the reason for the call; nothing in SAY or VOICEMAIL points at the missed call, the voicemail or "like I said". Never use "20% off" or a "normal price"; the real deal is the free second coat through Thanksgiving. Never offer a discount without a real reason. Never ask for photos or board counts; repairs are counted on cleaning day (picket $14, rot board $50, cap $85, rail $75). Signature = semi-transparent (lasts 4-5 yrs), Legacy = solid (lasts the LONGEST, 5-8 yrs). Redwood Naturaltone is a Signature color. Price is the same cash or card. "Sir"/"ma'am" must match the customer. Point out anything in the file that doesn't match (sides on the call vs sides on the estimate, color vs package, a held day they said not to hold) inside WHAT IT'S ABOUT, starting with ⚠️.

If CALLER is not Alan, also review the caller's call in Alan's fixed order: intro, address, sides, main reason, fence age ("probably some gray and sprinkler stains"), the whole process (clean day, then stain day; usually one coat, second coat free through Thanksgiving; back-brushed), what look/color, the three packages (Legacy "lasts the longest"), Signature semi vs Legacy solid, a day, the $250. Flag skipped or out-of-order steps, a color that doesn't fit the package, "yes sir" to a woman, the fake 20% off, asking for photos, letting "another bid" go unanswered. Flag a VA who ignores a money question ("is it cheaper with cash?", "can you do better?"): the moment a customer asks for a better price, a discount or a cash price, she must say "I can talk to my project manager and he can give you a call here in a few minutes", end the call and tell Alan right away; never dodge it and never try to close a negotiating customer herself. VA discount limits (Alan, 2026-11-08): Signature only, $50 off a $1,000-$1,500 job, $100 off a $1,500-$2,000 job, nothing under $1,000 or over $2,000, and only to book now with the $250; never any discount on Legacy (Alan alone can take Legacy down as far as the Signature price). Flag anything more. Flag a downsell to a cheaper package after the customer already picked one, and the 1-year warranty brought up while talking about how long the stain lasts. Quote the moment. A short call gets a short review (2-3 lines: what she did with the time she had, e.g. a slow intro, no call-back set when they said "call me later"). Leave "review" empty only when the customer never spoke (rings, a voicemail greeting, an instant hang-up). Keep the review under 900 characters, plain text, starting "🎧 <caller>'s call with <customer>" and ending "— Stella", then ✅ what went well, ❌ misses, and 💬 one calm coaching line for her. The VA may read this review herself, so write it to help her, plainly and kindly.

OLDER (Alan, 2026-11-08): set "older" true when the customer seems to be an older person: they mention retirement, grandkids, their age, a late husband, having trouble with the link or phone, or they talk the way older people do. Older customers are never called after 6 PM. When unsure, false.

CLOSE NOW (Alan, 2026-11-08): set "close_now" true when CALLER is not Alan and the customer was close to buying on this call: they picked a package and heard the price, and they are negotiating or wavering on price (asked if cash is cheaper, asked for a better price, said it's pricey, said they'll get another estimate or think about it) but did not hang up on a firm no. Alan wants these called within minutes, while they're hot. Put the reason in "close_now_why" in one short line with the package and price ("Legacy $3,210, asked if cash is cheaper, getting another estimate"). Otherwise false.

OIL (Alan, 2026-11-09): set "oil" true when the CUSTOMER asked about or asked for an oil-based stain (oil, Ready Seal, Cabot, "penetrates", "soaks in"). Put their own words in "oil_quote". Alan calls these himself to explain it: our photos are all water-based because most Houston fences are pine (pine drinks oil and looks blotchy); on cedar, oil is fine and the same price as Signature.

LEGACY (Alan, 2026-11-08): set "legacy" true when the CUSTOMER showed real interest in Legacy or a solid color (said they want it, leaned to it, asked its price to consider it, or said it's a little too much), and they didn't pay. Not when only our side described it, or they said "not solid". Put their own words in "legacy_quote". When legacy is true and a call back is owed, add this section to the reminder, right after PRICE:
💎 LEGACY OFFER (only you say this)
"Legacy for the Signature price, if we get you on the schedule in the next 2 weeks."
and build SAY 2️⃣ around it. The reason to give: the solid goes on faster for us and lasts longer for them. Never an inventory story, never "20% off". The offer is for a VALSPAR solid only. If they want a Sherwin-Williams solid (WoodScapes, SuperDeck, a custom SW color), lead with the closest Valspar solid match instead; a Sherwin-Williams solid gets a smaller discount that Alan names, never down to the Signature price. If the customer insisted on another brand's solid or an outside color (Behr, Sherwin-Williams, "our own stain"), put that brand in "legacy_own_brand" and leave the LEGACY OFFER section out; write "⚠️ Wants <brand> solid: smaller discount only, you name it" in WHAT IT'S ABOUT instead.

Reply with JSON only:
{"owed": true|false, "why": "<one short line>", "when": "YYYY-MM-DDTHH:MM" (Houston time, or "" if not owed), "reminder": "<the text, or empty>", "review": "<the review, or empty if Alan made the call>", "legacy": true|false, "legacy_quote": "<customer's words, or empty>", "legacy_own_brand": "<brand they insisted on, or empty>", "older": true|false, "close_now": true|false, "close_now_why": "<one line, or empty>", "oil": true|false, "oil_quote": "<customer's words, or empty>"}"""


# ── No answer: Stella books the next try (Alan, 2026-11-08) ──────────────
# Alan called Luis back, got voicemail, and nothing was scheduled: "That needs
# to be Stella's job." When our call to an open deal goes to voicemail, she
# schedules the next try the same way she schedules any call-back. Only for
# customers we've already had a real conversation with, so a new lead's
# missed first call (the VAs' job) never fills Alan's phone. If a call-back
# is already waiting for that customer, she leaves it alone.

VM_MIN_SECONDS = 10

VM_PROMPT = """You work for Alan, the owner of Sterling Fence Staining in Houston. We just called a customer and got their VOICEMAIL. The deal is still open. You get the WHOLE file: this voicemail (what we left), earlier calls, the texts, the estimate, any held day. Read all of it.

Schedule the next try. If the customer gave times that work for them, use them. If they have another quote coming, a held day, or something we promised them by a certain time, call before that. Otherwise the next business day in the morning. Never the same evening unless they said evenings. Give a time of day; it will be moved into Alan's phone hours (8-10 AM, 12-2:30 PM, 5-8 PM) for you.

Write the reminder Alan gets on his phone, in exactly this format (plain words, short lines, no markdown, no phone number in the body except in VOICEMAIL, no links):
📞 CALL NOW ❗❗❗

👤 <customer name>

📋 WHAT IT'S ABOUT
<No answer <day time>, what the voicemail said in one line. Then 1-3 lines: what they want, what's stopping them.>

💰 PRICE
<package and price they have>

📅 DAY
<held day or what day they want>

🗣️ SAY
1️⃣ "Hi <Mr./Mrs. Lastname, or first name>, it's Alan with Sterling Fence Staining. How are you doing today?"
2️⃣ "<the main point>"
3️⃣ "<the ask: a real day and the $250>"

📩 VOICEMAIL
"<short voicemail with a real day and 346-589-7877>"

Keep it under 1,000 characters. Same word rules as always: sound like Alan, never "20% off", never mention the missed call or the voicemail in SAY.

Reply with JSON only:
{"owed": true|false, "why": "<one short line>", "when": "YYYY-MM-DDTHH:MM" (Houston time, or ""), "reminder": "<the text, or empty>"}
"owed" is false only if the file shows the deal is over (paid, said no, hired someone)."""


def had_a_real_talk(db, lead_id: str, before_iso: str) -> bool:
    """We've had at least one live conversation with them before this call."""
    from database import CallRecording
    return db.query(CallRecording.id).filter(
        CallRecording.lead_id == lead_id, CallRecording.is_voicemail.isnot(True),
        CallRecording.duration_seconds >= TALK_SECONDS, CallRecording.created_at < before_iso).first() is not None


def answered_since(db, recording) -> bool:
    """A live call with them after this voicemail (they called back, or we got through)."""
    from database import CallRecording
    return db.query(CallRecording.id).filter(
        CallRecording.lead_id == recording.lead_id, CallRecording.id != recording.id,
        CallRecording.is_voicemail.isnot(True), CallRecording.duration_seconds >= TALK_SECONDS,
        CallRecording.created_at > (recording.created_at or "")).first() is not None


def _clip(s: str, n: int) -> str:
    s = s or ""
    return s if len(s) <= n else s[:n] + " …"


def build_file(db, lead, recording, transcript_text: str, caller: str) -> str:
    """Everything known about this customer, as one block of text."""
    from database import Booking, CallRecording, CallTranscript, Estimate, Message

    fd = {}
    try:
        fd = json.loads(lead.form_data or "{}")
    except Exception:  # noqa: BLE001
        pass
    fd.pop("booking_draft", None)
    fd.pop("invite_from_call", None)
    fd.pop(DONE_KEY, None)
    est = (db.query(Estimate).filter(Estimate.lead_id == lead.id)
           .order_by(Estimate.created_at.desc()).first())
    tiers = {}
    if est is not None:
        try:
            tiers = json.loads(est.tiers or "{}")
        except Exception:  # noqa: BLE001
            tiers = {}
    bk = db.query(Booking).filter(Booking.lead_id == lead.id).first()
    called = to_ct(recording.created_at)
    lines = [
        f"TODAY (Houston): {now_ct():%A %Y-%m-%d %I:%M %p}",
        f"THIS CALL: {called:%A %Y-%m-%d %I:%M %p} · {recording.call_direction} · {recording.duration_seconds}s · CALLER: {caller}",
        f"CUSTOMER: {lead.contact_name} · {lead.contact_phone} · {lead.address} {lead.zip_code or ''}",
        f"LEAD STATUS: {lead.status}",
        f"FORM / NOTES: {_clip(json.dumps(fd), 2500)}",
        f"ESTIMATE PRICES (tax incl.): {tiers}",
    ]
    if bk is not None:
        lines.append(f"BOOKING: day {bk.date} · {bk.tier} · color {bk.color} · total ${(bk.total_cents or 0) / 100:,.2f} "
                     f"· status {bk.status} · paid {'yes' if (bk.sent_by or '') == 'paid' else 'no'}")
    msgs = (db.query(Message).filter(Message.lead_id == lead.id)
            .order_by(Message.created_at.desc()).limit(20).all())
    lines.append("TEXTS (oldest first):")
    for m in reversed(msgs):
        body = (m.body or "").strip()
        if body and body not in ("Opportunity created", "Opportunity updated"):
            lines.append(f"  {m.created_at[:16]} {m.direction}: {_clip(body, 400)}")
    earlier = (db.query(CallRecording.created_at, CallTranscript.full_text)
               .join(CallTranscript, CallTranscript.recording_id == CallRecording.id)
               .filter(CallRecording.lead_id == lead.id, CallRecording.id != recording.id,
                       CallRecording.is_voicemail.isnot(True))
               .order_by(CallRecording.created_at.desc()).limit(3).all())
    for at, text in reversed(earlier):
        lines.append(f"EARLIER CALL {str(at)[:16]}: {_clip(text, 3000)}")
    lines.append(f"THIS CALL'S TRANSCRIPT:\n{_clip(transcript_text, 14000)}")
    return "\n".join(lines)


def _ask(db, file_text: str, prompt: str = PROMPT) -> dict | None:
    """Stella reads the call with everything Alan has taught her."""
    from services.stella import ask
    return ask(db, prompt, file_text, max_tokens=2000)


def _caller_name(db, recorded_by: str) -> str:
    from database import User
    if recorded_by:
        u = db.query(User).filter(User.ghl_user_id == recorded_by).first()
        if u:
            return (u.display_name or u.username or "").strip() or "Unknown"
    return "Unknown"


def _paid(db, lead_id: str) -> bool:
    from database import Booking, PayLink
    if db.query(PayLink.token).filter(PayLink.lead_id == lead_id, PayLink.status == "paid").first():
        return True
    bk = db.query(Booking).filter(Booking.lead_id == lead_id).first()
    return bk is not None and (bk.sent_by or "") == "paid"


VM_REVIEW_KEY = "vm_reviews"  # in lead.form_data: VA voicemails Stella already coached
VM_REVIEW_PROMPT = """You coach a VA at Sterling Fence Staining (Houston). She just left this VOICEMAIL for a customer. Grade only the voicemail she left (ignore the greeting).

A good voicemail, under 40 seconds:
- "Sterling Fence Staining" said slowly and clearly (not "Fence Sailing", "Fence Lending", "Sterling Fencing")
- Mr./Mrs. + the right name
- the reason: their fence staining estimate
- a reason to call back: the second coat of stain free if they book by Monday, November 16
- the number said twice: 346-589-7877
- never asks them to do homework (text which sides, send pictures); only call or text back

The script: "Hi Mr. [Last name], this is [name] with Sterling Fence Staining. I'm calling about your fence staining estimate. Right now we're including a second coat of stain for free if you book by Monday, November 16. Call or text me back at 346-589-7877. Again, 346-589-7877. Thank you!"

If she left no message (only the greeting, a full mailbox, a hang-up), reply {"review": ""}.
Otherwise reply with JSON only: {"review": "<2-4 short lines, plain text, starting '📩 Voicemail for <customer>:' then ✅ what was right and ❌ what was missing, kind and specific, ending '— Stella'>"}"""


def _va_for(db, recording):
    """The VA who made this call, if Alan has turned her reviews on."""
    from database import User
    va = db.query(User).filter(User.ghl_user_id == (recording.recorded_by or "")).first()
    if va is None or (va.role or "") != "va" or va.disabled or not reviews_go_to(db, va.username):
        return None
    return va


def review_va_voicemail(db, lead, recording, transcript_text: str) -> bool:
    """Coach a VA on a voicemail she left (Alan, 2026-11-09: "if it's a
    voicemail, say if we left a good voicemail"). Goes to the VA only, once
    per recording."""
    va = _va_for(db, recording)
    if va is None or (recording.call_direction or "") != "outbound":
        return False
    try:
        fd = json.loads(lead.form_data or "{}")
    except Exception:  # noqa: BLE001
        fd = {}
    seen = fd.get(VM_REVIEW_KEY) if isinstance(fd.get(VM_REVIEW_KEY), list) else []
    if recording.id in seen:
        return False
    out = _ask(db, f"CUSTOMER: {lead.contact_name}\nCALLER: {va.display_name or va.username}\n\n{(transcript_text or '')[:4000]}",
               VM_REVIEW_PROMPT)
    fd[VM_REVIEW_KEY] = (seen + [recording.id])[-30:]
    lead.form_data = json.dumps(fd)
    db.commit()
    review = ((out or {}).get("review") or "").strip()
    if not review:
        return False
    from services.on_call import message_person
    return bool(message_person(db, va, review[:900], force=True))


def _to_alan(message: str, scheduled_at: int | None = None) -> bool:
    """Stella's texts to Alan come from her own line (services.stella.to_alan)."""
    from services.stella import to_alan
    return to_alan(message, scheduled_at=scheduled_at)


# The poller (right after transcribing) and Stella's catch-up can reach the
# same call within seconds of each other; both passed the "already handled"
# check before either saved, so Alan and the VA got two different reviews of
# one call (2026-11-09). One call is worked by one thread at a time.
_IN_FLIGHT: set[str] = set()
_IN_FLIGHT_LOCK = threading.Lock()


def run_for_recording(db, recording, transcript_text: str) -> dict:
    """Review one finished call and schedule Alan's reminder. Returns what it did."""
    rid = recording.id or ""
    with _IN_FLIGHT_LOCK:
        if rid in _IN_FLIGHT:
            return {"skipped": "already being handled"}
        _IN_FLIGHT.add(rid)
    try:
        db.refresh(recording)
        lead_id = recording.lead_id
        if lead_id:
            from database import Lead
            lead = db.query(Lead).filter(Lead.id == lead_id).first()
            if lead is not None:
                db.refresh(lead)
        return _run_for_recording(db, recording, transcript_text)
    finally:
        with _IN_FLIGHT_LOCK:
            _IN_FLIGHT.discard(rid)


def _run_for_recording(db, recording, transcript_text: str) -> dict:
    from config import get_settings
    from database import Lead, SystemConfig
    from services import ghl

    from services.stella import on as stella_on
    if SystemConfig.get(db, SWITCH_KEY, "1") == "0" or not stella_on(db):
        return {"skipped": "switched off"}
    if not recording.lead_id:
        return {"skipped": "no lead"}
    lead = db.query(Lead).filter(Lead.id == recording.lead_id).first()
    if lead is None:
        return {"skipped": "not a live conversation"}
    voicemail = bool(recording.is_voicemail)
    if voicemail:
        if ((recording.call_direction or "") != "outbound" or (recording.duration_seconds or 0) < VM_MIN_SECONDS
                or (lead.status or "") in SKIP_STATUSES):
            return {"skipped": "not our voicemail"}
        coached = review_va_voicemail(db, lead, recording, transcript_text)
        if not had_a_real_talk(db, lead.id, recording.created_at or ""):
            return {"skipped": "voicemail on a lead we never talked to", "vm_review": coached}
    elif not worth_reviewing(recording.duration_seconds, False, lead.status):
        return {"skipped": "not a live conversation"}
    if _paid(db, lead.id):
        return {"skipped": "already paid"}
    fd = {}
    try:
        fd = json.loads(lead.form_data or "{}")
    except Exception:  # noqa: BLE001
        fd = {}
    done = fd.get(DONE_KEY) or []
    if any(d.get("recording_id") == recording.id for d in done):
        return {"skipped": "already handled"}
    if voicemail:
        if answered_since(db, recording):
            return {"skipped": "talked to them after the voicemail"}
        if pending_reminders(lead):
            return {"skipped": "a call-back is already waiting"}
    later = None if voicemail else superseded_by(db, recording)
    if later is not None:
        fd[DONE_KEY] = (done + [{"recording_id": recording.id, "at": datetime.now(timezone.utc).isoformat(), "owed": False,
                                 "why": f"cut off; the call that followed ({later.id[:8]}) is the one reviewed"}])[-20:]
        lead.form_data = json.dumps(fd)
        db.commit()
        return {"skipped": "superseded", "by": later.id}
    if not voicemail and not ended_cleanly(transcript_text) and minutes_since_end(recording) < CUTOFF_WAIT_MINUTES:
        return {"skipped": "possible cut-off, waiting"}
    owner = (get_settings().owner_ghl_contact_id or "").strip()
    if not owner:
        return {"skipped": "no owner contact"}

    caller = _caller_name(db, recording.recorded_by or "")
    out = _ask(db, build_file(db, lead, recording, transcript_text, caller), VM_PROMPT if voicemail else PROMPT)
    if not out:
        return {"skipped": "no model"}

    record = {"recording_id": recording.id, "at": datetime.now(timezone.utc).isoformat(),
              "owed": bool(out.get("owed")), "why": (out.get("why") or "")[:300]}
    if out.get("legacy"):
        # On Alan's Legacy list until they pay (services/legacy_interest.py).
        try:
            from services.legacy_interest import mark as mark_legacy
            mark_legacy(db, lead, recording.id, out.get("legacy_quote") or "", call_at=recording.created_at or "",
                        own_brand=out.get("legacy_own_brand") or "")
            fd = json.loads(lead.form_data or "{}")
            record["legacy"] = True
        except Exception as e:  # noqa: BLE001
            logger.warning("Legacy flag failed for %s: %s", lead.id, e)
    if voicemail:
        record["voicemail"] = True
    older = bool(out.get("older"))
    if older:
        record["older"] = True
    # A customer who was close on a VA's call gets Alan on the phone within
    # minutes, not at the next window (Alan, 2026-11-08: "Alan, call this
    # customer now"). Only while the call is fresh and it's a time he may call.
    if (not voicemail and out.get("close_now") and caller.lower() != "alan"
            and minutes_since_end(recording) <= CLOSE_NOW_MINUTES and callable_now(now_ct(), older)):
        why = (out.get("close_now_why") or out.get("why") or "").strip()
        if _to_alan(f"🔥 CALL THIS CUSTOMER NOW ❗❗❗\n\n👤 {lead.contact_name}\n{why}\n\nThey were close on {caller}'s call. Call before they get the other quote."[:600]):
            record["close_now_sent"] = True
    # A customer asking about oil gets Alan's call to explain it (Alan,
    # 2026-11-09, after a cedar-fence customer asked for oil on a VA call).
    if not voicemail and out.get("oil"):
        record["oil"] = True
        try:
            fd2 = json.loads(lead.form_data or "{}")
            fd2[OIL_KEY] = {"at": datetime.now(timezone.utc).isoformat(), "recording_id": recording.id,
                            "quote": (out.get("oil_quote") or "")[:200], "caller": caller}
            lead.form_data = json.dumps(fd2)
            db.commit()
            fd = fd2
        except Exception as e:  # noqa: BLE001
            logger.warning("Oil flag failed for %s: %s", lead.id, e)
        if caller.lower() != "alan" and callable_now(now_ct(), older):
            quote = (out.get("oil_quote") or "").strip()
            if _to_alan((f"🛢️ OIL QUESTION: {lead.contact_name} asked about oil-based on {caller}'s call"
                                    + (f': "{quote}"' if quote else "") +
                                    "\nCall to explain: pine = water-based; cedar = oil is fine, same price as Signature.")[:600]):
                record["oil_sent"] = True
    review = "" if voicemail or (recording.duration_seconds or 0) < VA_REVIEW_SECONDS else (out.get("review") or "").strip()
    if review and caller.lower() != "alan":
        _to_alan(review[:1100])
        record["review_sent"] = True
        # The VA gets the same review on WhatsApp (Alan, 2026-11-06). WhatsApp
        # only delivers if she messaged the Sterling WhatsApp in the last 24 h.
        try:
            from database import User
            from services.on_call import message_person
            va = db.query(User).filter(User.ghl_user_id == (recording.recorded_by or "")).first()
            # Off until Alan has checked Stella's reviews, so no VA gets a bad
            # tip. system_config stella_reviews_to_va: "1" = every VA, or a
            # list of usernames ("olga"; Alan turned Olga on 2026-11-09).
            if va is not None and (va.role or "") == "va" and not va.disabled and reviews_go_to(db, va.username):
                record["review_to_va"] = bool(message_person(db, va, review[:1100], force=True))
                db.commit()
        except Exception as e:  # noqa: BLE001
            logger.warning("Review to VA failed for %s: %s", recording.id, e)
    if out.get("owed") and (out.get("reminder") or "").strip():
        try:
            want = datetime.strptime(out.get("when") or "", "%Y-%m-%dT%H:%M")
        except ValueError:
            want = now_ct().replace(tzinfo=None) + timedelta(days=1)
        now = now_ct()
        slot = evenings_guard(transcript_text, pick_slot(want.replace(tzinfo=now.tzinfo), now, older), older)
        # The newest call decides the call-back: one reminder per customer
        # (Alan, 2026-11-09: a VA's call set Tue noon, his own call an hour
        # later promised "tomorrow evening", and both stayed scheduled).
        replaced = cancel_pending(db, lead, f"replaced by the newer call {recording.id[:8]}")
        if replaced:
            fd = json.loads(lead.form_data or "{}")
            done = fd.get(DONE_KEY) or []
            record["replaced"] = replaced
        ok = _to_alan(out["reminder"].strip()[:1100], scheduled_at=int(slot.timestamp()))
        record.update({"when": slot.isoformat(), "scheduled": bool(ok),
                       "ghl_message_id": ghl.last_message_id() if ok else ""})
        # Tell Alan right away that it's handled (Alan, 2026-11-06: he
        # couldn't see a reminder that only arrives on the call-back day).
        if ok:
            # "Mon 1/4" read as this Monday when it meant January 2027
            # (Alan, 2026-11-07), so a date outside this year says the year.
            when_txt = (slot.strftime("%a %b %-d, %Y %-I:%M %p") if slot.year != now.year
                        else slot.strftime("%a %-m/%-d %-I:%M %p"))
            _to_alan(f"✅ Stella: {lead.contact_name} call-back set for {when_txt}. {(out.get('why') or '').strip()}"[:600])
            # The VA hears it too, for her own calls (Alan, 2026-11-09:
            # "tell her when the callback is scheduled").
            va = _va_for(db, recording)
            if va is not None:
                try:
                    from services.on_call import message_person
                    record["va_told"] = bool(message_person(
                        db, va, f"📅 Call-back set: {lead.contact_name}, {when_txt}. Alan will call them. — Stella", force=True))
                except Exception as e:  # noqa: BLE001
                    logger.warning("Call-back note to VA failed for %s: %s", recording.id, e)
    fd[DONE_KEY] = (done + [record])[-20:]
    lead.form_data = json.dumps(fd)
    db.commit()
    logger.info("Callback reminder for lead %s: %s", lead.id, record)
    return record


# ── Closed deals get no reminders ─────────────────────────────────────────
# Alan (2026-11-07), after a 📞 reminder fired for a customer who had paid the
# $250 that morning: "if the deal has already been closed or the deposit's
# paid, the callback needs to be taken off." A call-back is owed only while
# the deal is open. The moment the money lands (or the day is confirmed),
# every reminder still waiting in GHL for that lead is cancelled.

CLOSED_STATUSES = {"closed", "archived", "won", "booked"}


def deal_closed(db, lead) -> bool:
    """Paid, confirmed, or marked closed: nothing left to chase."""
    if lead is None:
        return False
    if (lead.status or "") in CLOSED_STATUSES or (lead.deposit_status or "") == "paid":
        return True
    return _paid(db, lead.id)


def pending_reminders(lead) -> list[dict]:
    """Reminders GHL is still holding for this lead (scheduled, in the future,
    not cancelled)."""
    try:
        fd = json.loads(lead.form_data or "{}")
    except Exception:  # noqa: BLE001
        return []
    now = datetime.now(timezone.utc)
    out = []
    for rec in fd.get(DONE_KEY) or []:
        if not rec.get("scheduled") or rec.get("cancelled_at"):
            continue
        try:
            when = datetime.fromisoformat(rec.get("when") or "")
        except ValueError:
            continue
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        if when > now:
            out.append(rec)
    return out


def cancel_pending(db, lead, why: str) -> int:
    """Cancel every reminder still scheduled for this lead. Returns how many
    were marked. A record without GHL's message id (sent before 2026-11-07)
    can't be stopped on GHL's side; it is marked anyway so nothing counts on
    it, and the reason says so."""
    from services import ghl

    pending = pending_reminders(lead)
    if not pending:
        return 0
    fd = json.loads(lead.form_data or "{}")
    stamp = datetime.now(timezone.utc).isoformat()
    ids = {p.get("recording_id") for p in pending}
    for rec in fd.get(DONE_KEY) or []:
        if rec.get("recording_id") not in ids or rec.get("cancelled_at"):
            continue
        mid = (rec.get("ghl_message_id") or "").strip()
        stopped = ghl.cancel_scheduled_message(mid) if mid else False
        rec["cancelled_at"] = stamp
        rec["cancel_why"] = why
        rec["ghl_cancelled"] = bool(stopped)
    lead.form_data = json.dumps(fd)
    db.commit()
    logger.info("Cancelled %d call-back reminder(s) for lead %s: %s", len(pending), lead.id, why)
    return len(pending)


def cancel_for_closed_deals(db, limit: int = 200) -> dict:
    """Safety net for payments that reach us sideways (QuickBooks, offline,
    a status flipped by hand): any lead with a reminder still waiting whose
    deal has since closed gets its reminders cancelled. Cheap enough to run
    on Stella's tick."""
    from database import Lead

    rows = (db.query(Lead).filter(Lead.form_data.like('%"scheduled": true%'))
            .order_by(Lead.updated_at.desc()).limit(limit).all())
    cancelled = 0
    for lead in rows:
        if not pending_reminders(lead):
            continue
        if deal_closed(db, lead):
            cancelled += cancel_pending(db, lead, "deal closed")
    return {"checked": len(rows), "cancelled": cancelled}


def cancel_requested(db, limit: int = 200) -> dict:
    """Reminders marked cancelled in the record but not yet stopped on GHL's
    side: a cancel that failed, or one marked from a laptop whose GHL key
    can't reach GHL (2026-11-07, four wrong reminders). The server's key
    works, so this runs on Stella's tick. Three tries per record."""
    from database import Lead
    from services import ghl

    rows = (db.query(Lead).filter(Lead.form_data.like('%"cancelled_at": "%'))
            .order_by(Lead.updated_at.desc()).limit(limit).all())
    tried = stopped = 0
    for lead in rows:
        try:
            fd = json.loads(lead.form_data or "{}")
        except Exception:  # noqa: BLE001
            continue
        changed = False
        for rec in fd.get(DONE_KEY) or []:
            mid = (rec.get("ghl_message_id") or "").strip()
            tries = int(rec.get("ghl_cancel_tries") or 0)
            if not rec.get("cancelled_at") or not mid or rec.get("ghl_cancelled") or tries >= 3:
                continue
            tried += 1
            ok = bool(ghl.cancel_scheduled_message(mid))
            rec["ghl_cancel_tries"] = tries + 1
            if ok:
                rec["ghl_cancelled"] = True
                stopped += 1
            changed = True
        if changed:
            lead.form_data = json.dumps(fd)
            db.commit()
    return {"tried": tried, "stopped": stopped}
