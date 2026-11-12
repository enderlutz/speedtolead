"""Say the customer's name and address out loud before the VA dials.

Our phone VAs are not native English speakers and trip on names and street
names. The Listen button reads what the call script opens with: "Missus
Smith" when we know the label (services/greeting.py), else the full name,
then the address the way an American says it ("twenty-three oh ten Oak
Ridge Lane, Cypress").

A person can type how it should sound ("ek-PEN-yong") for the name and/or
the address. Those live in the lead's form_data (no new columns):
  say_name      replaces the name part when set
  say_address   replaces the address part when set
"""

from __future__ import annotations

import hashlib
import re
import threading
from collections import OrderedDict

from services import greeting

NAME_KEY = "say_name"
ADDRESS_KEY = "say_address"

SPOKEN_LABEL = {"Mr.": "Mister", "Mrs.": "Missus", "Ms.": "Missus", "Miss": "Missus", "Dr.": "Doctor"}

STREET_WORDS = {
    "ln": "Lane", "dr": "Drive", "ct": "Court", "st": "Street", "rd": "Road",
    "blvd": "Boulevard", "cir": "Circle", "pkwy": "Parkway", "ave": "Avenue",
    "av": "Avenue", "trl": "Trail", "tr": "Trail", "hwy": "Highway", "cv": "Cove",
    "pl": "Place", "fwy": "Freeway", "expy": "Expressway", "sq": "Square",
    "ter": "Terrace", "crk": "Creek", "xing": "Crossing", "mdw": "Meadow",
    "mdws": "Meadows", "hls": "Hills", "pt": "Point", "pass": "Pass",
}
DIRECTIONS = {
    "n": "North", "s": "South", "e": "East", "w": "West",
    "ne": "Northeast", "nw": "Northwest", "se": "Southeast", "sw": "Southwest",
}
COUNTRY = {"usa", "us", "u.s.", "u.s.a.", "united states", "united states of america"}
STATE = {"tx", "texas"}
UNIT_RE = re.compile(r"\b(?:apt|apartment|unit|ste|suite|bldg|building|lot|rm|room)\b\.?\s*#?\s*[\w-]+|#\s*[\w-]+", re.I)
ZIP_RE = re.compile(r"\b\d{5}(?:-\d{4})?\b")

ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
        "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
        "seventeen", "eighteen", "nineteen"]
TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]


# ── Numbers ───────────────────────────────────────────────────────────

def _two(n: int) -> str:
    """0..99 in words."""
    if n < 20:
        return ONES[n]
    t, o = divmod(n, 10)
    return TENS[t] + (f"-{ONES[o]}" if o else "")


def _pair(digits: str) -> str:
    """The second half of a house number: "14" → fourteen, "05" → oh five,
    "00" is handled by the caller."""
    if digits[0] == "0":
        return f"oh {ONES[int(digits[1])]}"
    return _two(int(digits))


def _three(digits: str) -> str:
    """"542" → five forty-two, "500" → five hundred, "010" → oh ten, "005" → oh oh five."""
    if digits[0] == "0":
        return "oh " + _pair(digits[1:])
    if digits[1:] == "00":
        return f"{ONES[int(digits[0])]} hundred"
    return f"{ONES[int(digits[0])]} {_pair(digits[1:])}"


def say_number(digits: str) -> str:
    """A house or highway number the way Americans read it.

    7 → seven, 542 → five forty-two, 4914 → forty-nine fourteen,
    4900 → forty-nine hundred, 23010 → twenty-three oh ten.
    Leading zeros or six digits and up are read one digit at a time.
    """
    d = (digits or "").strip()
    if not d.isdigit():
        return d
    if len(d) > 1 and d[0] == "0" or len(d) > 5:
        return " ".join(ONES[int(c)] for c in d)
    n = len(d)
    if n <= 2:
        return _two(int(d))
    if n == 3:
        return _three(d)
    if n == 4:
        if d[1:] == "000":
            return f"{ONES[int(d[0])]} thousand"
        if d[2:] == "00":
            return f"{_two(int(d[:2]))} hundred"
        return f"{_two(int(d[:2]))} {_pair(d[2:])}"
    # five digits: first two, then the last three
    if d[2:] == "000":
        return f"{_two(int(d[:2]))} thousand"
    return f"{_two(int(d[:2]))} {_three(d[2:])}"


