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


def make_token(user: User, perms: list[str] | None = None, impersonated_by: dict | None = None) -> str:
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
    # Impersonation session: which admin is acting as this user. Drives the
    # "return to your account" banner. Absent on normal logins.
    if impersonated_by:
        payload["impersonated_by"] = impersonated_by
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


def get_current_user_optional(creds: HTTPAuthorizationCredentials = Depends(bearer)):
    """Like get_current_user but returns None instead of raising when there's no
    valid token. For endpoints that want best-effort attribution (e.g. who sent
    an estimate) without enforcing auth or changing their contract."""
    if not creds:
        return None
    try:
        settings = get_settings()
        payload = jwt.decode(creds.credentials, settings.auth_secret, algorithms=[SECRET_ALGORITHM])
        return payload
    except JWTError:
        return None


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


# Revenue / QuickBooks-invoice pages are a restricted preview — only these
# specific accounts may access them (expand later, e.g. to Olga, on approval).
REVENUE_USERS = {"fragned", "alanbonner"}


def require_revenue(user: dict = Depends(get_current_user)):
    if (user.get("sub") or "").lower() not in REVENUE_USERS:
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
        if getattr(user, "disabled", False):
            raise HTTPException(status_code=403, detail="This account has been deactivated.")
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


@router.post("/auth/refresh")
def refresh(user: dict = Depends(get_current_user)):
    """Re-issue a token with freshly-resolved permissions/role so changes made
    by an admin take effect on the user's next app load — no manual logout.
    The frontend calls this on startup."""
    db = get_db()
    try:
        u = db.query(User).filter(User.username == user.get("sub")).first()
        if not u:
            raise HTTPException(status_code=401, detail="User no longer exists")
        from api.permissions import perms_for_user
        perms = perms_for_user(db, u)
        # Carry the impersonation marker across refresh so the banner persists.
        imp = user.get("impersonated_by")
        return {
            "token": make_token(u, perms, impersonated_by=imp),
            "user": {
                "username": u.username,
                "name": u.display_name,
                "role": u.role,
                "employee_id": u.employee_id or "",
                "see_all_jobs": bool(getattr(u, "see_all_jobs", False)),
                "perms": perms,
                "impersonated_by": imp,
            },
        }
    finally:
        db.close()


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


def seed_emmanuel_user():
    """Ensure the EmmanuelOnibayo estimator account exists and is ACTIVE.

    Timeline: created 2026-06-29; archived 2026-07-14 (quit) and replaced by
    Neo; re-hired 2026-07-16 — so this now REACTIVATES him (disabled=False) and
    Neo is the archived one instead (see seed_neo_user). Locked-down 'estimator'
    role (Estimator page only). Idempotent — never overwrites a changed
    password; re-asserts role + active state on each boot."""
    db = get_db()
    try:
        existing = db.query(User).filter(User.username == "EmmanuelOnibayo").first()
        if existing:
            changed = False
            if existing.role != "estimator":
                existing.role = "estimator"
                changed = True
            # Re-hired 2026-07-16 — unblock login.
            if existing.disabled:
                existing.disabled = False
                changed = True
            if changed:
                db.commit()
            return
        now = datetime.now(timezone.utc).isoformat()
        db.add(User(
            id=str(uuid.uuid4()),
            username="EmmanuelOnibayo",
            display_name="Emmanuel",
            password_hash=bcrypt.hashpw("EmmanuelFences1$2".encode(), bcrypt.gensalt()).decode(),
            role="estimator",
            see_all_jobs=False,
            disabled=False,
            created_at=now,
        ))
        db.commit()
    finally:
        db.close()


def seed_neo_user():
    """Ensure the NeoHerrera estimator account exists but is ARCHIVED.

    Neo covered for Emmanuel starting 2026-07-16 then stepped out when Emmanuel
    was re-hired — so this now DEACTIVATES Neo (disabled=True), keeping the row
    (history/links intact) while blocking login. To reactivate, set
    disabled=False. Idempotent; never overwrites a changed password."""
    db = get_db()
    try:
        existing = db.query(User).filter(User.username == "NeoHerrera").first()
        if existing:
            changed = False
            if existing.role != "estimator":
                existing.role = "estimator"
                changed = True
            # Stepped out 2026-07-16 (Emmanuel re-hired) — block login.
            if not existing.disabled:
                existing.disabled = True
                changed = True
            if changed:
                db.commit()
            return
        now = datetime.now(timezone.utc).isoformat()
        db.add(User(
            id=str(uuid.uuid4()),
            username="NeoHerrera",
            display_name="Neo",
            password_hash=bcrypt.hashpw("NeoFences979#!".encode(), bcrypt.gensalt()).decode(),
            role="estimator",
            see_all_jobs=False,
            disabled=True,
            created_at=now,
        ))
        db.commit()
    finally:
        db.close()


