// Public mobile-first photo capture page for exterior painting estimates.
// Route: /capture/:token  (no auth — token-gated by backend)
//
// Flow: welcome → tips → step-by-step photo capture → review → submit.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Camera,
  CheckCircle2,
  ChevronRight,
  ChevronLeft,
  Sun,
  Smartphone,
  Ruler,
  AlertCircle,
  Loader2,
  Send,
  Image as ImageIcon,
  Sparkles,
} from "lucide-react";
import { api, type ExteriorCaptureInfo } from "@/lib/api";

const BASE = (import.meta.env.VITE_API_URL as string) || "";

type PhotoStep = {
  id: string;
  title: string;
  subtitle: string;
  tip: string;
  required: boolean;
};

const PHOTO_STEPS: PhotoStep[] = [
  {
    id: "front_wide",
    title: "Front of your house",
    subtitle: "The whole front, corner to corner",
    tip: "Step back far enough to fit the entire front wall. Stand on the street if you need to.",
    required: true,
  },
  {
    id: "front_door",
    title: "Front door close-up",
    subtitle: "Centered on the front door",
    tip: "We use the door size to measure your walls — a standard door is 80 inches tall.",
    required: true,
  },
  {
    id: "right_side",
    title: "Right side of the house",
    subtitle: "Looking at the right wall",
    tip: "Stand back enough to see the whole side from the front corner to the back corner.",
    required: true,
  },
  {
    id: "right_close",
    title: "Right side close-up",
    subtitle: "A closer view showing windows",
    tip: "Helps us count and size your windows accurately.",
    required: false,
  },
  {
    id: "back_wide",
    title: "Back of your house",
    subtitle: "The whole back, corner to corner",
    tip: "If there's a fence in the way, shoot through the slats or stand on a chair.",
    required: true,
  },
  {
    id: "back_close",
    title: "Back close-up",
    subtitle: "A closer view of the back wall",
    tip: "Show any back doors, windows, or patios.",
    required: false,
  },
  {
    id: "left_side",
    title: "Left side of the house",
    subtitle: "Looking at the left wall",
    tip: "Same as the right — stand back, capture corner to corner.",
    required: true,
  },
  {
    id: "left_close",
    title: "Left side close-up",
    subtitle: "Closer view of any windows",
    tip: "Optional but helps accuracy.",
    required: false,
  },
  {
    id: "extras",
    title: "Anything else worth noting?",
    subtitle: "Damage, peeling, special areas",
    tip: "Optional — show us anything you want addressed.",
    required: false,
  },
];

type Stage = "loading" | "welcome" | "tips" | "capture" | "review" | "submitted" | "error";

