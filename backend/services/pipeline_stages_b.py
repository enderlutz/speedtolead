"""
GHL pipeline stage constants for STERLING LEADS B — the twin of A.

Mirror of services/pipeline_stages.py, but for the "STERLING" GHL pipeline
(pipeline id QSiqDNrxlwExuqcxi5IX, Cypress location). B leads are stamped
pipeline_version="v2b". Kept in a separate module (like the fence pipeline's
own file) so A's constants are never touched.

STERLING is nearly identical to A's fence pipeline: 16 stages match A by
name/order; 3 are STERLING-only (ESTIMATE SCHEDULED, No response to
scheduling, Painting Upsell). Keep this list in sync with the B_STAGES array
in frontend/src/pages/LeadsB.tsx, in matching order.
"""
from __future__ import annotations

# The B leads' pipeline_version discriminator (consistent with A's "v2").
PIPELINE_VERSION_B = "v2b"

# Full ordered list — mirrors B_STAGES in frontend/src/pages/LeadsB.tsx.
# Tuple shape: (stage_id, human-readable name as it appears in GHL).
V2B_STAGE_IDS_IN_ORDER: list[tuple[str, str]] = [
    ("13dd5565-5d19-4ebd-bb84-5e57fdfc848e", "New Lead"),
    ("3883dc86-e182-4633-9308-cbcc085abc02", "HOT LEAD_SEND ESTIMATE"),
    ("b382eea2-670c-4d3f-b2a1-a6053ce6e412", "ESTIMATE SCHEDULED"),
    ("a17b60c4-ea92-4703-bdb2-d7de1661ba1a", "No response to scheduling"),
    ("43a325dd-76ba-4aaf-aba1-f950ac2dd187", "Address Follow Up"),
    ("a7f4039b-0425-492e-a50b-30bf37ad432f", "Responded To ADDRESS Follow Up"),
    ("8c082ba1-95ea-467e-a225-c1750b611bbe", "ESTIMATE SENT"),
    ("dacf7848-c812-4d33-86ef-d70fc4e4e479", "ESTIMATE_FOLLOW UP LATER"),
    ("f7a09296-a9bb-4d69-9398-28c495743b4b", "RESPONDED TO ESTIMATE"),
    ("26a01635-5f91-415d-a6c1-671d15c6bd36", "Top Priority-Responded to Estimate"),
    ("b5f54570-4077-4d83-97e7-328201373930", "DECLINED ESTIMATE"),
    ("43fa0566-e118-4e70-81ff-429c3afa22e3", "DEAL CLOSED & NOT SCHEDULED"),
    ("09d3a03d-0571-4fd8-b677-9a74d15a094d", "CLOSED & SCHEDULED"),
    ("64d3e3e1-c91c-49e8-86ba-e2d4c8699a72", "COMPLETED JOB-HAPPY CUSTOMER- SEND REVIEW"),
    ("aac2bf8e-27ee-4301-81f6-9b5bf39b61ec", "COMPLETED JOB- UNHAPPY CUSTOMER"),
    ("084b08b5-a217-4b54-9506-28dd68107468", "LONG TERM NURTURE"),
    ("969a4e4b-535c-4215-b91c-cbf6867754ad", "Responded to long term nurture"),
    ("64dccea5-049f-4c3d-9c26-1142170dd0b6", "Cold Leads (Never answered)"),
    ("c54b66d1-0a65-40f7-b851-27d714b76936", "Painting Upsell"),
]

# Fast lookups derived from the ordered list above.
KNOWN_STAGE_IDS_B: set[str] = {sid for sid, _ in V2B_STAGE_IDS_IN_ORDER}
STAGE_NAME_BY_ID_B: dict[str, str] = {sid: name for sid, name in V2B_STAGE_IDS_IN_ORDER}

# Named single-stage constants used across the codebase (B equivalents of A's).
NEW_LEAD_STAGE_ID_B = "13dd5565-5d19-4ebd-bb84-5e57fdfc848e"
HOT_LEAD_STAGE_ID_B = "3883dc86-e182-4633-9308-cbcc085abc02"          # reply P01 target
ESTIMATE_SENT_STAGE_ID_B = "8c082ba1-95ea-467e-a225-c1750b611bbe"    # estimate-sent move / timer / self-heal
RESPONDED_TO_ESTIMATE_STAGE_ID_B = "f7a09296-a9bb-4d69-9398-28c495743b4b"  # reply P04 target
DECLINED_STAGE_ID_B = "b5f54570-4077-4d83-97e7-328201373930"
CLOSED_SCHEDULED_STAGE_ID_B = "09d3a03d-0571-4fd8-b677-9a74d15a094d"
CLOSED_NOT_SCHEDULED_STAGE_ID_B = "43fa0566-e118-4e70-81ff-429c3afa22e3"
COMPLETED_HAPPY_STAGE_ID_B = "64d3e3e1-c91c-49e8-86ba-e2d4c8699a72"
COMPLETED_UNHAPPY_STAGE_ID_B = "aac2bf8e-27ee-4301-81f6-9b5bf39b61ec"

# Terminal stages — leads here leave the Daily Task List working queue and
# have their follow-up guard applied. Matches A's set: declined + closed &
# scheduled + both completed. ("Closed — not scheduled" deliberately stays.)
TERMINAL_STAGE_IDS_B: set[str] = {
    DECLINED_STAGE_ID_B,
    CLOSED_SCHEDULED_STAGE_ID_B,
    COMPLETED_HAPPY_STAGE_ID_B,
    COMPLETED_UNHAPPY_STAGE_ID_B,
}

# Call List panel range: ESTIMATE SENT through DEAL CLOSED & NOT SCHEDULED.
# Mirrors A's CALL_LIST_STAGE_IDS (excludes declined + closed & scheduled).
CALL_LIST_STAGE_IDS_B: set[str] = {
    "8c082ba1-95ea-467e-a225-c1750b611bbe",  # ESTIMATE SENT
    "dacf7848-c812-4d33-86ef-d70fc4e4e479",  # ESTIMATE_FOLLOW UP LATER
    "f7a09296-a9bb-4d69-9398-28c495743b4b",  # RESPONDED TO ESTIMATE
    "26a01635-5f91-415d-a6c1-671d15c6bd36",  # Top Priority-Responded to Estimate
    "43fa0566-e118-4e70-81ff-429c3afa22e3",  # DEAL CLOSED & NOT SCHEDULED
}

# One-time opportunity-value backfill scope — mirrors A's set (leads that have
# ever had an estimate; excludes pre-estimate + closed & scheduled + completed).
OPP_VALUE_BACKFILL_STAGE_IDS_B: set[str] = {
    "8c082ba1-95ea-467e-a225-c1750b611bbe",  # ESTIMATE SENT
    "dacf7848-c812-4d33-86ef-d70fc4e4e479",  # ESTIMATE_FOLLOW UP LATER
    "f7a09296-a9bb-4d69-9398-28c495743b4b",  # RESPONDED TO ESTIMATE
    "26a01635-5f91-415d-a6c1-671d15c6bd36",  # Top Priority-Responded to Estimate
    "b5f54570-4077-4d83-97e7-328201373930",  # DECLINED ESTIMATE
    "43fa0566-e118-4e70-81ff-429c3afa22e3",  # DEAL CLOSED & NOT SCHEDULED
    "084b08b5-a217-4b54-9506-28dd68107468",  # LONG TERM NURTURE
    "969a4e4b-535c-4215-b91c-cbf6867754ad",  # Responded to long term nurture
    "64dccea5-049f-4c3d-9c26-1142170dd0b6",  # Cold Leads (Never answered)
}
