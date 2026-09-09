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
      "brief": "Wants both sides of the back fence stained before a party. Liked the Signature price. Her husband has to sign off tonight and she said she'd call back tomorrow. Call tomorrow, ask for the yes, take the deposit.",
      "quoted_price_mentioned": true
    }""")
    out = call_intent.extract_intent("...", call_date="2026-09-02")
    assert out["temperature"] == "hot"
    assert out["brief"].startswith("Wants both sides")
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


# ── A failed extraction must be retryable ─────────────────────────────

def test_a_missing_key_is_marked_not_ok_so_it_gets_retried(monkeypatch):
    """The guard against a credit outage silently blanking the backlog.

    If a failed extraction were recorded, the call would be marked done
    forever and never re-read — one outage would leave 768 empty rows and a
    callback list with nothing in it.
    """
    class _S:
        anthropic_api_key = ""
    monkeypatch.setattr(call_intent, "get_settings", lambda: _S())
    out = call_intent.extract_intent("Customer: call me Thursday.")
    assert out["ok"] is False


def test_a_credit_failure_is_marked_not_ok(monkeypatch):
    class _S:
        anthropic_api_key = "sk-test"
    monkeypatch.setattr(call_intent, "get_settings", lambda: _S())
    import anthropic
    def boom(*a, **k):
        raise RuntimeError("credit balance is too low")
    monkeypatch.setattr(anthropic, "Anthropic", boom)
    assert call_intent.extract_intent("Customer: hello.")["ok"] is False


def test_unparseable_output_is_marked_not_ok(monkeypatch):
    _install_fake_claude(monkeypatch, "not json")
    assert call_intent.extract_intent("Customer: hello.")["ok"] is False


# ── The object is in there somewhere ──────────────────────────────────

def test_prose_around_the_object_is_ignored(monkeypatch):
    """Seen live: "Looking at this thread, I can see that..." then the JSON."""
    _install_fake_claude(monkeypatch, """Looking at this transcript, I can see the customer is keen.

{"temperature": "hot", "one_line": "Ready to book.", "callback_phrase": ""}

