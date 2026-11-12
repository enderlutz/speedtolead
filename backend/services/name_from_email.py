"""
Fix a new lead's fake name from their email.

Why this exists
---------------
Facebook-ad leads often type a nickname or a handle as their name ("SweetJ",
"JD", "jdoe", "Jay Smoothie") while their email carries the real one
("jane.q.doe@…"). VAs then call and text "Hi SweetJ". Alan asked
(2026-11-11) for every new lead to be checked once, automatically:

* name clearly fake AND email clearly "first + last" → rename the lead and the
  GHL contact, keep the old name as an alias, log it.
* a real first name and an email that adds the matching last name
  ("Jane" + jane.doe@…) → fill in the last name.
* name looks fake but the email doesn't say who they are → no rename, a short
  text to Alan (automated alerts go to Alan only).
* anything else (a real name with a spouse's or a business email, a real first
  name with an unrelated handle) → leave it alone.

The model judges, the code double-checks: a rename needs high confidence, and
every word of the new name has to be visible in the email's local part, so a
guessed name can never land on a customer. Only the name and the email's local
part go to the model — never the phone or the address.

Runs in a background thread after lead creation; any error is logged and
swallowed so intake is never slowed or broken. Each lead is checked once
(form_data["name_check"]), so pollers re-seeing a contact don't re-run it.
"""
from __future__ import annotations

import json
import logging
import re
import threading
from datetime import datetime, timezone
from typing import Callable

logger = logging.getLogger(__name__)

CHECK_KEY = "name_check"
MODEL = "claude-sonnet-5-5"
FALLBACK_MODEL = "claude-sonnet-4-6"

_claim_lock = threading.Lock()
_in_flight: set[str] = set()

