// The key the customer reads, in its own band under the photo.
//
// It used to float over the picture, which meant it landed on whatever was in
// that corner — on one scope it covered a neighbour's roof and part of the
// fence line it was there to explain. A dedicated band can't collide with
// anything.
//
// The swatches are drawn with the same line weights, colours and arrowheads as
// the marks on the photo. A key that only approximated them would be worse
// than no key at all. Only colours actually present get a row, and unmarked
// fence is never mentioned — spec Sections 6 and 32.

import { Fragment } from "react";
import { Layer, Rect, Line, Text as KonvaText } from "react-konva";
import type { FenceScopeSegment } from "@/lib/api";
import { arrowheadPoints } from "./arrows";
import type { Rect as RectBox } from "./layout";
import type { HeaderTheme } from "./header-theme";
import {
  BLUE, GREEN, RED, LINE_HALO, LINE_WIDTH_INNER, LINE_WIDTH_HALO, ARROW_LENGTH, ARROW_WIDTH,
  LEGEND_ROW_FRAC, LEGEND_TITLE_FRAC, LEGEND_PAD_FRAC, LEGEND_SWATCH_FRAC,
  PAGE_MARGIN_FRAC, TITLE_FONT, BODY_FONT,
} from "./constants";

interface Props {
  pageWidth: number;
  band: RectBox;
  segments: FenceScopeSegment[];
  theme: HeaderTheme;
}

/** A short run of fence, drawn exactly as it appears on the photo. */
function Swatch({
  x, cy, width, color, doubleSided, scale, halo,
}: {
  x: number; cy: number; width: number; color: string;
  doubleSided: boolean; scale: number; halo: boolean;
}) {
  const inner = LINE_WIDTH_INNER * scale;
  const len = ARROW_LENGTH * scale;
  const wide = ARROW_WIDTH * scale;
  const offset = 6 * scale;
  // Two arrows, evenly spaced, so the repeating pattern on the photo reads as
  // the same thing as the key.
  const arrowsAt = [x + width * 0.3, x + width * 0.7];
  return (
    <Fragment>
      {/* The white halo exists to lift a line off a photo. On a flat band it
          would just look like a smear, so it's dropped there. */}
      {halo && (
        <Line points={[x, cy, x + width, cy]} stroke={LINE_HALO}
              strokeWidth={LINE_WIDTH_HALO * scale} lineCap="round" opacity={0.9} />
      )}
      <Line points={[x, cy, x + width, cy]} stroke={color} strokeWidth={inner} lineCap="round" />
      {arrowsAt.map((ax, i) => (
        <Fragment key={i}>
          <Line points={arrowheadPoints(ax, cy - offset, 0, -1, len, wide)} closed fill={color} />
          {doubleSided && (
            <Line points={arrowheadPoints(ax, cy + offset, 0, 1, len, wide)} closed fill={color} />
          )}
        </Fragment>
      ))}
    </Fragment>
  );
}

export default function Legend({ pageWidth, band, segments, theme }: Props) {
  // Only colours actually on the photo get a row. A customer having just the
  // inside done should never see a line about staining both faces.
  const used = (["blue", "green", "red"] as const).filter((c) => segments.some((s) => s.color === c));

  const margin = pageWidth * PAGE_MARGIN_FRAC;
  const pad = pageWidth * LEGEND_PAD_FRAC;
  // The band is a fixed height so the page never resizes mid-trace. All three
  // colours at once would overrun it, so the key shrinks to fit rather than
  // the page growing — and a one-colour scope keeps full-size type instead of
  // carrying a three-row footer it doesn't need.
  const rows = used.length;
  const natural = pageWidth * LEGEND_TITLE_FRAC + rows * pageWidth * LEGEND_ROW_FRAC;
  const room = band.height - pad * 2;
  const fit = natural > room ? room / natural : 1;

  const rowH = pageWidth * LEGEND_ROW_FRAC * fit;
  const titleH = pageWidth * LEGEND_TITLE_FRAC * fit;
  const swatchW = pageWidth * LEGEND_SWATCH_FRAC * fit;
  const contentH = titleH + rows * rowH;
  let rowTop = band.y + (band.height - contentH) / 2 + titleH;

  // Dark band on a dark theme, light band on a light one: it should read as
  // the same piece of stationery as the header.
  const light = theme.bg !== "#0d0d0d";

  const row = (color: string, doubleSided: boolean, label: string) => {
    const top = rowTop;
    rowTop += rowH;
    return (
      <Fragment key={label}>
        <Swatch
          x={margin} cy={top + rowH / 2} width={swatchW}
          color={color} doubleSided={doubleSided} scale={fit} halo={!light}
        />
        <KonvaText
          x={margin + swatchW + pad} y={top + rowH / 2 - rowH * 0.26}
          width={pageWidth - margin * 2 - swatchW - pad}
          text={label} fontSize={rowH * 0.46} fontFamily={BODY_FONT} fill={theme.ink}
          wrap="none" ellipsis
        />
      </Fragment>
    );
  };

  return (
    <Layer listening={false}>
      <Rect x={band.x} y={band.y} width={band.width} height={band.height} fill={theme.bg} />
      {/* Bookends the gold rule at the very top of the page. */}
      <Rect x={band.x} y={band.y} width={band.width} height={2} fill={theme.accent} />
      <KonvaText
        x={margin} y={band.y + (band.height - contentH) / 2}
        text="FENCE STAINING LEGEND"
        fontSize={titleH * 0.56} fontFamily={TITLE_FONT} fontStyle="bold" fill={theme.accent}
        letterSpacing={titleH * 0.03}
      />
      {used.map((c) =>
        c === "blue"
          ? row(BLUE, false, "Inside face only")
          : c === "green"
            ? row(GREEN, false, "Outside face only")
            : row(RED, true, "Both faces — inside and outside")
      )}
    </Layer>
  );
}