# ── Words ─────────────────────────────────────────────────────────────

def _fix_case(word: str) -> str:
    """ALL CAPS or all lowercase → Title; mixed case (McDonald) is left alone.
    Ordinals stay lowercase (2nd, 3rd)."""
    if not word or not any(c.isalpha() for c in word):
        return word
    if re.fullmatch(r"\d+(st|nd|rd|th)", word, re.I):
        return word.lower()
    if word.isupper() or word.islower():
        return re.sub(r"(^|[-'])([a-z])", lambda m: m.group(1) + m.group(2).upper(), word.lower())
    return word


def _street(segment: str) -> str:
    """One comma part of the street line: numbers spoken, abbreviations expanded."""
    raw = [w for w in re.split(r"\s+", segment.strip()) if w]
    out: list[str] = []
    for i, w in enumerate(raw):
        bare = w.rstrip(".").lower()
        if w.isdigit():
            out.append(say_number(w))
        elif bare in DIRECTIONS and (i == 0 or i == len(raw) - 1 or raw[i - 1].isdigit()):
            # A lone letter is a direction only at the edges or right after
            # the house number ("123 N Main St", "Main St N").
            out.append(DIRECTIONS[bare])
        elif bare == "st" and i < len(raw) - 1 and i > 0 and raw[i - 1].isdigit() \
                and raw[i + 1].rstrip(".").lower() not in DIRECTIONS:
            out.append("Saint")       # "123 St Andrews Dr"
        elif bare in STREET_WORDS and i > 0:
            out.append(STREET_WORDS[bare])
        else:
            out.append(_fix_case(w))
    return " ".join(out)


def speak_address(address: str | None) -> str:
    """"23010 OAK RIDGE LN, CYPRESS, TX 77429, USA" →
    "twenty-three oh ten Oak Ridge Lane, Cypress"."""
    text = (address or "").strip()
    if not text:
        return ""
    text = UNIT_RE.sub(" ", text)
    text = re.sub(r"[,\s]*\b(?:united states(?: of america)?|u\.?s\.?a\.?)[.\s]*$", "", text, flags=re.I)
    parts = []
    for idx, part in enumerate(text.split(",")):
        p = re.sub(r"\s+", " ", part).strip(" .")
        if not p or p.lower() in COUNTRY or p.lower() in STATE:
            continue
        # "Cypress TX 77429" in one part (or no commas at all): drop the
        # trailing zip / state / country. A part that is only a zip goes too,
        # but never the house number at the very start (23010 is five digits).
        words = p.split(" ")
        keep = 1 if idx == 0 else 0
        while len(words) > keep and (ZIP_RE.fullmatch(words[-1]) or words[-1].rstrip(".").lower() in STATE | COUNTRY):
            words.pop()
        p = " ".join(words)
        if p:
            parts.append(_street(p))
    return ", ".join(parts)


def speak_name(lead) -> str:
    """The customer's FULL name, cleaned up (Alan, 2026-11-11: "go back to
    it just saying the full name"; the VAs are trained to say Mr./Mrs. +
    last name themselves). Any Mr./Mrs. typed into the name is dropped."""
    if lead is None:
        return ""
    words = [greeting._clean(w) for w in (getattr(lead, "contact_name", "") or "").split()]
    words = [w for w in words if w and w.lower() not in greeting.LABELS]
    return " ".join(SUFFIXES.get(w.lower().rstrip("."), _fix_case(w)) for w in words)


# Name endings said the way people say them ("Milton Mosk the Third").
SUFFIXES = {"ii": "the Second", "iii": "the Third", "iv": "the Fourth", "jr": "Junior", "sr": "Senior"}