PROMPT = """You check names on new sales leads from Facebook ads for a fence-staining company in Houston.
People often type a nickname or a handle as their name, while their email shows their real name.

You get the NAME they typed and the LOCAL PART of their email (the text before @). Answer with strict JSON only, no prose:
{"fake_name": bool, "rename": bool, "first": str, "last": str, "confidence": "high"|"medium"|"low", "reason": str}

fake_name = true when the typed name is clearly NOT a real person's full or first name:
- one word that is not a common first name in any culture (a nickname or handle, e.g. "SweetJ", "Bigdaddy")
- initials only (3 letters or fewer, e.g. "JD", "KMW")
- contains digits or underscores
- a lowercase handle with no space, e.g. "jdoe" or "tjones"
- a nickname-style name, e.g. a short form plus a made-up surname ("Jay Smoothie", "DeeDee Jayz", "A Ricky")
fake_name = false for a real full name ("Mary Lopez") or a real first name alone ("Rachelle", "Ankush"), even when the email belongs to someone else.

rename = true only when the email local part clearly holds ONE person's first AND last name (optionally a middle initial,
a numeric tail, or Jr/Sr), separated by . _ - or obviously joined, AND you can tell which part is the first name and which
the last (e.g. "doe.jane14" -> Jane Doe; "jane.q.doe" -> Jane Doe; "doe.johnjr" -> John Doe Jr).
Also rename = true when the typed name is a real first name alone and the email is that same first name plus a last name
("Jane" + "jane_doe77" -> Jane Doe), or a pet name plus a last name with the typed first name ("Jane" + "sunny.doe" -> Jane Doe).
rename = false when the email is a business, a hobby, a handle, a single word, someone else's full name (a spouse) while the
typed name is already a real full name, or anything you are not sure about.

first / last: the real name in normal capitalisation (Jr/Sr goes at the end of last). Empty strings when rename is false.
confidence = "high" only when a person reading the email would agree without hesitation.
reason: a few plain words."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _form_data(lead) -> dict:
    try:
        fd = json.loads(lead.form_data or "{}")
        return fd if isinstance(fd, dict) else {}
    except (ValueError, TypeError):
        return {}


def email_local(email: str) -> str:
    email = (email or "").strip()
    if "@" not in email:
        return ""
    return email.split("@", 1)[0].strip()


# ── The model ──────────────────────────────────────────────────────────────

def ask_model(name: str, local: str) -> dict:
    """One small question to Claude; JSON back. Raises on failure."""
    from config import get_settings
    import anthropic

    client = anthropic.Anthropic(api_key=get_settings().anthropic_api_key)
    kw = dict(
        max_tokens=2000,
        system=PROMPT,
        messages=[{"role": "user", "content": json.dumps({"name": name, "email_local_part": local})}],
    )
    try:
        resp = client.messages.create(model=MODEL, **kw)
    except (anthropic.NotFoundError, anthropic.BadRequestError, anthropic.PermissionDeniedError) as e:
        logger.warning("name check: %s refused (%s), using %s", MODEL, e, FALLBACK_MODEL)
        resp = client.messages.create(model=FALLBACK_MODEL, **kw)
    text = "".join(getattr(b, "text", "") for b in (resp.content or [])
                   if getattr(b, "type", "") == "text").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0]
    if not text.startswith("{") and "{" in text:
        text = text[text.index("{"):text.rindex("}") + 1]
    return json.loads(text)


# ── The decision (pure; the model's answer is only an input) ──────────────

def _words(s: str) -> list[str]:
    return [w for w in re.split(r"[^a-z]+", (s or "").lower()) if w]


def _clean_part(s: str) -> str:
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s if re.fullmatch(r"[A-Za-z][A-Za-z' .\-]*", s or "") else ""


def decide(name: str, email: str, out: dict) -> dict:
    """What to do with one lead, given the model's answer.

    Returns {"action": "rename"|"alert"|"keep", "first", "last", "new_name", "reason"}.
    """
    name = (name or "").strip()
    local = email_local(email).lower()
    fake = out.get("fake_name") is True
    wants = out.get("rename") is True
    high = str(out.get("confidence") or "").lower() == "high"
    first, last = _clean_part(out.get("first")), _clean_part(out.get("last"))
    reason = str(out.get("reason") or "")[:200]
    keep = {"action": "keep", "first": "", "last": "", "new_name": "", "reason": reason}

    rename_ok = wants and high and bool(first) and bool(last)
    if rename_ok and not fake:
        # A real name stays real: only a lone first name may gain a last name,
        # and only the same first name.
        tokens = name.split()
        if len(tokens) != 1 or _words(tokens[0]) != _words(first.split()[0]):
            rename_ok = False
    if rename_ok:
        # Every new word must be readable in the email itself — the model may
        # pick the order, never invent a name. (Filling in a last name keeps
        # the first name they typed, so only the last name is checked then.)
        letters = re.sub(r"[^a-z]", "", local)
        must_see = _words(f"{first} {last}") if fake else _words(last)
        if not all(w in letters for w in must_see):
            rename_ok = False
            reason = f"name not in email ({reason})"[:200]
    new_name = f"{first} {last}".strip()
    if rename_ok and new_name.lower() == name.lower():
        return keep
    if rename_ok:
        return {"action": "rename", "first": first, "last": last, "new_name": new_name, "reason": reason}
    if fake:
        return {"action": "alert", "first": "", "last": "", "new_name": "", "reason": reason}
    return keep


# ── Applying it ────────────────────────────────────────────────────────────

def _alert_alan(text: str) -> None:
    from services.after_pay_hooks import alert_alan
    alert_alan(text)


def _ghl_rename(lead, first: str, last: str, new_name: str) -> bool:
    from services import ghl
    return ghl.update_contact_core_fields(
        lead.ghl_contact_id, name=new_name, first_name=first, last_name=last,
        location_id=lead.ghl_location_id or None,
    )


def _mark(db, lead, result: dict) -> None:
    fd = _form_data(lead)
    fd[CHECK_KEY] = {**result, "at": _now()}
    lead.form_data = json.dumps(fd)
    db.commit()


def check_lead(
    lead_id: str,
    *,
    judge: Callable[[str, str], dict] | None = None,
    alert: Callable[[str], None] | None = None,
    ghl_rename: Callable[..., bool] | None = None,
) -> dict:
    """Check one lead's name against its email. Never raises."""
    with _claim_lock:
        if lead_id in _in_flight:
            return {"status": "skipped", "why": "in_flight"}
        _in_flight.add(lead_id)
    try:
        return _check(lead_id, judge=judge, alert=alert or _alert_alan, ghl_rename=ghl_rename or _ghl_rename)
    except Exception as e:  # noqa: BLE001
        logger.warning("name check failed for lead %s: %s", lead_id, e)
        try:
            from database import get_db, Lead
            db = get_db()
            try:
                lead = db.query(Lead).filter(Lead.id == lead_id).first()
                if lead:
                    _mark(db, lead, {"status": "error", "error": str(e)[:200]})
            finally:
                db.close()
        except Exception:  # noqa: BLE001
            pass
        return {"status": "error", "error": str(e)[:200]}
    finally:
        with _claim_lock:
            _in_flight.discard(lead_id)


