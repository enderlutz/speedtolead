"""Tables for Alan's Plaud recordings (2026-10-31). Imported by api/plaud.py
so create_all sees them at startup."""
from sqlalchemy import Column, Index, Text

from database import Base


class PlaudNote(Base):
    __tablename__ = "plaud_notes"
    __table_args__ = (Index("idx_plaud_notes_at", "recorded_at"),)

    id = Column(Text, primary_key=True)
    plaud_id = Column(Text, default="")        # Plaud's own id, or a hash of the text
    title = Column(Text, default="")
    recorded_at = Column(Text, default="")     # ISO, when Plaud says it was recorded
    transcript = Column(Text, default="")
    summary = Column(Text, default="")
    received_at = Column(Text, default="")


class PlaudBrief(Base):
    __tablename__ = "plaud_briefs"

    day = Column(Text, primary_key=True)       # YYYY-MM-DD, Houston
    body = Column(Text, default="")
    text_sent = Column(Text, default="")
    created_at = Column(Text, default="")


class PlaudKey(Base):
    """The secret in the address Zapier posts to. Made on first look, shown
    only on Alan's page, never in chat or the code."""
    __tablename__ = "plaud_keys"

    id = Column(Text, primary_key=True)        # always "main"
    key = Column(Text, default="")
    created_at = Column(Text, default="")
