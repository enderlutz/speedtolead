import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { X, Phone } from "lucide-react";
import type { Persona } from "./PersonaCard";
import type { TrainingMood } from "@/lib/api";

type Props = {
  persona: Persona;
  moods: TrainingMood[];
  onStart: (mood: string) => void;
  onCancel: () => void;
};

export default function MoodPicker({ persona, moods, onStart, onCancel }: Props) {
  const allowed = new Set(persona.available_moods || moods.map((m) => m.id));
  const visible = moods.filter((m) => allowed.has(m.id));
  const [selected, setSelected] = useState<string>(persona.default_mood);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <Card
        className="w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <CardContent className="p-6">
          <div className="flex items-start justify-between mb-4">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground mb-0.5">
                Calling
              </p>
              <h2 className="text-lg font-semibold leading-tight">{persona.name}</h2>
              <p className="text-xs text-muted-foreground mt-0.5">{persona.headline}</p>
            </div>
            <button
              onClick={onCancel}
              className="p-1 rounded hover:bg-muted text-muted-foreground"
              aria-label="Cancel"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <p className="text-xs text-muted-foreground italic mb-5 border-l-2 border-primary/30 pl-3 py-1">
            {persona.fence_context}
          </p>

          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            What kind of day is {persona.name.split(" ")[0]} having?
          </p>
          <div className="space-y-2 mb-5">
            {visible.map((mood) => {
              const isSelected = selected === mood.id;
              const isDefault = persona.default_mood === mood.id;
              return (
                <button
                  key={mood.id}
                  onClick={() => setSelected(mood.id)}
                  className={`w-full text-left rounded-lg border px-4 py-3 transition-all ${
                    isSelected
                      ? "border-primary bg-primary/10 ring-1 ring-primary"
                      : "border-border hover:border-primary/40 hover:bg-muted/50"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{mood.label}</span>
                        {isDefault && (
                          <Badge variant="secondary" className="text-[10px] font-normal">
                            default
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{mood.subtitle}</p>
                    </div>
                    <div
                      className={`h-4 w-4 rounded-full border-2 shrink-0 ${
                        isSelected ? "border-primary bg-primary" : "border-muted-foreground/40"
                      }`}
                    />
                  </div>
                </button>
              );
            })}
          </div>

          <Button onClick={() => onStart(selected)} className="w-full" size="lg">
            <Phone className="h-4 w-4 mr-2" />
            Start the call
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
