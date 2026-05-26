"""
GoHighLevel API v2 client.
Handles contact fetching, webhook parsing, and sending messages (SMS + WhatsApp).
"""
from __future__ import annotations
import re
import logging
import httpx
from config import get_settings

logger = logging.getLogger(__name__)
GHL_BASE = "https://services.leadconnectorhq.com"

_client = httpx.Client(timeout=30, limits=httpx.Limits(max_keepalive_connections=10, max_connections=20))


def _headers(location_id: str | None = None) -> dict:
    settings = get_settings()
    api_key = settings.ghl_api_key
    if location_id and location_id == settings.ghl_location_id_2 and settings.ghl_api_key_2:
        api_key = settings.ghl_api_key_2
    return {
        "Authorization": f"Bearer {api_key}",
        "Version": "2021-07-28",
        "Content-Type": "application/json",
    }


# --- Contact fetching ---

def get_contacts(location_id: str, max_contacts: int = 500) -> list[dict]:
    all_contacts: list[dict] = []
    limit = 20
    params: dict = {"locationId": location_id, "limit": limit}

    while len(all_contacts) < max_contacts:
        try:
            r = _client.get(f"{GHL_BASE}/contacts/", headers=_headers(location_id), params=params, timeout=30)
            r.raise_for_status()
            data = r.json()
            contacts = data.get("contacts", [])
            all_contacts.extend(contacts)

            meta = data.get("meta", {})
            start_after = meta.get("startAfter")
            start_after_id = meta.get("startAfterId")

            if not start_after or not start_after_id or len(contacts) < limit:
                break

            params = {"locationId": location_id, "limit": limit, "startAfter": start_after, "startAfterId": start_after_id}
        except Exception as e:
            logger.error(f"GHL get_contacts failed: {e}")
            break

    return all_contacts


def get_contact(contact_id: str, location_id: str | None = None) -> dict | None:
    try:
        r = _client.get(f"{GHL_BASE}/contacts/{contact_id}", headers=_headers(location_id), timeout=10)
        r.raise_for_status()
        return r.json().get("contact")
    except Exception as e:
        logger.error(f"GHL get_contact failed: {e}")
        return None


def upsert_contact(
    location_id: str,
    name: str = "",
    phone: str = "",
    email: str = "",
    address: str = "",
    zip_code: str = "",
) -> str | None:
    """Create-or-update a contact in the given GHL location, deduped by phone/email.
    Returns the contact ID on success, None on failure.
    Used during v1→v2 export to register the lead's contact in the new GHL account
    so that subsequent SMS sends actually reach a known contact."""
    parts = (name or "").strip().split(maxsplit=1)
    first = parts[0] if parts else ""
    last = parts[1] if len(parts) > 1 else ""

    payload: dict = {
        "locationId": location_id,
        "firstName": first,
        "lastName": last,
        "name": name or "",
    }
    if phone:
        payload["phone"] = phone
    if email:
        payload["email"] = email
    if address:
        payload["address1"] = address
    if zip_code:
        payload["postalCode"] = zip_code

    try:
        r = _client.post(
            f"{GHL_BASE}/contacts/upsert",
            headers=_headers(location_id),
            json=payload,
            timeout=15,
        )
        r.raise_for_status()
        data = r.json()
        # GHL upsert returns either {contact: {id: ...}} or {id: ...} depending on version
        contact_id = (data.get("contact") or {}).get("id") or data.get("id")
        if contact_id:
            logger.info(f"GHL upsert_contact: {name} -> {contact_id}")
            return contact_id
        logger.error(f"GHL upsert_contact returned no ID: {data}")
        return None
    except Exception as e:
        logger.error(f"GHL upsert_contact failed for {name} ({phone}/{email}): {e}")
        return None


# --- Messaging (with retry) ---

import time


# ── Last-error capture for forensics ──────────────────────────────────
# After _send_message returns False, callers can read this to get the
# actual HTTP status + GHL response body. Without this, the only signal
# is a True/False return, which makes silent failures impossible to
# diagnose retroactively. Set on every send attempt (cleared on success,
# populated on failure). Single-process safe because uvicorn is single
# worker — if we ever scale to multi-worker, swap this for a small
# bounded ring buffer keyed by contact_id.
_last_send_error: dict | None = None


