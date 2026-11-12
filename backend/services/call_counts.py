"""How many calls each person made this week and today (Alan, 2026-11-11).

The On call page shows one small table: Alan, Gioconda, Olga — This week,
Today. A call only counts when the caller's NAME reached the customer:

  * the customer answered and she introduced herself,
  * an AI call screener asked who's calling and played her name, or
  * she left a voicemail.

It does NOT count when she could have left a voicemail and didn't, the
mailbox was full, it rang out, it was a wrong number, or they hung up before
her name. All of those leave either no recording or a transcript with no
"<name> with Sterling" in it, so the transcript is the judge.

Double dials (same person, same customer, each call within 10 minutes of the
last one) are ONE call: it counts if any dial in the chain counts.

Calls still waiting on a transcript can't be judged yet, so they are reported
separately as "waiting" instead of guessed.

Stella and David can reuse `count_calls()` / `name_reached()` directly.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta

from clock import CENTRAL, day_bounds_utc, now_utc, parse_iso

# Who shows up, in this order. (label, dashboard usernames, names she goes by
# on the phone — including the ways the transcriber garbles them). The
# recording's `recorded_by` is a GHL user id, matched through users.ghl_user_id.
PEOPLE: tuple[tuple[str, tuple[str, ...], tuple[str, ...]], ...] = (
    ("Alan", ("alanbonner", "alan"), ("alan", "allen", "allan")),
    ("Gioconda", ("gioconda", "geoconda"), ("lily", "lilly", "lili", "lolly", "gioconda", "geoconda")),
    ("Olga", ("olga",), ("amy", "olga")),
)

DOUBLE_DIAL_GAP = timedelta(minutes=10)

# Words that can sit where a name would ("I'm calling from Sterling", "this is
# just a quick call from Sterling") — none of them put a name in anyone's ear.
_NOT_A_NAME = {
    "calling", "call", "called", "just", "with", "from", "over", "reaching",
    "following", "the", "a", "an", "your", "you", "sterling", "sorry", "not",
    "so", "here", "good", "doing", "glad", "looking", "returning", "trying",
    "getting", "back", "about", "regarding", "someone", "somebody", "me",
    "it", "is", "this", "that", "who", "what", "on", "at", "in", "for",
    "and", "um", "uh", "hi", "hey", "hello", "quote", "estimate", "message",
    "voicemail", "guy", "lady", "company", "people", "folks", "team", "out",
    "up", "to", "of", "by", "i", "i'm", "im", "we're", "it's", "we", "they", "he", "she", "him", "her",
    "us", "them", "my", "our", "their", "great", "fine", "well", "okay", "ok",
}

_WORD = r"[a-z][a-z'\-]*"

# "this is Lolly with Sterling", "my name is Amy, I'm calling from Sterling
# Fence", "hi it's Alan over at Sterling". Stays inside one sentence and
# within ~50 characters, so a customer's own greeting ("Hey, this is Vidalis,
# I'm sorry I can't answer...") never borrows a "Sterling" from later on.
_INTRO = re.compile(
    r"\b(?:this\s+is|my\s+name\s+is|my\s+name's|it'?s|it\s+is|i'?m|i\s+am)\s+(" + _WORD + r")"
    r"[^.?!]{0,50}?\bsterling\b"
)

# A screener answer or a quick intro: "Lolly from Sterling Fence." at the
# start of a sentence (optionally after hi/hey/hello).
_NAME_FROM = re.compile(
    r"(?:^|[.?!,]\s*|\b(?:hi|hey|hello|yes|yeah)\s*,?\s+)(" + _WORD + r")\s+"
    r"(?:with|from|calling\s+from|over\s+at|at)\s+sterling\b"
)


def _sentences(text: str) -> list[str]:
    return [s for s in re.split(r"[.?!\n]+", text) if s.strip()]


def name_reached(text: str, aliases: tuple[str, ...] | list[str] = ()) -> bool:
    """True when the transcript shows the caller's name reaching the customer:
    a "<name> with/from Sterling" introduction, or one of her own names in a
    sentence that also says Sterling. Carrier messages and the customer's own
    greeting never carry "Sterling", so on their own they never count."""
    t = (text or "").lower()
    if "sterling" not in t:
        return False
    for m in _INTRO.finditer(t):
        if m.group(1) not in _NOT_A_NAME:
            return True
    for m in _NAME_FROM.finditer(t):
        if m.group(1) not in _NOT_A_NAME:
            return True
    names = [a.lower() for a in aliases if a]
    if names:
        pat = re.compile(r"\b(?:" + "|".join(re.escape(n) for n in names) + r")\b")
        for s in _sentences(t):
            if "sterling" in s and pat.search(s):
                return True
        # "This is Amy. I'm calling you from Sterling Fence Staining." The
        # name and the company often sit in back-to-back sentences, so her
        # own name within ~120 characters before (or 40 after) any
        # "Sterling" counts too (real calls, 2026-11-11: 10 of Olga's 25).
        for m in re.finditer(r"\bsterling", t):
            if pat.search(t[max(0, m.start() - 120): m.end() + 40]):
                return True
    return False


@dataclass
class Dial:
    """One outbound recording, reduced to what counting needs."""
    at: datetime                  # aware UTC
    chain: str                    # lead id, else GHL contact id, else the recording id
    transcript: str | None        # None = not transcribed yet
    failed: bool = False          # transcription gave up; nothing to wait for


def group_dials(dials: list[Dial]) -> list[list[Dial]]:
    """Same customer, each dial within 10 minutes of the previous one = one
    group. Input is one person's dials."""
    groups: list[list[Dial]] = []
    last: dict[str, list[Dial]] = {}
    for d in sorted(dials, key=lambda d: d.at):
        g = last.get(d.chain)
        if g is not None and d.at - g[-1].at <= DOUBLE_DIAL_GAP:
            g.append(d)
        else:
            g = [d]
            groups.append(g)
            last[d.chain] = g
    return groups


