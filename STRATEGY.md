# SpeedToLead — Strategic Growth Plan

## Executive Summary

You have a working vertical SaaS product that solves a $4.2B problem: home service companies lose 78% of leads because they respond too slowly. Your system delivers professional estimates in under 5 minutes. The technology is built, deployed, and functional. The question is no longer "can we build it" — it's "how do we scale it."

This document covers: market sizing, business model, pricing strategy, go-to-market, product roadmap, competitive positioning, unit economics, and 12-month milestones.

---

## 1. Market Opportunity

### The Problem
- **78% of customers buy from the first company to respond** (Harvard Business Review)
- Average home service company responds to leads in **4-24 hours**
- Lead cost: $30-$150 per lead (Google Ads, Angi, Thumbtack)
- Most companies have a **15-25% close rate** on inbound leads
- **The bottleneck isn't lead generation — it's lead conversion**

### Total Addressable Market (TAM)
| Segment | Companies in US | Avg Monthly Revenue | Market Size |
|---------|----------------|--------------------:|------------:|
| Fence/Staining | 52,000 | $40K | $2.1B |
| Painting | 120,000 | $35K | $4.2B |
| Pressure Washing | 85,000 | $25K | $2.1B |
| Roofing | 100,000 | $80K | $8.0B |
| HVAC | 115,000 | $60K | $6.9B |
| Landscaping | 600,000 | $30K | $18.0B |

**Your serviceable market (SAM):** Fence, painting, and pressure washing companies using GHL or similar CRMs doing $300K-$3M/year revenue = ~50,000 companies.

**Your serviceable obtainable market (SOM):** 500-1,000 companies in Year 1-2 (1-2% penetration).

At $1,500/month average contract value = **$9M-$18M ARR potential** within 2 years.

### Why Now
1. GHL has 1M+ users and growing — your integration rides their growth
2. AI is making customers expect instant responses
3. Home service companies are being professionalized (private equity rolling them up)
4. SMS response rates are 45% vs 6% for email — your SMS-first approach wins

---

## 2. What You Have (Asset Inventory)

### Technology
- **11,363 lines of production code** across 63 files
- **53 API endpoints** covering the full lead-to-close lifecycle
- **12 database tables** with structured data model
- **6 integrations** (GHL, Google Maps, PDF, SSE, SMS, WhatsApp)
- Deployed and running: Vercel + Railway + Supabase
- **Monthly hosting cost: ~$40-$75** per client instance