def last_send_error() -> dict | None:
    """Return the most recent send_sms failure context, or None.
    Shape: {status_code: int | None, response_excerpt: str, exception: str}"""
    return _last_send_error


def _send_message(msg_type: str, contact_id: str, message: str, location_id: str | None = None, max_retries: int = 3) -> bool:
    """Send a message via GHL with retry logic. msg_type: 'SMS' or 'WhatsApp'."""
    global _last_send_error
    settings = get_settings()
    payload = {
        "type": msg_type,
        "contactId": contact_id,
        "message": message,
        "locationId": location_id or settings.ghl_location_id,
    }

    final_status: int | None = None
    final_body: str = ""
    final_exc: str = ""

    for attempt in range(max_retries):
        try:
            r = _client.post(
                f"{GHL_BASE}/conversations/messages",
                headers=_headers(location_id),
                json=payload,
                timeout=15,
            )
            final_status = r.status_code
            # Capture body excerpt before any raise so we have it in
            # error logs no matter which branch we land in.
            try:
                final_body = r.text[:500]
            except Exception:
                final_body = ""

            if r.status_code == 429:
                wait = min(2 ** attempt, 10)
                logger.warning(f"GHL rate limited (429), retrying in {wait}s (attempt {attempt + 1}/{max_retries})")
                time.sleep(wait)
                continue
            r.raise_for_status()
            # Soft-fail detection — GHL can return 200 OK in several ways
            # that mean "did not actually send":
            #   {"success": false}                       — explicit
            #   {"msg": "No phone number on contact"}    — implicit
            #   {} / null / "" / no message id           — silent
            # The only signal that the SMS was ACTUALLY queued is a real
            # messageId in the response. Without that, treat the call as
            # a failure (triggers retry + downstream alert) instead of
            # silently returning True like we used to.
            try:
                body_json = r.json() if r.text else {}
            except Exception:
                body_json = {}
            if not isinstance(body_json, dict):
                raise RuntimeError(f"GHL 200 OK but response wasn't an object: {final_body[:200]}")
            if body_json.get("success") is False:
                raise RuntimeError(f"GHL 200 OK but success=false: {final_body[:200]}")
            # Required marker of a real send. GHL's documented success shape
            # returns either `messageId` or `id` (older endpoints). Accept
            # either; reject anything else.
            message_id = body_json.get("messageId") or body_json.get("id") or ""
            if not message_id:
                raise RuntimeError(
                    f"GHL 200 OK but no messageId in response (likely silent drop): {final_body[:200]}"
                )
            logger.info(f"GHL {msg_type} sent to {contact_id} (attempt {attempt + 1}) messageId={message_id}")
            _last_send_error = None
            return True
        except Exception as e:
            final_exc = f"{type(e).__name__}: {str(e)[:300]}"
            if attempt < max_retries - 1:
                wait = min(2 ** attempt, 8)
                logger.warning(
                    f"GHL {msg_type} failed (attempt {attempt + 1}), retrying in {wait}s: "
                    f"status={final_status} exc={final_exc} body={final_body[:200]}"
                )
                time.sleep(wait)
            else:
                logger.error(
                    f"GHL {msg_type} FAILED after {max_retries} attempts for {contact_id}: "
                    f"status={final_status} exc={final_exc} body={final_body[:200]}"
                )
                _last_send_error = {
                    "status_code": final_status,
                    "response_excerpt": final_body,
                    "exception": final_exc,
                }
                return False

    _last_send_error = {
        "status_code": final_status,
        "response_excerpt": final_body,
        "exception": final_exc or "max_retries_exceeded",
    }
    return False


def send_sms(contact_id: str, message: str, location_id: str | None = None) -> bool:
    """Send an SMS to a contact via GHL. Retries up to 3 times on failure.
    On failure, callers can call ghl.last_send_error() to retrieve the
    actual HTTP status + response body for forensics + alerting."""
    return _send_message("SMS", contact_id, message, location_id)


