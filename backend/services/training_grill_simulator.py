"""Hard-mode persona generator — the "grill call".

Per user request (2026-06-12): on top of the conversion-modeled bank,
we need a button that generates a random *challenging* customer on
the fly. Designed as a sanity check on a new hire — can they actually
hold their own against an informed, well-researched buyer who asks a
lot of detailed questions?

Personality dial:
  - Informed (knows the trade vocabulary, has read up)
  - Passive-aggressive when answers are vague — not mean, just doubtful
  - Asks LOTS of detailed questions
  - References online research, neighbors, competitor quotes
  - Will book if grilled successfully, walk if not

Each call randomizes the persona's name, city, fence shape, the
specific question categories they'll focus on, and the competitor
quote they'll throw at the rep. So the same person can't memorize
answers — they have to actually know the material.

Personas are EPHEMERAL — generated on demand, stored only as the
persona_snapshot_json on a TrainingSession row. We don't pollute the
TrainingPersonaBank with them; they're meant to be one-shot tests.
"""
from __future__ import annotations
import random
import uuid


# Plausible Houston-area names. Mixed first names so the gender heuristic
# in elevenlabs_client can pick the right voice pool.
_FIRST_NAMES_MALE = [
    "James", "Robert", "Michael", "David", "Richard", "Thomas",
    "Charles", "Steven", "Kenneth", "Edward", "Brian", "Ronald",
    "Anthony", "Kevin", "Jason", "Jeffrey", "Ryan", "Stephen",
    "Frank", "Gregory",
]
_FIRST_NAMES_FEMALE = [
    "Patricia", "Linda", "Barbara", "Elizabeth", "Susan", "Nancy",
    "Karen", "Lisa", "Carol", "Sandra", "Margaret", "Sharon",
    "Donna", "Michelle", "Laura", "Cynthia", "Pamela", "Christine",
    "Helen", "Catherine",
]
_LAST_INITIALS = [
    "K.", "P.", "M.", "S.", "T.", "B.", "L.", "G.", "H.", "C.",
    "W.", "R.", "D.", "F.", "J.",
]

_HOUSTON_CITIES = [
    "Cypress", "Katy", "Spring", "The Woodlands", "Sugar Land",
    "Pearland", "Tomball", "Conroe", "Kingwood", "Magnolia",
    "Stafford", "Missouri City",
]

_FENCE_SHAPES = [
    "~180 ft of cedar privacy fence, ~6 years old, mostly weathered gray with a few warped pickets",
    "~240 ft of cedar privacy fence on a corner lot, ~9 years old, never stained",
    "~120 ft of cedar privacy fence around the back yard only, ~4 years old, lightly faded",
    "~300 ft of cedar privacy fence wrapping the whole property, ~7 years old, partial mildew on the north side",
    "~150 ft of cedar privacy fence, ~3 years old, sealed once when the house was new — wants to extend that",
    "~200 ft of cedar privacy fence next to a pool, ~5 years old, chlorine exposure on one side",
]

_OTHER_QUOTES = [
    {"competitor": "the company that did my neighbor's fence", "amount": 1250},
    {"competitor": "a guy off Nextdoor", "amount": 950},
    {"competitor": "ABC Staining", "amount": 1450},
    {"competitor": "the one in the Home Depot ad", "amount": 1675},
    {"competitor": "Lone Star Fence Pros", "amount": 1300},
    {"competitor": "my brother-in-law who used to do this", "amount": 850},
]

# Question categories the grill persona will focus on. We pick 2-3 per
# call so each grill call has a different angle. The wording in each
# category gets baked into the persona's backstory so Claude knows
# what to drill on.
_QUESTION_CATEGORIES = [
    {
        "key": "materials",
        "label": "obsessed with materials",
        "concerns": (
            "What stain brand do they use — is it actually high-quality or just the cheapest one "
            "the supplier had? What's the difference between semi-transparent and solid? Does it "
            "include UV inhibitors? Will the color match if you ever add a section?"
        ),
    },
    {
        "key": "process",
        "label": "asks about every step of the process",
        "concerns": (
            "How long does prep take? Do they pressure-wash, sand, or just spray? How many coats? "
            "What's the drying time between coats? What if it rains within 24 hours? Will they "
            "come back for free if the weather messes it up?"
        ),
    },
    {
        "key": "warranty",
        "label": "wants ironclad warranty terms",
        "concerns": (
            "How long is the warranty? What's covered — peeling? Fading? Mildew? What VOIDS the "
            "warranty? Do they put it in writing? Have they ever had to honor a claim, and how did "
            "they handle it? Will they send a copy of the warranty BEFORE booking?"
        ),
    },
    {
        "key": "competition",
        "label": "comparison-shopping aggressively",
        "concerns": (
            "Why are they more expensive than the competitor's quote? What exactly are they doing "
            "different? Can they price-match? Who else has Diana / Tom / their neighbor used? Who's "
            "the cheapest, who's the best, and where does this company sit?"
        ),
    },
    {
        "key": "credentials",
        "label": "vetting credentials",
        "concerns": (
            "Are they licensed? Insured? For how much? Bonded? How long have they been in business? "
            "How many employees vs subcontractors? Does the same crew that quotes also do the work? "
            "BBB rating? Google reviews? Will they share a recent customer's contact info?"
        ),
    },
    {
        "key": "scheduling",
        "label": "particular about scheduling",
        "concerns": (
            "When can they actually start? Will the SAME PERSON who quoted be on-site? How many "
            "days of work? What if they need to push? Can they work around the dog, the kids' "
            "schedule, or the patio furniture? What happens if a crew member calls out?"
        ),
    },
    {
        "key": "specifics",
        "label": "fixated on specific edge cases",
        "concerns": (
            "What about the gate hinges — will they paint over them or remove them? The dog door "
            "in the back? The HVAC condenser the fence wraps around? The neighbor's side that "
            "they share — do they need permission? Will they tape off the landscaping?"
        ),
    },
]


