/** When a photo was really taken (Alan, 2026-10-20: every crew photo is
 *  timestamped, "so I can see when they arrived at the job").
 *
 *  Read before shrinkPhoto, which redraws the picture and drops its EXIF.
 *  The camera's own DateTimeOriginal first; a phone's file date otherwise. */

function exifDate(buf: ArrayBuffer): Date | null {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null; // not a JPEG
  let off = 2;
  while (off + 4 < v.byteLength) {
    const marker = v.getUint16(off);
    const len = v.getUint16(off + 2);
    if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return tiffDate(v, off + 10);
    if ((marker & 0xff00) !== 0xff00) return null;
    off += 2 + len;
  }
  return null;
}

function tiffDate(v: DataView, start: number): Date | null {
  const little = v.getUint16(start) === 0x4949;
  const u16 = (o: number) => v.getUint16(start + o, little);
  const u32 = (o: number) => v.getUint32(start + o, little);
  const read = (ifd: number, want: number): number | null => {
    if (start + ifd + 2 > v.byteLength) return null;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (start + e + 12 > v.byteLength) return null;
      if (u16(e) === want) return u32(e + 8);
    }
    return null;
  };
  const text = (o: number | null) => {
    if (o == null || start + o + 19 > v.byteLength) return null;
    let s = "";
    for (let i = 0; i < 19; i++) s += String.fromCharCode(v.getUint8(start + o + i));
    const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(s);
    // Camera time is the phone's local time, the same clock as this browser.
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
  };
  const ifd0 = u32(4);
  const exif = read(ifd0, 0x8769);
  return (exif != null ? text(read(exif, 0x9003)) : null) || text(read(ifd0, 0x0132));
}

export async function photoTakenAt(file: File): Promise<string> {
  try {
    const d = exifDate(await file.slice(0, 256 * 1024).arrayBuffer());
    if (d && !Number.isNaN(d.getTime())) return d.toISOString();
  } catch { /* fall back to the file date */ }
  return file.lastModified ? new Date(file.lastModified).toISOString() : "";
}

/** "Tue 10/20 · 8:42 AM" — on every photo, big enough to read at a glance. */
export function stampText(iso: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "";
  const day = d.toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" });
  return `${day} · ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}
