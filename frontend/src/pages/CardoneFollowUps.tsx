// Cardone's follow-ups, drawn out: every touch of the year the way the
// customer meets it. Alan (2026-10-12): "show me what they would look like,
// make a new tab… and let me visualize and see it all."
//
// Nothing here sends anything. It is the playbook in docs/follow-up-playbook.md
// as pictures: the texts as phone bubbles, the calls as scripts, the videos
// and the fence render as what lands on the phone, and the customer's whole
// thread for each clock. Each touch says whether it runs today, needs a
// rewrite, or has to be built.
import { useMemo, useState } from "react";
import {
  MessageSquare, Phone, Video, Image as ImageIcon, Mail, Clock, PlayCircle, Repeat, AlertTriangle,
  CheckCircle2, Hammer, Pencil, ListChecks, ShieldCheck, Voicemail, Sparkles, CalendarDays,
} from "lucide-react";
import { Panel } from "@/components/Panel";
import { ACCENT } from "@/lib/accents";
import { cn } from "@/lib/utils";

type Channel = "text" | "call" | "video" | "mms" | "email";
type Who = "Amy" | "Alan" | "Auto";
type Status = "live" | "rewrite" | "build";
type Clock = 1 | 2 | 3;

type Touch = {
  clock: Clock;
  day: string;          // "Day 3", "0:05", "On open"
  sort: number;         // order inside the clock
  title: string;
  channel: Channel;
  who: Who;
  reason: string;       // why this touch exists, one line
  body?: string;        // the text, {name} is the customer's first name
  script?: string[];    // the call, line by line
  vm?: string;          // the voicemail when nobody answers
  after?: string;       // the text that follows a no-answer
  image?: { src: string; caption: string; overlay?: string };
  video?: string;       // what the video shows
  subject?: string;     // email
  status: Status;
  note?: string;        // what has to change or be built
};

