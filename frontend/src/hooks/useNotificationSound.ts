/**
 * Notification sounds using Web Audio API.
 * Works on mobile — AudioContext is initialized on first user interaction.
 */

let _ctx: AudioContext | null = null;
let _initialized = false;

function getCtx(): AudioContext | null {
  if (!_ctx) {
    try {
      _ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  return _ctx;
}

// Initialize AudioContext on first user gesture (required for mobile)
function _initOnInteraction() {
  if (_initialized) return;
  const handler = () => {
    const ctx = getCtx();
    if (ctx && ctx.state === "suspended") ctx.resume();
    _initialized = true;
    document.removeEventListener("click", handler);
    document.removeEventListener("touchstart", handler);
  };
  document.addEventListener("click", handler, { once: true });
  document.addEventListener("touchstart", handler, { once: true });
}

// Auto-register on import
if (typeof document !== "undefined") _initOnInteraction();

function playTone(freq: number, duration: number, type: OscillatorType = "sine", vol = 0.3) {
  try {
    const ctx = getCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = vol;
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch {
    // Audio not available
  }
}

/** New lead arrived — attention-grabbing double chime */
export function playNewLeadSound() {
  playTone(880, 0.15, "sine", 0.4);
  setTimeout(() => playTone(1100, 0.2, "sine", 0.35), 170);
}

/** Customer replied — soft ping */
export function playReplySound() {
  playTone(660, 0.12, "sine", 0.25);
}

/** Estimate sent successfully — satisfying rising chord */
export function playSuccessSound() {
  playTone(523, 0.1, "sine", 0.3);
  setTimeout(() => playTone(659, 0.1, "sine", 0.3), 120);
  setTimeout(() => playTone(784, 0.15, "sine", 0.3), 240);
}

/** Warning / SMS failed — low attention tone */
export function playWarningSound() {
  playTone(330, 0.3, "triangle", 0.3);
}

/** Customer opened proposal — subtle notification */
export function playProposalViewedSound() {
  playTone(740, 0.15, "sine", 0.2);
}

/** Urgent: leads piling up — rapid triple beep */
export function playUrgentSound() {
  playTone(800, 0.08, "square", 0.25);
  setTimeout(() => playTone(800, 0.08, "square", 0.25), 150);
  setTimeout(() => playTone(1000, 0.12, "square", 0.3), 300);
}

/** Chatbot Amy responded — soft friendly pop */
export function playChatbotResponseSound() {
  playTone(587, 0.1, "sine", 0.2);
  setTimeout(() => playTone(784, 0.12, "sine", 0.18), 130);
}
