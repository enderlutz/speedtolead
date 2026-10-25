// Every follow-up GHL runs today, read off Alan's six screen recordings of
// the GHL workflows (2026-10-24). This is the "before" picture for moving
// the customer-facing follow-ups off GHL and into the dashboard: nothing
// here sends anything. Texts are copied word for word where the recording
// showed them; a step whose words weren't on screen says so.
//
// Written so Olga's daughter could read it (Alan, 2026-10-24): plain words
// up front, the GHL names in small print. Counts ("total" / "now") are
// GHL's Total enrolled / Active enrolled on 2026-10-24. Update this file
// when a GHL workflow changes.

export type StepKind = "wait" | "text" | "move" | "tag" | "alert" | "branch" | "stop" | "call";

export type Step = {
  kind: StepKind;
  /** Plain words. For a wait: how long ("2 days"). */
  label: string;
  /** For a wait: how many days it adds to the day counter (0 for minutes). */
  days?: number;
  /** For a text: the words the customer gets. For an alert: what the team gets. */
  text?: string;
  /** How many people GHL showed waiting right here. */
  waiting?: number;
  /** Something to fix before or during the move. */
  flag?: string;
};

export type Chain = {
  id: string;
  /** Plain title: "We send the price: the first 2 days". */
  title: string;
  /** One line for a kid: what this is for. */
  plain: string;
  /** What starts it. */
  startsWhen: string;
  /** The GHL workflow name(s), exactly as GHL shows them. */
  workflows: string[];
  total?: number;
  now?: number;
  steps: Step[];
  /** What happens the moment the customer writes back. */
  onReply?: Step[];
};

export type Board = {
  key: "sterling" | "at";
  name: string;
  ghlBoard: string;
  ghlFolder: string;
  blurb: string;
  chains: Chain[];
  /** What stops every follow-up when a deal closes. */
  stopRule: { exists: boolean; text: string };
};

const NO_WORDS = "(we don't have the words for this one yet: they weren't on screen)";

const AGE_TEXTS: Step[] = [
  { kind: "branch", label: "Then it depends on how old the fence is" },
  { kind: "text", label: "Brand new, under 6 months", text: "Hey {first}, Since your fence is still quite new and has that golden glow this is the most important time to stain the fence before it starts to gray out. The Signature Finish is what most folks go with since it soaks into the grains and protects the wood from Houston humidity. Are you free for a quick call today or tomato?" },
  { kind: "text", label: "1 to 6 years old", text: "Hey {first}! Fences in the 1-6 year old range are right in the sweet spot for staining. You've got a grey fence that needs some love and the Signature Finish is what most of our customers in your age range go with since it seals the wood and shows the wood grains. Are you available for a quick call today or tomato?" },
  { kind: "text", label: "6 to 15 years old", text: "Hey {first}! You've got a grey fence that needs some love and the Signature Finish is what most folks in your area go with since it seals the wood and shows the wood grains. Are you available for a quick call today or tommorow?" },
  { kind: "text", label: "15 years or older", text: "Hey {first} older fences don't have to mean full replacement. We swap broken pickets and posts if needed, clean and stain it. Adding up to 6 years of life which is way cheaper than a $10-15k new fence. The Legacy Finish covers the imperfections completely. Are you free today to tomato for a quick call?" },
  { kind: "wait", label: "a few seconds", days: 0 },
  { kind: "text", label: "The \"tomato\" joke, with a photo of a finished fence", text: "oops I meant tomorrow not tomato lol. btw this is a fence we just finished up of a similar age to yours" },
];

