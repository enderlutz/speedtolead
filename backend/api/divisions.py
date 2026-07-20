"""Division scoping — the company runs two divisions on one dashboard:
"fence" (Sterling Fence Staining, the original/default) and "brick" (Sterling
Brick Staining). The frontend sends the active division on every request via the
`X-Division` header; endpoints that are division-aware take `Depends(get_division)`
and filter their queries by it. Absent/unknown header → "fence", so every
existing caller (and every non-brick user) is unaffected.
"""
from fastapi import Header

VALID_DIVISIONS = ("fence", "brick")
DEFAULT_DIVISION = "fence"


def get_division(x_division: str = Header(default=DEFAULT_DIVISION)) -> str:
    d = (x_division or "").strip().lower()
    return d if d in VALID_DIVISIONS else DEFAULT_DIVISION
