"""How a call sounded (Alan, 2026-10-25): "we want to get the tone of voice
from the calls", to know when to follow up and how good the VA's call was.

Two parts:
  talk_numbers()  free, from the transcript's timings we already store:
                  who talked more, the pause after the price, interruptions,
                  how long the customer's answers were, talking speed.
  listen()        Gemini listens to the recording itself (the words alone
                  can't tell an excited "yeah" from a bored one) and says how
                  the customer and our person sounded, the moments that
                  mattered, and when to follow up.

GEMINI_API_KEY lives in Railway (project "at system", paid tier so the
recordings aren't used for training).
"""
from __future__ import annotations

import base64
import json
import logging
import re
import time

import httpx

logger = logging.getLogger(__name__)

# Google retires model names for new accounts (2.5 Flash was gone by
# 2026-10-25); the "latest" name always points at the current Flash.
GEMINI_MODEL = "gemini-flash-latest"
_API = "https://generativelanguage.googleapis.com"
# Gemini takes up to ~20 MB in one request; base64 adds a third, so bigger
# recordings are uploaded first.
_INLINE_MAX = 14 * 1024 * 1024

_PRICE = re.compile(r"\$\s?\d|\b\d[\d,]*\s*(?:dollars|bucks)\b|\b(?:price|total|comes (?:down )?to|per month|a month)\b", re.I)


# ── Part 1: the numbers ─────────────────────────────────────────────────────

def _who(speaker_map: dict, speaker) -> str:
    """'customer' or 'team'. The transcriber labels one voice "Customer" and
    ours "Team" or with a GHL user id."""
    name = str(speaker_map.get(str(speaker), "")).strip().lower()
    return "customer" if name == "customer" else "team"


def talk_numbers(segments: list[dict], speaker_map: dict) -> dict:
    """What the timings say about the call. Seconds rounded to one place."""
    segs = sorted((s for s in segments or [] if (s.get("end") or 0) > (s.get("start") or 0)), key=lambda s: s["start"])
    voices = {_who(speaker_map, s.get("speaker", 0)) for s in segs}
    if not segs:
        return {"ok": False, "why": "No transcript timings for this call."}
    if voices != {"customer", "team"}:
        return {"ok": False, "why": "The transcript couldn't tell the two voices apart on this call."}

    talk = {"customer": 0.0, "team": 0.0}
    words = {"customer": 0, "team": 0}
    turns = {"customer": 0, "team": 0}
    interrupts = {"customer": 0, "team": 0}   # who cut in on the other
    longest_customer = 0.0
    answers: list[float] = []                 # each customer turn, in seconds
    price_pauses: list[dict] = []
    prev = None
    turn_len = 0.0
    for s in segs:
        who = _who(speaker_map, s.get("speaker", 0))
        dur = float(s["end"]) - float(s["start"])
        talk[who] += dur
        words[who] += len((s.get("text") or "").split())
        if prev is not None and _who(speaker_map, prev.get("speaker", 0)) != who:
            if float(s["start"]) < float(prev["end"]) - 0.3:
                interrupts[who] += 1
            # The quiet after we said a price, until the customer spoke.
            if who == "customer" and _who(speaker_map, prev.get("speaker", 0)) == "team" and _PRICE.search(prev.get("text") or ""):
                price_pauses.append({"at": round(float(prev["end"]), 1),
                                     "pause": round(max(0.0, float(s["start"]) - float(prev["end"])), 1),
                                     "said": (prev.get("text") or "")[-120:]})
        if prev is None or _who(speaker_map, prev.get("speaker", 0)) != who:
            turns[who] += 1
            if prev is not None and _who(speaker_map, prev.get("speaker", 0)) == "customer":
                answers.append(turn_len)
            turn_len = 0.0
        turn_len += dur
        if who == "customer":
            longest_customer = max(longest_customer, turn_len)
        prev = s
    if prev is not None and _who(speaker_map, prev.get("speaker", 0)) == "customer":
        answers.append(turn_len)

    total = talk["customer"] + talk["team"]
    mins = {k: talk[k] / 60 for k in talk}
    short = sum(1 for a in answers if a < 2.0)
    return {
        "ok": True,
        "customer_share": round(100 * talk["customer"] / total) if total else 0,
        "team_share": round(100 * talk["team"] / total) if total else 0,
        "customer_seconds": round(talk["customer"], 1),
        "team_seconds": round(talk["team"], 1),
        "customer_turns": turns["customer"],
        "avg_customer_answer": round(sum(answers) / len(answers), 1) if answers else 0.0,
        "longest_customer_answer": round(longest_customer, 1),
        "short_answers_pct": round(100 * short / len(answers)) if answers else 0,
        "team_interrupted": interrupts["team"],
        "customer_interrupted": interrupts["customer"],
        "team_words_per_min": round(words["team"] / mins["team"]) if mins["team"] > 0.2 else 0,
        "customer_words_per_min": round(words["customer"] / mins["customer"]) if mins["customer"] > 0.2 else 0,
        "price_pauses": price_pauses[:5],
    }


