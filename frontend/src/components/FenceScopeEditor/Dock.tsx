// The editor's tools, in one dark dock.
//
// The old toolbar put twenty buttons in a row that wrapped to three on a
// phone and pushed the photo halfway down the screen. Now the dock shows only
// what the moment calls for: the pens while idle, the finish button while a
// run is being traced, and the line's own controls once one is selected.
// Everything about the photo itself lives behind one Photo menu, and the
// rarely-used bits behind "more".
//
// On a desktop the dock floats over the bottom of the canvas; on a phone it
// is a bar beneath it, under the thumb, with the pen labels kept because
// "Inside / Outside / Both" is the whole job.
import {
  MousePointer2, Undo2, Redo2, Trash2, Download, Image as ImageIcon, MoreHorizontal,
  FlipHorizontal2, Plus, Minus, RotateCcw, RotateCw, FlipHorizontal, FlipVertical,
  Sparkles, Plane, Loader2, X, Check, Keyboard, Undo, ArrowLeftRight,
} from "lucide-react";
import type { FenceColor } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ScopeStateApi } from "./use-scope-state";
import { Menu, MenuItem, MenuLabel, MenuRule } from "./Menu";
import { BLUE, GREEN, RED } from "./constants";

interface Props {
  scope: ScopeStateApi;
  activePointIndex: number | null;
  exporting: boolean;
  onExport: () => void;
  hasAi: boolean;
  aiConfigured: boolean;
  rendering: boolean;
  onGenerateAi: () => void;
  onDiscardAi: () => void;
}

const PENS: { color: FenceColor; label: string; hex: string; key: string; hint: string }[] = [
  { color: "blue", label: "Inside", hex: BLUE, key: "B", hint: "Inside face only" },
  { color: "green", label: "Outside", hex: GREEN, key: "G", hint: "Outside face only" },
  { color: "red", label: "Both", hex: RED, key: "R", hint: "Both faces" },
];

const BTN = "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-2 text-xs font-semibold transition active:scale-95 disabled:opacity-35 disabled:active:scale-100 sm:px-2.5";
const IDLE = "text-white/85 hover:bg-white/10";
const GOLD = "bg-gradient-to-r from-gold-light via-gold to-bronze text-ink shadow-md shadow-gold/30 ring-1 ring-gold-light/60 hover:from-gold hover:to-bronze";

function Rule() {
  return <div className="mx-0.5 h-5 w-px shrink-0 bg-white/15" />;
}

function Dot({ hex }: { hex: string }) {
  return <span className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-white/50" style={{ background: hex }} />;
}

