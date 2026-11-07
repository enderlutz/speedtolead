// The steps a scope must clear before it can go to a customer.
//
// Pure logic, kept out of the component so it can be read and tested on its
// own — and so the same rules are stated once rather than spread between a
// checklist, a tooltip and a disabled button.
//
// Three gates: a photo, a traced fence, a look-over. Brightening and the
// drone render used to be gates too; they are optional now (Alan,
// 2026-11-07: the render wouldn't run and he needed to send the scope as
// it was, so "the whole edit" can't stand between a drawing and the
// customer). They still show as done/not done, they just never lock Send.

export interface ScopeSteps {
  /** A screenshot has been uploaded. */
  photo: boolean;
  /** Quick Enhance: sharpen and brighten the original. Optional. */
  brightened: boolean;
  /** Drone View: the photorealistic re-render. Optional. */
  droned: boolean;
  /** At least one fence run has been traced. */
  drawn: boolean;
  /** Somebody has looked at the finished scope and said it's right. */
  confirmed: boolean;
}

export const STEP_COUNT = 3;

/** The first step not yet done, or null when the scope is ready to send. */
export function firstIncompleteStep(steps: ScopeSteps): 1 | 2 | 3 | null {
  if (!steps.photo) return 1;
  if (!steps.drawn) return 2;
  if (!steps.confirmed) return 3;
  return null;
}

/** Why Send is locked, phrased for whoever is looking at it. */
export function sendBlockedReason(steps: ScopeSteps): string | null {
  switch (firstIncompleteStep(steps)) {
    case 1: return "Step 1 of 3: upload the screenshot first.";
    case 2: return "Step 2 of 3: mark the fence before sending.";
    case 3: return "Step 3 of 3: check it over and confirm it's right.";
    default: return null;
  }
}

/** The photo has had the optional clean-up (brighten + drone view). */
export function photoPrepared(steps: ScopeSteps): boolean {
  return steps.brightened && steps.droned;
}

export type Stage = 1 | 2 | 3;

export const STAGES: { n: Stage; label: string; short: string }[] = [
  { n: 1, label: "Photo ready", short: "Photo" },
  { n: 2, label: "Mark the fence", short: "Mark" },
  { n: 3, label: "Check & send", short: "Send" },
];

/** The stage currently being worked on, or null when everything is done. */
export function currentStage(steps: ScopeSteps): Stage | null {
  return firstIncompleteStep(steps);
}

export function stageDone(steps: ScopeSteps, n: Stage): boolean {
  if (n === 1) return steps.photo;
  if (n === 2) return steps.drawn;
  return steps.confirmed;
}
