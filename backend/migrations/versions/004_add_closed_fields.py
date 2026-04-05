"""add closed_tier and closed_at to estimates

Revision ID: 004
Revises: 003
Create Date: 2026-04-04

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "004"
down_revision: Union[str, Sequence[str], None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("estimates", sa.Column("closed_tier", sa.Text, nullable=True))
    op.add_column("estimates", sa.Column("closed_at", sa.Text, nullable=True))


def downgrade() -> None:
    op.drop_column("estimates", "closed_tier")
    op.drop_column("estimates", "closed_at")