def _check(lead_id: str, *, judge, alert, ghl_rename) -> dict:
    from config import get_settings
    from database import get_db, Lead

    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            return {"status": "skipped", "why": "no_lead"}
        if CHECK_KEY in _form_data(lead):
            return {"status": "skipped", "why": "already_checked"}
        name = (lead.contact_name or "").strip()
        email = (lead.contact_email or "").strip()
        local = email_local(email)
        if not name or not local:
            _mark(db, lead, {"status": "no_email" if not local else "no_name"})
            return {"status": "no_email" if not local else "no_name"}
        if judge is None:
            if not get_settings().anthropic_api_key:
                return {"status": "skipped", "why": "no_api_key"}   # not marked: try again later
            judge = ask_model
        # Claim it before the slow call so a second trigger can't double up.
        _mark(db, lead, {"status": "running"})
        db.close()

        out = judge(name, local) or {}
        d = decide(name, email, out)

        db = get_db()
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            return {"status": "skipped", "why": "no_lead"}
        base = {"from": name, "fake_name": out.get("fake_name") is True,
                "confidence": str(out.get("confidence") or ""), "reason": d["reason"]}

        if d["action"] == "rename":
            # GHL first: the contact mirror copies GHL's name onto the lead, so
            # a dashboard-only rename would be undone on the next sweep.
            if lead.ghl_contact_id and not ghl_rename(lead, d["first"], d["last"], d["new_name"]):
                _mark(db, lead, {**base, "status": "ghl_failed", "to": d["new_name"]})
                alert(f"New lead's name looks fake: '{name}'. The email says {d['new_name']}, "
                      f"but GoHighLevel didn't take the change. Open: {_lead_link(lead_id)}")
                return {"status": "ghl_failed", "to": d["new_name"]}
            _rename_lead(lead, name, d["new_name"])
            _mark(db, lead, {**base, "status": "renamed", "to": d["new_name"]})
            msg = f"Name updated from '{name}' to '{d['new_name']}' from the email"
            from services.activity_log import log_event
            from services.lead_activity import record_activity
            log_event(lead_id, "name_from_email", msg, {"from": name, "to": d["new_name"], "email": email})
            record_activity(lead_id, {"name": "Automation"}, "name_updated", msg)
            logger.info("name check: lead %s %s", lead_id, msg)
            return {"status": "renamed", "from": name, "to": d["new_name"]}

        if d["action"] == "alert":
            _mark(db, lead, {**base, "status": "alerted"})
            alert(f"New lead's name looks fake: '{name}' ({email}). "
                  f"Couldn't tell the real name from the email. Open: {_lead_link(lead_id)}")
            return {"status": "alerted"}

        _mark(db, lead, {**base, "status": "kept"})
        return {"status": "kept"}
    finally:
        db.close()


def _rename_lead(lead, old: str, new: str) -> None:
    from services.identity import stamp_lead_keys
    try:
        aliases = json.loads(lead.identity_aliases or "[]")
        if not isinstance(aliases, list):
            aliases = []
    except (ValueError, TypeError):
        aliases = []
    if old and old.lower() not in {str(a).lower() for a in aliases}:
        aliases.append(old)
    lead.identity_aliases = json.dumps(aliases)
    lead.contact_name = new
    lead.updated_at = _now()
    # name_key / phonetic_key are derived from the name.
    stamp_lead_keys(lead)


def _lead_link(lead_id: str) -> str:
    from config import get_settings
    return f"{get_settings().frontend_url}/leads/{lead_id}"


def check_lead_soon(lead_id: str) -> None:
    """Fire-and-forget: run check_lead on a background thread."""
    if not lead_id:
        return
    try:
        threading.Thread(target=check_lead, args=(lead_id,), daemon=True,
                         name=f"name-check-{lead_id[:8]}").start()
    except Exception as e:  # noqa: BLE001
        logger.warning("name check not started for lead %s: %s", lead_id, e)
