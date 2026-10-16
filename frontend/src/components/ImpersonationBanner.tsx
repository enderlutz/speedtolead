import { getCurrentUser, isImpersonating, stopImpersonation } from "@/lib/api";
import { UserCheck } from "lucide-react";

/**
 * Global banner shown while an admin is "switched into" another account
 * (impersonation). Renders nothing on normal sessions. One click returns the
 * admin to their own account (restores the stashed token).
 */
export default function ImpersonationBanner() {
  const u = getCurrentUser();
  if (!u || !isImpersonating()) return null;

  const back = () => {
    if (stopImpersonation()) window.location.assign("/settings");
    else window.location.assign("/login");
  };

  return (
    <div className="bg-amber-500 text-white text-sm px-3 py-2 flex items-center justify-center gap-3 shrink-0">
      <span className="flex items-center gap-1.5 min-w-0">
        <UserCheck className="h-4 w-4 shrink-0" />
        <span className="truncate">Viewing as <strong>{u.name || u.sub}</strong>{u.impersonated_by ? ` — signed in by ${u.impersonated_by.name || u.impersonated_by.sub}` : ""}</span>
      </span>
      <button onClick={back} className="shrink-0 rounded-md bg-white px-3 py-1.5 font-bold text-amber-700 shadow-sm hover:bg-amber-50">
        Back to my account
      </button>
    </div>
  );
}
