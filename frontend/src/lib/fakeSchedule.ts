/* ============================================================================
 * TEMPORARY FAKE DATA — REMOVE WHEN DONE TESTING
 * ----------------------------------------------------------------------------
 * Realistic-looking sample jobs for the `employeefragne` test account ONLY, so
 * we can see what a worker's My Schedule looks like once real jobs are loaded.
 *
 * Frontend-only: nothing here touches the database or any API. It is gated to a
 * single username (see isFakeScheduleUser) so it can NEVER appear for any real
 * account. To rip it out: delete this file, then remove its imports/usages in
 * src/pages/MySchedule.tsx (search "fakeSchedule").
 * ==========================================================================*/
import type { ScheduledJob, WeatherDay } from "@/lib/api";

/** The one account allowed to see the fake schedule. */
export const FAKE_SCHEDULE_USERNAME = "employeefragne";

export function isFakeScheduleUser(user: { sub?: string } | null | undefined): boolean {
  return (user?.sub || "") === FAKE_SCHEDULE_USERNAME;
}

type Tab = "today" | "upcoming" | "past";

const SUNNY: WeatherDay = {
  date: "", high_f: 94, low_f: 74, precip_in: 0, precip_chance_pct: 10, summary: "Sunny",
};
const PARTLY: WeatherDay = {
  date: "", high_f: 90, low_f: 72, precip_in: 0, precip_chance_pct: 20, summary: "Partly cloudy",
};

// A job factory — fills every required ScheduledJob field with a sensible
// default so each sample only has to specify what makes it distinct.
function mk(id: string, o: Partial<ScheduledJob>): ScheduledJob {
  return {
    id,
    lead_id: `FAKE-LEAD-${id}`,
    job_date: "",
    arrival_time: "08:00",
    estimated_duration_hours: 4,
    address: "",
    zip_code: "77433",
    weather_today: null,
    fence_sides_label: "",
    customer_name: "",
    package_tier: "signature",
    color_choice: "",
    needs_test_spots: false,
    gallons_estimate: 0,
    bleach_gallons: 0,
    stain_gallons_used: 0,
    job_description: "Fence staining",
    worker_notes: "",
    status: "scheduled",
    google_event_id: "",
    service_type: "fence_staining",
    assigned_employee_ids: [],
    ...o,
  };
}

/** True for any id this module hands out — lets MySchedule short-circuit the
 *  start/complete API calls and mutate local state instead. */
export function isFakeJobId(id: string): boolean {
  return id.startsWith("FAKE-");
}

function todayJobs(D: (o: number) => string): ScheduledJob[] {
  const d = D(0);
  return [
    mk("FAKE-T1", {
      job_date: d, arrival_time: "07:30", status: "completed",
      customer_name: "Marcus Bell", address: "13402 Fern Hollow Ln, Cypress, TX", zip_code: "77429",
      fence_sides_label: "Inside Front, Inside Left, Inside Back, Inside Right",
      package_tier: "signature", color_choice: "Cedar Natural",
      gallons_estimate: 12, stain_gallons_used: 11, bleach_gallons: 4,
      estimated_duration_hours: 3, weather_today: { ...SUNNY, date: d },
      worker_notes: "Gate code #4471. Dog in backyard — owner will crate.",
      started_at: `${d}T07:34:00Z`, completed_at: `${d}T10:05:00Z`,
    }),
    mk("FAKE-T2", {
      job_date: d, arrival_time: "10:30", status: "in_progress",
      customer_name: "Priya Nair", address: "8815 Silverbrook Dr, Houston, TX", zip_code: "77095",
      fence_sides_label: "All 8 sides",
      package_tier: "legacy", color_choice: "Dark Walnut",
      gallons_estimate: 20, bleach_gallons: 6, needs_test_spots: true,
      estimated_duration_hours: 5, weather_today: { ...SUNNY, date: d },
      worker_notes: "Test spots on back panel first — customer picking between two shades.",
      started_at: `${d}T10:41:00Z`,
    }),
    mk("FAKE-T3", {
      job_date: d, arrival_time: "13:00", status: "scheduled",
      customer_name: "Derek & Sandra Coyle", address: "20719 Fenton Point Ct, Cypress, TX", zip_code: "77433",
      fence_sides_label: "Outside Front, Outside Left, Outside Right",
      package_tier: "essential", color_choice: "Clear / Natural",
      gallons_estimate: 9,
      estimated_duration_hours: 3, weather_today: { ...PARTLY, date: d },
    }),
    mk("FAKE-T4", {
      job_date: d, arrival_time: "15:30", status: "scheduled",
      customer_name: "Anthony Ruiz", address: "10238 Barker Cypress Rd, Houston, TX", zip_code: "77070",
      fence_sides_label: "Inside Front, Inside Back",
      package_tier: "signature", color_choice: "Redwood",
      gallons_estimate: 8, needs_test_spots: false,
      estimated_duration_hours: 2, weather_today: { ...PARTLY, date: d },
      worker_notes: "Street parking only. Ring bell at side gate.",
    }),
  ];
}