def send_via_provider(
    contact_id: str,
    message: str,
    conversation_provider_id: str,
    location_id: str | None = None,
    max_retries: int = 3,
    attachments: list[str] | None = None,
) -> tuple[bool, str, str]:
    """Send a message through a GHL Custom Conversation Provider.

    This is how third-party messaging integrations (MyCRMSim for
    iMessage, plus any future custom channel) plug into GHL. The
    payload shape was reverse-engineered by sniffing GHL's own UI —
    type "Custom" + conversationProviderId is what GHL sends when the
    user picks iMessage in the conversation dropdown.

    For MyCRMSim specifically: the provider itself handles
    iMessage-vs-SMS routing internally based on the recipient's device.
    We don't need to specify a channel — MyCRMSim picks iMessage for
    Apple users, falls back to SMS for Android automatically.

    `attachments` is an optional list of public URLs (images / files).
    GHL forwards them as MMS attachments; MyCRMSim relays them as
    iMessage attachments when the recipient is Apple. URLs must be
    publicly fetchable (Supabase Storage public-bucket URLs work).

    Returns: (success, ghl_message_id, error_text)
        ghl_message_id is set on success — used to correlate with any
        delivery-status webhook we may receive later.
        error_text carries the GHL error body on failure for debugging.
    """
    if not conversation_provider_id:
        return (False, "", "no conversation_provider_id configured")
    settings = get_settings()
    payload: dict = {
        "type": "Custom",
        "channel": "sms",
        "contactId": contact_id,
        "conversationProviderId": conversation_provider_id,
        "fromOneToOneConversation": True,
        "message": message,
        "locationId": location_id or settings.ghl_location_id,
        "attachments": [u for u in (attachments or []) if u],
    }

    last_err = ""
    for attempt in range(max_retries):
        try:
            r = _client.post(
                f"{GHL_BASE}/conversations/messages",
                headers=_headers(location_id),
                json=payload,
                timeout=15,
            )
            if r.status_code == 429:
                wait = min(2 ** attempt, 10)
                logger.warning(f"GHL rate limited (429), retrying in {wait}s (attempt {attempt + 1}/{max_retries})")
                time.sleep(wait)
                continue
            if not r.is_success:
                last_err = f"{r.status_code}: {r.text[:200]}"
                if attempt < max_retries - 1:
                    wait = min(2 ** attempt, 8)
                    time.sleep(wait)
                    continue
                logger.error(f"GHL provider send FAILED for {contact_id} provider={conversation_provider_id}: {last_err}")
                return (False, "", last_err)
            data = r.json() or {}
            # GHL returns the new conversation message ID under various keys depending on version.
            msg_id = (
                data.get("messageId")
                or data.get("id")
                or (data.get("message") or {}).get("id", "")
            )
            logger.info(f"GHL provider send ok contact={contact_id} provider={conversation_provider_id} msg_id={msg_id}")
            return (True, msg_id, "")
        except Exception as e:
            last_err = str(e)
            if attempt < max_retries - 1:
                wait = min(2 ** attempt, 8)
                time.sleep(wait)
            else:
                logger.error(f"GHL provider send EXCEPTION for {contact_id} provider={conversation_provider_id}: {e}")
                return (False, "", last_err)
    return (False, "", last_err or "max_retries_exceeded")


def send_whatsapp(contact_id: str, message: str, location_id: str | None = None) -> bool:
    """Send a WhatsApp message to a contact via GHL. Retries up to 3 times on failure."""
    return _send_message("WhatsApp", contact_id, message, location_id)


def send_email(
    contact_id: str,
    subject: str,
    html_body: str,
    location_id: str | None = None,
    attachments: list[str] | None = None,
    max_retries: int = 3,
) -> bool:
    """Send an email to a contact via GHL's Conversations API.

    The "From" address is whatever the GHL location has configured under
    Settings → Email Services. We do NOT set `emailFrom` here so GHL uses
    the location default (one sender per location keeps brand consistency).

    Replies route into GHL Conversations on the contact thread automatically
    — same as SMS replies — so the existing inbound message webhook handles
    them and the reply-handler dispatch (P04-REPLY etc.) continues to work.

    `attachments` is an optional list of public URLs. GHL fetches each URL
    and attaches it to the outgoing email. The proposal PDF page is served
    publicly so we can either link to it in `html_body` (current SMS pattern)
    or attach the raw PDF — caller's choice.

    Returns True on success."""
    settings = get_settings()
    payload: dict = {
        "type": "Email",
        "contactId": contact_id,
        "subject": subject,
        "html": html_body,
        "locationId": location_id or settings.ghl_location_id,
    }
    atts = [u for u in (attachments or []) if u]
    if atts:
        payload["attachments"] = atts

    for attempt in range(max_retries):
        try:
            r = _client.post(
                f"{GHL_BASE}/conversations/messages",
                headers=_headers(location_id),
                json=payload,
                timeout=20,
            )
            if r.status_code == 429:
                wait = min(2 ** attempt, 10)
                logger.warning(f"GHL email rate-limited (429), retrying in {wait}s (attempt {attempt + 1}/{max_retries})")
                time.sleep(wait)
                continue
            r.raise_for_status()
            logger.info(f"GHL email sent to {contact_id} (attempt {attempt + 1}, subject={subject!r})")
            return True
        except Exception as e:
            if attempt < max_retries - 1:
                wait = min(2 ** attempt, 8)
                logger.warning(f"GHL email failed (attempt {attempt + 1}), retrying in {wait}s: {e}")
                time.sleep(wait)
            else:
                logger.error(f"GHL email FAILED after {max_retries} attempts for {contact_id}: {e}")
                return False
    return False


