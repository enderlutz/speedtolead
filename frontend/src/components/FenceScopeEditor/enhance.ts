// Image enhancement for the aerial photo.
//
// A phone screenshot of a map is soft, flat, and then gets upscaled on the way
// into a 1536px-wide page, which softens it further. This sharpens it and
// lifts the contrast and colour so a fence line reads clearly at a glance.
//
// Deliberately arithmetic, not a model: it runs instantly, costs nothing, needs
// no network, and produces the same result every time. It cannot remove map
// labels or pins — that's a different job, and turning labels off in Google
// Maps before screenshotting beats any attempt to paint them out afterwards.

/** Unsharp-mask strength. Above ~1.2 the roof edges start to halo. */
const SHARPEN_AMOUNT = 0.85;
const CONTRAST = 1.14;
const SATURATION = 1.2;
/** Keeps mid-greys where they are while contrast stretches around them. */
const CONTRAST_PIVOT = 128;

/** Separable 5-tap Gaussian, [1 4 6 4 1] / 16. */
function blurPass(src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number, horizontal: boolean) {
  const stride = horizontal ? 4 : w * 4;
  const limit = horizontal ? w : h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const at = horizontal ? x : y;
      for (let c = 0; c < 3; c++) {
        // Clamp at the edges rather than wrapping, which would smear the
        // opposite side of the photo into this one.
        const m2 = src[i + c - 2 * stride + (at >= 2 ? 0 : 2 * stride)];
        const m1 = src[i + c - stride + (at >= 1 ? 0 : stride)];
        const p1 = src[i + c + stride - (at <= limit - 2 ? 0 : stride)];
        const p2 = src[i + c + 2 * stride - (at <= limit - 3 ? 0 : 2 * stride)];
        dst[i + c] = (m2 + 4 * m1 + 6 * src[i + c] + 4 * p1 + p2) / 16;
      }
      dst[i + 3] = src[i + 3];
    }
  }
}

/** Sharpens and lifts contrast/colour in place. */
export function enhancePixels(data: Uint8ClampedArray, w: number, h: number): void {
  if (w < 5 || h < 5) return;

  // Unsharp mask: whatever the blur removed is the detail, so add it back.
  const tmp = new Uint8ClampedArray(data.length);
  const blurred = new Uint8ClampedArray(data.length);
  blurPass(data, tmp, w, h, true);
  blurPass(tmp, blurred, w, h, false);

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] + SHARPEN_AMOUNT * (data[i] - blurred[i]);
    let g = data[i + 1] + SHARPEN_AMOUNT * (data[i + 1] - blurred[i + 1]);
    let b = data[i + 2] + SHARPEN_AMOUNT * (data[i + 2] - blurred[i + 2]);

    // Saturation around the pixel's own luminance.
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = lum + (r - lum) * SATURATION;
    g = lum + (g - lum) * SATURATION;
    b = lum + (b - lum) * SATURATION;

    data[i] = (r - CONTRAST_PIVOT) * CONTRAST + CONTRAST_PIVOT;
    data[i + 1] = (g - CONTRAST_PIVOT) * CONTRAST + CONTRAST_PIVOT;
    data[i + 2] = (b - CONTRAST_PIVOT) * CONTRAST + CONTRAST_PIVOT;
    // Uint8ClampedArray clamps to 0-255 on assignment, so no manual clamping.
  }
}

/** Returns an enhanced copy at the source's full resolution. */
export function enhanceImage(src: HTMLImageElement | HTMLCanvasElement): HTMLImageElement | HTMLCanvasElement {
  const w = src instanceof HTMLCanvasElement ? src.width : src.naturalWidth || src.width;
  const h = src instanceof HTMLCanvasElement ? src.height : src.naturalHeight || src.height;
  if (!w || !h) return src;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return src;
  ctx.drawImage(src, 0, 0);
  try {
    const frame = ctx.getImageData(0, 0, w, h);
    enhancePixels(frame.data, w, h);
    ctx.putImageData(frame, 0, 0);
  } catch {
    // Tainted canvas — hand back the original rather than a blank one.
    return src;
  }
  return canvas;
}
