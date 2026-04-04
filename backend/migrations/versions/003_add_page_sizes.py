"""add page_sizes_json to pdf_templates

Revision ID: 003
Revises: 002
Create Date: 2026-04-04

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "003"
down_revision: Union[str, Sequence[str], None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("pdf_templates", sa.Column("page_sizes_json", sa.Text, server_default="[]"))


def downgrade() -> None:
    op.drop_column("pdf_templates", "page_sizes_json")
