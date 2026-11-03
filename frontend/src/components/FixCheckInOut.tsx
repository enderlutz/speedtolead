/** A job to fix, timestamped like every other job (Alan, 2026-11-02: "we need
 *  to timestamp when they get there, when they leave"). At least one photo
 *  when they get there, at least one of the fix when they leave, as many as
 *  they like. The first "I'm here" photo is the arrival; "Done, I'm leaving"
 *  is the leave time (or the time they type if they forgot to tap). */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Camera, Loader2 } from "lucide-react";
import { api, type CompanyCamPhoto } from "@/lib/api";
import { photoTakenAt, stampText } from "@/lib/photoTime";
import { shrinkPhoto } from "@/lib/shrinkPhoto";
import { ForgotButton, WhenFields, toIso } from "@/components/JobCheckInOut";
import { cn, errMessage } from "@/lib/utils";
import { tr } from "@/lib/i18n";

type Which = "before" | "after";

function Shots({ photos }: { photos: CompanyCamPhoto[] }) {
  if (!photos.length) return null;
  return (
    <div className="mt-1.5 flex gap-1.5 overflow-x-auto">
      {photos.map((p) => (
        <div key={p.id} className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-black/10">
          {p.from_storage ? <img src={p.url} alt="" className="h-full w-full object-cover" /> : null}
          <span className="absolute inset-x-0 bottom-0 bg-black/60 px-1 text-center text-[12px] font-semibold leading-5 text-white">
            {stampText(p.taken_at || "").split(" · ")[1] || ""}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function FixCheckInOut({ fixId, onDone }: { fixId: string; onDone?: () => void }) {
  const [before, setBefore] = useState<CompanyCamPhoto[]>([]);
  const [after, setAfter] = useState<CompanyCamPhoto[]>([]);
  const [doneAt, setDoneAt] = useState("");
  const [busy, setBusy] = useState<Which | "leave" | "">("");
  const [earlier, setEarlier] = useState(false);
  const [lday, setLday] = useState("");
  const [ltime, setLtime] = useState("");
  const beforeRef = useRef<HTMLInputElement>(null);
  const afterRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api.getMyFixPhotos(fixId).then((r) => { setBefore(r.before); setAfter(r.after); setDoneAt(r.fix.done_at || ""); })
      .catch(() => { /* the card still shows what to do */ });
  }, [fixId]);
  useEffect(load, [load]);

  const upload = async (which: Which, files: FileList | File[] | null, typedAt?: string) => {
    if (!files?.length) return;
    setBusy(which);
    try {
      for (const f of Array.from(files)) {
        const takenAt = typedAt || await photoTakenAt(f); // before shrinking drops the EXIF
        await api.uploadMyFixPhoto(fixId, await shrinkPhoto(f), which, takenAt, !!typedAt);
      }
      load();
    } catch (e) { toast.error(errMessage(e, tr("Couldn't save"))); } finally { setBusy(""); }
  };

  const leftAt = earlier ? toIso(lday, ltime) : "";
  const leave = async () => {
    setBusy("leave");
    try { await api.myFixDone(fixId, leftAt); toast.success(tr("Done. Thank you!")); load(); onDone?.(); }
    catch (e) { toast.error(errMessage(e, tr("Couldn't save"))); } finally { setBusy(""); }
  };

  const step = (n: number, which: Which, title: string, photos: CompanyCamPhoto[], locked: boolean) => {
    const ref = which === "before" ? beforeRef : afterRef;
    const have = photos.length > 0;
    return (
      <div className={cn("mt-2 rounded-xl p-2.5 ring-1", have ? "bg-emerald-50 ring-emerald-300" : "bg-white ring-black/15", locked && "opacity-50")}>
        <p className="text-[15px] font-bold leading-snug">
          {have ? "✓" : n} · {title}
        </p>
        <p className="text-[14px] text-black/60">
          {have ? `${photos.length} ${tr(photos.length === 1 ? "photo" : "photos")} · ${stampText(photos[0].taken_at || "")}` : tr("At least 1 photo")}
        </p>
        <Shots photos={photos} />
        {!doneAt && !locked ? (
          <>
            <input ref={ref} type="file" accept="image/*" capture="environment" multiple hidden
                   onChange={(e) => { void upload(which, e.target.files); e.target.value = ""; }} />
            <button type="button" disabled={!!busy} onClick={() => ref.current?.click()}
                    className={cn("mt-2 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl text-base font-black disabled:opacity-50",
                                  have ? "bg-white ring-1 ring-black/15" : "bg-ink text-white")}>
              {busy === which ? <Loader2 className="h-5 w-5 animate-spin" /> : <Camera className="h-5 w-5" />}
              {have ? tr("Add more") : tr("Take a photo")}
            </button>
            <div className="mt-1.5">
              <ForgotButton onFiles={(fs, at) => void upload(which, fs, at)} />
            </div>
          </>
        ) : null}
      </div>
    );
  };

  if (doneAt) {
    return (
      <div className="mt-2 rounded-xl bg-emerald-50 p-2.5 ring-1 ring-emerald-300">
        <p className="text-[15px] font-bold">✓ {tr("Done")}</p>
        <p className="text-[14px] text-black/70">
          {before.length ? `${tr("Got there")} ${stampText(before[0].taken_at || "")} · ` : ""}{tr("Left at")} {stampText(doneAt)}
        </p>
        <Shots photos={[...before, ...after]} />
      </div>
    );
  }

  const future = !!leftAt && new Date(leftAt).getTime() > Date.now() + 5 * 60_000;
  const ready = before.length > 0 && after.length > 0 && (!earlier || (!!leftAt && !future));
  return (
    <div>
      {step(1, "before", tr("I'm here"), before, false)}
      {step(2, "after", tr("I'm leaving: photo of the fix"), after, before.length === 0)}
      {before.length && after.length ? (
        <div className="mt-2">
          <button type="button" onClick={() => { setEarlier(!earlier); if (!lday) setLday(new Date().toLocaleDateString("en-CA")); }}
                  className="mb-1.5 text-[14px] font-semibold text-black/60 underline">
            {earlier ? tr("Now") : tr("Earlier (I forgot)")}
          </button>
          {earlier ? <WhenFields day={lday} time={ltime} setDay={setLday} setTime={setLtime} /> : null}
          {future ? <p className="mt-1 text-base font-semibold text-rose-700">{tr("That time hasn't happened yet.")}</p> : null}
        </div>
      ) : null}
      <button type="button" disabled={!ready || !!busy} onClick={() => void leave()}
              className="mt-2 min-h-12 w-full rounded-xl bg-emerald-600 text-base font-black text-white disabled:opacity-40">
        {busy === "leave" ? <Loader2 className="mx-auto h-5 w-5 animate-spin" /> : tr("Done, I fixed it · I'm leaving")}
      </button>
    </div>
  );
}
