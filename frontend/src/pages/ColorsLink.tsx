// The colours link: every stain colour with its job photo, labelled
// "semi-transparent" or "solid", no package names and no prices. Alan
// (2026-11-07) texts it to contractors who sub work to us (Lionheart,
// Lucas) when they get one price and only need the colour picked:
// "here's the link of all our popular colors, let me know which one
// they like." Public page, reads the same list as the proposal.
//
// Old-person proof (see customer-pages rules): pictures first, 17px
// labels, nothing under 12px, 44px taps, plain words.
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { COLOR_BOARD, type BoardColor } from "@/content/stain-colors";

const PHONE = "(346) 589-7877";

// One package's colors only (Alan, 2026-11-14): /colors/legacy for a customer
// already on the Legacy who just needs to pick a solid color (Daninu), and
// /colors/signature for the semi-transparent line. A few plain lines on what
// the package is, then only its colors. Still no prices.
type Line = "legacy" | "signature";
const LINES: Record<Line, { finish: BoardColor["finish"]; title: string; what: string[] }> = {
  legacy: {
    finish: "solid",
    title: "Legacy colors",
    what: [
      "The Legacy is our longest-lasting finish. It's a solid stain: more color and sealer in every coat, so it covers the wood evenly and hides the small marks and knots.",
      "Two coats, every board brushed in by hand. It usually lasts 5 to 8 years.",
    ],
  },
  signature: {
    finish: "semi-transparent",
    title: "Signature colors",
    what: [
      "The Signature is our most popular finish. It's a semi-transparent stain: it adds color and protection and still lets the wood grain show through.",
      "Two coats, every board brushed in by hand. It usually lasts 4 to 5 years.",
    ],
  },
};

export default function ColorsLink({ embedded = false, line }: { embedded?: boolean; line?: Line }) {
  const [open, setOpen] = useState<BoardColor | null>(null);
  const pick = line ? LINES[line] : null;
  const colors = pick ? COLOR_BOARD.filter((c) => c.finish === pick.finish) : COLOR_BOARD;

  useEffect(() => {
    if (embedded) return;
    const prev = document.title;
    document.title = `${pick ? pick.title : "Our colors"} · Sterling Fence Staining`;
    return () => { document.title = prev; };
  }, [embedded, pick]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className={embedded ? "bg-white text-[#1a1a1a]" : "min-h-screen bg-white text-[#1a1a1a]"}>
      <div className="mx-auto max-w-3xl px-4 pb-16 pt-8 sm:px-6">
        <header className="flex items-center justify-between gap-4">
          <img src="/sterling-logo.png" alt="Sterling Fence Staining" className="h-9 w-auto" draggable={false} />
          <span className="text-[15px] text-[#555]">{PHONE}</span>
        </header>
        <div className="mt-4 h-px w-full bg-[#C9972F]/60" />

        <h1 className="mt-7 font-heading text-[40px] font-bold leading-none sm:text-[48px]">{pick ? pick.title : "Our colors"}</h1>
        {pick ? pick.what.map((t) => <p key={t} className="mt-3 text-[17px] leading-relaxed text-[#333]">{t}</p>) : null}
        <p className="mt-3 text-[17px] leading-relaxed text-[#333]">
          Every color here is on a real fence we stained. Tap one to see it bigger.
          Text us the name of the one you like.
        </p>
        {/* No "we'll show you samples in person" here (Alan, 2026-11-14): the
            point of this link is to pick without a visit. */}
        {pick ? null : (
          <p className="mt-2 text-[15px] leading-relaxed text-[#555]">
            <strong className="font-semibold text-[#1a1a1a]">Semi-transparent</strong> lets the wood grain show through.{" "}
            <strong className="font-semibold text-[#1a1a1a]">Solid</strong> is one even color that covers everything.
          </p>
        )}

        <ul className="mt-7 grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3">
          {colors.map((c) => (
            <li key={c.key}>
              <button
                type="button"
                onClick={() => setOpen(c)}
                className="group block w-full text-left"
                aria-label={`See ${c.label} bigger`}
              >
                <div className="overflow-hidden rounded-2xl bg-[#f3efe6] ring-1 ring-black/10">
                  <img
                    src={c.src}
                    alt={c.label}
                    loading="lazy"
                    className="aspect-[4/5] w-full object-cover transition group-hover:scale-[1.02]"
                    draggable={false}
                  />
                </div>
                <div className="mt-2 min-h-[44px]">
                  <div className="text-[17px] font-semibold leading-tight">{c.name}</div>
                  {pick ? null : <div className="text-[15px] text-[#555]">{c.finish}</div>}
                </div>
              </button>
            </li>
          ))}
        </ul>

        <footer className="mt-12 border-t border-black/10 pt-5 text-[15px] leading-relaxed text-[#555]">
          Sterling Fence Staining · Houston · {PHONE}
          <br />
          Colors look a little different on every fence. The wood, its age and the sun all change it a bit.
        </footer>
      </div>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
          onClick={() => setOpen(null)}
          role="dialog"
          aria-modal="true"
          aria-label={open.label}
        >
          <button
            type="button"
            onClick={() => setOpen(null)}
            className="absolute right-4 top-4 flex h-11 w-11 items-center justify-center rounded-full bg-white text-[#1a1a1a] shadow"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
          <figure className="max-h-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
            <img src={open.full} alt={open.label} className="max-h-[80vh] w-auto rounded-2xl object-contain" draggable={false} />
            <figcaption className="mt-3 text-center text-[19px] font-semibold text-white">{open.label}</figcaption>
          </figure>
        </div>
      ) : null}
    </div>
  );
}