const TOUCHES: Touch[] = [
  // ── Clock 1: the first hour ───────────────────────────────────────────
  { clock: 1, day: "0:00", sort: 0, title: "Intro text and the nearby fence", channel: "text", who: "Auto", status: "live",
    reason: "Be first. The text lands before they've closed the ad.",
    body: "Hey {name}, this is Amy with Sterling Fence Staining. Thanks for reaching out about your fence! I'll have your estimate ready shortly. To make sure I'm pulling the right property, can you confirm the full address with city and ZIP?",
    image: { src: "/proposal-mockup/pkg-signature-b.jpg", caption: "Btw this is a fence we just finished up nearby ^" } },
  { clock: 1, day: "0:05", sort: 1, title: "The 5-minute call", channel: "call", who: "Alan", status: "build",
    reason: "A lead gets a human in 5 minutes, not a text. 9x conversion inside 5 minutes.",
    script: ["Hey {name}, it's Alan with Sterling Fence Staining. Saw your request come in a minute ago.", "I'm pulling your fence up on the map right now. Is it the one at the address you typed?", "Inside only, or the outside too?", "Perfect. I'll have your three prices to you today."],
    vm: "Hey {name}, Alan with Sterling Fence Staining. Saw your request, I'm pulling your fence up on the map right now. Call me back at 346-589-7877.",
    after: "Just tried you, {name}. Pulling your fence up on the map now. Your prices come today either way.",
    note: "A timer on every new lead on the Dashboard, red at 5:00. The call is logged as a touch." },
  { clock: 1, day: "0:30", sort: 2, title: "The scope drawing", channel: "mms", who: "Amy", status: "live",
    reason: "Proof we found their house. No competitor sends this.",
    body: "Here's the scope we're pricing, {name}. The blue line is what we'd stain. Not right? Tell me and I'll fix it.",
    image: { src: "/proposal-mockup/hero-family.jpg", caption: "Their fence traced on the map", overlay: "SCOPE OF WORK" } },
  { clock: 1, day: "Same day", sort: 3, title: "The proposal", channel: "text", who: "Amy", status: "live",
    reason: "Present numbers to everyone. Nobody leaves day one without a price.",
    body: "Here it is, {name}! Three options, pick what fits. Your price is good for 30 days.\nestimate.sterlingfencetx.com/p/…" },
  { clock: 1, day: "On open", sort: 4, title: "The 90-second call", channel: "call", who: "Alan", status: "rewrite",
    reason: "They're looking at it right now. Highest-converting minute in the funnel.",
    script: ["Hey {name}, Alan with Sterling. Saw you're looking at the proposal. Which one are you leaning toward?", "(Agree with whatever they say.) Good choice. Want me to lock your spot while you've got it open?"],
    vm: "Hey {name}, Alan with Sterling. Saw you opened the proposal, call me with any questions, 346-589-7877.",
    note: "The text to Alan already fires. It needs an owner by hour block so somebody always dials." },

  // ── Clock 2: the 30-day close window ─────────────────────────────────
  { clock: 2, day: "Day 0", sort: 0, title: "Any questions", channel: "text", who: "Amy", status: "live",
    reason: "Thirty minutes after the proposal. Open the door.",
    body: "Any questions on the three options, {name}? I'm right here." },
  { clock: 2, day: "Day 0", sort: 1, title: "The thank-you call", channel: "call", who: "Amy", status: "build",
    reason: "Cardone's same-day call. The 1-to-10 answer tells us everything.",
    script: ["Hey {name}, it's Amy with Sterling. Thanks for letting us price your fence.", "Any questions? What did I miss?", "Is there anyone else who needs to see it? Your spouse, the HOA?", "On a scale of 1 to 10, how close are you?"],
    vm: "Hey {name}, Amy with Sterling, just wanted to say thanks for letting us price the fence. Call me with anything, 346-589-7877.",
    after: "Just tried you, {name}. Wanted to make sure the three options made sense. Any questions?",
    note: "A call task on the lead with this script. The 1-to-10 is saved as an objection." },
  { clock: 2, day: "Day 1", sort: 2, title: "I have an idea", channel: "call", who: "Alan", status: "rewrite",
    reason: "Cardone's 24-hour contact. An idea, not a check-in. The idea is real.",
    script: ["{name}, Alan with Sterling. I looked at your fence again on the map and I have an idea about the back side.", "If nobody sees the back from the street, Essential back there and Signature on the front saves you about $300. Want me to re-price it that way?"],
    vm: "Hey {name}, it's Alan with Sterling. Looked at your fence again, I have an idea about the back side. Call me, 346-589-7877.",
    after: "Just tried you, {name}. Looked at your fence again and had an idea that saves some money. Call me when you've got a minute.",
    note: "Replaces today's day-1 text, which opens with 'just checking in'." },
  { clock: 2, day: "Day 2", sort: 3, title: "Something to send you", channel: "text", who: "Amy", status: "build",
    reason: "Cardone's 'want to be sure I have the right address.' Gets a reply and a photo.",
    body: "{name}, I'm putting together a picture of your fence in the color you were looking at. Text me a quick photo of the fence and I'll send it back stained." },
  { clock: 2, day: "Day 2", sort: 4, title: "Their fence, stained", channel: "mms", who: "Amy", status: "build",
    reason: "Our handwritten letter. Nobody else sends them their own fence.",
    body: "Here's yours in Signature, {name}. That's the Cedar Naturaltone. Want to see Legacy on it too?",
    image: { src: "/proposal-mockup/stain-cedar-naturaltone.jpg", caption: "Their photo, rendered", overlay: "YOUR FENCE · SIGNATURE" },
    note: "The render has to be built: their photo or the scope drawing with the package color applied. The most valuable touch on this page." },
  { clock: 2, day: "Day 3", sort: 5, title: "Face to the name", channel: "video", who: "Alan", status: "build",
    reason: "Cardone's day 3. A face makes the company real. 30 seconds, recorded on a job.",
    body: "{name}, quick one from today's job so you can put a face to the name.",
    video: "Alan on site, crew staining behind him: \"I'm Alan, I own Sterling. We looked at your fence. Here's what we'd do first. This number is my cell.\"",
    note: "One recording a week on site, sent with the customer's name in the text." },
  { clock: 2, day: "Day 4", sort: 6, title: "We're on your street", channel: "text", who: "Amy", status: "build",
    reason: "Cardone's personal visit, without the visit. See the color in daylight.",
    body: "{name}, we're staining a fence 0.4 miles from you Thursday, on Cypress Creek. Drive by after 2 and see the Signature color in real light. Here's the house: 123 Cypress Creek Dr.",
    note: "The nearby-jobs map exists. The step that writes this text from it does not." },
  { clock: 2, day: "Day 5", sort: 7, title: "Thought of you", channel: "text", who: "Amy", status: "rewrite",
    reason: "Cardone's day 5. A real reason that week: weather, pollen, the sun.",
    body: "Front coming Friday, {name}. Rain on bare wood is the one thing that doesn't wash off. Thought of your fence." },
  { clock: 2, day: "Day 7", sort: 8, title: "The deposit link closes tonight", channel: "text", who: "Amy", status: "build",
    reason: "A deadline we hold. Deposit links die at 7 days.",
    body: "{name}, your reserve link closes tonight. Here it is again. The price itself is good through the 31st.\nestimate.sterlingfencetx.com/pay/…" },
  { clock: 2, day: "Day 10", sort: 9, title: "Neighborhood day", channel: "text", who: "Amy", status: "build",
    reason: "Cardone's event offer. Only sent when it's true.",
    body: "{name}, we're doing three fences in your subdivision on the 24th. Add yours while the crew's already there and the neighborhood 10% applies. Want the spot?" },
  { clock: 2, day: "Day 14", sort: 10, title: "The exit survey", channel: "text", who: "Amy", status: "build",
    reason: "Cardone's survey. We never ask the lost ones what we missed.",
    body: "Three quick ones so I stop guessing, {name}. Did the price fit your budget? 1 to 10, how did we do? What's the one thing stopping you?",
    note: "Answers save as objections on the lead." },
  { clock: 2, day: "Day 21", sort: 11, title: "Before and after", channel: "video", who: "Amy", status: "build",
    reason: "Cardone's video email. Twenty seconds, no talking needed.",
    body: "This one was grayer than yours, {name}. Start to finish.",
    video: "A nearby job: gray fence, the crew, the finished Signature. 20 seconds." },
  { clock: 2, day: "Day 25", sort: 12, title: "Five days left", channel: "text", who: "Amy", status: "build",
    reason: "The honest deadline. After the 30th it's regular pricing.",
    body: "Five days left on your quoted price, {name}. After the 31st it's regular pricing. No pressure, I just didn't want you to miss it." },
  { clock: 2, day: "Day 30", sort: 13, title: "Price ended", channel: "text", who: "Amy", status: "build",
    reason: "The deadline is real because this text goes out and the page flips.",
    body: "Your quoted price ended today, {name}. The proposal still opens; regular pricing is on it now. If the timing's just off, I'll check in now and then.",
    note: "The page already flips at day 30 and texts Alan when they come back." },

  // ── Clock 3: the year ─────────────────────────────────────────────────
  { clock: 3, day: "Day 40", sort: 0, title: "Thinking about you", channel: "text", who: "Amy", status: "rewrite",
    reason: "A tip, not a check-in.",
    body: "{name}, most bare pickets start cupping by the second summer. Yours has had one. If you want the number refreshed, say the word." },
  { clock: 3, day: "Day 50", sort: 1, title: "Special offer", channel: "text", who: "Amy", status: "rewrite",
    reason: "Cardone's special offer. Real, with a date it ends.",
    body: "Fall booking is open, {name}: $150 off any package through November 15. It ends on the 16th, for real. Want your proposal refreshed with it?",
    note: "Replaces the '20% off for a limited time' text in today's nurture." },
  { clock: 3, day: "Day 60", sort: 2, title: "The FaceTime walk-around", channel: "text", who: "Alan", status: "build",
    reason: "Cardone's personal-visit offer, our way.",
    body: "{name}, Alan here. Walk me around your fence on FaceTime for five minutes. I'll tell you exactly what it needs and lock the number. When's good?" },
  { clock: 3, day: "Day 75", sort: 3, title: "Photo mockup, the other package", channel: "mms", who: "Amy", status: "build",
    reason: "Cardone's photo mockup. Side by side on their fence.",
    body: "Here's Legacy next to Signature on your fence, {name}. Which one's you?",
    image: { src: "/proposal-mockup/pkg-legacy-wide-b.jpg?v=3", caption: "Their fence, both packages", overlay: "YOUR FENCE · LEGACY" } },
  { clock: 3, day: "Day 90", sort: 4, title: "The management call", channel: "call", who: "Alan", status: "build",
    reason: "Cardone's management call. The owner, listening.",
    script: ["{name}, Alan, I own Sterling. You never got a number you liked from us and I want to know why.", "(Listen. Don't sell. Log what they say.)"],
    vm: "Hey {name}, Alan, I own Sterling Fence Staining. Not calling to sell you, I want to know what we got wrong. 346-589-7877." },
  { clock: 3, day: "Day 100", sort: 5, title: "Small gift, a real one", channel: "email", who: "Alan", status: "build",
    reason: "Cardone's special gift. Only if we send it. Only to people who talked to us.",
    subject: "Coffee's on me",
    body: "{name}, no strings. Here's a $5 coffee for the conversation we had about your fence. If it ever goes gray enough to bother you, you know where I am. Alan" },
  { clock: 3, day: "Day 120", sort: 6, title: "On your street again", channel: "text", who: "Amy", status: "build",
    reason: "The second nearby-job invite, when one lands within a mile.",
    body: "{name}, crew's on Windfern Trace Tuesday, a mile from you. Drive by and see Legacy in October light." },
  { clock: 3, day: "Day 150", sort: 7, title: "Neighbor special", channel: "text", who: "Amy", status: "build",
    reason: "Cardone's drop-off offer. A neighbor booked; the crew is already there.",
    body: "Your neighbor on Cypress Creek booked with us, {name}. If you go the same week the crew's already there: 10% off. Want in?" },
  { clock: 3, day: "Day 180", sort: 8, title: "The replacement math", channel: "email", who: "Amy", status: "build",
    reason: "Cardone's compelling information, with their numbers.",
    subject: "Your fence, six months later",
    body: "{name}, it's been six months since we priced your fence. Replacing it runs about $9,000. Staining it was $2,390 on your proposal. That's one more summer of sun on bare wood. Here's the proposal if you want to look again." },
  { clock: 3, day: "Day 210", sort: 9, title: "Just got this in", channel: "mms", who: "Amy", status: "build",
    reason: "Cardone's 'just got this in via text.' A new color on a real fence.",
    body: "Just got this one back, {name}. Potato Skin on a 6-foot cedar. Thought of you.",
    image: { src: "/proposal-mockup/stain-dark-walnut.jpg", caption: "A fresh job, a new color" } },
  { clock: 3, day: "Day 240", sort: 10, title: "The apology call", channel: "call", who: "Alan", status: "build",
    reason: "Cardone's apology contact. Nothing to sell on this call.",
    script: ["{name}, Alan with Sterling. What did we do wrong?", "Where did I miss it?", "What could we have done differently?"],
    vm: "Hey {name}, Alan with Sterling. I'd like to know where we missed it with you. No pitch. 346-589-7877.",
    after: "Just tried you, {name}. Where did we miss it? One line back helps me more than you'd think." },
  { clock: 3, day: "Day 270", sort: 11, title: "The chocolate boot", channel: "mms", who: "Amy", status: "build",
    reason: "Cardone's gimmick, done honestly: a picture, not a promise.",
    body: "No strings, {name}. Just thought of you.",
    image: { src: "/proposal-mockup/pkg-essential.jpg", caption: "Their fence, with pumpkins on it", overlay: "🎃 🎃 🎃" },
    note: "A generated picture of their fence dressed for the season. We never say a gift is coming unless it is." },
  { clock: 3, day: "Day 300", sort: 12, title: "Person of influence", channel: "text", who: "Amy", status: "build",
    reason: "Cardone's person of influence. A neighbor's review by street.",
    body: "{name}, your neighbor two doors down had us out last month. Her words: \"It looks like a new fence and the crew was gone by 3.\" Want her color?" },
  { clock: 3, day: "Day 330", sort: 13, title: "Why not us", channel: "text", who: "Alan", status: "build",
    reason: "Cardone's testimonial request, turned around for the unsold.",
    body: "{name}, Alan here. One line, honest: why didn't it happen? It helps me more than you'd think." },
  { clock: 3, day: "Day 365", sort: 14, title: "The anniversary close call", channel: "call", who: "Alan", status: "build",
    reason: "Cardone's anniversary call. A fresh proposal goes out the same day.",
    script: ["{name}, Alan with Sterling. A year ago today you asked about your fence.", "It's a year older. Here's the new number, and it's good for 30 days again."],
    vm: "Hey {name}, Alan with Sterling. A year ago today you asked us about your fence. It's a year older. New number's on its way. 346-589-7877." },
];

