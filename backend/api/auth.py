"""Dashboard authentication — JWT-based login for internal users."""
from __future__ import annotations
import uuid
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from jose import jwt, JWTError
import bcrypt

from database import get_db, User
from config import get_settings

router = APIRouter()
bearer = HTTPBearer(auto_error=False)
SECRET_ALGORITHM = "HS256"
TOKEN_EXPIRE_DAYS = 7


class LoginRequest(BaseModel):
    username: str
    password: str


def make_token(user: User, perms: list[str] | None = None) -> str:
    settings = get_settings()
    payload = {
        "sub": user.username,
        "name": user.display_name,
        "role": user.role,
        "employee_id": user.employee_id or "",
        "see_all_jobs": bool(getattr(user, "see_all_jobs", False)),
        # Effective permission keys (views + actions). The frontend gates nav,
        # routes, and buttons on these; backend require_perm checks them too.
        "perms": perms or [],
        "exp": datetime.now(timezone.utc) + timedelta(days=TOKEN_EXPIRE_DAYS),
    }
    return jwt.encode(payload, settings.auth_secret, algorithm=SECRET_ALGORITHM)


def get_current_user(creds: HTTPAuthorizationCredentials = Depends(bearer)):
    if not creds:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        settings = get_settings()
        payload = jwt.decode(creds.credentials, settings.auth_secret, algorithms=[SECRET_ALGORITHM])
        return payload
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")


def require_admin(user: dict = Depends(get_current_user)):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def require_staff(user: dict = Depends(get_current_user)):
    """Admin or VA — used to wall workers off from internal-only endpoints."""
    if user.get("role") not in ("admin", "va"):
        raise HTTPException(status_code=403, detail="Staff access required")
    return user


def require_fragned(user: dict = Depends(get_current_user)):
    if user.get("sub") != "fragned":
        raise HTTPException(status_code=403, detail="Access denied")
    return user


@router.post("/auth/login")
def login(body: LoginRequest):
    db = get_db()
    try:
        user = db.query(User).filter(User.username == body.username).first()
        if not user:
            raise HTTPException(status_code=401, detail="Invalid credentials")
        if not bcrypt.checkpw(body.password.encode(), user.password_hash.encode()):
            raise HTTPException(status_code=401, detail="Invalid credentials")
        # Resolve effective permissions (lazy import avoids an auth↔permissions
        # import cycle) and stamp them into the token.
        from api.permissions import perms_for_user
        perms = perms_for_user(db, user)
        return {
            "token": make_token(user, perms),
            "user": {
                "username": user.username,
                "name": user.display_name,
                "role": user.role,
                "employee_id": user.employee_id or "",
                "see_all_jobs": bool(getattr(user, "see_all_jobs", False)),
                "perms": perms,
            },
        }
    finally:
        db.close()


@router.get("/auth/me")
def me(user: dict = Depends(get_current_user)):
    return user


@router.post("/auth/logout")
def logout():
    return {"status": "ok"}


def seed_fragned_user():
    """Create fragned developer account if it doesn't exist."""
    db = get_db()
    try:
        existing = db.query(User).filter(User.username == "fragned").first()
        if existing:
            return
        now = datetime.now(timezone.utc).isoformat()
        db.add(User(
            id=str(uuid.uuid4()),
            username="fragned",
            display_name="Fragne",
            password_hash=bcrypt.hashpw(b"atpressurewash3", bcrypt.gensalt()).decode(),
            role="admin",
            created_at=now,
        ))
        db.commit()
    finally:
        db.close()


def seed_eduardo_user():
    """Create EduardoElvir admin account if it doesn't exist. One-shot
    addition per client request (2026-06-04). Idempotent: subsequent
    boots no-op once the row exists, so this is safe to leave in the
    startup chain. If Eduardo ever changes his password through a real
    flow, this function should NOT overwrite — and it doesn't, because
    the `if existing: return` branch covers that case."""
    db = get_db()
    try:
        existing = db.query(User).filter(User.username == "EduardoElvir").first()
        if existing:
            return
        now = datetime.now(timezone.utc).isoformat()
        db.add(User(
            id=str(uuid.uuid4()),
            username="EduardoElvir",
            display_name="Eduardo",
            password_hash=bcrypt.hashpw(b"atpressurewash4", bcrypt.gensalt()).decode(),
            role="admin",
            created_at=now,
        ))
        db.commit()
    finally:
        db.close()


