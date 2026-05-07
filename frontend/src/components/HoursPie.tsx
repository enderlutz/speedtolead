import { useMemo } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from "recharts";

const PALETTE = [
  "#3b82f6", // blue
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#10b981", // emerald
  "#ef4444", // red
  "#ec4899", // pink
  "#14b8a6", // teal
  "#f97316", // orange
  "#6366f1", // indigo
  "#84cc16", // lime
];

export interface PieSlice {
  name: string;
  hours: number;
}

interface Props {
  data: PieSlice[];
  /** Label under the center total. e.g. "today" or "total" */
  centerSubtitle?: string;
  /** Height in pixels (chart area). Default 200. */
  height?: number;
}

/**
 * Donut chart of hours grouped by some key (customer, task, employee, etc.).
 * Returns null if there's no data — caller decides what to render in that case.
 */
export default function HoursPie({ data, centerSubtitle, height = 200 }: Props) {
  const total = useMemo(() => data.reduce((a, d) => a + d.hours, 0), [data]);

  if (data.length === 0 || total <= 0) return null;

  return (
    <div className="relative w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="hours"
            nameKey="name"
            cx="50%"
            cy="50%"
            innerRadius="55%"
            outerRadius="85%"
            paddingAngle={data.length > 1 ? 2 : 0}
            stroke="none"
          >
            {data.map((_, i) => (
              <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
            ))}
          </Pie>
          <Tooltip
            formatter={(value, name) => {
              const v = typeof value === "number" ? value : 0;
              const pct = total > 0 ? ((v / total) * 100).toFixed(0) : "0";
              return [`${v.toFixed(2)}h (${pct}%)`, name];
            }}
            contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))" }}
          />
          <Legend
            verticalAlign="bottom"
            height={28}
            iconSize={8}
            formatter={(value: string, _entry, idx) => {
              const slice = data[idx ?? 0];
              const pct = slice && total > 0 ? Math.round((slice.hours / total) * 100) : 0;
              return (
                <span style={{ fontSize: 11, color: "hsl(var(--foreground))" }}>
                  {value} <span style={{ color: "hsl(var(--muted-foreground))" }}>· {pct}%</span>
                </span>
              );
            }}
            wrapperStyle={{ fontSize: 11 }}
          />
        </PieChart>
      </ResponsiveContainer>
      {/* Center label */}
      <div
        className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
        style={{ paddingBottom: 28 }}
      >
        <p className="text-xl font-bold leading-none">{total.toFixed(1)}h</p>
        {centerSubtitle && (
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide mt-0.5">
            {centerSubtitle}
          </p>
        )}
      </div>
    </div>
  );
}
