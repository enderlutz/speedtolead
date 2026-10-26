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
  "customer_mood": one of "excited", "interested", "unsure", "flat", "annoyed", "rushed",
  "customer_mood_why": one short sentence in plain words a 10-year-old can read,
  "buying_temperature": integer 1-10 (10 = ready to pay today), judged from their voice as much as their words,
  "moments": up to 5 objects {"at": "m:ss", "who": "customer" or "team", "feeling": one or two words, "quote": the words said (max 15 words), "why_it_matters": one short sentence},
  "team_tone": {"warmth": 1-10, "confidence": 1-10, "pace": "too fast" | "good" | "too slow", "listening": 1-10, "note": one short sentence on how our person sounded},
  "team_score": integer 1-10 for how well our person handled the call,
  "do_better": up to 3 short, specific tips for our person, plain words,
  "follow_up": {"when_days": integer days from the call to reach out next (0 = today), "how": "call" | "text" | "either", "say": one sentence of what to open with next time, "why": one short sentence}
}
NEVER write down card numbers, expiration dates, security codes, bank details or any long number read out on the call; if a moment is someone paying, write "reads out card details" instead of the quote.
If the recording is a voicemail, silence, or not a sales conversation, return {"skip": true, "why": "..."}.
Plain words only. No markdown, no extra text."""


def _key() -> str:
    from config import get_settings
    return (getattr(get_settings(), "gemini_api_key", "") or "").strip()


def configured() -> bool:
    return bool(_key())


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


def listen(audio: bytes, transcript: str = "", model: str = GEMINI_MODEL) -> dict:
    """Gemini's read of how the call sounded. Raises on a missing key or an
    API error; the caller saves the error so it shows on the call."""
    key = _key()
    if not key:
        raise RuntimeError("GEMINI_API_KEY isn't set")
    mime = _mime(audio)
    with httpx.Client(timeout=240) as client:
        part = (_upload(client, key, audio, mime) if len(audio) > _INLINE_MAX
                else {"inline_data": {"mime_type": mime, "data": base64.b64encode(audio).decode()}})
        prompt = LISTEN_PROMPT
        if transcript:
            prompt += "\n\nThe transcript (speaker labels may be wrong; trust the audio):\n" + transcript[:12000]
        body = {"contents": [{"role": "user", "parts": [part, {"text": prompt}]}],
                "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json"}}
        # Busy (503) or too many at once (429) passes in a moment: try again.
        for wait in (5, 15, 40, 0):
            r = client.post(f"{_API}/v1beta/models/{model}:generateContent", params={"key": key}, json=body)
            if r.status_code not in (429, 500, 503) or not wait:
                break
            time.sleep(wait)
        if r.status_code >= 400:
            raise RuntimeError(f"Gemini {r.status_code}: {r.text[:300]}")
        data = r.json()
    cands = data.get("candidates") or []
    text = "".join(p.get("text", "") for p in ((cands[0].get("content") or {}).get("parts") or [])) if cands else ""
    if not text:
        raise RuntimeError(f"Gemini sent nothing back ({(data.get('promptFeedback') or {}).get('blockReason', 'no reason given')})")
    out = scrub(_json_out(text))
    usage = data.get("usageMetadata") or {}
    out["_tokens"] = {"in": usage.get("promptTokenCount", 0), "out": usage.get("candidatesTokenCount", 0)}
    return out