Let me know if you need anything else.""")
    out = call_intent.extract_intent("Customer: book it.")
    assert out["ok"] is True
    assert out["temperature"] == "hot"
    assert out["one_line"] == "Ready to book."


def test_a_note_after_the_closing_brace_is_ignored(monkeypatch):
    """Seen live: "Extra data: line 11 column 1" — a trailing remark."""
    _install_fake_claude(monkeypatch, '{"temperature": "warm"}\nNote: the audio cut out near the end.')
    assert call_intent.extract_intent("Customer: hi.")["temperature"] == "warm"


def test_an_answer_cut_off_by_the_token_limit_says_so(monkeypatch):
    """Seen live once the brief was added: 4 to 9 reads per hundred came
    back as "no object found" on an answer that visibly started with one.
    They had hit max_tokens mid-object. The reason must say that."""
    class _S:
        anthropic_api_key = "sk-test"
    monkeypatch.setattr(call_intent, "get_settings", lambda: _S())

    class _Block:
        def __init__(self, text): self.text = text

    class _Resp:
        stop_reason = "max_tokens"
        content = [_Block('{"wanted": "the back fence", "brief": "She wants the back')]

    class _Messages:
        def create(self, **kw): return _Resp()

    class _Fake:
        def __init__(self, *a, **k): self.messages = _Messages()

    import anthropic
    monkeypatch.setattr(anthropic, "Anthropic", _Fake)

    out = call_intent.extract_intent("Customer: hi.")
    assert out["ok"] is False
    assert "Cut off" in out["one_line"]


def test_the_answer_budget_has_room_for_the_brief():
    """A five-sentence brief on top of the other fields runs well past 800."""
    assert call_intent._MAX_ANSWER_TOKENS >= 1500


def test_an_escaped_apostrophe_inside_a_quote_is_tolerated(monkeypatch):
    """Seen live: "Customer said \\'no thanks\\'" — the model escaping an
    apostrophe, which JSON does not allow. It failed as "no object found"
    on an answer that visibly started with one."""
    _install_fake_claude(monkeypatch,
                         '{"temperature": "cold", "blocker": "price", '
                         '"blocker_detail": "Customer said \\\'too much\\\' twice"}')
    out = call_intent.extract_intent("Customer: too much.")
    assert out["ok"] is True
    assert out["blocker_detail"] == "Customer said 'too much' twice"


def test_a_real_escape_is_left_alone():
    assert call_intent._repair_escapes(r'{"a": "line\nbreak \"quoted\" back\\slash"}') == \
        r'{"a": "line\nbreak \"quoted\" back\\slash"}'


def test_a_bad_json_reason_shows_both_ends(monkeypatch):
    _install_fake_claude(monkeypatch, '{"wanted": "the START of it", "brief": "and this is the END of it')
    out = call_intent.extract_intent("Customer: hi.")
    assert out["ok"] is False
    assert "START" in out["one_line"] and "END" in out["one_line"]


def test_a_brace_inside_a_quoted_value_does_not_end_the_object():
    got = call_intent._first_json_object('x {"one_line": "wants a {gate} too", "temperature": "warm"} y')
    assert got == {"one_line": "wants a {gate} too", "temperature": "warm"}


def test_no_object_at_all_is_still_a_failure():
    assert call_intent._first_json_object("nothing here") is None
    assert call_intent._first_json_object("{not: valid}") is None


def test_a_successful_read_is_marked_ok(monkeypatch):
    _install_fake_claude(monkeypatch, """{
      "wanted": "", "blocker": "none", "blocker_detail": "",
      "commitment": "", "callback_phrase": "", "temperature": "warm",
      "one_line": "", "quoted_price_mentioned": false
    }""")
    assert call_intent.extract_intent("Customer: hi.")["ok"] is True


def test_an_empty_transcript_is_ok_because_there_is_nothing_to_retry(db):
    """A call with no transcript is a final answer, not a transient failure.

    Marking it not-ok would make the drain retry it forever.
    """
    assert call_intent.extract_intent("")["ok"] is True


# ── Prompt caching floor ──────────────────────────────────────────────

def test_a_short_prompt_does_not_ask_for_caching():
    """Anthropic rejects a cache_control block under ~1024 tokens.

    Not "ignores" — rejects. Asking to cache this ~580-token prompt failed
    every single call, so 762 extractions produced exactly nothing for hours
    and looked like a silent stall rather than an error.
    """
    from services.call_intent import _PROMPT, _CACHE_MIN_CHARS
    if len(_PROMPT) < _CACHE_MIN_CHARS:
        captured = {}

        class _Block:
            def __init__(self, text): self.text = text

        class _Resp:
            def __init__(self): self.content = [_Block('{"temperature":"warm"}')]

        class _Messages:
            def create(self, **kw):
                captured.update(kw)
                return _Resp()

        class _Fake:
            def __init__(self, *a, **k): self.messages = _Messages()

        import anthropic
        import pytest as _pytest
        mp = _pytest.MonkeyPatch()
        try:
            class _S:
                anthropic_api_key = "sk-test"
            mp.setattr(call_intent, "get_settings", lambda: _S())
            mp.setattr(anthropic, "Anthropic", _Fake)
            call_intent.extract_intent("Customer: hello.")
        finally:
            mp.undo()

        block = captured["system"][0]
        assert "cache_control" not in block, (
            "asked to cache a sub-threshold prompt — the API will reject "
            "every request and the extractor will produce nothing"
        )


def test_the_cache_floor_is_above_anthropics_minimum():
    """~4 chars per token, so the floor must clear 1024 tokens with room."""
    from services.call_intent import _CACHE_MIN_CHARS
    assert _CACHE_MIN_CHARS / 4 > 1024
