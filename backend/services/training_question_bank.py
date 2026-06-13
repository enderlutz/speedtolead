"""Shared customer-question bank for the voice training simulator.

The same ~130-question corpus is used by:
  - training_grill_simulator: picks 1 random question per category for a
    realistic picky-customer call.
  - training_spitfire_simulator: works through the FULL list rapid-fire
    so reps can practice their answers end-to-end.

Keeping it here means the two callers can never drift, and any future
mode (audio-only flashcards, written self-quiz, etc.) can grab the same
questions without copy-paste.

The 11 categories mirror the user's source document (2026-06-12). Ten
buckets are "askable" customer questions; the eleventh — silence /
stalling behaviors — is in STALLING_BEHAVIORS because those are things
the persona *does* during a call, not things it *says*.
"""
from __future__ import annotations


QUESTION_BANK: dict[str, list[str]] = {
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


# Category 11 from the user's source doc — behavioral cues, not questions.
# Used by the grill persona once per call to test if the rep can read the
# room. NOT used in spitfire mode (which is pure Q→A drilling).
STALLING_BEHAVIORS: list[str] = [
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


def total_question_count() -> int:
    """Count of all askable questions across the bank. Used by UI copy."""
    return sum(len(qs) for qs in QUESTION_BANK.values())