export default function Dock({
  scope, activePointIndex, exporting, onExport, hasAi, aiConfigured, rendering, onGenerateAi, onDiscardAi,
}: Props) {
  const selected = scope.selectedSegment;
  const tracing = scope.drawingPoints.length > 0;
  const penDown = scope.mode !== "select";

  // ---- a run in progress: the only thing that matters is finishing it ----
  if (tracing) {
    const n = scope.drawingPoints.length;
    return (
      <Shell>
        <button type="button" onClick={scope.cancelDrawing} className={cn(BTN, IDLE)} title="Throw this run away (Esc)">
          <X className="h-4 w-4" /> Cancel
        </button>
        <button type="button" onClick={scope.undo} className={cn(BTN, IDLE)} title="Take back the last point (Ctrl/Cmd+Z)">
          <Undo className="h-4 w-4" /> <span className="hidden sm:inline">Last point</span>
        </button>
        <span className="shrink-0 px-1 text-[11px] text-white/70 tabular-nums">
          {n} point{n === 1 ? "" : "s"}
          <span className="hidden md:inline"> · tap the last point again to finish</span>
        </span>
        <div className="flex-1" />
        <button
          type="button" onClick={scope.finishDrawing} disabled={n < 2}
          className={cn(BTN, GOLD, "px-3.5")} title="Finish this fence line (Enter)"
        >
          <Check className="h-4 w-4" /> Confirm line
        </button>
      </Shell>
    );
  }

  // ---- a line is selected: its own controls ----
  if (selected && !penDown) {
    const done = () => { scope.selectSegment(null); };
    return (
      <Shell>
        {selected.color !== "red" ? (
          <button type="button" onClick={() => scope.flipArrows(selected.id)} className={cn(BTN, IDLE)} title="Point the arrows at the other face (F)">
            <FlipHorizontal2 className="h-4 w-4" /> <span className="hidden sm:inline">Flip</span> arrows
          </button>
        ) : null}
        <Rule />
        {PENS.filter((p) => p.color !== selected.color).map((p) => (
          <button
            key={p.color} type="button" onClick={() => scope.setColor(selected.id, p.color)}
            className={cn(BTN, IDLE)} title={`Make this ${p.hint.toLowerCase()}`}
          >
            <Dot hex={p.hex} /> {p.label}
          </button>
        ))}
        <Rule />
        <button
          type="button"
          onClick={() => scope.addPointToSegment(selected.id, activePointIndex ?? selected.points.length - 2)}
          className={cn(BTN, IDLE)} title="Add a corner after the selected point"
        >
          <Plus className="h-4 w-4" /> <span className="hidden sm:inline">Point</span>
        </button>
        <button
          type="button" disabled={activePointIndex == null}
          onClick={() => { if (activePointIndex != null) scope.removePoint(selected.id, activePointIndex); }}
          className={cn(BTN, IDLE)} title="Remove the selected point"
        >
          <Minus className="h-4 w-4" /> <span className="hidden sm:inline">Point</span>
        </button>
        <button
          type="button" onClick={() => scope.deleteSegment(selected.id)}
          className={cn(BTN, "text-red-300 hover:bg-red-500/20")} title="Delete this line (Delete)"
        >
          <Trash2 className="h-4 w-4" /> <span className="hidden sm:inline">Delete</span>
        </button>
        <div className="flex-1" />
        <button type="button" onClick={done} className={cn(BTN, "bg-white/15 text-white hover:bg-white/25")} title="Done with this line (Esc)">
          <Check className="h-4 w-4" /> Done
        </button>
      </Shell>
    );
  }

  // ---- idle (or a pen picked, nothing placed yet) ----
  return (
    <Shell>
      <button
        type="button" onClick={() => scope.setMode("select")}
        className={cn(BTN, !penDown ? "bg-white/20 text-white" : IDLE)} title="Select and move lines (V)"
      >
        <MousePointer2 className="h-4 w-4" /> <span className="hidden md:inline">Select</span>
      </button>
      {PENS.map((p) => {
        const on = scope.mode === p.color;
        return (
          <button
            key={p.color} type="button" onClick={() => scope.startDrawing(p.color)}
            className={cn(BTN, on ? "text-white shadow-md" : IDLE)}
            style={on ? { background: p.hex, boxShadow: `0 0 0 1px ${p.hex}, 0 4px 14px ${p.hex}66` } : undefined}
            title={`${p.hint} (${p.key})`}
          >
            {on ? <Check className="h-3.5 w-3.5" /> : <Dot hex={p.hex} />} {p.label}
          </button>
        );
      })}
      {penDown ? (
        <span className="hidden shrink-0 px-1 text-[11px] text-white/70 lg:inline">Tap along the fence</span>
      ) : null}
      <Rule />
      <button type="button" onClick={scope.undo} disabled={!scope.canUndo} className={cn(BTN, IDLE, "px-2")} title="Undo (Ctrl/Cmd+Z)">
        <Undo2 className="h-4 w-4" />
      </button>
      <button type="button" onClick={scope.redo} disabled={!scope.canRedo} className={cn(BTN, IDLE, "hidden px-2 sm:inline-flex")} title="Redo (Ctrl/Cmd+Shift+Z)">
        <Redo2 className="h-4 w-4" />
      </button>
      <Rule />

      <Menu icon={ImageIcon} label="Photo" title="Everything about the photo: brighten, drone view, turn and flip">
        {(close) => (
          <>
            <MenuLabel>Look</MenuLabel>
            <MenuItem
              icon={Sparkles} label={scope.enhanced ? "Brightened" : "Brighten"} checked={scope.enhanced}
              hint="Sharper, brighter, more colour. Free and instant."
              onClick={() => { scope.toggleEnhance(); close(); }}
            />
            {hasAi ? (
              <>
                <MenuItem
                  icon={Plane} label="Drone view" checked={scope.useAi}
                  hint="The photorealistic re-render of the property"
                  onClick={() => { scope.setUseAi(true); close(); }}
                />
                <MenuItem
                  icon={ImageIcon} label="Original screenshot" checked={!scope.useAi}
                  hint="What was uploaded"
                  onClick={() => { scope.setUseAi(false); close(); }}
                />
              </>
            ) : (
              <MenuItem
                icon={rendering ? Loader2 : Plane} label={rendering ? "Rendering… up to a minute" : "Run drone view"}
                disabled={rendering || !aiConfigured}
                hint={aiConfigured ? "Re-renders the screenshot as an overhead drone photo. A few cents." : "Needs an OpenAI key on the server"}
                onClick={() => { onGenerateAi(); close(); }}
              />
            )}
            <MenuLabel>Turn</MenuLabel>
            <MenuItem icon={RotateCcw} label="Turn left" shortcut="[" onClick={() => { scope.rotateBy(-1); close(); }} />
            <MenuItem icon={RotateCw} label="Turn right" shortcut="]" onClick={() => { scope.rotateBy(1); close(); }} />
            <MenuItem icon={FlipHorizontal} label="Mirror left-to-right" shortcut="H" onClick={() => { scope.flip("x"); close(); }} />
            <MenuItem icon={FlipVertical} label="Flip top-to-bottom" shortcut="J" onClick={() => { scope.flip("y"); close(); }} />
            {scope.reoriented ? (
              <MenuItem icon={ArrowLeftRight} label="Put it back" hint="Back to how the property actually sits" onClick={() => { scope.resetOrientation(); close(); }} />
            ) : null}
            {hasAi ? (
              <>
                <MenuRule />
                <MenuItem
                  icon={rendering ? Loader2 : Plane} label={rendering ? "Rendering…" : "Render the drone view again"}
                  disabled={rendering} hint="Costs another render"
                  onClick={() => { onGenerateAi(); close(); }}
                />
                <MenuItem icon={X} label="Discard the drone view" danger hint="Keeps only the original screenshot" onClick={() => { onDiscardAi(); close(); }} />
              </>
            ) : null}
          </>
        )}
      </Menu>

      <Menu icon={MoreHorizontal} title="More" align="right">
        {(close) => (
          <>
            <MenuItem
              icon={Download} label={exporting ? "Exporting…" : "Download as PNG"} disabled={exporting || scope.segments.length === 0}
              hint="A full-size copy, without sending it"
              onClick={() => { onExport(); close(); }}
            />
            <MenuRule />
            <MenuLabel><span className="inline-flex items-center gap-1"><Keyboard className="h-3 w-3" /> Keys</span></MenuLabel>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 px-2.5 pb-2 text-[11px] text-ink/80">
              <span><b>B / G / R</b> pens</span><span><b>V</b> select</span>
              <span><b>Enter</b> finish line</span><span><b>Esc</b> cancel</span>
              <span><b>F</b> flip arrows</span><span><b>Del</b> delete line</span>
              <span><b>[ ]</b> turn photo</span><span><b>H / J</b> mirror / flip</span>
              <span><b>⌘Z</b> undo</span><span><b>⌘S</b> save now</span>
            </div>
          </>
        )}
      </Menu>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-center gap-1 px-1.5 py-1.5",
        // Phone: a bar that scrolls sideways if it must. Desktop: a pill
        // that must NOT clip or filter — its menus pop up out of it, and a
        // backdrop-filter here would pin their full-screen backdrop inside.
        "w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        "bg-gradient-to-r from-stone-900 via-ink to-stone-900 text-white",
        "sm:w-auto sm:max-w-[calc(100vw-2rem)] sm:overflow-visible sm:rounded-2xl sm:shadow-2xl sm:shadow-black/40 sm:ring-1 sm:ring-gold/35",
      )}
    >
      {children}
    </div>
  );
}
