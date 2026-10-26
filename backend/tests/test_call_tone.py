"""How a call sounded (Alan, 2026-10-25): the free numbers from the
transcript timings, and reading Gemini's answer."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import call_tone as tone  # noqa: E402

SPK = {"0": "Team", "1": "Customer"}


def test_numbers_split_talk_and_catch_the_pause_after_the_price():
    segs = [
        {"speaker": 0, "start": 0, "end": 10, "text": "Hi this is Amy with Sterling Fence Staining"},
        {"speaker": 1, "start": 10.5, "end": 12, "text": "Oh hi"},
        {"speaker": 0, "start": 12, "end": 20, "text": "So the Signature package comes to $1,994 total"},
        {"speaker": 1, "start": 26, "end": 27, "text": "Okay"},
        {"speaker": 0, "start": 26.5, "end": 30, "text": "And we can do monthly payments"},   # cuts in
        {"speaker": 1, "start": 30, "end": 40, "text": "Well I need to talk to my wife about the color first"},
    ]
    n = tone.talk_numbers(segs, SPK)
    assert n["ok"] and n["team_share"] == 63 and n["customer_share"] == 37
    assert n["price_pauses"][0]["pause"] == 6.0
    assert n["team_interrupted"] == 1 and n["customer_turns"] == 3
    assert n["short_answers_pct"] == 67 and n["longest_customer_answer"] == 10.0


def test_one_voice_or_nothing_says_why():
    assert not tone.talk_numbers([], SPK)["ok"]
    one = [{"speaker": 0, "start": 0, "end": 5, "text": "hello"}]
    assert "voices" in tone.talk_numbers(one, {"0": "Team"})["why"]


def test_a_gemini_user_id_label_counts_as_our_side():
    segs = [{"speaker": 0, "start": 0, "end": 4, "text": "hi"}, {"speaker": 1, "start": 4, "end": 6, "text": "yes"}]
    assert tone.talk_numbers(segs, {"0": "L8Gy6MLPvf3Wc0s2cNcl", "1": "Customer"})["team_share"] == 67


def test_reads_json_even_in_a_code_fence_and_knows_wav():
    assert tone._json_out('```json\n{"customer_mood": "excited"}\n```') == {"customer_mood": "excited"}
    assert tone._mime(b"RIFF\x00\x00\x00\x00WAVE") == "audio/wav"


def test_listen_without_a_key_says_so(monkeypatch):
    monkeypatch.setattr(tone, "_key", lambda: "")
    try:
        tone.listen(b"RIFF")
        raise AssertionError("should have raised")
    except RuntimeError as e:
        assert "GEMINI_API_KEY" in str(e)


def test_card_digits_never_survive_but_prices_do():
    out = tone.scrub({"moments": [{"quote": "It's a Visa. It's 4266 1234 5678 9012, exp 0428"}],
                      "say": "Your total is $1,994.40", "_tokens": {"in": 777}})
    assert "4266" not in str(out) and "1234" not in str(out) and "0428" not in str(out)
    assert out["say"] == "Your total is $1,994.40" and out["_tokens"]["in"] == 777
