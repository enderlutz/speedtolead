"""The dashboard as an MCP server for the Claude app (Alan, 2026-11-10).

Alan adds one "custom connector" in the Claude app (phone or laptop) with the
URL  <railway address>/mcp . Claude then signs in once and can call the tools
in services/mcp_tools.py.

Sign-in is OAuth 2.1 with PKCE, the way Claude's connectors expect it:

    GET  /.well-known/oauth-protected-resource   where to sign in
    GET  /.well-known/oauth-authorization-server the sign-in endpoints
    POST /mcp/oauth/register     Claude registers itself (no secret)
    GET  /mcp/oauth/authorize    the "Sign in to Sterling Dashboard" page
    POST /mcp/oauth/authorize    checks the owner password, sends a code back
    POST /mcp/oauth/token        code (or refresh token) -> access token
    POST /mcp                    the MCP calls themselves (JSON-RPC)

The one secret is MCP_OWNER_PASSWORD in Railway. Unset = the whole thing is
off (404). Every token is signed with AUTH_SECRET and carries
MCP_TOKEN_VERSION: bump that number in Railway to sign every device out.
Nothing is stored in the database; client ids, codes and tokens are all signed
and short-lived where it matters (codes 5 minutes, access 1 day, refresh 60).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import html
import json
import logging
import secrets
import time
from urllib.parse import urlencode

from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from jose import JWTError, jwt

from config import get_settings

router = APIRouter()
logger = logging.getLogger(__name__)

ALG = "HS256"
PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
SERVER_INFO = {"name": "Sterling Dashboard", "version": "1.0"}
INSTRUCTIONS = (
    "Sterling Fence Staining's dashboard (Houston fence staining company). "
    "Start with find_customer to get a lead_id. Times are Houston time. Read the customer's "
    "texts and latest call before drafting anything to them. Texting a customer is two steps: "
    "draft_text, show Alan the exact words, edit with another draft_text, and call send_text "
    "only when Alan's latest message says 'send'. Never send on your own. Before any change "
    "tool (set_job, set_crew, add_note, log_receipt, teach_stella, teach_david, forget_david_rule, "
    "david_day_off), say exactly what will change and wait for Alan's OK. Crew never see prices."
)
PLAYBOOK_CAP = 8000  # per playbook, so the initialize reply stays a sensible size


def _cap(text: str, tool: str) -> str:
    text = (text or "").strip()
    if len(text) <= PLAYBOOK_CAP:
        return text
    return text[:PLAYBOOK_CAP].rsplit("\n", 1)[0] + f"\n… (cut here; call {tool} for the rest)"


def instructions() -> str:
    """The fixed INSTRUCTIONS plus the rules Alan has taught David and Stella,
    read fresh from the database on every connection. Never fails: a database
    problem just leaves the playbooks off."""
    parts = [INSTRUCTIONS]
    try:
        from database import SystemConfig, get_db
        from services import david_playbook, stella
        db = get_db()
        try:
            david = david_playbook.playbook_text(db)
            stella_text = SystemConfig.get(db, stella.PLAYBOOK_KEY, "") or stella.DEFAULT_PLAYBOOK
        finally:
            db.close()
        parts.append("Follow these rules Alan has taught. Rules for jobs, crew and materials are David's; "
                     "rules for leads, calls and sales are Stella's.")
        parts.append("== DAVID (AI Project Manager) ==\n"
                     + (_cap(david, "david_rules") or "No rules yet. Add them with teach_david."))
        parts.append("== STELLA (AI Sales Manager) ==\n" + _cap(stella_text, "stella"))
    except Exception:  # noqa: BLE001
        logger.exception("mcp: could not read the playbooks for initialize")
    return "\n\n".join(parts)
CODE_TTL = 300
ACCESS_TTL = 24 * 3600
REFRESH_TTL = 60 * 24 * 3600
_used_codes: dict[str, float] = {}
_fails: dict[str, list[float]] = {}


# ── settings / helpers ─────────────────────────────────────────────────────

def _password() -> str:
    return (get_settings().mcp_owner_password or "").strip()


def _enabled() -> bool:
    return len(_password()) >= 12


def _key() -> str:
    s = get_settings()
    return hmac.new(s.auth_secret.encode(), b"mcp-v1", hashlib.sha256).hexdigest()


def _version() -> str:
    return str(get_settings().mcp_token_version or "1")


def _base(request: Request) -> str:
    fixed = (get_settings().mcp_public_url or "").strip().rstrip("/")
    if fixed:
        return fixed
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or "localhost"
    proto = request.headers.get("x-forwarded-proto") or ("http" if host.startswith(("localhost", "127.")) else "https")
    return f"{proto}://{host}"


def _sign(claims: dict, ttl: int | None) -> str:
    body = dict(claims, v=_version(), iat=int(time.time()))
    if ttl:
        body["exp"] = int(time.time()) + ttl
    return jwt.encode(body, _key(), algorithm=ALG)


def _read(token: str, typ: str) -> dict | None:
    try:
        c = jwt.decode(token or "", _key(), algorithms=[ALG])
    except JWTError:
        return None
    if c.get("typ") != typ or c.get("v") != _version():
        return None
    return c


def _off() -> Response:
    return JSONResponse({"error": "not_found"}, status_code=404)


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return (fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "")) or "?"


def _too_many(ip: str) -> bool:
    now = time.time()
    _fails[ip] = [t for t in _fails.get(ip, []) if now - t < 900]
    return len(_fails[ip]) >= 5


# ── discovery ──────────────────────────────────────────────────────────────

@router.get("/.well-known/oauth-protected-resource")
@router.get("/.well-known/oauth-protected-resource/mcp")
def protected_resource(request: Request):
    if not _enabled():
        return _off()
    base = _base(request)
    return {"resource": f"{base}/mcp", "authorization_servers": [base],
            "bearer_methods_supported": ["header"]}


@router.get("/.well-known/oauth-authorization-server")
@router.get("/.well-known/oauth-authorization-server/mcp")
def auth_server(request: Request):
    if not _enabled():
        return _off()
    base = _base(request)
    return {
        "issuer": base,
        "authorization_endpoint": f"{base}/mcp/oauth/authorize",
        "token_endpoint": f"{base}/mcp/oauth/token",
        "registration_endpoint": f"{base}/mcp/oauth/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": ["dashboard"],
    }


# ── OAuth ──────────────────────────────────────────────────────────────────

@router.post("/mcp/oauth/register")
async def register(request: Request):
    if not _enabled():
        return _off()
    try:
        body = await request.json()
    except Exception:
        body = {}
    uris = [u for u in (body.get("redirect_uris") or []) if isinstance(u, str)]
    if not uris or not all(u.startswith(("https://", "http://localhost", "http://127.0.0.1")) for u in uris):
        return JSONResponse({"error": "invalid_redirect_uri"}, status_code=400)
    name = str(body.get("client_name") or "Claude")[:80]
    client_id = _sign({"typ": "client", "uris": uris, "name": name}, None)
    return JSONResponse({
        "client_id": client_id, "client_name": name, "redirect_uris": uris,
        "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
        "token_endpoint_auth_method": "none", "client_id_issued_at": int(time.time()),
    }, status_code=201)


def _page(fields: dict, error: str = "") -> HTMLResponse:
    hidden = "".join(f'<input type="hidden" name="{html.escape(k)}" value="{html.escape(v)}">'
                     for k, v in fields.items())
    err = f'<p class="err">{html.escape(error)}</p>' if error else ""
    return HTMLResponse(f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to Sterling Dashboard</title>
<style>body{{margin:0;background:#f7f3ea;color:#1c1a17;font:16px/1.5 -apple-system,system-ui,sans-serif}}
main{{max-width:420px;margin:12vh auto;padding:28px 20px}}h1{{font-size:24px;margin:0 0 8px}}
p{{margin:0 0 20px;color:#4a453d}}input[type=password]{{width:100%;box-sizing:border-box;font-size:18px;
padding:14px;border:1px solid #c9bfa8;border-radius:10px;background:#fff}}button{{width:100%;margin-top:14px;
min-height:48px;font-size:17px;border:0;border-radius:10px;background:#1c1a17;color:#fff}}
.err{{color:#a3261b;font-weight:600}}</style></head><body><main>
<h1>Sterling Dashboard</h1><p>Let Claude read the dashboard (customers, jobs, crew, stain, money).
Enter the owner password.</p>{err}
<form method="post" action="/mcp/oauth/authorize">{hidden}
<input type="password" name="password" autocomplete="current-password" autofocus required>
<button type="submit">Allow</button></form></main></body></html>""")


