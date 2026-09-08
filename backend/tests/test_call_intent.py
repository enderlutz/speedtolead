"""Customer-intent extraction — and the guarantee it must not break.

The output decides who Alan rings today. A wrong confident answer is worse than
an empty one: it sends him to call someone who never asked to be called, and he
stops trusting the list. So the tests that matter most here are the ones that
assert something is NOT produced.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

import clock  # noqa: E402
from services import call_intent  # noqa: E402


# ── Callback resolution — the fabrication guard ───────────────────────

def test_no_stated_callback_yields_no_date():
    """An empty callback is the correct answer, not a failure to compute one."""
    assert call_intent.resolve_callback("", "2026-09-02") == ""
    assert call_intent.resolve_callback("   ", "2026-09-02") == ""


@pytest.mark.parametrize("vague", [
    "sometime next week", "soon", "whenever", "later in the year",
    "after the holidays", "give me a shout sometime",
])
def test_a_vague_phrase_schedules_nothing(vague):
    """"Sometime next week" is not a date. Guessing one is the failure mode."""
    assert call_intent.resolve_callback(vague, "2026-09-02") == ""


def test_a_real_phrase_resolves_against_the_day_of_the_call():
    """"Tomorrow" means the day after the CALL, not the day of processing.

    The backlog runs months after these calls happened, so resolving against
    today would put every historical callback in the wrong place.
    """
    assert call_intent.resolve_callback("call me tomorrow", "2026-09-02") == "2026-09-03"
    assert call_intent.resolve_callback("tomorrow", "2026-05-01") == "2026-05-02"


def test_a_weekday_resolves_from_the_call_date():
    # 2026-09-02 is a Wednesday; "Thursday" is the next day.
    got = call_intent.resolve_callback("try me Thursday", "2026-09-02")
    assert got == "2026-09-03"
    assert clock.weekday_label(got) == "Thursday"


def test_the_resolved_day_is_always_a_real_houston_date():
    got = call_intent.resolve_callback("next monday", "2026-09-02")
    assert got and len(got) == 10 and got.count("-") == 2
    assert clock.weekday_label(got) == "Monday"


def test_an_evening_call_does_not_shift_the_callback_a_day():
    """A call logged at 8pm Houston is stored as tomorrow's UTC date.

    Resolving off the raw timestamp would push every evening callback forward.
    """
    ct_day = clock.ct_date_of("2026-09-03T01:00:00+00:00")   # 8pm Sep 2 Houston
    assert ct_day == "2026-09-02"
    assert call_intent.resolve_callback("tomorrow", ct_day) == "2026-09-03"


# ── Value coercion ────────────────────────────────────────────────────

def test_an_unexpected_temperature_falls_back_to_unknown():
    """The model returning something off-menu must not corrupt the ranking."""
    assert call_intent._coerce("scorching", call_intent.TEMPERATURES, "unknown") == "unknown"
    assert call_intent._coerce("HOT", call_intent.TEMPERATURES, "unknown") == "hot"
    assert call_intent._coerce("", call_intent.TEMPERATURES, "unknown") == "unknown"


def test_blockers_are_coerced_to_the_known_set():
    assert call_intent._coerce("Spouse or partner", call_intent.BLOCKERS, "unknown") == "spouse_or_partner"
    assert call_intent._coerce("vibes", call_intent.BLOCKERS, "unknown") == "unknown"


# ── Failure paths never raise ─────────────────────────────────────────

def test_an_empty_transcript_returns_the_empty_shape():
    out = call_intent.extract_intent("")
    assert out["temperature"] == "unknown"
    assert out["callback_at"] == ""
    assert out["commitment"] == ""


def test_a_missing_api_key_degrades_quietly(monkeypatch):
    """One unconfigured environment must not crash a backlog run."""
    class _S:
        anthropic_api_key = ""
    monkeypatch.setattr(call_intent, "get_settings", lambda: _S())
    out = call_intent.extract_intent("Customer: hello there, about my fence.")
    assert out["temperature"] == "unknown"
    assert out["callback_at"] == ""


def test_a_claude_failure_returns_empty_rather_than_raising(monkeypatch):
    class _S:
        anthropic_api_key = "sk-test"
    monkeypatch.setattr(call_intent, "get_settings", lambda: _S())

    import anthropic
    def boom(*a, **k):
        raise RuntimeError("credit balance too low")
    monkeypatch.setattr(anthropic, "Anthropic", boom)

    out = call_intent.extract_intent("Customer: call me Thursday.")
    assert out["temperature"] == "unknown"
    assert out["callback_at"] == ""


def test_unparseable_model_output_returns_empty(monkeypatch):
    _install_fake_claude(monkeypatch, "this is not json at all")
    out = call_intent.extract_intent("Customer: hello.")
    assert out["temperature"] == "unknown"
    assert out["callback_at"] == ""


# ── End to end, with the model faked ──────────────────────────────────

def _install_fake_claude(monkeypatch, payload: str):
    class _S:
        anthropic_api_key = "sk-test"
    monkeypatch.setattr(call_intent, "get_settings", lambda: _S())

    class _Block:
        def __init__(self, text): self.text = text

    class _Resp:
        def __init__(self, text): self.content = [_Block(text)]

    class _Messages:
        def create(self, **kw): return _Resp(payload)

    class _Fake:
        def __init__(self, *a, **k): self.messages = _Messages()

    import anthropic
    monkeypatch.setattr(anthropic, "Anthropic", _Fake)


def test_a_full_extraction_round_trips(monkeypatch):
    _install_fake_claude(monkeypatch, """{
      "wanted": "Both sides of the back fence stained before the party",
      "blocker": "spouse_or_partner",
      "blocker_detail": "Wants to run the price past her husband first.",
      "commitment": "I'll talk to my husband tonight and call you back",
      "callback_phrase": "call me tomorrow",
      "temperature": "hot",
      "one_line": "Ready to go, just needs the husband's yes.",
      "quoted_price_mentioned": true
    }""")
    out = call_intent.extract_intent("...", call_date="2026-09-02")
    assert out["temperature"] == "hot"
    assert out["blocker"] == "spouse_or_partner"
    assert out["commitment"].startswith("I'll talk to my husband")
    assert out["quoted_price_mentioned"] is True
    # The date is computed here from the phrase, never taken from the model.
    assert out["callback_at"] == "2026-09-03"
    assert out["callback_phrase"] == "call me tomorrow"


def test_a_date_the_model_invents_cannot_reach_the_list(monkeypatch):
    """The model returns a PHRASE. If it makes one up that doesn't parse, the
    callback stays empty rather than becoming a real appointment."""
    _install_fake_claude(monkeypatch, """{
      "wanted": "", "blocker": "unknown", "blocker_detail": "",
      "commitment": "", "callback_phrase": "the 47th of Smarch",
      "temperature": "warm", "one_line": "", "quoted_price_mentioned": false
    }""")
    out = call_intent.extract_intent("...", call_date="2026-09-02")
    assert out["callback_at"] == ""
    assert out["temperature"] == "warm"


def test_a_cold_call_produces_no_callback(monkeypatch):
    _install_fake_claude(monkeypatch, """{
      "wanted": "", "blocker": "competitor",
      "blocker_detail": "Already had it done by someone else.",
      "commitment": "", "callback_phrase": "",
      "temperature": "cold", "one_line": "Already used another company.",
      "quoted_price_mentioned": false
    }""")
    out = call_intent.extract_intent("...", call_date="2026-09-02")
    assert out["temperature"] == "cold"
    assert out["callback_at"] == ""
    assert out["commitment"] == ""


def test_the_extractor_is_not_the_coach():
    """Guard against the two prompts drifting back together.

    call_analyzer grades Olga; this reads the customer. If this prompt starts
    asking for coaching, the callback list quietly fills with advice for the
    rep instead of signal about the buyer.
    """
    prompt = call_intent._PROMPT.lower()
    assert "customer" in prompt
    for coaching_word in ("rubric", "score her", "coaching", "olga"):
        assert coaching_word not in prompt, (
            f"the intent prompt mentions {coaching_word!r} — it is drifting "
            f"back into being a call coach"
        )