# --- Contact notes ---

def add_contact_note(contact_id: str, body: str, location_id: str | None = None) -> str | None:
    """Add a note to a GHL contact. Returns the new note's ID on success, None on failure.
    (Used by callers that may need to delete the note later — e.g., when a
    badge is removed from the dashboard.)

    GHL's notes endpoint requires a userId so the note is attributed to a
    real user in the workspace. Set GHL_DEFAULT_USER_ID in env to your GHL
    user UUID — without it, every note write 422s."""
    settings = get_settings()
    user_id = settings.ghl_default_user_id
    if not user_id:
        logger.error("GHL_DEFAULT_USER_ID is not set — notes API requires a userId. Set it in env to your GHL user UUID (find in GHL → My Profile).")
        return None
    payload = {"body": body, "userId": user_id}
    url = f"{GHL_BASE}/contacts/{contact_id}/notes"
    headers = _headers(location_id)
    # Up to 3 attempts with exponential backoff on 429 (GHL rate limits at
    # ~100 req / 10s per location — bulk note writes can blow past that).
    delay = 1.0
    for attempt in range(3):
        try:
            r = _client.post(url, headers=headers, json=payload, timeout=10)
            if r.status_code == 429 and attempt < 2:
                import time as _time
                logger.warning(f"GHL note rate-limited for {contact_id}, retrying in {delay}s (attempt {attempt + 1}/3)")
                _time.sleep(delay)
                delay *= 2
                continue
            r.raise_for_status()
            data = r.json() or {}
            note_id = (data.get("note") or {}).get("id") or data.get("id")
            logger.info(f"GHL note added to contact {contact_id} (note_id={note_id})")
            return note_id
        except Exception as e:
            logger.error(f"GHL add_contact_note failed: {e}")
            return None
    return None


def delete_contact_note(contact_id: str, note_id: str, location_id: str | None = None) -> bool:
    """Delete a note from a GHL contact."""
    if not contact_id or not note_id:
        return False
    try:
        r = _client.delete(
            f"{GHL_BASE}/contacts/{contact_id}/notes/{note_id}",
            headers=_headers(location_id),
            timeout=10,
        )
        r.raise_for_status()
        logger.info(f"GHL note {note_id} deleted from contact {contact_id}")
        return True
    except Exception as e:
        logger.error(f"GHL delete_contact_note failed: {e}")
        return False


def add_contact_tag(contact_id: str, tag: str, location_id: str | None = None) -> bool:
    """Add a tag to a GHL contact."""
    try:
        r = _client.post(
            f"{GHL_BASE}/contacts/{contact_id}/tags",
            headers=_headers(location_id),
            json={"tags": [tag]},
            timeout=10,
        )
        r.raise_for_status()
        logger.info(f"GHL tag '{tag}' added to contact {contact_id}")
        return True
    except Exception as e:
        logger.error(f"GHL add_contact_tag failed: {e}")
        return False


# --- Conversations / Messages ---

def get_conversations(contact_id: str, location_id: str | None = None) -> list[dict]:
    """Fetch recent messages for a contact from GHL."""
    try:
        r = _client.get(
            f"{GHL_BASE}/conversations/search",
            headers=_headers(location_id),
            params={"contactId": contact_id, "limit": 20},
            timeout=15,
        )
        r.raise_for_status()
        return r.json().get("conversations", [])
    except Exception as e:
        logger.error(f"GHL get_conversations failed: {e}")
        return []