const CLOCKS: { id: Clock; name: string; sub: string; icon: React.ElementType; accent: keyof typeof ACCENT }[] = [
  { id: 1, name: "The first hour", sub: "Lead arrives. Be first.", icon: Clock, accent: "amber" },
  { id: 2, name: "The 30-day close", sub: "Proposal sent. 15 touches, 5 channels.", icon: CalendarDays, accent: "gold" },
  { id: 3, name: "The year", sub: "One touch every 2 to 4 weeks, never the same twice.", icon: Repeat, accent: "cedar" },
];

const CHANNEL: Record<Channel, { label: string; icon: React.ElementType; cls: string }> = {
  text: { label: "Text", icon: MessageSquare, cls: "bg-emerald-100 text-emerald-800" },
  call: { label: "Call", icon: Phone, cls: "bg-blue-100 text-blue-800" },
  video: { label: "Video", icon: Video, cls: "bg-fuchsia-100 text-fuchsia-800" },
  mms: { label: "Picture", icon: ImageIcon, cls: "bg-amber-100 text-amber-800" },
  email: { label: "Email", icon: Mail, cls: "bg-stone-200 text-stone-800" },
};

const STATUS: Record<Status, { label: string; icon: React.ElementType; cls: string }> = {
  live: { label: "Runs today", icon: CheckCircle2, cls: "bg-emerald-600 text-white" },
  rewrite: { label: "Rewrite", icon: Pencil, cls: "bg-amber-500 text-white" },
  build: { label: "To build", icon: Hammer, cls: "bg-stone-700 text-white" },
};

