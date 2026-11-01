import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/**
 * Alan's yes/no question to one person (2026-11-01). The next time they open
 * the dashboard it sits big in the middle of the screen: Yes or No, plus a
 * box to explain. Alan gets a text when they see it and when they answer.
 */
export default function StaffQuestion() {
  const [q, setQ] = useState<{ id: string; question: string } | null>(null);
  const [pick, setPick] = useState<"yes" | "no" | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    api.getStaffQuestion().then(r => setQ(r.question)).catch(() => {});
  }, []);

  if (!q) return null;

  const send = async () => {
    if (!pick) return;
    setSending(true);
    setErr("");
    try {
      await api.answerStaffQuestion({ id: q.id, answer: pick, note });
      setDone(true);
      setTimeout(() => setQ(null), 1800);
    } catch {
      setErr("That didn't go through. Try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 text-gray-900 shadow-2xl sm:p-8">
        {done ? (
          <p className="py-10 text-center text-2xl font-bold">Sent to Alan. Thank you.</p>
        ) : (
          <>
            <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">From Alan</p>
            <h2 className="mt-2 text-3xl font-extrabold leading-tight sm:text-4xl">{q.question}</h2>
            <div className="mt-6 grid grid-cols-2 gap-3">
              {(["yes", "no"] as const).map(a => (
                <button
                  key={a}
                  onClick={() => setPick(a)}
                  className={`min-h-[64px] rounded-xl border-2 text-2xl font-extrabold transition ${
                    pick === a
                      ? a === "yes" ? "border-green-600 bg-green-600 text-white" : "border-red-600 bg-red-600 text-white"
                      : "border-gray-300 bg-white text-gray-900 hover:border-gray-500"
                  }`}
                >
                  {a === "yes" ? "Yes" : "No"}
                </button>
              ))}
            </div>
            <label className="mt-6 block text-base font-semibold">Explain (optional)</label>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              rows={4}
              className="mt-2 w-full rounded-xl border-2 border-gray-300 p-3 text-base focus:border-gray-600 focus:outline-none"
              placeholder="Write anything you want Alan to know"
            />
            {err && <p className="mt-2 text-sm font-semibold text-red-600">{err}</p>}
            <button
              onClick={send}
              disabled={!pick || sending}
              className="mt-5 min-h-[52px] w-full rounded-xl bg-gray-900 text-lg font-bold text-white disabled:opacity-40"
            >
              {sending ? "Sending…" : "Send to Alan"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
