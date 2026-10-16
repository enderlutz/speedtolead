import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { RefreshCw, Search, Phone, Mail, MessageSquare, Ban, ChevronRight, Trash2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { api, getCurrentUser, type ContactRow, type ContactStats } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

/**
 * Contacts — a straight mirror of the GHL contact list.
 *
 * The lead boards only ever showed people who had an opportunity card in one
 * of two polled pipelines. This shows everyone, so "who have we never sent
 * an estimate to?" can be answered against the whole customer base rather
 * than a subset of it.
 *
 * Newest form fill first (Alan, 2026-10-09): one in ten customers fills the
 * form again, and a customer who came in in August and came back in October
 * is a new lead again — they belong at the top, with "no estimate" meaning
 * none since they came back. GHL's own added-order is a toggle away.
 */

const PAGE_SIZE = 100;

type EstimateFilter = "all" | "sent" | "not_sent";
type SortKey = "intake" | "added";

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
/** Texts and calls in plain words (Alan, 2026-10-15: "4 texts (2 in), 3 talked,
 *  0 no answer, 3 dials — what does that even mean?"). Green when they've
 *  answered: texted back, or picked up. */
function TextsChip({ sent, fromThem }: { sent: number; fromThem: number }) {
  return (
    <span title={`${sent} texts in the thread, ${fromThem} of them from the customer`}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${fromThem > 0 ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300" : "bg-muted text-muted-foreground"}`}>
      <MessageSquare className="h-3 w-3" />
      {sent === 0 ? "No texts" : <>{sent} text{sent === 1 ? "" : "s"}{fromThem > 0 ? <> · <b>{fromThem} from them</b></> : " · no reply"}</>}
    </span>
  );
}

function CallsChip({ dials, talked, voicemails }: { dials: number; talked: number; voicemails: number }) {
  const noAnswer = Math.max(0, dials - talked - voicemails);
  return (
    <span title="Calls we made: how many they picked up, went to voicemail, or rang out"
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${talked > 0 ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300" : "bg-muted text-muted-foreground"}`}>
      <Phone className="h-3 w-3" />
      {dials === 0 ? "No calls yet" : <>
        {dials} call{dials === 1 ? "" : "s"}
        {talked > 0 ? <> · <b>{talked} picked up</b></> : null}
        {voicemails > 0 ? ` · ${voicemails} voicemail` : null}
        {noAnswer > 0 ? ` · ${noAnswer} no answer` : null}
      </>}
    </span>
  );
}

function CallTally({
  row,
  onRefreshed,
}: {
  row: ContactRow;
  onRefreshed: (leadId: string, patch: Partial<ContactRow>) => void;
}) {
  const [pulling, setPulling] = useState(false);
  const talked = row.conversation_count;
  const voicemails = row.voicemail_count;
  const dials = row.attempt_count;

  const pull = async () => {
    if (!row.lead_id || pulling) return;
    setPulling(true);
    try {
      const r = await api.refreshContactHistory(row.lead_id);
      onRefreshed(row.lead_id, {
        conversation_count: r.conversation_count,
        voicemail_count: r.voicemail_count,
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

  // One short line: the table has to fit a laptop without sideways
  // scrolling (Alan, 2026-10-12), and each number keeps its tooltip.
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
      <CallsChip dials={dials} talked={talked} voicemails={voicemails} />
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

// Where you were, so Back from a customer lands on the same row instead of
// the top of page one. Alan works down this list calling people; scrolling
// back to where he was after every customer wasted the time this page is
// meant to save. sessionStorage: per tab, gone when the tab closes.
const VIEW_KEY = "contacts_view_v1";
type SavedView = { q: string; search: string; estimate: EstimateFilter; sort?: SortKey; offset: number; scroll: number; anchor: string };

function readView(): Partial<SavedView> {
  try { return JSON.parse(sessionStorage.getItem(VIEW_KEY) || "{}") || {}; } catch { return {}; }
}
function writeView(v: SavedView) {
  try { sessionStorage.setItem(VIEW_KEY, JSON.stringify(v)); } catch { /* private mode — just don't remember */ }
}
/** The page scrolls inside <main>, not the window. */
function scroller(): HTMLElement | null {
  return document.querySelector("main");
}

function toneClass(tone: string) {
  return tone === "hot" ? "text-rose-700" : tone === "warm" ? "text-amber-700"
    : tone === "off" ? "text-muted-foreground line-through" : "text-foreground";
}

/** The estimate marker, the same in the table and on the phone cards. A
 *  scheduled estimate reads as sent straight away — the point of the
 *  10-minute button is not having to come back in 10 minutes. "overdue" is
 *  the self-correction: queued, past its time, still sitting there. */
function EstimateBadge({ c }: { c: ContactRow }) {
  if (c.estimate_send_overdue) {
    return (
      <Badge variant="outline" className="border-red-500 text-red-700"
        title="Queued but still not sent well past its send time — the SMS worker may be stalled. This customer has no price yet.">
        send overdue
      </Badge>
    );
  }
  if (c.estimate_scheduled) {
    return <Badge variant="outline" className="border-blue-400 text-blue-700" title="Estimate approved and queued — the text goes out shortly">sending</Badge>;
  }
  if (c.estimate_sent) return <Badge variant="secondary">sent</Badge>;
  return (
    <Badge variant="outline" className="border-amber-400 text-amber-700"
      title={c.intake_count > 1 ? "They came back and nobody has priced them since" : undefined}>
      {c.intake_count > 1 ? "none since they came back" : "never sent"}
    </Badge>
  );
}

/** Where they are and what to do next, in words (Alan, 2026-10-12). Hot =
 *  act now, warm = soon, cold = waiting. */
function NextStep({ s, big }: { s: ContactRow["next_step"]; big?: boolean }) {
  if (!s) return <span className="text-xs italic text-muted-foreground/70">no lead</span>;
  return (
    <div className={big ? "" : "min-w-[150px]"}>
      <div className={`${big ? "text-[15px]" : "text-sm"} font-semibold leading-tight ${toneClass(s.tone)}`}>{s.next}</div>
      <div className="text-[11px] text-muted-foreground">{s.stage}</div>
    </div>
  );
}

export default function Contacts() {
  const navigate = useNavigate();
  const saved = useRef(readView()).current;
  const [rows, setRows] = useState<ContactRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(saved.offset || 0);
  const [stats, setStats] = useState<ContactStats | null>(null);
  const [q, setQ] = useState(saved.q || "");
  // ?q= from the Dashboard queue wins over the remembered search.
  const [urlParams] = useSearchParams();
  const [search, setSearch] = useState(urlParams.get("q") || saved.search || "");
  const [estimate, setEstimate] = useState<EstimateFilter>(saved.estimate || "all");
  const [sort, setSort] = useState<SortKey>(saved.sort || "intake");
  const restored = useRef(false);
  const [flash, setFlash] = useState("");
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
        sort,
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
  }, [search, estimate, sort, offset]);

  const patchRow = useCallback((leadId: string, patch: Partial<ContactRow>) => {
    setRows((prev) => prev.map((r) => (r.lead_id === leadId ? { ...r, ...patch } : r)));
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    api.getContactStats().then(setStats).catch(() => setStats(null));
  }, []);

  // Debounced so typing a name doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      const next = q.trim();
      // Only a real change of search resets to page one — not coming back
      // to the page with the search you left it on.
      if (next !== search) {
        setSearch(next);
        setOffset(0);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q, search]);

  // Back from a customer: once the rows are in, put the scroll back and, if
  // the row you opened is on screen, centre it and flash it so you can see
  // where you were even if the list moved.
  useEffect(() => {
    if (restored.current || loading || rows.length === 0) return;
    restored.current = true;
    if (!saved.anchor && !saved.scroll) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = saved.anchor ? document.querySelector(`[data-lead-row="${saved.anchor}"]`) : null;
      if (el) {
        el.scrollIntoView({ block: "center" });
        setFlash(saved.anchor || "");
        setTimeout(() => setFlash(""), 2000);
      } else {
        scroller()?.scrollTo({ top: saved.scroll || 0 });
      }
    }));
  }, [loading, rows.length, saved.anchor, saved.scroll]);

  const isAdmin = getCurrentUser()?.role === "admin";

  // Deletes in GHL first — which also removes their conversations and
  // opportunity there, and can't be undone — so it asks for "DELETE".
  // The lead is archived here, not deleted, so its history stays.
  const deleteContact = async (c: ContactRow) => {
    const who = c.name || c.phone || "this contact";
    const typed = window.prompt(
      `Delete ${who} in GoHighLevel AND on the dashboard?\n\n` +
      `GHL deletes their conversations and opportunity with them. That can't be undone there. ` +
      `Here the lead is archived, so its estimates and history are kept.\n\nType DELETE to confirm.`,
    );
    if ((typed || "").trim().toUpperCase() !== "DELETE") return;
    try {
      await api.deleteContact(c.id);
      setRows((prev) => prev.filter((r) => r.id !== c.id));
      setTotal((t) => Math.max(0, t - 1));
      toast.success(`${who} deleted in GHL and archived here`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't delete");
    }
  };

  const openLead = (leadId: string) => {
    writeView({ q, search, estimate, sort, offset, scroll: scroller()?.scrollTop || 0, anchor: leadId });
    navigate(`/leads/${leadId}`);
  };

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
            Everyone in Go High Level, newest form fill first — a customer who fills the form again comes back to the top.
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
          {/* GHL's own opt-outs on any channel, plus everyone who told us
              to stop, plus the lead flag. The old count read only GHL's
              all-channel switch, which is set by hand, and said 2. */}
          <Stat label="Do not contact" value={stats.dnd} hint="opted out in GHL, or told us to stop" />
          {stats.texts_bouncing > 0 ? (
            <Stat label="Texts bouncing" value={stats.texts_bouncing} hint="dead numbers — call instead" />
          ) : null}
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
          ["all", "Everyone", ""],
          ["not_sent", "No estimate yet", "Nobody has sent them a price since they last filled the form"],
          ["sent", "Estimate sent", "A price went out since they last filled the form"],
        ] as [EstimateFilter, string, string][]).map(([key, label, title]) => (
          <Button
            key={key}
            size="sm"
            variant={estimate === key ? "default" : "outline"}
            onClick={() => { setEstimate(key); setOffset(0); }}
            title={title || undefined}
          >
            {label}
          </Button>
        ))}
        <span className="mx-1 hidden h-5 w-px bg-border sm:inline-block" />
        {([
          ["intake", "Newest form fill", "A customer who fills the form again moves back to the top"],
          ["added", "Newest in GHL", "GHL's own order — when the contact was first added"],
        ] as [SortKey, string, string][]).map(([key, label, title]) => (
          <Button
            key={key}
            size="sm"
            variant={sort === key ? "secondary" : "ghost"}
            onClick={() => { setSort(key); setOffset(0); }}
            title={title}
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

      {/* Phone: one card per customer, readable without scrolling sideways.
          Alan works this list on walks (2026-10-12: "I close the most deals
          when I'm on a walk"), so the number is a Call button, the next step
          is the biggest line, and a tap anywhere else opens the lead. */}
      <div className="space-y-2 md:hidden">
        {rows.map((c, i) => (
          <div
            key={c.id}
            data-lead-row={c.lead_id || undefined}
            onClick={() => c.lead_id && openLead(c.lead_id)}
            className={`rounded-xl border bg-card p-3 transition-colors duration-700 ${c.lead_id ? "cursor-pointer active:bg-muted/40" : ""} ${flash && flash === c.lead_id ? "bg-amber-100" : ""}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <span className="text-xs tabular-nums text-muted-foreground">#{offset + i + 1}</span>
                  <span className="text-[15px] font-semibold leading-tight">{c.name || "(no name)"}</span>
                  {c.opted_out ? (
                    <Badge variant="destructive" className="gap-1"><Ban className="h-3 w-3" /> {c.asked_to_stop ? "told us to stop" : "opted out"}</Badge>
                  ) : c.texts_bouncing ? (
                    <Badge variant="outline" className="border-amber-400 text-amber-700">texts bouncing</Badge>
                  ) : null}
                  {c.intake_count > 1 ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-gold/20 px-1.5 text-[10px] font-semibold text-bronze">
                      <RotateCcw className="h-2.5 w-2.5" /> came back ×{c.intake_count}
                    </span>
                  ) : null}
                </div>
                {c.address ? <div className="truncate text-xs text-muted-foreground">{c.address}</div> : null}
              </div>
              {c.phone ? (
                <a
                  href={`tel:${c.phone}`}
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-emerald-600 px-3 text-sm font-bold text-white active:scale-95"
                >
                  <Phone className="h-4 w-4" /> Call
                </a>
              ) : (
                <span className="shrink-0 text-xs text-muted-foreground">no phone</span>
              )}
            </div>
            <div className="mt-2"><NextStep s={c.next_step} big /></div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <EstimateBadge c={c} />
              <span>came in {fmtDate(c.last_intake_at || c.date_added)}</span>
              <TextsChip sent={c.message_count} fromThem={c.inbound_count} />
              <CallsChip dials={c.attempt_count} talked={c.conversation_count} voicemails={c.voicemail_count} />
              {c.phone ? <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{fmtPhone(c.phone)}</span> : null}
              {c.stage ? <span className="truncate">{c.stage}</span> : null}
            </div>
          </div>
        ))}
      </div>

      <div className="hidden overflow-x-auto rounded-lg border md:block">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="text-left font-medium px-2 py-2 w-8">#</th>
              <th className="text-left font-medium px-3 py-2">Customer</th>
              <th className="text-left font-medium px-3 py-2">Phone</th>
              <th className="text-left font-medium px-3 py-2">Estimate</th>
              <th className="text-left font-medium px-3 py-2">Next step</th>
              <th className="text-left font-medium px-3 py-2">History</th>
              <th className="hidden text-left font-medium px-3 py-2 xl:table-cell">Stage</th>
              <th className="w-12" />
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => (
              <tr
                key={c.id}
                data-lead-row={c.lead_id || undefined}
                onClick={() => c.lead_id && openLead(c.lead_id)}
                className={`border-t transition-colors duration-700 hover:bg-muted/30 ${c.lead_id ? "cursor-pointer" : ""} ${flash && flash === c.lead_id ? "bg-amber-100" : ""}`}
              >
                <td className="px-2 py-2 text-xs text-muted-foreground tabular-nums">{offset + i + 1}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{c.name || "(no name)"}</span>
                    {c.opted_out ? (
                      <Badge
                        variant="destructive" className="gap-1"
                        title={c.asked_to_stop ? "They told us to stop texting them" : c.dnd_note ? `Opted out in GHL — ${c.dnd_note}` : "Opted out in GHL"}
                      >
                        <Ban className="h-3 w-3" /> {c.asked_to_stop ? "told us to stop" : "opted out"}
                      </Badge>
                    ) : c.texts_bouncing ? (
                      <Badge variant="outline" className="gap-1 border-amber-400 text-amber-700" title={`Texts don't deliver — ${c.dnd_note}. Call instead.`}>
                        texts bouncing
                      </Badge>
                    ) : null}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {c.address ? <span>{c.address} · </span> : null}
                    <span title={`Last came in ${fmtDate(c.last_intake_at || c.date_added)}`}>came in {fmtDate(c.last_intake_at || c.date_added)}</span>
                    {c.intake_count > 1 ? (
                      <span
                        className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-gold/20 px-1.5 text-[10px] font-semibold text-bronze"
                        title={`First came in ${fmtDate(c.date_added)}. Filled the form ${c.intake_count} times — this is a new lead again.`}
                      >
                        <RotateCcw className="h-2.5 w-2.5" /> came back ×{c.intake_count}
                      </span>
                    ) : null}
                  </div>
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
                    <div className="mt-0.5 hidden items-center gap-1 text-xs text-muted-foreground 2xl:flex" title={c.email}>
                      <Mail className="h-3 w-3 shrink-0" /><span className="max-w-[180px] truncate">{c.email}</span>
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2"><EstimateBadge c={c} /></td>
                <td className="px-3 py-2"><NextStep s={c.next_step} /></td>
                <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                  <TextsChip sent={c.message_count} fromThem={c.inbound_count} />
                  {/* Talked / no answer / dials: a recording means we actually
                      spoke, a dial with no recording is a voicemail or a
                      ring-out, and that is half of all dialling. */}
                  <div className="mt-0.5"><CallTally row={c} onRefreshed={patchRow} /></div>
                </td>
                {/* The pipeline is an attribute of the contact now, not the
                    reason they exist. Blank = nobody made a card for them.
                    Where they came from sits under it; both only on a wide
                    screen so a laptop shows the whole row at once. */}
                <td className="hidden px-3 py-2 text-xs text-muted-foreground xl:table-cell">
                  {c.stage ? (
                    <div className="max-w-[160px] truncate" title={c.stage}>{c.stage}</div>
                  ) : (
                    <div className="italic text-muted-foreground/70">not on a board</div>
                  )}
                  <div className="max-w-[160px] truncate text-muted-foreground/80" title={[c.source, ...c.tags].filter(Boolean).join(" · ")}>
                    {c.source || "—"}{c.tags.length ? ` · ${c.tags.slice(0, 2).join(", ")}` : ""}
                  </div>
                </td>
                <td className="px-2 py-2 text-muted-foreground">
                  <div className="flex items-center justify-end gap-1">
                    {isAdmin ? (
                      <button
                        type="button"
                        title="Delete this contact in GHL and here"
                        onClick={(e) => { e.stopPropagation(); void deleteContact(c); }}
                        className="rounded-md p-1 opacity-40 transition hover:bg-red-50 hover:text-red-600 hover:opacity-100"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                    {c.lead_id ? <ChevronRight className="h-4 w-4" /> : null}
                  </div>
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