def _check_request(q: dict) -> tuple[dict | None, str]:
    client = _read(q.get("client_id", ""), "client")
    if not client:
        return None, "Unknown app. Remove the connector and add it again."
    if q.get("redirect_uri") not in client.get("uris", []):
        return None, "That return address isn't registered."
    if q.get("response_type", "code") != "code":
        return None, "Unsupported response type."
    if q.get("code_challenge_method") != "S256" or len(q.get("code_challenge", "")) < 43:
        return None, "Missing PKCE challenge."
    return client, ""


_KEEP = ("client_id", "redirect_uri", "response_type", "state", "code_challenge",
         "code_challenge_method", "scope", "resource")


@router.get("/mcp/oauth/authorize")
def authorize_page(request: Request):
    if not _enabled():
        return _off()
    q = {k: request.query_params.get(k, "") for k in _KEEP}
    _client, err = _check_request(q)
    if err:
        return HTMLResponse(f"<p>{html.escape(err)}</p>", status_code=400)
    return _page(q)


@router.post("/mcp/oauth/authorize")
async def authorize_submit(request: Request):
    if not _enabled():
        return _off()
    form = await request.form()
    q = {k: str(form.get(k, "")) for k in _KEEP}
    _client, err = _check_request(q)
    if err:
        return HTMLResponse(f"<p>{html.escape(err)}</p>", status_code=400)
    ip = _client_ip(request)
    if _too_many(ip):
        return _page(q, "Too many tries. Wait 15 minutes.")
    if not hmac.compare_digest(str(form.get("password", "")).encode(), _password().encode()):
        _fails.setdefault(ip, []).append(time.time())
        logger.warning("mcp sign-in: wrong password")
        return _page(q, "Wrong password.")
    code = _sign({"typ": "code", "cid": q["client_id"], "uri": q["redirect_uri"],
                  "pkce": q["code_challenge"], "jti": secrets.token_urlsafe(12)}, CODE_TTL)
    params = {"code": code}
    if q["state"]:
        params["state"] = q["state"]
    logger.info("mcp sign-in: approved")
    sep = "&" if "?" in q["redirect_uri"] else "?"
    return RedirectResponse(q["redirect_uri"] + sep + urlencode(params), status_code=302)


