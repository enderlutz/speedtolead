// /r/{code}: where a referred friend lands (Alan, 2026-10-15: the old link
// went to a page that didn't exist). Who sent them, the $100 off, and three
// boxes; what they send becomes a lead on the board, marked with who sent
// them, and Alan gets a text. Raw fetch, never api.request(): a 401 there
// would bounce a stranger to the staff login.
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Check, Phone } from "lucide-react";

const BASE = import.meta.env.VITE_API_URL || "";
const GOLD = "#C9972F";

export default function ReferralPage() {
  const { code } = useParams<{ code: string }>();
  const [who, setWho] = useState<{ first_name: string; reward: number } | null>(null);
  const [gone, setGone] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", address: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    document.title = "$100 off your fence · Sterling Fence Staining";
    fetch(`${BASE}/api/public/referral/${encodeURIComponent(code || "")}`)
      .then(async (r) => { if (!r.ok) throw new Error(); setWho(await r.json()); })
      .catch(() => setGone(true));
  }, [code]);

  const send = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`${BASE}/api/public/referral/${encodeURIComponent(code || "")}/claim`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
      });
      const d = (await r.json().catch(() => ({}))) as { detail?: string };
      if (!r.ok) throw new Error(d.detail || "That didn't go through. Call or text us.");
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't go through. Call or text us.");
    } finally {
      setBusy(false);
    }
  };

  const field = "mt-1 h-14 w-full rounded-xl border border-[#15130F]/20 bg-white px-4 text-[17px] text-[#15130F]";
  const reward = who?.reward ?? 100;
  return (
    <div className="min-h-screen bg-[#F8F3E7] text-[#15130F]">
      <div className="mx-auto flex max-w-md items-center justify-between bg-[#15130F] px-4 py-3">
        <img src="/sterling-logo-dark.png" alt="Sterling Fence Staining" className="h-8 w-auto" draggable={false} />
        <a href="tel:+13465897877" className="inline-flex h-11 items-center gap-2 rounded-full px-4 text-[15px] font-bold text-[#15130F]" style={{ background: GOLD }}><Phone className="h-4 w-4" /> Call or text</a>
      </div>
      <div className="mx-auto max-w-md px-5 pb-10 pt-6">
        {gone ? (
          <div className="pt-10 text-center">
            <p className="text-[19px] font-bold">This link isn't working.</p>
            <p className="mt-2 text-[16px]">Call or text us at <a href="tel:+13465897877" className="font-bold underline">346-589-7877</a> and mention who sent you.</p>
          </div>
        ) : done ? (
          <div className="pt-6 text-center">
            <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#15130F] text-[#E3BE63] ring-4 ring-[#C9972F]/50"><Check className="h-8 w-8" /></span>
            <h1 className="mt-4 font-heading text-3xl font-bold leading-tight">Got it, {form.name.trim().split(" ")[0]}!</h1>
            <p className="mt-2 text-[17px]">Alan will text you shortly with your free quote. Your ${reward} off is saved.</p>
            <p className="mt-4 text-[15px] text-[#15130F]/75">Questions? Call or text 346-589-7877.</p>
          </div>
        ) : (
          <>
            <p className="text-[13px] font-bold uppercase tracking-[0.2em]" style={{ color: "#8C6224" }}>A gift from {who?.first_name || "your neighbor"}</p>
            <h1 className="mt-1 font-heading text-3xl font-bold leading-tight">{who?.first_name || "Your neighbor"} sent you ${reward} off your fence.</h1>
            <p className="mt-2 text-[17px]">{who?.first_name || "They"} had their fence stained by Sterling. Tell us where to come and we'll send you a free quote, with ${reward} off.</p>
            <img src="/proposal-mockup/pkg-signature-a.jpg" alt="" className="mt-4 h-44 w-full rounded-2xl object-cover" draggable={false} />
            <div className="mt-5 space-y-3">
              <label className="block text-[15px] font-semibold">Your name
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" className={field} />
              </label>
              <label className="block text-[15px] font-semibold">Mobile number
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" autoComplete="tel" className={field} />
              </label>
              <label className="block text-[15px] font-semibold">Home address
                <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} autoComplete="street-address" placeholder="Street, city and ZIP" className={field} />
              </label>
            </div>
            {error ? <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-[15px] font-semibold text-rose-800">{error}</p> : null}
            <button type="button" onClick={() => void send()} disabled={busy || !form.name.trim() || !form.phone.trim()}
              className="mt-5 flex h-14 w-full items-center justify-center rounded-xl text-[18px] font-bold text-[#15130F] shadow-lg disabled:opacity-60" style={{ background: GOLD }}>
              {busy ? "Sending…" : `Get my free quote, $${reward} off`}
            </button>
            <p className="mt-2 text-center text-[14px] text-[#15130F]/70">No spam. Alan texts you once with your quote.</p>
          </>
        )}
      </div>
    </div>
  );
}
