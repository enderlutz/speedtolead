"""The call-back day read off a call (Alan, 2026-10-26, Chemaria Green: she
said she'd call by the end of the week, Alan said he'd reach out next Sunday,
and the list showed her as due the next day)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from datetime import date  # noqa: E402

from services.callback_promise import find_promise  # noqa: E402

SUNDAY_CALL = "2026-10-25T21:41:08Z"  # Sun Oct 25, 4:41 PM Houston


def test_calling_someone_else_is_no_promise_and_the_last_agreement_wins():
    text = ("Let me, I'll call them tomorrow, and then I'll call y'all back this week. ... "
            "But I'll call you back by the end of the week for sure. ... "
            "If I don't hear anything back, I'll put a reminder, and I'll reach back out to you, "
            "I'd say, next Sunday around Sunday. That's cool.")
    p = find_promise(text, SUNDAY_CALL)
    assert p["day"] == date(2026, 11, 1) and p["they_call"] is False


def test_end_of_the_week_is_that_friday():
    p = find_promise("Okay, I'll call you back by the end of the week.", "2026-10-26T15:00:00Z")
    assert p["day"] == date(2026, 10, 30) and p["they_call"] is True


def test_call_me_monday_still_works():
    p = find_promise("Let me think about it. Call me Monday. Okay perfect.", "2026-10-24T14:29:00Z")
    assert p["day"] == date(2026, 10, 26) and p["they_call"] is False


def test_only_them_tomorrow_finds_nothing():
    assert find_promise("I'll call them tomorrow about the pool.", SUNDAY_CALL) is None
