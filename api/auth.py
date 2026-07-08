"""Meta (Facebook) OAuth flow for Odylic Lens. BYO Meta App.

Self-hosted single-tenant: the operator creates one Meta App in
developers.facebook.com, drops `META_APP_ID` and `META_APP_SECRET` into
`.env`, and is the sole user who ever connects through this deployment.

Flow:
  1. `GET /auth/start` returns the Facebook authorize URL (with random state).
  2. User visits it, grants `ads_read` + `ads_management` + `business_management`.
  3. Facebook redirects to `OAUTH_REDIRECT_URI` with `?code=...&state=...`.
  4. `GET /auth/callback` exchanges code → short-lived token → long-lived token,
     pulls `me`, persists user + connection, creates a session cookie, redirects
     to the web app.
  5. The frontend reads the session cookie on subsequent /api/* calls.
"""
from __future__ import annotations

import os
import secrets
import time
import urllib.parse as urlparse
from typing import Optional

import requests
from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse, JSONResponse
from pydantic import BaseModel

from meta_client import META_API_VERSION, GRAPH_BASE, MetaClient
from security import rate_limited
from store import (
    clear_app_credentials,
    create_session,
    delete_session,
    disconnect_user,
    get_access_token,
    get_connection_meta,
    get_session,
    load_app_credentials,
    save_ad_account,
    save_app_credentials,
    save_connection,
    upsert_user,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Required scopes for Creative Analysis. `ads_read` is the only strict
# requirement for read-only Insights pulls; `ads_management` gives access
# to ad/adset/campaign objects (effective_status), and `business_management`
# is needed if the user manages accounts under a Meta Business.
_DEFAULT_SCOPES = "ads_read,ads_management,business_management"

# In-process state cache (CSRF protection on the OAuth flow). State is a
# one-time-use random string; we remember it for 10 minutes max.
_STATE_CACHE: dict[str, float] = {}
_STATE_TTL_SEC = 600


def _credentials() -> dict:
    """Resolve credentials with precedence: env vars first (so a deployer
    using systemd/docker secrets isn't overridden by stale UI state), then
    UI-pasted config file as a fallback."""
    out = {
        "META_APP_ID": os.environ.get("META_APP_ID"),
        "META_APP_SECRET": os.environ.get("META_APP_SECRET"),
        "OAUTH_REDIRECT_URI": os.environ.get("OAUTH_REDIRECT_URI"),
    }
    stored = load_app_credentials()
    for k, v in stored.items():
        if not out.get(k):
            out[k] = v
    return out


def _app_id() -> str:
    v = _credentials().get("META_APP_ID")
    if not v:
        raise HTTPException(400, "META_APP_ID is not configured. Use /api/auth/configure or set it in .env.")
    return v


def _app_secret() -> str:
    v = _credentials().get("META_APP_SECRET")
    if not v:
        raise HTTPException(400, "META_APP_SECRET is not configured. Use /api/auth/configure or set it in .env.")
    return v


def _redirect_uri() -> str:
    # Default: the API listens on 8765 and the OAuth callback is on /api/.
    # Earlier default was :3001 which was a leftover from the Atelier port.
    return _credentials().get("OAUTH_REDIRECT_URI") or "http://localhost:8765/api/auth/callback"


def _credentials_configured() -> bool:
    c = _credentials()
    return bool(c.get("META_APP_ID") and c.get("META_APP_SECRET"))


class ConfigureRequest(BaseModel):
    app_id: str
    app_secret: str
    redirect_uri: Optional[str] = None


def _web_origin() -> str:
    # Where the OAuth callback bounces the browser after a successful
    # connect. In a production install the API serves the prebuilt SPA
    # on :8765, so the web origin IS :8765. We previously defaulted to
    # :5173 (Vite dev) which left fresh installs with a "this site can't
    # be reached" after OAuth completed.
    return os.environ.get("WEB_ORIGIN", "http://localhost:8765")


def current_user_id(session_id: Optional[str]) -> Optional[str]:
    """Resolve a session cookie to a Facebook user id, or None."""
    if not session_id:
        return None
    return get_session(session_id)


def require_user(session_id: Optional[str]) -> str:
    """FastAPI helper for endpoints that need an authenticated user."""
    uid = current_user_id(session_id)
    if not uid:
        raise HTTPException(401, "Not authenticated. Visit /api/auth/start.")
    return uid


def require_meta(session_id: Optional[str]) -> tuple[str, MetaClient]:
    """Return (fb_user_id, MetaClient) or raise 401."""
    uid = require_user(session_id)
    token = get_access_token(uid)
    if not token:
        raise HTTPException(401, "Meta is not connected for this user.")
    return uid, MetaClient(token)


@router.get("/status")
def status(lens_session: Optional[str] = Cookie(None)):
    """Lightweight status. does this deployment have a Meta App configured
    and is the current visitor logged in?"""
    creds = _credentials()
    return {
        "app_configured": _credentials_configured(),
        "logged_in": bool(current_user_id(lens_session)),
        "meta_api_version": META_API_VERSION,
        "app_id_preview": (creds.get("META_APP_ID")[-4:] if creds.get("META_APP_ID") else None),
        "redirect_uri": _redirect_uri(),
        "config_source": "env" if os.environ.get("META_APP_ID") else ("file" if creds.get("META_APP_ID") else "unset"),
    }


@router.post("/configure")
def configure(req: ConfigureRequest, _rl=Depends(rate_limited("auth/configure", limit=10))):
    """Persist Meta App credentials pasted from the Setup page.
    The user can do this instead of editing `.env`. Validates the App ID
    looks like a Meta numeric ID and stores the secret encrypted on disk."""
    app_id = (req.app_id or "").strip()
    app_secret = (req.app_secret or "").strip()
    if not app_id or not app_secret:
        raise HTTPException(400, "Both app_id and app_secret are required.")
    if not app_id.isdigit():
        raise HTTPException(400, "Meta App ID should be all digits (e.g. 123456789012345). Double-check the value from developers.facebook.com → App settings → Basic.")
    save_app_credentials(app_id, app_secret, req.redirect_uri)
    return {"ok": True, "app_id_preview": app_id[-4:], "redirect_uri": _redirect_uri()}


@router.get("/check")
def check(_rl=Depends(rate_limited("auth/check", limit=20))):
    """Hits Meta's debug_token endpoint with an app-access-token to verify
    the configured App ID + Secret are valid. Returns a structured result
    the Setup page renders inline."""
    if not _credentials_configured():
        raise HTTPException(400, "No credentials to check. Configure first.")
    app_id = _app_id()
    app_secret = _app_secret()
    try:
        r = requests.get(
            f"{GRAPH_BASE}/oauth/access_token",
            params={"client_id": app_id, "client_secret": app_secret, "grant_type": "client_credentials"},
            timeout=15,
        )
        j = r.json()
    except Exception as e:
        return {"ok": False, "error": f"network error: {type(e).__name__}: {e}"}
    if "error" in j:
        err = j["error"]
        code = err.get("code")
        msg = (err.get("message") or "").lower()
        # Distinguish "bad App ID" (code 101 / "Invalid Client ID" /
        # "App not found") from "bad App Secret" (code 1 or "client_secret"
        # in the message). Saves the user a round trip of re-checking the
        # wrong field.
        if code == 101 or "invalid client id" in msg or "app not found" in msg:
            hint = (
                "Most likely the App ID is wrong or you pasted from the wrong app. "
                "Open developers.facebook.com → your app → App settings → Basic, "
                "and copy the numeric App ID at the top."
            )
        elif code in (1, 102) or "client_secret" in msg or "secret" in msg:
            hint = (
                "Most likely the App Secret is wrong or truncated. Open your Meta App → "
                "Settings → Basic → click 'Show' next to App Secret (re-enter your "
                "Facebook password if prompted) and re-paste the 32-char hex string."
            )
        else:
            hint = (
                "Recheck both App ID and App Secret from your Meta App's "
                "Settings → Basic page. Re-paste with double-click select all."
            )
        return {
            "ok": False,
            "error": err.get("message", "Meta rejected credentials"),
            "code": code,
            "type": err.get("type"),
            "hint": hint,
        }
    return {
        "ok": True,
        "app_access_token_obtained": True,
        "redirect_uri": _redirect_uri(),
        "note": (
            "Credentials accepted by Meta. Next: ensure the redirect URI above is "
            "in your App's 'Facebook Login for Business → Settings → Valid OAuth Redirect URIs', "
            "then click Connect Meta."
        ),
    }


@router.post("/unconfigure")
def unconfigure(_rl=Depends(rate_limited("auth/unconfigure", limit=5))):
    """Remove stored credentials (UI 'Reset' button). Doesn't touch .env.

    Rate-limited because it's a destructive write that doesn't require
    auth. For a self-hosted single-tenant deploy on localhost this is
    fine, but a public exposure without auth in front would let any
    LAN guest wipe the Meta config.
    """
    clear_app_credentials()
    return {"ok": True}


@router.get("/start")
def start(request: Request):
    """Return the Facebook authorize URL. Frontend redirects the browser to it."""
    state = secrets.token_urlsafe(24)
    _STATE_CACHE[state] = time.time()
    # purge any expired states opportunistically
    now = time.time()
    for k, ts in list(_STATE_CACHE.items()):
        if now - ts > _STATE_TTL_SEC:
            _STATE_CACHE.pop(k, None)
    params = {
        "client_id": _app_id(),
        "redirect_uri": _redirect_uri(),
        "state": state,
        "scope": os.environ.get("META_OAUTH_SCOPES", _DEFAULT_SCOPES),
        "response_type": "code",
    }
    url = f"https://www.facebook.com/{META_API_VERSION}/dialog/oauth?{urlparse.urlencode(params)}"
    return {"authorize_url": url, "state": state}


@router.get("/callback")
def callback(request: Request, code: str = "", state: str = "", error: str = "", error_description: str = ""):
    """OAuth callback handler. Exchanges code → token, persists, redirects to web app."""
    if error:
        return RedirectResponse(
            url=f"{_web_origin()}/?auth_error={urlparse.quote(error_description or error)}",
            status_code=302,
        )
    if not code:
        raise HTTPException(400, "Missing ?code")
    if state not in _STATE_CACHE:
        raise HTTPException(400, "Invalid or expired state parameter")
    _STATE_CACHE.pop(state, None)

    # 1) Exchange code → short-lived token
    short = requests.get(
        f"{GRAPH_BASE}/oauth/access_token",
        params={
            "client_id": _app_id(),
            "client_secret": _app_secret(),
            "redirect_uri": _redirect_uri(),
            "code": code,
        },
        timeout=30,
    ).json()
    if "error" in short:
        raise HTTPException(400, f"Token exchange failed: {short['error'].get('message')}")
    short_token = short.get("access_token")
    if not short_token:
        raise HTTPException(400, "No access_token in short-lived response")

    # 2) Exchange short-lived → long-lived (60-day) token
    long_resp = requests.get(
        f"{GRAPH_BASE}/oauth/access_token",
        params={
            "grant_type": "fb_exchange_token",
            "client_id": _app_id(),
            "client_secret": _app_secret(),
            "fb_exchange_token": short_token,
        },
        timeout=30,
    ).json()
    long_token = long_resp.get("access_token") or short_token
    expires_in = long_resp.get("expires_in")
    expires_at = int(time.time()) + int(expires_in) if expires_in else None

    # 3) Fetch user identity
    client = MetaClient(long_token)
    me = client.me("id,name,email")
    fb_user_id = me["id"]
    upsert_user(fb_user_id, me.get("name"), me.get("email"))
    save_connection(
        fb_user_id,
        long_token,
        expires_at,
        os.environ.get("META_OAUTH_SCOPES", _DEFAULT_SCOPES),
    )

    # 3a) Sync the user's ad accounts so /api/brands has something to
    # return immediately. Without this, the BrandSelector dropdown is
    # empty until the user manually refreshes. Best-effort: a single
    # account_id failure shouldn't block login.
    try:
        accounts = client.list_ad_accounts()
        for a in accounts:
            try:
                save_ad_account(fb_user_id, a)
            except Exception as e:
                print(f"[auth] save_ad_account failed for {a.get('account_id')}: {e}", flush=True)
    except Exception as e:
        print(f"[auth] account sync at login failed: {e}", flush=True)

    # 4) Issue a session cookie and bounce back to the web app. Standalone
    # flows (the Funnel Viewer) set a short-lived `lens_setup_return` cookie
    # before starting OAuth — cookies are per-host (ports ignored on
    # localhost), so it survives the facebook.com round-trip. Same-site
    # relative paths only; default stays the Lens /brands page.
    ret = "/brands"
    raw = urlparse.unquote(request.cookies.get("lens_setup_return", "") or "")
    if raw.startswith("/") and not raw.startswith("//"):
        ret = raw
    sid = create_session(fb_user_id)
    resp = RedirectResponse(url=f"{_web_origin()}{ret}", status_code=302)
    resp.delete_cookie("lens_setup_return")
    resp.set_cookie(
        key="lens_session",
        value=sid,
        max_age=60 * 60 * 24 * 30,
        httponly=True,
        samesite="lax",
        secure=os.environ.get("LENS_COOKIE_SECURE", "0") == "1",
    )
    return resp


@router.post("/logout")
def logout(response: Response, lens_session: Optional[str] = Cookie(None)):
    if lens_session:
        delete_session(lens_session)
    response.delete_cookie("lens_session")
    return {"ok": True}


@router.post("/disconnect")
def disconnect(
    response: Response,
    lens_session: Optional[str] = Cookie(None),
    _rl=Depends(rate_limited("auth/disconnect", limit=5)),
):
    """Disconnect Meta entirely. wipes tokens, accounts, sessions for this user.

    Rate-limited (5/min) to match /unconfigure's hardening. The route
    requires a valid session, but rate-limiting the auth'd endpoints
    too prevents accidental rapid double-clicks from creating racey
    state during the cleanup.
    """
    uid = require_user(lens_session)
    disconnect_user(uid)
    response.delete_cookie("lens_session")
    return {"ok": True}


@router.get("/me")
def me(lens_session: Optional[str] = Cookie(None)):
    """Current user profile + connection metadata.
    Surfaces token TTL so the UI can warn before expiry."""
    uid = require_user(lens_session)
    meta = get_connection_meta(uid)
    days_remaining = None
    if meta and meta.get("expires_at"):
        days_remaining = max(0, round((meta["expires_at"] - time.time()) / 86400, 1))
    return {
        "fb_user_id": uid,
        "connection": meta,
        "days_remaining": days_remaining,
        "warn_expiring_soon": (days_remaining is not None and days_remaining < 7),
    }
