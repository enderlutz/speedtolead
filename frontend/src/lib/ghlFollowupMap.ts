// Every follow-up GHL runs today, read off Alan's six screen recordings of
// the GHL workflows (2026-10-24). This is the "before" picture for moving
// the customer-facing follow-ups off GHL and into the dashboard: nothing
// here sends anything. Texts are copied word for word where the recording
// showed them; a step whose words weren't on screen says so.
//
// Counts ("total" / "now") are GHL's Total enrolled / Active enrolled on
// 2026-10-24. Update this file when a GHL workflow changes.

export type StepKind = "start" | "wait" | "text" | "move" | "tag" | "alert" | "branch" | "stop" | "call";

export type Step = {
  kind: StepKind;
  label: string;
  /** The words the customer (or the team) gets, when the recording showed them. */
  text?: string;
  /** How many people GHL showed sitting right before this step. */
  waiting?: number;
  /** Something to fix before or during the move. */
  flag?: string;
};

export type Chain = {
  id: string;
  title: string;
  /** The GHL workflow name(s), exactly as GHL shows them. */
  workflows: string[];
  total?: number;
  now?: number;
  /** What starts it, in plain words. */
  startsWhen: string;
  steps: Step[];
  /** The reply catcher that stops it when the customer answers. */
  onReply?: Step[];
  flags?: string[];
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

const AGE_TEXTS: Step[] = [
  { kind: "branch", label: "Splits by fence age" },
  { kind: "text", label: "New, under 6 months", text: "Hey {first}, Since your fence is still quite new and has that golden glow this is the most important time to stain the fence before it starts to gray out. The Signature Finish is what most folks go with since it soaks into the grains and protects the wood from Houston humidity. Are you free for a quick call today or tomato?" },
  { kind: "text", label: "1–6 years", text: "Hey {first}! Fences in the 1-6 year old range are right in the sweet spot for staining. You've got a grey fence that needs some love and the Signature Finish is what most of our customers in your age range go with since it seals the wood and shows the wood grains. Are you available for a quick call today or tomato?" },
  { kind: "text", label: "6–15 years", text: "Hey {first}! You've got a grey fence that needs some love and the Signature Finish is what most folks in your area go with since it seals the wood and shows the wood grains. Are you available for a quick call today or tommorow?" },
  { kind: "text", label: "15+ years", text: "Hey {first} older fences don't have to mean full replacement. We swap broken pickets and posts if needed, clean and stain it. Adding up to 6 years of life which is way cheaper than a $10-15k new fence. The Legacy Finish covers the imperfections completely. Are you free today to tomato for a quick call?" },
  { kind: "wait", label: "A few seconds" },
  { kind: "text", label: "The \"tomato\" follow-up, with a photo", text: "oops I meant tomorrow not tomato lol. btw this is a fence we just finished up of a similar age to yours" },
];

const ADDRESS_TEXTS: Step[] = [
  { kind: "text", label: "Text 1: asks for the address", text: "(asks for the address; the words weren't on screen)" },
  { kind: "wait", label: "2 days, sends 10:00–10:30 AM" },
  { kind: "text", label: "Text 2: friendly bump", text: "Hey {first}, just bumping this up — what's the best address for your fence staining estimate? Or if you'd rather, send me the linear footage of your fence and I can put together a general estimate that way." },
  { kind: "wait", label: "2 days, sends 3:00–3:30 PM" },
  { kind: "text", label: "Text 3: footage instead", text: "Hey {first}, no rush — and if you're not comfortable sharing your address, just send me the linear footage of your fence and I can put together a general estimate that way." },
  { kind: "wait", label: "3 days, sends 10:00–10:30 AM" },
  { kind: "text", label: "Text 4: last try this week", text: "Hey {first}, last try for this week — what's the address? Happy to circle back later if the timing's off, just want to make sure your estimate doesn't get stuck on my end." },
  { kind: "wait", label: "7 days, 10:00 AM" },
  { kind: "text", label: "Text 5: graceful exit", text: "Hey {first}, since I haven't heard back, I'll close out your estimate request for now. If you'd like to revisit, just shoot me your address anytime and I'll get the quote done. Take care!" },
];

export const BOARDS: Board[] = [
  {
    key: "sterling",
    name: "Sterling",
    ghlBoard: "STERLING",
    ghlFolder: "Sterling B (plus one in Sterling A)",
    blurb: "The real Sterling Fence Staining company. The dashboard adds the tags that start these (\"estimate sent sterling\", \"asking for address sterling\").",
    stopRule: {
      exists: false,
      text: "Nothing stops the Sterling follow-ups when a Sterling deal closes. Only a reply stops them, so a customer who pays without texting back keeps getting \"want me to hold a spot?\" texts. A&T's board has U02 for this; Sterling needs the same before anything moves.",
    },
    chains: [
      {
        id: "s-intro",
        title: "New lead from Facebook",
        workflows: ["New lead from fb (sterling B)"],
        total: 71, now: 4,
        startsWhen: "A Facebook form is filled on the Sterling Fence Staining page (skipped if they're already tagged website-lead).",
        steps: [
          { kind: "move", label: "Card → New Lead" },
          { kind: "alert", label: "Tells Olga", text: "The lead's name, phone, email, fence age, stained before, other services, neighbour, notes and address." },
          { kind: "wait", label: "A minute, inside the sending window" },
          { kind: "text", label: "Intro text", text: "Hi {first}! This is Amy with Sterling Fence Staining. Thanks for reaching out, we just received your request. To build your quote, which sides of the fence would you like stained?" },
          { kind: "wait", label: "Up to 1 day for a reply. No reply: it ends here." },
        ],
        onReply: [
          { kind: "alert", label: "Tells Olga", text: "{name} REPLIED TO INTRO- check convo before you send estimate" },
          { kind: "move", label: "Card → HOT LEAD_SEND ESTIMATE" },
        ],
      },
      {
        id: "s-website",
        title: "Lead from the website",
        workflows: ["Website lead (Home folder)"],
        total: 53, now: 0,
        startsWhen: "Someone fills in the form on sterlingfencetx.com.",
        steps: [
          { kind: "tag", label: "Creates the contact, tags website-lead" },
          { kind: "alert", label: "Texts the team", text: "WEBSITE LEAD: name, phone, address, message about scope" },
          { kind: "move", label: "Hands them to A&T's intake (P01)", flag: "A Sterling website lead lands on A&T's board, not Sterling's. They get the right \"Amy with Sterling\" intro, but if they close they count on A&T's side." },
        ],
      },
      {
        id: "s-address",
        title: "Asking for the address",
        workflows: ["Sterling - P03: Address Confirmation", "Sterling - P03-REPLY: Address Reply Catcher"],
        total: 2, now: 0,
        startsWhen: "The VA clicks Ask for address (the dashboard adds \"asking for address sterling\").",
        steps: [
          { kind: "move", label: "Card → Address Follow Up" },
          ...ADDRESS_TEXTS,
          { kind: "tag", label: "Tags cold lead sterling (this starts the long-term nurture)" },
          { kind: "move", label: "Card → LONG TERM NURTURE" },
          { kind: "alert", label: "Tells everyone", text: "No Address — Call This Lead. Hey guys, {name} never responded with their address. Give them a call — they're getting moved over to cold lead." },
        ],
        onReply: [
          { kind: "stop", label: "Stops the address texts" },
          { kind: "move", label: "Card → Responded To ADDRESS Follow Up" },
          { kind: "alert", label: "Tells the team", text: "{name} replied to the address request. They said: {message}. Route from there." },
        ],
      },
      {
        id: "s-sent",
        title: "Estimate sent, days 0–2",
        workflows: ["P04a: Estimate Sent (Day 0-2) STERLING"],
        total: 93, now: 0,
        startsWhen: "Send Estimate on the dashboard (it adds \"estimate sent sterling\").",
        steps: [
          { kind: "stop", label: "Takes them out of every other workflow" },
          { kind: "wait", label: "Holds until the sending window" },
          { kind: "move", label: "Card → ESTIMATE SENT" },
          { kind: "text", label: "Text 1", text: "(the words weren't on screen)" },
          { kind: "wait", label: "24 hours" },
          { kind: "text", label: "Text 2", text: "(the words weren't on screen)" },
          { kind: "wait", label: "1 day, sends 1:45–2:30 PM" },
          ...AGE_TEXTS,
          { kind: "tag", label: "Tags estimate follow up continue sterling (starts days 4–15)" },
        ],
      },
      {
        id: "s-sent2",
        title: "Estimate sent, days 4–15",
        workflows: ["P04b: Estimate Sent (Day 4-15) STERLING"],
        total: 56, now: 4,
        startsWhen: "The days 0–2 texts finish.",
        steps: [
          { kind: "wait", label: "2 days, sends 6:30–7:00 PM" },
          { kind: "text", label: "Text 5", text: "(the words weren't on screen)" },
          { kind: "wait", label: "3 days, sends 8:00–8:30 AM" },
          { kind: "text", label: "Text 6", text: "Hey {first}, it's Amy! The Houston weather is brutal on unstained wood fences. Most pickets that go unstained start rotting and turn fading very quickly and replacements eventually run $10-15k. Staining is the cheap side of that math. Happy to go over any questions you may have!" },
          { kind: "wait", label: "4 days, 3:30 PM" },
          { kind: "text", label: "Text 7", text: "(the words weren't on screen)" },
          { kind: "wait", label: "4 days, 11:30 AM" },
          { kind: "text", label: "Text 8", text: "Hey {first}, we're wrapping up our schedule for this month. After this I'll just check in once a month in case the timing works out better later. Want me to hold one of our last spots for you?" },
          { kind: "move", label: "Card → LONG TERM NURTURE (this starts the nurture)" },
          { kind: "alert", label: "Tells the team", text: "moved to cold lead: {name} moved to long term nurture, call and see whats going on w them" },
        ],
        onReply: [
          { kind: "stop", label: "Stops days 0–2 and 4–15 (Sterling - P04-REPLY, 310 so far)" },
          { kind: "move", label: "Card → RESPONDED TO ESTIMATE" },
          { kind: "tag", label: "Tags replied to estimate sterling" },
          { kind: "alert", label: "Texts Alan and alerts the team", text: "🔥 {name} Responded to the Estimate! Check the Conversation🔥" },
        ],
      },
      {
        id: "s-nurture",
        title: "Long-term nurture",
        workflows: ["P06: Long Term Nurture Sterling (filed in the Sterling A folder)", "Sterling - P06-REPLY: LTN Reply Catcher"],
        total: 39, now: 33,
        startsWhen: "The card lands in LONG TERM NURTURE on the STERLING board, or the tag cold lead sterling goes on.",
        steps: [
          { kind: "move", label: "Card → LONG TERM NURTURE" },
          { kind: "wait", label: "28 days", waiting: 11 },
          { kind: "text", label: "Text 1", text: "Hey! This is Amy with A&T's Fence Staining 👋 Just wanted to reach out again, fence staining is usually something people circle back to when the timing feels right. If you ever want to talk it through, I'm here.", flag: "Says A&T's to a Sterling customer." },
          { kind: "wait", label: "7 days", waiting: 1 },
          { kind: "text", label: "Text 2", text: "(the words weren't on screen)" },
          { kind: "wait", label: "14 days", waiting: 7 },
          { kind: "text", label: "Text 3", text: "Hey {first}! Quick tip! untreated fences typically need full replacement after 10-12 years, but staining and replacing and repairing a few boards (if needed) can extend the life 15+ years. If you want a quick updated estimate, just shoot me a text!" },
          { kind: "wait", label: "30 days", waiting: 12 },
          { kind: "text", label: "Text 4", text: "Hey {first}, just finished a fence staining job near your area and the homeowner loved the results. If you'd like to see before/after photos or get an updated quote, just text me back!" },
          { kind: "wait", label: "30 days", waiting: 2 },
          { kind: "text", label: "Text 5", text: "Hey {first}, just checking — is fence staining still on your radar, or have you gone a different direction? Either way, no worries at all!" },
          { kind: "wait", label: "60 days" },
          { kind: "text", label: "Text 6", text: "Hey {first}, it's Amy with A&T's Fence Staining! Just wanted to check in — we've been booking up fast this season. If you want to get on the schedule before things fill up, just text me back and I'll get you a fresh quote!", flag: "Says A&T's to a Sterling customer." },
          { kind: "wait", label: "90 days" },
          { kind: "text", label: "Text 7", text: "Hey {first}, it's been a while! If your fence is still untreated, it's not too late — we'd love to help you protect it before more weather damage sets in. Want me to send over an updated estimate?" },
          { kind: "wait", label: "90 days" },
          { kind: "call", label: "Texts the whole team", text: "CALL LEAD! they never responded to COLD LEAD {name}" },
        ],
        onReply: [
          { kind: "stop", label: "Stops the nurture (34 so far)" },
          { kind: "move", label: "Card → Responded to long term nurture" },
          { kind: "alert", label: "Tells Olga", text: "🔥 {name} Responded to Long Term Nurture! Check the Conversation🔥" },
        ],
      },
    ],
  },
  {
    key: "at",
    name: "A&T's",
    ghlBoard: "FENCE STAINING NEW AUTOMATION FLOW",
    ghlFolder: "Sterling A",
    blurb: "A&T's Pressure Washing's ads. The texts still sign as \"Amy with Sterling\" in the intro. The dashboard adds \"estimate sent\" and \"asking for address\" to start these.",
    stopRule: {
      exists: true,
      text: "U02 Stop Workflows in Terminal Stages (323 so far): when a card lands in DECLINED ESTIMATE, Top Priority-Responded to Estimate, DEAL CLOSED & NOT SCHEDULED or CLOSED & SCHEDULED, every follow-up stops.",
    },
    chains: [
      {
        id: "a-intro",
        title: "New lead intake",
        workflows: ["P01: New Lead Intake (FB Form)", "P02a–d Ad Tag workflows"],
        total: 1492, now: 10,
        startsWhen: "About 10 Facebook forms on both pages (A&T's and Sterling), plus every Sterling website lead.",
        steps: [
          { kind: "tag", label: "Tags new lead - needs estimate (P02a–d add the ad's tag: See This Gray, Walk Outside, Premium Hook 1 and 2)" },
          { kind: "move", label: "Card → New Lead" },
          { kind: "alert", label: "Texts Alan the lead, tells Olga", text: "New Lead! Sterling FENCE STAINING Call to schedule service appointment. NAME, PHONE, EMAIL, WHEN, ADDRESS, Fence Height, Fence Age" },
          { kind: "wait", label: "A minute, sends 5:30 AM–10:00 PM" },
          { kind: "text", label: "Intro text", text: "Hi {first}! this is Amy with Sterling Fence Staining. I just received your information! While we build your quote do you have any questions… (the repair-sides form adds the sister-company line and asks inside, front or outside)" },
          { kind: "wait", label: "Up to 1 day for a reply" },
        ],
        onReply: [
          { kind: "move", label: "Card → HOT LEAD_SEND ESTIMATE" },
          { kind: "alert", label: "Tells Olga, texts Alan", text: "NEW LEAD RESPONDED – check their text before sending estimate / {name} REPLIED TO INTRO" },
        ],
      },
      {
        id: "a-address",
        title: "Asking for the address",
        workflows: ["P03: Address Confirmation", "P03-REPLY: Address Reply Catcher"],
        total: 85, now: 0,
        startsWhen: "The VA clicks Ask for address (the dashboard adds \"asking for address\").",
        steps: [
          { kind: "move", label: "Card → Address Follow Up" },
          ...ADDRESS_TEXTS,
          { kind: "tag", label: "Tags cold lead (this starts the long-term nurture)" },
          { kind: "move", label: "Card moves on" },
          { kind: "alert", label: "Tells everyone", text: "No Address — Call This Lead. Hey guys, {name} never responded with their address. Give them a call — they're getting moved over to cold lead." },
        ],
        onReply: [
          { kind: "stop", label: "Stops the address texts (360 so far)" },
          { kind: "move", label: "Card → Responded to Address Follow Up" },
          { kind: "alert", label: "Tells the team", text: "{name} replied to the address request. They said: {message}. Route from there." },
        ],
      },
      {
        id: "a-sent",
        title: "Estimate sent, days 0–2",
        workflows: ["P04a: Estimate Sent (Day 0-2)"],
        total: 1510, now: 8,
        startsWhen: "Send Estimate on the dashboard (it adds \"estimate sent\").",
        steps: [
          { kind: "stop", label: "Takes them out of the intake" },
          { kind: "wait", label: "Holds until the sending window" },
          { kind: "move", label: "Card → ESTIMATE SENT" },
          { kind: "text", label: "Text 1", text: "Hey {first}, your personalized estimate is in the link above! I included 3 packages (Essential, Signature, and Legacy). Is this something you're looking to get done soon while we're running our 20% off promotion?", flag: "\"20% off promotion\": you said the 20% off isn't real." },
          { kind: "wait", label: "24 hours" },
          { kind: "text", label: "Text 2", text: "(the words weren't on screen)" },
          { kind: "wait", label: "1 day, sends 1:45–2:30 PM" },
          ...AGE_TEXTS,
          { kind: "tag", label: "Tags estimate-followup-continue (starts days 4–15)" },
        ],
      },
      {
        id: "a-sent2",
        title: "Estimate sent, days 4–15",
        workflows: ["P04b: Estimate Sent (Day 4-15)", "P04-REPLY: Estimate Reply Catcher"],
        total: 577, now: 21,
        startsWhen: "The days 0–2 texts finish.",
        steps: [
          { kind: "wait", label: "2 days, sends 6:30–7:00 PM" },
          { kind: "text", label: "Text 5", text: "(the words weren't on screen)" },
          { kind: "wait", label: "3 days, 8:00 AM" },
          { kind: "text", label: "Text 6", text: "Hey {first}, it's Amy! The Houston weather is brutal on unstained wood fences. Most pickets that go unstained start rotting and turn fading very quickly and replacements eventually run $10-15k. Staining is the cheap side of that math. Happy to go over any questions you may have!" },
          { kind: "wait", label: "4 days, 3:30 PM" },
          { kind: "text", label: "Text 7", text: "(the words weren't on screen)" },
          { kind: "wait", label: "4 days, 11:30 AM" },
          { kind: "text", label: "Text 8", text: "(the words weren't on screen)" },
          { kind: "move", label: "Card → LONG TERM NURTURE (this starts the nurture)" },
          { kind: "alert", label: "Tells the team" },
        ],
        onReply: [
          { kind: "stop", label: "Stops days 0–2 and 4–15 (about 3,047 so far)" },
          { kind: "move", label: "Card → RESPONDED TO ESTIMATE" },
          { kind: "tag", label: "Tags replied to estimate" },
          { kind: "alert", label: "Texts Alan" },
        ],
      },
      {
        id: "a-nurture",
        title: "Long-term nurture",
        workflows: ["P06: Long Term Nurture", "U01: Manual Move to LTN", "P06-REPLY: LTN Reply Catcher"],
        total: 209, now: 161,
        startsWhen: "The tag cold lead goes on (U01 also moves the card), or the card lands in LONG TERM NURTURE.",
        steps: [
          { kind: "move", label: "Card → LONG TERM NURTURE" },
          { kind: "wait", label: "28 days", waiting: 32 },
          { kind: "text", label: "Text 1", text: "Hey {first} hope you're well. Just wanted to mention we're currently offering 20% off fence staining for a limited time. If that helps make the timing work, feel free to text me back anytime 👍", flag: "\"20% off\" again." },
          { kind: "wait", label: "7 days", waiting: 10 },
          { kind: "text", label: "More texts, 30 days apart", text: "Hey {first}, just finished a fence staining job near your area and the homeowner loved the results. If you'd like to see before/after photos or get an updated quote, just text me back! … Hey {first}, just checking — is fence staining still on your radar, or have you gone a different direction? Either way, no worries at all!" },
          { kind: "alert", label: "Tells the team at the end" },
        ],
        onReply: [
          { kind: "stop", label: "Stops the nurture (128 so far)" },
          { kind: "move", label: "Card → Responded to long term nurture" },
          { kind: "alert", label: "Tells the team", text: "{name} Responded to Long Term Nurture! Check the Conversation🔥" },
        ],
      },
    ],
  },
];

/** Shared workflows in GHL's Home folder. */
export const SHARED: { name: string; total?: number; what: string; rule?: string }[] = [
  { name: "Dashboard instant lead ping", total: 614, what: "Sends every call, call transcript, website-lead tag, customer reply and Facebook form to the dashboard the moment it happens.", rule: "Never touch. This is how the dashboard hears about everything." },
  { name: "Website lead", total: 53, what: "sterlingfencetx.com form → creates the contact, tags website-lead, texts the team, hands them to A&T's intake (P01)." },
  { name: "ADD CONTACT TO FENCE STAINING 2", total: 98, what: "Tag \"add to sterling 2\" → sends the contact (name, phone, fence height and age, address) to another GHL account." },
  { name: "REMOVE AI AUTOMATIONS NEW LEAD", what: "Tag \"new lead automation off\" → takes them out of the new-lead workflow." },
  { name: "video opened", total: 145, what: "The \"Video\" link in a text is tapped → fills in a field on the contact." },
];

/** Not running: drafts, or old templates with nobody in them. */
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
  { title: "Sterling customers get \"A&T's\" texts", detail: "Long-term nurture Sterling, texts 1 and 6, say \"Amy with A&T's Fence Staining\". 11 people reach text 1 within 4 weeks.", safe: "Safe now: change the words, nobody moves." },
  { title: "Nothing stops Sterling's follow-ups when a deal closes", detail: "A&T's board has U02. Sterling's board has nothing, so a customer who pays without replying keeps getting estimate texts.", safe: "Build before the move." },
  { title: "\"20% off\" that isn't real", detail: "A&T's estimate text 1, A&T's nurture text 1, and the P05 draft.", safe: "Safe now: change the words." },
  { title: "Sterling website leads sit on A&T's board", detail: "Website lead hands them to A&T's intake, so their card is on FENCE STAINING NEW AUTOMATION FLOW.", safe: "Decide where they belong before the move." },
];
