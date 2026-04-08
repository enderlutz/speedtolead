import type { EditorField } from "./use-editor-state";
import ColorPicker from "@/components/ColorPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Trash2, Copy, Lock, Unlock } from "lucide-react";

interface Props {
  selected: EditorField | null;
  pageCount: number;
  previewMode: boolean;
  onUpdate: (id: string, updates: Partial<EditorField>) => void;
  onUpdateSilent: (id: string, updates: Partial<EditorField>) => void;
  onCommit: () => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onToggleLock: (id: string) => void;
  onTogglePreview: () => void;
}

export default function PropertiesPanel({
  selected, pageCount, previewMode,
  onUpdate, onUpdateSilent, onCommit, onDelete, onDuplicate, onToggleLock, onTogglePreview,
}: Props) {
  return (
    <div className="w-full h-full border-l overflow-y-auto bg-background p-3 space-y-4">
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Properties</p>

      {selected ? (
        <div className="space-y-3">
          {/* Label */}
          <div>
            <label className="text-[10px] font-medium text-muted-foreground mb-1 block">Field</label>
            <p className="text-sm font-semibold">{selected.label}</p>
          </div>

          {/* Font Size — live preview */}
          <div>
            <label className="text-[10px] font-medium text-muted-foreground mb-1 block">Font Size</label>
            <div className="flex items-center gap-2">
              <input
                type="range" min={8} max={80}
                value={selected.font_size}
                onChange={(e) => onUpdateSilent(selected.id, { font_size: Number(e.target.value) })}
                onMouseUp={() => onCommit()}
                onTouchEnd={() => onCommit()}
                className="flex-1"
              />
              <Input
                type="number" min={8} max={80}
                value={selected.font_size}
                onChange={(e) => onUpdate(selected.id, { font_size: Number(e.target.value) || 14 })}
                className="h-7 w-14 text-xs text-center"
              />
            </div>
          </div>

          {/* Color */}
          <div>
            <label className="text-[10px] font-medium text-muted-foreground mb-1 block">Color</label>
            <ColorPicker value={selected.color} onChange={(c) => onUpdate(selected.id, { color: c })} />
          </div>

          {/* Width */}
          <div>
            <label className="text-[10px] font-medium text-muted-foreground mb-1 block">Box Width</label>
            <div className="flex items-center gap-2">
              <input
                type="range" min={0} max={500}
                value={selected.width || 0}
                onChange={(e) => onUpdateSilent(selected.id, { width: Number(e.target.value) })}
                onMouseUp={() => onCommit()}
                onTouchEnd={() => onCommit()}
                className="flex-1"
              />
              <Input
                type="number" min={0} max={500}
                value={selected.width || 0}
                onChange={(e) => onUpdate(selected.id, { width: Number(e.target.value) || 0 })}
                className="h-7 w-14 text-xs text-center"
              />
            </div>
            <p className="text-[9px] text-muted-foreground mt-0.5">0 = left-aligned, {">"}0 = centered in box</p>
          </div>

          {/* Position */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] font-medium text-muted-foreground mb-1 block">X</label>
              <Input
                type="number"
                value={Math.round(selected.x)}
                onChange={(e) => onUpdate(selected.id, { x: Number(e.target.value) })}
                className="h-7 text-xs"
              />
            </div>
            <div>
              <label className="text-[10px] font-medium text-muted-foreground mb-1 block">Y</label>
              <Input
                type="number"
                value={Math.round(selected.y)}
                onChange={(e) => onUpdate(selected.id, { y: Number(e.target.value) })}
                className="h-7 text-xs"
              />
            </div>
          </div>

          {/* Page */}
          <div>
            <label className="text-[10px] font-medium text-muted-foreground mb-1 block">Page</label>
            <select
              className="w-full border border-input rounded-md px-2 py-1 text-xs bg-background"
              value={selected.page}
              onChange={(e) => onUpdate(selected.id, { page: Number(e.target.value) })}
            >
              {Array.from({ length: pageCount }, (_, i) => (
                <option key={i} value={i}>Page {i + 1}</option>
              ))}
            </select>
          </div>

          {/* Actions */}
          <div className="flex gap-1.5">
            <Button
              variant="outline" size="sm" className="flex-1"
              onClick={() => onToggleLock(selected.id)}
            >
              {selected.locked ? <Lock className="h-3.5 w-3.5 mr-1" /> : <Unlock className="h-3.5 w-3.5 mr-1" />}
              {selected.locked ? "Unlock" : "Lock"}
            </Button>
            <Button
              variant="outline" size="sm" className="flex-1"
              onClick={() => onDuplicate(selected.id)}
            >
              <Copy className="h-3.5 w-3.5 mr-1" /> Copy
            </Button>
          </div>
          <Button
            variant="destructive" size="sm" className="w-full"
            onClick={() => onDelete(selected.id)}
            disabled={selected.locked}
          >
            <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground py-4 text-center">
          Select a field to edit its properties, or drag one from the left panel onto the PDF.
        </p>
      )}

      {/* Preview toggle */}
      <div className="pt-3 border-t">
        <label className="flex items-center gap-2 text-xs cursor-pointer">
          <input
            type="checkbox"
            checked={previewMode}
            onChange={onTogglePreview}
            className="rounded"
          />
          Preview with sample data
        </label>
        <p className="text-[9px] text-muted-foreground mt-1">
          Shows example text at actual size and color
        </p>
      </div>

      {/* Keyboard shortcuts */}
      <div className="pt-3 border-t">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Shortcuts</p>
        <div className="space-y-0.5 text-[9px] text-muted-foreground">
          <p><kbd className="px-1 py-0.5 bg-muted rounded text-[8px]">Arrow</kbd> Nudge 1px</p>
          <p><kbd className="px-1 py-0.5 bg-muted rounded text-[8px]">Shift+Arrow</kbd> Nudge 10px</p>
          <p><kbd className="px-1 py-0.5 bg-muted rounded text-[8px]">Ctrl+Z</kbd> Undo</p>
          <p><kbd className="px-1 py-0.5 bg-muted rounded text-[8px]">Ctrl+Shift+Z</kbd> Redo</p>
          <p><kbd className="px-1 py-0.5 bg-muted rounded text-[8px]">Ctrl+D</kbd> Duplicate</p>
          <p><kbd className="px-1 py-0.5 bg-muted rounded text-[8px]">Ctrl+L</kbd> Lock/Unlock</p>
          <p><kbd className="px-1 py-0.5 bg-muted rounded text-[8px]">Ctrl+S</kbd> Save</p>
          <p><kbd className="px-1 py-0.5 bg-muted rounded text-[8px]">Del</kbd> Delete field</p>
        </div>
      </div>
    </div>
  );
}
