"""
Permissions — Discord-style per-account / per-role access control layered over
the base account type (admin | va | worker).

Model:
  - Every account keeps a base TYPE (role) that still governs server-side data
    security (e.g. workers never get prices, see scheduling/database.to_dict).
  - On top of that, a catalog of PERMISSIONS — page "views" and in-page
    "actions" — is resolved per user:
        effective(key) = role_baseline ← role_override ← user_override
    where role_override lives in RolePermission (editable per role) and
    user_override lives in User.permissions (editable per account).
  - The resolved permission list is embedded in the JWT so the frontend can
    gate nav/routes/buttons synchronously. Admins always keep every permission
    (no self-lockout); manage_users is admin-only.

This module owns the catalog, the resolver, and the admin user/permission CRUD
endpoints. Enforcement of the *base type* security stays where it already is
(require_staff/require_admin + role-aware to_dict).
"""
from __future__ import annotations
import json
import uuid
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
import bcrypt

from database import get_db, User, RolePermission
from api.auth import get_current_user, make_token

router = APIRouter()
logger = logging.getLogger(__name__)


# ── Catalog ──────────────────────────────────────────────────────────────
# (key, label) pairs. Keys are stable identifiers stored in the DB + JWT;
# labels are shown in the Permissions UI. Two kinds: page "views" gate which
# pages show in the nav / are openable; "actions" gate in-page controls.

VIEW_PERMS: list[tuple[str, str]] = [
    ("dashboard", "Dashboard"),
    ("leads", "Leads"),
    ("painting_upsell", "Painting Upsell"),
    ("analytics", "Analytics"),
    ("calls", "Call Coach"),
    ("training", "Training"),
    ("payroll", "Payroll / Crew"),
    ("stain_inventory", "Stain Inventory"),
    ("accounting", "Accounting"),
    ("calendar", "Job Calendar"),
    ("my_schedule", "My Schedule"),
    ("estimator", "Estimator"),
    ("invoice_queue", "Invoice Queue"),
    ("pricing", "Pricing"),
    ("settings", "Settings"),
    ("agents", "AI Agents"),
]

ACTION_PERMS: list[tuple[str, str]] = [
    ("manage_users", "Manage users & permissions"),
    ("see_prices", "See prices"),
    ("assign_crew", "Assign crew to jobs"),
    ("mark_paid", "Mark jobs paid"),
    ("delete_jobs", "Cancel / delete jobs"),
]

VIEW_KEYS = [k for k, _ in VIEW_PERMS]
ACTION_KEYS = [k for k, _ in ACTION_PERMS]
ALL_KEYS = VIEW_KEYS + ACTION_KEYS
_ALL = set(ALL_KEYS)

# Per-role baseline (which keys default ON). Admin = everything. These are the
# fallback defaults; the RolePermission table can override them per role, and
# User.permissions can override per account.
ROLE_BASELINE: dict[str, set[str]] = {
    "admin": set(_ALL),
    "va": {
        "dashboard", "leads", "painting_upsell", "analytics", "calls",
        "training", "calendar", "invoice_queue", "pricing", "settings",
        "stain_inventory",
        "see_prices", "assign_crew", "mark_paid", "delete_jobs",
    },
    "worker": {"calendar", "my_schedule"},
    # Estimator — a field role that ONLY sees the Estimator page (their own
    # schedule + clock in/out). No prices, no leads, no calendar. The admin
    # view of that same page (drive-path map) is gated separately by role.
    "estimator": {"estimator"},
}

VALID_ROLES = ("admin", "va", "worker", "estimator")


def _load_overrides(raw: str | None) -> dict[str, bool]:
    try:
        data = json.loads(raw or "{}")
        return {k: bool(v) for k, v in data.items() if k in _ALL}
    except (json.JSONDecodeError, AttributeError):
        return {}


def role_defaults(role: str, role_override_raw: str | None) -> dict[str, bool]:
    """Baseline for a role merged with its stored override row."""
    base = {k: (k in ROLE_BASELINE.get(role, set())) for k in ALL_KEYS}
    base.update(_load_overrides(role_override_raw))
    return base


def effective_permissions(role: str, user_perms_raw: str | None, role_override_raw: str | None) -> dict[str, bool]:
    """Resolve the full effective permission map for an account:
    role baseline ← role override ← per-account override. Admins always keep
    every permission (and manage_users), so an override can never lock an
    admin out of the panel that grants permissions."""
    eff = role_defaults(role, role_override_raw)
    eff.update(_load_overrides(user_perms_raw))
    if role == "admin":
        for k in ALL_KEYS:
            eff[k] = True
    return eff