const RULES: [string, string][] = [
  ["Speed", "A human within 5 minutes. A price the same day."],
  ["Frequency", "80% of sales happen between the 5th and 12th touch. We used to quit at 2."],
  ["Variety", "Call, voicemail, text, picture, video, email. Never the same channel twice in a row."],
  ["A reason, every time", "The first line says why. \"Just checking in\" is banned."],
  ["Always leave a message", "No answer is still a touch: voicemail, then the text that says we called."],
  ["Always agree", "\"You're right, it's not cheap. Here's why people do it anyway.\""],
  ["Numbers to everyone", "Sides answered or not, they get three prices today."],
  ["Ask for referrals", "\"Who do you know with a fence going gray?\" Never \"if you know anybody.\""],
  ["Honest urgency only", "A deadline we hold. A gift we send. A picture, not a promise."],
];

const MISTAKES: string[] = [
  "Not making the call. The 'just opened' text fires and nobody dials.",
  "Quitting at touch 2. Intake texts twice, waits 24 hours, moves them to Cold.",
  "Silence from day 14 to day 42, right when they're reading the other quotes.",
  "One channel, one voice. Seven texts from Amy, no calls, no video, no pictures.",
  "\"Just checking in\" opens three of today's texts.",
  "\"20% off for a limited time\" in the nurture. Not real, and people noticed.",
  "No referral ask until the after-payment page, which only buyers see.",
  "No exit survey. We never ask the lost ones what we missed.",
  "No second sale. The service chips exist; nothing follows them.",
];

