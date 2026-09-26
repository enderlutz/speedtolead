"""Fence Staining Scope tool — a VA-traced blue/red fence markup over an
uploaded aerial screenshot, sent to a customer to visually confirm scope
before they receive their estimate.

By design there is NO AI interpretation of fence geometry anywhere in this
router. The VA's traced path is the source of truth — this backend only
stores and serves what the frontend editor sends it: the raw uploaded
image, the VA's segment data, and the branded PNG the editor exports
client-side. See the frontend's src/map... no — src/components/FenceScopeEditor
for the actual tracing/rendering logic.
"""
from __future__ import annotations
import json
import logging
import os
import secrets
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Request
from fastapi.responses import Response
from pydantic import BaseModel

import clock
from database import get_db, Lead, Estimate
from api.auth import get_current_user
from services.activity_log import log_event
from services.event_bus import publish
from services.ghl import send_sms, last_send_error
from services import ai_image

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_IMAGE_BYTES = 20 * 1024 * 1024  # 20 MB — covers a high-res phone screenshot or export


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _touch(lead, user: dict | None) -> str:
    """Stamps the edit and returns the timestamp, which is also the version
    every open editor compares against."""
    stamp = _now()
    lead.fence_scope_updated_at = stamp
    lead.fence_scope_updated_by = (user or {}).get("sub") or ""
    return stamp


def _announce(lead_id: str, updated_at: str) -> None:
    """Tells every other open editor that this scope moved on.

    Never allowed to fail the write it follows — a scope that saved but didn't
    broadcast is a stale tab; a scope that failed to save is lost work.
    """
    try:
        publish("fence_scope_updated", {"lead_id": lead_id, "updated_at": updated_at})
    except Exception:
        logger.warning("fence scope: could not broadcast update for %s", lead_id, exc_info=True)


def _png_dimensions(data: bytes) -> tuple[int, int]:
    """Pixel size of an uploaded screenshot, whatever format it arrived in."""
    from io import BytesIO

    from PIL import Image

    with Image.open(BytesIO(data)) as im:
        return im.size


VALID_ROTATIONS = (0, 90, 180, 270)


class SaveSegmentsBody(BaseModel):
    segments_json: str  # pre-serialized by the frontend; stored verbatim
    # Display orientation of the aerial screenshot. Saved alongside the
    # segments because the traced points are moved with the photo — the two
    # are only meaningful together.
    rotation: int = 0
    mirrored: bool = False
    enhanced: bool = False
    use_ai: bool = False


@router.get("/leads/{lead_id}/fence-scope")
def get_fence_scope(lead_id: str, user: dict = Depends(get_current_user)):
    del user
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        segments = []
        if lead.fence_scope_segments_json:
            try:
                segments = json.loads(lead.fence_scope_segments_json)
            except (TypeError, ValueError):
                segments = []
        return {
            "has_source": bool(lead.has_fence_scope_source),
            "has_export": bool(lead.has_fence_scope_export),
            "segments": segments,
            "rotation": int(lead.fence_scope_rotation or 0),
            "mirrored": bool(lead.fence_scope_mirrored),
            "enhanced": bool(lead.fence_scope_enhanced),
            "has_ai": bool(lead.has_fence_scope_ai),
            "use_ai": bool(lead.fence_scope_use_ai),
            "ai_generated_at": lead.fence_scope_ai_generated_at,
            # Whether a drone re-render can even be attempted, so the editor can
            # say so up front instead of failing on click.
            "ai_configured": ai_image.is_configured(),
            "updated_at": lead.fence_scope_updated_at,
            "updated_by": lead.fence_scope_updated_by or "",
            "address": lead.address or "",
            "contact_name": lead.contact_name or "",
        }
    finally:
        db.close()


