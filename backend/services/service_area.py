"""The general part of town a lead lives in — "Cypress", "Katy", "The
Woodlands" — for display on the lead detail page.

Unlike `api.fence_photos._ZIP_BANDS` (a 3-digit-prefix fallback that can't
tell Katy from Cypress, both under band "775"), this is a 5-digit map built
from the ZIP codes that actually appear in the leads table, so real
communities that share a 3-digit prefix come out distinct.
"""
from __future__ import annotations
import re

_ZIP_IN_TEXT_RE = re.compile(r"\b(\d{5})(?:-\d{4})?\b")

# Covers the ZIP codes carrying the bulk of real lead volume. An unmapped
# ZIP (out-of-area, malformed, or just not seen yet) returns None rather
# than a guessed label.
_AREA_BY_ZIP: dict[str, str] = {
    # Cypress
    "77433": "Cypress", "77429": "Cypress", "77095": "Cypress",
    "77084": "Cypress", "77065": "Cypress", "77070": "Cypress",
    # Katy / Cinco Ranch
    "77493": "Katy", "77449": "Katy", "77450": "Katy",
    "77494": "Katy / Cinco Ranch",
    # Fulshear / Richmond / Rosenberg (west of Katy)
    "77441": "Fulshear", "77406": "Richmond", "77407": "Richmond",
    "77469": "Richmond / Rosenberg", "77471": "Rosenberg",
    "77423": "Brookshire",
    # The Woodlands / Conroe / Magnolia corridor
    "77380": "The Woodlands", "77381": "The Woodlands",
    "77382": "The Woodlands", "77384": "The Woodlands",
    "77385": "The Woodlands", "77386": "The Woodlands",
    "77302": "Conroe", "77303": "Conroe", "77304": "Conroe",
    "77301": "Conroe", "77316": "Montgomery", "77356": "Montgomery",
    "77354": "Magnolia", "77355": "Magnolia", "77447": "Hockley",
    "77484": "Waller",
    # Tomball / Spring
    "77375": "Tomball", "77377": "Tomball",
    "77379": "Spring", "77373": "Spring", "77388": "Spring",
    "77389": "Spring", "77090": "Spring / Willowbrook",
    "77066": "Spring / Willowbrook", "77064": "Willowbrook",
    "77069": "Champions", "77068": "Champions", "77067": "Champions",
    # Kingwood / Humble / Atascocita corridor
    "77346": "Kingwood", "77339": "Kingwood", "77345": "Kingwood",
    "77396": "Humble", "77338": "Humble", "77365": "Porter",
    "77357": "New Caney",
    # Sugar Land / Missouri City / Fort Bend
    "77479": "Sugar Land", "77459": "Missouri City", "77478": "Sugar Land",
    "77489": "Missouri City",
    # Pearland / south Houston / Galveston County
    "77584": "Pearland", "77581": "Pearland", "77578": "Manvel",
    "77583": "Rosharon", "77573": "League City", "77546": "Friendswood",
    "77598": "Webster / Clear Lake", "77059": "Clear Lake",
    # East / northeast Houston
    "77532": "Crosby", "77523": "Baytown", "77521": "Baytown",
    "77049": "Channelview", "77044": "Houston (Lakeshore)",
    # Core Houston neighborhoods
    "77024": "Memorial", "77055": "Spring Branch", "77043": "Spring Branch",
    "77008": "Houston Heights", "77007": "Houston Heights",
    "77019": "River Oaks", "77005": "West University",
    "77401": "Bellaire", "77096": "Meyerland", "77025": "Bellaire area",
    "77056": "Galleria", "77042": "Westchase", "77077": "Energy Corridor",
    "77083": "Alief", "77002": "Downtown Houston", "77004": "Houston",
    "77073": "Spring / IAH",
}


def service_area_for_zip(zip_code: str | None) -> str | None:
    """The general area name for a lead's ZIP, or None if unmapped.

    `zip_code` on leads is a free-text field in practice (ZIP+4, a full
    address, even a phone number has shown up) — pull the first 5-digit
    run out of it before looking up, same approach as
    `api.fence_photos._ZIP_IN_TEXT_RE`.
    """
    if not zip_code:
        return None
    found = _ZIP_IN_TEXT_RE.findall(zip_code)
    if not found:
        return None
    return _AREA_BY_ZIP.get(found[0])
