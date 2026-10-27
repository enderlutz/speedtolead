// The first-call script (v3, 2026-10-27). Built from the transcripts of
// Alan's own last five closed jobs (Oct 21 to 27, 2026) plus the run-through
// Alan did with Olga on 2026-10-27. No customer names in this file: the
// repo is public. Shown on the Call
// script tab. Word-for-word lines are in `say`; the branches are what the
// customers on those calls actually said.
//
// Rule of thumb when editing: keep the words a real customer heard on a
// call that closed. Don't invent lines.

export type ScriptLine =
  | { kind: "say"; text: string }
  | { kind: "do"; text: string }
  | { kind: "if"; when: string; say: string; then?: string }
  | { kind: "note"; text: string };

export type ScriptStep = {
  id: string;
  title: string;
  goal: string;              // one line: what this step gets you
  lines: ScriptLine[];
};

export type Objection = { when: string; say: string; why?: string };

export type CheatCard = { title: string; rows: string[] };

export const SCRIPT_VERSION = "v3 · 2026-10-27";

export const SCRIPT_RULES: string[] = [
  "Call every new lead inside 5 minutes, 8 AM to 8 PM. Call before you send anything.",
  "Speak slowly the whole call. Use sir or ma'am and their last name.",
  "Dial first, measure while they talk. Everything you need is on the lead page.",
  "Never ask “which package do you want?” Ask natural or solid.",
  "Never ask “is this something you want done soon?” Give one weekday and one weekend day.",
  "The $250 locks the spot. The package and the color can still change on cleaning day.",
  "Prices include tax. Say it before they ask.",
];

