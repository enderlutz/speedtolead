import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Share, SquarePlus, X } from "lucide-react";
import { isSpanish } from "@/lib/i18n";
import { canPrompt, isInstalled, isIphone, onInstallChange, promptInstall } from "@/lib/install";

// The "Install the app" button in the menu (see lib/install). Hidden once the
// app is opened from the home-screen icon. Plain words, English or Spanish,
// big taps: the crew uses this on a phone outside.
export default function InstallApp() {
  const [, bump] = useState(0);
  const [help, setHelp] = useState(false);
  useEffect(() => onInstallChange(() => bump((n) => n + 1)), []);

  if (isInstalled()) return null;
  const es = isSpanish();
  const iphone = isIphone();
  // On a computer without Chrome's prompt there is nothing to install to.
  if (!iphone && !canPrompt() && !/Android/i.test(navigator.userAgent)) return null;

  const tap = async () => {
    if (canPrompt()) {
      await promptInstall();
      return;
    }
    setHelp(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={tap}
        className="mx-3 mb-2 flex min-h-[44px] w-[calc(100%-1.5rem)] items-center gap-2.5 rounded-xl border border-gold/50 bg-gold/10 px-3 text-left text-[14px] font-semibold text-gold-light transition hover:bg-gold/20 active:scale-[0.98]"
      >
        <Download className="h-4 w-4 shrink-0" />
        {es ? "Instalar la app" : "Install the app"}
      </button>

      {/* Portal to <body>: the menu panel is transformed, which would trap a
          fixed popup inside it on a phone. */}
      {help ? createPortal(
        <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/70 p-3 sm:items-center" onClick={() => setHelp(false)}>
          <div
            className="keep-light w-full max-w-sm rounded-2xl bg-white p-5 text-[#15130F] shadow-xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <img src="/apple-touch-icon.png" alt="" className="h-12 w-12 rounded-xl" />
                <div>
                  <p className="text-[17px] font-bold">{es ? "Pon Sterling en tu teléfono" : "Put Sterling on your phone"}</p>
                  <p className="text-[14px] text-[#55534D]">{es ? "Dos toques, en Safari" : "Two taps, in Safari"}</p>
                </div>
              </div>
              <button type="button" onClick={() => setHelp(false)} aria-label="Close" className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-black/5">
                <X className="h-5 w-5" />
              </button>
            </div>
            <ol className="mt-4 space-y-3 text-[15px]">
              <li className="flex items-center gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#15130F] text-[14px] font-bold text-white">1</span>
                <span className="flex items-center gap-1.5">
                  {iphone
                    ? (es ? "Toca Compartir" : "Tap Share")
                    : (es ? "Toca el menú ⋮ de Chrome" : "Tap Chrome's ⋮ menu")}
                  {iphone ? <Share className="h-5 w-5 text-[#1f8bff]" /> : null}
                  {iphone ? <span className="text-[13px] text-[#55534D]">{es ? "(abajo)" : "(at the bottom)"}</span> : null}
                </span>
              </li>
              <li className="flex items-center gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#15130F] text-[14px] font-bold text-white">2</span>
                <span className="flex items-center gap-1.5">
                  {iphone
                    ? (es ? "Toca «Agregar a inicio»" : "Tap “Add to Home Screen”")
                    : (es ? "Toca «Instalar app»" : "Tap “Install app”")}
                  {iphone ? <SquarePlus className="h-5 w-5" /> : null}
                </span>
              </li>
              <li className="flex items-center gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#C9972F] text-[14px] font-bold text-[#15130F]">✓</span>
                <span>{es ? "Abre Sterling desde el ícono nuevo e inicia sesión una vez." : "Open Sterling from the new icon and log in once."}</span>
              </li>
            </ol>
            {iphone ? (
              <p className="mt-4 text-[13px] text-[#55534D]">
                {es ? "Si no ves «Agregar a inicio», abre esta página en Safari." : "Don't see “Add to Home Screen”? Open this page in Safari."}
              </p>
            ) : null}
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
