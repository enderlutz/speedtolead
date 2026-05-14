"""
Ad attribution — apply a GHL tag based on which form the lead submitted.

Replaces Alan's GHL workflows P02a-d. Each ad creative has its own form
in GHL named like `WALK OUTSIDE 5/11/2026`. When the lead comes in, we
match the form name against this map (exact match) and apply the
corresponding tag to the GHL contact.

EXACT-MATCH semantics — every time Alan launches a new ad creative
(new form name with a fresh date), the map needs an entry added here
and a redeploy. This is a deliberate trade-off: Alan tests new creative
infrequently (every few weeks) and the explicit map prevents accidental
mis-tagging if a form is renamed.

To add a new ad form:
  1. Get the exact form name from GHL.
  2. Add a `"<form name>": "<tag>"` entry below.
  3. Redeploy.
"""
from __future__ import annotations
import logging
from services.ghl import add_contact_tag

logger = logging.getLogger(__name__)


# Form name → GHL tag. Form names are matched EXACTLY (case-sensitive)
# against payload.formName. Tag spellings (including the quotes around
# "see this grey" / "walk outside" but no quotes for the premium ones)
# match Alan's GHL workflow vocabulary verbatim — don't "tidy" them.
# Update each time Alan launches a new ad creative.
FORM_NAME_TO_TAG: dict[str, str] = {
    # Active ads — 5/11/2026 launch
    "FENCE REVIVE-FULL DETAIL -GREY - SEE THIS GREY AD 5/11/2026-copy": 'ad from "see this grey"',
    "FENCE REVIVE-FULL DETAIL -GREY - WALK OUTSIDE AD 5/11/2026":       'ad from "walk outside"',
    "FENCE REVIVE-FULL DETAIL -PREMIUM AD 5/11/2026":                   "ad from premium 1",
    "FENCE REVIVE-FULL DETAIL -PREMIUM 2 AD 5/11/2026-":                "ad from premium 2",
}


def tag_for_form_name(form_name: str) -> str:
    """Return the GHL tag for `form_name` (exact match). Empty string if no
    map entry exists — caller should skip tagging in that case."""
    if not form_name:
        return ""
    return FORM_NAME_TO_TAG.get(form_name, "")


def apply_ad_tag(contact_id: str, form_name: str, location_id: str | None = None) -> str:
    """Apply the mapped GHL tag for `form_name`. Returns the tag that was
    applied (or empty string if no match / no contact_id). Best-effort —
    a GHL failure logs a warning but doesn't raise."""
    tag = tag_for_form_name(form_name)
    if not tag or not contact_id:
        return ""
    try:
        ok = add_contact_tag(contact_id, tag, location_id=location_id)
        if ok:
            logger.info(f"P02 ad attribution: tagged contact {contact_id} with '{tag}' (form '{form_name}')")
            return tag
        logger.warning(f"P02 ad attribution: tag add returned false for {contact_id} ({form_name})")
        return ""
    except Exception as e:
        logger.warning(f"P02 ad attribution failed for {contact_id} ({form_name}): {e}")
        return ""