export const SCRIPT_STEPS: ScriptStep[] = [
  {
    id: "before",
    title: "Before you dial",
    goal: "Under a minute. Know what you are looking at before they pick up.",
    lines: [
      { kind: "do", text: "Open the lead. Pull up the house on the satellite. Find the fence: Google Maps, then Apple Maps, then a look-alike house, then HAR photos." },
      { kind: "do", text: "Street View: how tall is it, how gray is it. You confirm height from the picture, you never ask it." },
      { kind: "do", text: "Open the calendar. Know one open weekday and one open weekend day before you dial." },
      { kind: "note", text: "If they already told us the sides on the form, measure before you call so the price is ready." },
    ],
  },
  {
    id: "open",
    title: "Open",
    goal: "Their name, your name, the company, one warm line. Ten seconds.",
    lines: [
      { kind: "say", text: "Hi, is this Mr. [Last name]?" },
      { kind: "say", text: "Hi Mr. [Last name], this is [Your name] with Sterling Fence Staining. I'm the project manager here. How are you doing today?" },
      { kind: "note", text: "Alan says “project manager”. Olga is Amy on calls, Gioconda is Lily. Say what they would hear if they called the office back." },
      { kind: "if", when: "They give you a line (“better than I deserve”)", say: "Same here. Weather's amazing, can't ask for much more than this." },
      { kind: "if", when: "Hard last name", say: "Is it [try it]? Did I say it right?", then: "Use whatever they say. At the end: “Where is that name from?”" },
    ],
  },
  {
    id: "why-calling",
    title: "Why you're calling",
    goal: "Confirm it is the right house. Make it a quick confirmation call, not a sales call.",
    lines: [
      { kind: "say", text: "Perfect. Awesome, Mr. [Last name]. So I just wanted to give you a quick call and confirm the scope of work with you, the sides of the fence you wanted to get stained. I have here that your address is [street address], right?" },
      { kind: "if", when: "They're at work or driving", say: "No problem. Real quick, which sides of the fence did you want stained?", then: "Get the sides. Send the proposal while you have them. Then book the exact time to call back: “When would be a good time to give you a call back when you're home, so I can walk you through everything?”" },
      { kind: "if", when: "“I didn't fill anything out”", say: "Oh, okay, no problem. Are you interested in getting your fence stained?", then: "If no: “No problem, have a great day.”" },
      { kind: "if", when: "“How much is it?” right away", say: "Yeah, no problem. It depends on how long your fence is, the height, the age, and whether it's been stained before. Let me confirm a couple of things and I'll get you the exact price." },
    ],
  },
  {
    id: "sides",
    title: "Confirm the sides from the picture",
    goal: "The must-ask. Describe their yard back to them until they say yes.",
    lines: [
      { kind: "say", text: "Let me pull up your house here. So when you're standing in your driveway looking at the house, it looks like the fence attaches to the back right corner of the house, goes across the back kind of like a rectangle, and then comes back to the front by the garage. Right?" },
      { kind: "say", text: "I just want to make sure nothing was added there, since the photos sometimes aren't fully up to date." },
      { kind: "say", text: "Okay, perfect. So it'll be all the insides when you're standing in your backyard, and the two front gates. Is that correct?" },
      { kind: "if", when: "“The front is metal and brick”", say: "Perfect. So it would just be the left side, the back, and the right side. Let me update that here." },
      { kind: "if", when: "“Both sides”", say: "Okay, so everything double-sided. I got you here. You'll see on the pricing that you save more doing both sides, since we're doing more square footage.", then: "If they ask for both prices: send double-sided first, then one-sided." },
      { kind: "if", when: "“Just the outside, that's the HOA easement” or “only the sides that face the street”", say: "Okay, perfect. So all the insides and the outside front.", then: "A small outside section they only want cleaned: “We can clean that, no problem. I won't charge you extra, it's a very small section.”" },
      { kind: "if", when: "There's a second little fence, a trash-can section, planter boxes, a koi pond", say: "I see on the left side by the garage there's like a second section. Is that still there? Do you want the inside of that stained as well?", then: "Add it. Ask how many and how big." },
      { kind: "say", text: "Looks like a standard six-foot fence?" },
    ],
  },
  {
    id: "why-age",
    title: "Ask why, then age and condition",
    goal: "The reason they're buying, in their words. Then the three facts that set the price.",
    lines: [
      { kind: "say", text: "And also, Mr. [Last name], I was just curious. What was the main reason for wanting to get your fence stained? Was it more the longevity aspect of it, or was there a certain look you were going for?" },
      { kind: "do", text: "Listen. Say it back: “So the main reason is just to get it lasting as long as possible?” Keep it. You use it when you recommend the package and the color." },
      { kind: "say", text: "And how old is this fence?" },
      { kind: "if", when: "“I honestly don't know”", say: "Oh, no problem at all. Just as long as I have a good idea. Let's say about nine to ten years-ish, right?" },
      { kind: "say", text: "And when you look at it right now, is it leaning at all? Any problems, any broken boards?" },
      { kind: "say", text: "And have you ever had it stained before?" },
      { kind: "if", when: "Yes", say: "When was the last time? And was it a color you did, or just a clear coat? Did you do one coat or two?" },
      { kind: "if", when: "It's gray, my husband put bleach on it, the weed eater took the stain off at the bottom, the sunny sides are fading", say: "Okay, that makes sense. That's exactly what the soft wash takes off, and then two coats brings it back." },
      { kind: "if", when: "“I've only been here six years, never stained it”", say: "Okay, awesome. So you're just trying to get it all refreshed and back up and running." },
    ],
  },
  {
    id: "process",
    title: "The process, while you measure",
    goal: "Say it the same way every time. It answers the questions before they ask them.",
    lines: [
      { kind: "say", text: "Okay, sir. So while I'm measuring your fence, I'll also explain the process to you." },
      { kind: "say", text: "It's a two-day process if your fence needs to get cleaned. The first day we come out and do the cleaning. Our cleaning is a soft wash. It's a chemical-based cleaning, high volume rather than high pressure, because a pressure washer can damage the wood grain and the fibers in the wood. We don't do any power washing. The soft wash takes off all the gray, the sprinkler stains, everything you see on the fence." },
      { kind: "say", text: "That way, when we come back to stain, the fence is fully dry and the pores are wide open. That's when we do two coats of stain, and we back-brush it if needed. That makes sure the stain actually penetrates into the wood, it lasts a lot longer, and it looks even, with any of our packages, sir." },
      { kind: "say", text: "And if there are any boards that are loose, we screw those back in at no charge before we stain, so everything is flat. Any replacements are extra, and you can tally those up yourself in the proposal. It just depends on the height of the fence, and for pickets, whether you want pine or cedar." },
      { kind: "if", when: "“It's brand new”", say: "Is there any gray on it, or any faded stain?", then: "Built in the last 1 to 2 weeks: too wet, book it later. 3 weeks to 6 months and no gray: “Perfect, we'll just stain it, no cleaning needed.” Any gray: the full two-day process." },
      { kind: "if", when: "“I'll need some pickets replaced, a post for my gate, some rails are drooping”", say: "Perfect. We charge a flat rate for all of that. It's $12 a pine picket, $14 cedar, and the rails and posts are priced in the proposal too. If you count them up and tell me, I can get you an answer right now. Or when we come out to clean, our cleaner has all the pricing. He'll see what you need, and we go from there.", then: "If they have an iPhone: “Can I FaceTime you real quick and we count them together?”" },
      { kind: "if", when: "“How long does each day take?”", say: "The cleaning is about five to six hours. The staining with two guys is usually a full day for your fence." },
    ],
  },
  {
    id: "send",
    title: "Send the proposal",
    goal: "The link lands while you are on the phone. Never after.",
    lines: [
      { kind: "say", text: "So, sir, I'm sending you over the proposal here. It's going to come through text message, from this same number. Let me know when you receive the link." },
      { kind: "say", text: "Perfect. Alrighty, sir, let me know when you see the three packages." },
      { kind: "if", when: "They're driving or can't look", say: "No problem at all. I'll just explain the packages to you now, so when you do review the estimate you understand it a little more.", then: "Give the three packages in one breath (next step), then: “When would be a good time to give you a call back when you're home, so I can walk you through everything?” Book the exact hour. “Either way, this is our business number. Me, Amy or Lily will answer.”" },
      { kind: "if", when: "“How much is it? I didn't see it”", say: "It should have come through from the number I'm calling you from. It's three packages, that's why I'd like you to look at it with me for just a second.", then: "If they still can't: say the Signature price, then the Legacy price, in that order." },
    ],
  },
  {
    id: "packages",
    title: "The three packages",
    goal: "Essential, Signature, Legacy, with how long each lasts. Then one line that is about them.",
    lines: [
      { kind: "say", text: "Awesome, sir. So our three packages are the Essential, the Signature and the Legacy." },
      { kind: "say", text: "The Essential is more of a clear coat on the fence after it's cleaned. That's going to give you about two years of longevity. It's typically for the newer fences." },
      { kind: "say", text: "The Signature is the second one. That's our most popular option. It's more of a semi-transparent stain, so it's more natural, and you can still see the wood grain, sir. You'll usually get three to four years out of it, sometimes five." },
      { kind: "say", text: "Then the Legacy is our longest-lasting finish. It's a solid stain, so it has more pigment and sealer mixed into it, and it covers up the imperfections in the wood. Those last four to seven years, sometimes longer." },
      { kind: "say", text: "They all include two coats of stain, so it looks even and lasts as long as possible. And the pricing includes tax, so there's nothing extra." },
      { kind: "do", text: "Now one line that is about them, from the why and the age. Make them feel it." },
      { kind: "if", when: "Older fence", say: "I know you mentioned you have an older fence, so depending on the condition of it, we would probably recommend the Legacy." },
      { kind: "if", when: "“I want it to last, I don't care about the color”", say: "You're looking for something to give you another five years, right? So I would recommend the Legacy, but you could also go with the Signature." },
      { kind: "if", when: "Previously stained", say: "Some of our customers with a previously stained fence like the Legacy, since it covers up the previous stain all the way. But if you're looking to match what you have, we can color-match it with the Signature.", then: "Same color or darker, never lighter." },
      { kind: "if", when: "“Why those years?” or they sound unsure", say: "The reason we have those ranges is we've been doing this seven years, and we're just now getting the first solid-stain fences calling us back to restain. It depends on your yard too. Usually the west side fades first." },
      { kind: "note", text: "On a phone the packages show top to bottom. Say “the second one” and “the last one”, not “in the middle” or “on the right”." },
    ],
  },
  {
    id: "pick",
    title: "Let them pick",
    goal: "Natural or solid. Never “which package”.",
    lines: [
      { kind: "say", text: "So, sir, in regards to the packages, were you looking for something more natural, like the Signature? Or were you looking for more of a premium solid option, that has more pigment and sealer mixed into it?" },
      { kind: "if", when: "Newer fence", say: "Were you looking more toward just a clear coat, or more of a natural stain?" },
      { kind: "if", when: "“The middle one”", say: "Okay, perfect. The Signature." },
      { kind: "if", when: "“What about the one that covers the wood all the way?”", say: "That's the solid stain, the Legacy. That one's going to last longer, since it has more pigment and sealer mixed into it. That's just going to give you more longevity.", then: "Say the Legacy price." },
    ],
  },
  {
    id: "color",
    title: "Color",
    goal: "A color on the phone if you can. If not, cleaning day, and that is fine.",
    lines: [
      { kind: "say", text: "Okay, sir. So if you go down, you can see the colors for the Signature and the Legacy. Do you like any of the colors you see there?" },
      { kind: "if", when: "“What's the most popular?”", say: "On the Signature it's the Cedar Naturaltone. Most people go with it. It's the most natural color, you'll still see the wood grain, and it gives it good protection. On the Legacy, October Brown and Darkest Night are the ones that go the most." },
      { kind: "if", when: "“Match it to my house”", say: "What color is your house? Let me look at your front door and the trim here. Honestly, that looks exactly like October Brown.", then: "Chocolate Chips is a really dark brown. Classic Mahogany is more of a maroon, the Aggie color. Redwood Naturaltone is the orange-y cedar look. Cedar Naturaltone is the natural cedar." },
      { kind: "if", when: "“October Brown or Potato Skin, which do you recommend?”", say: "For your house I'd go October Brown.", then: "Pick one. Say why in five words." },
      { kind: "if", when: "Still can't choose, or “I have to talk to my wife about the colors”", say: "No problem at all, sir. Look, you do not have to make a final decision on the color right now. That's why the colors are there for you to look at. We believe that for you to make the right decision for your fence, you should see it in person. So what we do is we schedule you for the cleaning, and you don't have to decide the color today. When we come out, we paint the colors on a stick and show you the different options, so you can make the right decision. Our cleaner will recommend the best package for your fence as well.", then: "Only for people who really want to see it. The goal is still a color on the phone." },
      { kind: "if", when: "“I like the Signature but I don't like any of the colors”", say: "Okay, perfect, no problem, sir. We actually have more options than that. Those are just our most popular ones. When we come out and clean the fence, we can show you. And I'm glad I got an idea of the colors you like, sir. You said you like the dark browns. Perfect, so I can bring you those." },
      { kind: "if", when: "“I want to keep the color I have”", say: "If you've had it that long, why change it? I would do the same thing. We offer that color with our packages, so you'll see it in the proposal. Do you know what stain it was?", then: "Orange-y cedar is usually Redwood Naturaltone. Oil-based on request: “We use oil-based as well, so we can always color-match it.”" },
      { kind: "if", when: "“I want Cabot” or their own brand", say: "We can do that. We typically use Valspar, but we've used Cabot. What's the exact name of the color? And have you seen it on a fence, or just on the can? I just like to make sure, because sometimes we apply a requested color and then they don't like it.", then: "Get the opacity too: “Is it semi-transparent or semi-solid?” Semi-solid is the Legacy line. Put the exact product on the job." },
    ],
  },
  {
    id: "book",
    title: "Book it",
    goal: "Two dates, their pick, the invite, the two ways to pay.",
    lines: [
      { kind: "say", text: "Awesome, sir. So right now we actually have next Tuesday and Saturday available. Do you typically like to get things like this done on weekdays or weekends?" },
      { kind: "if", when: "“Weekends, if possible”", say: "Okay. Are you home at all on the weekdays by chance?", then: "Clean on the weekday they're home, stain on the weekend: “So we can do Friday for the cleaning, and then stain it Saturday or Sunday. We'll confirm the exact staining day with you once the cleaning is done.”" },
      { kind: "if", when: "“We have a party on the 30th”", say: "Okay, so we'd want it done before that. Let me see. We could clean it Monday and come back and stain it Wednesday." },
      { kind: "say", text: "Okay, perfect, sir. So what I can do then is I'll get you scheduled here. I'm going to send you a booking invite. You can either choose to pay the $250 deposit up front and the remainder when the job is done. Or you can pay with Klarna, which lets you pay in four payments at 0% interest. On that one you just have to get approved up front, sir." },
      { kind: "say", text: "The $250 just locks in your spot. You can change the package or the color whenever you'd like, even when we come out and show you the samples. Does that make sense?" },
      { kind: "if", when: "“Do I have to be home?”", say: "Nobody has to be home, but we love it when you are, especially for the cleaning, so you can see the samples. And if you aren't home for any reason, I can always have our crew member FaceTime you. We walk the whole property with you on video. We don't leave unless you're fully happy with everything." },
      { kind: "if", when: "“Start inside first, I have dogs” or any request", say: "Okay, perfect. I'll put a note on the calendar on our end so the team sees it.", then: "Put it on the job now, while they watch you do it." },
    ],
  },
  {
    id: "pay",
    title: "Walk them through the $250",
    goal: "Stay on the line until it says paid. This is where the job is won.",
    lines: [
      { kind: "say", text: "I just sent you over the booking link. Let me know when it comes through. It's a new system we just switched to, so sometimes people have trouble finding the exact button, that's why I'd rather walk you through it." },
      { kind: "say", text: "So on that link there, just click on it. At the very top you'll see Pay $250 to lock in my date. Under that it has your package, the job total, the $250 deposit, and what you'll pay after. The proposal is attached to it as well. Let me know if that's showing on your screen." },
      { kind: "say", text: "Perfect. Just click Pay $250, and that'll open up the payment. We work with Stripe, so Stripe takes all our payments. You can pay with Apple Pay, Google Pay, a card, or a bank transfer." },
      { kind: "if", when: "“It says pay with Link”", say: "Just click pay without Link, and it'll go straight to the Apple Pay screen." },
      { kind: "if", when: "“Pay in full or pay later, what's pay later?”", say: "Pay later is through Klarna. Pay in full there just means the $250, not the total. Once we're done with the job and you're happy with everything, that's when we settle the remaining balance. And the pricing includes taxes, so there won't be any additional charges." },
      { kind: "if", when: "“I want to pay with a card but it says add a card”", say: "If you want, I can type it in for you.", then: "Read it back digit by digit as they say it. Take your time: “No rush at all, I'll stay on.”" },
      { kind: "say", text: "And I have your email here as [email]. Is that the right one to send the confirmation to?" },
      { kind: "say", text: "It came through on our end. Awesome, I really appreciate it. You can add it to your calendar right there too, just click Add to my calendar." },
      { kind: "say", text: "So we'll be out there [day] between 8 and 9 AM. We start a little early so the fence has enough time to dry. The cleaning takes about five to six hours, and the staining is a full day. [Cleaner's name] is our cleaner for that day. He'll text you when he's headed your way." },
      { kind: "say", text: "I'll send you a confirmation here shortly. If you have any questions or the payment link doesn't work or anything, just call this number. Either way, we'll see you [day]." },
      { kind: "note", text: "Brand-new fence, three weeks old: “He still comes out and double-checks everything and the scope of work, so we have everything we need when we come to stain it.”" },
    ],
  },
  {
    id: "no-answer",
    title: "If they don't answer",
    goal: "Two calls, a voicemail, a text that asks for the sides. The price still goes out today.",
    lines: [
      { kind: "do", text: "Call. Call again and leave a voicemail. After the second missed call, if they haven't replied, text:" },
      { kind: "say", text: "Hi [Name], this is [Your name] with Sterling Fence Staining. I just tried calling about your fence estimate. I'm looking at your property now. Which sides would you like stained?" },
      { kind: "do", text: "Can see their fence on any map: text the scope-of-work picture to confirm the sides. Never from a look-alike house." },
      { kind: "do", text: "They text the sides: send the scope and confirm from what they said." },
      { kind: "do", text: "By 6 PM: call again. Still nothing: send the estimate anyway. Default scope: inside front, inside left, inside back, inside right, outside front." },
    ],
  },
];

