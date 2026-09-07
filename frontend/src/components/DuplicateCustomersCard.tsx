import { useCallback, useEffect, useState } from "react";
import { api, type DuplicateGroup, type DuplicateGroupLead } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Users, Loader2, Check, X, RefreshCw } from "lucide-react";

// Customers that look like the same person, for Alan to judge.
//
// This exists because two different customers are called Micheal — one at
// 9403 Calwood Cir, one named Micheal Jessop at 19802 Laguna Hills Ct — and
// they were nearly merged into a single record. No matcher can tell them
// apart, and no matcher ever will. What settles it is a person looking once.
//
// Both answers are useful, which is why both are recorded:
//   "Same person"     -> a soft pointer. Nothing is moved or deleted.
//   "Different people" -> stops this pair being raised again, AND becomes the
//                         record the resolver reads so they never collapse.

function LeadRow({ lead }: { lead: DuplicateGroupLead }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="text-sm font-medium truncate">{lead.contact_name || "(no name)"}</p>
      <p className="text-xs text-muted-foreground truncate">
        {lead.address || "no address"}
      </p>
      {lead.phone && (
        <p className="text-xs text-muted-foreground">{lead.phone}</p>
      )}
    </div>
  );
}

function Group({ group, onResolved }: { group: DuplicateGroup; onResolved: () => void }) {
  const [busy, setBusy] = useState(false);
  // Only pairs can be judged. A group of three is judged two at a time.
  const [a, b] = group.leads;
  if (!a || !b) return null;

  const same = async (canonicalId: string, duplicateId: string) => {
    setBusy(true);
    try {
      await api.markSamePerson(canonicalId, duplicateId);
      toast.success("Marked as the same person. Nothing was deleted.");
      onResolved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save that");
    } finally {
      setBusy(false);
    }
  };

  const different = async () => {
    setBusy(true);
    try {
      await api.markDifferentPeople(a.id, b.id);
      toast.success("Noted — these two won't be raised again.");
      onResolved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save that");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border p-3 space-y-3">
      <p className="text-xs text-muted-foreground">{group.reason}</p>

      <div className="flex items-start gap-3">
        <LeadRow lead={a} />
        <span className="text-xs text-muted-foreground shrink-0 pt-1">vs</span>
        <LeadRow lead={b} />
      </div>

      <div className="flex flex-wrap gap-2 pt-1 border-t">
        <Button size="sm" variant="outline" disabled={busy} onClick={different}>
          {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                : <X className="h-3.5 w-3.5 mr-1" />}
          Different people
        </Button>
        <Button size="sm" variant="outline" disabled={busy}
                onClick={() => same(a.id, b.id)}>
          <Check className="h-3.5 w-3.5 mr-1" />
          Same — keep {(a.contact_name || "the first").split(" ")[0]}&apos;s record
        </Button>
        <Button size="sm" variant="outline" disabled={busy}
                onClick={() => same(b.id, a.id)}>
          <Check className="h-3.5 w-3.5 mr-1" />
          Same — keep {(b.contact_name || "the second").split(" ")[0]}&apos;s record
        </Button>
      </div>
    </div>
  );
}

export default function DuplicateCustomersCard() {
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.listDuplicates();
      setGroups(r.groups);
    } catch {
      toast.error("Couldn't load the duplicate list");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm sm:text-base flex items-center gap-2">
          <Users className="h-4 w-4" />
          Possible duplicate customers
          {!loading && groups.length > 0 && (
            <span className="text-xs font-normal text-muted-foreground">
              {groups.length} to check
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Two records that might be one person. Your answer is remembered either
          way — marking them as different stops them being raised again, and
          keeps them from ever being merged by mistake.
        </p>

        {loading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…
          </p>
        ) : groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing to review — no customer records look like duplicates.
          </p>
        ) : (
          <div className="space-y-2">
            {groups.map((g) => (
              <Group key={g.leads.map((l) => l.id).join("|")} group={g} onResolved={load} />
            ))}
          </div>
        )}

        <Button size="sm" variant="outline" onClick={load} disabled={loading}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Check again
        </Button>
      </CardContent>
    </Card>
  );
}
