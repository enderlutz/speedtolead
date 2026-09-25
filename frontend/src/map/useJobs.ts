import { useCallback, useEffect, useMemo, useState } from "react";
import jobsData from "@/data/jobs.json";
import sitesData from "@/data/sites.json";
import { isDone, isArchived, owesGoBack, type Job, type JobOverride, type Site } from "./encoding";

const LS_KEY = "sterling-job-state-v2";

// Every localStorage access wrapped in try/catch — private windows, blocked
// site data, and thumbnail capture all throw or return empty, and the map
// has to render correctly regardless. Spec Section 7.
function loadOverrides(): Record<string, JobOverride> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) || {} : {};
  } catch {
    return {};
  }
}
function saveOverrides(ovr: Record<string, JobOverride>) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(ovr));
  } catch {
    // ignore — nothing we can do in a private window / blocked storage
  }
}

export const REVIEW_LINK = "https://g.page/r/CSqFYMG3SFFFEBE/review";
export const REVIEW_REQUEST_TEXT =
  "Hey! Thanks so much for choosing us for your fence staining project. " +
  "If you have a minute, would you mind leaving us a quick Google review? " +
  "It really helps our small business out a lot. Here's the link: " +
  REVIEW_LINK;

export interface ResolvedJob extends Job {
  resolvedDone: boolean;
  resolvedArchived: boolean;
  resolvedOwesGoBack: boolean;
}

export function useJobs() {
  const [overrides, setOverrides] = useState<Record<string, JobOverride>>(() => loadOverrides());
  const jobs = jobsData as unknown as Job[];
  const sites = sitesData as unknown as Site[];

  useEffect(() => {
    saveOverrides(overrides);
  }, [overrides]);

  const setJobState = useCallback((id: string, state: JobOverride) => {
    setOverrides((prev) => ({ ...prev, [id]: state }));
  }, []);

  // Two-step completion — finishing a job and closing it out are different
  // decisions, often days apart. Spec Section 7.1.
  const markComplete = useCallback((id: string) => setJobState(id, { done: true, archived: false }), [setJobState]);
  const unstarJob = useCallback((id: string) => setJobState(id, { done: false, archived: false }), [setJobState]);
  const reopenJob = useCallback((id: string) => setJobState(id, { done: false, archived: false }), [setJobState]);

  // 7.3 — the archive gate. Archiving is not direct: it asks whether the
  // Google review link went out, and only archives on yes. This is a
  // deliberate speed bump on the one revenue-adjacent step that was
  // consistently getting skipped.
  const archiveJob = useCallback(
    (id: string): "archived" | "needs-review-link" => {
      const sent = window.confirm("Did you send the Google review link?");
      if (sent) {
        setJobState(id, { done: true, archived: true });
        return "archived";
      }
      return "needs-review-link";
    },
    [setJobState]
  );

  const resolved: ResolvedJob[] = useMemo(
    () =>
      jobs.map((j) => {
        const ovr = overrides[j.id];
        return {
          ...j,
          resolvedDone: isDone(j, ovr),
          resolvedArchived: isArchived(j, ovr),
          resolvedOwesGoBack: owesGoBack(j),
        };
      }),
    [jobs, overrides]
  );

  // Grouped for the sidebar, sorted by the underlying ISO day string —
  // that's exactly why the format is fixed: lexical sort = chronological.
  // "go-back" sorts after any real date string, which is what we want —
  // undated open work trails the dated schedule.
  const grouped = useMemo(() => {
    const groups = new Map<string, { dayLabel: string; day: string; jobs: ResolvedJob[] }>();
    for (const j of resolved) {
      if (!groups.has(j.day)) groups.set(j.day, { dayLabel: j.dayLabel, day: j.day, jobs: [] });
      groups.get(j.day)!.jobs.push(j);
    }
    return [...groups.values()].sort((a, b) => a.day.localeCompare(b.day));
  }, [resolved]);

  const stats = useMemo(() => {
    const activeJobs = resolved.filter((j) => !j.resolvedArchived);
    const goBacks = resolved.filter((j) => j.resolvedOwesGoBack && !j.resolvedArchived);
    const booked = resolved.filter((j) => !j.resolvedDone && !j.resolvedArchived);
    return { jobs: activeJobs.length, goBacks: goBacks.length, booked: booked.length };
  }, [resolved]);

  return { jobs: resolved, sites, grouped, stats, markComplete, unstarJob, reopenJob, archiveJob };
}