function fill(text: string, name: string): string {
  return text.replaceAll("{name}", name || "Maria");
}

/** One grey iPhone bubble from Sterling. */
function Bubble({ children, tail = true }: { children: React.ReactNode; tail?: boolean }) {
  return (
    <div className={cn("max-w-[86%] whitespace-pre-line rounded-2xl bg-[#E9E9EB] px-3.5 py-2 text-[15px] leading-snug text-black", tail && "rounded-bl-md")}>
      {children}
    </div>
  );
}

function Picture({ image }: { image: NonNullable<Touch["image"]> }) {
  return (
    <div className="relative max-w-[86%] overflow-hidden rounded-2xl rounded-bl-md ring-1 ring-black/10">
      <img src={image.src} alt="" className="block h-40 w-full object-cover" draggable={false} />
      {image.overlay ? (
        <span className="absolute left-2 top-2 rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-[#E3BE63]">{image.overlay}</span>
      ) : null}
      <span className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-6 text-[12px] font-semibold text-white">{image.caption}</span>
    </div>
  );
}

function VideoTile({ what }: { what: string }) {
  return (
    <div className="relative max-w-[86%] overflow-hidden rounded-2xl rounded-bl-md bg-black ring-1 ring-black/10">
      <div className="flex h-40 items-center justify-center">
        <PlayCircle className="h-12 w-12 text-white/90" />
      </div>
      <span className="absolute left-2 top-2 rounded-md bg-white/15 px-1.5 py-0.5 text-[11px] font-bold text-white">0:30</span>
      <p className="px-3 pb-3 text-[12px] leading-snug text-white/85">{what}</p>
    </div>
  );
}