const ADDRESS_TEXTS: Step[] = [
  { kind: "text", label: "Text 1: we ask for the address", text: NO_WORDS },
  { kind: "wait", label: "2 days (sent 10:00–10:30 AM)", days: 2 },
  { kind: "text", label: "Text 2: a friendly bump", text: "Hey {first}, just bumping this up — what's the best address for your fence staining estimate? Or if you'd rather, send me the linear footage of your fence and I can put together a general estimate that way." },
  { kind: "wait", label: "2 days (sent 3:00–3:30 PM)", days: 2 },
  { kind: "text", label: "Text 3: footage works too", text: "Hey {first}, no rush — and if you're not comfortable sharing your address, just send me the linear footage of your fence and I can put together a general estimate that way." },
  { kind: "wait", label: "3 days (sent 10:00–10:30 AM)", days: 3 },
  { kind: "text", label: "Text 4: last try this week", text: "Hey {first}, last try for this week — what's the address? Happy to circle back later if the timing's off, just want to make sure your estimate doesn't get stuck on my end." },
  { kind: "wait", label: "7 days (sent 10:00 AM)", days: 7 },
  { kind: "text", label: "Text 5: we close it out nicely", text: "Hey {first}, since I haven't heard back, I'll close out your estimate request for now. If you'd like to revisit, just shoot me your address anytime and I'll get the quote done. Take care!" },
];

