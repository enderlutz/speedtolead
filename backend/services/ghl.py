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


# --- Messaging (with retry) ---

import time


def _send_message(msg_type: str, contact_id: str, message: str, location_id: str | None = None, max_retries: int = 3) -> bool:
    """Send a message via GHL with retry logic. msg_type: 'SMS' or 'WhatsApp'."""
    settings = get_settings()
    payload = {
        "type": msg_type,
        "contactId": contact_id,
        "message": message,
        "locationId": location_id or settings.ghl_location_id,
    }

    for attempt in range(max_retries):
        try:
            r = _client.post(
                f"{GHL_BASE}/conversations/messages",
                headers=_headers(location_id),
                json=payload,
                timeout=15,
            )
            if r.status_code == 429:
                # Rate limited — back off and retry
                wait = min(2 ** attempt, 10)
                logger.warning(f"GHL rate limited (429), retrying in {wait}s (attempt {attempt + 1}/{max_retries})")
                time.sleep(wait)
                continue
            r.raise_for_status()
            logger.info(f"GHL {msg_type} sent to {contact_id} (attempt {attempt + 1})")
            return True
        except Exception as e:
            if attempt < max_retries - 1:
                wait = min(2 ** attempt, 8)
                logger.warning(f"GHL {msg_type} failed (attempt {attempt + 1}), retrying in {wait}s: {e}")
                time.sleep(wait)
            else:
                logger.error(f"GHL {msg_type} FAILED after {max_retries} attempts for {contact_id}: {e}")
                return False

    return False


def send_sms(contact_id: str, message: str, location_id: str | None = None) -> bool:
    """Send an SMS to a contact via GHL. Retries up to 3 times on failure."""
    return _send_message("SMS", contact_id, message, location_id)


def send_whatsapp(contact_id: str, message: str, location_id: str | None = None) -> bool:
    """Send a WhatsApp message to a contact via GHL. Retries up to 3 times on failure."""
    return _send_message("WhatsApp", contact_id, message, location_id)


# --- Contact notes ---

def add_contact_note(contact_id: str, body: str, location_id: str | None = None) -> bool:
    """Add a note to a GHL contact."""
    settings = get_settings()
    try:
        payload = {"body": body, "contactId": contact_id}
        r = _client.post(
            f"{GHL_BASE}/contacts/{contact_id}/notes",
            headers=_headers(location_id),
            json=payload, timeout=10,
        )
        r.raise_for_status()
        logger.info(f"GHL note added to contact {contact_id}")
        return True
    except Exception as e:
        logger.error(f"GHL add_contact_note failed: {e}")
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


def update_opportunity_stage(opportunity_id: str, stage_id: str, location_id: str | None = None) -> bool:
    """Move a GHL opportunity to a different pipeline stage."""
    try:
        r = _client.put(
            f"{GHL_BASE}/opportunities/{opportunity_id}",
            headers=_headers(location_id),
            json={"pipelineStageId": stage_id},
            timeout=10,
        )
        r.raise_for_status()
        return True
    except Exception as e:
        logger.error(f"GHL update_opportunity_stage failed: {e}")
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
    """Fetch all custom fields for a location."""
    try:
        r = _client.get(
            f"{GHL_BASE}/locations/{location_id}/customFields",
            headers=_headers(location_id),
            timeout=15,
        )
        r.raise_for_status()
        data = r.json()
        fields = data.get("customFields", [])
        logger.info(f"GHL get_custom_fields for {location_id}: {len(fields)} fields found")
        return fields
    except Exception as e:
        logger.error(f"GHL get_custom_fields failed for {location_id}: {e}")
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
    }