# The area each zip is in, said after the street when the address has no
# city (Alan, 2026-11-11: "77433 would be Cypress"). Every other 770xx zip
# is Houston. Covers the service area; anything else says no area.
ZIP_AREAS = {
    **{z: "Cypress" for z in ("77410", "77429", "77433")},
    **{z: "Katy" for z in ("77449", "77450", "77491", "77492", "77493", "77494")},
    **{z: "Tomball" for z in ("77375", "77377")},
    **{z: "Spring" for z in ("77373", "77379", "77386", "77388", "77389")},
    **{z: "The Woodlands" for z in ("77380", "77381", "77382")},
    **{z: "Conroe" for z in ("77301", "77302", "77303", "77304", "77306", "77384", "77385")},
    **{z: "Magnolia" for z in ("77354", "77355")},
    **{z: "Montgomery" for z in ("77316", "77356")},
    **{z: "Humble" for z in ("77338", "77396")},
    "77346": "Atascocita",
    **{z: "Kingwood" for z in ("77339", "77345")},
    "77365": "Porter", "77357": "New Caney", "77362": "Pinehurst",
    "77447": "Hockley", "77423": "Brookshire", "77441": "Fulshear", "77484": "Waller", "77445": "Hempstead",
    **{z: "Richmond" for z in ("77406", "77407", "77469")},
    **{z: "Sugar Land" for z in ("77478", "77479", "77498")},
    **{z: "Missouri City" for z in ("77459", "77489")},
    "77477": "Stafford",
    **{z: "Pearland" for z in ("77581", "77584", "77588")},
    "77578": "Manvel", "77583": "Rosharon", "77573": "League City",
    **{z: "Baytown" for z in ("77520", "77521")},
    "77532": "Crosby",
}


def area_for(lead) -> str:
    """The town for the lead's zip ("Cypress"), "" when we don't know it."""
    z = str(getattr(lead, "zip_code", "") or "").strip()[:5]
    if not ZIP_RE.fullmatch(z):
        m = re.search(r"\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)", getattr(lead, "address", "") or "")
        z = m.group(1) if m and not (getattr(lead, "address", "") or "").strip().startswith(m.group(1)) else ""
    if not z:
        return ""
    if z in ZIP_AREAS:
        return ZIP_AREAS[z]
    return "Houston" if z.startswith("770") else ""


def overrides(lead) -> dict:
    data = greeting.form(lead)
    return {
        NAME_KEY: str(data.get(NAME_KEY) or "").strip(),
        ADDRESS_KEY: str(data.get(ADDRESS_KEY) or "").strip(),
    }


def parts(lead) -> dict:
    """{name, address, say_name, say_address, text}: what the Listen button says."""
    o = overrides(lead)
    name = o[NAME_KEY] or speak_name(lead)
    address = o[ADDRESS_KEY] or speak_address(getattr(lead, "address", ""))
    # No town in the address: add the area from the zip ("..., Cypress").
    if address and not o[ADDRESS_KEY] and "," not in address:
        area = area_for(lead)
        if area:
            address = f"{address}, {area}"
    return {"name": name, "address": address, **o, "text": join(name, address)}


def join(name: str, address: str) -> str:
    """Plain text, safe for the browser's own voice: name. address."""
    bits = [b.strip().rstrip(".") for b in (name, address) if b and b.strip()]
    return ". ".join(bits) + ("." if bits else "")


def tts_text(name: str, address: str) -> str:
    """The same words for ElevenLabs, with a short pause between them."""
    n, a = (name or "").strip().rstrip("."), (address or "").strip().rstrip(".")
    if n and a:
        return f'{n}. <break time="0.8s" /> {a}.'
    return join(n, a)


# ── Audio cache ───────────────────────────────────────────────────────

CACHE_MAX = 300
_cache: "OrderedDict[str, bytes]" = OrderedDict()
_lock = threading.Lock()


def cache_key(text: str, voice: str) -> str:
    return hashlib.sha256(f"{voice}\n{text}".encode("utf-8")).hexdigest()


def cache_get(key: str) -> bytes | None:
    with _lock:
        audio = _cache.get(key)
        if audio is not None:
            _cache.move_to_end(key)
        return audio


def cache_put(key: str, audio: bytes) -> None:
    if not audio:
        return
    with _lock:
        _cache[key] = audio
        _cache.move_to_end(key)
        while len(_cache) > CACHE_MAX:
            _cache.popitem(last=False)


def cache_clear() -> None:
    with _lock:
        _cache.clear()
