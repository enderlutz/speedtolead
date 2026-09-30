import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw, Search, Phone, Mail, MessageSquare, PhoneCall, Ban } from "lucide-react";
import { api, type ContactRow, type ContactStats } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

/**
 * Contacts — a straight mirror of the GHL contact list.
 *
 * The lead boards only ever showed people who had an opportunity card in one
 * of two polled pipelines. This shows everyone, in GHL's own order (newest
 * added first), so "who have we never sent an estimate to?" can be answered
 * against the whole customer base rather than a subset of it.
 */

const PAGE_SIZE = 100;

type EstimateFilter = "all" | "sent" | "not_sent";

function fmtPhone(p: string): string {
  const d = (p || "").replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p || "";
}

function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <div className="text-lg font-semibold leading-tight">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {hint ? <div className="text-[11px] text-muted-foreground/80 mt-0.5">{hint}</div> : null}
    </div>
  );
}

export default function Contacts() {
  const [rows, setRows] = useState<ContactRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [stats, setStats] = useState<ContactStats | null>(null);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [estimate, setEstimate] = useState<EstimateFilter>("all");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const page = await api.listContacts({
        q: search || undefined,
        estimate: estimate === "all" ? undefined : estimate,
        limit: PAGE_SIZE,
        offset,
      });
      setRows(page.contacts);
      setTotal(page.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load contacts");
    } finally {
      setLoading(false);
    }
  }, [search, estimate, offset]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    api.getContactStats().then(setStats).catch(() => setStats(null));
  }, []);

  // Debounced so typing a name doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => { setSearch(q.trim()); setOffset(0); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  async function runSync() {
    setSyncing(true);
    setNote("");
    setError("");
    try {
      const res = await api.syncContacts();
      const r = res.location_1 || Object.values(res)[0];
      if (r?.error) {
        setError(`Sync failed: ${r.error}`);
      } else {
        setNote(
          `Mirrored ${r?.fetched ?? 0} contacts — ${r?.created ?? 0} new, ` +
          `${r?.leads_created ?? 0} given a record, ${r?.names_corrected ?? 0} names corrected.`,
        );
        const [, s] = await Promise.all([load(), api.getContactStats()]);
        setStats(s);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  const showing = rows.length;
  const pageStart = total === 0 ? 0 : offset + 1;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Contacts</h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
            Everyone in Go High Level, newest first — not just the ones on a board.
          </p>
        </div>
        <Button onClick={runSync} disabled={syncing} variant="outline" size="sm">
          <RefreshCw className={`h-4 w-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
          {syncing ? "Syncing…" : "Sync from GHL"}
        </Button>
      </div>

      {stats ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          <Stat label="Contacts in GHL" value={stats.total} />
          <Stat label="Never got an estimate" value={stats.no_estimate} hint="the list to work" />
          <Stat label="Estimate sent" value={stats.estimate_sent} />
          <Stat label="No phone number" value={stats.no_phone} hint="can't be called" />
          <Stat label="Opted out in GHL" value={stats.dnd} hint="do not contact" />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, phone, email or address…"
            className="pl-8"
          />
        </div>
        {([
          ["all", "Everyone"],
          ["not_sent", "No estimate"],
          ["sent", "Estimate sent"],
        ] as [EstimateFilter, string][]).map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            variant={estimate === key ? "default" : "outline"}
            onClick={() => { setEstimate(key); setOffset(0); }}
          >
            {label}
          </Button>
        ))}
      </div>

      {note ? (
        <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
          {note}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
          {error}
        </div>
      ) : null}

      {/* The estimate filter is applied to the page after it is built (the
          flag is derived from two other tables), so the visible count can be
          smaller than the page size. Said plainly rather than hidden. */}
      <div className="text-xs text-muted-foreground">
        {loading
          ? "Loading…"
          : total === 0
            ? "No contacts yet — hit “Sync from GHL”."
            : `Showing ${showing} of ${total} contacts, from #${pageStart}` +
              (estimate !== "all" ? " (filtered within this page)" : "")}
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm min-w-[820px]">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="text-left font-medium px-3 py-2 w-10">#</th>
              <th className="text-left font-medium px-3 py-2">Name</th>
              <th className="text-left font-medium px-3 py-2">Phone</th>
              <th className="text-left font-medium px-3 py-2">Came in</th>
              <th className="text-left font-medium px-3 py-2">Estimate</th>
              <th className="text-left font-medium px-3 py-2">History</th>
              <th className="text-left font-medium px-3 py-2">Where from</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => (
              <tr key={c.id} className="border-t hover:bg-muted/30">
                <td className="px-3 py-2 text-muted-foreground tabular-nums">{offset + i + 1}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    {c.lead_id ? (
                      <Link to={`/leads/${c.lead_id}`} className="font-medium hover:underline">
                        {c.name || "(no name)"}
                      </Link>
                    ) : (
                      <span className="font-medium">{c.name || "(no name)"}</span>
                    )}
                    {c.dnd ? (
                      <Badge variant="destructive" className="gap-1">
                        <Ban className="h-3 w-3" /> opted out
                      </Badge>
                    ) : null}
                  </div>
                  {c.address ? (
                    <div className="text-xs text-muted-foreground">{c.address}</div>
                  ) : null}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {c.phone ? (
                    <a href={`tel:${c.phone}`} className="inline-flex items-center gap-1 hover:underline">
                      <Phone className="h-3 w-3" />{fmtPhone(c.phone)}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">no phone</span>
                  )}
                  {c.email ? (
                    <div className="text-xs text-muted-foreground inline-flex items-center gap-1 mt-0.5">
                      <Mail className="h-3 w-3" />{c.email}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                  {fmtDate(c.date_added)}
                </td>
                <td className="px-3 py-2">
                  {c.estimate_sent ? (
                    <Badge variant="secondary">sent</Badge>
                  ) : (
                    <Badge variant="outline" className="border-amber-400 text-amber-700">
                      never sent
                    </Badge>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                  <span className="inline-flex items-center gap-1 mr-3" title={`${c.inbound_count} from them`}>
                    <MessageSquare className="h-3 w-3" />{c.message_count}
                    {c.inbound_count > 0 ? (
                      <span className="text-foreground font-medium">({c.inbound_count} in)</span>
                    ) : null}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <PhoneCall className="h-3 w-3" />{c.call_count}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {c.source || "—"}
                  {c.tags.length ? (
                    <div className="mt-0.5">{c.tags.slice(0, 2).join(", ")}</div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={offset === 0 || loading}
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
        >
          Previous
        </Button>
        <span className="text-xs text-muted-foreground">
          {total > 0 ? `${pageStart}–${Math.min(offset + PAGE_SIZE, total)} of ${total}` : ""}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={offset + PAGE_SIZE >= total || loading}
          onClick={() => setOffset(offset + PAGE_SIZE)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
