"""Painting Upsell pipeline — stage definitions.

The Painting Upsell pipeline is a dashboard-only view (no GHL mirror)
that holds leads we've pulled in from the old GHL account's
COMPLETED JOB-HAPPY CUSTOMER- SEND REVIEW stage. The team uses the
Upsell tab on each lead to pitch exterior painting; when one books, we
push that single lead into the NEW GHL account as a v2 lead.

Stages are intentionally simple so the kanban doesn't feel cluttered.
Status values match the column the lead belongs in.
"""
from __future__ import annotations

# Stage IDs are local-only — they never appear in any GHL account.
# Prefix `pu_` so they're trivially distinguishable in logs from real
# GHL stage UUIDs.
PAINTING_UPSELL_STAGES = [
    {
        "id": "pu_new",
        "label": "New (Imported)",
        "short": "New",
        "header_cls": "bg-slate-100 text-slate-700",
        "bg_cls": "bg-slate-50/30",
        "dot_cls": "bg-slate-500",
    },
    {
        "id": "pu_contacted",
        "label": "Contacted",
        "short": "Contacted",
        "header_cls": "bg-orange-100 text-orange-800",
        "bg_cls": "bg-orange-50/30",
        "dot_cls": "bg-orange-500",
    },
    {
        "id": "pu_interested",
        "label": "Interested",
        "short": "Interested",
        "header_cls": "bg-yellow-100 text-yellow-800",
        "bg_cls": "bg-yellow-50/30",
        "dot_cls": "bg-yellow-500",
    },
    {
        "id": "pu_booked",
        "label": "Booked Exterior (push to v2)",
        "short": "Booked",
        "header_cls": "bg-emerald-100 text-emerald-800",
        "bg_cls": "bg-emerald-50/30",
        "dot_cls": "bg-emerald-500",
    },
    {
        "id": "pu_declined",
        "label": "Declined",
        "short": "Declined",
        "header_cls": "bg-stone-200 text-stone-700",
        "bg_cls": "bg-stone-50/40",
        "dot_cls": "bg-stone-500",
    },
]

# Default landing stage for freshly-imported leads.
PAINTING_UPSELL_NEW_STAGE = "pu_new"
PAINTING_UPSELL_BOOKED_STAGE = "pu_booked"

# pipeline_version value on Lead rows. Distinguishes these from v1
# (legacy untouched), v2 (live), and any future migration source.
PIPELINE_VERSION = "painting_upsell"


def stage_ids() -> set[str]:
    return {s["id"] for s in PAINTING_UPSELL_STAGES}


def is_valid_stage(stage_id: str) -> bool:
    return stage_id in stage_ids()