@router.put("/leads/{lead_id}/fence-scope")
def save_fence_scope(lead_id: str, body: SaveSegmentsBody, user: dict = Depends(get_current_user)):
    # Validate it's actually a JSON array before persisting — a malformed
    # save here would silently corrupt the one thing this tool exists to
    # get right.
    try:
        parsed = json.loads(body.segments_json)
        if not isinstance(parsed, list):
            raise ValueError("segments must be a JSON array")
    except (TypeError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid segments payload: {e}")

    if body.rotation not in VALID_ROTATIONS:
        raise HTTPException(status_code=400, detail=f"rotation must be one of {VALID_ROTATIONS}")

    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        lead.fence_scope_segments_json = body.segments_json
        lead.fence_scope_rotation = body.rotation
        lead.fence_scope_mirrored = body.mirrored
        lead.fence_scope_enhanced = body.enhanced
        lead.fence_scope_use_ai = body.use_ai and bool(lead.has_fence_scope_ai)
        stamp = _touch(lead, user)
        db.commit()
        _announce(lead_id, stamp)
        return {"saved": True, "segment_count": len(parsed), "updated_at": stamp}
    finally:
        db.close()


@router.post("/leads/{lead_id}/fence-scope/source")
async def upload_fence_scope_source(
    lead_id: str,
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    data = await file.read()
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="File too large (max 20MB)")
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image files are allowed")

    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        lead.fence_scope_source_image = data
        lead.has_fence_scope_source = True
        lead.fence_scope_source_mime = file.content_type or "image/png"
        stamp = _touch(lead, user)
        db.commit()
        log_event(lead.id, "fence_scope_source_uploaded", "Aerial screenshot uploaded for fence scope", {})
        _announce(lead_id, stamp)
        return {"uploaded": True, "updated_at": stamp}
    finally:
        db.close()


@router.get("/leads/{lead_id}/fence-scope/source")
def get_fence_scope_source(lead_id: str, user: dict = Depends(get_current_user)):
    del user
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead or not lead.fence_scope_source_image:
            raise HTTPException(status_code=404, detail="No source image on file")
        return Response(content=lead.fence_scope_source_image, media_type=lead.fence_scope_source_mime or "image/png")
    finally:
        db.close()


@router.post("/leads/{lead_id}/fence-scope/export")
async def upload_fence_scope_export(
    lead_id: str,
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Receives the final branded PNG, rendered client-side by the editor
    (Konva Stage.toDataURL) — this endpoint just persists it. No server-side
    rendering or AI touches this image."""
    data = await file.read()
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="File too large (max 20MB)")
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image files are allowed")

    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        lead.fence_scope_export_image = data
        lead.has_fence_scope_export = True
        lead.fence_scope_export_mime = file.content_type or "image/png"
        stamp = _touch(lead, user)
        db.commit()
        log_event(lead.id, "fence_scope_exported", "Fence scope image exported", {})
        _announce(lead_id, stamp)
        return {"uploaded": True, "updated_at": stamp}
    finally:
        db.close()


@router.get("/leads/{lead_id}/fence-scope/export")
def get_fence_scope_export(lead_id: str, user: dict = Depends(get_current_user)):
    del user
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead or not lead.fence_scope_export_image:
            raise HTTPException(status_code=404, detail="No exported scope on file")
        return Response(
            content=lead.fence_scope_export_image,
            media_type=lead.fence_scope_export_mime or "image/png",
            headers={"Content-Disposition": 'inline; filename="fence-scope.png"'},
        )
    finally:
        db.close()


@router.delete("/leads/{lead_id}/fence-scope")
def delete_fence_scope(lead_id: str, user: dict = Depends(get_current_user)):
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        lead.fence_scope_source_image = None
        lead.has_fence_scope_source = False
        lead.fence_scope_source_mime = ""
        lead.fence_scope_export_image = None
        lead.has_fence_scope_export = False
        lead.fence_scope_export_mime = ""
        lead.fence_scope_segments_json = ""
        lead.fence_scope_rotation = 0
        lead.fence_scope_mirrored = False
        lead.fence_scope_enhanced = False
        lead.fence_scope_ai_image = None
        lead.has_fence_scope_ai = False
        lead.fence_scope_ai_mime = ""
        lead.fence_scope_ai_meta = ""
        lead.fence_scope_ai_generated_at = None
        lead.fence_scope_use_ai = False
        lead.fence_scope_sent_at = None
        lead.fence_scope_mms_image = None
        lead.fence_scope_mms_mime = ""
        stamp = _touch(lead, user)
        db.commit()
        log_event(lead.id, "fence_scope_cleared", "Fence scope reset (start over)", {})
        _announce(lead_id, stamp)
        return {"deleted": True, "updated_at": stamp}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Photorealistic "drone view" re-render.
#
# This calls out to OpenAI and costs money per click, so it is never automatic:
# a person presses the button, waits, and then chooses between the original and
# the re-render. The original screenshot is never modified or deleted by any of
# this — it stays the record of what the property actually looks like.
# ---------------------------------------------------------------------------


@router.post("/leads/{lead_id}/fence-scope/ai")
def generate_fence_scope_ai(lead_id: str, user: dict = Depends(get_current_user)):
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        source = lead.fence_scope_source_image
        if not source:
            raise HTTPException(status_code=400, detail="Upload an aerial screenshot first")
        try:
            width, height = _png_dimensions(source)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Could not read the screenshot: {exc}")

        try:
            result = ai_image.render_drone_view(source, width, height)
        except ai_image.AiImageError as exc:
            # These messages are written for the person who clicked the button.
            raise HTTPException(status_code=400, detail=str(exc))

        meta = {
            "model": result.model,
            "quality": result.quality,
            "requested_size": result.requested_size,
            "source_size": f"{width}x{height}",
            "bytes": len(result.png),
            "usage": result.usage,
            # Kept so a render that comes back wrong can be diagnosed later
            # rather than guessed at.
            **(result.orientation or {}),
        }
        lead.fence_scope_ai_image = result.png
        lead.has_fence_scope_ai = True
        lead.fence_scope_ai_mime = "image/png"
        lead.fence_scope_ai_meta = json.dumps(meta)
        lead.fence_scope_ai_generated_at = _now()
        # Show it straight away — the editor puts the original one click away.
        lead.fence_scope_use_ai = True
        stamp = _touch(lead, user)
        db.commit()
        log_event(
            lead.id, "fence_scope_ai_rendered",
            f"Drone-view re-render generated ({result.requested_size}, {result.quality})",
            meta,
        )
        _announce(lead_id, stamp)
        return {"generated": True, "updated_at": stamp, **meta}
    finally:
        db.close()


@router.get("/leads/{lead_id}/fence-scope/ai")
def get_fence_scope_ai(lead_id: str, user: dict = Depends(get_current_user)):
    del user
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead or not lead.fence_scope_ai_image:
            raise HTTPException(status_code=404, detail="No drone-view image on file")
        return Response(content=lead.fence_scope_ai_image, media_type=lead.fence_scope_ai_mime or "image/png")
    finally:
        db.close()


@router.delete("/leads/{lead_id}/fence-scope/ai")
def delete_fence_scope_ai(lead_id: str, user: dict = Depends(get_current_user)):
    """Drops the re-render and falls back to the original screenshot."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        lead.fence_scope_ai_image = None
        lead.has_fence_scope_ai = False
        lead.fence_scope_ai_mime = ""
        lead.fence_scope_ai_meta = ""
        lead.fence_scope_ai_generated_at = None
        lead.fence_scope_use_ai = False
        stamp = _touch(lead, user)
        db.commit()
        log_event(lead.id, "fence_scope_ai_discarded", "Drone-view re-render discarded", {})
        _announce(lead_id, stamp)
        return {"deleted": True, "updated_at": stamp}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Sending the scope to the customer.
#
# The customer's phone fetches the image itself, so the picture has to live at
# a URL with no login on it. That's one unguessable token per lead, stable so
# the same link keeps working if the scope is re-sent after an edit.
# ---------------------------------------------------------------------------


class SendScopeBody(BaseModel):
    message: str = ""
    """Which wording to fall back to when no message is supplied."""
    template: str = "new"


def _public_base(request: Request) -> str:
    """Where the customer's phone should come to fetch the image.

    Derived from the request rather than configured, so this works the moment
    it deploys with nothing to set up. PUBLIC_API_URL overrides it if the API
    ever sits behind a different public name. Returns "" when there is no
    address a phone on a carrier network could actually reach — running
    locally, mainly — so the caller can say so instead of texting a dead link.
    """
    explicit = (os.getenv("PUBLIC_API_URL") or "").strip().rstrip("/")
    if explicit:
        return explicit
    host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "")
    host = host.split(",")[0].strip()
    if not host or host.startswith(("localhost", "127.", "0.0.0.0", "[::1]")):
        return ""
    # Always https: carriers fetching an MMS attachment over plain http is a
    # redirect at best and a dropped image at worst.
    return f"https://{host}"


def _segment_count(lead) -> int:
    try:
        parsed = json.loads(lead.fence_scope_segments_json or "[]")
        return len(parsed) if isinstance(parsed, list) else 0
    except (TypeError, ValueError):
        return 0


def _unfinished_steps(lead) -> list[str]:
    """The scope's own three steps, checked server-side.

    The editor disables Send until these pass, but a disabled button isn't a
    control — the point of the steps is that a half-finished picture never
    reaches a customer, so the last word belongs here.
    """
    missing = []
    if not (lead.fence_scope_enhanced or lead.fence_scope_use_ai):
        missing.append("Step 1: the photo hasn't been enhanced yet.")
    if _segment_count(lead) == 0:
        missing.append("Step 2: no fence has been marked on the photo yet.")
    return missing


def _share_token(lead, db) -> str:
    if not lead.fence_scope_share_token:
        lead.fence_scope_share_token = secrets.token_urlsafe(20)
        db.commit()
    return lead.fence_scope_share_token


# What a carrier will actually carry. The provider rejects anything over 5MB
# outright (error 11751), and phones on a weak signal fare better well below
# that, so the texted copy is built to a budget rather than hoping.
MMS_MAX_BYTES = 1_500_000
MMS_HARD_LIMIT = 5_000_000
JPEG_QUALITY_LADDER = (88, 82, 75, 68, 60)


def build_mms_image(png_bytes: bytes) -> tuple[bytes, str]:
    """A version of the scope small enough for a carrier to deliver.

    Quality is given up before resolution: a slightly softer JPEG at full size
    reads better on a phone than a crisp one that's been shrunk. Only if the
    whole quality ladder fails does it start scaling down.
    """
    from io import BytesIO

    from PIL import Image

    with Image.open(BytesIO(png_bytes)) as opened:
        full = opened.convert("RGB")

    work = full
    for _ in range(4):
        for quality in JPEG_QUALITY_LADDER:
            buf = BytesIO()
            work.save(buf, "JPEG", quality=quality, optimize=True, progressive=True)
            if buf.tell() <= MMS_MAX_BYTES:
                return buf.getvalue(), "image/jpeg"
        work = work.resize(
            (max(1, int(work.width * 0.8)), max(1, int(work.height * 0.8))),
            Image.LANCZOS,
        )

    buf = BytesIO()
    work.save(buf, "JPEG", quality=50, optimize=True, progressive=True)
    return buf.getvalue(), "image/jpeg"


def greeting_for(now=None) -> str:
    """Time-of-day greeting in the customer's time, not the server's.

    The server runs in UTC; a Houston customer texted at 8pm Central would
    otherwise be wished good morning.
    """
    hour = (now or datetime.now(clock.CENTRAL)).hour
    if 3 <= hour < 12:
        return "Good morning"
    if 12 <= hour < 18:
        return "Good afternoon"
    return "Good evening"


# What each colour means, in the customer's words. The order is the order they
# appear in the message: inside, outside, both.
COLOR_ORDER = ("blue", "green", "red")
COLOR_MEANINGS = {
    "blue": "Blue = we stain the inside face only.",
    "green": "Green = we stain the outside face only.",
    "red": "Red = we stain both sides.",
}


def colors_used(lead) -> list[str]:
    """The colours actually marked on this scope, in a fixed order."""
    try:
        segments = json.loads(lead.fence_scope_segments_json or "[]")
    except (TypeError, ValueError):
        return []
    present = {s.get("color") for s in segments if isinstance(s, dict)}
    return [c for c in COLOR_ORDER if c in present]


def previously_estimated(db, lead) -> bool:
    """Whether this customer has already had an estimate sent.

    Decides which message is offered first. Not a hard gate — the estimate
    could have gone out by phone, or the record could predate the dashboard —
    so it only sets the default and can be overridden.
    """
    if (lead.proposal_view_count or 0) > 0 or lead.proposal_viewed_at:
        return True
    return (
        db.query(Estimate)
        .filter(Estimate.lead_id == lead.id, Estimate.status == "sent")
        .first()
        is not None
    )


def returning_scope_message(contact_name: str, address: str, colors: list[str] | None = None) -> str:
    """For a customer who was quoted before and never booked.

    Leads with the scope rather than the discount. The picture is the genuinely
    new thing — they've never seen it — whereas opening on a price cut trains
    customers to wait for one, and gives them a reason to say no before
    they've even looked. The offer to re-price is the reason to reply, and it
    ends on a question a customer can answer with one word.
    """
    first = (contact_name or "").strip().split(" ")[0]
    hello = f"{greeting_for()} {first}," if first else f"{greeting_for()},"
    where = f" at {address}" if address else ""
    intro = (
        f"{hello} we put together a fence staining estimate for you{where} a while back. "
        "We've started sending a detailed scope of work so you can see exactly what we'd "
        "be staining. Here's yours."
    )
    wanted = COLOR_ORDER if colors is None else colors
    key = [COLOR_MEANINGS[c] for c in wanted if c in COLOR_MEANINGS]
    closing = (
        "Is this still something you're thinking about? I'm going to attach our Essential, "
        "Signature and Legacy packages at a discounted price for you!"
    )
    parts = [intro] + (["\n".join(key)] if key else []) + [closing]
    return "\n\n".join(parts)


def default_scope_message(contact_name: str, address: str, colors: list[str] | None = None) -> str:
    """What gets sent if nobody edits it.

    Deliberately does NOT ask the customer to reply before anything else
    happens: the estimate follows regardless. Waiting on a confirmation just
    stalls the quote, and a customer who spots a wrong side will say so on
    their own — at which point the estimate gets updated.
    """
    first = (contact_name or "").strip().split(" ")[0]
    hello = f"{greeting_for()} {first}," if first else f"{greeting_for()},"
    where = f" at {address}" if address else ""
    intro = (
        f"{hello} here's the scope of work for you to look at while we're working "
        f"on your personalized fence staining estimate{where}!"
    )
    # Only the colours actually on the picture. A customer having just the
    # inside done should never read a line about staining both faces — it
    # invites a question about work that was never quoted.
    # None means "caller didn't say", which falls back to the full key. An
    # empty list means "nothing is marked", which must list nothing — `or`
    # would have treated the two the same and named all three colours.
    wanted = COLOR_ORDER if colors is None else colors
    key = [COLOR_MEANINGS[c] for c in wanted if c in COLOR_MEANINGS]
    return intro + ("\n\n" + "\n".join(key) if key else "")


@router.get("/fence-scope/shared/{token}")
def get_shared_fence_scope(token: str):
    """Public. The customer's phone fetches the texted image from here.

    No auth by necessity — a carrier fetching an MMS attachment cannot log in.
    The token is the only credential, it grants nothing but this one picture,
    and it's per-lead so it can be rotated without touching anything else.
    """
    if not token or len(token) < 16:
        raise HTTPException(status_code=404, detail="Not found")
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.fence_scope_share_token == token).first()
        if not lead or not lead.fence_scope_export_image:
            raise HTTPException(status_code=404, detail="Not found")
        payload = lead.fence_scope_mms_image
        mime = lead.fence_scope_mms_mime or "image/jpeg"
        if not payload:
            # A scope shared before the carrier-sized copy existed.
            payload, mime = build_mms_image(bytes(lead.fence_scope_export_image))
        suffix = "jpg" if "jpeg" in mime else "png"
        return Response(
            content=payload,
            media_type=mime,
            headers={
                "Content-Disposition": f'inline; filename="fence-scope.{suffix}"',
                "Cache-Control": "public, max-age=300",
            },
        )
    finally:
        db.close()