/** The phone a touch lands on: bubbles, pictures, the video, or the call. */
function Preview({ t, name }: { t: Touch; name: string }) {
  if (t.channel === "call") {
    return (
      <div className="space-y-2">
        <div className="rounded-2xl bg-ink p-3.5 text-ivory ring-1 ring-gold/40">
          <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-gold"><Phone className="h-3.5 w-3.5" /> {t.who} calls</p>
          <ol className="mt-2 space-y-1.5 text-[14px] leading-snug">
            {(t.script || []).map((line, i) => (
              <li key={i} className={cn("flex gap-2", line.startsWith("(") && "text-ivory/60 italic")}>
                <span className="shrink-0 text-ivory/40">{i + 1}.</span><span>{fill(line, name)}</span>
              </li>
            ))}
          </ol>
        </div>
        {t.vm ? (
          <div className="rounded-xl bg-white p-3 ring-1 ring-border">
            <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground"><Voicemail className="h-3.5 w-3.5" /> No answer: the voicemail</p>
            <p className="mt-1 text-[14px] leading-snug">{fill(t.vm, name)}</p>
          </div>
        ) : null}
        {t.after ? (
          <div>
            <p className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground"><MessageSquare className="h-3.5 w-3.5" /> Then the text that says we called</p>
            <Bubble>{fill(t.after, name)}</Bubble>
          </div>
        ) : null}
      </div>
    );
  }
  if (t.channel === "email") {
    return (
      <div className="overflow-hidden rounded-xl bg-white ring-1 ring-border">
        <div className="border-b border-border bg-muted/40 px-3 py-2 text-[12px]">
          <p><span className="text-muted-foreground">From:</span> {t.who === "Alan" ? "Alan" : "Amy"} at Sterling Fence Staining</p>
          <p><span className="text-muted-foreground">Subject:</span> <span className="font-semibold">{t.subject}</span></p>
        </div>
        <p className="whitespace-pre-line px-3 py-2.5 text-[14px] leading-snug">{fill(t.body || "", name)}</p>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {t.channel === "video" && t.video ? <VideoTile what={t.video} /> : null}
      {t.image && t.channel !== "video" ? <Picture image={t.image} /> : null}
      {t.body ? <Bubble>{fill(t.body, name)}</Bubble> : null}
      {t.image && t.channel === "text" && t.image.caption ? <Picture image={t.image} /> : null}
    </div>
  );
}

function WhoChip({ who }: { who: Who }) {
  const cls = who === "Alan" ? "bg-ink text-gold" : who === "Amy" ? "bg-gold/20 text-bronze" : "bg-stone-200 text-stone-700";
  return <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold", cls)}>{who === "Auto" ? "Automatic" : who}</span>;
}

/** The customer's whole thread for one clock: what their Messages app
 *  shows after the clock has run with nobody replying. */
function Thread({ touches, name }: { touches: Touch[]; name: string }) {
  const items = touches.filter((t) => t.channel !== "call" && t.channel !== "email");
  return (
    <div className="mx-auto w-full max-w-[390px] overflow-hidden rounded-[2rem] bg-white shadow-2xl ring-8 ring-stone-800">
      <div className="border-b border-border bg-[#F6F6F6] px-4 pb-2 pt-3 text-center">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-ink"><img src="/sterling-logo-dark.png" alt="" className="h-5 w-auto" draggable={false} /></div>
        <p className="mt-1 text-[12px] font-semibold">Sterling Fence Staining</p>
      </div>
      <div className="max-h-[640px] space-y-2 overflow-y-auto bg-white px-3 py-3">
        {items.map((t, i) => (
          <div key={`${t.clock}-${t.sort}`} className="space-y-1.5">
            {i === 0 || items[i - 1].day !== t.day ? <p className="py-1 text-center text-[11px] font-semibold text-muted-foreground">{t.day}</p> : null}
            {t.channel === "video" && t.video ? <VideoTile what={t.video} /> : null}
            {t.image && t.channel === "mms" ? <Picture image={t.image} /> : null}
            {t.body ? <Bubble>{fill(t.body, name)}</Bubble> : null}
            {t.image && t.channel === "text" ? <Picture image={t.image} /> : null}
          </div>
        ))}
        {items.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">Calls only on this clock.</p> : null}
      </div>
    </div>
  );
}

export default function CardoneFollowUps() {
  const [clock, setClock] = useState<Clock>(2);
  const [name, setName] = useState("Maria");
  const [view, setView] = useState<"timeline" | "thread">("timeline");
  const [only, setOnly] = useState<Channel | "all">("all");

  const touches = useMemo(() => TOUCHES.filter((t) => t.clock === clock).sort((a, b) => a.sort - b.sort), [clock]);
  const shown = useMemo(() => (only === "all" ? touches : touches.filter((t) => t.channel === only)), [touches, only]);
  const counts = useMemo(() => ({
    total: TOUCHES.length,
    live: TOUCHES.filter((t) => t.status === "live").length,
    build: TOUCHES.filter((t) => t.status === "build").length,
    rewrite: TOUCHES.filter((t) => t.status === "rewrite").length,
  }), []);
  const current = CLOCKS.find((c) => c.id === clock)!;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      <div className="overflow-hidden rounded-2xl bg-ink text-ivory shadow-lg">
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-gold to-bronze shadow-sm">
            <Repeat className="h-5 w-5 text-ink" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="font-heading text-xl font-bold leading-tight">Cardone's Follow-Ups</h1>
            <p className="text-xs text-ivory/70">Every touch of the year, the way the customer meets it. Nothing on this page sends anything.</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-bold">
            <span className="rounded-full bg-white/10 px-2.5 py-1">{counts.total} touches</span>
            <span className="rounded-full bg-emerald-500/20 px-2.5 py-1 text-emerald-200">{counts.live} run today</span>
            <span className="rounded-full bg-amber-500/20 px-2.5 py-1 text-amber-200">{counts.rewrite} rewrite</span>
            <span className="rounded-full bg-white/10 px-2.5 py-1">{counts.build} to build</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-white/10 px-5 py-2.5 text-xs">
          <label className="flex items-center gap-2">
            <span className="text-ivory/70">Preview as</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Maria"
              className="h-7 w-28 rounded-md bg-white/10 px-2 text-ivory placeholder:text-ivory/40 focus:outline-none focus:ring-2 focus:ring-gold" />
          </label>
          <span className="text-ivory/50">The texts use their first name. A reply stops the clock and hands them to a person for 48 hours. STOP stops everything. Nothing before 8 AM or after 8 PM.</span>
        </div>
      </div>

      {/* The three clocks */}
      <div className="grid gap-2 sm:grid-cols-3">
        {CLOCKS.map((c) => {
          const Icon = c.icon;
          const on = clock === c.id;
          const n = TOUCHES.filter((t) => t.clock === c.id).length;
          return (
            <button key={c.id} type="button" onClick={() => { setClock(c.id); setOnly("all"); }}
              className={cn("flex items-center gap-3 rounded-2xl p-3 text-left ring-1 transition",
                on ? "bg-white shadow-md ring-2 ring-gold" : "bg-white/60 ring-border hover:bg-white")}>
              <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white", ACCENT[c.accent].grad)}><Icon className="h-5 w-5" /></div>
              <div className="min-w-0">
                <p className="font-heading text-sm font-bold">{c.name} <span className="ml-1 text-[11px] font-semibold text-muted-foreground">{n} touches</span></p>
                <p className="text-[11px] text-muted-foreground">{c.sub}</p>
              </div>
            </button>
          );
        })}
      </div>

      {/* View and channel filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg bg-muted p-0.5 text-xs font-semibold">
          {(["timeline", "thread"] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)} className={cn("h-7 rounded-md px-3", view === v ? "bg-white shadow-sm" : "text-muted-foreground")}>
              {v === "timeline" ? "Touch by touch" : "Their phone"}
            </button>
          ))}
        </div>
        {view === "timeline" ? (
          <div className="flex flex-wrap gap-1">
            {(["all", "text", "call", "video", "mms", "email"] as const).map((k) => {
              const on = only === k;
              const label = k === "all" ? "All" : CHANNEL[k].label;
              return (
                <button key={k} type="button" onClick={() => setOnly(k)}
                  className={cn("h-7 rounded-full px-2.5 text-xs font-semibold ring-1", on ? "bg-ink text-ivory ring-ink" : "bg-white text-muted-foreground ring-border hover:text-foreground")}>
                  {label}
                </button>
              );
            })}
          </div>
        ) : null}
        <p className="ml-auto text-xs text-muted-foreground">{current.name}: {touches.length} touches</p>
      </div>

      {view === "thread" ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-2 text-sm text-muted-foreground">
            <p className="font-semibold text-foreground">This is what {name || "Maria"}'s Messages app looks like after {current.name.toLowerCase()} has run with no reply.</p>
            <p>Calls and emails aren't in the thread; they're on the touch-by-touch view. Every bubble has a reason in the first line and none of them says "just checking in."</p>
            <p>Read it as the customer. If a bubble would make you roll your eyes, say which one.</p>
          </div>
          <Thread touches={touches} name={name} />
        </div>
      ) : (
        <ol className="relative space-y-3 border-l-2 border-gold/40 pl-5">
          {shown.map((t) => {
            const ch = CHANNEL[t.channel];
            const st = STATUS[t.status];
            const ChIcon = ch.icon;
            const StIcon = st.icon;
            return (
              <li key={`${t.clock}-${t.sort}`} className="relative">
                <span className="absolute -left-[31px] top-4 flex h-5 w-5 items-center justify-center rounded-full bg-gold ring-4 ring-background"><ChIcon className="h-3 w-3 text-ink" /></span>
                <div className="grid gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-border lg:grid-cols-[minmax(0,1fr)_380px]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-md bg-ink px-2 py-0.5 font-heading text-[13px] font-bold text-gold">{t.day}</span>
                      <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold", ch.cls)}><ChIcon className="h-3 w-3" /> {ch.label}</span>
                      <WhoChip who={t.who} />
                      <span className={cn("ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold", st.cls)}><StIcon className="h-3 w-3" /> {st.label}</span>
                    </div>
                    <h3 className="mt-2 font-heading text-lg font-bold leading-tight">{t.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground"><span className="font-semibold text-foreground">Why: </span>{t.reason}</p>
                    {t.note ? (
                      <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-900 ring-1 ring-amber-200"><Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t.note}</p>
                    ) : null}
                  </div>
                  <div className="rounded-xl bg-[#F8F3E7] p-3 ring-1 ring-gold/30">
                    <Preview t={t} name={name} />
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel icon={ShieldCheck} title="The rules, in our words" sub="Cardone's system, translated for a company that never visits in person" accent={ACCENT.gold} bodyClassName="p-3.5">
          <ol className="space-y-2">
            {RULES.map(([t, d], i) => (
              <li key={t} className="flex gap-2.5 text-sm">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gold text-[11px] font-bold text-ink">{i + 1}</span>
                <span><span className="font-semibold">{t}.</span> <span className="text-muted-foreground">{d}</span></span>
              </li>
            ))}
          </ol>
        </Panel>
        <Panel icon={AlertTriangle} title="The mistakes we make today" sub="Measured against the two PDFs and our own sequences" accent={ACCENT.rose} bodyClassName="p-3.5">
          <ul className="space-y-2">
            {MISTAKES.map((m) => (
              <li key={m} className="flex gap-2.5 text-sm"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" /><span className="text-muted-foreground">{m}</span></li>
            ))}
          </ul>
        </Panel>
      </div>

      <Panel icon={ListChecks} title="What has to be built before the engine can run this" sub="In order. The render first." accent={ACCENT.ink} bodyClassName="p-3.5">
        <ol className="grid gap-2 text-sm sm:grid-cols-2">
          {[
            "Call tasks with a clock: a timer on new leads, a task with the script on call days, undone ones in the 3 PM digest.",
            "A name on the proposal-opened alert, by hour block.",
            "The fence render: their photo or the scope drawing with the package color on it.",
            "Video and voice steps in the engine, with Alan's weekly recording slot.",
            "The nearby-job text written from the nearby-jobs map.",
            "Real dated offers in Settings, so day 50 and the ad say the same thing.",
            "The 30-day close window replaces the 14-day estimate sequence; the year replaces the nurture.",
            "The exit survey and the 1-to-10 saved as objections.",
            "Touch count and channel on every lead, and close rate by touch number.",
          ].map((s, i) => (
            <li key={s} className="flex gap-2.5 rounded-lg bg-muted/40 px-3 py-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink text-[11px] font-bold text-gold">{i + 1}</span>
              <span className="text-muted-foreground">{s}</span>
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}
