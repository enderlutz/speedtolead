/**
 * PDF coordinate conversion using actual page dimensions.
 * PyMuPDF uses Y=0 at TOP of page (same as screen coordinates).
 */

/** Convert screen pixel coordinates to PDF points. */
export function screenToPdf(
  screenX: number,
  screenY: number,
  renderedWidth: number,
  renderedHeight: number,
  pdfWidth: number,
  pdfHeight: number,
): { x: number; y: number } {
  return {
    x: (screenX / renderedWidth) * pdfWidth,
    y: (screenY / renderedHeight) * pdfHeight,
  };
}

/** Convert PDF point coordinates to screen pixels. */
export function pdfToScreen(
  pdfX: number,
  pdfY: number,
  renderedWidth: number,
  renderedHeight: number,
  pdfWidth: number,
  pdfHeight: number,
): { x: number; y: number } {
  return {
    x: (pdfX / pdfWidth) * renderedWidth,
    y: (pdfY / pdfHeight) * renderedHeight,
  };
}