@router.get("/leads/{lead_id}/fence-scope/send-preview")
def preview_fence_scope_send(lead_id: str, request: Request, user: dict = Depends(get_current_user)):
    """Everything the editor needs to show before anything is sent: who it
    goes to, what it will say, and any reason it can't go."""
    del user
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        blockers = _unfinished_steps(lead)
        if not lead.has_fence_scope_export:
            blockers.append("The scope hasn't been exported yet.")
        if not lead.ghl_contact_id:
            blockers.append("This lead has no CRM contact, so there's nobody to text.")
        if not lead.contact_phone:
            blockers.append("This lead has no phone number.")
        if lead.do_not_contact:
            blockers.append("This customer asked not to be contacted. Texting them anyway isn't allowed.")
        if not _public_base(request):
            blockers.append(
                "The server has no public address right now, so the image would have no link "
                "the customer's phone could open. This works on the deployed site."
            )
        return {
            "can_send": not blockers,
            "blockers": blockers,
            "contact_name": lead.contact_name or "",
            "contact_phone": lead.contact_phone or "",
            # Both wordings up front, so switching between them in the editor
            # is instant and neither needs another round trip.
            "messages": {
                "new": default_scope_message(lead.contact_name or "", lead.address or "", colors_used(lead)),
                "returning": returning_scope_message(lead.contact_name or "", lead.address or "", colors_used(lead)),
            },
            "suggested_template": "returning" if previously_estimated(db, lead) else "new",
            "last_sent_at": lead.fence_scope_sent_at,
        }
    finally:
        db.close()


