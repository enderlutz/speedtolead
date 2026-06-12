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
};

const PHOTO_STEPS: PhotoStep[] = [
  {
    id: "front_wide",
    title: "Front of your house",
    subtitle: "The whole front, corner to corner",
    tip: "Step back far enough to fit the entire front wall. Stand on the street if you need to.",
  },
  {
    id: "front_door",
    title: "Front door close-up",
    subtitle: "Centered on the front door",
    tip: "We use the door size to measure your walls — a standard door is 80 inches tall.",
  },
  {
    id: "right_side",
    title: "Right side of the house",
    subtitle: "Looking at the right wall",
    tip: "Stand back enough to see the whole side from the front corner to the back corner.",
  },
  {
    id: "right_close",
    title: "Right side close-up",
    subtitle: "A closer view showing windows",
    tip: "Helps us count and size your windows accurately.",
  },
  {
    id: "back_wide",
    title: "Back of your house",
    subtitle: "The whole back, corner to corner",
    tip: "If there's a fence in the way, shoot through the slats or stand on a chair.",
  },
  {
    id: "back_close",
    title: "Back close-up",
    subtitle: "A closer view of the back wall",
    tip: "Show any back doors, windows, or patios.",
  },
  {
    id: "left_side",
    title: "Left side of the house",
    subtitle: "Looking at the left wall",
    tip: "Same as the right — stand back, capture corner to corner.",
  },
  {
    id: "left_close",
    title: "Left side close-up",
    subtitle: "Closer view of any windows",
    tip: "Helps accuracy.",
  },
  {
    id: "extras",
    title: "Anything else worth noting?",
    subtitle: "Damage, peeling, special areas",
    tip: "Show us anything you want addressed.",
  },
];

type Stage = "loading" | "welcome" | "tips" | "capture" | "review" | "submitted" | "error";

// Hard cap so a runaway loop can't fill the bucket. 50 photos is well
// beyond any realistic capture; we soft-warn the customer at 25.
const MAX_EXTRA_PHOTOS = 50 - PHOTO_STEPS.length;

