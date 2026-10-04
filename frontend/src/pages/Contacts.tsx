import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshCw, Search, Phone, Mail, MessageSquare, Ban, ChevronRight } from "lucide-react";
import { toast } from "sonner";
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

function Stat({ label, value, hint, tone }: { label: string; value: number | string; hint?: string; tone?: "alert" }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${tone === "alert" ? "border-red-400 bg-red-50" : "bg-card"}`}>
      <div className={`text-lg font-semibold leading-tight ${tone === "alert" ? "text-red-700" : ""}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {hint ? <div className="text-[11px] text-muted-foreground/80 mt-0.5">{hint}</div> : null}
    </div>
  );
}

/**
 * Talked / No answer / Total dials, plus a pull-now button.
 *
 * "Talked" comes from call recordings: the call poller skips anything that
 * did not connect or ran under five seconds so Deepgram is never charged for
 * silence, which makes recordings a good proxy for a real conversation and a
 * useless one for counting effort. "Total dials" comes from TYPE_CALL
 * messages, which exist whether or not anyone picked up. Across the whole
 * customer base 49% of dials never connected and so used to be invisible.
 *
 * The refresh button exists because both pollers work through every lead in
 * rotation — a lead waits a median two hours for its turn. Having just rung
 * somebody, that is exactly when the page is wrong and you are looking at it.
 */
function CallTally({
  row,
  onRefreshed,
}: {
  row: ContactRow;
  onRefreshed: (leadId: string, patch: Partial<ContactRow>) => void;
}) {
  const [pulling, setPulling] = useState(false);
  const talked = row.conversation_count;
  const dials = row.attempt_count;
  const noAnswer = Math.max(0, dials - talked);

  const pull = async () => {
    if (!row.lead_id || pulling) return;
    setPulling(true);
    try {
      const r = await api.refreshContactHistory(row.lead_id);
      onRefreshed(row.lead_id, {
        conversation_count: r.conversation_count,
        attempt_count: r.attempt_count,
      });
      if (r.errors.length) toast.error(`GHL wouldn't give everything up: ${r.errors.join("; ")}`);
      else if (r.new_messages || r.new_recordings) {
        toast.success(`Found ${r.new_messages} new message(s), ${r.new_recordings} new recording(s)`);
      } else {
        toast.info("Nothing new in GHL for this customer");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't pull from GHL");
    } finally {
      setPulling(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span title="Calls that connected and left us a recording">
        <span className="tabular-nums font-medium text-foreground">{talked}</span>
        <span className="text-muted-foreground"> talked</span>
      </span>
      <span
        className="text-muted-foreground"
        title="Dialled but never connected — a voicemail, a no answer or an instant hangup. We can't tell those apart yet."
      >
        <span className="tabular-nums">{noAnswer}</span> no answer
      </span>
      <span className="text-muted-foreground/80" title="Every dial, answered or not">
        <span className="tabular-nums">{dials}</span> total
      </span>
      {row.lead_id ? (
        <button
          type="button"
          onClick={pull}
          disabled={pulling}
          title="Pull this customer's texts and calls from GHL now, rather than waiting for the poller (median ~2 hours)"
          className="text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${pulling ? "animate-spin" : ""}`} />
        </button>
      ) : null}
    </span>
  );
}

export default function Contacts() {
  const navigate = useNavigate();
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

  const patchRow = useCallback((leadId: string, patch: Partial<ContactRow>) => {
    setRows((prev) => prev.map((r) => (r.lead_id === leadId ? { ...r, ...patch } : r)));
  }, []);

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
          {/* Only appears when something is actually wrong — a queued estimate
              that sailed past its send time without going out. */}
          {stats.send_overdue > 0 ? (
            <Stat label="Send overdue" value={stats.send_overdue} hint="queued but never went out" tone="alert" />
          ) : null}
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
        <table className="w-full text-sm min-w-[980px]">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="text-left font-medium px-3 py-2 w-10">#</th>
              <th className="text-left font-medium px-3 py-2">Name</th>
              <th className="text-left font-medium px-3 py-2">Phone</th>
              <th className="text-left font-medium px-3 py-2">Came in</th>
              <th className="text-left font-medium px-3 py-2">Estimate</th>
              <th className="text-left font-medium px-3 py-2">History</th>
              <th className="text-left font-medium px-3 py-2">Stage</th>
              <th className="text-left font-medium px-3 py-2">Where from</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => (
              <tr
                key={c.id}
                onClick={() => c.lead_id && navigate(`/leads/${c.lead_id}`)}
                className={`border-t hover:bg-muted/30 ${c.lead_id ? "cursor-pointer" : ""}`}
              >
                <td className="px-3 py-2 text-muted-foreground tabular-nums">{offset + i + 1}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{c.name || "(no name)"}</span>
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
                {/* stopPropagation so tapping a number dials instead of
                    navigating away from the list. */}
                <td className="px-3 py-2 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
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
                  {/* A scheduled estimate reads as sent straight away — the
                      point of the 10-minute button is not having to come back
                      in 10 minutes. "overdue" is the self-correction: queued,
                      past its time, still sitting there. */}
                  {c.estimate_send_overdue ? (
                    <Badge
                      variant="outline"
                      className="border-red-500 text-red-700"
                      title="Queued but still not sent well past its send time — the SMS worker may be stalled. This customer has no price yet."
                    >
                      send overdue
                    </Badge>
                  ) : c.estimate_scheduled ? (
                    <Badge
                      variant="outline"
                      className="border-blue-400 text-blue-700"
                      title="Estimate approved and queued — the text goes out shortly"
                    >
                      sending
                    </Badge>
                  ) : c.estimate_sent ? (
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
                  {/* Talked / No answer / Total dials. Three numbers because
                      they answer different questions: a recording means we
                      actually spoke, a dial with no recording is a voicemail
                      or a ring-out, and that is half of all dialling. */}
                  <CallTally row={c} onRefreshed={patchRow} />
                </td>
                {/* The pipeline is an attribute of the contact now, not the
                    reason they exist. Blank = nobody made a card for them. */}
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {c.stage ? (
                    <span>{c.stage}</span>
                  ) : (
                    <span className="italic text-muted-foreground/70">not on a board</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {c.source || "—"}
                  {c.tags.length ? (
                    <div className="mt-0.5">{c.tags.slice(0, 2).join(", ")}</div>
                  ) : null}
                </td>
                <td className="px-2 py-2 text-muted-foreground">
                  {c.lead_id ? <ChevronRight className="h-4 w-4" /> : null}
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
