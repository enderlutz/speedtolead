import { useEffect, useMemo, useRef, useState } from "react";
import { api, type SearchableCustomer } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Search, X } from "lucide-react";

interface Props {
  /** Used to seed the customer list. Any active employee id works — the
   *  underlying endpoint returns every searchable customer regardless. */
  employeeId: string;
  /** Initial text in the input (so freeform values from older records show). */
  initialValue?: string;
  /** Pre-selected lead id (so re-opening a record shows the picked state). */
  initialLeadId?: string;
  /** Fires every time the search text changes OR a customer is picked.
   *  When a customer is picked, `leadId` is set; freeform-typed values keep
   *  `leadId` empty and just propagate the typed text. */
  onChange: (value: { text: string; leadId: string }) => void;
  placeholder?: string;
  /** Optional helper line under the input. */
  hint?: string;
  className?: string;
}

/**
 * Typeahead customer picker. Wraps the existing /api/time-logs/customers-to-log
 * endpoint that powers the lead-search box on the Daily Log + Reimbursement
 * forms. Designed for places where we just need a customer name (e.g.
 * Time Entry job_reference) — keeps the freeform fallback so anything the
 * user types still saves even when no customer matches.
 */
export default function CustomerSearchPicker({
  employeeId, initialValue = "", initialLeadId = "", onChange,
  placeholder = "Search a customer (or just type)", hint, className = "",
}: Props) {
  const [text, setText] = useState(initialValue);
  const [leadId, setLeadId] = useState(initialLeadId);
  const [allCustomers, setAllCustomers] = useState<SearchableCustomer[]>([]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!employeeId) return;
    api.getCustomersToLog(employeeId)
      .then((r) => setAllCustomers(r.all_customers))
      .catch(() => setAllCustomers([]));
  }, [employeeId]);

  // Close suggestion list on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const suggestions = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return [] as SearchableCustomer[];
    return allCustomers
      .filter((c) => c.name.toLowerCase().includes(q) || c.address.toLowerCase().includes(q))
      .slice(0, 8);
  }, [text, allCustomers]);

  const update = (next: { text: string; leadId: string }) => {
    setText(next.text);
    setLeadId(next.leadId);
    onChange(next);
  };

  const pick = (c: SearchableCustomer) => {
    update({ text: c.name, leadId: c.lead_id });
    setOpen(false);
  };

  const clear = () => {
    update({ text: "", leadId: "" });
    setOpen(false);
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <Search className="h-3.5 w-3.5 text-muted-foreground absolute left-2.5 top-2.5 pointer-events-none" />
      <Input
        value={text}
        onChange={(e) => {
          // Any keystroke unsticks a previously-picked customer — caller
          // now has freeform text and can either keep typing or pick again.
          update({ text: e.target.value, leadId: "" });
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        className="pl-8 pr-8"
      />
      {text && (
        <button
          type="button"
          onClick={clear}
          className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
          title="Clear"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      {leadId && (
        <p className="text-[11px] text-emerald-700 mt-1">
          ✓ Linked to customer record
        </p>
      )}
      {!leadId && hint && (
        <p className="text-[11px] text-muted-foreground mt-1">{hint}</p>
      )}
      {open && suggestions.length > 0 && (
        <div className="absolute z-20 left-0 right-0 mt-1 border rounded-md divide-y max-h-44 overflow-y-auto bg-background shadow-md">
          {suggestions.map((c) => (
            <button
              key={c.lead_id}
              type="button"
              onClick={() => pick(c)}
              className="w-full px-3 py-2 text-left text-sm hover:bg-muted flex items-center gap-2"
            >
              <span className="font-medium truncate flex-1">{c.name}</span>
              {c.address && (
                <span className="text-xs text-muted-foreground truncate hidden sm:inline">{c.address}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {open && text.trim() && suggestions.length === 0 && allCustomers.length > 0 && (
        <p className="absolute -bottom-5 left-0 text-[11px] text-muted-foreground">
          No customers matched — your text saves as-is.
        </p>
      )}
    </div>
  );
}
