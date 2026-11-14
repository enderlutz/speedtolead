// The owner's command center on the Dashboard tab (Alan, 2026-11-14): "when
// the owner opens this page, they should understand the state of the
// business within about 10 seconds". Data: GET /api/dashboard/command.
//
// Desktop order: scorecard; Action Center + Today; pipeline + marketing +
// next 7 days; alerts + collections. Phone order (the brief): Action Center,
// Today, scorecard, alerts, collections, pipeline, next 7 days, marketing.
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/utils";
import { Section, SectionFailed } from "./ui";
import { isErr, type CommandCenter as CC } from "./types";
import Scorecard from "./Scorecard";
import ActionCenter from "./ActionCenter";
import TodayJobs from "./TodayJobs";
import PipelineCard from "./PipelineCard";
import MarketingCard from "./MarketingCard";
import WeekStrip from "./WeekStrip";
import CollectionsCard from "./CollectionsCard";
import AlertsCard from "./AlertsCard";

const REFRESH_MS = 2 * 60 * 1000;

function Skeleton({ h = "h-40" }: { h?: string }) {
  return <div className={`${h} animate-pulse rounded-xl bg-muted/60`} />;
}

export default function CommandCenter({ onUnavailable, refreshKey = 0 }: {
  /** Called when this user can't see money (403): the page falls back. */
  onUnavailable?: () => void;
  /** Bump to reload (new lead, payment, reply over SSE). */
  refreshKey?: number;
}) {
  const [data, setData] = useState<CC | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState("");
  const [gone, setGone] = useState(false);

  const load = useCallback((fresh = false) => {
    api.commandCenter(fresh)
      .then((d) => { setData(d); setFailed(""); })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (/403|denied|forbidden/i.test(msg)) {
          setGone(true);
          onUnavailable?.();
        } else {
          setFailed(msg);
        }
      })
      .finally(() => setLoading(false));
  }, [onUnavailable]);

  useEffect(() => { if (!gone) load(); }, [load, refreshKey, gone]);
  useEffect(() => {
    if (gone) return;
    const t = window.setInterval(() => load(), REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load, gone]);

  if (gone) return null;

  const d = data;
  const week = d && !isErr(d.week) ? d.week : null;
  const nextDay = week?.days.find((x, i) => i > 0 && x.jobs > 0);
  const actionsCount = d && !isErr(d.actions) ? d.actions.length : 0;
  const todayCount = d && !isErr(d.today_jobs) ? d.today_jobs.length : 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {d ? <>Updated {timeAgo(d.generated_at)}</> : loading ? "Loading the business…" : failed ? "Couldn't load" : ""}
        </p>
        <button
          type="button"
          onClick={() => { setLoading(true); load(true); }}
          disabled={loading}
          className="inline-flex min-h-11 items-center gap-2 rounded-lg border px-3.5 text-sm font-semibold hover:bg-muted disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {failed && !d && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          The command center didn't load ({failed.slice(0, 140)}). Your lists below still work.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="order-3 lg:order-1 lg:col-span-12">
          {!d ? <Skeleton h="h-32" /> : isErr(d.scorecard) ? <SectionFailed err={d.scorecard} /> : <Scorecard s={d.scorecard} />}
        </div>

        <Section
          className="order-1 lg:order-2 lg:col-span-7"
          emphasis
          title={<>Action Center{actionsCount ? <span className="ml-2 text-base font-normal text-muted-foreground">{actionsCount}</span> : null}</>}
          sub="Everything waiting on someone, worst first"
        >
          {!d ? <Skeleton h="h-72" /> : isErr(d.actions) ? <SectionFailed err={d.actions} /> : <ActionCenter items={d.actions} />}
        </Section>

        <Section
          className="order-2 lg:order-3 lg:col-span-5"
          emphasis
          title={<>Today's jobs{todayCount ? <span className="ml-2 text-base font-normal text-muted-foreground">{todayCount}</span> : null}</>}
          sub="Crew calendar for today; problems in red"
        >
          {!d ? <Skeleton h="h-56" /> : isErr(d.today_jobs) ? <SectionFailed err={d.today_jobs} /> : <TodayJobs jobs={d.today_jobs} next={nextDay} />}
        </Section>

        <Section className="order-6 lg:order-4 lg:col-span-4" title="Sales pipeline" sub="Where leads sit and the money on them">
          {!d ? <Skeleton /> : isErr(d.pipeline) ? <SectionFailed err={d.pipeline} /> : <PipelineCard p={d.pipeline} />}
        </Section>

        <Section className="order-8 lg:order-5 lg:col-span-4" title="Marketing" sub="Facebook ads, this month so far">
          {!d ? <Skeleton /> : isErr(d.marketing) ? <SectionFailed err={d.marketing} /> : <MarketingCard m={d.marketing} />}
        </Section>

        <Section className="order-7 lg:order-6 lg:col-span-4" title="Next 7 days" sub="Where more jobs need booking">
          {!d ? <Skeleton /> : isErr(d.week) ? <SectionFailed err={d.week} /> : <WeekStrip w={d.week} />}
        </Section>

        <Section className="order-4 lg:order-7 lg:col-span-5" title="Business alerts" sub="Only what's out of the ordinary">
          {!d ? <Skeleton h="h-32" /> : isErr(d.alerts) ? <SectionFailed err={d.alerts} /> : <AlertsCard alerts={d.alerts} />}
        </Section>

        <Section className="order-5 lg:order-8 lg:col-span-7" title="Payments & collections" sub="Money to collect, and who owes it">
          {!d ? <Skeleton /> : isErr(d.collections) ? <SectionFailed err={d.collections} /> : <CollectionsCard c={d.collections} />}
        </Section>
      </div>
    </div>
  );
}
