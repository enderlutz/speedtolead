// The header bar has to match whatever logo is uploaded, or the logo sits in
// an obvious rectangle of its own background colour — which is exactly how it
// looked with a cream logo on a black bar.
//
// Rather than hardcode a colour that breaks the next time the logo changes,
// sample the logo's own corners. Four corners that agree on a solid colour
// means the logo ships with a background plate, so the header adopts it. A
// transparent or busy-edged logo leaves the header on its original black.

import { GOLD, HEADER_BG, HEADER_TEXT } from "./constants";

export interface HeaderTheme {
  bg: string;
  /** Text colour on that background. */
  ink: string;
  /** Brand accent (the hairline rule, and the wordmark fallback). */
  accent: string;
}

export const DARK_HEADER: HeaderTheme = { bg: HEADER_BG, ink: HEADER_TEXT, accent: GOLD };

// Ink and accent for a light plate. Dark gold rather than the bright brand
// gold: #C9A24B on cream is barely legible.
const LIGHT_INK = "#17130D";
const LIGHT_ACCENT = "#7A5E22";

/** Corners must agree within this per-channel spread to count as a plate. */
const MAX_CORNER_SPREAD = 14;

function relativeLuminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function headerThemeForLogo(logo: HTMLImageElement | null): HeaderTheme {
  if (!logo) return DARK_HEADER;
  const w = logo.naturalWidth;
  const h = logo.naturalHeight;
  if (!w || !h) return DARK_HEADER;

  let data: Uint8ClampedArray[];
  try {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return DARK_HEADER;
    ctx.drawImage(logo, 0, 0);
    // Step in slightly — the outermost pixel row is often an antialiased edge.
    const inset = Math.max(1, Math.round(Math.min(w, h) * 0.01));
    data = [
      [inset, inset],
      [w - 1 - inset, inset],
      [inset, h - 1 - inset],
      [w - 1 - inset, h - 1 - inset],
    ].map(([x, y]) => ctx.getImageData(x, y, 1, 1).data);
  } catch {
    // A tainted canvas can't be read. Not worth surfacing — the black header
    // is a perfectly good result.
    return DARK_HEADER;
  }

  // Any transparency means the logo is meant to sit on whatever is behind it.
  if (data.some((px) => px[3] < 250)) return DARK_HEADER;

  const channels = [0, 1, 2].map((i) => data.map((px) => px[i]));
  const spread = Math.max(...channels.map((vals) => Math.max(...vals) - Math.min(...vals)));
  if (spread > MAX_CORNER_SPREAD) return DARK_HEADER;

  const [r, g, b] = channels.map((vals) => Math.round(vals.reduce((a, v) => a + v, 0) / vals.length));
  const bg = `rgb(${r}, ${g}, ${b})`;
  return relativeLuminance(r, g, b) > 0.5
    ? { bg, ink: LIGHT_INK, accent: LIGHT_ACCENT }
    : { bg, ink: HEADER_TEXT, accent: GOLD };
}