export const BOARDS: Board[] = [
  {
    key: "sterling",
    name: "Sterling",
    ghlBoard: "STERLING",
    ghlFolder: "Sterling B (plus one filed in Sterling A)",
    blurb: "The real Sterling Fence Staining company. The dashboard starts these by putting a tag on the customer (\"estimate sent sterling\", \"asking for address sterling\").",
    stopRule: {
      exists: false,
      text: "Nothing turns the texts off when a Sterling customer buys. Only a reply stops them. So a customer who pays without ever texting back keeps getting \"want me to hold a spot?\" A&T's board has a helper for this (U02). Sterling needs the same before anything moves.",
    },
    chains: [
      {
        id: "s-intro",
        title: "Someone fills in our Facebook form",
        plain: "We say hi within a minute and ask which sides of the fence.",
        startsWhen: "A Facebook form comes in on the Sterling Fence Staining page.",
        workflows: ["New lead from fb (sterling B)"],
        total: 71, now: 4,
        steps: [
          { kind: "move", label: "Their card goes to New Lead" },
          { kind: "alert", label: "Olga gets the lead", text: "Name, phone, email, fence age, stained before, other services, neighbour, notes and address." },
          { kind: "wait", label: "a minute (inside texting hours)", days: 0 },
          { kind: "text", label: "Amy says hi", text: "Hi {first}! This is Amy with Sterling Fence Staining. Thanks for reaching out, we just received your request. To build your quote, which sides of the fence would you like stained?" },
          { kind: "wait", label: "up to 1 day for an answer. No answer: it ends here.", days: 1 },
        ],
        onReply: [
          { kind: "alert", label: "Olga gets a heads-up", text: "{name} REPLIED TO INTRO- check convo before you send estimate" },
          { kind: "move", label: "Their card goes to HOT LEAD_SEND ESTIMATE" },
        ],
      },
      {
        id: "s-website",
        title: "Someone fills in the website form",
        plain: "We tell the team and hand them to the Facebook welcome (on A&T's board).",
        startsWhen: "The form on sterlingfencetx.com is filled in.",
        workflows: ["Website lead (Home folder)", "→ P01: New Lead Intake (FB Form)"],
        total: 53, now: 0,
        steps: [
          { kind: "tag", label: "Behind the scenes: the contact is created and tagged website-lead" },
          { kind: "alert", label: "The team gets a text", text: "WEBSITE LEAD: name, phone, address, message about scope" },
          { kind: "move", label: "They're handed to A&T's welcome (P01), so their card lands on A&T's board", flag: "A Sterling website customer ends up on A&T's board. They get the right \"Amy with Sterling\" hello, but if they buy, they count on A&T's side." },
        ],
      },
      {
        id: "s-address",
        title: "We ask for their address",
        plain: "Five texts over two weeks asking where the fence is.",
        startsWhen: "The VA taps Ask for address. (Behind the scenes: the tag \"asking for address sterling\" goes on.)",
        workflows: ["Sterling - P03: Address Confirmation", "Sterling - P03-REPLY: Address Reply Catcher"],
        total: 2, now: 0,
        steps: [
          { kind: "move", label: "Their card goes to Address Follow Up" },
          ...ADDRESS_TEXTS,
          { kind: "tag", label: "Behind the scenes: the tag cold lead sterling goes on. That starts the year of check-ins." },
          { kind: "move", label: "Their card goes to LONG TERM NURTURE" },
          { kind: "alert", label: "Everyone gets a nudge", text: "No Address — Call This Lead. Hey guys, {name} never responded with their address. Give them a call — they're getting moved over to cold lead." },
        ],
        onReply: [
          { kind: "stop", label: "The address texts stop" },
          { kind: "move", label: "Their card goes to Responded To ADDRESS Follow Up" },
          { kind: "alert", label: "The team gets their answer", text: "{name} replied to the address request. They said: {message}. Route from there." },
        ],
      },
      {
        id: "s-sent",
        title: "We send the price: the first 2 days",
        plain: "Three quick texts, then one picked for how old their fence is.",
        startsWhen: "We tap Send Estimate on the dashboard. (Behind the scenes: the tag \"estimate sent sterling\" goes on.)",
        workflows: ["P04a: Estimate Sent (Day 0-2) STERLING"],
        total: 93, now: 0,
        steps: [
          { kind: "stop", label: "Any other follow-up they were in stops" },
          { kind: "wait", label: "until texting hours", days: 0 },
          { kind: "move", label: "Their card goes to ESTIMATE SENT" },
          { kind: "text", label: "Text 1", text: NO_WORDS },
          { kind: "wait", label: "1 day", days: 1 },
          { kind: "text", label: "Text 2", text: NO_WORDS },
          { kind: "wait", label: "1 day (sent 1:45–2:30 PM)", days: 1 },
          ...AGE_TEXTS,
          { kind: "tag", label: "Behind the scenes: the tag estimate follow up continue sterling goes on. That starts days 4 to 15." },
        ],
      },
      {
        id: "s-sent2",
        title: "Still no answer: days 4 to 15",
        plain: "Four more texts, spaced out. Then we move them to the monthly check-ins.",
        startsWhen: "The first-2-days texts finish with no answer.",
        workflows: ["P04b: Estimate Sent (Day 4-15) STERLING"],
        total: 56, now: 4,
        steps: [
          { kind: "wait", label: "2 days (sent 6:30–7:00 PM)", days: 2 },
          { kind: "text", label: "Text 5", text: NO_WORDS },
          { kind: "wait", label: "3 days (sent 8:00–8:30 AM)", days: 3 },
          { kind: "text", label: "Text 6: why staining beats replacing", text: "Hey {first}, it's Amy! The Houston weather is brutal on unstained wood fences. Most pickets that go unstained start rotting and turn fading very quickly and replacements eventually run $10-15k. Staining is the cheap side of that math. Happy to go over any questions you may have!" },
          { kind: "wait", label: "4 days (sent 3:30 PM)", days: 4 },
          { kind: "text", label: "Text 7", text: NO_WORDS },
          { kind: "wait", label: "4 days (sent 11:30 AM)", days: 4 },
          { kind: "text", label: "Text 8: last call for this month", text: "Hey {first}, we're wrapping up our schedule for this month. After this I'll just check in once a month in case the timing works out better later. Want me to hold one of our last spots for you?" },
          { kind: "move", label: "Their card goes to LONG TERM NURTURE. That starts the year of check-ins." },
          { kind: "alert", label: "The team gets a nudge", text: "moved to cold lead: {name} moved to long term nurture, call and see whats going on w them" },
        ],
        onReply: [
          { kind: "stop", label: "All the estimate texts stop (this has caught 310 replies so far)" },
          { kind: "move", label: "Their card goes to RESPONDED TO ESTIMATE" },
          { kind: "tag", label: "Behind the scenes: the tag replied to estimate sterling goes on" },
          { kind: "alert", label: "Alan gets a text, the team gets a nudge", text: "🔥 {name} Responded to the Estimate! Check the Conversation🔥" },
        ],
      },
      {
        id: "s-nurture",
        title: "They went quiet: we check in for a year",
        plain: "One text about every month. Nice and easy, never pushy. After a year, a person calls.",
        startsWhen: "Their card lands in LONG TERM NURTURE on the Sterling board, or the tag cold lead sterling goes on.",
        workflows: ["P06: Long Term Nurture Sterling (filed in the Sterling A folder)", "Sterling - P06-REPLY: LTN Reply Catcher"],
        total: 39, now: 33,
        steps: [
          { kind: "move", label: "Their card goes to LONG TERM NURTURE" },
          { kind: "wait", label: "28 days", days: 28, waiting: 11 },
          { kind: "text", label: "Check-in 1", text: "Hey! This is Amy with A&T's Fence Staining 👋 Just wanted to reach out again, fence staining is usually something people circle back to when the timing feels right. If you ever want to talk it through, I'm here.", flag: "Says A&T's to a Sterling customer. Change the word to Sterling." },
          { kind: "wait", label: "7 days", days: 7, waiting: 1 },
          { kind: "text", label: "Check-in 2", text: NO_WORDS },
          { kind: "wait", label: "14 days", days: 14, waiting: 7 },
          { kind: "text", label: "Check-in 3: a quick tip", text: "Hey {first}! Quick tip! untreated fences typically need full replacement after 10-12 years, but staining and replacing and repairing a few boards (if needed) can extend the life 15+ years. If you want a quick updated estimate, just shoot me a text!" },
          { kind: "wait", label: "30 days", days: 30, waiting: 12 },
          { kind: "text", label: "Check-in 4: a job near them", text: "Hey {first}, just finished a fence staining job near your area and the homeowner loved the results. If you'd like to see before/after photos or get an updated quote, just text me back!" },
          { kind: "wait", label: "30 days", days: 30, waiting: 2 },
          { kind: "text", label: "Check-in 5: still on your radar?", text: "Hey {first}, just checking — is fence staining still on your radar, or have you gone a different direction? Either way, no worries at all!" },
          { kind: "wait", label: "60 days", days: 60 },
          { kind: "text", label: "Check-in 6: we're booking up", text: "Hey {first}, it's Amy with A&T's Fence Staining! Just wanted to check in — we've been booking up fast this season. If you want to get on the schedule before things fill up, just text me back and I'll get you a fresh quote!", flag: "Says A&T's to a Sterling customer. Change the word to Sterling." },
          { kind: "wait", label: "90 days", days: 90 },
          { kind: "text", label: "Check-in 7: it's been a while", text: "Hey {first}, it's been a while! If your fence is still untreated, it's not too late — we'd love to help you protect it before more weather damage sets in. Want me to send over an updated estimate?" },
          { kind: "wait", label: "90 days", days: 90 },
          { kind: "call", label: "A person calls them", text: "The whole team gets: CALL LEAD! they never responded to COLD LEAD {name}" },
        ],
        onReply: [
          { kind: "stop", label: "The check-ins stop (34 replies caught so far)" },
          { kind: "move", label: "Their card goes to Responded to long term nurture" },
          { kind: "alert", label: "Olga gets a heads-up", text: "🔥 {name} Responded to Long Term Nurture! Check the Conversation🔥" },
        ],
      },
    ],
  },
  {
    key: "at",
    name: "A&T's",
    ghlBoard: "FENCE STAINING NEW AUTOMATION FLOW",
    ghlFolder: "Sterling A",
    blurb: "The leads from A&T's Pressure Washing's ads. The texts still say \"Amy with Sterling\". The dashboard starts these with the tags \"estimate sent\" and \"asking for address\".",
    stopRule: {
      exists: true,
      text: "A helper called U02 (used 323 times so far) turns every follow-up off the moment a card lands in DECLINED ESTIMATE, Top Priority-Responded to Estimate, DEAL CLOSED & NOT SCHEDULED or CLOSED & SCHEDULED.",
    },
    chains: [
      {
        id: "a-intro",
        title: "Someone fills in a Facebook form",
        plain: "We tell Alan and Olga, then Amy says hi.",
        startsWhen: "Any of about 10 Facebook forms, on A&T's page or Sterling's. Sterling website leads come here too.",
        workflows: ["P01: New Lead Intake (FB Form)", "P02a–d Ad Tag workflows"],
        total: 1492, now: 10,
        steps: [
          { kind: "tag", label: "Behind the scenes: the tag new lead - needs estimate goes on, plus the ad's name (See This Gray, Walk Outside, Premium Hook)" },
          { kind: "move", label: "Their card goes to New Lead" },
          { kind: "alert", label: "Alan gets a text, Olga gets a heads-up", text: "New Lead! Sterling FENCE STAINING Call to schedule service appointment. NAME, PHONE, EMAIL, WHEN, ADDRESS, Fence Height, Fence Age" },
          { kind: "wait", label: "a minute (sent 5:30 AM–10:00 PM)", days: 0 },
          { kind: "text", label: "Amy says hi", text: "Hi {first}! this is Amy with Sterling Fence Staining. I just received your information! While we build your quote do you have any questions… (the repair-sides form adds the sister-company line and asks inside, front or outside)" },
          { kind: "wait", label: "up to 1 day for an answer", days: 1 },
        ],
        onReply: [
          { kind: "move", label: "Their card goes to HOT LEAD_SEND ESTIMATE" },
          { kind: "alert", label: "Olga gets a heads-up, Alan gets a text", text: "NEW LEAD RESPONDED – check their text before sending estimate / {name} REPLIED TO INTRO" },
        ],
      },
      {
        id: "a-address",
        title: "We ask for their address",
        plain: "Five texts over two weeks asking where the fence is.",
        startsWhen: "The VA taps Ask for address. (Behind the scenes: the tag \"asking for address\" goes on.)",
        workflows: ["P03: Address Confirmation", "P03-REPLY: Address Reply Catcher"],
        total: 85, now: 0,
        steps: [
          { kind: "move", label: "Their card goes to Address Follow Up" },
          ...ADDRESS_TEXTS,
          { kind: "tag", label: "Behind the scenes: the tag cold lead goes on. That starts the year of check-ins." },
          { kind: "move", label: "Their card moves on" },
          { kind: "alert", label: "Everyone gets a nudge", text: "No Address — Call This Lead. Hey guys, {name} never responded with their address. Give them a call — they're getting moved over to cold lead." },
        ],
        onReply: [
          { kind: "stop", label: "The address texts stop (360 replies caught so far)" },
          { kind: "move", label: "Their card goes to Responded to Address Follow Up" },
          { kind: "alert", label: "The team gets their answer", text: "{name} replied to the address request. They said: {message}. Route from there." },
        ],
      },
      {
        id: "a-sent",
        title: "We send the price: the first 2 days",
        plain: "Three quick texts, then one picked for how old their fence is.",
        startsWhen: "We tap Send Estimate on the dashboard. (Behind the scenes: the tag \"estimate sent\" goes on.)",
        workflows: ["P04a: Estimate Sent (Day 0-2)"],
        total: 1510, now: 8,
        steps: [
          { kind: "stop", label: "The welcome follow-up stops" },
          { kind: "wait", label: "until texting hours", days: 0 },
          { kind: "move", label: "Their card goes to ESTIMATE SENT" },
          { kind: "text", label: "Text 1: your price is in the link", text: "Hey {first}, your personalized estimate is in the link above! I included 3 packages (Essential, Signature, and Legacy). Is this something you're looking to get done soon while we're running our 20% off promotion?", flag: "Says \"20% off promotion\". You said the 20% off isn't real." },
          { kind: "wait", label: "1 day", days: 1 },
          { kind: "text", label: "Text 2", text: NO_WORDS },
          { kind: "wait", label: "1 day (sent 1:45–2:30 PM)", days: 1 },
          ...AGE_TEXTS,
          { kind: "tag", label: "Behind the scenes: the tag estimate-followup-continue goes on. That starts days 4 to 15." },
        ],
      },
      {
        id: "a-sent2",
        title: "Still no answer: days 4 to 15",
        plain: "Four more texts, spaced out. Then we move them to the monthly check-ins.",
        startsWhen: "The first-2-days texts finish with no answer.",
        workflows: ["P04b: Estimate Sent (Day 4-15)", "P04-REPLY: Estimate Reply Catcher"],
        total: 577, now: 21,
        steps: [
          { kind: "wait", label: "2 days (sent 6:30–7:00 PM)", days: 2 },
          { kind: "text", label: "Text 5", text: NO_WORDS },
          { kind: "wait", label: "3 days (sent 8:00 AM)", days: 3 },
          { kind: "text", label: "Text 6: why staining beats replacing", text: "Hey {first}, it's Amy! The Houston weather is brutal on unstained wood fences. Most pickets that go unstained start rotting and turn fading very quickly and replacements eventually run $10-15k. Staining is the cheap side of that math. Happy to go over any questions you may have!" },
          { kind: "wait", label: "4 days (sent 3:30 PM)", days: 4 },
          { kind: "text", label: "Text 7", text: NO_WORDS },
          { kind: "wait", label: "4 days (sent 11:30 AM)", days: 4 },
          { kind: "text", label: "Text 8", text: NO_WORDS },
          { kind: "move", label: "Their card goes to LONG TERM NURTURE. That starts the year of check-ins." },
          { kind: "alert", label: "The team gets a nudge" },
        ],
        onReply: [
          { kind: "stop", label: "All the estimate texts stop (about 3,047 replies caught so far)" },
          { kind: "move", label: "Their card goes to RESPONDED TO ESTIMATE" },
          { kind: "tag", label: "Behind the scenes: the tag replied to estimate goes on" },
          { kind: "alert", label: "Alan gets a text" },
        ],
      },
      {
        id: "a-nurture",
        title: "They went quiet: we check in for a year",
        plain: "One text about every month. Nice and easy, never pushy.",
        startsWhen: "The tag cold lead goes on (a helper called U01 moves the card too), or their card lands in LONG TERM NURTURE.",
        workflows: ["P06: Long Term Nurture", "U01: Manual Move to LTN", "P06-REPLY: LTN Reply Catcher"],
        total: 209, now: 161,
        steps: [
          { kind: "move", label: "Their card goes to LONG TERM NURTURE" },
          { kind: "wait", label: "28 days", days: 28, waiting: 32 },
          { kind: "text", label: "Check-in 1", text: "Hey {first} hope you're well. Just wanted to mention we're currently offering 20% off fence staining for a limited time. If that helps make the timing work, feel free to text me back anytime 👍", flag: "Says \"20% off\" again." },
          { kind: "wait", label: "7 days", days: 7, waiting: 10 },
          { kind: "text", label: "Check-in 2: a job near them", text: "Hey {first}, just finished a fence staining job near your area and the homeowner loved the results. If you'd like to see before/after photos or get an updated quote, just text me back!" },
          { kind: "wait", label: "30 days", days: 30 },
          { kind: "text", label: "Check-in 3: still on your radar?", text: "Hey {first}, just checking — is fence staining still on your radar, or have you gone a different direction? Either way, no worries at all!" },
          { kind: "wait", label: "more months, 30 days apart", days: 30 },
          { kind: "alert", label: "At the end, the team gets a nudge" },
        ],
        onReply: [
          { kind: "stop", label: "The check-ins stop (128 replies caught so far)" },
          { kind: "move", label: "Their card goes to Responded to long term nurture" },
          { kind: "alert", label: "The team gets a heads-up", text: "{name} Responded to Long Term Nurture! Check the Conversation🔥" },
        ],
      },
    ],
  },
];

