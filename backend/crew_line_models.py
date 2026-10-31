"""Tables for the crew line (2026-10-30). Kept out of database.py; imported
by api/crew_line.py so create_all sees them at startup."""
from sqlalchemy import Column, Index, Integer, LargeBinary, Text
from sqlalchemy.orm import deferred

from database import Base


class CrewText(Base):
    __tablename__ = "crew_texts"
    __table_args__ = (Index("idx_crew_texts_emp", "employee_id", "created_at"),)

    id = Column(Text, primary_key=True)
    employee_id = Column(Text, default="")        # empty: a number not on the crew list
    phone = Column(Text, default="")              # their number, +1…
    direction = Column(Text, default="outbound")  # inbound | outbound
    body = Column(Text, default="")
    media = Column(Text, default="")              # JSON list of picture URLs
    twilio_sid = Column(Text, default="")
    status = Column(Text, default="")
    sent_by = Column(Text, default="")
    created_at = Column(Text, default="")


class CrewCall(Base):
    __tablename__ = "crew_calls"
    __table_args__ = (Index("idx_crew_calls_emp", "employee_id", "created_at"),)

    id = Column(Text, primary_key=True)
    employee_id = Column(Text, default="")
    phone = Column(Text, default="")
    direction = Column(Text, default="outbound")
    call_sid = Column(Text, default="")
    recording_sid = Column(Text, default="")
    duration_seconds = Column(Integer, default=0)
    audio = deferred(Column(LargeBinary, nullable=True))
    transcript = Column(Text, default="")
    status = Column(Text, default="")             # ringing | recorded | transcribed | failed
    created_at = Column(Text, default="")
