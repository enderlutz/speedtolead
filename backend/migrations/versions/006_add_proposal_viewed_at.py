"""add proposal_viewed_at to leads

Revision ID: 006
Revises: 005
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "006"
down_revision: Union[str, Sequence[str], None] = "005"

def upgrade() -> None:
    op.add_column("leads", sa.Column("proposal_viewed_at", sa.Text, nullable=True))

def downgrade() -> None:
    op.drop_column("leads", "proposal_viewed_at")
