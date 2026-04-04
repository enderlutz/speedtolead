/**
 * US Letter dimensions in PDF points (72 DPI).
 * PyMuPDF uses Y=0 at TOP of page (same as screen coordinates).
 * No Y-axis flip needed.
 */
export const PDF_WIDTH = 612;
export const PDF_HEIGHT = 792;

/** Convert screen pixel coordinates to PDF points. */
export function screenToPdf(
  screenX: number,
  screenY: number,
  renderedWidth: number,
  renderedHeight: number,
): { x: number; y: number } {
  return {
    x: (screenX / renderedWidth) * PDF_WIDTH,
    y: (screenY / renderedHeight) * PDF_HEIGHT,
  };
}

/** Convert PDF point coordinates to screen pixels. */
export function pdfToScreen(
  pdfX: number,
  pdfY: number,
  renderedWidth: number,
  renderedHeight: number,
): { x: number; y: number } {
  return {
    x: (pdfX / PDF_WIDTH) * renderedWidth,
    y: (pdfY / PDF_HEIGHT) * renderedHeight,
  };
}