@router.post("/leads/{lead_id}/fence-scope/send")
def send_fence_scope(lead_id: str, body: SendScopeBody, request: Request, user: dict = Depends(get_current_user)):
    """Texts the exported scope image to the customer as an MMS."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        if not lead.has_fence_scope_export or not lead.fence_scope_export_image:
            raise HTTPException(status_code=400, detail="Export the scope before sending it")
        # A customer who has opted out must not be texted, whatever the UI says.
        # This is the last gate before a message leaves, so it is checked here
        # rather than trusted to the button being disabled.
        if lead.do_not_contact:
            raise HTTPException(
                status_code=400,
                detail="This customer asked not to be contacted, so nothing was sent.",
            )
        if not lead.ghl_contact_id or not lead.contact_phone:
            raise HTTPException(status_code=400, detail="This lead has no phone number to text")
        unfinished = _unfinished_steps(lead)
        if unfinished:
            raise HTTPException(status_code=400, detail=" ".join(unfinished))
        base = _public_base(request)
        if not base:
            raise HTTPException(
                status_code=400,
                detail="The server has no public address, so the image has no link the "
                       "customer's phone could open.",
            )

        try:
            mms_bytes, mms_mime = build_mms_image(bytes(lead.fence_scope_export_image))
        except Exception as exc:
            logger.warning("fence scope: could not build the MMS copy for %s", lead_id, exc_info=True)
            raise HTTPException(status_code=500, detail=f"Could not prepare the image to send: {exc}")
        if len(mms_bytes) > MMS_HARD_LIMIT:
            # Better to say so than to hand the carrier something it will
            # reject with a code nobody can read.
            raise HTTPException(
                status_code=400,
                detail=f"The scope image is {len(mms_bytes) / 1_000_000:.1f}MB, over the "
                       f"{MMS_HARD_LIMIT / 1_000_000:.0f}MB a text can carry. Try a smaller screenshot.",
            )
        lead.fence_scope_mms_image = mms_bytes
        lead.fence_scope_mms_mime = mms_mime

        token = _share_token(lead, db)
        image_url = f"{base}/api/fence-scope/shared/{token}"
        builder = returning_scope_message if body.template == "returning" else default_scope_message
        message = (body.message or "").strip() or builder(
            lead.contact_name or "", lead.address or "", colors_used(lead)
        )

        sent = send_sms(lead.ghl_contact_id, message, attachments=[image_url])
        if not sent:
            err = last_send_error() or {}
            reason = (
                err.get("response_excerpt")
                or err.get("exception")
                or (f"HTTP {err.get('status_code')}" if err.get("status_code") else "")
                or "unknown error"
            )
            log_event(lead.id, "fence_scope_send_failed", f"Scope text failed: {reason}",
                      {"image_url": image_url})
            raise HTTPException(status_code=502, detail=f"The text didn't go through: {reason}")

        stamp = _touch(lead, user)
        lead.fence_scope_sent_at = stamp
        db.commit()
        log_event(lead.id, "fence_scope_sent", f"Fence scope texted to {lead.contact_phone}",
                  {"image_url": image_url, "chars": len(message), "image_bytes": len(mms_bytes)})
        _announce(lead_id, stamp)
        return {"sent": True, "to": lead.contact_phone, "updated_at": stamp}
    finally:
        db.close()
