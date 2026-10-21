# On call

Talked through 2026-10-20 (Alan, Olga). Not built yet.

1. **When leads arrive.** Track every lead's arrival hour and weekday, going
   back through all past leads. Show the share in each time window, and
   recommend the shift schedule from it (e.g. if 6–8 AM is big, shifts start
   earlier). Let the data set the hours.
2. **A call attempt stops the timer.** Susanna Lee: we called, no answer,
   couldn't see the house. The attempt counts as the first call.
3. **Replace "Not a lead"** with what we're waiting on to reach the next step:
   their address, a video, a reply… Maybe the source (Facebook, Google) too.
4. **A "chance to close" score** that drops the longer a lead waits past 5
   minutes, from our own data. Never zero, but it shows where to put attention
   first.
5. **The VA is busy on a call when a new lead comes in.** Near the 5-minute
   mark, if the assigned person is on a live call, alert the other VA or Alan to
   take it, and show on On call that she's on a call. Needs live "on a call"
   status from GHL. No extra text to the customer: the form's automatic text
   already says we'll call soon.

## Schedule (2026-10-20)

6. **Pick any time to the minute** instead of 30-minute steps: a clean
   time picker (8:00, 8:05…), professional and easy to slide through.
7. **The week fills itself from each person's agreed schedule.** Enter each
   VA's agreed days and hours once (what was agreed when hiring); the week
   builds from that. Edits are only for no-shows and swaps.
8. **Nobody on tomorrow = alert.** Before a day starts, if 8 AM–8 PM isn't
   fully covered, alert the main VA (Alan for now) to fill the gaps.
9. **Best person on the best hours.** Once the arrival data shows the busiest
   hours, put the highest-scoring VA there. A weaker VA gets the quiet hours
   and works the "No reply yet" list.
10. The goal: Alan fully off the schedule, in phases, as VAs are hired and trained.

## Scorecard: scoring the VA (2026-10-20)

Today the Scorecard counts speed only (leads given, % called within 5 min,
average minutes). It should score from the recordings:

11. **Speed:** how fast the lead got its first call.
12. **How the call sounded:** natural or scripted/monotone; positive; attentive
    to the customer's questions; not rude, brash, bothered, rushed or forced.
13. **Followed the script to the end (the SOP):** every required step covered.
    Flag patterns, e.g. "the last 3 calls skipped financing" or "keeps saying X
    instead of Y", so we know what to coach.
14. **Outcome, tracked but not blamed:** booked the appointment, closed the
    offer, finished the whole process. A VA isn't faulted for no sale on the
    call, only for skipping steps or how they handled it.

Check first: the current call analysis reads the transcript text only. It
doesn't hear tone of voice (monotone, annoyed), so tone needs either
judgment from the words and pace, or an audio-based model.

## Replace Olga's notebook: score every call, then hand the VA the next task (2026-10-21)

Alan with Olga. Goal: no notebook. The system remembers, scores and directs.

15. **Hear the call, not just read it.** Score tone from the audio: pace
    (the script says speak slowly), monotone vs lively, talk ratio,
    interrupting, long silences. Deepgram already gives word timings, so pace,
    talk ratio and silences are cheap. Real tone (annoyed, flat, warm) needs an
    audio emotion model (Hume or similar); Claude reads text only.
16. **Grade against the real script.** The current grader
    (backend/services/call_coach_rubric.md) still says "not a sales call,
    3–5 minutes, never book". The new first-call script
    (docs/sop/first-call-script.md) is a 12–15 minute call that walks packages,
    picks a colour, books a date and sends the $250 link. Rewrite the rubric
    from the script first; every score depends on it.
17. **A score after every call, in minutes.** Recordings already arrive through
    the every-minute sync and Deepgram transcribes in under a minute. Target:
    score on the VA's screen ~2–3 minutes after hang-up, no GHL switch needed.
    Live mid-call help needs a phone system that streams audio (Twilio Media
    Streams, Dialpad, Aircall, JustCall); GHL's phone doesn't. Decide only after
    post-call scoring runs for a few weeks.
18. **Next task, one at a time.** After the score, On call shows one card: the
    highest-value thing to do now (new lead in its 5 minutes, a promised
    callback that's due, hot-then-silent, estimate never called…), ranked by
    the chance-to-close score (#4) and matched to the VA's skills. Needs Alan to
    write down each VA's skills and job.
19. **What goes in the notebook goes in the system.** Promises made on the
    call ("call me Thursday after 3", "send the colour samples") become tasks
    automatically from the transcript (call_intent already pulls callback
    phrases). Ask Olga what she writes down and make sure each kind is caught.
