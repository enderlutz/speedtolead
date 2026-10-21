/**
 * The Sterling look for the schedule (frontend/src/index.css has the brand):
 * ink, gold, ivory, paper, line, muted, cedar, bronze. Kept apart from the
 * components so hot reload keeps working.
 */
import type { PmDay } from "@/lib/api";

export const PAPER = "bg-[#FFFDF8]";
export const IVORY = "bg-[#F8F3E7]";
export const LINE = "border-[#E4DCCB]";
export const RING = "ring-1 ring-[#E4DCCB]";
export const MUTED = "text-[#6B6256]";
export const INK = "text-[#15130F]";
export const TODAY_WASH = "bg-[#C9972F]/10";

/** One icon per kind of day instead of a colour (easier to tell apart in the sun). */
export const TASK_ICON: Record<string, string> = { cleaning: "🧽", staining: "🖌️", pressure_washing: "💦", "": "•" };
export const TASK_WORD: Record<string, string> = { cleaning: "cleaning", staining: "staining", pressure_washing: "pressure washing", "": "on the job" };
/** The dot before a line in the schedule list. Staining is the stain itself (cedar). */
export const TASK_DOT: Record<string, string> = { cleaning: "bg-[#15130F]", staining: "bg-[#B5651D]", pressure_washing: "bg-[#8C6224]", "": "bg-[#6B6256]" };

/** This row's part is finished: the job is done, or it was a cleaning day and the cleaning is done. */
export const isDone = (x: PmDay) => !!x.completed_at || (x.task === "cleaning" && !!x.progress?.cleaning_done);