export default function ExteriorCapture() {
  const { token } = useParams<{ token: string }>();
  const [stage, setStage] = useState<Stage>("loading");
  const [info, setInfo] = useState<ExteriorCaptureInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stepIdx, setStepIdx] = useState(0);
  const [stepsTaken, setStepsTaken] = useState<Record<string, string>>({}); // step.id → photo url
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!token) {
      setError("Missing capture link");
      setStage("error");
      return;
    }
    api
      .getExteriorCaptureInfo(token)
      .then((d) => {
        setInfo(d);
        setStage("welcome");
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Link not found");
        setStage("error");
      });
  }, [token]);

  const currentStep = PHOTO_STEPS[stepIdx];
  const requiredRemaining = useMemo(
    () =>
      PHOTO_STEPS.filter((s) => s.required && !stepsTaken[s.id]).length,
    [stepsTaken],
  );
  const totalTaken = Object.keys(stepsTaken).length;

  const uploadFile = useCallback(
    async (file: File) => {
      if (!token || !currentStep) return;
      setUploading(true);
      setError(null);
      try {
        const fd = new FormData();
        fd.append("photo", file);
        fd.append("label", currentStep.id);
        const resp = await fetch(`${BASE}/api/exterior/capture/${token}/photo`, {
          method: "POST",
          body: fd,
        });
        if (!resp.ok) {
          const txt = await resp.text().catch(() => "");
          throw new Error(`Upload failed (${resp.status}): ${txt.slice(0, 120)}`);
        }
        const data = await resp.json();
        setStepsTaken((prev) => ({ ...prev, [currentStep.id]: data?.photo?.url || "ok" }));
        // Auto-advance to next step (or jump to review when all done)
        const nextIdx = stepIdx + 1;
        if (nextIdx >= PHOTO_STEPS.length) {
          setStage("review");
        } else {
          setStepIdx(nextIdx);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [token, currentStep, stepIdx],
  );

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
    e.target.value = "";
  };

  const skip = () => {
    if (!currentStep) return;
    const next = stepIdx + 1;
    if (next >= PHOTO_STEPS.length) {
      setStage("review");
    } else {
      setStepIdx(next);
    }
  };

  const goBack = () => {
    if (stepIdx > 0) setStepIdx(stepIdx - 1);
  };

  const retake = (idx: number) => {
    setStepIdx(idx);
    setStepsTaken((prev) => {
      const next = { ...prev };
      delete next[PHOTO_STEPS[idx].id];
      return next;
    });
    setStage("capture");
  };

  const submit = async () => {
    if (!token) return;
    setSubmitting(true);
    try {
      await api.submitExteriorCapture(token, "");
      setStage("submitted");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  };

  // ---------- Render ----------

  if (stage === "loading") return <LoadingScreen />;
  if (stage === "error") return <ErrorScreen message={error || "Something went wrong"} />;

  if (stage === "welcome") return <WelcomeScreen info={info} onContinue={() => setStage("tips")} />;

  if (stage === "tips")
    return (
      <TipsScreen
        onStart={() => {
          setStepIdx(0);
          setStage("capture");
        }}
      />
    );

  if (stage === "capture")
    return (
      <CaptureScreen
        step={currentStep}
        stepIdx={stepIdx}
        totalSteps={PHOTO_STEPS.length}
        taken={!!stepsTaken[currentStep.id]}
        uploading={uploading}
        error={error}
        onCamera={() => fileInputRef.current?.click()}
        onSkip={skip}
        onBack={goBack}
        onJumpToReview={() => setStage("review")}
        canSkip={!currentStep.required}
        requiredRemaining={requiredRemaining}
        totalTaken={totalTaken}
        fileInputRef={fileInputRef}
        onFileChange={onFileChange}
      />
    );

  if (stage === "review")
    return (
      <ReviewScreen
        stepsTaken={stepsTaken}
        retake={retake}
        addMore={() => {
          const firstMissing = PHOTO_STEPS.findIndex((s) => !stepsTaken[s.id]);
          setStepIdx(Math.max(0, firstMissing));
          setStage("capture");
        }}
        submit={submit}
        submitting={submitting}
        requiredRemaining={requiredRemaining}
      />
    );

  if (stage === "submitted") return <SubmittedScreen info={info} />;

  return null;
}

// ---------- Screens ----------

function LoadingScreen() {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-slate-50 text-slate-600">
      <Loader2 className="h-6 w-6 animate-spin" />
    </div>
  );
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-slate-50 p-6 text-center">
      <AlertCircle className="h-10 w-10 text-rose-500 mb-3" />
      <h1 className="text-lg font-semibold mb-1">Link not found</h1>
      <p className="text-sm text-slate-500 mb-4 max-w-sm">{message}</p>
      <p className="text-xs text-slate-400">
        Reach out to the rep who sent you the link — they can issue a new one.
      </p>
    </div>
  );
}