# ── Part 2: listening ───────────────────────────────────────────────────────

LISTEN_PROMPT = """You are listening to a recorded sales phone call for Sterling Fence Staining, a fence staining company in Houston. One voice is our person (a VA or the project manager, Alan); the other is the customer. Listen to HOW things are said, not just the words: tone, energy, warmth, hesitation, pace, sighs, laughter, long pauses.

Return ONLY a JSON object with these keys:
{
  "customer_voice": one of "a man", "a woman", "can't tell": how the CUSTOMER sounds, from the voice alone, never from the name; say "can't tell" whenever you are not sure, when more than one person is on their side, or when anything does not add up,
  "customer_mood": one of "excited", "interested", "unsure", "flat", "annoyed", "rushed",
  "customer_mood_why": one short sentence in plain words a 10-year-old can read,
  "buying_temperature": integer 1-10 (10 = ready to pay today), judged from their voice as much as their words,
  "moments": up to 5 objects {"at": "m:ss", "who": "customer" or "team", "feeling": one or two words, "quote": the words said (max 15 words), "why_it_matters": one short sentence},
  "team_tone": {"warmth": 1-10, "confidence": 1-10, "pace": "too fast" | "good" | "too slow", "listening": 1-10, "note": one short sentence on how our person sounded},
  "team_score": integer 1-10 for how well our person handled the call,
  "do_better": up to 3 short, specific tips for our person, plain words,
  "follow_up": {"when_days": integer days from the call to reach out next (0 = today), "how": "call" | "text" | "either", "say": one sentence of what to open with next time, "why": one short sentence},
  "opening": OPENING,
  "ending": ENDING
}
NEVER write down card numbers, expiration dates, security codes, bank details or any long number read out on the call; if a moment is someone paying, write "reads out card details" instead of the quote.
If the recording is a voicemail, silence, or not a sales conversation, return {"skip": true, "why": "..."}.
Plain words only. No markdown, no extra text."""


# The first 10-15 seconds once a live person answers (Alan, 2026-10-31: "the
# customer just hangs up maybe because they don't like the tone of voice that
# we start off with"). On every call, long or short, so openers compare.
OPENING = """{"first_words": our first words to the live person, exactly as said (max 25 words), "opener_score": integer 1-10 for how well those first seconds would keep a stranger on the phone, "sounded_like": one of "a friendly local person", "a call center", "reading a script", "rushed", "unsure", "too pushy", "energy": "low" | "good" | "too much", "customer_reaction": one short sentence on how the customer took the opening, "tip": one short, specific tip for the opening}"""
# How it ended. "hung_up_early" is the one Alan wants counted.
ENDING = """{"how": one of "finished normally", "customer hung up early", "customer busy, call back later", "not interested", "wrong number", "call dropped", "we ended it", "ended_early": true if the customer ended it in the first 30 seconds of the conversation without agreeing to anything, else false, "why": one short sentence}"""
LISTEN_PROMPT = LISTEN_PROMPT.replace("OPENING", OPENING).replace("ENDING", ENDING)

