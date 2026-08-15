// Brick-division route allowlist.
//
// Pages the Brick Staining division is allowed to reach. Anything else
// redirects to the Brick Leads board while brick is the active division, so no
// fence data is shown. Prefix match, except "/" which must be exact (Dashboard
// is fence-only).
//
// Lives beside the nav rather than inside Sidebar.tsx so that module exports
// only components and keeps Fast Refresh.
const BRICK_ALLOWED_PREFIXES = [
  "/leads-brick", "/leads/", "/calendar", "/pm-hq", "/my-schedule",
  "/daily-tasks", "/sops/", "/settings", "/internal", "/login",
];

export function isBrickAllowedPath(path: string): boolean {
  if (path === "/") return false;  // Dashboard — fence-only for now
  return BRICK_ALLOWED_PREFIXES.some((p) => path === p || path.startsWith(p));
}