def build_grill_persona() -> dict:
    """Generate a fresh challenging-customer persona. Ephemeral — caller
    persists it on the TrainingSession row, doesn't add to the bank."""
    # Gender + name (drives voice selection downstream)
    gender = random.choice(("male", "female"))
    first = random.choice(
        _FIRST_NAMES_MALE if gender == "male" else _FIRST_NAMES_FEMALE
    )
    last_initial = random.choice(_LAST_INITIALS)
    name = f"{first} {last_initial}"

    city = random.choice(_HOUSTON_CITIES)
    fence_shape = random.choice(_FENCE_SHAPES)
    quote = random.choice(_OTHER_QUOTES)

    # Pick 2-3 question categories so each call grills on different angles
    n_focus = random.randint(2, 3)
    focus_areas = random.sample(_QUESTION_CATEGORIES, n_focus)

    age = random.randint(35, 65)
    voice_id = _voice_for_gender(gender)

    return {
        "id": f"grill:{uuid.uuid4().hex[:10]}",
        "name": name,
        "headline": "Hard mode — informed buyer who'll grill you on every detail",
        "age": age,
        "gender": gender,
        "location": city,
        "fence_context": fence_shape,
        "backstory": _build_backstory(name, fence_shape, quote, focus_areas),
        "traits": [
            "informed",
            "asks a lot of questions",
            "passive-aggressive when unsatisfied",
            "well-researched",
            *[f["label"] for f in focus_areas],
        ],
        "default_mood": "skeptical",
        "available_moods": ["friendly", "busy", "skeptical"],
        "voice_id": voice_id,
        "source": "grill",
        "grill_focus_keys": [f["key"] for f in focus_areas],
        "competitor_quote": quote,
    }


def _voice_for_gender(gender: str) -> str:
    """Pick a voice that fits the persona's inferred gender. Same pools
    as the conversion seeder so the catalog is consistent."""
    if gender == "female":
        return random.choice(["domi_midage", "bella_busy"])
    return random.choice(["adam_mature", "antoni_warm", "sam_young"])


def _build_backstory(
    name: str,
    fence_shape: str,
    quote: dict,
    focus_areas: list[dict],
) -> str:
    """Compose a backstory that explicitly tells Claude how to behave —
    the system prompt builder embeds the backstory verbatim, so this is
    where the grill personality gets seeded."""
    concerns = "\n".join(f"- {f['concerns']}" for f in focus_areas)
    first = name.split()[0]
    return (
        f"You are {first}. You called Sterling Fence Staining because you need work done on your fence "
        f"({fence_shape}). You've already gotten a quote from {quote['competitor']} — they said about "
        f"${quote['amount']}.\n\n"
        f"PERSONALITY (this is HARD MODE — you are deliberately a difficult customer):\n"
        f"- You've done your homework. You've read articles, you've talked to neighbors, you know the "
        f"vocabulary. You'll show off this knowledge by asking detailed questions.\n"
        f"- You're passive-aggressive when the rep gives a vague answer. Sigh. Say 'hmm', 'okay...', "
        f"'I see', 'that's interesting' — but say them in a way that conveys doubt, not enthusiasm.\n"
        f"- You're not MEAN. You're polite, you say 'thanks for explaining' between objections — but "
        f"you keep coming back to your questions until they're answered satisfactorily.\n"
        f"- You will NOT book on the first vague answer. You need each of your concerns addressed "
        f"with confidence and specifics.\n"
        f"- If the rep stumbles or gives generic answers, you start mentioning that the {quote['competitor']} "
        f"already answered these clearly and you're leaning toward them.\n"
        f"- If the rep ANSWERS WELL — with specifics, confidence, and shows they know the trade — you "
        f"can soften and eventually book. A well-prepared rep CAN close you. An unprepared one CANNOT.\n\n"
        f"WHAT YOU'LL DRILL ON THIS CALL:\n{concerns}\n\n"
        f"Behave like a real person on a real phone call. Don't list all your questions at once — "
        f"weave them in naturally, react to each answer before going to the next one, and keep your "
        f"tone civil but unimpressed until they earn your trust."
    )
