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


def test_every_new_real_call_gets_listened_to(db, monkeypatch):
    """The pipeline listens after the transcript, short calls with words too
    (2026-10-31, the short-call read); a ring under 8 seconds doesn't."""
    import json as _json
    from database import CallRecording, CallTone
    from services import call_poller, call_transcriber, call_analyzer
    from services import voicemail
    db.add(CallRecording(id="R1", lead_id=None, recording_data=b"RIFFxxxxWAVE", has_recording_data=True,
                         duration_seconds=300, call_direction="outbound", status="pending"))
    db.add(CallRecording(id="R2", lead_id=None, recording_data=b"RIFFxxxxWAVE", has_recording_data=True,
                         duration_seconds=30, call_direction="outbound", status="pending"))
    db.add(CallRecording(id="R3", lead_id=None, recording_data=b"RIFFyyyyWAVE", has_recording_data=True,
                         duration_seconds=5, call_direction="outbound", status="pending"))
    db.commit()
    monkeypatch.setattr(call_poller, "get_db", lambda: db); monkeypatch.setattr(db, "close", lambda: None)
    monkeypatch.setattr(call_transcriber, "transcribe_recording", lambda a: {"full_text": "hi there", "segments": [
        {"speaker": 0, "start": 0, "end": 3, "text": "hi"}, {"speaker": 1, "start": 3, "end": 5, "text": "there"}], "confidence": 0.9})
    monkeypatch.setattr(voicemail, "looks_like_voicemail", lambda t: False)
    monkeypatch.setattr(call_analyzer, "analyze_call", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no credits")))
    heard = []
    monkeypatch.setattr(tone, "_key", lambda: "k")
    monkeypatch.setattr(tone, "configured", lambda: True)
    monkeypatch.setattr(tone, "listen", lambda audio, text="", short=False: heard.append(short) or {"customer_mood": "excited"})
    call_poller.process_recording_pipeline("R1")
    call_poller.process_recording_pipeline("R2")
    call_poller.process_recording_pipeline("R3")
    assert heard == [False, True]          # the long prompt, then the short one
    assert _json.loads(db.query(CallTone).filter_by(recording_id="R1").first().listen_json)["customer_mood"] == "excited"
    assert db.query(CallTone).filter_by(recording_id="R2").first() is not None
    assert db.query(CallTone).filter_by(recording_id="R3").first() is None


def test_listening_stays_paused_until_turned_on(db, monkeypatch):
    """Free-plan key (2026-10-25): nothing is sent until someone unpauses."""
    import database
    from database import SystemConfig
    monkeypatch.setattr(tone, "_key", lambda: "k")
    monkeypatch.setattr(database, "get_db", lambda: db); monkeypatch.setattr(db, "close", lambda: None)
    assert tone.configured() is False
    SystemConfig.set(db, "call_tone_paused", "0")
    assert tone.configured() is True


def test_short_calls_need_words_and_no_voicemail_flag():
    assert tone.should_listen(20, False, "Hello? Hi, this is Amy with Sterling")
    assert not tone.should_listen(20, False, "")
    assert not tone.should_listen(20, True, "Hello?")
    assert not tone.should_listen(5, False, "Hello?")
    assert tone.should_listen(75, False, "")
    assert "first_words" in tone.LISTEN_PROMPT and "ended_early" in tone.SHORT_PROMPT and "OPENING" not in tone.SHORT_PROMPT


def test_the_backlog_starts_once_when_its_time_comes(db, monkeypatch):
    """Alan, 2026-10-31: start the whole backlog at 11 PM."""
    from datetime import datetime, timezone
    import database
    from database import SystemConfig
    from api import call_tone as api
    monkeypatch.setattr(api, "get_db", lambda: db); monkeypatch.setattr(database, "get_db", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    monkeypatch.setattr(tone, "configured", lambda: True)
    started = []
    monkeypatch.setattr(api, "start_run", lambda n: started.append(n) or {"started": True, "of": 3})
    import services.after_pay_hooks as hooks
    monkeypatch.setattr(hooks, "alert_alan", lambda m: None)
    SystemConfig.set(db, "call_tone_backlog_at", "2026-11-01T04:00:00+00:00")
    assert api.backlog_tick(datetime(2026, 11, 1, 3, 55, tzinfo=timezone.utc)) is None and started == []
    assert api.backlog_tick(datetime(2026, 11, 1, 4, 2, tzinfo=timezone.utc))["of"] == 3
    assert api.backlog_tick(datetime(2026, 11, 1, 4, 6, tzinfo=timezone.utc)) is None
    assert started == [5000] and SystemConfig.get(db, "call_tone_backlog_at", "") == ""


def test_openers_count_early_hang_ups_per_caller(db, monkeypatch):
    import json as _json
    from database import CallRecording, CallTone, User
    from api import call_tone as api
    monkeypatch.setattr(api, "get_db", lambda: db); monkeypatch.setattr(db, "close", lambda: None)
    db.add(User(id="u1", username="amy", display_name="Amy", ghl_user_id="G1", role="staff", password_hash="x"))
    def call(rid, early, score, skip=False):
        db.add(CallRecording(id=rid, recorded_by="G1", duration_seconds=20, has_recording_data=True,
                             created_at="2026-10-31T15:00:00+00:00", call_direction="outbound", status="analyzed"))
        h = {"skip": True, "outcome": "voicemail"} if skip else {
            "opening": {"first_words": f"Hi it's Amy {rid}", "opener_score": score}, "ending": {"ended_early": early, "how": "customer hung up early" if early else "finished normally"}}
        db.add(CallTone(recording_id=rid, listen_json=_json.dumps(h), created_at="2026-10-31T15:01:00+00:00"))
    call("a", True, 3); call("b", False, 8); call("c", False, 7); call("d", False, 0, skip=True)
    db.commit()
    monkeypatch.setattr(api, "datetime", type("D", (), {"now": staticmethod(lambda tz=None: __import__("datetime").datetime(2026, 11, 1, tzinfo=tz))}))
    p = api.openers(30, user={})["people"]
    assert len(p) == 1 and p[0]["name"] == "Amy" and p[0]["live"] == 3 and p[0]["hung_up_early"] == 1
    assert p[0]["early_rate"] == 33 and p[0]["avg_opener"] == 6.0 and p[0]["worst"][0]["recording_id"] == "a"
