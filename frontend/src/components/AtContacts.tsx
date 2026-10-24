// A&T's Contacts (Alan, 2026-10-23): everyone in A&T's Pressure Washing's
// GHL, read into the dashboard so A&T's fence staining and pressure washing
// leads stop living somewhere nobody looks. Read only: nothing here texts,
// calls or copies anyone. A row whose phone is already a Sterling customer
// says so, so nobody copies them over again.
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, Phone, Search } from "lucide-react";
import { api, type ContactRow, type ContactStats } from "@/lib/api";
import { cn } from "@/lib/utils";

type Service = "all" | "fence" | "pressure";
const PAGE = 50;

function phoneText(p: string) {
  const d = (p || "").replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p;
}
function dayText(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
}

export function AtContacts() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [rows, setRows] = useState<ContactRow[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<ContactStats | null>(null);
  const [service, setService] = useState<Service>("all");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api.contactAccounts().then((a) => setConnected(a.at_connected)).catch(() => setConnected(false));
    api.getContactStats("at").then(setStats).catch(() => setStats(null));
  }, []);
  useEffect(() => { const t = setTimeout(() => { setSearch(q.trim()); setOffset(0); }, 350); return () => clearTimeout(t); }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const page = await api.listContacts({ account: "at", service: service === "all" ? undefined : service, q: search || undefined, sort: "added", limit: PAGE, offset });
      setRows(page.contacts);
      setTotal(page.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load A&T's contacts");
    } finally {
      setLoading(false);
    }
  }, [service, search, offset]);
  useEffect(() => { void load(); }, [load]);

  const chip = "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[13px] font-semibold";

  return (
    <div className="space-y-3">
      {connected === false && (stats?.total || 0) === 0 ? (
        <div className="rounded-2xl border border-[#C9972F]/50 bg-[#FBF8F2] p-4 text-[15px] leading-relaxed">
          <p className="font-bold">A&amp;T&rsquo;s GHL isn&rsquo;t connected yet.</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>In A&amp;T&rsquo;s Pressure Washing GHL: <b>Settings → Private Integrations → Create new integration</b>.</li>
            <li>Name it &ldquo;Sterling dashboard&rdquo;, tick <b>View Contacts</b> and <b>View Conversations</b>, create, copy the token.</li>
            <li>In Railway, backend Variables: <b>GHL_API_KEY_AT</b> = that token. (Woodlands account: same steps, <b>GHL_API_KEY_AT_WOODLANDS</b>.)</li>
            <li>After the deploy, the contacts fill in here within 5 minutes.</li>
          </ol>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {([["all", "Everyone"], ["fence", "Fence staining"], ["pressure", "Pressure washing"]] as [Service, string][]).map(([k, label]) => (
          <button key={k} type="button" onClick={() => { setService(k); setOffset(0); }}
            className={cn("min-h-10 rounded-full px-3.5 text-[14px] font-bold ring-1 transition",
              service === k ? "bg-[#1F1A14] text-white ring-[#1F1A14]" : "bg-white text-[#1F1A14] ring-[#E4DCCB] hover:bg-[#F8F3E7]")}>
            {label}
          </button>
        ))}
        <label className="ml-auto flex min-h-10 w-full items-center gap-2 rounded-xl border border-[#E4DCCB] bg-white px-3 sm:w-72">
          <Search className="h-4 w-4 text-[#6B6052]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, phone or email" className="w-full bg-transparent text-[15px] outline-none" />
        </label>
      </div>

      <p className="text-[14px] text-[#6B6052]">
        {loading ? "Loading…" : `${total.toLocaleString()} ${total === 1 ? "contact" : "contacts"}`}
        {stats?.last_sync ? ` · synced ${dayText(stats.last_sync)}` : ""} · newest first · read only, nothing here texts anyone
      </p>
      {error ? <p className="rounded-xl bg-red-50 p-3 text-[15px] text-red-800">{error}</p> : null}

      <ul className="space-y-2">
        {rows.map((c) => (
          <li key={c.id} className="rounded-2xl border border-[#E4DCCB] bg-white p-3.5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-[16px] font-bold text-[#1F1A14]">{c.name || "No name"}</p>
                <p className="truncate text-[14px] text-[#6B6052]">{[c.address, c.source, dayText(c.date_added)].filter(Boolean).join(" · ")}</p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {c.service ? <span className={cn(chip, c.service === "Fence staining" ? "bg-[#C9972F]/15 text-[#8C6224]" : "bg-sky-50 text-sky-800")}>{c.service}</span> : null}
                {c.also_sterling ? <span className={cn(chip, "bg-emerald-50 text-emerald-800")}>Already in Sterling</span> : null}
              </div>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {c.phone ? (
                <a href={`tel:${c.phone}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-[#E4DCCB] px-3.5 text-[15px] font-bold text-[#1F1A14] hover:bg-[#F8F3E7]">
                  <Phone className="h-4 w-4" /> {phoneText(c.phone)}
                </a>
              ) : null}
              {c.ghl_url ? (
                <a href={c.ghl_url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3.5 text-[15px] font-bold text-[#8C6224] hover:bg-[#F8F3E7]">
                  <ExternalLink className="h-4 w-4" /> Open in A&amp;T&rsquo;s GHL
                </a>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {loading && !rows.length ? <p className="flex items-center gap-2 text-[15px] text-[#6B6052]"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p> : null}
      {!loading && !rows.length && !error ? <p className="rounded-2xl border border-dashed border-[#E4DCCB] bg-white p-6 text-center text-[15px] text-[#6B6052]">No A&amp;T&rsquo;s contacts here yet.</p> : null}

      {total > PAGE ? (
        <div className="flex items-center justify-between gap-2">
          <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} className="min-h-11 rounded-xl border border-[#E4DCCB] bg-white px-4 text-[15px] font-bold disabled:opacity-40">Newer</button>
          <span className="text-[14px] text-[#6B6052]">{offset + 1}–{Math.min(offset + PAGE, total)} of {total.toLocaleString()}</span>
          <button type="button" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)} className="min-h-11 rounded-xl border border-[#E4DCCB] bg-white px-4 text-[15px] font-bold disabled:opacity-40">Older</button>
        </div>
      ) : null}
    </div>
  );
}