def judge_group(group: list[Dial], aliases=()) -> str:
    """'counted' if any dial's transcript shows her name reached them,
    'waiting' if not but a dial is still waiting on its transcript, else 'no'."""
    if any(d.transcript is not None and name_reached(d.transcript, aliases) for d in group):
        return "counted"
    if any(d.transcript is None and not d.failed for d in group):
        return "waiting"
    return "no"


def week_bounds(now: datetime | None = None) -> tuple[datetime, datetime]:
    """(Monday 00:00, today 00:00) in Houston, as aware UTC datetimes. On a
    Monday both are the same midnight."""
    now = (now or now_utc()).astimezone(CENTRAL)
    today = now.date()
    monday = today - timedelta(days=today.weekday())
    return parse_iso(day_bounds_utc(monday)[0]), parse_iso(day_bounds_utc(today)[0])


def tally(dials: list[Dial], week_start: datetime, today_start: datetime, aliases=()) -> dict:
    """Counts for one person. A group lands in the window its first dial is in."""
    out = {"today": 0, "week": 0, "waiting_today": 0, "waiting_week": 0}
    for g in group_dials([d for d in dials if d.at >= week_start]):
        verdict = judge_group(g, aliases)
        if verdict == "no":
            continue
        key = "" if verdict == "counted" else "waiting_"
        out[key + "week"] += 1
        if g[0].at >= today_start:
            out[key + "today"] += 1
    return out


def count_calls(db, now: datetime | None = None) -> dict:
    """{"week_start", "today_start", "people": [{name, today, week, waiting_today, waiting_week}]}"""
    from database import CallRecording, CallTranscript, User
    from sqlalchemy import func

    week_start, today_start = week_bounds(now)

    # Who's who: recorded_by holds a GHL user id (or, for in-browser uploads,
    # a username / display name).
    users = db.query(User).all()
    owner: dict[str, int] = {}
    for i, (_label, usernames, _aliases) in enumerate(PEOPLE):
        for u in users:
            if (u.username or "").lower() in usernames:
                for key in (u.ghl_user_id, u.username, u.display_name):
                    if key:
                        owner[key.strip().lower()] = i
        for un in usernames:
            owner.setdefault(un, i)

    # Only this week's outbound calls. The string prefix is a day early so
    # every stored timestamp shape ("Z", "+00:00", none) is caught; the exact
    # cut happens below on the parsed time.
    floor = (week_start - timedelta(days=1)).date().isoformat()
    rows = (
        db.query(CallRecording.id, CallRecording.lead_id, CallRecording.ghl_contact_id,
                 CallRecording.recorded_by, CallRecording.created_at, CallRecording.status)
        .filter(CallRecording.created_at >= floor)
        .filter(func.lower(CallRecording.call_direction) == "outbound")
        .filter((CallRecording.is_archived.is_(None)) | (CallRecording.is_archived == False))  # noqa: E712
        .all()
    )
    mine = [r for r in rows if (r.recorded_by or "").strip().lower() in owner]
    texts: dict[str, str] = {}
    ids = [r.id for r in mine]
    for i in range(0, len(ids), 500):
        for rid, full in (db.query(CallTranscript.recording_id, CallTranscript.full_text)
                          .filter(CallTranscript.recording_id.in_(ids[i:i + 500])).all()):
            texts[rid] = (texts[rid] + "\n" + (full or "")) if rid in texts else (full or "")

    per: dict[int, list[Dial]] = {i: [] for i in range(len(PEOPLE))}
    for r in mine:
        at = parse_iso(r.created_at)
        if at is None or at < week_start:
            continue
        per[owner[r.recorded_by.strip().lower()]].append(Dial(
            at=at, chain=r.lead_id or r.ghl_contact_id or r.id,
            transcript=texts.get(r.id), failed=(r.status == "failed")))

    people = []
    for i, (label, _usernames, aliases) in enumerate(PEOPLE):
        people.append({"name": label, **tally(per[i], week_start, today_start, aliases)})
    return {"week_start": week_start.isoformat(), "today_start": today_start.isoformat(),
            "people": people}