def migrate_neo_visits_to_emmanuel():
    """One-shot: hand Neo's remaining estimate appointments back to Emmanuel.

    Reverses the 2026-07-16 Emmanuel→Neo transfer now that Emmanuel is re-hired
    and Neo is archived. Moves EVERY still-'scheduled' visit from Neo to
    Emmanuel; done/canceled visits stay attributed to Neo so history + his time
    records are untouched. Idempotent: after the first run Neo has no scheduled
    rows left, so later boots are a no-op."""
    from database import EstimatorVisit
    OLD, NEW = "NeoHerrera", "EmmanuelOnibayo"
    db = get_db()
    try:
        moved = (
            db.query(EstimatorVisit)
            .filter(
                EstimatorVisit.estimator_user_id == OLD,
                EstimatorVisit.status == "scheduled",
            )
            .update(
                {EstimatorVisit.estimator_user_id: NEW},
                synchronize_session=False,
            )
        )
        db.commit()
        if moved:
            import logging
            logging.getLogger(__name__).info(
                f"migrate_neo_visits_to_emmanuel: moved {moved} scheduled visit(s) from {OLD} to {NEW}"
            )
    finally:
        db.close()


def seed_olga_estimator_access():
    """Grant Olga (the VA) access to the Estimator view. One-off per client
    request (2026-07-01). She keeps her 'va' role; we just add the 'estimator'
    permission as a per-account override so the nav item + /estimator route
    unlock for her. Admin-only pieces of that page (drive-path map, the "+"
    scheduler, edit-time) stay role-gated to admin, so she gets the read view.

    Idempotent — only sets the key the first time (absent) so a later admin
    revoke (estimator=false) via the Permissions UI isn't clobbered on boot."""
    import json
    db = get_db()
    try:
        u = db.query(User).filter(User.username == "olga").first()
        if not u:
            return
        try:
            perms = json.loads(u.permissions or "{}")
        except (json.JSONDecodeError, TypeError):
            perms = {}
        if "estimator" not in perms:
            perms["estimator"] = True
            u.permissions = json.dumps(perms)
            db.commit()
    finally:
        db.close()


def seed_geoconda_user():
    """Create the Geoconda VA account if it doesn't exist. One-off addition per
    client request (2026-07-20) — a second VA login. Plain 'va' role, same
    access as the original olga account (no estimator override unless an admin
    grants it later via the Permissions UI). Idempotent — never overwrites a
    changed password."""
    db = get_db()
    try:
        if db.query(User).filter(User.username == "Geoconda").first():
            return
        now = datetime.now(timezone.utc).isoformat()
        db.add(User(
            id=str(uuid.uuid4()),
            username="Geoconda",
            display_name="Geoconda",
            password_hash=bcrypt.hashpw("FenceCare5528#".encode(), bcrypt.gensalt()).decode(),
            role="va",
            created_at=now,
        ))
        db.commit()
    finally:
        db.close()


def seed_anna_moran_user():
    """Create the AnnaMoran VA account if it doesn't exist. One-off addition per
    client request (2026-07-24) — a third VA login. Plain 'va' role, same access
    as the original olga account (no estimator override unless an admin grants it
    later via the Permissions UI). Idempotent — never overwrites a changed
    password."""
    db = get_db()
    try:
        if db.query(User).filter(User.username == "AnnaMoran").first():
            return
        now = datetime.now(timezone.utc).isoformat()
        db.add(User(
            id=str(uuid.uuid4()),
            username="AnnaMoran",
            display_name="Anna",
            password_hash=bcrypt.hashpw("FenceLove803!".encode(), bcrypt.gensalt()).decode(),
            role="va",
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