def get_conversation_messages(conversation_id: str, location_id: str | None = None) -> list[dict]:
    """Fetch messages from a specific conversation."""
    try:
        r = _client.get(
            f"{GHL_BASE}/conversations/{conversation_id}/messages",
            headers=_headers(location_id),
            params={"limit": 20},
            timeout=15,
        )
        r.raise_for_status()
        return r.json().get("messages", {}).get("messages", [])
    except Exception as e:
        logger.error(f"GHL get_conversation_messages failed: {e}")
        return []


# --- Pipelines ---

def get_pipelines(location_id: str) -> list[dict]:
    """Fetch all pipelines for a location."""
    try:
        r = _client.get(
            f"{GHL_BASE}/opportunities/pipelines",
            headers=_headers(location_id),
            params={"locationId": location_id},
            timeout=15,
        )
        r.raise_for_status()
        return r.json().get("pipelines", [])
    except Exception as e:
        logger.error(f"GHL get_pipelines failed: {e}")
        return []


def get_opportunity(opportunity_id: str, location_id: str | None = None) -> dict | None:
    """Fetch a single opportunity from GHL by ID. Used for one-shot stage
    re-sync when the regular poller missed a stage transition."""
    if not opportunity_id:
        return None
    try:
        r = _client.get(
            f"{GHL_BASE}/opportunities/{opportunity_id}",
            headers=_headers(location_id),
            timeout=15,
        )
        r.raise_for_status()
        data = r.json() or {}
        return data.get("opportunity") or data
    except Exception as e:
        logger.error(f"GHL get_opportunity({opportunity_id}) failed: {e}")
        return None


def update_opportunity_stage(opportunity_id: str, stage_id: str, location_id: str | None = None) -> bool:
    """Move a GHL opportunity to a different pipeline stage. Used by the
    1:1 mirror — when a card is dragged on our kanban, push the change
    back to GHL. 429-retried so a flurry of drags doesn't fail silently."""
    if not opportunity_id or not stage_id:
        return False
    url = f"{GHL_BASE}/opportunities/{opportunity_id}"
    payload = {"pipelineStageId": stage_id}
    headers = _headers(location_id)
    delay = 1.0
    for attempt in range(3):
        try:
            r = _client.put(url, headers=headers, json=payload, timeout=10)
            if r.status_code == 429 and attempt < 2:
                import time as _time
                logger.warning(f"GHL stage push rate-limited for {opportunity_id}, retrying in {delay}s (attempt {attempt + 1}/3)")
                _time.sleep(delay)
                delay *= 2
                continue
            r.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"GHL update_opportunity_stage failed: {e}")
            return False
    return False


def update_contact_core_fields(
    contact_id: str,
    *,
    name: str | None = None,
    phone: str | None = None,
    email: str | None = None,
    address: str | None = None,
    zip_code: str | None = None,
    location_id: str | None = None,
) -> bool:
    """PUT name/phone/email/address1/postalCode on an existing GHL contact.
    Used to mirror dashboard edits of the contact card back to GHL. Pass
    only the fields you want to update — None values are skipped so we
    don't accidentally blank out a field. Best-effort, 429-retried."""
    if not contact_id:
        return False
    payload: dict = {}
    if name is not None:
        parts = (name or "").strip().split(maxsplit=1)
        payload["firstName"] = parts[0] if parts else ""
        payload["lastName"] = parts[1] if len(parts) > 1 else ""
        payload["name"] = name or ""
    if phone is not None:
        payload["phone"] = phone or ""
    if email is not None:
        payload["email"] = email or ""
    if address is not None:
        payload["address1"] = address or ""
    if zip_code is not None:
        payload["postalCode"] = zip_code or ""
    if not payload:
        return False
    url = f"{GHL_BASE}/contacts/{contact_id}"
    headers = _headers(location_id)
    delay = 1.0
    for attempt in range(3):
        try:
            r = _client.put(url, headers=headers, json=payload, timeout=10)
            if r.status_code == 429 and attempt < 2:
                import time as _time
                logger.warning(f"GHL core-field push rate-limited for {contact_id}, retrying in {delay}s")
                _time.sleep(delay)
                delay *= 2
                continue
            r.raise_for_status()
            logger.info(f"GHL core fields updated for contact {contact_id}: {list(payload.keys())}")
            return True
        except Exception as e:
            logger.error(f"GHL update_contact_core_fields failed for {contact_id}: {e}")
            return False
    return False