def seed_edward_user():
    """Create the EdwardSawyer project-manager account if it doesn't exist.
    One-shot addition per client request (2026-06-28). Role is 'worker' so he
    gets the price-free employee view (UI, routing, nav), and see_all_jobs=True
    lifts the assigned-only filter so he sees every crew's jobs for oversight.
    He also gets the assign_crew permission so he can assign/unassign crews from
    the calendar (the only action permission a worker carries here).

    Idempotent — never overwrites a changed password. For an already-seeded
    Edward it backfills the assign_crew permission so existing prod rows pick up
    the new capability on deploy."""
    import json
    db = get_db()
    try:
        existing = db.query(User).filter(User.username == "EdwardSawyer").first()
        if existing:
            # Backfill assign_crew onto the existing account if missing.
            try:
                perms = json.loads(existing.permissions or "{}")
            except (json.JSONDecodeError, TypeError):
                perms = {}
            # Only set it the first time (key absent) so a later admin revoke
            # (assign_crew=false) isn't clobbered on the next boot.
            if "assign_crew" not in perms:
                perms["assign_crew"] = True
                existing.permissions = json.dumps(perms)
                db.commit()
            return
        now = datetime.now(timezone.utc).isoformat()
        db.add(User(
            id=str(uuid.uuid4()),
            username="EdwardSawyer",
            display_name="Edward",
            password_hash=bcrypt.hashpw("EdwardFences$!&".encode(), bcrypt.gensalt()).decode(),
            role="worker",
            see_all_jobs=True,
            permissions=json.dumps({"assign_crew": True}),
            created_at=now,
        ))
        db.commit()
    finally:
        db.close()


def seed_brent_user():
    """Create the BrentBrown crew account if it doesn't exist. One-shot
    addition per client request (2026-06-28). Plain worker — no see_all_jobs,
    no permission overrides — so he gets the locked-down employee view: no
    prices (worker serialization strips them) and only the jobs he's assigned
    to. Also creates a linked Employee row so he can actually be assigned jobs
    (workers resolve their schedule via User.employee_id). Idempotent."""
    from database import Employee
    db = get_db()
    try:
        if db.query(User).filter(User.username == "BrentBrown").first():
            return
        now = datetime.now(timezone.utc).isoformat()
        emp_id = str(uuid.uuid4())
        db.add(Employee(
            id=emp_id,
            first_name="Brent",
            last_name="Brown",
            display_name="Brent Brown",
            status="active",
            pay_rate=0,
            created_at=now,
        ))
        db.add(User(
            id=str(uuid.uuid4()),
            username="BrentBrown",
            display_name="Brent",
            password_hash=bcrypt.hashpw("BrentFences1$2".encode(), bcrypt.gensalt()).decode(),
            role="worker",
            employee_id=emp_id,
            see_all_jobs=False,
            created_at=now,
        ))
        db.commit()
    finally:
        db.close()


def seed_default_users():
    """Create default admin + VA users if none exist."""
    db = get_db()
    try:
        count = db.query(User).count()
        if count > 0:
            return
        now = datetime.now(timezone.utc).isoformat()
        users = [
            User(
                id=str(uuid.uuid4()),
                username="alanbonner",
                display_name="Alan",
                password_hash=bcrypt.hashpw(b"atpressurewash1", bcrypt.gensalt()).decode(),
                role="admin",
                created_at=now,
            ),
            User(
                id=str(uuid.uuid4()),
                username="thomassellnau",
                display_name="Thomas",
                password_hash=bcrypt.hashpw(b"atpressurewash2", bcrypt.gensalt()).decode(),
                role="admin",
                created_at=now,
            ),
            User(
                id=str(uuid.uuid4()),
                username="olga",
                display_name="Olga",
                password_hash=bcrypt.hashpw(b"olga5673$", bcrypt.gensalt()).decode(),
                role="va",
                created_at=now,
            ),
        ]
        for u in users:
            db.add(u)
        db.commit()
    finally:
        db.close()
