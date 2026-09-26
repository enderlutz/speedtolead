/** Bakes a quarter-turn into an offscreen canvas.
 *
 * Konva can rotate an Image node directly, but getting a rotated node to
 * exactly fill a fixed rect means juggling the origin per angle, and any
 * mistake there silently shifts the photo under an already-traced fence.
 * Pre-turning the pixels means every angle draws with the same plain
 * x/y/width/height fill, on screen and in the export alike.
 */
export function orientImage(
  img: HTMLImageElement,
  rotation: number,
  mirrored: boolean
): HTMLImageElement | HTMLCanvasElement {
  const deg = (((rotation | 0) % 360) + 360) % 360;
  if (deg === 0 && !mirrored) return img;

  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return img;

  const quarterTurn = deg === 90 || deg === 270;
  const canvas = document.createElement("canvas");
  canvas.width = quarterTurn ? ih : iw;
  canvas.height = quarterTurn ? iw : ih;
  const ctx = canvas.getContext("2d");
  if (!ctx) return img;

  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  // After the rotate, so it mirrors the photo's own left-right — which is what
  // the stored orientation means, and what the point maps assume.
  if (mirrored) ctx.scale(-1, 1);
  ctx.drawImage(img, -iw / 2, -ih / 2);
  return canvas;
}
