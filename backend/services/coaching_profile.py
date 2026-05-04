"""
Coaching profile — self-learning summary of how leadership coaches the VA.

Claude reads all the CallReview rows that admins (Alan, etc.) have written on
Olga's calls and distills them into a coaching profile. That profile gets
injected into every future call analysis as calibration so the AI Call Coach
aligns with how Alan actually thinks about quality, not just the static rubric.

Auto-regenerates when 5+ new reviews land since the last profile snapshot.
Append-only history — old profiles are kept for traceability.
"""
from __future__ import annotations
import json
import logging
import threading
import uuid
from datetime import datetime, timezone
from sqlalchemy.orm import Session
from database import get_db, CallReview, CoachingProfile
from config import get_settings

logger = logging.getLogger(__name__)


REGEN_THRESHOLD = 5  # new reviews since last profile snapshot before auto-regen


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_active_profile(db: Session) -> CoachingProfile | None:
    """Return the most recent profile snapshot — that's the active calibration
    for new call analyses."""
    return (
        db.query(CoachingProfile)
        .order_by(CoachingProfile.created_at.desc())
        .first()
    )


def _count_reviews(db: Session) -> int:
    return db.query(CallReview).count()


_PROFILE_PROMPT = """You are summarizing how the owner of A&T's Fence Staining (Alan) and his admins coach their VA (Olga) on her lead intake calls. Below is every coaching review they have left on Olga's recorded calls over time.

Your job: distill these reviews into a coaching profile that an AI Call Coach can use as calibration when evaluating future calls. The AI Call Coach already has a static rubric (the call script + boundary rules). Your profile is the LIVING overlay — Alan's actual style, recurring themes, and pet peeves.

Focus on:
- Recurring themes Alan emphasizes across multiple reviews
- Phrases or approaches he praises
- Pet peeves / patterns he flags repeatedly
- Boundaries he enforces beyond the static rubric
- Tone preferences (warm vs direct, brief vs thorough)

Output 200-400 words of plain text. Write it as guidance addressed to the AI Call Coach in second person ("When you evaluate a call, pay attention to..."). No JSON, no markdown headers — just flowing text the model can read as context.

If there are very few reviews to learn from, say so honestly and keep the profile short. Don't invent themes that aren't in the data.

REVIEWS:

"""


def generate_coaching_profile(db: Session, generated_by: str = "system") -> CoachingProfile | None:
    """Pull every review, ask Claude to distill them into a profile, save a
    new snapshot. Returns the new row, or None if there are no reviews to
    learn from yet or the API call fails."""
    settings = get_settings()
    if not settings.anthropic_api_key:
        logger.warning("Coaching profile regen skipped — no ANTHROPIC_API_KEY")
        return None

    reviews = (
        db.query(CallReview)
        .order_by(CallReview.created_at.asc())
        .all()
    )
    if not reviews:
        logger.info("Coaching profile regen skipped — no reviews yet")
        return None

    review_blocks = []
    for r in reviews:
        when = r.created_at or ""
        who = r.reviewer_name or "Admin"
        review_blocks.append(f"[{when}] {who}: {r.text}")
    reviews_text = "\n\n".join(review_blocks)

    import anthropic
    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    try:
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=800,
            system=[{"type": "text", "text": _PROFILE_PROMPT, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": reviews_text}],
        )
        text = response.content[0].text if response.content else ""
        usage = response.usage
        logger.info(f"Profile regen | input={usage.input_tokens} | output={usage.output_tokens}")

        profile = CoachingProfile(
            id=str(uuid.uuid4()),
            profile_text=text.strip(),
            reviews_count_at_gen=len(reviews),
            generated_by=generated_by,
            created_at=_now(),
        )
        db.add(profile)
        db.commit()
        logger.info(f"Coaching profile regenerated from {len(reviews)} reviews")
        return profile
    except Exception as e:
        logger.error(f"Coaching profile generation failed: {e}")
        db.rollback()
        return None


def maybe_regenerate_profile_async(threshold: int = REGEN_THRESHOLD) -> None:
    """Check if enough new reviews have accumulated since the last profile
    snapshot and trigger a regen in a background thread if so. Safe to call
    after every new review — cheap when there's nothing to do."""
    def _run():
        db = get_db()
        try:
            active = get_active_profile(db)
            current_count = _count_reviews(db)
            baseline = active.reviews_count_at_gen if active else 0
            if (current_count - baseline) < threshold:
                return
            logger.info(f"Auto-regen: {current_count - baseline} new reviews since last profile (threshold={threshold})")
            generate_coaching_profile(db, generated_by="system")
        except Exception as e:
            logger.error(f"maybe_regenerate_profile_async failed: {e}")
        finally:
            db.close()

    threading.Thread(target=_run, daemon=True).start()


def fetch_recent_reviews(db: Session, limit: int = 5, exclude_recording_id: str | None = None) -> list[dict]:
    """Return the last N reviews as dicts for prompt injection."""
    q = db.query(CallReview)
    if exclude_recording_id:
        q = q.filter(CallReview.recording_id != exclude_recording_id)
    rows = q.order_by(CallReview.created_at.desc()).limit(limit).all()
    return [
        {
            "reviewer": r.reviewer_name or "Admin",
            "created_at": r.created_at,
            "text": r.text,
        }
        for r in rows
    ]
