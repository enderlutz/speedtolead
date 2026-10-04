"""A recording is not proof anybody spoke to us.

Background: when a call rings out to voicemail and the rep leaves a message,
the carrier reports it "completed" and GHL hands us audio — of the greeting
plus the rep talking to a machine. The call poller keeps it, correctly, but
counting it as a conversation overstated real contact badly: 1,200 of 3,098
transcripts in production (39%) are voicemails.

Michele Horton is the case that exposed it. Her one "conversation" was a
32-second recording whose transcript opens *"Your call has been forwarded to
voice mail… At the tone, please record your message"* followed by Alan
leaving a message.

What these pin:
  * carrier greetings in their real production wordings are caught
  * a real conversation that merely mentions voicemail is NOT caught — the
    detector looks only at how the audio opens
  * the Postgres pattern used to repair history stays in step with the Python
    one, so the two can never disagree about a given transcript
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from services.voicemail import (  # noqa: E402
    OPENING_CHARS,
    SQL_VOICEMAIL_PATTERN,
    VOICEMAIL_PHRASES,
    looks_like_voicemail,
)

# Verbatim openings from production transcripts.
REAL_VOICEMAILS = [
    "Your call has been forwarded to voice mail. The person you're trying to reach "
    "is not available. At the tone, please record your message. When you have "
    "finished recording, you may hang up. Hi, miss Horton. This is Alan.",
    "Sorry. The mailbox is full, and there is not enough space to leave a message. Goodbye.",
    "Yes. This is Mike Flores. I'm sorry I missed your call. I'll get back with you "
    "as soon as I can. Thanks. At the tone, please record your message.",
    "Telephone number (281) 610-3335 can't take your call now. At the tone, please "
    "record your message. When you've finished recording, you may hang up.",
]

REAL_CONVERSATIONS = [
    "Hello? Hi, is this Michele? Yes it is. Great, I'm calling about the fence staining quote.",
    "Hey Alan, I got your voicemail earlier and wanted to call you back about the fence.",
    "Yeah, so I'd like to leave a message with your office about rescheduling, is that alright?",
    "Hi there. Yes, we're available Thursday. What time works for your crew?",
]


@pytest.mark.parametrize("text", REAL_VOICEMAILS)
def test_production_voicemail_openings_are_caught(text):
    assert looks_like_voicemail(text) is True


@pytest.mark.parametrize("text", REAL_CONVERSATIONS)
def test_real_conversations_are_not_misfiled(text):
    """The expensive mistake would be hiding a genuine conversation."""
    assert looks_like_voicemail(text) is False


@pytest.mark.parametrize("text", ["", None, "   "])
def test_missing_text_is_not_a_voicemail(text):
    """An untranscribed or empty recording is unknown, not a voicemail."""
    assert looks_like_voicemail(text) is False


def test_only_the_opening_is_examined():
    """A long conversation that happens to say "leave a message" near the end
    must not be reclassified by it."""
    tail = " at the tone, please record your message"
    text = ("So the crew will arrive Tuesday morning and we'll start on the back fence. "
            * 20) + tail
    assert len(text) > OPENING_CHARS
    assert looks_like_voicemail(text) is False
    # Same phrase at the front is decisive.
    assert looks_like_voicemail(tail + " " + text) is True


def test_detection_is_case_insensitive():
    assert looks_like_voicemail(
        "YOUR CALL HAS BEEN FORWARDED TO VOICEMAIL. AT THE TONE, PLEASE RECORD YOUR MESSAGE."
    ) is True


# --- the greeting has to be complete ---

TRUNCATED_GREETINGS = [
    # Verbatim. Both ran for minutes as real conversations: the carrier cuts
    # the greeting off the moment somebody picks up, so a greeting that never
    # reaches "at the tone" means a human answered.
    "Call has been forwarded to voice mail. The person you're trying to reach is not a "
    "Hello? Hi. Is this, miss Malone? Yes. It is. Hey, miss Malone. This is Alan.",
    "Your call has been forwarded to voice mail. Hello. How's it going? Hello. Is this "
    "mister Harvey? Yes. I am. Hey. This is Amy again with Sterling Fence.",
]


@pytest.mark.parametrize("text", TRUNCATED_GREETINGS)
def test_a_cut_off_greeting_means_they_picked_up(text):
    """These were 410s and 129s of real conversation. Matching on the opening
    words of the greeting alone filed both as voicemails."""
    assert looks_like_voicemail(text) is False


def test_a_long_monologue_into_the_machine_is_still_a_voicemail():
    """The counterpart: 456 seconds of Alan talking to voicemail. Duration
    cannot be used to separate these — this one is longer than both pickups
    above."""
    text = (
        "Your call has been forwarded to voice mail. The person you're trying to reach "
        "is not available. At the tone, please record your message. When you have "
        "finished recording, you may hang up. Hey, mister Gagnio. This is Alan, with "
        "Sterling Fence Staining. I just went over to look at the property."
    )
    assert looks_like_voicemail(text) is True


def test_sql_pattern_covers_the_same_phrases_as_python():
    """database.py repairs 3,098 historical rows with the SQL pattern. If the
    two drifted, history and new calls would be classified differently."""
    # Can't just count "|" — several phrases contain their own alternation.
    for phrase in VOICEMAIL_PHRASES:
        assert phrase.replace("(?:", "(") in SQL_VOICEMAIL_PATTERN, phrase
    # Python's non-capturing groups and inline flags aren't POSIX.
    assert "(?:" not in SQL_VOICEMAIL_PATTERN
    assert "(?i)" not in SQL_VOICEMAIL_PATTERN


@pytest.mark.parametrize("text", REAL_VOICEMAILS)
def test_sql_pattern_matches_the_same_production_openings(text):
    """Approximates Postgres `~*` with Python's engine on the SQL string, so a
    phrase that only works with Python-specific syntax is caught here."""
    assert re.search(SQL_VOICEMAIL_PATTERN, text[:OPENING_CHARS], re.IGNORECASE)


@pytest.mark.parametrize("text", REAL_CONVERSATIONS)
def test_sql_pattern_also_leaves_conversations_alone(text):
    assert not re.search(SQL_VOICEMAIL_PATTERN, text[:OPENING_CHARS], re.IGNORECASE)
