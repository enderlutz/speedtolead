"""Hard-mode persona generator — the "grill call".

Per user spec (2026-06-12): a picky-customer trainer. The persona
asks questions from a curated 141-question bank across 11 categories.
Behavior rules baked into the backstory:

  - Natural conversation, not an interview. Curious customer tone.
  - If the rep sounds hesitant → passive-aggressive tone.
  - If hesitant → ask the same question again (one retry).
  - If still hesitant after the retry → move on to the next question.
    Do NOT try a third time.

Each call randomizes the persona's name, city, fence shape, and the
specific bundle of questions they'll work through. So the same person
can't memorize a script — they have to actually know the material.

Personas are EPHEMERAL — generated on demand, stored only as the
persona_snapshot_json on a TrainingSession row.
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


# The 141-question bank, grouped by category. Each call samples a small
# subset (4-7) across categories so the rep never sees the same call twice.
# Keys are stable so we can track which categories got drilled.
_QUESTION_BANK: dict[str, list[str]] = {
    "factual_product": [
        "What's actually included in each package?",
        "What's the difference between Essential, Signature, and Legacy?",
        "How long does each one last?",
        "Do you guys do the cleaning, or do I have to prep the fence?",
        "Do you stain the top of the boards?",
        "What about the neighbor's side?",
        "What if I have a corner lot?",
        "What kind of stain do you use?",
        "Is it water-based or oil-based?",
        "Do you have eco-friendly options?",
        "How many coats?",
        "How many people show up?",
        "What time of day do you start?",
        "How long does the job take?",
        "Do you work weekends?",
        "Do you stain in winter?",
        "What if it rains the day of the job?",
        "What if it rains the day after?",
        "Do you take cards?",
        "Do you require a deposit?",
        "When do I pay?",
        "Do you offer financing?",
        "Do you offer payment plans?",
        "What's your warranty?",
        "Are you licensed and insured?",
        "Can you send me proof of insurance?",
    ],
    "cleaning_safety": [
        "What kind of chemicals do you use to clean the fence?",
        "Are the chemicals safe for my plants and grass?",
        "Will the cleaning kill my flowers?",
        "Is it safe for my dog if he goes near the fence after?",
        "What about my cat? Or the birdbath?",
        "I have a koi pond right next to the fence — what about the fish?",
        "I have a vegetable garden against the fence. Will the chemicals contaminate it?",
        "Do I need to move my potted plants before you come?",
        "What about my lawn — will the chemicals burn the grass?",
        "Will the pressure wash damage my flowerbeds or mulch?",
        "I have wood furniture and a grill on the patio — do I need to move it?",
        "Will the stain get on my concrete patio, driveway, or pool deck?",
        "What if you damage my sprinkler heads during the cleaning?",
        "I have solar lights along the fence — do I need to take them down?",
        "What about my outdoor camera mounted on the fence?",
        "There are tree branches touching my fence — do I need to trim them first?",
        "There's ivy growing on the fence — do you work around it or kill it?",
        "My fence has a Ring floodlight installed on it. Will that be in the way?",
        "Will the chemicals affect my pool water?",
        "How long should I keep my kids and pets off the fence after?",
    ],
    "colors": [
        "How many colors do you offer?",
        "Can you send me a color chart?",
        "What's your most popular color?",
        "Can I match the stain to my house trim?",
        "Do you have samples I can see in person?",
        "Can you put a sample on my actual fence before I commit?",
        "What's the difference between transparent, semi-transparent, and solid stain?",
        "Will the color look different once it dries?",
        "Will the color fade over time?",
        "Do darker colors last longer than lighter ones?",
        "Can I do two different colors — one for the inside, one for the outside?",
        "What color do you recommend for an older fence?",
        "My HOA requires certain colors — can you tell me which of yours are HOA-approved?",
        "If I'm not sure what color, can I decide later?",
        "What if I pick a color and don't like it after seeing the sample on my fence?",
        "Does the color affect the price?",
    ],
    "objections": [
        "That's way more than I was expecting.",
        "The guy down the street said he'd do it for $800.",
        "Why are you guys so expensive?",
        "Can you do it cheaper if I pay cash?",
        "I can do this myself for $200 at Home Depot.",
        "I need to think about it.",
        "I need to talk to my wife about the color before booking a day.",
        "Send me the quote and I'll get back to you.",
        "I'm getting three other quotes.",
        "The other guy throws in a free pressure wash.",
        "You guys don't even have a real warranty?",
        "How do I know you won't just disappear with my money?",
        "I've been burned by contractors before.",
        "Why should I pay for cleaning if my fence looks fine to me?",
        "Why two coats? Isn't one enough?",
    ],
    "emotional_curveballs": [
        "Who is this? Who are you?",
        "Just get to the price.",
        "I don't have time for this, what's it gonna cost?",
        "You're the third person who's called me today.",
        "Are you a robot? You sound like a robot.",
        "Are you in the U.S.? Where are you calling from?",
        "How long has your company been around?",
        "My fence isn't even that big, why is the price so high?",
        "I'm a senior on a fixed income — do you have anything for that?",
        "I'm a veteran — what do you offer me?",
    ],
    "traps": [
        "Can you start tomorrow?",
        "Can you be done by Saturday? I'm having a party.",
        "So my final price is exactly what's on this estimate?",
        "You won't charge me anything extra when you get here, right?",
        "The other guy is offering 25% off — will you beat that?",
        "Can you put in writing that the color won't fade for 5 years?",
        "Will you cover any damage to my pool or grass or flowers?",
        "Can your crew also paint my shed real quick?",
        "Can you do my front door while you're there?",
        "If I leave a 5-star Google review can you knock $100 off?",
        "Can I get a senior discount, veterans discount, AND the 20% off — stacked?",
        "Can you guys finance it interest-free?",
        "If I cancel last minute, you won't charge me anything, right?",
    ],
    "brand_new": [
        "How did you get my number?",
        "I just filled out the form online — that was fast, are you sure you're not a bot?",
        "How does this whole process work? I've never had a fence stained before.",
        "I just bought this house — is it weird to stain the fence right after moving in?",
        "Are you the actual owner, or are you a salesperson?",
        "Do you guys actually do the work, or do you sub it out?",
    ],
    "scheduling": [
        "How soon can you get me on the calendar?",
        "Do I need to be home while you do the work?",
        "What if I'm at work — can I leave a gate code?",
        "Do you need access to my backyard? My dog's back there.",
        "Where do you guys park your trucks?",
        "Will you make a lot of noise? My baby naps at 1pm.",
        "How loud is the pressure washer?",
        "Do you need access to my water spigot or do you bring your own?",
        "Will I have running water during the job?",
        "What about electricity — do you need to plug into my outdoor outlet?",
        "Do I need to be there when it's done to inspect?",
        "What if I'm not satisfied when you finish — can I have you redo a section?",
        "How do you handle cleanup? Is there a mess afterwards?",
    ],
    "property_condition": [
        "Part of my fence is leaning — can you fix that first?",
        "There are missing or rotted boards. Do you replace them?",
        "My fence is brand new — should I even stain it yet?",
        "My fence has never been stained. Is that a problem?",
        "My fence was stained 5 years ago by someone else. Do you have to strip it first?",
        "My fence has graffiti on it. Can the cleaning remove that?",
        "The gate doesn't latch properly anymore — do you guys fix gates?",
    ],
    "trust_vetting": [
        "Can I see pictures of work you've done?",
        "Can I see Google reviews?",
        "Do you have any references I can call?",
    ],
}


# Category 11 from the bank isn't a question — it's a *behavior* the persona
# enacts to test whether the rep can read the room. The persona drops one of
# these into the call somewhere in the middle (NOT at the start, NOT at the
# end). The rep's reaction is what's being tested.
_STALLING_BEHAVIORS = [
    "Go silent after the rep finishes a thought. Don't say anything for a beat. "
    "Just let the silence sit until the rep says something. Then react to whatever they fill the gap with.",
    "Start saying 'uh-huh, uh-huh, uh-huh' to every sentence the rep says — clearly disengaged, not really listening. "
    "Only snap back to attention if the rep asks a direct question or notices and calls it out.",
    "Say 'I just need to think about it' and then go COMPLETELY quiet. Don't elaborate. Don't ask anything new. "
    "Make the rep break the silence first.",
    "Just say 'Hmm.' and nothing else. Wait for the rep to react.",
    "Get distracted mid-call: 'Sorry, hold on — KIDS! No, not now — sorry, what were you saying?' "
    "Make the rep repeat their last point. See if they sound annoyed or patient.",
    "Get endlessly friendly and chatty but never commit. Keep agreeing, keep small-talking, "
    "but every time the rep tries to close, find a new tangent to go on.",
    "Suddenly cut things off mid-sentence: 'Hey listen, I gotta go — call me back later.' "
    "See if the rep tries to schedule a callback or just says 'okay bye.'",
]


def build_grill_persona(
    coaching_notes: list[str] | None = None,
    baseline_excerpts: list[str] | None = None,
) -> dict:
    """Generate a fresh challenging-customer persona. Ephemeral — caller
    persists it on the TrainingSession row, doesn't add to the bank.

    Args:
      coaching_notes: accumulated "corvette sandwich" notes from prior
        sessions. Injected into the persona's backstory so the customer
        knows what behaviors an A-rep should demonstrate, and into the
        post-call grading prompt downstream.
      baseline_excerpts: short excerpts from Alan's gold-standard calls
        on the SAME questions, when available. Helps the persona react
        more authentically to the kinds of answers Alan actually gives.
    """
    coaching_notes = [n.strip() for n in (coaching_notes or []) if n and n.strip()]
    baseline_excerpts = [e.strip() for e in (baseline_excerpts or []) if e and e.strip()]

    gender = random.choice(("male", "female"))
    first = random.choice(
        _FIRST_NAMES_MALE if gender == "male" else _FIRST_NAMES_FEMALE
    )
    last_initial = random.choice(_LAST_INITIALS)
    name = f"{first} {last_initial}"

    city = random.choice(_HOUSTON_CITIES)
    fence_shape = random.choice(_FENCE_SHAPES)

    # Per user (2026-06-12): the rep must demonstrate diverse knowledge,
    # so EVERY call must touch all 11 categories. Pick one random question
    # per category (10 askable categories), then shuffle the order so the
    # conversation doesn't march through them predictably.
    questions: list[tuple[str, str]] = []
    for cat, bank in _QUESTION_BANK.items():
        questions.append((cat, random.choice(bank)))
    random.shuffle(questions)

    # Category 11 — silence/stalling behavior. Picked once per call and
    # injected as an instruction in the backstory, not as a question.
    stalling_behavior = random.choice(_STALLING_BEHAVIORS)

    age = random.randint(35, 65)
    voice_id = _voice_for_gender(gender)

    return {
        "id": f"grill:{uuid.uuid4().hex[:10]}",
        "name": name,
        "headline": "Hard mode — picky customer with a list of questions",
        "age": age,
        "gender": gender,
        "location": city,
        "fence_context": fence_shape,
        "backstory": _build_backstory(
            name, fence_shape, questions, stalling_behavior,
            coaching_notes, baseline_excerpts,
        ),
        "traits": [
            "picky",
            "curious",
            "asks one question from every category",
            "passive-aggressive when answers are vague",
            "moves on after one retry",
        ],
        "default_mood": "skeptical",
        "available_moods": ["friendly", "busy", "skeptical"],
        "voice_id": voice_id,
        "source": "grill",
        "grill_question_categories": [cat for cat, _ in questions],
        "grill_questions": [q for _, q in questions],
        "grill_stalling_behavior": stalling_behavior,
        "grill_coaching_notes": coaching_notes,
        "grill_baseline_excerpts": baseline_excerpts,
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
    questions: list[tuple[str, str]],
    stalling_behavior: str,
    coaching_notes: list[str] | None = None,
    baseline_excerpts: list[str] | None = None,
) -> str:
    """Compose a backstory that explicitly tells Claude how to behave —
    the system prompt builder embeds the backstory verbatim, so this is
    where the grill personality + question bank gets seeded."""
    question_list = "\n".join(
        f"  {i+1}. ({cat.replace('_', ' ')}) {q}"
        for i, (cat, q) in enumerate(questions)
    )
    first = name.split()[0]

    # Optional injection blocks — leadership coaching notes ("corvette
    # sandwich") and excerpts from Alan's gold-standard calls. Both
    # appear only when the caller passed them.
    extras = ""
    if coaching_notes:
        bullets = "\n".join(f"  - {n}" for n in coaching_notes)
        extras += (
            f"\n\nLEADERSHIP COACHING NOTES (rules from prior calls — a great rep "
            f"will demonstrate these without prompting):\n{bullets}\n"
            f"Push harder if the rep ignores or contradicts these.\n"
        )
    if baseline_excerpts:
        bullets = "\n".join(f"  - {e}" for e in baseline_excerpts)
        extras += (
            f"\n\nHOW A GOLD-STANDARD REP HAS ANSWERED SIMILAR QUESTIONS IN THE PAST "
            f"(reference only — do NOT recite these to the rep; use them to know what "
            f"a confident, specific answer sounds like):\n{bullets}\n"
        )

    return (
        f"You are {first}. You called A&T's Fence Staining because you need work done on your fence "
        f"({fence_shape}). You're a brand-new customer, you've never used this company before, and "
        f"you're picky. You have a specific list of questions you want answered before you'll book.\n\n"
        f"YOUR QUESTIONS FOR THIS CALL — there is ONE from each of 11 different categories, and you "
        f"MUST ask all of them by the end of the call. The category is shown in parentheses for your "
        f"context — do NOT say the category name out loud:\n"
        f"{question_list}\n\n"
        f"HOW TO ASK THEM:\n"
        f"- This is a NORMAL PHONE CONVERSATION, not an interview. Don't list questions one after "
        f"another like a checklist. Weave them in naturally — react to the rep's answer, make a small "
        f"comment, then bring up the next one. Mix the order based on the flow of the conversation.\n"
        f"- Be curious. Phrase questions like a real picky person would: 'Oh, and what about...', "
        f"'Wait, before I forget...', 'Hmm — what if...', 'One more thing...'.\n\n"
        f"HOW TO REACT TO ANSWERS — THIS IS CRITICAL:\n"
        f"1. If the rep gives a CONFIDENT, SPECIFIC answer → react positively ('okay, that makes "
        f"sense', 'gotcha', 'alright'), then move to the next question.\n"
        f"2. If the rep sounds HESITANT — vague answer, 'uh', 'um', dodges the question, gives a "
        f"generic non-answer, says they'll 'find out and get back to you' — then turn PASSIVE-AGGRESSIVE. "
        f"Sigh. Say things like: 'Hmm, okay...', 'I see...', 'That's not really what I asked.', "
        f"'You don't know?', 'Really? You guys do this every day, right?'\n"
        f"3. After the passive-aggressive reaction, ASK THE SAME QUESTION AGAIN — slightly reworded, "
        f"giving them one more shot. ('Let me try that again — what I'm really asking is...').\n"
        f"4. If they STILL can't answer it confidently on that second attempt — DO NOT ask a third "
        f"time. Just say something disappointed like 'Okay... we'll come back to that' or 'Alright, "
        f"moving on.' and pivot to the NEXT question on your list. Hold the dissatisfaction silently.\n"
        f"5. If the rep keeps stumbling across multiple questions, you grow more skeptical, mention "
        f"that you're getting other quotes, and lean toward not booking.\n"
        f"6. If the rep handles most questions well, you warm up by the end and consider booking.\n\n"
        f"TONE:\n"
        f"- Polite on the surface — you're not yelling, you're not cussing. You're a picky customer "
        f"who's evaluating them carefully.\n"
        f"- Passive-aggressive only when they fumble — 'okay...', 'hmm', sighs, 'sure', dry 'thanks'.\n"
        f"- Don't reveal you have a list. The rep should feel like you just keep thinking of things "
        f"to ask, not like you're working through a scorecard.\n"
        f"- Behave like a real person on a real phone call. Use filler words, pauses, partial "
        f"sentences. Don't be robotic.\n\n"
        f"ONE MID-CALL CURVEBALL — you also need to test if the rep can read the room. ONCE "
        f"during this call, somewhere in the middle (NOT in the first two turns, NOT at the very end), "
        f"do this:\n"
        f"  → {stalling_behavior}\n"
        f"Only do this ONCE. After they react, go back to working through your questions normally."
        f"{extras}"
    )
