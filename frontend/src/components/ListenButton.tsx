// Listen button (2026-11-11): reads the customer's name and address out loud
// before a VA dials, so names and street names come out right. "Missus Doe"
// when we know the label, else the first name; then the address the way an
// American says it. The pencil lets staff type how it should sound
// ("ek-PEN-yong"); that replaces the name or address part.
//
// The voice is ElevenLabs (GET /api/leads/{id}/say). No voice → the
// browser's own en-US voice reads the same words, a bit slow.
// iPhone Safari: the Audio element is made and started inside the tap, then
// pointed at the blob URL once it arrives.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, Pencil, Volume2, X } from "lucide-react";
import { api, getCurrentUser, type SayText } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { cn, errMessage } from "@/lib/utils";

/** A tiny silent WAV, played inside the tap so iOS lets the real audio play after the fetch. */
function silentWav(): string {
  const samples = 80;
  const buf = new Uint8Array(44 + samples);
  const dv = new DataView(buf.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  w(0, "RIFF"); dv.setUint32(4, 36 + samples, true); w(8, "WAVE"); w(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
  w(36, "data"); dv.setUint32(40, samples, true);
  buf.fill(128, 44);
  let bin = "";
  buf.forEach((b) => { bin += String.fromCharCode(b); });
  return `data:audio/wav;base64,${btoa(bin)}`;
}
let SILENT: string | null = null;

// Only one voice at a time on the whole page (Alan, 2026-11-11: two taps
// played on top of each other). Every tap stops whatever is playing first.
let PLAYING: HTMLAudioElement | null = null;
function stopAll() {
  if (PLAYING) { PLAYING.pause(); PLAYING.currentTime = 0; PLAYING = null; }
  if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
}
function playUrl(url: string) {
  stopAll();
  const a = new Audio(url);
  PLAYING = a;
  void a.play().catch(() => {});
}

function speakWithBrowser(text: string): boolean {
  if (typeof window === "undefined" || !("speechSynthesis" in window) || !text) return false;
  const synth = window.speechSynthesis;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  u.rate = 0.85;
  const voice = synth.getVoices().find((v) => v.lang === "en-US" && v.localService)
    || synth.getVoices().find((v) => v.lang?.startsWith("en-US"));
  if (voice) u.voice = voice;
  synth.speak(u);
  return true;
}

export function ListenButton({ leadId, className, label = "Listen" }: { leadId: string; className?: string; label?: string }) {
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [info, setInfo] = useState<SayText | null>(null);
  const [sayName, setSayName] = useState("");
  const [sayAddress, setSayAddress] = useState("");
  const audioUrl = useRef<string | null>(null);   // the cached mp3 for replays
  const fallbackText = useRef<string | null>(null); // set once we know there's no voice
  const role = getCurrentUser()?.role;
  const staff = role === "admin" || role === "va";

  const forget = () => {
    if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
    audioUrl.current = null;
    fallbackText.current = null;
  };
  useEffect(() => forget, [leadId]);

  const listen = async () => {
    // Replays: straight from the tap, no network. Each tap restarts it.
    if (audioUrl.current) { playUrl(audioUrl.current); return; }
    if (fallbackText.current) { stopAll(); speakWithBrowser(fallbackText.current); return; }
    if (loading) return;
    stopAll();
    const audio = new Audio();
    PLAYING = audio;
    audio.src = SILENT ||= silentWav();
    void audio.play().catch(() => {});
    setLoading(true);
    try {
      const url = await api.fetchSayAudioUrl(leadId).catch(() => null);
      if (url) {
        audioUrl.current = url;
        if (PLAYING !== audio) return; // another button took over while this loaded
        audio.pause();
        audio.src = url;
        await audio.play().catch(() => playUrl(url));
        return;
      }
      const t = await api.sayText(leadId);
      setInfo(t);
      if (!t.text) { toast.error("No name or address to read yet"); return; }
      fallbackText.current = t.text;
      if (!speakWithBrowser(t.text)) toast.error("This phone can't read out loud");
    } catch (e) {
      toast.error(errMessage(e, "Couldn't read it out loud"));
    } finally {
      setLoading(false);
    }
  };

  const openEditor = async () => {
    setEditing(true);
    try {
      const t = info || await api.sayText(leadId);
      setInfo(t); setSayName(t.say_name); setSayAddress(t.say_address);
    } catch (e) { toast.error(errMessage(e, "Couldn't load")); }
  };

  const save = async () => {
    setSaving(true);
    try {
      const t = await api.saveSayIt(leadId, { say_name: sayName, say_address: sayAddress });
      setInfo(t); forget(); setEditing(false);
      toast.success("Saved. Tap Listen to hear it.");
    } catch (e) { toast.error(errMessage(e, "Couldn't save")); }
    finally { setSaving(false); }
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <button
        type="button"
        onClick={listen}
        aria-label="Listen to the name and address"
        title="Hear how to say the name and address"
        className="inline-flex min-h-11 touch-manipulation items-center gap-1.5 rounded-lg border bg-background px-3 text-sm font-semibold hover:bg-muted"
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Volume2 className="h-4 w-4" />}
        {label}
      </button>
      {staff ? (
        <button
          type="button"
          onClick={() => (editing ? setEditing(false) : void openEditor())}
          aria-label="Change how it's said"
          title="Type how the name or address should sound"
          className="inline-flex h-11 w-11 touch-manipulation items-center justify-center rounded-lg border bg-background text-muted-foreground hover:bg-muted"
        >
          {editing ? <X className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
        </button>
      ) : null}
      {editing && staff ? (
        <div className="basis-full space-y-2 rounded-lg border bg-muted/30 p-3 text-sm">
          <label className="block space-y-1">
            <span className="font-medium">Say the name like</span>
            <Input className="h-11 text-base" value={sayName} placeholder={info?.name ? `Now: ${info.name}` : "e.g. ek-PEN-yong"}
              onChange={(e) => setSayName(e.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className="font-medium">Say the address like</span>
            <Input className="h-11 text-base" value={sayAddress} placeholder={info?.address ? `Now: ${info.address}` : "e.g. twenty-three oh ten Oak Ridge Lane"}
              onChange={(e) => setSayAddress(e.target.value)} />
          </label>
          <p className="text-sm text-muted-foreground">Leave a box empty to use the normal reading.</p>
          <button type="button" onClick={save} disabled={saving}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-60">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default ListenButton;
