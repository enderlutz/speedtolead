// The three steps a scope must clear before it can go to a customer.
//
// Pure logic, kept out of the component so it can be read and tested on its
// own — and so the same rules can be stated in one place rather than being
// spread between a checklist, a tooltip and a disabled button.

export interface ScopeSteps {
  /** The photo has been made presentable: a drone render, or Quick Enhance. */
  enhanced: boolean;
  /** At least one fence run has been traced. */
  drawn: boolean;
  /** Somebody has looked at the finished scope and said it's right. */
  confirmed: boolean;
}

/** The first step not yet done, or null when the scope is ready to send. */
export function firstIncompleteStep(steps: ScopeSteps): 1 | 2 | 3 | null {
  if (!steps.enhanced) return 1;
  if (!steps.drawn) return 2;
  if (!steps.confirmed) return 3;
  return null;
}

/** Why Send is locked, phrased for whoever is looking at it. */
export function sendBlockedReason(steps: ScopeSteps): string | null {
  switch (firstIncompleteStep(steps)) {
    case 1: return "Step 1: make the photo presentable first — Drone View or Enhance.";
    case 2: return "Step 2: mark the fence before sending.";
    case 3: return "Step 3: check it over and confirm it's right.";
    default: return null;
  }
}
