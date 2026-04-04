# AT-System Lite — Setup & Deployment TODO

## 1. Supabase (Database)

- [ ] Create a new Supabase project
- [ ] Copy the **Connection string (URI)** from Settings > Database
  - Format: `postgresql://postgres.[ref]:[password]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`
- [ ] Tables auto-create on first backend startup (no manual SQL needed)

## 2. Railway (Backend)

- [ ] Push repo to GitHub
- [ ] Create Railway project > Deploy from GitHub > set root directory to `backend`
- [ ] Add environment variables in Railway:

| Variable | Where to get it |
|----------|----------------|
| `DATABASE_URL` | Supabase connection string from step 1 |
| `GHL_API_KEY` | GHL > Settings > Business Profile > API Key (Cypress location) |
| `GHL_LOCATION_ID` | GHL > Settings > Business Profile > Location ID (Cypress) |
| `GHL_API_KEY_2` | Same, for Woodlands location |
| `GHL_LOCATION_ID_2` | Location ID for Woodlands |
| `OWNER_GHL_CONTACT_ID` | Alan's Contact ID in GHL (click his contact > URL has the ID) |
| `OLGA_GHL_CONTACT_ID` | Olga's Contact ID in GHL |
| `FRONTEND_URL` | Your Vercel URL (set after Vercel deploy, e.g. `https://at-system-lite.vercel.app`) |
| `PROPOSAL_BASE_URL` | Same as FRONTEND_URL |
| `GOOGLE_MAPS_API_KEY` | Google Cloud Console > APIs & Services > Credentials |
| `ALLOWED_ORIGINS` | Your Vercel URL (e.g. `https://at-system-lite.vercel.app`) |
| `GHL_PIPELINE_ID` | (Optional) GHL pipeline ID for Cypress — find via Settings > Pipelines in dashboard |
| `GHL_PIPELINE_ID_2` | (Optional) GHL pipeline ID for Woodlands |

- [ ] Note the Railway deployment URL (e.g. `https://at-system-lite-production.up.railway.app`)
- [ ] Verify backend health: `https://[railway-url]/health` should return `{"status":"ok"}`

## 3. Vercel (Frontend)

- [ ] Import same GitHub repo in Vercel
- [ ] Set root directory to `frontend`
- [ ] Set framework preset to **Vite**
- [ ] Add environment variables in Vercel:

| Variable | Value |
|----------|-------|
| `VITE_API_URL` | Your Railway URL (e.g. `https://at-system-lite-production.up.railway.app`) |
| `VITE_GOOGLE_MAPS_KEY` | Same Google Maps API key |

- [ ] Deploy
- [ ] Go back to Railway and update `FRONTEND_URL`, `PROPOSAL_BASE_URL`, and `ALLOWED_ORIGINS` with the actual Vercel domain

## 4. GHL Webhooks (CRITICAL)

These make leads and messages show up instantly in the dashboard. Without them, leads only sync every 60 seconds via the poller.

- [ ] **Form submission webhook**: In GHL, go to Settings > Webhooks (or Automation > Workflows) and add:
  - URL: `https://[railway-url]/webhook/ghl`
  - Trigger: Contact Created / Form Submitted
  - Set this for **both** Cypress and Woodlands locations

- [ ] **Message webhook**: Add a second webhook:
  - URL: `https://[railway-url]/webhook/ghl/message`
  - Trigger: Inbound Message / Outbound Message
  - Set this for **both** locations
  - This is what makes customer replies appear instantly (< 1 second) in the dashboard

## 5. Google Maps API Key

- [ ] Go to Google Cloud Console > APIs & Services
- [ ] Enable these APIs:
  - Maps Embed API (for satellite view on lead detail page)
  - Geocoding API (for address/ZIP extraction)
- [ ] Create or use an existing API key
- [ ] Restrict the key: HTTP referrers for Embed API, IP restriction for Geocoding
- [ ] Add the key to both Railway (`GOOGLE_MAPS_API_KEY`) and Vercel (`VITE_GOOGLE_MAPS_KEY`)

## 6. PDF Template

- [ ] Upload a PDF proposal template via Settings > PDF Template in the dashboard
- [ ] Map fields (customer_name, address, essential_price, signature_price, legacy_price, etc.) to positions on the PDF
- [ ] Test: approve an estimate and verify the filled PDF looks correct

## 7. GHL Pipeline Sync (Optional)

- [ ] In the dashboard, go to Settings > click "Discover Pipelines"
- [ ] Note the pipeline IDs for Cypress and Woodlands
- [ ] Add them to Railway env vars: `GHL_PIPELINE_ID` and `GHL_PIPELINE_ID_2`

## 8. Test the Full Flow

- [ ] Submit a test form in GHL (Cypress location)
- [ ] Verify lead appears on dashboard instantly (via webhook) or within 60s (via poller)
- [ ] Verify Alan + Olga both receive SMS/WhatsApp notification
- [ ] Open the lead detail page > fill in linear feet + fence details > Save & Recalculate
- [ ] Verify estimate calculates correctly (3 tiers)
- [ ] Click "Approve & Send to Customer"
- [ ] Verify:
  - [ ] Customer receives SMS with proposal link
  - [ ] GHL contact has a note with tier prices
  - [ ] Alan + Olga notified of the sent estimate
  - [ ] Proposal page loads in < 2 seconds (pre-rasterized JPEG pages)
  - [ ] PDF download works
- [ ] Wait 5 minutes without sending an estimate on a new lead
- [ ] Verify Alan + Olga receive the nudge SMS listing pending leads with elapsed time
- [ ] Submit a RED estimate (outside zone or 15+ yr fence)
- [ ] Click "Request Alan's Approval" > verify Alan gets SMS with quick-approve link
- [ ] Alan opens link on phone > taps Approve > verify estimate sends to customer

## 9. After Go-Live

- [ ] Monitor the Analytics > Speed tab — target: 80%+ of estimates sent within 5 minutes
- [ ] Monitor Analytics > Revenue tab — track capture rate and missed revenue reasons
- [ ] Check Analytics > Patterns tab — identify which zones/zips/days have highest close rates
- [ ] Review the Sent Log page to verify pricing logic is correct across estimates
- [ ] Watch for nudge SMS frequency — adjust if 5 minutes feels too aggressive or too slow

## Known Limitations

- No Stripe payment / deposit collection (customers call to book)
- No Google Calendar integration (manual scheduling)
- No customer-facing interactive proposal wizard (PDF-only)
- No SMS drip/workflow automation (single estimate send only)
- No auth on the dashboard (relies on being behind a private URL or VPN)