export const OBJECTIONS: Objection[] = [
  {
    when: "“I need to talk to my wife” (at the booking)",
    say: "No problem at all, sir. What I can still do is get you on that booking invite for next Saturday. I know you have to talk to your wife. This is just so you can see all the information on one screen. We attach the proposal to it, we attach the $250 to it, everything's going to be there, sir. That way there are no questions when we come out and stain your fence. … And I know you said you wanted to talk to your wife. Are there any questions, doubts or concerns your wife might have? That way I can answer them for you right now. … Also, sir, at the very bottom of the proposal there's a Text it button. You can text the proposal to your wife so she can start looking at it too. Let me know when you scroll down and see it.",
    why: "It's always something: a party, the money, the color. Answer it. Maybe you close it, usually you won't, and that's fine. The invite is in their hands either way.",
  },
  {
    when: "“Let me check with my wife and call you back”",
    say: "Yeah, no problem at all. The main thing is that somebody's home for the cleaning so you can see the samples. And if somebody wants to be there while we stain, that's always great too. Is this a good number to call you back on? … I'll hold [day] for you while you check.",
    why: "Set the callback for the same day. The customer who said this called back and booked.",
  },
  {
    when: "“I want to check you out first, make sure you're legit” or “are you one of those lead companies?”",
    say: "Yes sir. So a little more about us. We run everything in-house: our own ads, our own Google page, our own crews. We don't subcontract anything. Sterling Fence Staining is the name we rebranded to about a year ago, and that one has over forty five-star Google reviews. Our sister company is A&T's Pressure Washing. That one started seven years ago and has over 160 five-star reviews. If you search fence staining in Houston, we come up first. Let me text you the website and the Google page right now.",
    why: "A customer asked exactly this and paid on the same call. Text sterlingfencetx.com and the Google link while you talk. Local: “We're based right off 290 by Jersey Village, in Cypress.”",
  },
  {
    when: "“I'm not sure I'm in a position to buy right now”",
    say: "Sure, no problem at all. We also offer splitting it into four payments, no interest. A lot of our customers like to do that, especially on a double-sided fence. Either way, this is our business number, so just call us with any questions. Me, Amy or Lily will answer.",
    why: "A customer said this on the first call and booked five days later. Leave the door open, follow up.",
  },
  {
    when: "“Give me your final price so I don't have to shop around”",
    say: "Let me check what I have on hand in your color and I'll call you right back with the best I can do.",
    why: "Alan's lever, Alan only: stain already on the shelf in their color is worth about $200 a five-gallon off, and can bring a Legacy down to the Signature price if they lock in a date next week. Olga and Lily: send it to Alan, don't invent a discount.",
  },
  {
    when: "“Is the 20% off included?”",
    say: "Yes sir, that's included in the price you see. Fall is a little slower for us, so we're able to give a little more of a discount this time of year.",
  },
  {
    when: "“What about my plants along the fence?”",
    say: "It depends how close they are. If they're on the fence, we cover them and pull them back slightly. One guy pulls them back, the other stains, and we have a longer lance for the sprayer. If they're a little farther back we get behind them without damaging anything, and we still cover them so no stain gets on them. The tips we use on the sprayer depend on the stain, so there's no overspray.",
  },
  {
    when: "“Do you send somebody out to look at it first?”",
    say: "That's the cleaning day. Our cleaner comes out, cleans the fence, and he has all the samples and all the pricing. If you want to see the samples before you decide on the package, that's exactly when you do it. The $250 just locks the spot, and you can change the package then.",
  },
  {
    when: "“Can I pay cash or check?”",
    say: "You can definitely pay with cash or check, but it doesn't change the price. We report everything.",
  },
  {
    when: "“It's brand new, why do you need to come clean it?”",
    say: "He still comes out and double-checks everything and the scope of work, so we have everything we need when we come to stain it. If it doesn't need cleaning, we don't clean it.",
  },
];

