"""add is_test to leads

Revision ID: 005
Revises: 004
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "005"
down_revision: Union[str, Sequence[str], None] = "004"

def upgrade() -> None:
    op.add_column("leads", sa.Column("is_test", sa.Boolean, server_default="false"))

def downgrade() -> None:
    op.drop_column("leads", "is_test")
