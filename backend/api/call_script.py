"""
Call script API. Single-row table — admin edits one master script at
Settings → Call Script. The VA's sticky panel on Lead Detail pulls
the raw template + the active lead, substitutes variables + conditional
blocks client-side, and renders the result.

The initial seed content is the script Olga uses today, marked up with
{{var}} placeholders + {{#if X}}/{{/if}} branches matching the
"if they put X / if they didn't" forks in the original script.
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from database import get_db, CallScript
from api.auth import require_admin, get_current_user

router = APIRouter()
logger = logging.getLogger(__name__)

DEFAULT_SCRIPT_ID = "default"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# Initial template seeded into the DB on first read. Admin can edit/replace
# from the Settings page; this string is only the fallback if the row is
# missing. Variables: customer_name, customer_first_name, your_name, brand,
# address, zip_code, fence_height, fence_age, previously_stained,
# fence_sides, linear_feet, tier_essential, tier_signature, tier_legacy.
# Conditionals: has_address, has_fence_height, has_fence_age,
# has_previously_stained, has_fence_sides, fence_brand_new, fence_older_than_6mo.
INITIAL_SCRIPT = """## Stage 1 — Greeting

Hi, is this {{customer_name}}? Hi {{customer_first_name}}! This is {{your_name}} calling from {{brand}} — we just received your information. How are you doing?

> **Customer:** I'm doing great, how are you?
>
> **You:** I'm doing great
>
> **Customer:** I'm sorry, who is this?
>
> **You:** This is {{your_name}} with {{brand}}

## Stage 2 — Address Confirmation

I just want to call to make sure everything we have on file is correct so that I can send your estimate.

{{#if has_address}}
I have your address as **{{address}}, {{zip_code}}**. Is that correct?

*(update it if anything is incorrect)*
{{/if}}{{#unless has_address}}
What's the address where you'd like the fence staining done? And what's the ZIP code there? I want to make sure we get an accurate measurement using Google Earth.

Just to confirm — that's **[FULL ADDRESS, ZIP]**?

*(if they don't want to give you an address then ask them for the linear feet so we can give them a rough estimate)*
{{/unless}}

## Stage 3 — Fence Details

### Fence Height

{{#if has_fence_height}}
I just wanted to confirm that your fence is **{{fence_height}}** tall?

*(ex: six, six and a half, seven, seven and a half)*
{{/if}}{{#unless has_fence_height}}
*(confirm it for yourself later and don't talk to them about it)*
{{/unless}}

### Fence Age

{{#if has_fence_age}}
I see here that your fence is between **{{fence_age}}** old?
{{/if}}{{#unless has_fence_age}}
About how old would you say the fence is?
{{/unless}}

### Previously Stained

{{#if has_previously_stained}}
And it is **{{previously_stained}}** previously stained, right?
{{/if}}{{#unless has_previously_stained}}
*(confirm it for yourself later and don't talk to them about it)*
{{/unless}}

### Fence Sides

Okay and one last thing! — which sides of the fence do you want stained? Which sides?

**8 possible sides:**
- Inside front *(usually contains a gate)*
- Inside left
- Inside back
- Inside right
- Outside front *(usually contains a gate)*
- Outside left
- Outside back
- Outside right

*If they pick all 4 inside:* "OK I'll quote you for all the insides"

Once they tell you, **confirm back to them**:

> Okay so to confirm you want the *(name the sides)*?

{{#if has_fence_sides}}
*(They previously selected: {{fence_sides}})*
{{/if}}

## Stage 4 — Package Walkthrough

{{#if fence_brand_new}}
OK perfect, since your fence is brand new, it will not require a cleaning before we stain it. I will make sure to take that charge off the cleaning fee since it won't be needed.
{{/if}}{{#if fence_older_than_6mo}}
OK since your fence is over 6 months old, it will need to be cleaned before we stain it. We use a biodegradable chemical wash that is safe for the plants and pets. It removes the grey color, sprinkler stains, and any mold — and we also pressure wash if it's needed.

This will make sure the stain penetrates the wood properly.
{{/if}}

## Stage 5 — Explain the Packages

Once we clean and stain it we will apply the stain based on your chosen package which we will have on the estimate. Would you like me to explain the packages or would you prefer to review them when I send the estimate?

**The first package is the Essential** — it's a clear stain that protects the fence and lasts one to three years.

**The second package is the Signature Finish** — it's our most popular package. The colors are rich and have more of a natural look that lasts three to six years.

**The third package is the Legacy Premium** — a solid and bold color that gives you the maximum protection and typically lasts three to eight years.

Okay, and just to let you know, every package comes with **2 coats of stain** and we also **back-brush** the stain.

## Stage 6 — Set Estimate Expectations

Perfect, once I get off the call I'm going to measure your fence on Google Earth and then I'll text you your estimate here in a few minutes. Do you have any questions before I send you the estimate?

## Stage 7 — Goodbye

Okay, thank you, have a great day!

---

**If you don't know the answer:**

> "That's a great question for our project manager. I'll have him reach out to you after this call!"
"""


class CallScriptBody(BaseModel):
    content: str


def _ensure_seed(db) -> CallScript:
    """Lazy seed — first read on a fresh DB inserts the initial script.
    Subsequent reads return whatever admin has saved."""
    row = db.query(CallScript).filter(CallScript.id == DEFAULT_SCRIPT_ID).first()
    if row:
        return row
    row = CallScript(
        id=DEFAULT_SCRIPT_ID,
        content=INITIAL_SCRIPT,
        updated_at=_now(),
        updated_by="system",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.get("/call-script")
def get_call_script(user: dict = Depends(get_current_user)):
    """Open to all roles — VA + admin both load the script. Workers don't
    have a use case but no reason to hide it."""
    del user
    db = get_db()
    try:
        row = _ensure_seed(db)
        return row.to_dict()
    finally:
        db.close()


@router.put("/call-script")
def update_call_script(body: CallScriptBody, user: dict = Depends(require_admin)):
    db = get_db()
    try:
        row = _ensure_seed(db)
        row.content = body.content or ""
        row.updated_at = _now()
        row.updated_by = user.get("name", "")
        db.commit()
        db.refresh(row)
        return row.to_dict()
    except Exception as e:
        db.rollback()
        raise HTTPException(500, str(e))
    finally:
        db.close()
