"""The 8 PM estimate digest counts the same people as the Dashboard list."""
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import estimate_digest as dg  # noqa: E402


def test_counts_split_by_last_form_fill_and_skip_the_outreach_batch(db):
    from database import Contact
    now = datetime(2026, 10, 11, 20, 0, tzinfo=timezone.utc)
    for name, added, src in [
        ("today", now - timedelta(hours=3), "Facebook"),
        ("this week", now - timedelta(days=5), "Facebook"),
        ("old", now - timedelta(days=60), "Facebook"),
        ("fence company", datetime(2026, 6, 12, 10, 30, tzinfo=timezone.utc), ""),
    ]:
        db.add(Contact(id=str(uuid.uuid4()), ghl_contact_id=str(uuid.uuid4()), name=name,
                       date_added=added.isoformat().replace("+00:00", "Z"), source=src,
                       tags_json='["ad"]' if src else "[]"))
    db.commit()
    c = dg.counts(now)
    assert c == {"total": 3, "two_weeks": 2, "day": 1}
    msg = dg.daily_message(c)
    assert "Last 24 hours: 1" in msg and "Last 2 weeks: 2" in msg and "All time: 3" in msg
    assert "need an estimate" in dg.weekly_message(c)
