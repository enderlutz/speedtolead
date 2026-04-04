# AT-System Lite

Lightweight version of A&T's Fence Restoration estimating dashboard.

## Tech Stack
- **Frontend:** React + Vite + shadcn/ui + Tailwind CSS + TypeScript (port 5173)
- **Backend:** FastAPI + Python + SQLite/SQLAlchemy (port 8000)
- **PDF:** PyMuPDF (fitz) template fill
- **Notifications:** GHL API (SMS to Alan, WhatsApp to Olga)

## Running Locally
```bash
# Backend
cd backend && source .venv/bin/activate && uvicorn main:app --reload --port 8000

# Frontend
cd frontend && npm run dev
```

## Core Flow
1. Lead comes in via GHL webhook or 5-min poller (Cypress + Woodlands)
2. Auto-estimate calculated, lead placed on kanban board
3. Alan (SMS) + Olga (WhatsApp) notified with link to lead page
4. VA opens lead detail, refines estimate inputs, clicks Save & Recalculate
5. VA clicks Approve & Send -> PDF generated, Alan + Olga notified

## Kanban Columns
- New Lead (gray) | Asking for Address (purple) | Address Correct (orange) | Hot Lead (green) | Needs Review (red)

## Key Decisions
- SQLite for simplicity (no PostgreSQL needed)
- No auth (local-only dashboard)
- Hardcoded pricing (no settings UI)
- Both notifications go through GHL (SMS + WhatsApp channels)
