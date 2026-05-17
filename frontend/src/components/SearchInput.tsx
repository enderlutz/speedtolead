import { useEffect, useRef, useState, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { api, type LeanLead, type LeanEmployee } from "@/lib/api";

// Generic typeahead primitive used by both <CustomerSearchInput> and
// <EmployeeSearchInput>. On empty input + focus, shows the "recent"
// dropdown (last 10 items admin touched). On typing, debounces 200ms
// then hits the search endpoint. Click outside to dismiss.
//
// Designed so the picker can return EITHER a selected object (full
// row) or a free-text fallback for unknown customers/employees, since
// some forms accept names that don't yet exist in the DB.

type SearchInputProps<T> = {
  value: string;                                  // current text in the input
  onChange: (text: string) => void;               // user typed
  onSelect: (item: T) => void;                    // user picked from dropdown
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  fetchRecent: () => Promise<{ results: T[] }>;
  fetchSearch: (q: string) => Promise<{ results: T[] }>;
  renderItem: (item: T) => React.ReactNode;
  getKey: (item: T) => string;
};

function SearchInput<T>({
  value, onChange, onSelect, placeholder, className, disabled,
  fetchRecent, fetchSearch, renderItem, getKey,
}: SearchInputProps<T>) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<number | null>(null);

  // Click outside → close.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // Fetch results: empty → recent; non-empty → debounced search.
  const runFetch = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const fn = q.trim() ? fetchSearch(q.trim()) : fetchRecent();
      const res = await fn;
      setResults(res.results || []);
      setHighlightIdx(0);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [fetchRecent, fetchSearch]);

  // Debounce on value change while open.
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => runFetch(value), value.trim() ? 200 : 0);
    return () => { if (debounceRef.current) window.clearTimeout(debounceRef.current); };
  }, [value, open, runFetch]);

  const handleFocus = () => { setOpen(true); runFetch(value); };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (results[highlightIdx]) {
        e.preventDefault();
        pick(results[highlightIdx]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const pick = (item: T) => {
    onSelect(item);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className={`relative ${className || ""}`}>
      <Input
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
      />
      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-md shadow-lg max-h-80 overflow-y-auto">
          {loading && results.length === 0 && (
            <div className="px-3 py-2 text-sm text-muted-foreground">Searching…</div>
          )}
          {!loading && results.length === 0 && (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {value.trim() ? "No matches" : "Nothing recent"}
            </div>
          )}
          {results.map((item, i) => (
            <button
              key={getKey(item)}
              type="button"
              onMouseEnter={() => setHighlightIdx(i)}
              onClick={() => pick(item)}
              className={`block w-full text-left px-3 py-2 text-sm border-b border-slate-100 last:border-b-0 ${
                i === highlightIdx ? "bg-slate-100" : "hover:bg-slate-50"
              }`}
            >
              {renderItem(item)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Customer search — drop-in autocomplete for any "pick a customer" input.
// ─────────────────────────────────────────────────────────────────────

export function CustomerSearchInput({
  value, onChange, onSelect, placeholder = "Search customers…", className, disabled,
}: {
  value: string;
  onChange: (text: string) => void;
  onSelect: (lead: LeanLead) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <SearchInput<LeanLead>
      value={value}
      onChange={onChange}
      onSelect={onSelect}
      placeholder={placeholder}
      className={className}
      disabled={disabled}
      fetchRecent={() => api.recentLeads(10)}
      fetchSearch={(q) => api.searchLeads(q, 10)}
      getKey={(l) => l.id}
      renderItem={(l) => (
        <div>
          <div className="font-medium">{l.contact_name || "(no name)"}</div>
          <div className="text-xs text-muted-foreground truncate">
            {[l.address, l.contact_phone].filter(Boolean).join(" — ")}
          </div>
        </div>
      )}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────
// Employee search — same primitive, employee endpoints.
// ─────────────────────────────────────────────────────────────────────

export function EmployeeSearchInput({
  value, onChange, onSelect, placeholder = "Search employees…", className, disabled,
}: {
  value: string;
  onChange: (text: string) => void;
  onSelect: (employee: LeanEmployee) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <SearchInput<LeanEmployee>
      value={value}
      onChange={onChange}
      onSelect={onSelect}
      placeholder={placeholder}
      className={className}
      disabled={disabled}
      fetchRecent={() => api.recentEmployees(10)}
      fetchSearch={(q) => api.searchEmployees(q, 10)}
      getKey={(e) => e.id}
      renderItem={(e) => (
        <div>
          <div className="font-medium">{e.full_name || "(no name)"}</div>
          <div className="text-xs text-muted-foreground truncate">
            {[e.pay_type, e.phone].filter(Boolean).join(" — ")}
          </div>
        </div>
      )}
    />
  );
}
