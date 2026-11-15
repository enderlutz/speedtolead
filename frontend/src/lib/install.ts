// "Install the app" (Alan, 2026-11-15: a mobile app for him and the crew to
// download). The dashboard installs from the browser: Android/Chrome hands us
// an install prompt we fire from a button; iPhone has no prompt, so we show the
// two taps (Share -> Add to Home Screen). Chrome fires its event once, early,
// so we catch it here at load.
type PromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

let deferred: PromptEvent | null = null;
const listeners = new Set<() => void>();
const ping = () => listeners.forEach((fn) => fn());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as PromptEvent;
    ping();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    ping();
  });
}

export function onInstallChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Already opened from the home-screen icon. */
export function isInstalled(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.("(display-mode: standalone)").matches || nav.standalone === true;
}

export function isIphone(): boolean {
  const ua = navigator.userAgent || "";
  const ipadOs = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod/.test(ua) || ipadOs;
}

export function canPrompt(): boolean {
  return deferred !== null;
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const ev = deferred;
  deferred = null;
  await ev.prompt();
  const { outcome } = await ev.userChoice;
  ping();
  return outcome === "accepted";
}