SHORT_PROMPT = """You are listening to a SHORT recorded phone call (under a minute) for Sterling Fence Staining, a fence staining company in Houston. One voice is our person (a VA or the project manager, Alan); the other is the customer. Many short calls are voicemails, call screeners or no answer; some are a real person who picked up and hung up fast. Listen to HOW things are said: tone, energy, warmth, hesitation.

Return ONLY a JSON object:
{
  "outcome": one of "voicemail", "call screener", "no answer", "live person",
  "customer_spoke": true if a live customer (not a greeting or machine) said anything,
  "customer_voice": one of "a man", "a woman", "can't tell": how the CUSTOMER sounds, from the voice alone, never from the name; say "can't tell" whenever you are not sure, when more than one person is on their side, or when anything does not add up (only when a live customer spoke),
  "customer_mood": one of "excited", "interested", "unsure", "flat", "annoyed", "rushed" (only when a live customer spoke),
  "customer_mood_why": one short sentence in plain words,
  "opening": OPENING (only when a live customer spoke),
  "ending": ENDING (only when a live customer spoke),
  "follow_up": {"when_days": integer, "how": "call" | "text" | "either", "say": one sentence to open with next time, "why": one short sentence} (only when a live customer spoke)
}
If it was a voicemail, call screener or no answer, return {"skip": true, "outcome": that outcome, "why": "..."}.
NEVER write down card numbers or any long number read out on the call.
Plain words only. No markdown, no extra text.""".replace("OPENING", OPENING).replace("ENDING", ENDING)

# Shorter than a minute still gets a listen when it isn't a voicemail and
# somebody said something (Alan, 2026-10-31). Under this is a ring or a beep.
SHORT_MIN = 8
LONG_MIN = 60


def should_listen(duration: int | None, is_voicemail: bool, transcript: str) -> bool:
    """Every real call: a minute or more, or a shorter one with words on it.
    The listen itself sorts voicemails and screeners from a live hang-up
    (the transcript's voice labels can't: see the 2026-10-31 notes)."""
    d = int(duration or 0)
    if is_voicemail or d < SHORT_MIN:
        return False
    return d >= LONG_MIN or bool((transcript or "").strip())


def _key() -> str:
    from config import get_settings
    return (getattr(get_settings(), "gemini_api_key", "") or "").strip()


def current_model(db=None) -> str:
    """The model to use: the one picked on the server (SystemConfig
    call_tone_model) when set, so a busy or retired model can be swapped
    without a deploy; otherwise GEMINI_MODEL."""
    try:
        from database import SystemConfig, get_db
        d = db or get_db()
        try:
            return (SystemConfig.get(d, "call_tone_model", "") or GEMINI_MODEL).strip()
        finally:
            if db is None:
                d.close()
    except Exception:  # noqa: BLE001
        return GEMINI_MODEL


def models() -> list[str]:
    """Gemini models this key can use to listen (generateContent)."""
    with httpx.Client(timeout=30) as client:
        r = client.get(f"{_API}/v1beta/models", params={"key": _key(), "pageSize": 200})
        r.raise_for_status()
        return sorted(m["name"].removeprefix("models/") for m in r.json().get("models", [])
                      if "generateContent" in (m.get("supportedGenerationMethods") or []))


def configured() -> bool:
    """A key is in AND listening isn't paused. Paused 2026-10-25: the key
    turned out to be on Google's free plan, where Google may use what we
    send (customers' voices) for training. Unpause once billing is on:
    POST /api/call-tone/pause {"paused": false}."""
    if not _key():
        return False
    try:
        from database import SystemConfig, get_db
        d = get_db()
        try:
            return SystemConfig.get(d, "call_tone_paused", "1") != "1"
        finally:
            d.close()
    except Exception:  # noqa: BLE001
        return False


