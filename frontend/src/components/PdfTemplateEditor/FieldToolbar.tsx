import { useDraggable } from "@dnd-kit/core";
import { PRESET_FIELDS, PRESET_FIELD_LABELS, PRESET_FIELD_COLORS } from "@/lib/pdf-types";
import type { EditorField } from "./use-editor-state";
import { GripVertical, Lock, Unlock } from "lucide-react";

interface Props {
  fields: EditorField[];
  selectedId: string | null;
  usedPresets: Set<string>;
  onSelect: (id: string) => void;
  onNavigate: (page: number) => void;
  onToggleLock: (id: string) => void;
}

function DraggableFieldItem({ fieldKey, label, color }: { fieldKey: string; label: string; color: string }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `toolbar-${fieldKey}`,
    data: { fieldKey, label },
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`flex items-center gap-2 px-2.5 py-2 rounded-md text-sm cursor-grab active:cursor-grabbing hover:bg-muted transition-colors ${isDragging ? "opacity-40" : ""}`}
    >
      <GripVertical className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
      <span className="truncate text-xs font-medium">{label}</span>
    </div>
  );
}

export default function FieldToolbar({
  fields, selectedId, usedPresets, onSelect, onNavigate, onToggleLock,
}: Props) {
  const availablePresets = PRESET_FIELDS.filter((k) => !usedPresets.has(k));

  return (
    <div className="w-full h-full border-r overflow-y-auto bg-background">
      {/* Available fields to drag */}
      {availablePresets.length > 0 && (
        <div className="p-3 border-b">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Drag to place
          </p>
          <div className="space-y-0.5">
            {availablePresets.map((key) => (
              <DraggableFieldItem
                key={key}
                fieldKey={key}
                label={PRESET_FIELD_LABELS[key]}
                color={PRESET_FIELD_COLORS[key]}
              />
            ))}
          </div>
        </div>
      )}

      {/* Placed fields */}
      <div className="p-3">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Placed ({fields.length})
        </p>
        <div className="space-y-0.5">
          {fields.map((f) => (
            <button
              key={f.id}
              onClick={() => { onSelect(f.id); onNavigate(f.page); }}
              className={`w-full text-left px-2.5 py-1.5 rounded-md text-xs flex items-center gap-2 transition-colors group ${
                f.id === selectedId ? "bg-primary/10 text-primary" : "hover:bg-muted"
              }`}
            >
              <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: f.color }} />
              <span className="truncate flex-1">{f.label}</span>
              <button
                onClick={(e) => { e.stopPropagation(); onToggleLock(f.id); }}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted-foreground/10"
                title={f.locked ? "Unlock" : "Lock"}
              >
                {f.locked ? <Lock className="h-3 w-3 text-amber-500" /> : <Unlock className="h-3 w-3 text-muted-foreground" />}
              </button>
              <span className="text-[10px] text-muted-foreground shrink-0">p{f.page + 1}</span>
            </button>
          ))}
          {fields.length === 0 && (
            <p className="text-xs text-muted-foreground py-4 text-center">
              Drag fields from above onto the PDF
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
