import { useTrainingMode } from "@/lib/training_mode_context";
import { GraduationCap } from "lucide-react";

/**
 * Full-viewport red ring + a small "TRAINING MODE" badge across the top.
 * Mounted at AppLayout so it persists across every page. pointer-events:none
 * lets clicks pass through to the underlying UI.
 */
export default function TrainingBorder() {
  const { trainingModeOn } = useTrainingMode();
  if (!trainingModeOn) return null;

  return (
    <>
      {/* The ring itself */}
      <div
        className="pointer-events-none fixed inset-0 z-[60]"
        style={{
          boxShadow: "inset 0 0 0 4px rgba(244, 63, 94, 0.85)",
        }}
        aria-hidden="true"
      />
      {/* Badge — centered at top */}
      <div className="pointer-events-none fixed top-2 left-0 right-0 z-[61] flex justify-center">
        <div className="bg-rose-500 text-white text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-b-md flex items-center gap-1.5 shadow-lg">
          <GraduationCap className="h-3 w-3" />
          Training Mode
        </div>
      </div>
    </>
  );
}
