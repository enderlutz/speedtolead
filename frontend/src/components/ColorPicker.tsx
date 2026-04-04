import { useState, useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";

const PRESETS = [
  "#2B2B2B", "#000000", "#1e3a5f", "#991b1b",
  "#166534", "#1e40af", "#6b21a8", "#92400e",
  "#ffffff", "#64748b", "#0ea5e9", "#f59e0b",
];

interface ColorPickerProps {
  value: string;
  onChange: (color: string) => void;
}

export default function ColorPicker({ value, onChange }: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const [hex, setHex] = useState(value);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setHex(value), [value]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleHexChange = (v: string) => {
    setHex(v);
    if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-input hover:bg-muted/50 transition-colors w-full"
      >
        <span
          className="h-4 w-4 rounded border border-black/10 shrink-0"
          style={{ backgroundColor: value }}
        />
        <span className="text-xs font-mono text-muted-foreground">{value}</span>
      </button>

      {open && (
        <div className="absolute z-50 top-full mt-1 left-0 bg-popover border rounded-lg shadow-lg p-3 w-52">
          <div className="grid grid-cols-6 gap-1.5 mb-3">
            {PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => { onChange(c); setHex(c); }}
                className={`h-6 w-6 rounded border transition-transform hover:scale-110 ${
                  value === c ? "ring-2 ring-primary ring-offset-1" : "border-black/10"
                }`}
                style={{ backgroundColor: c }}
                title={c}
              />
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className="h-7 w-7 rounded border border-black/10 shrink-0"
              style={{ backgroundColor: /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : value }}
            />
            <Input
              value={hex}
              onChange={(e) => handleHexChange(e.target.value)}
              placeholder="#2B2B2B"
              className="h-7 text-xs font-mono"
            />
          </div>
        </div>
      )}
    </div>
  );
}
