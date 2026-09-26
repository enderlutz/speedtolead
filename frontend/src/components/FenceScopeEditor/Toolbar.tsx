import { Button } from "@/components/ui/button";
import {
  MousePointer2, PenLine, Undo2, Redo2, Trash2, Download,
  FlipHorizontal2, Palette, Plus, Minus, ZoomIn, ZoomOut, Maximize2,
  RotateCcw, RotateCw, FlipHorizontal, FlipVertical, Sparkles, Plane, Loader2, X, Check, Send,
} from "lucide-react";
import type { ScopeStateApi } from "./use-scope-state";
import { BLUE, GREEN, RED } from "./constants";

interface Props {
  scope: ScopeStateApi;
  activePointIndex: number | null;
  exporting: boolean;
  onExport: () => void;
  zoom: number;
  zoomIn: () => void;
  zoomOut: () => void;
  fitToPage: () => void;
  hasAi: boolean;
  aiConfigured: boolean;
  rendering: boolean;
  onGenerateAi: () => void;
  onDiscardAi: () => void;
  onSend: () => void;
  /** Non-null when a step is outstanding; doubles as the tooltip. */
  sendBlockedReason: string | null;
}

export default function Toolbar({
  scope, activePointIndex, exporting, onExport, zoom, zoomIn, zoomOut, fitToPage,
  hasAi, aiConfigured, rendering, onGenerateAi, onDiscardAi, onSend, sendBlockedReason,
}: Props) {
  const selected = scope.selectedSegment;

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b bg-background px-2 py-1.5 min-w-0">
      <ToolButton active={scope.mode === "select" && !scope.drawingPoints.length} onClick={() => scope.setMode("select")} title="Select (V)">
        <MousePointer2 className="h-4 w-4" /> <span className="hidden sm:inline">Select</span>
      </ToolButton>
      <ToolButton
        active={scope.mode === "blue"}
        onClick={() => scope.startDrawing("blue")}
        title="Blue Fence — inside face only (B)"
        style={{ color: scope.mode === "blue" ? "#fff" : BLUE, background: scope.mode === "blue" ? BLUE : undefined }}
      >
        <PenLine className="h-4 w-4" /> <span className="hidden sm:inline">Blue Fence</span>
      </ToolButton>
      <ToolButton
        active={scope.mode === "green"}
        onClick={() => scope.startDrawing("green")}
        title="Green Fence — outside face only (G)"
        style={{ color: scope.mode === "green" ? "#fff" : GREEN, background: scope.mode === "green" ? GREEN : undefined }}
      >
        <PenLine className="h-4 w-4" /> <span className="hidden sm:inline">Green Fence</span>
      </ToolButton>
      <ToolButton
        active={scope.mode === "red"}
        onClick={() => scope.startDrawing("red")}
        title="Red Fence — both sides (R)"
        style={{ color: scope.mode === "red" ? "#fff" : RED, background: scope.mode === "red" ? RED : undefined }}
      >
        <PenLine className="h-4 w-4" /> <span className="hidden sm:inline">Red Fence</span>
      </ToolButton>

      {scope.drawingPoints.length > 0 && (
        <>
          {/* The one button that ends a run. Prominent on purpose: it's the
              step between drawing a line and being able to adjust it. */}
          <Button size="sm" onClick={scope.finishDrawing} disabled={scope.drawingPoints.length < 2} title="Confirm this fence line (Enter)">
            <Check className="h-4 w-4 mr-1" /> Confirm
          </Button>
          <Button size="sm" variant="ghost" onClick={scope.cancelDrawing}>
            Cancel<span className="hidden sm:inline">&nbsp;(Esc)</span>
          </Button>
          <span className="text-[11px] text-muted-foreground">
            {scope.drawingPoints.length} point{scope.drawingPoints.length === 1 ? "" : "s"}
            <span className="hidden sm:inline"> — press Confirm, or click the last point again</span>
          </span>
        </>
      )}

      <div className="w-px h-5 bg-border mx-1" />

      <Button size="icon" variant="ghost" className="h-8 w-8" disabled={!scope.canUndo} onClick={scope.undo} title="Undo (Ctrl/Cmd+Z)">
        <Undo2 className="h-4 w-4" />
      </Button>
      <Button size="icon" variant="ghost" className="h-8 w-8" disabled={!scope.canRedo} onClick={scope.redo} title="Redo (Ctrl/Cmd+Shift+Z)">
        <Redo2 className="h-4 w-4" />
      </Button>

      <div className="w-px h-5 bg-border mx-1" />
      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={zoomOut} title="Zoom out">
        <ZoomOut className="h-4 w-4" />
      </Button>
      <span className="text-[11px] tabular-nums text-muted-foreground w-9 text-center">{Math.round(zoom * 100)}%</span>
      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={zoomIn} title="Zoom in">
        <ZoomIn className="h-4 w-4" />
      </Button>
      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={fitToPage} title="Fit to view — resets zoom and re-centers">
        <Maximize2 className="h-4 w-4" />
      </Button>

      <div className="w-px h-5 bg-border mx-1" />
      {/* Re-orients the photo only — the header, logo and address stay
          upright. Any traced fence moves with it. */}
      <span className="hidden sm:inline text-[11px] text-muted-foreground mr-0.5">Photo</span>
      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => scope.rotateBy(-1)} title="Turn the photo left 90° ( [ )">
        <RotateCcw className="h-4 w-4" />
      </Button>
      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => scope.rotateBy(1)} title="Turn the photo right 90° ( ] )">
        <RotateCw className="h-4 w-4" />
      </Button>
      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => scope.flip("x")} title="Mirror the photo left-to-right (H)">
        <FlipHorizontal className="h-4 w-4" />
      </Button>
      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => scope.flip("y")} title="Flip the photo top-to-bottom (J)">
        <FlipVertical className="h-4 w-4" />
      </Button>
      <Button
        size="sm"
        variant={scope.enhanced ? "default" : "outline"}
        onClick={scope.toggleEnhance}
        title="Sharpen the photo and lift its contrast and colour. Click again to go back to the original."
        className="gap-1.5"
      >
        <Sparkles className="h-3.5 w-3.5" /> <span className="hidden sm:inline">{scope.enhanced ? "Enhanced" : "Enhance"}</span>
      </Button>

      {/* Drone view — a paid OpenAI re-render. The original screenshot is kept
          and stays one click away, because the re-render is the model's
          interpretation of the property, not a photograph of it. */}
      {hasAi ? (
        <div className="flex items-center gap-1 rounded border bg-muted/40 px-1.5 py-0.5">
          <span className="text-[11px] text-muted-foreground">Photo:</span>
          <Button
            size="sm" variant={scope.useAi ? "ghost" : "default"} className="h-6 px-2 text-[11px]"
            onClick={() => scope.setUseAi(false)} title="Show the screenshot you uploaded"
          >
            Original
          </Button>
          <Button
            size="sm" variant={scope.useAi ? "default" : "ghost"} className="h-6 px-2 text-[11px]"
            onClick={() => scope.setUseAi(true)} title="Show the photorealistic drone re-render"
          >
            Drone
          </Button>
          <Button
            size="sm" variant="ghost" className="h-6 px-1.5" disabled={rendering}
            onClick={onGenerateAi} title="Render it again — costs another API call"
          >
            {rendering ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plane className="h-3 w-3" />}
          </Button>
          <Button
            size="sm" variant="ghost" className="h-6 px-1.5 text-destructive"
            onClick={onDiscardAi} title="Delete the drone re-render and keep only the original"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ) : (
        <Button
          size="sm" variant="outline" className="gap-1.5" disabled={rendering || !aiConfigured}
          onClick={onGenerateAi}
          title={
            aiConfigured
              ? "Re-render the screenshot as a photorealistic overhead drone photo. Takes up to a minute and costs a few cents per render. Your original screenshot is kept."
              : "Needs an OpenAI API key (OPENAI_API_KEY) on the server. A ChatGPT subscription does not cover this — the API bills separately."
          }
        >
          {rendering ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plane className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">{rendering ? "Rendering…" : "Drone View"}</span>
        </Button>
      )}

      <div className="flex-1" />

      {/* Contextual segment toolbar — spec Section 19 */}
      {selected && (
        <div className="flex items-center gap-1.5 rounded border bg-muted/40 px-2 py-1">
          {selected.color !== "red" && (
            <Button size="sm" variant="outline" onClick={() => scope.flipArrows(selected.id)} title="Flip Arrows (F)">
              <FlipHorizontal2 className="h-3.5 w-3.5 mr-1" /> Flip Arrows
            </Button>
          )}
          {(["blue", "green", "red"] as const)
            .filter((c) => c !== selected.color)
            .map((c) => (
              <Button
                key={c} size="sm" variant="outline" className="px-2"
                onClick={() => scope.setColor(selected.id, c)}
                title={c === "blue" ? "Inside face only" : c === "green" ? "Outside face only" : "Both faces"}
              >
                <Palette className="h-3.5 w-3.5 mr-1" style={{ color: c === "blue" ? BLUE : c === "green" ? GREEN : RED }} />
                {c === "blue" ? "Inside" : c === "green" ? "Outside" : "Both"}
              </Button>
            ))}
          <Button
            size="sm" variant="outline"
            onClick={() => scope.addPointToSegment(selected.id, activePointIndex ?? selected.points.length - 2)}
            title="Add Point"
          >
            <Plus className="h-3.5 w-3.5 sm:mr-1" /> <span className="hidden sm:inline">Add Point</span>
          </Button>
          <Button
            size="sm" variant="outline"
            disabled={activePointIndex == null}
            onClick={() => { if (activePointIndex != null) scope.removePoint(selected.id, activePointIndex); }}
            title="Remove Point"
          >
            <Minus className="h-3.5 w-3.5 sm:mr-1" /> <span className="hidden sm:inline">Remove Point</span>
          </Button>
          <Button size="sm" variant="destructive" onClick={() => scope.deleteSegment(selected.id)} title="Delete this fence path (Delete)">
            <Trash2 className="h-3.5 w-3.5 sm:mr-1" /> <span className="hidden sm:inline">Delete</span>
          </Button>
        </div>
      )}

      <Button size="sm" variant="outline" onClick={onExport} disabled={exporting || scope.segments.length === 0}
              title="Save a high-resolution PNG of the scope without sending it">
        <Download className="h-4 w-4 sm:mr-1" /> <span className="hidden sm:inline">{exporting ? "Exporting…" : "Export"}</span>
      </Button>
      {/* Saves the current canvas first, then asks who it's going to — so the
          customer always gets what's on screen, not an older export. */}
      <Button size="sm" onClick={onSend} disabled={exporting || !!sendBlockedReason}
              title={sendBlockedReason || "Text this scope to the customer"}>
        <Send className="h-4 w-4 sm:mr-1" /> <span className="hidden sm:inline">Send</span>
      </Button>
    </div>
  );
}

function ToolButton({
  active, onClick, title, children, style,
}: { active: boolean; onClick: () => void; title: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <Button size="sm" variant={active ? "default" : "outline"} onClick={onClick} title={title} style={style} className="gap-1.5">
      {children}
    </Button>
  );
}
