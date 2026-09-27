// The four steps a scope must clear before it can go to a customer.
//
// Pure logic, kept out of the component so it can be read and tested on its
// own — and so the same rules are stated once rather than spread between a
// checklist, a tooltip and a disabled button.

export interface ScopeSteps {
  /** Quick Enhance: sharpen and brighten the original. Instant, free. */
  brightened: boolean;
  /** Drone View: the photorealistic re-render. Takes up to a minute. */
  droned: boolean;
  /** At least one fence run has been traced. */
  drawn: boolean;
  /** Somebody has looked at the finished scope and said it's right. */
  confirmed: boolean;
}

export const STEP_COUNT = 4;

/** The first step not yet done, or null when the scope is ready to send. */
export function firstIncompleteStep(steps: ScopeSteps): 1 | 2 | 3 | 4 | null {
  if (!steps.brightened) return 1;
  if (!steps.droned) return 2;
  if (!steps.drawn) return 3;
  if (!steps.confirmed) return 4;
  return null;
}

/** Why Send is locked, phrased for whoever is looking at it. */
export function sendBlockedReason(steps: ScopeSteps): string | null {
  switch (firstIncompleteStep(steps)) {
    case 1: return "Step 1 of 4: brighten the photo first.";
    case 2: return "Step 2 of 4: run Drone View to re-render the photo.";
    case 3: return "Step 3 of 4: mark the fence before sending.";
    case 4: return "Step 4 of 4: check it over and confirm it's right.";
    default: return null;
  }
}
