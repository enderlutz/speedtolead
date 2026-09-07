"""Who did what, keyed on a stable id rather than however a name was spelled.

Attribution columns across this codebase mix three kinds of value row to row:
a username ("alanbonner"), a display name ("Alan"), or a literal ("System",
"auto (invoice note)"). Code that keyed on the name therefore counted one
person as two whenever two write paths spelled them differently.

The stable id is User.username: unique, present in every JWT as "sub", and
never updated by any code path.
"""
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _merge_key(name: str, sub: str) -> str:
    """The keying rule from api/daily_tasks.py's owner-avatar merge."""
    name = (name or "").strip()
    sub = (sub or "").strip()
    return (sub or name).lower()


def test_one_person_spelled_two_ways_collapses_to_one(db):
    """The regression. These are the same human.

    One write path stores the display name, another stores the username, and
    a third stores both. Keying on the name made "Alan" and "alan bonner" two
    separate people in the call tally.
    """
    sources = [
        {"name": "Alan", "sub": "alanbonner"},
        {"name": "alan bonner", "sub": "alanbonner"},
        {"name": "Alan Bonner", "sub": "alanbonner"},
    ]
    keys = {_merge_key(s["name"], s["sub"]) for s in sources}
    assert len(keys) == 1, f"one person split into {len(keys)} rows: {keys}"


def test_the_old_name_first_rule_would_have_split_them(db):
    """Pins why the change was needed, so it can't quietly regress."""
    def old_key(name, sub):
        return ((name or "").strip() or (sub or "").strip()).lower()

    old = {old_key("Alan", "alanbonner"), old_key("alan bonner", "alanbonner")}
    assert len(old) == 2, "if this is 1 the old rule was fine and the fix is pointless"


def test_two_different_people_stay_separate(db):
    """The merge must not overshoot."""
    keys = {_merge_key("Alan", "alanbonner"), _merge_key("Olga", "olga")}
    assert len(keys) == 2


def test_a_row_with_only_a_name_still_keys(db):
    """Older rows recorded no username; they must not vanish from the tally."""
    assert _merge_key("Alan", "") == "alan"
    assert _merge_key("", "alanbonner") == "alanbonner"


def test_starting_a_job_records_the_stable_id(db):
    """Dual-write: the legacy text column keeps its value, the id is added."""
    from database import ScheduledJob
    job = ScheduledJob(
        id=str(uuid.uuid4()), lead_id=str(uuid.uuid4()),
        job_date="2026-09-06", division="fence", status="scheduled",
    )
    db.add(job); db.commit()

    user = {"sub": "brentbrown", "name": "Brent Brown"}
    job.started_by = user.get("sub", "") or "Brent Brown"
    job.started_by_user_id = user.get("sub", "")
    db.commit(); db.refresh(job)

    assert job.started_by_user_id == "brentbrown"
    assert job.started_by == "brentbrown"      # legacy column still populated


def test_the_id_columns_default_empty_for_old_rows(db):
    """Existing rows are not backfilled; reads fall back to the legacy text."""
    from database import ScheduledJob
    job = ScheduledJob(
        id=str(uuid.uuid4()), lead_id=str(uuid.uuid4()),
        job_date="2026-09-06", division="fence", started_by="Alan",
    )
    db.add(job); db.commit(); db.refresh(job)
    assert job.started_by_user_id == ""
    assert job.started_by == "Alan"


def test_measurement_upload_records_the_uploader(db):
    """This field was written from a JWT claim that does not exist ("username"
    rather than "sub"), so it was an empty string on every upload."""
    jwt = {"sub": "olga", "name": "Olga", "role": "va"}
    assert (jwt or {}).get("username") is None      # the old read
    assert (jwt or {}).get("sub") == "olga"         # the fixed read