def update_contact_custom_fields(
    contact_id: str,
    fields: dict[str, str | int | float],
    location_id: str | None = None,
) -> bool:
    """Push a dict of {ghl_field_id: value} to a GHL contact's custom fields.
    Used to mirror estimate-input edits (zip / fence height / fence age /
    previously stained / timeline) back to GHL. 429-retried."""
    if not contact_id or not fields:
        return False
    url = f"{GHL_BASE}/contacts/{contact_id}"
    payload = {
        "customFields": [{"id": fid, "field_value": str(val)} for fid, val in fields.items() if fid],
    }
    if not payload["customFields"]:
        return False
    headers = _headers(location_id)
    delay = 1.0
    for attempt in range(3):
        try:
            r = _client.put(url, headers=headers, json=payload, timeout=10)
            if r.status_code == 429 and attempt < 2:
                import time as _time
                logger.warning(f"GHL custom-field push rate-limited for {contact_id}, retrying in {delay}s")
                _time.sleep(delay)
                delay *= 2
                continue
            r.raise_for_status()
            logger.info(f"GHL custom fields updated for contact {contact_id}: {list(fields.keys())}")
            return True
        except Exception as e:
            logger.error(f"GHL update_contact_custom_fields failed: {e}")
            return False
    return False


def get_opportunities(location_id: str, pipeline_id: str, stage_id: str | None = None) -> list[dict]:
    """Fetch opportunities from a pipeline, optionally filtered by stage."""
    all_opps: list[dict] = []
    page = 1
    while True:
        params: dict = {"location_id": location_id, "pipeline_id": pipeline_id, "limit": 100, "page": page}
        if stage_id:
            params["pipeline_stage_id"] = stage_id
        try:
            r = _client.get(f"{GHL_BASE}/opportunities/search", headers=_headers(location_id), params=params, timeout=30)
            r.raise_for_status()
            data = r.json()
            opps = data.get("opportunities", [])
            all_opps.extend(opps)
            total = data.get("meta", {}).get("total", 0)
            if len(all_opps) >= total or len(opps) == 0:
                break
            page += 1
        except Exception as e:
            logger.error(f"GHL get_opportunities failed: {e}")
            break
    return all_opps


def get_custom_fields(location_id: str) -> list[dict]:
    """Fetch all custom fields for a location. Tries multiple API endpoints."""
    endpoints = [
        f"{GHL_BASE}/locations/{location_id}/customFields",
        f"{GHL_BASE}/locations/{location_id}/customFields?model=contact",
    ]
    for url in endpoints:
        try:
            r = _client.get(url, headers=_headers(location_id), timeout=15)
            if r.status_code == 401:
                logger.warning(f"GHL custom fields 401 at {url}, trying next...")
                continue
            r.raise_for_status()
            data = r.json()
            fields = data.get("customFields", [])
            logger.info(f"GHL get_custom_fields for {location_id}: {len(fields)} fields via {url}")
            return fields
        except Exception as e:
            logger.error(f"GHL get_custom_fields failed at {url}: {e}")

    # Last resort: try fetching a single contact and extracting custom field structure
    try:
        contacts = get_all_contacts(location_id)
        if contacts:
            sample = contacts[0]
            custom_fields = sample.get("customFields", [])
            if custom_fields:
                logger.info(f"GHL extracted {len(custom_fields)} custom field entries from sample contact")
                return [{"id": cf.get("id", ""), "key": cf.get("key", cf.get("id", "")), "name": cf.get("key", cf.get("id", "")), "value": cf.get("value", "")} for cf in custom_fields if cf.get("id")]
    except Exception as e:
        logger.error(f"GHL fallback contact field extraction failed: {e}")

    return []


# --- Webhook parsing ---

