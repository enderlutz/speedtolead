import { Button } from "@/components/ui/button";
import {
  MousePointer2, PenLine, Undo2, Redo2, Trash2, Download,
  FlipHorizontal2, Palette, Plus, Minus, ZoomIn, ZoomOut, Maximize2,
  RotateCcw, RotateCw, FlipHorizontal, FlipVertical, Sparkles,
} from "lucide-react";
import type { ScopeStateApi } from "./use-scope-state";
import { BLUE, RED } from "./constants";

interface Props {
  scope: ScopeStateApi;
  activePointIndex: number | null;
  exporting: boolean;
  onExport: () => void;
  zoom: number;
  zoomIn: () => void;
  zoomOut: () => void;
  fitToPage: () => void;
}

export default function Toolbar({ scope, activePointIndex, exporting, onExport, zoom, zoomIn, zoomOut, fitToPage }: Props) {
  const selected = scope.selectedSegment;

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b bg-background px-2 py-1.5">
      <ToolButton active={scope.mode === "select" && !scope.drawingPoints.length} onClick={() => scope.setMode("select")} title="Select (V)">
        <MousePointer2 className="h-4 w-4" /> Select
      </ToolButton>
      <ToolButton
        active={scope.mode === "blue"}
        onClick={() => scope.startDrawing("blue")}
        title="Blue Fence — inside face only (B)"
        style={{ color: scope.mode === "blue" ? "#fff" : BLUE, background: scope.mode === "blue" ? BLUE : undefined }}
      >
        <PenLine className="h-4 w-4" /> Blue Fence
      </ToolButton>
      <ToolButton
        active={scope.mode === "red"}
        onClick={() => scope.startDrawing("red")}
        title="Red Fence — both sides (R)"
        style={{ color: scope.mode === "red" ? "#fff" : RED, background: scope.mode === "red" ? RED : undefined }}
      >
        <PenLine className="h-4 w-4" /> Red Fence
      </ToolButton>

      {scope.drawingPoints.length > 0 && (
        <>
          <Button size="sm" variant="secondary" onClick={scope.finishDrawing} disabled={scope.drawingPoints.length < 2}>
            Finish (Enter)
          </Button>
          <Button size="sm" variant="ghost" onClick={scope.cancelDrawing}>
            Cancel (Esc)
          </Button>
          <span className="text-[11px] text-muted-foreground">{scope.drawingPoints.length} point{scope.drawingPoints.length === 1 ? "" : "s"} placed — double-click or Enter to finish</span>
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
      <span className="text-[11px] text-muted-foreground mr-0.5">Photo</span>
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
        <Sparkles className="h-3.5 w-3.5" /> {scope.enhanced ? "Enhanced" : "Enhance"}
      </Button>

      <div className="flex-1" />

      {/* Contextual segment toolbar — spec Section 19 */}
      {selected && (
        <div className="flex items-center gap-1.5 rounded border bg-muted/40 px-2 py-1">
          {selected.color === "blue" && (
            <Button size="sm" variant="outline" onClick={() => scope.flipArrows(selected.id)} title="Flip Arrows (F)">
              <FlipHorizontal2 className="h-3.5 w-3.5 mr-1" /> Flip Arrows
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => scope.toggleColor(selected.id)} title="Change Blue / Red">
            <Palette className="h-3.5 w-3.5 mr-1" /> {selected.color === "blue" ? "Make Red" : "Make Blue"}
          </Button>
          <Button
            size="sm" variant="outline"
            onClick={() => scope.addPointToSegment(selected.id, activePointIndex ?? selected.points.length - 2)}
            title="Add Point"
          >
            <Plus className="h-3.5 w-3.5 mr-1" /> Add Point
          </Button>
          <Button
            size="sm" variant="outline"
            disabled={activePointIndex == null}
            onClick={() => { if (activePointIndex != null) scope.removePoint(selected.id, activePointIndex); }}
            title="Remove Point"
          >
            <Minus className="h-3.5 w-3.5 mr-1" /> Remove Point
          </Button>
          <Button size="sm" variant="destructive" onClick={() => scope.deleteSegment(selected.id)} title="Delete this fence path (Delete)">
            <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
          </Button>
        </div>
      )}

      <Button size="sm" onClick={onExport} disabled={exporting || scope.segments.length === 0} title="Export high-resolution PNG">
        <Download className="h-4 w-4 mr-1" /> {exporting ? "Exporting…" : "Export"}
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