export const CHEAT_SHEET: CheatCard[] = [
  {
    title: "The packages",
    rows: [
      "Essential: clear coat, about 2 years, newer fences.",
      "Signature: semi-transparent, see the wood grain, 3 to 4 years, sometimes 5. Most popular.",
      "Legacy: solid, more pigment and sealer, hides imperfections, 4 to 7 years. Older or previously stained fences.",
      "All three: two coats, back-brushed if needed, loose boards screwed in free, 1-year workmanship warranty, a touch-up can left behind. Tax included.",
    ],
  },
  {
    title: "Colors to know",
    rows: [
      "Signature: Cedar Naturaltone (most popular), Redwood Naturaltone (orange-y cedar), October Brown, Potato Skin, Chocolate Chips (very dark brown).",
      "Legacy: October Brown, Darkest Night, Chocolate Chips, Classic Mahogany (maroon), Simply Cedar, Plymouth Red.",
      "Match from Street View: front door, trim, soffit, garage door.",
      "Customer's own brand (Cabot, Sherwin): fine. Get the exact name and the opacity. Semi-solid = Legacy.",
    ],
  },
  {
    title: "Money",
    rows: [
      "$250 deposit locks the spot. Remainder when the job is done and they're happy.",
      "Klarna: four payments, 0% interest, approved up front. Military: $50 off any package.",
      "Minimum job $600. Prices include tax.",
      "Pay page: Apple Pay, Google Pay, card, bank transfer. Through Stripe.",
    ],
  },
  {
    title: "Proof",
    rows: [
      "Sterling Fence Staining: rebranded about a year ago, 40+ five-star Google reviews.",
      "A&T's Pressure Washing: sister company, seven years, 160+ five-star reviews.",
      "First on Google for fence staining in Houston. Based off 290 by Jersey Village, Cypress.",
      "Website: sterlingfencetx.com. Business line answers any hour.",
    ],
  },
  {
    title: "The days",
    rows: [
      "Arrive between 8 and 9 AM. Cleaning: 5 to 6 hours. Staining: a full day with two guys.",
      "Stain the day after cleaning once it's dry, usually 12 to 24 hours, weather permitting.",
      "Cleaner texts them when he's headed over. He brings the samples and the repair pricing.",
      "Nobody has to be home. We love it when they are, especially cleaning day.",
    ],
  },
  {
    title: "Repairs",
    rows: [
      "Loose boards: screwed in free. Replacements: extra, flat rate, in the proposal.",
      "Pickets $12 pine, $14 cedar. Rails and posts priced in the proposal.",
      "They count, or the cleaner counts on cleaning day and the customer approves.",
      "Fence over 15 years: we still do it. It usually needs repairs; walk them.",
    ],
  },
];

export const SCRIPT_SOURCES: string[] = [
  "A two-call close: first call while the customer was driving, deposit five days later",
  "A previously stained fence: oil-based pecan, an HOA easement to clean only",
  "A durability buyer who checked us out on Google, color-matched from Street View, paid on the call",
  "A customer with his own Cabot color, card typed in for him, repairs counted on cleaning day",
  "A keep-my-color customer: plants on the fence, had to check with his wife, called back and booked",
  "A booking-invite walk-through on a three-week-old fence",
  "Alan and Olga run-through, 2026-10-27",
]
