"""A phone's AI call screener that ends in voicemail is not a conversation
(Alan, 2026-11-04: "we never got to talk to him")."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.voicemail import listener_heard_nobody, looks_like_voicemail  # noqa: E402

SCREENER = ("Hi. Hi. I'm an AI assistant recording this call for the person you're trying to reach. "
            "Please say who you are and why you're calling. Hey. Hey, AI assistant. This is Alan with "
            "Sterling Fence Staining. I was just calling to get a hold of the customer, because they had "
            "requested to get an estimate for getting their fence stained. Thank you. Please hold while I "
            "connect you. The person you're calling is busy now. I'll let them know you called. If you "
            "would like to add a message, start talking after the tone. You can hang up when you're finished. "
            "Hey, this is Alan with Sterling Fence Staining, give me a callback.")


def test_screener_then_voicemail_is_a_voicemail():
    assert looks_like_voicemail(SCREENER)


def test_screener_that_connects_is_a_conversation():
    live = ("Hi. I'm an AI assistant recording this call for the person you're trying to reach. Please say "
            "who you are and why you're calling. Amy with Sterling Fence Staining. Please hold while I connect "
            "you. Hello? Hi, this is Amy, you asked about getting your fence stained? Yes, just the inside. "
            + "Okay, perfect, and how old is the fence? About three years. " * 20)
    assert not looks_like_voicemail(live)


def test_listener_skip_only_counts_when_nobody_was_there():
    assert listener_heard_nobody({"skip": True, "why": "The call was answered by an automated Google call screener."})
    assert listener_heard_nobody({"skip": True, "why": "The call went to voicemail."})
    assert not listener_heard_nobody({"skip": True, "why": "A call with Home Depot about supplies, not a sales call."})
    assert not listener_heard_nobody({"customer_mood": "interested"})