function WelcomeScreen({
  info,
  onContinue,
}: {
  info: ExteriorCaptureInfo | null;
  onContinue: () => void;
}) {
  const greeting = info?.first_name ? `Hi ${info.first_name}!` : "Hello!";
  return (
    <div className="min-h-dvh bg-gradient-to-b from-blue-50 to-white p-6 flex flex-col">
      <div className="flex-1 flex flex-col items-center justify-center max-w-md mx-auto text-center">
        <div className="h-16 w-16 rounded-full bg-blue-500/15 text-blue-600 flex items-center justify-center mb-4">
          <Camera className="h-8 w-8" />
        </div>
        <h1 className="text-2xl font-bold mb-2">{greeting}</h1>
        <p className="text-base text-slate-600 mb-1">
          We need ~10 quick photos of your house to give you a fast exterior paint quote.
        </p>
        <p className="text-sm text-slate-500 mb-8">
          Takes about 5 minutes. No app to download.
        </p>
        {info?.address && (
          <div className="rounded-lg border bg-white p-3 mb-6 text-sm text-slate-600 w-full">
            <p className="text-[10px] uppercase tracking-wide text-slate-400 mb-0.5">
              Property
            </p>
            <p className="font-medium">{info.address}</p>
          </div>
        )}
        <button
          onClick={onContinue}
          className="w-full bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-semibold py-4 rounded-xl shadow-lg shadow-blue-600/25 transition-all"
        >
          Get started
          <ChevronRight className="h-4 w-4 inline ml-1" />
        </button>
        <p className="text-xs text-slate-400 mt-6">
          A&T's Fence Restoration · Sterling Fence Staining
        </p>
      </div>
    </div>
  );
}

function TipsScreen({ onStart }: { onStart: () => void }) {
  return (
    <div className="min-h-dvh bg-slate-50 p-5 flex flex-col">
      <div className="max-w-md mx-auto w-full flex-1 flex flex-col">
        <div className="flex items-center gap-2 mb-1">
          <Sparkles className="h-4 w-4 text-blue-600" />
          <p className="text-xs uppercase tracking-wide text-blue-600 font-semibold">
            Before you start
          </p>
        </div>
        <h2 className="text-xl font-bold mb-5">Tips for accurate measurements</h2>

        <Tip
          icon={<Sun className="h-5 w-5" />}
          title="Take photos in daylight"
          body="Avoid harsh shadows. Cloudy is great. Late morning or mid-afternoon is best."
        />
        <Tip
          icon={<Smartphone className="h-5 w-5" />}
          title="Keep your phone level"
          body="Don't tilt up or down. Hold it straight, like you're looking at the wall through a window."
        />
        <Tip
          icon={<Camera className="h-5 w-5" />}
          title="Step back enough to see the whole wall"
          body="Front corner to back corner needs to fit in the photo. Walk into the yard or across the street if you have to."
        />
        <Tip
          icon={<Ruler className="h-5 w-5" />}
          title="Include the ground and roofline"
          body="We need to see the bottom of the wall AND the top of the roof in each side photo so we can measure height."
        />
        <Tip
          icon={<ImageIcon className="h-5 w-5" />}
          title="Don't zoom or crop"
          body="Take the original photo and let us crop. Zooming reduces quality and breaks our measurements."
        />

        <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 mt-4 text-xs text-amber-800">
          <p className="font-semibold mb-1">Pro tip:</p>
          <p>
            If you have a fence, gate, or hedge blocking part of the wall — that's fine. Just
            take the photo from wherever you can.
          </p>
        </div>

        <div className="mt-6">
          <button
            onClick={onStart}
            className="w-full bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-semibold py-4 rounded-xl shadow-lg shadow-blue-600/25 transition-all"
          >
            I'm ready — let's go
            <ChevronRight className="h-4 w-4 inline ml-1" />
          </button>
        </div>
      </div>
    </div>
  );
}

function Tip({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex gap-3 py-3 border-b border-slate-200 last:border-b-0">
      <div className="h-10 w-10 rounded-full bg-blue-500/10 text-blue-600 flex items-center justify-center shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold leading-tight">{title}</p>
        <p className="text-xs text-slate-500 leading-snug mt-0.5">{body}</p>
      </div>
    </div>
  );
}

