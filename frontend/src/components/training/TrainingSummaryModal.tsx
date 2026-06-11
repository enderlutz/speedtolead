import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useTrainingMode } from "@/lib/training_mode_context";
import CallSummary, { type TrainingSessionRow } from "./CallSummary";

/**
 * Global summary modal — pops up over any page when the rep ends a
 * practice call. Reuses the CallSummary component (full score + transcript
 * + playback) inside a dialog scroll surface.
 */
export default function TrainingSummaryModal() {
  const { pendingSummary, dismissSummary } = useTrainingMode();

  return (
    <Dialog
      open={!!pendingSummary}
      onOpenChange={(open) => {
        if (!open) dismissSummary();
      }}
    >
      <DialogContent className="max-w-4xl w-[95vw] max-h-[90vh] p-0 overflow-hidden flex flex-col">
        <DialogTitle className="sr-only">Practice call summary</DialogTitle>
        <div className="overflow-y-auto">
          {pendingSummary && (
            <CallSummary
              session={pendingSummary as unknown as TrainingSessionRow}
              onClose={dismissSummary}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