/** The whole thing in five pictures, for the top of the page. */
export const JOURNEY: { title: string; sub: string }[] = [
  { title: "Someone asks for a price", sub: "From a Facebook form, our website, or a call." },
  { title: "Amy says hi", sub: "A text within a minute: which sides of the fence?" },
  { title: "We send the price", sub: "Three packages: Essential, Signature, Legacy." },
  { title: "We check in", sub: "A few texts over two weeks, picked for how old the fence is." },
  { title: "We keep in touch", sub: "If they go quiet, one text a month for about a year." },
];

/** Alan's decisions (2026-10-24). Not built yet; this is the plan. */
export const DECIDED: string[] = [
  "Sterling moves first, then A&T's. Anyone in the middle of a follow-up finishes it where they are. Nobody gets cut off.",
  "If we gave the price on a phone call: no texts. We call back on the exact day we promised. The script always names a day (\"can I call you next Thursday?\") so the call list fills itself in.",
  "\"Call this customer\" moments show on the On Call screen. Gio calls the ones who never answered; Olga the rest. The screen tells them what to say.",
  "Customers with an email get emails too: videos about the company and the longer stuff that doesn't fit in a text.",
  "The texts stay written by people. The computer only fills in the details (name, fence age, sides). It never writes a text itself, so it never sounds like a robot.",
  "One person, one card. When someone is on both boards, the Sterling board wins.",
  "Website leads belong on the Sterling board. (Not moved yet.)",
  "The texts keep signing as Amy.",
];

