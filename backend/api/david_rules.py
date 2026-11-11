"""David's rules on the dashboard (Alan, 2026-11-11): Documents -> David's
rules. The same list the Claude app reads and teaches (services/david_playbook.py).
Alan only, like his Ideas."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.ideas import require_alan
from database import get_db
from services import david_playbook

router = APIRouter()


class RuleBody(BaseModel):
    text: str


def _list(db) -> dict:
    return {"rules": david_playbook.rules(db)}


def _log(db, tool: str, what: str) -> None:
    from services.mcp_tools import _log_change
    _log_change(db, tool, "", what)
    db.commit()


@router.get("/david-rules")
def list_rules(user: dict = Depends(require_alan)):
    db = get_db()
    try:
        return _list(db)
    finally:
        db.close()


@router.post("/david-rules")
def add_rule(body: RuleBody, user: dict = Depends(require_alan)):
    db = get_db()
    try:
        out = david_playbook.teach(db, body.text)
        if out["added"]:
            _log(db, "teach_david", f"(dashboard) {out['rule']['text']}")
        return dict(_list(db), added=out["added"])
    except david_playbook.RuleError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        db.close()


@router.put("/david-rules/{n}")
def edit_rule(n: int, body: RuleBody, user: dict = Depends(require_alan)):
    db = get_db()
    try:
        out = david_playbook.edit(db, n, body.text)
        _log(db, "edit_david_rule", f"(dashboard) #{n}: {out['before']} -> {out['text']}")
        return _list(db)
    except david_playbook.RuleError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        db.close()


@router.delete("/david-rules/{n}")
def delete_rule(n: int, user: dict = Depends(require_alan)):
    db = get_db()
    try:
        gone = david_playbook.forget(db, n)
        _log(db, "forget_david_rule", f"(dashboard) #{gone['n']}: {gone['text']}")
        return _list(db)
    except david_playbook.RuleError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        db.close()
