// A note from Alan to Olga (2026-10-14): every time she opens the dashboard,
// once per visit, not on every page change, and again the first time she
// comes back to a tab left open from an earlier day. Never shown to anyone
// else, and never when Alan is viewing the dashboard as her.
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { Heart } from "lucide-react";
import { getCurrentUser } from "@/lib/api";

const SEEN_KEY = "love-note-seen";
// The Houston day it last showed, so a tab left open overnight shows it
// again the next morning when she comes back to it.
const DAY_KEY = "love-note-day";

function today(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function due(): boolean {
  try {
    return sessionStorage.getItem(SEEN_KEY) !== "1" || localStorage.getItem(DAY_KEY) !== today();
  } catch {
    return true;
  }
}

function markShown() {
  try { sessionStorage.setItem(SEEN_KEY, "1"); localStorage.setItem(DAY_KEY, today()); } catch { /* fine */ }
}

function isOlga(): boolean {
  const u = getCurrentUser();
  if (!u || u.impersonated_by) return false;
  return (u.sub || "").toLowerCase() === "olga" || (u.name || "").trim().toLowerCase().startsWith("olga");
}

// Customer-facing pages and the login screen never get it.
const SKIP = ["/login", "/p/", "/proposal/", "/pay/", "/after/", "/receipt/", "/legal/", "/preview/", "/approve/", "/capture/", "/v/", "/crew-app/"];

export function LoveNote() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  // Checked on every page change, so it also appears right after she logs in;
  // the session flag keeps it to once per visit.
  useEffect(() => {
    // ?love=1 shows it to whoever is logged in, once, so Alan can see it
    // without her password.
    if (new URLSearchParams(window.location.search).get("love") === "1") {
      const t = setTimeout(() => setOpen(true), 400);
      return () => clearTimeout(t);
    }
    if (SKIP.some((p) => pathname === p || pathname.startsWith(p)) || !isOlga()) return;
    const tryShow = () => {
      if (!due()) return;
      markShown();
      setOpen(true);
    };
    // A beat after the dashboard paints, so it lands on the page she opened.
    const t = setTimeout(tryShow, 400);
    // A tab left open: check again whenever she comes back to it.
    const onBack = () => { if (document.visibilityState === "visible") tryShow(); };
    document.addEventListener("visibilitychange", onBack);
    window.addEventListener("focus", onBack);
    return () => {
      clearTimeout(t);
      document.removeEventListener("visibilitychange", onBack);
      window.removeEventListener("focus", onBack);
    };
  }, [pathname]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={() => setOpen(false)}>
      <style>{`@keyframes love-float{0%{transform:translateY(0) scale(.6);opacity:0}15%{opacity:1}100%{transform:translateY(-70vh) scale(1.2);opacity:0}}`}</style>
      {Array.from({ length: 14 }).map((_, i) => (
        <Heart key={i} className="pointer-events-none absolute bottom-0 fill-rose-500 text-rose-500"
          style={{ left: `${5 + ((i * 37) % 90)}%`, width: 18 + (i % 4) * 8, height: 18 + (i % 4) * 8, animation: `love-float ${3 + (i % 5) * 0.6}s ease-out ${(i % 7) * 0.35}s infinite` }} />
      ))}
      <div className="relative w-full max-w-sm rounded-3xl bg-white p-6 text-center text-stone-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-rose-100">
          <Heart className="h-9 w-9 animate-pulse fill-rose-500 text-rose-500" />
        </div>
        <p className="mt-4 font-heading text-3xl font-bold">Olga, I love you.</p>
        <p className="mt-2 text-lg text-stone-600">Have a great day.</p>
        <p className="mx-auto mt-4 max-w-[16rem] border-t border-rose-100 pt-3 font-heading text-lg italic leading-snug text-stone-700">"The joy of the Lord is my strength."</p>
        <p className="mt-0.5 text-sm font-semibold text-rose-500">Nehemiah 8:10</p>
        <p className="mt-1 text-sm text-stone-400">— Alan</p>
        <button type="button" onClick={() => setOpen(false)} className="mt-5 h-12 w-full rounded-xl bg-rose-500 text-base font-bold text-white hover:bg-rose-600">
          I love you too ❤️
        </button>
      </div>
    </div>
  );
}