function CaptureScreen({
  step,
  stepIdx,
  totalSteps,
  taken,
  uploading,
  error,
  onCamera,
  onSkip,
  onBack,
  onJumpToReview,
  canSkip,
  requiredRemaining,
  totalTaken,
  fileInputRef,
  onFileChange,
}: {
  step: PhotoStep;
  stepIdx: number;
  totalSteps: number;
  taken: boolean;
  uploading: boolean;
  error: string | null;
  onCamera: () => void;
  onSkip: () => void;
  onBack: () => void;
  onJumpToReview: () => void;
  canSkip: boolean;
  requiredRemaining: number;
  totalTaken: number;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const progress = ((stepIdx + (taken ? 1 : 0)) / totalSteps) * 100;
  return (
    <div className="min-h-dvh bg-slate-50 flex flex-col">
      {/* Header / progress */}
      <div className="px-5 pt-5 pb-3 bg-white border-b">
        <div className="max-w-md mx-auto">
          <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
            <span>
              Photo {stepIdx + 1} of {totalSteps}
            </span>
            <span>{totalTaken} taken</span>
          </div>
          <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-600 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>

      <div className="flex-1 px-5 pt-6 pb-24 max-w-md mx-auto w-full">
        {/* Step title */}
        <div className="mb-1 flex items-center gap-2">
          {step.required ? (
            <span className="text-[10px] uppercase tracking-wide font-semibold text-rose-600 bg-rose-50 px-2 py-0.5 rounded">
              Required
            </span>
          ) : (
            <span className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 bg-slate-100 px-2 py-0.5 rounded">
              Optional
            </span>
          )}
        </div>
        <h2 className="text-xl font-bold leading-tight">{step.title}</h2>
        <p className="text-sm text-slate-600 mt-1">{step.subtitle}</p>

        {/* Tip card */}
        <div className="mt-5 rounded-xl bg-blue-50 border border-blue-100 p-4">
          <div className="flex items-start gap-2">
            <Sparkles className="h-4 w-4 text-blue-600 shrink-0 mt-0.5" />
            <p className="text-xs text-blue-800 leading-relaxed">{step.tip}</p>
          </div>
        </div>

        {/* Status when taken */}
        {taken && (
          <div className="mt-5 rounded-xl bg-emerald-50 border border-emerald-200 p-4 flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            <p className="text-sm font-semibold text-emerald-700">Photo received</p>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs text-rose-700">
            {error}
          </div>
        )}

        {/* Hidden file input — native camera */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={onFileChange}
          className="hidden"
        />
      </div>

      {/* Sticky bottom action */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t shadow-[0_-8px_24px_rgba(0,0,0,0.06)] px-5 py-3 safe-bottom">
        <div className="max-w-md mx-auto flex items-center gap-2">
          <button
            onClick={onBack}
            disabled={stepIdx === 0 || uploading}
            className="p-3 rounded-xl text-slate-500 hover:bg-slate-100 disabled:opacity-30"
            aria-label="Previous"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            onClick={onCamera}
            disabled={uploading}
            className="flex-1 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:opacity-60 text-white font-semibold py-4 rounded-xl shadow-lg shadow-blue-600/25 transition-all flex items-center justify-center gap-2"
          >
            {uploading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Uploading…
              </>
            ) : (
              <>
                <Camera className="h-5 w-5" />
                {taken ? "Retake photo" : "Take photo"}
              </>
            )}
          </button>
          {canSkip && (
            <button
              onClick={onSkip}
              disabled={uploading}
              className="px-3 py-3 text-xs text-slate-500 hover:bg-slate-100 rounded-xl disabled:opacity-40"
            >
              Skip
            </button>
          )}
        </div>
        {requiredRemaining === 0 && stepIdx < totalSteps - 1 && (
          <div className="max-w-md mx-auto mt-2 text-center">
            <button
              onClick={onJumpToReview}
              className="text-xs text-blue-600 font-semibold underline-offset-4 hover:underline"
            >
              Skip the rest and review →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewScreen({
  stepsTaken,
  retake,
  addMore,
  submit,
  submitting,
  requiredRemaining,
}: {
  stepsTaken: Record<string, string>;
  retake: (idx: number) => void;
  addMore: () => void;
  submit: () => void;
  submitting: boolean;
  requiredRemaining: number;
}) {
  const taken = PHOTO_STEPS.map((step, idx) => ({
    step,
    idx,
    url: stepsTaken[step.id],
  })).filter((x) => !!x.url);

  return (
    <div className="min-h-dvh bg-slate-50 p-5 pb-32">
      <div className="max-w-md mx-auto">
        <h2 className="text-xl font-bold mb-1">Review your photos</h2>
        <p className="text-sm text-slate-600 mb-4">
          {taken.length} photo{taken.length === 1 ? "" : "s"} ready to send. Tap any to retake.
        </p>

        {requiredRemaining > 0 && (
          <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 mb-4 text-xs text-amber-800">
            <p className="font-semibold mb-1">
              {requiredRemaining} required photo{requiredRemaining === 1 ? "" : "s"} still missing
            </p>
            <p>You can submit anyway, but the estimate may be less accurate.</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          {taken.map(({ step, idx, url }) => (
            <button
              key={step.id}
              onClick={() => retake(idx)}
              className="rounded-xl overflow-hidden border-2 border-slate-200 hover:border-blue-400 bg-white transition-all"
            >
              <div className="aspect-square bg-slate-100 relative">
                {url && url !== "ok" ? (
                  <img
                    src={url}
                    alt={step.title}
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-slate-400">
                    <ImageIcon className="h-8 w-8" />
                  </div>
                )}
                <div className="absolute top-1.5 right-1.5 bg-emerald-500 text-white rounded-full h-5 w-5 flex items-center justify-center">
                  <CheckCircle2 className="h-3 w-3" />
                </div>
              </div>
              <div className="p-2 text-left">
                <p className="text-[10px] uppercase tracking-wide text-slate-400">
                  Tap to retake
                </p>
                <p className="text-xs font-semibold leading-tight">{step.title}</p>
              </div>
            </button>
          ))}
          <button
            onClick={addMore}
            className="rounded-xl border-2 border-dashed border-slate-300 bg-white hover:border-blue-400 transition-all p-4 flex flex-col items-center justify-center gap-2 aspect-square"
          >
            <Camera className="h-6 w-6 text-slate-400" />
            <span className="text-xs text-slate-500 font-semibold">Add more</span>
          </button>
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-white border-t shadow-[0_-8px_24px_rgba(0,0,0,0.06)] px-5 py-3 safe-bottom">
        <div className="max-w-md mx-auto">
          <button
            onClick={submit}
            disabled={submitting || taken.length === 0}
            className="w-full bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:opacity-60 text-white font-semibold py-4 rounded-xl shadow-lg shadow-blue-600/25 transition-all flex items-center justify-center gap-2"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Submitting…
              </>
            ) : (
              <>
                <Send className="h-4 w-4" />
                Send {taken.length} photo{taken.length === 1 ? "" : "s"}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function SubmittedScreen({ info }: { info: ExteriorCaptureInfo | null }) {
  return (
    <div className="min-h-dvh bg-gradient-to-b from-emerald-50 to-white p-6 flex flex-col items-center justify-center text-center">
      <div className="h-20 w-20 rounded-full bg-emerald-500/15 text-emerald-600 flex items-center justify-center mb-5">
        <CheckCircle2 className="h-10 w-10" />
      </div>
      <h1 className="text-2xl font-bold mb-2">All set{info?.first_name ? `, ${info.first_name}` : ""}!</h1>
      <p className="text-sm text-slate-600 max-w-md mb-4">
        We've got your photos and we're working on your estimate. You'll hear back from us soon
        with your quote.
      </p>
      <p className="text-xs text-slate-400">
        Need to add more photos?{" "}
        <button
          onClick={() => window.location.reload()}
          className="text-blue-600 font-semibold underline-offset-4 hover:underline"
        >
          Reload
        </button>{" "}
        and tap "Add more".
      </p>
      <p className="text-[10px] text-slate-300 mt-10">
        A&T's Fence Restoration · Sterling Fence Staining
      </p>
    </div>
  );
}