def _pkce_ok(verifier: str, challenge: str) -> bool:
    digest = hashlib.sha256((verifier or "").encode()).digest()
    calc = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return bool(verifier) and hmac.compare_digest(calc, challenge or "")


def _tokens(client_id: str) -> dict:
    return {
        "access_token": _sign({"typ": "access", "cid": client_id}, ACCESS_TTL),
        "refresh_token": _sign({"typ": "refresh", "cid": client_id, "jti": secrets.token_urlsafe(8)}, REFRESH_TTL),
        "token_type": "Bearer", "expires_in": ACCESS_TTL, "scope": "dashboard",
    }


def _bad(error: str, desc: str = "") -> JSONResponse:
    return JSONResponse({"error": error, "error_description": desc}, status_code=400)


@router.post("/mcp/oauth/token")
async def token(request: Request):
    if not _enabled():
        return _off()
    form = await request.form()
    grant = form.get("grant_type", "")
    client_id = str(form.get("client_id", ""))
    if grant == "authorization_code":
        c = _read(str(form.get("code", "")), "code")
        if not c or c.get("cid") != client_id or c.get("uri") != form.get("redirect_uri"):
            return _bad("invalid_grant", "Code is wrong or expired.")
        now = time.time()
        for k in [k for k, t in _used_codes.items() if now - t > CODE_TTL]:
            _used_codes.pop(k, None)
        if c["jti"] in _used_codes:
            return _bad("invalid_grant", "Code already used.")
        if not _pkce_ok(str(form.get("code_verifier", "")), c.get("pkce", "")):
            return _bad("invalid_grant", "PKCE check failed.")
        _used_codes[c["jti"]] = now
        return JSONResponse(_tokens(client_id), headers={"Cache-Control": "no-store"})
    if grant == "refresh_token":
        c = _read(str(form.get("refresh_token", "")), "refresh")
        if not c or (client_id and c.get("cid") != client_id):
            return _bad("invalid_grant", "Sign in again.")
        return JSONResponse(_tokens(c["cid"]), headers={"Cache-Control": "no-store"})
    return _bad("unsupported_grant_type")