def granted_keys(role: str, user_perms_raw: str | None, role_override_raw: str | None) -> list[str]:
    eff = effective_permissions(role, user_perms_raw, role_override_raw)
    return [k for k in ALL_KEYS if eff.get(k)]


def _role_override_raw(db, role: str) -> str | None:
    row = db.query(RolePermission).filter(RolePermission.role == role).first()
    return row.permissions if row else None


def perms_for_user(db, user: User) -> list[str]:
    """Effective permission keys for a User row (used at login to stamp the JWT)."""
    return granted_keys(user.role, user.permissions, _role_override_raw(db, user.role))


# ── Auth dependency ──────────────────────────────────────────────────────

def require_perm(key: str):
    """Dependency factory: 403 unless the caller has `key` (admins always pass).
    Resolves permissions LIVE from the DB so a freshly-granted permission works
    even if the caller's token predates it; falls back to the JWT-embedded perms
    if the lookup fails."""
    def _dep(user: dict = Depends(get_current_user)) -> dict:
        if user.get("role") == "admin":
            return user
        try:
            db = get_db()
            try:
                u = db.query(User).filter(User.username == user.get("sub")).first()
                if u:
                    if u.role == "admin":
                        return user
                    eff = effective_permissions(u.role, u.permissions, _role_override_raw(db, u.role))
                    if eff.get(key):
                        return user
            finally:
                db.close()
        except Exception as e:
            logger.warning(f"require_perm live lookup failed, falling back to token: {e}")
        if key in (user.get("perms") or []):
            return user
        raise HTTPException(status_code=403, detail=f"Missing permission: {key}")
    return _dep


# ── Schemas ──────────────────────────────────────────────────────────────

class CreateUserBody(BaseModel):
    username: str
    password: str
    display_name: str = ""
    role: str = "worker"
    see_all_jobs: bool = False
    permissions: dict[str, bool] = {}


class UpdateUserBody(BaseModel):
    display_name: str | None = None
    role: str | None = None
    see_all_jobs: bool | None = None
    password: str | None = None                 # optional reset
    permissions: dict[str, bool] | None = None  # full per-account override map


class RoleDefaultsBody(BaseModel):
    permissions: dict[str, bool]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _user_row(db, u: User) -> dict:
    return {
        "id": u.id,
        "username": u.username,
        "display_name": u.display_name or "",
        "role": u.role,
        "see_all_jobs": bool(getattr(u, "see_all_jobs", False)),
        "overrides": _load_overrides(u.permissions),
        "effective": effective_permissions(u.role, u.permissions, _role_override_raw(db, u.role)),
        "created_at": u.created_at or "",
    }


# ── Catalog endpoint ─────────────────────────────────────────────────────

@router.get("/admin/permissions/catalog")
def permissions_catalog(user: dict = Depends(require_perm("manage_users"))):
    """The permission catalog + per-role defaults (baseline merged with stored
    role overrides), for rendering the Permissions UI."""
    del user
    db = get_db()
    try:
        return {
            "views": [{"key": k, "label": lbl} for k, lbl in VIEW_PERMS],
            "actions": [{"key": k, "label": lbl} for k, lbl in ACTION_PERMS],
            "roles": VALID_ROLES,
            "role_defaults": {
                r: role_defaults(r, _role_override_raw(db, r)) for r in VALID_ROLES
            },
        }
    finally:
        db.close()


# ── Users CRUD ───────────────────────────────────────────────────────────

@router.get("/admin/users")
def list_users(user: dict = Depends(require_perm("manage_users"))):
    del user
    db = get_db()
    try:
        rows = db.query(User).order_by(User.created_at.asc()).all()
        return {"users": [_user_row(db, u) for u in rows]}
    finally:
        db.close()


@router.post("/admin/users")
def create_user(body: CreateUserBody, user: dict = Depends(require_perm("manage_users"))):
    del user
    db = get_db()
    try:
        username = (body.username or "").strip()
        if not username or not body.password:
            raise HTTPException(400, "username and password are required")
        if body.role not in VALID_ROLES:
            raise HTTPException(400, f"role must be one of {VALID_ROLES}")
        if db.query(User).filter(User.username == username).first():
            raise HTTPException(409, "That username already exists")
        u = User(
            id=str(uuid.uuid4()),
            username=username,
            display_name=(body.display_name or username).strip(),
            password_hash=bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode(),
            role=body.role,
            see_all_jobs=bool(body.see_all_jobs),
            permissions=json.dumps(_load_overrides(json.dumps(body.permissions))),
            created_at=_now(),
        )
        db.add(u)
        db.commit()
        db.refresh(u)
        return _user_row(db, u)
    finally:
        db.close()