export default function ExteriorCapture() {
  const { token } = useParams<{ token: string }>();
  const [stage, setStage] = useState<Stage>("loading");
  const [info, setInfo] = useState<ExteriorCaptureInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stepIdx, setStepIdx] = useState(0);
  // stepsTaken keys are either a PHOTO_STEPS step.id (front_wide, etc.) or
  // an auto-generated `extra_{n}` for additional unlimited photos.
  const [stepsTaken, setStepsTaken] = useState<Record<string, string>>({});
  const [extraCounter, setExtraCounter] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const extraInputRef = useRef<HTMLInputElement | null>(null);

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
  const totalTaken = Object.keys(stepsTaken).length;
  const extrasCount = useMemo(
    () => Object.keys(stepsTaken).filter((id) => id.startsWith("extra_")).length,
    [stepsTaken],
  );
  const extrasCapHit = extrasCount >= MAX_EXTRA_PHOTOS;

  // Shared upload helper. label = stepsTaken key + backend tag.
  const doUpload = useCallback(
    async (file: File, label: string): Promise<string | null> => {
      if (!token) return null;
      const fd = new FormData();
      fd.append("photo", file);
      fd.append("label", label);
      const resp = await fetch(`${BASE}/api/exterior/capture/${token}/photo`, {
        method: "POST",
        body: fd,
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`Upload failed (${resp.status}): ${txt.slice(0, 120)}`);
      }
      const data = await resp.json();
      return data?.photo?.url || "ok";
    },
    [token],
  );

  const uploadFile = useCallback(
    async (file: File) => {
      if (!token || !currentStep) return;
      setUploading(true);
      setError(null);
      try {
        const url = await doUpload(file, currentStep.id);
        if (url) {
          setStepsTaken((prev) => ({ ...prev, [currentStep.id]: url }));
        }
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
    [token, currentStep, stepIdx, doUpload],
  );

  const uploadExtraPhoto = useCallback(
    async (file: File) => {
      if (!token) return;
      if (extrasCapHit) {
        setError(`Maximum of ${MAX_EXTRA_PHOTOS} extra photos reached`);
        return;
      }
      setUploading(true);
      setError(null);
      try {
        const label = `extra_${extraCounter}`;
        const url = await doUpload(file, label);
        if (url) {
          setStepsTaken((prev) => ({ ...prev, [label]: url }));
          setExtraCounter((c) => c + 1);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [token, extraCounter, extrasCapHit, doUpload],
  );

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
    e.target.value = "";
  };

  const onExtraFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadExtraPhoto(file);
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

  const removeExtra = (id: string) => {
    setStepsTaken((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
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
        submitting={submitting}
        error={error}
        onCamera={() => fileInputRef.current?.click()}
        onSkip={skip}
        onBack={goBack}
        onJumpToReview={() => setStage("review")}
        onSubmitNow={submit}
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
        removeExtra={removeExtra}
        addAnotherPhoto={() => extraInputRef.current?.click()}
        submit={submit}
        submitting={submitting}
        uploading={uploading}
        extrasCount={extrasCount}
        extrasCapHit={extrasCapHit}
        extraInputRef={extraInputRef}
        onExtraFileChange={onExtraFileChange}
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
          Send us some photos of your home so we can quote your exterior paint job.
        </p>
        <p className="text-sm text-slate-500 mb-8">
          We'll walk you through it. Skip any shots that don't apply, submit whenever you're done.
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
  submitting,
  error,
  onCamera,
  onSkip,
  onBack,
  onJumpToReview,
  onSubmitNow,
  totalTaken,
  fileInputRef,
  onFileChange,
}: {
  step: PhotoStep;
  stepIdx: number;
  totalSteps: number;
  taken: boolean;
  uploading: boolean;
  submitting: boolean;
  error: string | null;
  onCamera: () => void;
  onSkip: () => void;
  onBack: () => void;
  onJumpToReview: () => void;
  onSubmitNow: () => void;
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

      <div className="flex-1 px-5 pt-6 pb-32 max-w-md mx-auto w-full">
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
            disabled={stepIdx === 0 || uploading || submitting}
            className="p-3 rounded-xl text-slate-500 hover:bg-slate-100 disabled:opacity-30"
            aria-label="Previous"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            onClick={onCamera}
            disabled={uploading || submitting}
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
          <button
            onClick={onSkip}
            disabled={uploading || submitting}
            className="px-3 py-3 text-xs text-slate-500 hover:bg-slate-100 rounded-xl disabled:opacity-40"
          >
            Skip
          </button>
        </div>
        {/* Always-available submit / jump-to-review. Customer can bail
            with whatever they've taken at any point. */}
        <div className="max-w-md mx-auto mt-2 flex items-center justify-center gap-3 text-xs">
          {totalTaken > 0 && (
            <button
              onClick={onSubmitNow}
              disabled={uploading || submitting}
              className="text-blue-600 font-semibold underline-offset-4 hover:underline disabled:opacity-40 flex items-center gap-1"
            >
              {submitting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Send className="h-3 w-3" />
              )}
              Submit {totalTaken} photo{totalTaken === 1 ? "" : "s"} now
            </button>
          )}
          {totalTaken > 0 && stepIdx < totalSteps - 1 && (
            <span className="text-slate-300">·</span>
          )}
          {stepIdx < totalSteps - 1 && (
            <button
              onClick={onJumpToReview}
              disabled={uploading || submitting}
              className="text-slate-500 font-semibold underline-offset-4 hover:underline disabled:opacity-40"
            >
              Review my photos →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

type TakenPhoto = {
  id: string;
  title: string;
  url: string;
  isExtra: boolean;
  stepIdx: number; // -1 for extras
};

function ReviewScreen({
  stepsTaken,
  retake,
  removeExtra,
  addAnotherPhoto,
  submit,
  submitting,
  uploading,
  extrasCount,
  extrasCapHit,
  extraInputRef,
  onExtraFileChange,
}: {
  stepsTaken: Record<string, string>;
  retake: (idx: number) => void;
  removeExtra: (id: string) => void;
  addAnotherPhoto: () => void;
  submit: () => void;
  submitting: boolean;
  uploading: boolean;
  extrasCount: number;
  extrasCapHit: boolean;
  extraInputRef: React.RefObject<HTMLInputElement | null>;
  onExtraFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const guidedTaken: TakenPhoto[] = PHOTO_STEPS.map((step, idx) => ({
    id: step.id,
    title: step.title,
    url: stepsTaken[step.id] || "",
    isExtra: false,
    stepIdx: idx,
  })).filter((x) => !!x.url);

  const extraTaken: TakenPhoto[] = Object.entries(stepsTaken)
    .filter(([id]) => id.startsWith("extra_"))
    .map(([id, url], i) => ({
      id,
      title: `Extra photo ${i + 1}`,
      url,
      isExtra: true,
      stepIdx: -1,
    }));

  const taken = [...guidedTaken, ...extraTaken];

  return (
    <div className="min-h-dvh bg-slate-50 p-5 pb-32">
      <div className="max-w-md mx-auto">
        <h2 className="text-xl font-bold mb-1">Review your photos</h2>
        <p className="text-sm text-slate-600 mb-4">
          {taken.length} photo{taken.length === 1 ? "" : "s"} ready to send. Tap any guided
          shot to retake, or tap an extra to remove it.
        </p>

        {extrasCount >= 25 && !extrasCapHit && (
          <div className="rounded-xl bg-blue-50 border border-blue-200 p-3 mb-4 text-xs text-blue-800">
            That's a lot of photos! You've got {taken.length} sent — plenty for an accurate
            estimate. You can add more if you really want, but we have everything we need.
          </div>
        )}

        {extrasCapHit && (
          <div className="rounded-xl bg-slate-100 border border-slate-200 p-3 mb-4 text-xs text-slate-700">
            You've reached the maximum number of photos. Tap submit to send them in!
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          {taken.map((p) => (
            <button
              key={p.id}
              onClick={() => (p.isExtra ? removeExtra(p.id) : retake(p.stepIdx))}
              className="rounded-xl overflow-hidden border-2 border-slate-200 hover:border-blue-400 bg-white transition-all"
            >
              <div className="aspect-square bg-slate-100 relative">
                {p.url && p.url !== "ok" ? (
                  <img
                    src={p.url}
                    alt={p.title}
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
                {p.isExtra && (
                  <div className="absolute top-1.5 left-1.5 bg-slate-800/85 text-white text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded">
                    Extra
                  </div>
                )}
              </div>
              <div className="p-2 text-left">
                <p className="text-[10px] uppercase tracking-wide text-slate-400">
                  {p.isExtra ? "Tap to remove" : "Tap to retake"}
                </p>
                <p className="text-xs font-semibold leading-tight">{p.title}</p>
              </div>
            </button>
          ))}
          <button
            onClick={addAnotherPhoto}
            disabled={uploading || extrasCapHit}
            className="rounded-xl border-2 border-dashed border-slate-300 bg-white hover:border-blue-400 disabled:opacity-40 transition-all p-4 flex flex-col items-center justify-center gap-2 aspect-square"
          >
            {uploading ? (
              <>
                <Loader2 className="h-6 w-6 text-blue-500 animate-spin" />
                <span className="text-xs text-slate-500 font-semibold">Uploading…</span>
              </>
            ) : (
              <>
                <Camera className="h-6 w-6 text-slate-400" />
                <span className="text-xs text-slate-600 font-semibold text-center leading-tight">
                  Add another photo
                </span>
                <span className="text-[10px] text-slate-400">No limit</span>
              </>
            )}
          </button>
        </div>

        {/* Hidden input for extras — native camera */}
        <input
          ref={extraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={onExtraFileChange}
          className="hidden"
        />
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