# Common GHL form field names -> our field names
FIELD_ALIASES: dict[str, str] = {
    "fence_height": "fence_height",
    "fenceheight": "fence_height",
    "fence height": "fence_height",
    "height_of_fence": "fence_height",
    "fence_age": "fence_age",
    "fenceage": "fence_age",
    "fence age": "fence_age",
    "age_of_fence": "fence_age",
    "how_old_is_the_fence": "fence_age",
    "previously_stained": "previously_stained",
    "previouslystained": "previously_stained",
    "has_the_fence_been_stained_before": "previously_stained",
    "service_timeline": "service_timeline",
    "timeline": "service_timeline",
    "when_would_you_like_the_work_done": "service_timeline",
    "additional_services": "additional_services",
    "additionalservices": "additional_services",
    "additional_notes": "additional_notes",
    "additionalnotes": "additional_notes",
    "additional_note": "additional_notes",
    "notes": "additional_notes",
    "customer_notes": "additional_notes",
    "customernotes": "additional_notes",
    "linear_feet": "linear_feet",
    "linearfeet": "linear_feet",
}


def _normalize_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", key.lower().strip())


def parse_webhook_payload(payload: dict) -> dict:
    """
    Parse GHL webhook payload and extract lead data.
    Returns dict with: contact_id, contact_name, contact_phone, contact_email,
                       address, zip_code, service_type, form_data, location_id
    """
    contact_id = payload.get("contact_id") or payload.get("contactId") or payload.get("id", "")
    location_id = payload.get("location_id") or payload.get("locationId") or ""

    # Contact info
    name = payload.get("full_name") or payload.get("name") or ""
    first = payload.get("first_name") or payload.get("firstName") or ""
    last = payload.get("last_name") or payload.get("lastName") or ""
    if not name and (first or last):
        name = f"{first} {last}".strip()

    phone = payload.get("phone") or payload.get("phoneNumber") or ""
    email = payload.get("email") or ""
    address = payload.get("address1") or payload.get("address") or ""
    city = payload.get("city") or ""
    state = payload.get("state") or ""
    postal = payload.get("postalCode") or payload.get("postal_code") or ""

    if city and state:
        full_address = f"{address}, {city}, {state} {postal}".strip(", ")
    else:
        full_address = address

    # Extract custom fields into form_data
    form_data: dict = {}
    custom_fields = payload.get("customFields") or payload.get("custom_fields") or payload.get("customField") or {}

    if isinstance(custom_fields, list):
        for cf in custom_fields:
            key = cf.get("key") or cf.get("id") or ""
            value = cf.get("value") or cf.get("field_value") or ""
            norm = _normalize_key(key)
            for alias_norm, our_name in {_normalize_key(k): v for k, v in FIELD_ALIASES.items()}.items():
                if norm == alias_norm or alias_norm in norm:
                    form_data[our_name] = value
                    break
            else:
                form_data[key] = value
    elif isinstance(custom_fields, dict):
        for key, value in custom_fields.items():
            norm = _normalize_key(key)
            for alias_norm, our_name in {_normalize_key(k): v for k, v in FIELD_ALIASES.items()}.items():
                if norm == alias_norm or alias_norm in norm:
                    form_data[our_name] = value
                    break
            else:
                form_data[key] = value

    # Check top-level for form fields too
    for raw_key in list(payload.keys()):
        norm = _normalize_key(raw_key)
        for alias_norm, our_name in {_normalize_key(k): v for k, v in FIELD_ALIASES.items()}.items():
            if norm == alias_norm:
                form_data.setdefault(our_name, payload[raw_key])
                break

    # Determine service type
    svc = str(form_data.get("service_type") or payload.get("service_type") or "fence_staining").lower()
    if "pressure" in svc or "wash" in svc:
        service_type = "pressure_washing"
    else:
        service_type = "fence_staining"

    # Pluck the form name (used by P02 ad attribution). GHL workflow webhooks
    # can pass this under several keys depending on how Alan configured the
    # workflow action — handle the common shapes.
    form_name = (
        payload.get("formName")
        or payload.get("form_name")
        or (payload.get("form") or {}).get("name", "")
        or (payload.get("customData") or {}).get("formName", "")
        or (payload.get("customData") or {}).get("form_name", "")
        or ""
    )

    return {
        "contact_id": contact_id,
        "contact_name": name,
        "contact_phone": phone,
        "contact_email": email,
        "address": full_address,
        "zip_code": postal,
        "service_type": service_type,
        "form_data": form_data,
        "location_id": location_id,
        "form_name": str(form_name).strip(),
    }
