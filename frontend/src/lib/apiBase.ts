// Customer pages talk to the server through our own domain (Vercel passes
// /api/* on to Railway, see vercel.json). Work phones and laptops block the
// railway.app address: Russ Schamun's estimate and booking never loaded on
// his (Alan, 2026-10-20). Staff pages and the photo/video upload pages still
// go straight to Railway, so big uploads don't pass through Vercel.
const CUSTOMER_PAGE = /^\/(p|proposal|b|pay|after|r|receipt|legal)\//;
export const API_BASE = typeof window !== "undefined" && CUSTOMER_PAGE.test(window.location.pathname)
  ? ""
  : import.meta.env.VITE_API_URL || "";