# ── MCP (JSON-RPC over HTTP) ───────────────────────────────────────────────

def _unauthorized(request: Request) -> Response:
    meta = f"{_base(request)}/.well-known/oauth-protected-resource"
    return JSONResponse({"error": "unauthorized"}, status_code=401,
                        headers={"WWW-Authenticate": f'Bearer resource_metadata="{meta}"'})


def _rpc_result(mid, result) -> dict:
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def _rpc_error(mid, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}}


def _handle(msg: dict) -> dict | None:
    from database import get_db
    from services import mcp_tools

    method = msg.get("method", "")
    mid = msg.get("id")
    params = msg.get("params") or {}
    if mid is None:  # a notification (e.g. notifications/initialized): no reply
        return None
    if method == "initialize":
        asked = params.get("protocolVersion", "")
        return _rpc_result(mid, {
            "protocolVersion": asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO, "instructions": instructions(),
        })
    if method == "ping":
        return _rpc_result(mid, {})
    if method == "tools/list":
        return _rpc_result(mid, {"tools": mcp_tools.list_tools()})
    if method == "tools/call":
        db = get_db()
        try:
            out = mcp_tools.call_tool(db, params.get("name", ""), params.get("arguments") or {})
            text = json.dumps(out, default=str, ensure_ascii=False)
            return _rpc_result(mid, {"content": [{"type": "text", "text": text}], "isError": False})
        except mcp_tools.ToolError as e:
            return _rpc_result(mid, {"content": [{"type": "text", "text": str(e)}], "isError": True})
        except Exception:
            logger.exception("mcp tool failed: %s", params.get("name"))
            return _rpc_result(mid, {"content": [{"type": "text", "text": "That lookup failed on the server."}],
                                     "isError": True})
        finally:
            db.close()
    return _rpc_error(mid, -32601, f"Method not found: {method}")


@router.post("/mcp")
async def mcp(request: Request):
    if not _enabled():
        return _off()
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer ") or not _read(auth[7:].strip(), "access"):
        return _unauthorized(request)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(_rpc_error(None, -32700, "Parse error"), status_code=400)
    if isinstance(body, list):
        replies = [r for r in [await run_in_threadpool(_handle, m) for m in body if isinstance(m, dict)] if r]
        return JSONResponse(replies) if replies else Response(status_code=202)
    if not isinstance(body, dict):
        return JSONResponse(_rpc_error(None, -32600, "Invalid request"), status_code=400)
    reply = await run_in_threadpool(_handle, body)
    return JSONResponse(reply) if reply else Response(status_code=202)


@router.get("/mcp")
def mcp_get():
    if not _enabled():
        return _off()
    return Response(status_code=405, headers={"Allow": "POST"})


@router.delete("/mcp")
def mcp_delete():
    return Response(status_code=405, headers={"Allow": "POST"})
