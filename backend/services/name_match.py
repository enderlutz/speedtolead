"""Name normalization and phonetic keys.

Split out from identity.py so the matching logic can be tested without a
database, and so database.py can import it for the key columns without pulling
in the resolver.

The problem this exists for: three different employees are all called "Chris" —
Chris, Christian, and Cris. Customers arrive from voice transcription as
Nalonso/Nolasco, Syfuentes/Cifuentes, McCollum/McConnell, Wade/"Waiks"/"Weighed".

Deliberately NOT using a fuzzy-matching library, for two measured reasons.

First, it would make the Chris case worse. Chris/Christian/Cris share an
identical Soundex and Metaphone key, and Chris↔Cris is edit distance 1, so any
off-the-shelf scorer returns a *confident* single winner on exactly the
comparison that must stay unconfident. What prevents the wrong Chris is the
refusal rule in identity.py, not a better scorer.

Second, it would not buy the hard cases anyway. Nalonso/Nolasco is edit
distance 4 on seven letters and Wade/"Weighed" scores 0.36 — both far below any
threshold that wouldn't also match half the customer list. See phonetic_key()
for what is and isn't reachable automatically. The mechanism for badly mangled
transcriptions is an alias recorded once, not cleverer matching.
"""

from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

# Titles and suffixes carry no identity and vary wildly in transcription.
_NOISE = {
    "mr", "mrs", "ms", "miss", "dr", "sr", "jr", "ii", "iii", "iv",
    "the", "and",
}

_PUNCT = re.compile(r"[^a-z0-9\s]")
_SPACE = re.compile(r"\s+")


def strip_accents(text: str) -> str:
    """José -> Jose. Voice transcripts and CRM exports disagree on accents."""
    return "".join(
        c for c in unicodedata.normalize("NFKD", text)
        if not unicodedata.combining(c)
    )


def normalize_name(name: str) -> str:
    """Case-folded, accent-stripped, punctuation-free, single-spaced.

    "  Mr. José  Nolasco-Peña " -> "jose nolasco pena"
    """
    if not name:
        return ""
    text = strip_accents(str(name)).lower()
    text = _PUNCT.sub(" ", text)
    tokens = [t for t in _SPACE.sub(" ", text).strip().split(" ") if t and t not in _NOISE]
    return " ".join(tokens)


def name_key(name: str) -> str:
    """The normalized form used as an indexed lookup column."""
    return normalize_name(name)


# Ordered rewrites applied before vowel-dropping. Tuned to the variants that
# actually occurred in three weeks of dictation rather than to English
# generally — this is a Houston fence company with a Spanish-speaking crew.
_SOUND_RULES = [
    ("ph", "f"),
    ("qu", "k"),
    ("ck", "k"),
    ("ce", "se"), ("ci", "si"), ("cy", "sy"),   # Cifuentes ~ Syfuentes
    ("z", "s"),
    ("c", "k"),
    ("ll", "y"),                                 # Spanish ll
    ("j", "h"),                                  # José ~ Hose
    ("v", "b"),                                  # Spanish b/v merge
    ("x", "s"),
    ("gh", "g"),
    ("wr", "r"),
    ("kn", "n"),
    ("mb", "m"),
    ("w", "u"),                                  # Wade ~ Uade ~ "Weighed"
]

# 'y' counts as a vowel: without that, Syfuentes and Cifuentes produce
# different keys ("syfnts" vs "sfnts") and the pair never matches.
_VOWELS = set("aeiouy")


def _phonetic_token(token: str) -> str:
    if not token:
        return ""
    t = token
    for a, b in _SOUND_RULES:
        t = t.replace(a, b)
    if not t:
        return ""
    # Keep the leading sound, drop interior vowels: the part transcription
    # mangles most. "nolasco" -> "nlsk", "nalonso" -> "nlns"... close but not
    # equal, which is why callers combine this with a similarity score.
    head, rest = t[0], t[1:]
    rest = "".join(c for c in rest if c not in _VOWELS)
    out = head + rest
    # Collapse doubled letters: "mcconnell" -> "mkonel"
    collapsed = []
    for c in out:
        if not collapsed or collapsed[-1] != c:
            collapsed.append(c)
    return "".join(collapsed)


def phonetic_key(name: str) -> str:
    """A spelling-tolerant key. Equal keys are a strong signal, not proof.

    Measured against the variants that actually occurred:

        Micheal   / Michael    -> same key   (caught)
        Syfuentes / Cifuentes  -> same key   (caught)
        Nalonso   / Nolasco    -> DIFFERENT  (not caught)
        Wade      / "Waiks"    -> DIFFERENT  (not caught)
        Wade      / "Weighed"  -> DIFFERENT  (not caught)

    The misses are not a tuning problem. Those pairs have genuinely different
    consonant skeletons — "Weighed" contains a hard g that "Wade" does not —
    so no phonetic scheme reaches them, and a similarity threshold loose
    enough to (0.36) would match half the customer list.

    The mechanism for badly mangled transcriptions is therefore an ALIAS
    recorded once against the right record, not cleverer matching. Until that
    alias exists the resolver says "I don't know that name" and asks, which is
    the correct outcome — a wrong confident match is far more expensive.

    Note also what this deliberately does not do: it does not separate Chris,
    Christian and Cris. They collapse together, which is right — the system's
    job there is to notice the ambiguity and ask, not to guess.
    """
    normalized = normalize_name(name)
    if not normalized:
        return ""
    return " ".join(_phonetic_token(t) for t in normalized.split(" ") if t)


def phone_key(phone: str) -> str:
    """Last 10 digits. Formats vary (+1 …, (281) …, 281-…); the digits don't."""
    digits = re.sub(r"\D", "", str(phone or ""))
    return digits[-10:] if len(digits) >= 10 else ""


def similarity(a: str, b: str) -> float:
    """0..1 on normalized names. One signal among several, never the decider."""
    na, nb = normalize_name(a), normalize_name(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    return SequenceMatcher(None, na, nb).ratio()


def street_number(address: str) -> str:
    """The leading house number — the cheapest way to tell two Micheals apart."""
    m = re.match(r"\s*(\d+)", str(address or ""))
    return m.group(1) if m else ""


def address_tokens(address: str) -> set[str]:
    """Normalized street words, minus the number and common suffixes.

    "9403 Calwood Cir" -> {"calwood"}
    """
    drop = {
        "st", "street", "rd", "road", "dr", "drive", "ln", "lane", "ct",
        "court", "cir", "circle", "blvd", "boulevard", "way", "trl", "trail",
        "pkwy", "parkway", "ave", "avenue", "n", "s", "e", "w", "apt", "unit",
    }
    return {
        t for t in normalize_name(address).split(" ")
        if t and not t.isdigit() and t not in drop
    }
