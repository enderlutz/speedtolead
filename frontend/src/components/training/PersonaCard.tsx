import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export type Persona = {
  id: string;
  name: string;
  headline: string;
  age: number;
  gender: string;
  location: string;
  fence_context: string;
  default_mood: string;
  traits: string[];
  source: string;
};

export default function PersonaCard({
  persona,
  onPick,
}: {
  persona: Persona;
  onPick: () => void;
}) {
  const initials = (persona.name || "??")
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const moodColor =
    persona.default_mood === "skeptical"
      ? "bg-amber-500/10 text-amber-600 border-amber-500/30"
      : persona.default_mood === "busy"
      ? "bg-rose-500/10 text-rose-600 border-rose-500/30"
      : "bg-emerald-500/10 text-emerald-600 border-emerald-500/30";

  return (
    <Card
      onClick={onPick}
      className="cursor-pointer hover:border-primary/50 hover:shadow-lg transition-all duration-150"
    >
      <CardContent className="p-5">
        <div className="flex items-start gap-3 mb-3">
          <div className="h-12 w-12 shrink-0 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/20 flex items-center justify-center text-sm font-bold text-primary">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold leading-tight">{persona.name}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {persona.age} · {persona.location}
            </p>
          </div>
          <Badge variant="outline" className={`text-[10px] uppercase tracking-wide ${moodColor}`}>
            {persona.default_mood}
          </Badge>
        </div>

        <p className="text-xs text-muted-foreground italic mb-3 line-clamp-2">
          {persona.headline}
        </p>

        <p className="text-[11px] text-muted-foreground line-clamp-2 mb-3">
          {persona.fence_context}
        </p>

        <div className="flex flex-wrap gap-1">
          {persona.traits.slice(0, 3).map((t) => (
            <Badge key={t} variant="secondary" className="text-[10px] font-normal">
              {t}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
