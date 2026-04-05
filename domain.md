# Custom Domain Setup Guide

## Goal

Replace the default Vercel URL (`speedtolead-two.vercel.app`) with:
- **`admin.atpressurewash.com`** — VA/admin dashboard
- **`proposal.atpressurewash.com`** — Customer-facing proposal links sent via SMS

---

## Step 1: Add DNS Records

At your domain registrar for `atpressurewash.com`, add two CNAME records:

| Type  | Name       | Value                  |
|-------|------------|------------------------|
| CNAME | `admin`    | `cname.vercel-dns.com` |
| CNAME | `proposal` | `cname.vercel-dns.com` |

DNS propagation can take a few minutes up to 48 hours.

---

## Step 2: Add Domains in Vercel

1. Go to [Vercel Dashboard](https://vercel.com) → your project → **Settings** → **Domains**
2. Add `admin.atpressurewash.com`
3. Add `proposal.atpressurewash.com`
4. Vercel handles SSL automatically — wait for both to show "Valid Configuration"

---

## Step 3: Update Railway Environment Variables

In your Railway backend service, update these env vars:

| Variable           | New Value                                |
|--------------------|------------------------------------------|
| `FRONTEND_URL`     | `https://admin.atpressurewash.com`       |
| `PROPOSAL_BASE_URL`| `https://proposal.atpressurewash.com`    |
| `ALLOWED_ORIGINS`  | `https://admin.atpressurewash.com,https://proposal.atpressurewash.com` |

Redeploy the backend after updating.

---

## Step 4: Update Vercel Environment Variables

In your Vercel project settings → **Environment Variables**, update:

| Variable         | New Value                          |
|------------------|------------------------------------|
| `VITE_API_URL`   | Keep as your Railway backend URL   |

Redeploy the frontend after updating (or push a commit to trigger auto-deploy).

---

## Step 5: Verify

1. Open `https://admin.atpressurewash.com` — should load the login/dashboard
2. Send a test estimate — the SMS link should use `https://proposal.atpressurewash.com/proposal/{token}`
3. Open the proposal link — should load the customer proposal page
4. Confirm SSL padlock shows on both subdomains

---

## Notes

- Both subdomains serve the same Vercel app. Routing is handled by React Router.
- The auth wall protects dashboard routes, so even if someone visits `/leads` on the proposal subdomain, they'd need to log in.
- If you want to fully restrict dashboard routes on the proposal subdomain later, add a check in `App.tsx` that redirects based on `window.location.hostname`.
- The old `speedtolead-two.vercel.app` URL will continue to work unless you remove it from Vercel domains.
