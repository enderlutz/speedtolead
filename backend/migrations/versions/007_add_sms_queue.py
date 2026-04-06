"""add sms_queue table for scheduled messages

Revision ID: 007
Revises: 006
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "007"
down_revision: Union[str, Sequence[str], None] = "006"


def upgrade() -> None:
    op.create_table(
        "sms_queue",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("lead_id", sa.Text, nullable=False),
        sa.Column("ghl_contact_id", sa.Text, nullable=False),
        sa.Column("ghl_location_id", sa.Text, server_default=""),
        sa.Column("message_body", sa.Text, nullable=False),
        sa.Column("proposal_url", sa.Text, server_default=""),
        sa.Column("send_at", sa.Text, nullable=False),
        sa.Column("sent_at", sa.Text, nullable=True),
        sa.Column("status", sa.Text, server_default="pending"),
        sa.Column("error_message", sa.Text, server_default=""),
        sa.Column("attempts", sa.Integer, server_default="0"),
        sa.Column("created_at", sa.Text, server_default=""),
    )
    op.create_index("idx_sms_queue_pending", "sms_queue", ["send_at"])
    op.create_index("idx_sms_queue_lead", "sms_queue", ["lead_id"])


def downgrade() -> None:
    op.drop_index("idx_sms_queue_lead")
    op.drop_index("idx_sms_queue_pending")
    op.drop_table("sms_queue")
