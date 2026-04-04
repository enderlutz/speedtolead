/** US Letter dimensions in PDF points (72 DPI). */
export const PDF_WIDTH = 612;
export const PDF_HEIGHT = 792;

/** Convert screen pixel coordinates to PDF points. Y-axis flips. */
export function screenToPdf(
  screenX: number,
  screenY: number,
  renderedWidth: number,
  renderedHeight: number,
): { x: number; y: number } {
  return {
    x: (screenX / renderedWidth) * PDF_WIDTH,
    y: PDF_HEIGHT - (screenY / renderedHeight) * PDF_HEIGHT,
  };
}

/** Convert PDF point coordinates to screen pixels. Y-axis flips. */
export function pdfToScreen(
  pdfX: number,
  pdfY: number,
  renderedWidth: number,
  renderedHeight: number,
): { x: number; y: number } {
  return {
    x: (pdfX / PDF_WIDTH) * renderedWidth,
    y: ((PDF_HEIGHT - pdfY) / PDF_HEIGHT) * renderedHeight,
  };
}
