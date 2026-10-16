// Company Cam for the crew (Alan, 2026-10-15): the customer's job without the
// customer page, which shows prices everywhere. A list of booked customers
// (or search any by name or address), and each one opens straight onto
// Company Cam. The crew only ever gets the employee view.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Loader2, MapPin, Search } from "lucide-react";
import { api } from "@/lib/api";
import CompanyCamTab from "@/components/CompanyCamTab";

type Row = { lead_id: string; name: string; address: string; date: string };

function day(iso: string) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

export default function CompanyCamPage() {
  const { leadId } = useParams<{ leadId: string }>();
  if (leadId) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 p-3 sm:p-5">
        <Link to="/company-cam" className="-ml-1 inline-flex min-h-11 items-center gap-1 px-1 text-base font-semibold text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" /> All jobs
        </Link>
        <CompanyCamTab leadId={leadId} />
      </div>
    );
  }
  return <JobList />;
}

function JobList() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api.getCompanyCamJobs(q.trim())
        .then((r) => { if (live) { setRows(r); setError(""); } })
        .catch((e) => { if (live) { setRows([]); setError(e instanceof Error ? e.message : "Couldn't load the jobs"); } });
    }, q ? 300 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  return (
    <div className="mx-auto max-w-3xl space-y-3 p-3 sm:p-5">
      <div>
        <h1 className="font-heading text-2xl font-bold">Company Cam</h1>
        <p className="text-sm text-muted-foreground">Pick the customer you're at.</p>
      </div>
      <label className="flex h-12 items-center gap-2 rounded-xl border border-input bg-background px-3">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a name or address" className="h-full w-full bg-transparent text-base outline-none" />
      </label>
      {error ? <p className="text-sm text-rose-700">{error}</p> : null}
      {rows === null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
      ) : !rows.length ? (
        <p className="text-sm text-muted-foreground">{q ? "Nobody matches that." : "No booked jobs yet. Search for the customer instead."}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.lead_id}>
              <Link to={`/company-cam/${r.lead_id}`} className="flex min-h-16 items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 hover:bg-muted/50">
                {r.date ? (
                  <span className="w-16 shrink-0 rounded-lg bg-muted px-1.5 py-1 text-center text-xs font-bold leading-tight">{day(r.date)}</span>
                ) : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-semibold capitalize">{(r.name || "Customer").toLowerCase()}</span>
                  {r.address ? <span className="flex items-center gap-1 truncate text-xs text-muted-foreground"><MapPin className="h-3 w-3 shrink-0" />{r.address}</span> : null}
                </span>
                <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
