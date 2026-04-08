import { useMemo } from "react";

interface Props {
  zoom: number;
  pdfWidth: number;
  pdfHeight: number;
  scaleX: number;
  scaleY: number;
}

function ticks(pdfSize: number, scale: number, zoom: number) {
  const items: { pos: number; label: string; major: boolean }[] = [];
  const step = 50; // PDF points between major ticks
  const minorStep = 10;

  for (let pt = 0; pt <= pdfSize; pt += minorStep) {
    const px = pt * scale * zoom;
    const major = pt % step === 0;
    items.push({ pos: px, label: major ? String(pt) : "", major });
  }
  return items;
}

export default function Rulers({ zoom, pdfWidth, pdfHeight, scaleX, scaleY }: Props) {
  const hTicks = useMemo(() => ticks(pdfWidth, scaleX, zoom), [pdfWidth, scaleX, zoom]);
  const vTicks = useMemo(() => ticks(pdfHeight, scaleY, zoom), [pdfHeight, scaleY, zoom]);

  return (
    <>
      {/* Horizontal ruler */}
      <div className="absolute top-0 left-[30px] right-0 h-[22px] bg-muted/80 border-b overflow-hidden z-10 pointer-events-none">
        {hTicks.map((t, i) => (
          <div key={i} className="absolute top-0" style={{ left: t.pos }}>
            <div
              className={`bg-muted-foreground/40 ${t.major ? "w-px" : "w-px"}`}
              style={{ height: t.major ? 10 : 5, marginTop: t.major ? 0 : 5 }}
            />
            {t.label && (
              <span className="absolute top-0 left-1 text-[7px] text-muted-foreground select-none">
                {t.label}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Vertical ruler */}
      <div className="absolute top-[22px] left-0 bottom-0 w-[30px] bg-muted/80 border-r overflow-hidden z-10 pointer-events-none">
        {vTicks.map((t, i) => (
          <div key={i} className="absolute left-0" style={{ top: t.pos }}>
            <div
              className="bg-muted-foreground/40"
              style={{
                width: t.major ? 10 : 5,
                height: 1,
                marginLeft: t.major ? 0 : 5,
              }}
            />
            {t.label && (
              <span
                className="absolute left-1 text-[7px] text-muted-foreground select-none"
                style={{ top: 2 }}
              >
                {t.label}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Corner */}
      <div className="absolute top-0 left-0 w-[30px] h-[22px] bg-muted/80 border-b border-r z-20" />
    </>
  );
}