function upcomingJobs(D: (o: number) => string): ScheduledJob[] {
  return [
    mk("FAKE-U1", {
      job_date: D(1), arrival_time: "08:00", customer_name: "Rebecca Tran",
      address: "7104 Lakeshore Bend Dr, Cypress, TX", fence_sides_label: "All 8 sides",
      package_tier: "legacy", color_choice: "Chestnut", gallons_estimate: 18, estimated_duration_hours: 5,
    }),
    mk("FAKE-U2", {
      job_date: D(1), arrival_time: "13:30", customer_name: "Jamal Whitfield",
      address: "4419 Prairie Vale Ct, Katy, TX", zip_code: "77494",
      fence_sides_label: "Inside Front, Inside Left, Inside Back, Inside Right",
      package_tier: "signature", color_choice: "Cedar Natural", gallons_estimate: 11, estimated_duration_hours: 3,
    }),
    mk("FAKE-U3", {
      job_date: D(2), arrival_time: "08:30", customer_name: "Olivia MendezRosario",
      address: "12530 Canyon Fields Ln, Cypress, TX", fence_sides_label: "Outside Front, Outside Back",
      package_tier: "essential", color_choice: "Clear / Natural", gallons_estimate: 7, estimated_duration_hours: 2,
    }),
    mk("FAKE-U4", {
      job_date: D(2), arrival_time: "11:00", customer_name: "The Halvorsen Family",
      address: "9007 Windmill Estates Dr, Houston, TX", zip_code: "77064",
      fence_sides_label: "All 8 sides", package_tier: "legacy", color_choice: "Dark Walnut",
      gallons_estimate: 22, needs_test_spots: true, estimated_duration_hours: 6,
      worker_notes: "Large corner lot — bring the extra 25ft ladder.",
    }),
    mk("FAKE-U5", {
      job_date: D(4), arrival_time: "09:00", customer_name: "Sean Okafor",
      address: "18122 Timber Falls Dr, Cypress, TX", fence_sides_label: "Inside Front, Inside Back",
      package_tier: "signature", color_choice: "Redwood", gallons_estimate: 10, estimated_duration_hours: 3,
    }),
    mk("FAKE-U6", {
      job_date: D(5), arrival_time: "08:00", customer_name: "Grace Lindqvist",
      address: "6521 Meadow Vista Ln, Katy, TX", zip_code: "77493",
      fence_sides_label: "All 8 sides", package_tier: "signature", color_choice: "Chestnut",
      gallons_estimate: 15, estimated_duration_hours: 4,
    }),
  ];
}

function pastJobs(D: (o: number) => string): ScheduledJob[] {
  const done = (id: string, offset: number, o: Partial<ScheduledJob>): ScheduledJob =>
    mk(id, {
      job_date: D(offset), status: "completed",
      started_at: `${D(offset)}T08:12:00Z`, completed_at: `${D(offset)}T12:40:00Z`,
      ...o,
    });
  return [
    done("FAKE-P1", -1, {
      arrival_time: "08:00", customer_name: "Victor Alcala",
      address: "14210 Stonehill Grove Ln, Cypress, TX", fence_sides_label: "All 8 sides",
      package_tier: "legacy", color_choice: "Dark Walnut", gallons_estimate: 19, stain_gallons_used: 20, bleach_gallons: 6,
    }),
    done("FAKE-P2", -2, {
      arrival_time: "09:30", customer_name: "Danielle Prescott",
      address: "3308 Aspen Meadow Dr, Katy, TX", zip_code: "77494",
      fence_sides_label: "Inside Front, Inside Left, Inside Back, Inside Right",
      package_tier: "signature", color_choice: "Cedar Natural", gallons_estimate: 12, stain_gallons_used: 12, bleach_gallons: 4,
    }),
    done("FAKE-P3", -4, {
      arrival_time: "08:00", customer_name: "Curtis Boonyasai",
      address: "11945 Golden Sunrise Dr, Houston, TX", zip_code: "77095",
      fence_sides_label: "Outside Front, Outside Back", package_tier: "essential",
      color_choice: "Clear / Natural", gallons_estimate: 8, stain_gallons_used: 7,
    }),
    done("FAKE-P4", -6, {
      arrival_time: "13:00", customer_name: "The Ferraro Household",
      address: "20044 Bluewater Cove Ct, Cypress, TX", fence_sides_label: "All 8 sides",
      package_tier: "signature", color_choice: "Redwood", gallons_estimate: 16, stain_gallons_used: 17, bleach_gallons: 5,
    }),
  ];
}

/** Fake jobs for the given tab. `D(offset)` returns a YYYY-MM-DD Central date. */
export function buildFakeJobs(tab: Tab, D: (offset: number) => string): ScheduledJob[] {
  if (tab === "today") return todayJobs(D);
  if (tab === "upcoming") return upcomingJobs(D);
  return pastJobs(D);
}
