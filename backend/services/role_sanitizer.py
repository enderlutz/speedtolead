"""
Role-aware text sanitization for free-form fields shown to workers.

Why this exists: scheduled-job descriptions and Google Calendar event
descriptions are free text that admins write for customers + the team.
They often contain pricing info, proposal URLs, and sales vocabulary
("Your Estimate", "Proposal: …") that workers shouldn't see when the
same text is rendered on the worker dashboard.

This module's one job: take a raw description string + return a
worker-safe version. Idempotent — running it twice produces the same
output as running it once.
"""
from __future__ import annotations
import re


# $1,859 / $1859.00 / $ 1859. The first digit group is \d+ (not \d{1,3})
# because plain numbers without thousands separators can be any length —
# \d{1,3} would only consume the first three digits of "$1859" leaving
# "9" behind. Trailing "+ tax" or "+ tax-" gets eaten too so the
# leftover doesn't start with a dangling dash mid-sentence.
_DOLLAR_PATTERN = re.compile(
    r"\$\s?\d+(?:,\d{3})*(?:\.\d{1,2})?(?:\s*\+\s*tax\s*-?\s*)?",
    re.IGNORECASE,
)

# proposal.atpressurewash.com URLs (any scheme, any path). These point
# to the customer-facing proposal page which exposes the price.
_PROPOSAL_URL_PATTERN = re.compile(
    r"https?://(?:www\.)?proposal\.atpressurewash\.com\S*",
    re.IGNORECASE,
)

# Sales vocabulary that gives away the customer-facing framing. Stripped
# inline; trailing punctuation / hyphens get cleaned in the post-pass.
_KEYWORDS_PATTERN = re.compile(
    r"\b(estimate|proposal|quote)\b",
    re.IGNORECASE,
)


def sanitize_for_worker(text: str) -> str:
    """Return a copy of `text` with worker-unsafe info stripped:
      - dollar amounts (and a trailing "+ tax" if present)
      - proposal.atpressurewash.com URLs
      - sales vocabulary ("estimate" / "proposal" / "quote")
    Then collapse the whitespace + empty lines that the strips leave
    behind so the result reads cleanly. Empty input passes through."""
    if not text:
        return text or ""

    out = _DOLLAR_PATTERN.sub("", text)
    out = _PROPOSAL_URL_PATTERN.sub("", out)
    out = _KEYWORDS_PATTERN.sub("", out)

    # Punctuation cleanup — handles leftovers from the strips above so
    # the output doesn't read like "X. . Y" or trail with " : ".
    out = re.sub(r"\.\s*\.", ".", out)           # ". ." → "."
    out = re.sub(r":\s*([.\n])", r"\1", out)     # stranded ": " before . or \n
    out = re.sub(r":\s*$", "", out, flags=re.MULTILINE)  # ": " at end of line

    # Cleanup pass — HORIZONTAL whitespace only ([ \t]), never \s.
    # \s matches newlines too; using it here would eat blank lines and
    # the leading bullets ("• Cleaning of fence" → "Cleaning of fence").
    out = re.sub(r"[ \t]{2,}", " ", out)         # multi-space → single
    out = re.sub(r"[ \t]+\n", "\n", out)         # trailing line whitespace
    out = re.sub(r"\n[ \t]+\n", "\n\n", out)     # whitespace-only lines → blank
    out = re.sub(r"\n{3,}", "\n\n", out)         # 3+ blanks → 1 blank
    return out.strip()