/** Words on this page, for anyone new. */
export const WORDS: { word: string; means: string }[] = [
  { word: "GHL", means: "The system that sends our texts today." },
  { word: "Board", means: "The big list of customers, in columns. There are two: Sterling's and A&T's." },
  { word: "Card", means: "One customer on a board. A card moves from column to column as things happen." },
  { word: "Follow-up", means: "The texts we send after someone asks for a price, until they answer." },
  { word: "Tag", means: "A little label on a customer. Behind the scenes, a tag is what starts a follow-up." },
];

/** Helpers in GHL's Home folder. */
export const SHARED: { name: string; total?: number; what: string; rule?: string }[] = [
  { name: "Dashboard instant lead ping", total: 614, what: "The moment a call, a transcript, a website form, a customer reply or a Facebook form happens, it tells the dashboard.", rule: "Never touch. This is how the dashboard hears about everything." },
  { name: "Website lead", total: 53, what: "Website form → creates the customer, tags website-lead, texts the team, hands them to A&T's welcome (P01)." },
  { name: "ADD CONTACT TO FENCE STAINING 2", total: 98, what: "Tag \"add to sterling 2\" → sends the customer (name, phone, fence height and age, address) to another GHL account." },
  { name: "REMOVE AI AUTOMATIONS NEW LEAD", what: "Tag \"new lead automation off\" → takes them out of the welcome follow-up." },
  { name: "video opened", total: 145, what: "They tapped the video link in a text → a note goes on the customer." },
];

