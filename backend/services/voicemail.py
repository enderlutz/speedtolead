"""Telling a voicemail apart from a conversation.

A recording is not proof that anyone spoke to us. When a call rings out to
voicemail and the rep leaves a message, the carrier still reports the call
"completed" and GHL still hands us audio — of the greeting plus the rep
talking to a machine. The call poller keeps it (correctly: a rep's voicemail
is worth transcribing), but counting it as a conversation overstates how much
contact we have actually had.

Measured across all 3,098 transcripts on 2026-10-04: **1,200 of them (39%)
are voicemails**, with the carrier greeting inside the first 120 characters
in 1,033 cases. So "calls that connected" was overstating real conversations
by more than a third.

Duration cannot separate them — voicemails run a 33s median against 51s for
real calls, far too much overlap. The transcript can, because the greeting is
boilerplate read by a machine.

The patterns deliberately look only at how the audio *opens*. A real
conversation can mention voicemail ("I left you a voicemail earlier") and
must not be misfiled, whereas a recording that begins with a carrier greeting
is a voicemail no matter what follows.
"""
from __future__ import annotations

import re

# How much of the opening to inspect. The greeting always leads the audio;
# 400 characters covers a long personal outgoing message plus the beep
# without reaching into whatever the rep then said.
OPENING_CHARS = 400

# Kept as one source of truth: the SQL backfill in database.py compiles the
# same alternation, so a pattern added here is applied to history too.
VOICEMAIL_PHRASES = (
    # Only wordings a machine says, and which imply we are being recorded.
    # Anything a human might plausibly say is left out on purpose: hiding a
    # real conversation is the expensive direction to be wrong in, while
    # missing a voicemail only undercounts a number nobody had before.
    #
    # Rejected after testing against production transcripts:
    #   "sorry we missed your call"   — a rep opened a 14-minute live call
    #                                   with it (Gail Norris)
    #   "the person you're trying to  — Google's call screening says this and
    #    reach"                         then connects; one such call ran 25
    #                                   minutes
    #   "is not available"            — "John is not available Tuesday"
    # Deliberately NOT "forwarded to voice mail" on its own. The carrier
    # stops the greeting the instant somebody picks up, so a *truncated*
    # greeting is a pickup, not a voicemail — "Call has been forwarded to
    # voice mail. The person you're trying to reach is not a Hello? Hi. Is
    # this miss Malone?" was a seven-minute conversation. Every phrase below
    # comes from the end of the greeting, after which a human cannot appear.
    r"please record your message",
    r"record your message at the tone",
    r"at the tone",
    r"after the tone",
    r"(?:please|kindly) leave (?:a|your) (?:brief )?message",
    r"you (?:may|can) leave (?:a|your) message",
    r"space to leave a message",
    r"please leave your name and number",
    r"mailbox is full",
    r"you may hang ?up",
    r"when you have finished recording",
    r"can'?t take your call",
    r"cannot take your call",
    r"unable to take your call",
    r"not available to take your call",
)

VOICEMAIL_RE = re.compile("|".join(VOICEMAIL_PHRASES), re.IGNORECASE)

# Postgres POSIX alternation for the one-shot backfill. Python's (?:...) and
# (?i) are not POSIX, so the inline flags are dropped and the caller uses the
# case-insensitive operator instead.
SQL_VOICEMAIL_PATTERN = "|".join(p.replace("(?:", "(") for p in VOICEMAIL_PHRASES)


def looks_like_voicemail(full_text: str | None) -> bool:
    """True when the recording opens with a voicemail greeting.

    Only the opening is examined — see the module docstring for why a later
    mention of voicemail must not count.
    """
    if not full_text:
        return False
    return bool(VOICEMAIL_RE.search(full_text[:OPENING_CHARS]))
