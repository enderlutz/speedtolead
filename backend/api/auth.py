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


def make_token(user: User) -> str:
    settings = get_settings()
    payload = {
        "sub": user.username,
        "name": user.display_name,
        "role": user.role,
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
        return {
            "token": make_token(user),
            "user": {
                "username": user.username,
                "name": user.display_name,
                "role": user.role,
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