### Intelligence Layer
- Speed-to-estimate tracking (the core KPI)
- Zone-based pricing optimization
- Close rate analysis by 8 dimensions (zone, ZIP, day, age, priority, location, size, time)
- Revenue attribution (which tier customers actually pick)
- Cohort analysis (weekly conversion trends)
- Missed revenue tracking (why deals don't close)

### Data Moat (grows with each client)
- Per-ZIP-code close rates across multiple companies
- Optimal pricing by geography and fence characteristics
- Response time → close rate correlation data
- Seasonal demand patterns
- Price sensitivity by market

---

## 3. Business Model Options

### Option A: Vertical SaaS (Recommended)
**Monthly subscription + setup fee**

| Tier | Monthly | Setup Fee | What's Included |
|------|--------:|----------:|-----------------|
| Starter | $497 | $1,500 | System access, 1 location, email support |
| Growth | $1,497 | $3,000 | 2 locations, priority support, analytics, monthly strategy call |
| Scale | $2,997 | $5,000 | Unlimited locations, dedicated success manager, custom integrations, weekly calls |

**Why this model:**
- Recurring revenue = high company valuation (SaaS companies valued at 8-15x ARR)
- Low churn (switching cost is high once their workflow runs through you)
- Margins are 90%+ (hosting is <$75/client)
- Scales with headcount, not hours

### Option B: RevOps Agency + Software
**Consulting fee + software**

| Service | Price | Scope |
|---------|------:|-------|
| Sales Audit | $2,500 | one-time | Analyze their current pipeline, identify leaks |
| Implementation | $5,000 | one-time | Set up system, train team, configure pricing |
| Managed Service | $2,000-$4,000/mo | Ongoing optimization, analytics reviews, VA management |

**Why this model:**
- Higher revenue per client
- Consulting justifies premium pricing
- You become embedded in their operations
- Harder to scale (requires your time)

### Option C: Hybrid (Best of Both)
**This is the McKinsey recommendation.**

1. **Land with consulting** ($2,500-$5,000 audit + setup)
2. **Expand with software** ($997-$1,997/month ongoing)
3. **Upsell with managed services** ($2,000-$4,000/month for clients who want hands-off)

**Revenue per client lifecycle:**
- Month 0: $5,000 (setup)
- Months 1-12: $1,497/month = $17,964
- **Year 1 LTV: $22,964 per client**
- **Year 2+ LTV: $17,964/year** (just subscription)

At 20 clients: **$459,000 Year 1 revenue**

---

## 4. Unit Economics

### Per Client
| Metric | Value |
|--------|------:|
| Customer Acquisition Cost (CAC) | $500-$1,500 |
| Monthly Revenue (ARPU) | $1,497 |
| Hosting Cost | $50-$75/mo |
| Support Cost (allocated) | $100-$200/mo |
| **Gross Margin** | **85-90%** |
| Monthly Gross Profit | ~$1,250 |
| **Payback Period** | **< 1 month** |
| **LTV (24-month)** | **$30,000+** |
| **LTV:CAC Ratio** | **20:1 to 60:1** |

These are elite SaaS metrics. Anything above 3:1 LTV:CAC is considered excellent.

### Break-Even Analysis
| Expense | Monthly |
|---------|--------:|
| Your time (opportunity cost) | $5,000 |
| Hosting (10 clients) | $750 |
| Tools (GHL, email, etc.) | $300 |
| **Total Monthly Cost** | **$6,050** |
| **Break-even** | **5 clients at $1,497/mo** |

---

## 5. Go-To-Market Strategy

### Phase 1: Proof of Concept (Months 1-2)
**Goal: 3 paying clients, 1 case study**

1. **Close Alan** at $1,497/month + $3,000 setup
2. Collect 30-60 days of data (close rate before vs after)
3. Build the case study: "A&T Fence Restoration reduced estimate delivery from 24 hours to 5 minutes, increasing close rate by X%"
4. Ask Alan for 2 warm referrals to other fence/pressure washing companies in Houston

**Sales script:**
> "How long does it take you to send an estimate after a lead comes in? [They say hours/next day.] What if every lead got a professional PDF proposal with pricing in under 5 minutes, automatically? We built this for A&T's Fence Restoration and they [result]. Can I show you a 10-minute demo?"

### Phase 2: Local Dominance (Months 3-6)
**Goal: 10-15 clients in Houston metro**

1. **Target:** Fence, painting, pressure washing companies in Houston using GHL
2. **Channel:** GHL Facebook groups, local contractor meetups, Google "fence staining Houston"
3. **Offer:** "Free 30-day trial, we set everything up. If your close rate doesn't improve, you pay nothing."
4. **Referral program:** Give existing clients $500 for every referral that signs up

### Phase 3: Vertical Expansion (Months 6-12)
**Goal: 30-50 clients across Texas, expand trades**

1. Adapt pricing engine for painting, pressure washing, roofing
2. Hire a part-time sales rep (commission-only: 20% of first 3 months)
3. **GHL Marketplace:** List as a GHL integration/app (free distribution to 1M+ users)
4. Create content: "Speed to Lead" YouTube channel, blog, case studies
5. **Partnership:** Approach GHL agencies who serve home service clients — white-label deal

### Phase 4: Scale (Months 12-24)
**Goal: 100+ clients, $150K+ MRR**

1. Hire customer success manager (handles onboarding + support)
2. Build self-serve onboarding (client uploads template, configures pricing themselves)
3. Multi-trade support (fence, painting, roofing, HVAC — same system, different pricing configs)
4. **Benchmarking product:** "Your close rate is 18%. Top performers in your ZIP code close at 32%. Here's what they do differently."
5. Consider fundraising if unit economics prove out (SaaS at $2M ARR with 90% margins attracts interest)

---

## 6. Competitive Landscape

### Direct Competitors
| Company | What They Do | Price | Your Advantage |
|---------|-------------|------:|----------------|
| Estimate Rocket | Estimating software | $59-$199/mo | Generic, not trade-specific. No GHL integration. No speed tracking. |
| JobNimbus | CRM for contractors | $200+/mo | CRM, not speed-to-lead. No auto-estimating. No PDF canvas editor. |
| CompanyCam | Photo documentation | $19-$49/mo | Different problem. No estimating. |
| Joist/Invoice2go | Invoicing | $10-$40/mo | Invoicing ≠ estimating. No pipeline management. |

### Indirect Competitors
| Company | Threat Level | Notes |
|---------|:----------:|-------|
| GHL itself | Medium | Could build estimating features, but they're a platform, not vertical |
| ServiceTitan | Low | Enterprise ($400+/mo), overkill for small contractors |
| Housecall Pro | Medium | Good CRM but no speed-to-lead or auto-estimate capability |

### Your Moat
1. **Speed-to-lead focus** — nobody else measures and optimizes estimate delivery time
2. **Trade-specific pricing engine** — zone-based fence staining pricing isn't in any generic tool
3. **GHL-native** — built on top of what they already use, not a replacement
4. **Data network effects** — more clients = better benchmarks = stronger product = more clients
5. **Canvas PDF editor** — professional proposals that look custom, generated in seconds

---

## 7. Product Roadmap

### Now (Built)
- [x] Lead ingestion from GHL pipeline
- [x] Auto-estimating (3-tier, zone-based)
- [x] Canvas PDF proposal editor
- [x] SMS/WhatsApp notifications
- [x] Kanban board with real-time updates
- [x] Analytics dashboard (speed, patterns, revenue, funnel)
- [x] Customer-facing proposal page
- [x] Pricing configuration page
- [x] Auth + role-based access

### Q2 2026 (Next 3 months)
- [ ] **Self-serve onboarding** — new client signs up, uploads template, configures pricing, goes live in 1 hour
- [ ] **Follow-up automations** — auto-text customer if no response in 24h, 48h, 7d
- [ ] **Customer tier selection** — buttons on proposal page: "I want Signature" → auto-records
- [ ] **Referral program built-in** — "Refer a neighbor" on proposal page
- [ ] **Multi-trade pricing** — configurable pricing engine (fence, painting, pressure washing, etc.)
- [ ] **Benchmarking** — "Your close rate vs industry average in your area"

### Q3 2026
- [ ] **GHL Marketplace listing** — free distribution
- [ ] **White-label** — agencies can brand it as their own
- [ ] **AI estimate assistant** — auto-measure fence from Google Maps satellite view
- [ ] **Customer booking** — pick a date on the proposal page → Google Calendar event
- [ ] **Stripe integration** — collect deposits online

### Q4 2026
- [ ] **Mobile app** (React Native wrapper)
- [ ] **Multi-company dashboard** — agency view across all clients
- [ ] **Predictive analytics** — "This lead has 72% chance of closing based on similar leads"
- [ ] **API for custom integrations**

---

## 8. Key Metrics to Track

### North Star Metric
**Average time from lead arrival to estimate delivery (minutes)**
- Current: not enough data yet
- Target: < 5 minutes for 80% of leads

### Business Health Metrics
| Metric | Target Month 3 | Target Month 12 |
|--------|:--------------:|:---------------:|
| Paying clients | 5 | 30 |
| MRR | $7,500 | $45,000 |
| Client churn (monthly) | < 5% | < 3% |
| Avg close rate improvement | +30% | +50% |
| NPS score | 40+ | 60+ |

### Product Metrics
| Metric | What It Tells You |
|--------|-------------------|
| Estimates sent per client per month | Product engagement |
| Avg time to estimate | Core value delivery |
| Proposal view rate | Customer experience quality |
| Close rate delta (before vs after) | ROI proof |
| DAU/MAU ratio | Stickiness |

---

## 9. Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|------|:----------:|:------:|------------|
| GHL changes API / breaks integration | Medium | High | Abstract GHL layer, support multiple CRMs |
| Client churns after 3 months | Medium | Medium | Lock in with annual contracts, prove ROI monthly |
| Competitor copies the product | Low | Medium | Data moat + relationships + speed of execution |
| Alan's business doesn't grow | Low | High | Diversify to other clients quickly, don't depend on one |
| Scaling support with clients | Medium | Medium | Build self-serve, hire CS at 15+ clients |
| Pricing resistance | Medium | Low | Offer performance guarantee: "improve close rate or money back" |

---

## 10. Immediate Action Items (Next 7 Days)

1. **Close Alan** — present the system, agree on $1,497/month + $3,000 setup. Get signed.
2. **Set up tracking** — ensure all analytics are capturing data from Day 1. This is your case study.
3. **Create a 1-pager** — one-page PDF explaining the service. "Speed to Lead: Send estimates in 5 minutes, automatically."
4. **Identify 10 prospects** — fence/painting companies in Houston using GHL. LinkedIn, Google, GHL communities.
5. **Record a demo video** — 3-minute Loom showing the system in action. Use for outreach.
6. **Set up a landing page** — simple page: problem → solution → demo video → "Book a Call" button.
7. **Ask Alan for referrals** — "Who else do you know in the industry who struggles with slow estimates?"

---

## 11. Financial Projections

### Conservative Scenario (Organic Growth)
| Month | Clients | MRR | Setup Revenue | Total Monthly |
|------:|--------:|-----:|-------------:|-------------:|
| 1 | 1 | $1,497 | $3,000 | $4,497 |
| 3 | 5 | $7,485 | $6,000 | $13,485 |
| 6 | 12 | $17,964 | $6,000 | $23,964 |
| 9 | 20 | $29,940 | $9,000 | $38,940 |
| 12 | 30 | $44,910 | $9,000 | $53,910 |

**Year 1 Total Revenue: ~$350,000**
**Year 1 Costs: ~$85,000** (your time + hosting + tools)
**Year 1 Profit: ~$265,000**

### Aggressive Scenario (With Sales Rep + GHL Marketplace)
| Month | Clients | MRR | Total Monthly |
|------:|--------:|-----:|-------------:|
| 6 | 25 | $37,425 | $52,425 |
| 12 | 75 | $112,275 | $127,275 |
| 18 | 150 | $224,550 | $239,550 |

**Year 2 ARR: $1.35M** (at 75 clients)
**Year 3 ARR: $2.7M** (at 150 clients)

At $2.7M ARR with 85% gross margins, the company is worth **$20M-$40M** at standard SaaS multiples (8-15x ARR).

---

## 12. The One Sentence

**SpeedToLead helps home service companies close more deals by delivering professional estimates to customers in under 5 minutes — automatically.**

That's your pitch. Everything else is just execution.

---

*Document prepared for internal strategy use. Not for external distribution.*
*Data based on system analysis as of April 2026.*
