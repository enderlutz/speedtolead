// Page geometry and text fitting for the scope document.
//
// The page is the photo with a header band on top — nothing more. That means
// the photo is never stretched, letterboxed, or cropped, and turning it 90
// degrees reshapes the page instead of squashing the house.
//
// Text is measured rather than estimated. The header carries a customer's
// street address, which can be any length, and a logo of any width sits next
// to it; guessing at a font size is how a line ends up hanging off the page.

import {
  HEADER_HEIGHT_OF_WIDTH, LEGEND_BAND_OF_WIDTH, TITLE_LETTER_SPACING,
} from "./constants";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageLayout {
  width: number;
  height: number;
  headerHeight: number;
  /** Where the photo goes — and the frame traced points are normalized to. */
  body: Rect;
  /** The band under the photo that carries the key. */
  legend: Rect;
}

/** @param photoAspect width / height of the photo as displayed. */
export function pageLayout(pageWidth: number, photoAspect: number): PageLayout {
  const headerHeight = pageWidth * HEADER_HEIGHT_OF_WIDTH;
  const bodyHeight = pageWidth / photoAspect;
  const legendHeight = pageWidth * LEGEND_BAND_OF_WIDTH;
  return {
    width: pageWidth,
    height: headerHeight + bodyHeight + legendHeight,
    headerHeight,
    body: { x: 0, y: headerHeight, width: pageWidth, height: bodyHeight },
    legend: { x: 0, y: headerHeight + bodyHeight, width: pageWidth, height: legendHeight },
  };
}

/** Page width : page height, for fitting the page into the editor frame. */
export function pageAspect(photoAspect: number): number {
  return 1 / (HEADER_HEIGHT_OF_WIDTH + 1 / photoAspect + LEGEND_BAND_OF_WIDTH);
}

/** Natural width / height of whatever Konva is about to draw. */
export function sourceAspect(img: HTMLImageElement | HTMLCanvasElement | null, fallback: number): number {
  if (!img) return fallback;
  const w = img instanceof HTMLCanvasElement ? img.width : img.naturalWidth;
  const h = img instanceof HTMLCanvasElement ? img.height : img.naturalHeight;
  return w > 0 && h > 0 ? w / h : fallback;
}

// One shared context, reused for every measurement. Konva measures text the
// same way (a throwaway 2D context), so what fits here fits on the canvas.
let measureCtx: CanvasRenderingContext2D | null | undefined;
function ctx(): CanvasRenderingContext2D | null {
  if (measureCtx === undefined) {
    try {
      measureCtx = document.createElement("canvas").getContext("2d");
    } catch {
      measureCtx = null;
    }
  }
  return measureCtx;
}

export function textWidth(text: string, size: number, family: string, bold: boolean, letterSpacing = 0): number {
  const c = ctx();
  // No canvas means no measuring; claiming zero width lets the caller fall
  // back to its maximum size rather than collapsing to the minimum.
  if (!c) return 0;
  c.font = `${bold ? "bold " : ""}${size}px ${family}`;
  return c.measureText(text).width + letterSpacing * text.length;
}

/** Headroom on the fitted width.
 *
 * Fitting exactly to the column leaves the line sitting on the boundary, and
 * Konva's own measurement rounds slightly differently — enough that it dropped
 * the last letter of "Fence Staining Scope" while every measurement said it
 * fit by a fraction of a pixel. A little slack costs nothing and removes the
 * whole class of silently-chopped glyphs. */
const FIT_SAFETY = 0.985;

/** Largest size in [min, max] at which `text` fits `maxWidth` on one line. */
export function fitFontSize(
  text: string,
  maxWidth: number,
  max: number,
  min: number,
  family: string,
  bold: boolean,
  letterSpacingRatio = 0
): number {
  if (!text || maxWidth <= 0) return max;
  const room = maxWidth * FIT_SAFETY;
  // Width scales linearly with font size, so one measurement gives the answer
  // directly — no search loop needed.
  const at = textWidth(text, max, family, bold, max * letterSpacingRatio);
  if (at <= room || at === 0) return max;
  return Math.max(min, (max * room) / at);
}

export const titleLetterSpacing = (size: number) => size * TITLE_LETTER_SPACING;
