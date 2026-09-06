#!/usr/bin/env python3
"""Fail the build if a broken date shape comes back.

Four different answers to "what is today in Central" once coexisted in this
codebase — a correct ZoneInfo one, a hand-rolled `is_dst = 3 <= month <= 10`
guess, hardcoded -5/-6 offsets that disagreed with each other, and a function
named `_today()` that returned UTC. They were consolidated into clock.py.

This guard exists so they cannot creep back. It deliberately does NOT flag the
~48 duplicate `_now()` definitions: those are byte-identical and correct, so
they cannot disagree with each other. Only shapes that CAN be wrong are listed.

    python scripts/check_time.py          # from backend/
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
SCAN_DIRS = ("api", "services")
SCAN_FILES = ("main.py", "database.py", "config.py")
SKIP_PARTS = {".venv", "__pycache__", "migrations", "tests", "scripts"}

# Each rule: (name, compiled regex, why it's wrong)
RULES = [
    (
        "naive-now",
        re.compile(r"\bdatetime\.now\(\s*\)"),
        "datetime.now() reads the server clock, which is UTC in production. "
        "Use clock.now_utc() for an instant or clock.now_ct() for Houston time.",
    ),
    (
        "dst-guess",
        re.compile(r"\bis_dst\b"),
        "Hand-rolled DST guesses are wrong for about two weeks a year. "
        "Use clock.today_ct_iso() / clock.now_ct().",
    ),
    (
        "hardcoded-offset",
        re.compile(r"timedelta\(\s*hours\s*=\s*-?\s*[56]\s*\)"),
        "A fixed -5/-6 offset is only right for part of the year, and the two "
        "halves of this codebase used to disagree about which. Use clock.",
    ),
    (
        "utc-date-string",
        re.compile(r"now\(\s*timezone\.utc\s*\)\s*\.strftime\(\s*[\"']%Y-%m-%d"),
        "Formatting a UTC instant as a date gives TOMORROW after 6 PM Houston. "
        "Use clock.today_ct_iso().",
    ),
]

# Lines carrying this marker are allowed — for the rare deliberate exception.
ALLOW = "clock-check: allow"


def iter_files():
    for name in SCAN_FILES:
        p = BACKEND / name
        if p.exists():
            yield p
    for d in SCAN_DIRS:
        root = BACKEND / d
        if not root.exists():
            continue
        for p in sorted(root.rglob("*.py")):
            if SKIP_PARTS & set(p.parts):
                continue
            yield p


def main() -> int:
    failures = []
    for path in iter_files():
        rel = path.relative_to(BACKEND)
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            if ALLOW in line:
                continue
            for name, regex, why in RULES:
                if regex.search(line):
                    failures.append((rel, lineno, name, line.strip(), why))

    if not failures:
        print(f"check_time: clean ({sum(1 for _ in iter_files())} files scanned)")
        return 0

    print(f"check_time: {len(failures)} problem(s)\n")
    for rel, lineno, name, snippet, why in failures:
        print(f"  {rel}:{lineno}  [{name}]")
        print(f"      {snippet}")
        print(f"      {why}\n")
    print("If one is genuinely intended, append a trailing comment "
          f"'# {ALLOW}' to that line.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
