// Detects when a new frontend build has been deployed and shows a top banner
// prompting a refresh. Vite content-hashes the asset filenames per build, so a
// new deploy changes the /assets/*.js|css names referenced by index.html. We
// snapshot the hashes the running page loaded with, then poll index.html; when
// the set differs, a new version is live.
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

// The asset bundle names this page booted with (captured once, at load).
function loadedAssetKeys(): string {
  const urls: string[] = [];
  document.querySelectorAll('script[src]').forEach((s) => {
    const src = (s as HTMLScriptElement).src;
    if (src.includes("/assets/")) urls.push(src);
  });
  document.querySelectorAll('link[href]').forEach((l) => {
    const href = (l as HTMLLinkElement).href;
    if (href.includes("/assets/")) urls.push(href);
  });
  return [...new Set(urls.map((u) => u.split("/").pop() || ""))].filter(Boolean).sort().join(",");
}

const BOOT_KEYS = loadedAssetKeys();

async function deployedAssetKeys(): Promise<string | null> {
  try {
    const res = await fetch(`/index.html?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const html = await res.text();
    const matches = html.match(/\/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g) || [];
    return [...new Set(matches.map((m) => m.split("/").pop() || ""))].filter(Boolean).sort().join(",");
  } catch {
    return null;
  }
}

export default function UpdateBanner() {
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    // Only meaningful in a real (hashed) production build; dev has no /assets/.
    if (!import.meta.env.PROD || !BOOT_KEYS) return;
    let stopped = false;

    const check = async () => {
      if (stopped || updateReady) return;
      const latest = await deployedAssetKeys();
      if (!stopped && latest && latest !== BOOT_KEYS) setUpdateReady(true);
    };

    const id = window.setInterval(check, 60_000); // every minute
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    void check(); // and once on mount
    return () => { stopped = true; window.clearInterval(id); window.removeEventListener("focus", onFocus); };
  }, [updateReady]);

  if (!updateReady) return null;

  return (
    <div className="fixed top-0 inset-x-0 z-[200] bg-blue-600 text-white shadow-md">
      <div className="max-w-5xl mx-auto px-4 py-2 flex items-center justify-center gap-3 text-sm">
        <RefreshCw className="h-4 w-4 shrink-0" />
        <span className="font-medium">Update detected — refresh the page for the latest version.</span>
        <button
          onClick={() => window.location.reload()}
          className="ml-1 rounded-md bg-white/20 hover:bg-white/30 px-3 py-1 font-semibold shrink-0 transition-colors"
        >
          Refresh
        </button>
      </div>
    </div>
  );
}
