"""initial schema

Revision ID: 001
Revises:
Create Date: 2026-04-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "001"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("username", sa.Text, unique=True, nullable=False),
        sa.Column("display_name", sa.Text, server_default=""),
        sa.Column("password_hash", sa.Text, nullable=False),
        sa.Column("role", sa.Text, server_default="va"),
        sa.Column("created_at", sa.Text, server_default=""),
    )

    op.create_table(
        "leads",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("ghl_contact_id", sa.Text, unique=True, nullable=True),
        sa.Column("ghl_location_id", sa.Text, server_default=""),
        sa.Column("location_label", sa.Text, server_default=""),
        sa.Column("contact_name", sa.Text, server_default=""),
        sa.Column("contact_phone", sa.Text, server_default=""),
        sa.Column("contact_email", sa.Text, server_default=""),
        sa.Column("address", sa.Text, server_default=""),
        sa.Column("zip_code", sa.Text, server_default=""),
        sa.Column("service_type", sa.Text, server_default="fence_staining"),
        sa.Column("status", sa.Text, server_default="new"),
        sa.Column("kanban_column", sa.Text, server_default="new_lead"),
        sa.Column("priority", sa.Text, server_default="MEDIUM"),
        sa.Column("form_data", sa.Text, server_default="{}"),
        sa.Column("customer_responded", sa.Boolean, server_default="false"),
        sa.Column("customer_response_text", sa.Text, server_default=""),
        sa.Column("ghl_opportunity_id", sa.Text, server_default=""),
        sa.Column("created_at", sa.Text, server_default=""),
        sa.Column("updated_at", sa.Text, server_default=""),
    )
    op.create_index("idx_leads_ghl_contact_id", "leads", ["ghl_contact_id"])
    op.create_index("idx_leads_status", "leads", ["status"])
    op.create_index("idx_leads_kanban_column", "leads", ["kanban_column"])
    op.create_index("idx_leads_created_at", "leads", ["created_at"])

    op.create_table(
        "estimates",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("lead_id", sa.Text, nullable=False),
        sa.Column("service_type", sa.Text, server_default="fence_staining"),
        sa.Column("status", sa.Text, server_default="pending"),
        sa.Column("inputs", sa.Text, server_default="{}"),
        sa.Column("breakdown", sa.Text, server_default="[]"),
        sa.Column("estimate_low", sa.Float, server_default="0"),
        sa.Column("estimate_high", sa.Float, server_default="0"),
        sa.Column("tiers", sa.Text, server_default="{}"),
        sa.Column("approval_status", sa.Text, server_default=""),
        sa.Column("approval_reason", sa.Text, server_default=""),
        sa.Column("approval_token", sa.Text, nullable=True),
        sa.Column("owner_notes", sa.Text, server_default=""),
        sa.Column("created_at", sa.Text, server_default=""),
        sa.Column("sent_at", sa.Text, nullable=True),
    )
    op.create_index("idx_estimates_lead_id", "estimates", ["lead_id"])
    op.create_index("idx_estimates_status", "estimates", ["status"])
    op.create_index("idx_estimates_sent_at", "estimates", ["sent_at"])

    op.create_table(
        "proposals",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("token", sa.Text, unique=True, nullable=False),
        sa.Column("estimate_id", sa.Text, nullable=False),
        sa.Column("lead_id", sa.Text, nullable=False),
        sa.Column("status", sa.Text, server_default="sent"),
        sa.Column("proposal_version", sa.Text, server_default="pdf"),
        sa.Column("pdf_data", sa.LargeBinary, nullable=True),
        sa.Column("pdf_page_count", sa.Integer, server_default="0"),
        sa.Column("first_viewed_at", sa.Text, nullable=True),
        sa.Column("created_at", sa.Text, server_default=""),
    )

    op.create_table(
        "proposal_pages",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("proposal_id", sa.Text, nullable=False),
        sa.Column("token", sa.Text, nullable=False),
        sa.Column("page_num", sa.Integer, nullable=False),
        sa.Column("image_data", sa.LargeBinary, nullable=False),
        sa.Column("created_at", sa.Text, server_default=""),
    )
    op.create_index("idx_proposal_pages_token_page", "proposal_pages", ["token", "page_num"])

    op.create_table(
        "messages",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("ghl_contact_id", sa.Text, server_default=""),
        sa.Column("lead_id", sa.Text, nullable=True),
        sa.Column("direction", sa.Text, server_default="inbound"),
        sa.Column("body", sa.Text, server_default=""),
        sa.Column("message_type", sa.Text, server_default="SMS"),
        sa.Column("ghl_message_id", sa.Text, nullable=True, unique=True),
        sa.Column("created_at", sa.Text, server_default=""),
    )
    op.create_index("idx_messages_lead_id", "messages", ["lead_id"])
    op.create_index("idx_messages_ghl_message_id", "messages", ["ghl_message_id"])

    op.create_table(
        "pricing_config",
        sa.Column("service_type", sa.Text, primary_key=True),
        sa.Column("config", sa.Text, server_default="{}"),
        sa.Column("updated_at", sa.Text, server_default=""),
    )

    op.create_table(
        "automation_log",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("lead_id", sa.Text, nullable=True),
        sa.Column("event_type", sa.Text, server_default=""),
        sa.Column("detail", sa.Text, server_default=""),
        sa.Column("metadata_json", sa.Text, server_default="{}"),
        sa.Column("created_at", sa.Text, server_default=""),
    )

    op.create_table(
        "ghl_field_mapping",
        sa.Column("ghl_field_id", sa.Text, primary_key=True),
        sa.Column("ghl_field_key", sa.Text, server_default=""),
        sa.Column("ghl_field_name", sa.Text, server_default=""),
        sa.Column("our_field_name", sa.Text, nullable=True),
        sa.Column("created_at", sa.Text, server_default=""),
    )

    op.create_table(
        "notifications_log",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("lead_id", sa.Text, nullable=False),
        sa.Column("channel", sa.Text, server_default=""),
        sa.Column("recipient", sa.Text, server_default=""),
        sa.Column("event", sa.Text, server_default=""),
        sa.Column("detail", sa.Text, server_default=""),
        sa.Column("created_at", sa.Text, server_default=""),
    )

    op.create_table(
        "pdf_templates",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("filename", sa.Text, server_default=""),
        sa.Column("pdf_data", sa.LargeBinary, nullable=True),
        sa.Column("page_count", sa.Integer, server_default="0"),
        sa.Column("field_map", sa.Text, server_default="{}"),
        sa.Column("created_at", sa.Text, server_default=""),
        sa.Column("updated_at", sa.Text, server_default=""),
    )


def downgrade() -> None:
    op.drop_table("pdf_templates")
    op.drop_table("notifications_log")
    op.drop_table("ghl_field_mapping")
    op.drop_table("automation_log")
    op.drop_table("pricing_config")
    op.drop_table("messages")
    op.drop_table("proposal_pages")
    op.drop_table("proposals")
    op.drop_table("estimates")
    op.drop_table("leads")
    op.drop_table("users")