def _mime(audio: bytes) -> str:
    if audio[:4] == b"RIFF":
        return "audio/wav"
    if audio[:3] == b"ID3" or audio[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return "audio/mp3"
    if audio[:4] == b"OggS":
        return "audio/ogg"
    if audio[4:8] == b"ftyp":
        return "audio/mp4"
    if audio[:4] == b"\x1aE\xdf\xa3":
        return "audio/webm"
    return "audio/wav"


def _upload(client: httpx.Client, key: str, audio: bytes, mime: str) -> dict:
    """Big recordings go through Gemini's file upload first."""
    start = client.post(f"{_API}/upload/v1beta/files", params={"key": key}, headers={
        "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": str(len(audio)), "X-Goog-Upload-Header-Content-Type": mime,
        "Content-Type": "application/json"}, json={"file": {"display_name": "call"}})
    start.raise_for_status()
    url = start.headers.get("x-goog-upload-url")
    if not url:
        raise RuntimeError("Gemini didn't return an upload address")
    done = client.post(url, headers={"Content-Length": str(len(audio)), "X-Goog-Upload-Offset": "0",
                                     "X-Goog-Upload-Command": "upload, finalize"}, content=audio)
    done.raise_for_status()
    f = done.json().get("file", {})
    for _ in range(20):  # audio is usually ready at once
        if f.get("state") in (None, "ACTIVE"):
            break
        time.sleep(1.5)
        f = client.get(f"{_API}/v1beta/{f['name']}", params={"key": key}).json()
    return {"file_data": {"mime_type": mime, "file_uri": f["uri"]}}


# A card number, expiry or code read out on the call never gets saved or
# shown, whatever Gemini writes (Chris Harrell's quote had his card digits).
_DIGITS = re.compile(r"(?:\d[\s-]?){4,}")


def scrub(value):
    """Blank out runs of 4+ digits in every string of Gemini's answer.
    Prices keep their commas ($1,994 is safe) so they stay readable."""
    if isinstance(value, str):
        return _DIGITS.sub("••••", value)
    if isinstance(value, list):
        return [scrub(v) for v in value]
    if isinstance(value, dict):
        return {k: (v if k == "_tokens" else scrub(v)) for k, v in value.items()}
    return value


def _json_out(text: str) -> dict:
    t = (text or "").strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t)
    m = re.search(r"\{.*\}", t, re.S)
    return json.loads(m.group(0) if m else t)


def listen(audio: bytes, transcript: str = "", model: str = "", short: bool = False) -> dict:
    """Gemini's read of how the call sounded. Raises on a missing key or an
    API error; the caller saves the error so it shows on the call."""
    key = _key()
    if not key:
        raise RuntimeError("GEMINI_API_KEY isn't set")
    model = model or current_model()
    mime = _mime(audio)
    with httpx.Client(timeout=httpx.Timeout(150, connect=20)) as client:
        part = (_upload(client, key, audio, mime) if len(audio) > _INLINE_MAX
                else {"inline_data": {"mime_type": mime, "data": base64.b64encode(audio).decode()}})
        prompt = SHORT_PROMPT if short else LISTEN_PROMPT
        if transcript:
            prompt += "\n\nThe transcript (speaker labels may be wrong; trust the audio):\n" + transcript[:12000]
        body = {"contents": [{"role": "user", "parts": [part, {"text": prompt}]}],
                "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json"}}
        # Busy (503) or too many at once (429) passes in a moment: try again.
        # A hang (read timeout) is the same busy, said differently.
        for wait in (5, 20, 60, 0):
            try:
                r = client.post(f"{_API}/v1beta/models/{model}:generateContent", params={"key": key}, json=body)
            except httpx.TimeoutException:
                if not wait:
                    raise RuntimeError("Gemini took too long to answer (busy)")
                time.sleep(wait)
                continue
            if r.status_code not in (429, 500, 503) or not wait:
                break
            time.sleep(wait)
        if r.status_code >= 400:
            # Keep which quota was hit ("free_tier" in its name means the key
            # has no billing, and Google may train on what we send).
            quota = sorted(set(re.findall(r'"quota(?:Metric|Id)":\s*"([^"]+)"', r.text)))
            raise RuntimeError(f"Gemini {r.status_code}: {r.text[:200]}" + (f" | quota: {', '.join(quota)}" if quota else ""))
        data = r.json()
    cands = data.get("candidates") or []
    text = "".join(p.get("text", "") for p in ((cands[0].get("content") or {}).get("parts") or [])) if cands else ""
    if not text:
        raise RuntimeError(f"Gemini sent nothing back ({(data.get('promptFeedback') or {}).get('blockReason', 'no reason given')})")
    out = scrub(_json_out(text))
    usage = data.get("usageMetadata") or {}
    out["_tokens"] = {"in": usage.get("promptTokenCount", 0), "out": usage.get("candidatesTokenCount", 0)}
    return out