@router.patch("/admin/users/{user_id}")
def update_user(user_id: str, body: UpdateUserBody, user: dict = Depends(require_perm("manage_users"))):
    db = get_db()
    try:
        u = db.query(User).filter(User.id == user_id).first()
        if not u:
            raise HTTPException(404, "User not found")

        # Guard against demoting/locking out the last admin.
        demoting_admin = u.role == "admin" and body.role is not None and body.role != "admin"
        if demoting_admin:
            admin_count = db.query(User).filter(User.role == "admin").count()
            if admin_count <= 1:
                raise HTTPException(400, "Can't demote the last admin")

        if body.display_name is not None:
            u.display_name = body.display_name.strip()
        if body.role is not None:
            if body.role not in VALID_ROLES:
                raise HTTPException(400, f"role must be one of {VALID_ROLES}")
            u.role = body.role
        if body.see_all_jobs is not None:
            u.see_all_jobs = bool(body.see_all_jobs)
        if body.password:
            u.password_hash = bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode()
        if body.permissions is not None:
            u.permissions = json.dumps(_load_overrides(json.dumps(body.permissions)))
        db.commit()
        db.refresh(u)
        return _user_row(db, u)
    finally:
        db.close()


@router.delete("/admin/users/{user_id}")
def delete_user(user_id: str, user: dict = Depends(require_perm("manage_users"))):
    db = get_db()
    try:
        u = db.query(User).filter(User.id == user_id).first()
        if not u:
            raise HTTPException(404, "User not found")
        if u.username == user.get("sub"):
            raise HTTPException(400, "You can't delete your own account")
        if u.role == "admin" and db.query(User).filter(User.role == "admin").count() <= 1:
            raise HTTPException(400, "Can't delete the last admin")
        db.delete(u)
        db.commit()
        return {"status": "deleted"}
    finally:
        db.close()


@router.post("/admin/users/{user_id}/impersonate")
def impersonate_user(user_id: str, user: dict = Depends(require_perm("manage_users"))):
    """Mint a session token for another account so an admin can switch to it and
    act fully as that user. The token carries impersonated_by so the app shows a
    'return to your account' banner. Gated on manage_users (admin-only)."""
    db = get_db()
    try:
        target = db.query(User).filter(User.id == user_id).first()
        if not target:
            raise HTTPException(404, "User not found")
        if target.username == user.get("sub"):
            raise HTTPException(400, "You're already on this account.")
        perms = perms_for_user(db, target)
        imp = {"sub": user.get("sub", ""), "name": user.get("name", "")}
        logger.info(f"[IMPERSONATE] {user.get('sub')} → {target.username}")
        return {
            "token": make_token(target, perms, impersonated_by=imp),
            "user": {
                "username": target.username,
                "name": target.display_name,
                "role": target.role,
                "employee_id": target.employee_id or "",
                "see_all_jobs": bool(getattr(target, "see_all_jobs", False)),
                "perms": perms,
                "impersonated_by": imp,
            },
        }
    finally:
        db.close()


# ── Per-role defaults ────────────────────────────────────────────────────

@router.put("/admin/permissions/roles/{role}")
def set_role_defaults(role: str, body: RoleDefaultsBody, user: dict = Depends(require_perm("manage_users"))):
    """Override a role's default permissions. Stored as a sparse map on top of
    the code baseline; affects every account of that role that doesn't have a
    per-account override for the same key."""
    del user
    if role not in VALID_ROLES:
        raise HTTPException(400, f"role must be one of {VALID_ROLES}")
    db = get_db()
    try:
        overrides = _load_overrides(json.dumps(body.permissions))
        row = db.query(RolePermission).filter(RolePermission.role == role).first()
        if row:
            row.permissions = json.dumps(overrides)
            row.updated_at = _now()
        else:
            db.add(RolePermission(role=role, permissions=json.dumps(overrides), updated_at=_now()))
        db.commit()
        return {"role": role, "defaults": role_defaults(role, json.dumps(overrides))}
    finally:
        db.close()
