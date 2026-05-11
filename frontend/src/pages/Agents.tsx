import { useEffect, useState, useCallback, useMemo } from "react";
import { api, type AIThought, type AIThoughtSeverity, getCurrentUser } from "@/lib/api";
import { timeAgo } from "@/lib/utils";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sparkles, Check, X, Clock, Filter, BeakerIcon } from "lucide-react";
import { useSSE } from "@/hooks/useSSE";

type StatusFilter = "active" | "all" | "approved" | "dismissed" | "executed";

const SEVERITY_STYLES: Record<AIThoughtSeverity, { badge: string; border: string; tint: string }> = {
  high: {
    badge: "bg-red-500/15 text-red-600 border-red-200",
    border: "border-red-500/30",
    tint: "from-red-500/5",
  },
  medium: {
    badge: "bg-amber-500/15 text-amber-700 border-amber-200",
    border: "border-amber-500/30",
    tint: "from-amber-500/5",
  },
  low: {
    badge: "bg-blue-500/15 text-blue-700 border-blue-200",
    border: "border-blue-500/30",
    tint: "from-blue-500/5",
  },
};

export default function Agents() {
  const isAdmin = getCurrentUser()?.role === "admin";
  const [thoughts, setThoughts] = useState<AIThought[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [showTestDialog, setShowTestDialog] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.listAIThoughts({
      status: statusFilter,
      source: sourceFilter === "all" ? undefined : sourceFilter,
      limit: 100,
    })
      .then((res) => {
        setThoughts(res.thoughts);
        setActiveCount(res.active_count);
      })
      .catch(() => toast.error("Failed to load thoughts"))
      .finally(() => setLoading(false));
  }, [statusFilter, sourceFilter]);

  useEffect(() => {
    if (isAdmin) load();
  }, [load, isAdmin]);

  // Real-time refresh when a new thought is published anywhere
  useSSE(useCallback((event) => {
    if (event.type === "ai_thought") {
      load();
    }
  }, [load]));

  const sources = useMemo(() => {
    const set = new Set<string>(thoughts.map((t) => t.source).filter(Boolean));
    return ["all", ...Array.from(set).sort()];
  }, [thoughts]);

  if (!isAdmin) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">This page is admin-only.</p>
      </div>
    );
  }

  const handleApprove = async (t: AIThought) => {
    setActingOn(t.id);
    try {
      const res = await api.approveAIThought(t.id);
      if (res.status === "executed") {
        toast.success("Approved — action executed");
      } else if (res.status === "approved_no_action") {
        toast.success("Approved (no action handler — observer-only)");
      } else if (res.error) {
        toast.error(`Approved, but action failed: ${res.error}`);
      } else {
        toast.success("Approved");
      }
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to approve");
    } finally {
      setActingOn(null);
    }
  };

  const handleDismiss = async (t: AIThought) => {
    setActingOn(t.id);
    try {
      await api.dismissAIThought(t.id);
      toast.success("Dismissed");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to dismiss");
    } finally {
      setActingOn(null);
    }
  };

  const handleSnooze = async (t: AIThought) => {
    setActingOn(t.id);
    try {
      const until = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
      await api.snoozeAIThought(t.id, until);
      toast.success("Snoozed 4 hours");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to snooze");
    } finally {
      setActingOn(null);
    }
  };

  return (
    <div className="container mx-auto p-4 sm:p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-violet-500/10">
            <Sparkles className="h-5 w-5 text-violet-600" />
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-semibold leading-tight">Agents</h1>
            <p className="text-xs text-muted-foreground">
              {activeCount} active · observer-only — admin approves before anything mutates
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowTestDialog(true)}>
          <BeakerIcon className="h-3.5 w-3.5 mr-1.5" /> Drop test thought
        </Button>
      </div>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
          <TabsList>
            <TabsTrigger value="active">Active</TabsTrigger>
            <TabsTrigger value="approved">Approved</TabsTrigger>
            <TabsTrigger value="dismissed">Dismissed</TabsTrigger>
            <TabsTrigger value="executed">Executed</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>
        {sources.length > 2 && (
          <div className="flex items-center gap-1 text-xs">
            <Filter className="h-3 w-3 text-muted-foreground" />
            <select
              className="border rounded px-2 py-1 text-xs bg-background"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
            >
              {sources.map((s) => (
                <option key={s} value={s}>
                  {s === "all" ? "All sources" : s}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {loading ? (
        <div className="text-center py-12 text-muted-foreground text-sm">Loading…</div>
      ) : thoughts.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No thoughts to show.</p>
            <p className="text-xs mt-1">The feed will populate once observer modules start running.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {thoughts.map((t) => (
            <ThoughtCard
              key={t.id}
              thought={t}
              onApprove={() => handleApprove(t)}
              onDismiss={() => handleDismiss(t)}
              onSnooze={() => handleSnooze(t)}
              loading={actingOn === t.id}
            />
          ))}
        </div>
      )}

      {showTestDialog && (
        <TestThoughtDialog
          onClose={() => setShowTestDialog(false)}
          onSubmit={async (body) => {
            try {
              await api.dropTestAIThought(body);
              toast.success("Test thought added");
              setShowTestDialog(false);
              load();
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Failed");
            }
          }}
        />
      )}
    </div>
  );
}

function ThoughtCard({
  thought: t,
  onApprove,
  onDismiss,
  onSnooze,
  loading,
}: {
  thought: AIThought;
  onApprove: () => void;
  onDismiss: () => void;
  onSnooze: () => void;
  loading: boolean;
}) {
  const styles = SEVERITY_STYLES[t.severity];
  const isDecided = t.status !== "active" && t.status !== "snoozed";

  return (
    <Card className={`border ${styles.border} bg-gradient-to-br ${styles.tint} to-transparent`}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={`uppercase text-[10px] tracking-wide ${styles.badge}`}>
              {t.severity}
            </Badge>
            {t.category && (
              <span className="text-[11px] text-muted-foreground">{t.category}</span>
            )}
            {t.source && (
              <span className="text-[11px] text-muted-foreground">· {t.source}</span>
            )}
          </div>
          <span className="text-[11px] text-muted-foreground">{timeAgo(t.created_at)}</span>
        </div>
        <CardTitle className="text-base sm:text-lg leading-snug mt-1">{t.title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0 pb-4">
        {t.summary && (
          <p className="text-sm text-muted-foreground whitespace-pre-line mb-3 leading-relaxed">
            {t.summary}
          </p>
        )}
        {t.proposed_action_text && (
          <div className="rounded-md bg-violet-500/5 border border-violet-500/20 px-3 py-2 mb-3">
            <p className="text-[11px] uppercase tracking-wide text-violet-700 mb-0.5">
              Proposed action
            </p>
            <p className="text-sm">{t.proposed_action_text}</p>
          </div>
        )}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="text-[11px] text-muted-foreground">
            confidence <span className="font-medium text-foreground">{t.confidence_pct}%</span>
          </div>
          {!isDecided ? (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={onSnooze} disabled={loading} title="Snooze 4 hours">
                <Clock className="h-3.5 w-3.5 mr-1" /> Snooze
              </Button>
              <Button size="sm" variant="outline" onClick={onDismiss} disabled={loading}>
                <X className="h-3.5 w-3.5 mr-1" /> Dismiss
              </Button>
              <Button size="sm" onClick={onApprove} disabled={loading}>
                <Check className="h-3.5 w-3.5 mr-1" /> Approve
              </Button>
            </div>
          ) : (
            <Badge variant="outline" className="text-[10px] uppercase">
              {t.status}
              {t.decided_by ? ` · ${t.decided_by}` : ""}
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function TestThoughtDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (body: { title: string; summary: string; severity: string; category: string }) => void;
}) {
  const [title, setTitle] = useState("Sample diagnosis");
  const [summary, setSummary] = useState("This is a smoke test to verify the Operator AI feed renders properly.");
  const [severity, setSeverity] = useState<string>("medium");
  const [category, setCategory] = useState("System");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="bg-card border rounded-lg p-5 max-w-md w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold mb-3">Drop test thought</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Title</label>
            <input
              className="w-full border rounded px-2 py-1.5 text-sm bg-background"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Summary</label>
            <textarea
              rows={3}
              className="w-full border rounded px-2 py-1.5 text-sm bg-background"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Severity</label>
              <select
                className="w-full border rounded px-2 py-1.5 text-sm bg-background"
                value={severity}
                onChange={(e) => setSeverity(e.target.value)}
              >
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Category</label>
              <input
                className="w-full border rounded px-2 py-1.5 text-sm bg-background"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => onSubmit({ title, summary, severity, category })}>
            Drop it
          </Button>
        </div>
      </div>
    </div>
  );
}
