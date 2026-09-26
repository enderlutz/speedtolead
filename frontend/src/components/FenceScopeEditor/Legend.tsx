// The key the customer reads.
//
// It draws real samples of the markings using the same line widths, colours and
// arrowheads as the fence lines on the photo — a swatch that only approximated
// them would be worse than no key at all. Blue carries arrows on one side
// (inside face only), red on both (both faces stained).
//
// Only colours actually present get a row, and unmarked fence is never
// mentioned — spec Sections 6 and 32.

import { Fragment } from "react";
import { Layer, Rect, Line, Text as KonvaText } from "react-konva";
import type { FenceScopeSegment } from "@/lib/api";
import { arrowheadPoints } from "./arrows";
import type { Rect as RectBox } from "./layout";
import {
  BLUE, RED, LINE_HALO, LINE_WIDTH_INNER, LINE_WIDTH_HALO, ARROW_LENGTH, ARROW_WIDTH,
  LEGEND_WIDTH_FRAC, LEGEND_ROW_FRAC, LEGEND_TITLE_FRAC, LEGEND_PAD_FRAC,
  LEGEND_SWATCH_FRAC, LEGEND_MARGIN_FRAC, LEGEND_MAX_BODY_SHARE,
  GOLD, HEADER_TEXT, BODY_FONT, TITLE_FONT,
} from "./constants";

interface Props {
  pageWidth: number;
  body: RectBox;
  segments: FenceScopeSegment[];
}

/** A short run of fence, drawn exactly as it appears on the photo. */
function Swatch({
  x, cy, width, color, doubleSided, scale,
}: { x: number; cy: number; width: number; color: string; doubleSided: boolean; scale: number }) {
  const halo = LINE_WIDTH_HALO * scale;
  const inner = LINE_WIDTH_INNER * scale;
  const len = ARROW_LENGTH * scale;
  const wide = ARROW_WIDTH * scale;
  const offset = 6 * scale;
  // Two arrows, evenly spaced, so the repeating pattern on the photo reads as
  // the same thing as the key.
  const arrowsAt = [x + width * 0.3, x + width * 0.7];
  return (
    <Fragment>
      <Line points={[x, cy, x + width, cy]} stroke={LINE_HALO} strokeWidth={halo} lineCap="round" opacity={0.9} />
      <Line points={[x, cy, x + width, cy]} stroke={color} strokeWidth={inner} lineCap="round" />
      {arrowsAt.map((ax, i) => (
        <Fragment key={i}>
          <Line
            points={arrowheadPoints(ax, cy - offset, 0, -1, len, wide)}
            closed fill={color} stroke={LINE_HALO} strokeWidth={1.5 * scale}
          />
          {doubleSided && (
            <Line
              points={arrowheadPoints(ax, cy + offset, 0, 1, len, wide)}
              closed fill={color} stroke={LINE_HALO} strokeWidth={1.5 * scale}
            />
          )}
        </Fragment>
      ))}
    </Fragment>
  );
}

export default function Legend({ pageWidth, body, segments }: Props) {
  const hasBlue = segments.some((s) => s.color === "blue");
  const hasRed = segments.some((s) => s.color === "red");
  if (!hasBlue && !hasRed) return null;

  const rows = (hasBlue ? 1 : 0) + (hasRed ? 1 : 0);
  let pad = pageWidth * LEGEND_PAD_FRAC;
  let rowH = pageWidth * LEGEND_ROW_FRAC;
  let titleH = pageWidth * LEGEND_TITLE_FRAC;
  let width = pageWidth * LEGEND_WIDTH_FRAC;
  let swatchW = pageWidth * LEGEND_SWATCH_FRAC;
  const margin = pageWidth * LEGEND_MARGIN_FRAC;

  // A short body (a wide landscape photo) can't spare as much room, so the
  // whole key scales down together rather than overrunning the picture.
  let height = pad * 2 + titleH + rows * rowH;
  const maxHeight = body.height * LEGEND_MAX_BODY_SHARE;
  const maxWidth = body.width - margin * 2;
  const scale = Math.min(1, maxHeight / height, maxWidth / width);
  if (scale < 1) {
    pad *= scale;
    rowH *= scale;
    titleH *= scale;
    width *= scale;
    swatchW *= scale;
    height *= scale;
  }

  const x = body.x + margin;
  const y = body.y + body.height - height - margin;
  const textX = x + pad + swatchW + pad;
  const textW = width - (textX - x) - pad;
  let rowTop = y + pad + titleH;

  const row = (color: string, doubleSided: boolean, label: string) => {
    const top = rowTop;
    rowTop += rowH;
    return (
      <Fragment key={label}>
        <Swatch x={x + pad} cy={top + rowH / 2} width={swatchW} color={color} doubleSided={doubleSided} scale={scale} />
        <KonvaText
          x={textX} y={top + rowH / 2 - rowH * 0.24} width={textW}
          text={label} fontSize={rowH * 0.42} fontFamily={BODY_FONT} fill={HEADER_TEXT}
          wrap="none" ellipsis
        />
      </Fragment>
    );
  };

  return (
    <Layer listening={false}>
      <Rect
        x={x} y={y} width={width} height={height}
        fill="#0d0d0dee" stroke={GOLD} strokeWidth={2 * scale} cornerRadius={6 * scale}
      />
      <KonvaText
        x={x + pad} y={y + pad} width={width - pad * 2}
        text="FENCE STAINING LEGEND"
        fontSize={titleH * 0.62} fontFamily={TITLE_FONT} fontStyle="bold" fill={GOLD}
        letterSpacing={titleH * 0.03}
      />
      {hasBlue && row(BLUE, false, "Inside face only")}
      {hasRed && row(RED, true, "Both faces — inside and outside")}
    </Layer>
  );
}
