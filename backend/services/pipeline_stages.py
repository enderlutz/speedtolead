"""
GHL pipeline stage constants — mirror of frontend V2_STAGES.

The dashboard's stage list is hardcoded for kanban layout stability. This
file is the backend's source of truth for which GHL stage IDs we know
about. When Alan adds new stages in GHL:

  1. Run `GET /api/admin/ghl-stage-diff` (admin-only). It compares the
     live GHL stages against this file and lists what's missing.
  2. Add the missing entries to V2_STAGE_IDS_IN_ORDER below (and to the
     same list in frontend/src/pages/LeadsV2.tsx, in matching order).
  3. If a new stage belongs in CALL_LIST_STAGE_IDS or any other named
     subset, add it there too.

Why a hand-maintained constant instead of dynamic sync: stage IDs are
referenced as named constants across the codebase (V2_ESTIMATE_SENT_STAGE_ID,
CLOSED_SCHEDULED_STAGE_ID, etc.). A dynamic table would require touching
every import site. Additive-only stage changes don't justify the refactor.
"""
from __future__ import annotations

# Full ordered list — mirrors V2_STAGES in frontend/src/pages/LeadsV2.tsx.
# Tuple shape: (stage_id, human-readable name as it appears in GHL).
V2_STAGE_IDS_IN_ORDER: list[tuple[str, str]] = [
    ("e77fa568-8dd1-4f66-83c3-fa70dbd4d570", "New Lead"),
    ("616087fa-4144-454e-b3d3-ff3669cb9461", "HOT LEAD_SEND ESTIMATE"),
    ("86fd0197-38ee-4999-bd26-4cf175aeba6b", "Address Follow Up"),
    ("92585169-bbc1-42c5-945d-63caf780e0b1", "Responded to Address Follow Up"),
    # Pre-estimate calling campaign — warm-up calls before quote sent.
    ("1e8a52ac-a85a-4ee6-bcd5-0699ff64d3a7", "Call 1 Pre Estimate"),
    ("fe74a5e6-e173-4783-a8a9-1f28168a6c1b", "Call 2 Pre Estimate"),
    ("3020bb38-8c84-455d-a840-3650fbe50ecd", "Call 3 Pre Estimate"),
    ("dc3600f2-009b-4075-95fa-786823131416", "ESTIMATE SENT"),
    ("3ed8e7e3-6852-469c-bb72-effc1b6df76c", "ESTIMATE_FOLLOW UP LATER"),
    ("8e1eb2cd-b9db-4eb7-aacf-901945cfca9b", "RESPONDED TO ESTIMATE"),
    ("147bd53b-3848-449d-b7c2-7a2cfad2a5f5", "Top Priority-Responded to Estimate"),
    # Post-estimate callback campaign — aggressive follow-up after quote
    # sent. All seven feed into the Call List panel (see CALL_LIST_STAGE_IDS).
    ("1cca8bd9-83a4-4138-84bf-10d38efa0e49", "Call 1 Post Estimate"),
    ("1ad50871-3d2f-460a-bb38-6ca586aeef36", "Call 2 Post Estimate"),
    ("9f348720-939a-4064-b50f-3b391fb7b281", "Call 3 Post Estimate"),
    ("a2e09473-5711-4fbc-b246-2f5d70efc5d2", "Call 4 Post Estimate"),
    ("f9b4c5d3-d72c-4a64-b799-d9fcab0624a8", "Call 5 Post Estimate"),
    ("07de5d8f-11db-448c-9af8-1d92aa8d36d7", "Call 6 Post Estimate"),
    ("73b2553d-4b42-461c-8857-48e7d9c73191", "Call 7 Post Estimate"),
    ("f207a600-81c9-4150-941c-e977ea876929", "DECLINED ESTIMATE"),
    ("bbebbdac-0011-4253-9ed7-65522bafde02", "DEAL CLOSED & NOT SCHEDULED"),
    ("3eed5964-573f-445e-a181-1ee28068f066", "CLOSED & SCHEDULED"),
    ("c77b052f-845c-47e9-bba2-4cdba35a94d0", "COMPLETED JOB-HAPPY CUSTOMER- SEND REVIEW"),
    ("5f2cea8e-1f10-411b-b5fd-fa7ffa40cdcc", "COMPLETED JOB- UNHAPPY CUSTOMER"),
    ("d836628c-3094-4a63-b95a-8a5358d251d0", "LONG TERM NURTURE"),
    ("8e17bd4c-5181-40b9-ba1e-bbe9b0547c01", "Responded to long term nurture"),
    ("0ca2e2a6-2990-4a5b-8ace-608393e39b5a", "Cold Leads (Never answered)"),
]

# Fast lookup sets derived from the ordered list above.
KNOWN_STAGE_IDS: set[str] = {sid for sid, _ in V2_STAGE_IDS_IN_ORDER}
STAGE_NAME_BY_ID: dict[str, str] = {sid: name for sid, name in V2_STAGE_IDS_IN_ORDER}

# Stages where the Call List panel surfaces leads for the sales-call
# campaign. Range: ESTIMATE SENT through DEAL CLOSED & NOT SCHEDULED,
# including ALL seven "Call N Post Estimate" callback stages.
# Explicitly EXCLUDES:
#   - DECLINED ESTIMATE (per user — dead leads don't belong in a call queue)
#   - Pre-estimate call stages (before ESTIMATE SENT — outside the range)
#   - CLOSED & SCHEDULED and downstream (already won — no callback needed)
CALL_LIST_STAGE_IDS: set[str] = {
    "dc3600f2-009b-4075-95fa-786823131416",  # ESTIMATE SENT
    "3ed8e7e3-6852-469c-bb72-effc1b6df76c",  # ESTIMATE_FOLLOW UP LATER
    "8e1eb2cd-b9db-4eb7-aacf-901945cfca9b",  # RESPONDED TO ESTIMATE
    "147bd53b-3848-449d-b7c2-7a2cfad2a5f5",  # Top Priority-Responded to Estimate
    # Post-estimate callback campaign (added 2026-05-31 — aggressive call sequence)
    "1cca8bd9-83a4-4138-84bf-10d38efa0e49",  # Call 1 Post Estimate
    "1ad50871-3d2f-460a-bb38-6ca586aeef36",  # Call 2 Post Estimate
    "9f348720-939a-4064-b50f-3b391fb7b281",  # Call 3 Post Estimate
    "a2e09473-5711-4fbc-b246-2f5d70efc5d2",  # Call 4 Post Estimate
    "f9b4c5d3-d72c-4a64-b799-d9fcab0624a8",  # Call 5 Post Estimate
    "07de5d8f-11db-448c-9af8-1d92aa8d36d7",  # Call 6 Post Estimate
    "73b2553d-4b42-461c-8857-48e7d9c73191",  # Call 7 Post Estimate
    "bbebbdac-0011-4253-9ed7-65522bafde02",  # DEAL CLOSED & NOT SCHEDULED
}
