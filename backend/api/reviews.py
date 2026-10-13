"""Google reviews: the public list the proposal shows, and the office's
refresh and hide controls (services/google_reviews.py)."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.auth import require_admin, require_staff
from database import get_db, GoogleReview
from services import google_reviews as gr
from services.activity_log import log_event

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/public/reviews")
def public_reviews():
    """Public. Five-star reviews with words, newest first, plus the counts."""
    db = get_db()
    try:
        return gr.public_reviews(db)
    finally:
        db.close()


@router.get("/reviews")
def list_reviews(user: dict = Depends(require_staff)):
    del user
    db = get_db()
    try:
        rows = db.query(GoogleReview).order_by(GoogleReview.reviewed_at.desc(), GoogleReview.fetched_at.desc()).all()
        return {"configured": gr.configured(), "summary": gr.summary(db), "reviews": [gr.review_dict(r) for r in rows]}
    finally:
        db.close()


@router.post("/reviews/refresh")
def refresh_reviews(user: dict = Depends(require_admin)):
    db = get_db()
    try:
        try:
            out = gr.refresh(db)
        except Exception as e:  # noqa: BLE001 - the reason is the answer
            logger.warning("Google reviews refresh failed: %s", e)
            raise HTTPException(status_code=502, detail=f"Couldn't pull the reviews: {e}")
        log_event(None, "google_reviews_refreshed", f"{out.get('five_star')} five-star of {out.get('total')} by {user.get('name') or user.get('sub') or ''}")
        return out
    finally:
        db.close()


class HideBody(BaseModel):
    hidden: bool


@router.post("/reviews/{review_id}/hide")
def hide_review(review_id: str, body: HideBody, user: dict = Depends(require_admin)):
    db = get_db()
    try:
        row = db.query(GoogleReview).filter(GoogleReview.id == review_id).first()
        if row is None:
            raise HTTPException(status_code=404, detail="Not found")
        row.hidden = bool(body.hidden)
        db.commit()
        log_event(None, "google_review_hidden" if body.hidden else "google_review_shown", f"{row.author} by {user.get('name') or user.get('sub') or ''}")
        return gr.review_dict(row)
    finally:
        db.close()