/** Switched off: drafts, or old templates with nobody in them. */
export const NOT_RUNNING = [
  "P05: Deferred Follow-Up (draft; its text says \"Olga with A&T's… 20% off\")",
  "Z. Follow up later-Lead (draft)",
  "P01: New Lead Intake (FB Form) STERLING PAGE (draft, 1 person stuck in it)",
  "Appointment SMS Confirmations (draft)",
  "Workflow 1–6, the old A&T's pressure washing templates (house wash, window cleaning, Christmas lights, solar panels)",
  "1–6 numbered drafts (Fast 5, appointment reminders, no-show, review request, stale leads)",
  "Hiring Estimator, hiring, neighbour forms, turn off bot, SMS BLAST",
];

/** What to fix, found while mapping. */
export const ISSUES: { title: string; detail: string; safe: string }[] = [
  { title: "Two Sterling texts say \"A&T's\"", detail: "In the year of check-ins for Sterling customers, check-in 1 and check-in 6 say \"Amy with A&T's Fence Staining\". 11 people get check-in 1 within the next 4 weeks.", safe: "Safe to fix today: change one word. Nobody moves." },
  { title: "Nothing turns off Sterling's texts when someone buys", detail: "A&T's board has a helper that stops the texts when a deal closes. Sterling's board has none. A customer who pays without texting back keeps getting \"want me to hold a spot?\"", safe: "Build the helper before the move." },
  { title: "\"20% off\" that isn't real", detail: "A&T's first estimate text, A&T's first check-in, and the P05 draft all promise 20% off.", safe: "Safe to fix today: change the words." },
  { title: "Website leads land on the wrong board", detail: "Someone who fills in the Sterling website form gets a card on A&T's board, not Sterling's.", safe: "Decided: they belong on Sterling's board. Not moved yet." },
];
