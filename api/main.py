"""Odylic Lens API. FastAPI entrypoint.

Self-hosted, single-tenant. Run:
    uvicorn main:app --reload --port 8765

The frontend (Vite) runs on :5173 and proxies /api/* here.

Structure:
* ``auth``. OAuth flow, session cookie, /api/auth/*
* ``integrations``. encrypted third-party key store (Atria, OpenAI)
* ``ad_analysis_endpoints``. full Creative Analysis suite, ported from
  Atelier (~7400 lines, 33 routes), monkey-patched to use the current
  user's Meta credentials instead of Atelier's global token + dict.
* ``lens_routes``. Lens-native top-level endpoints (/api/brands,
  /api/metrics, /api/profile, plus stubs for taxonomy/trends/boards).
* ``lens_context``. middleware that loads the per-request access token
  + brand map from the lens_session cookie.
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

_HERE = Path(__file__).resolve().parent
load_dotenv(_HERE.parent / ".env", override=False)
load_dotenv(_HERE / ".env", override=False)

# Atelier's CA module fires a background thread that prewarms the in-process
# creative cache by iterating ``META_ACCOUNTS`` and calling Graph for each
# brand. In Lens the user might not be logged in at boot, and we don't want
# anonymous cycles hitting Meta. Disable the global prewarmer; the cache
# is still populated on demand whenever a user opens the CA tab.
os.environ.setdefault("ATELIER_DISABLE_PREWARM", "1")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from auth import router as auth_router
from integrations import router as integrations_router
from security import SecurityHeadersMiddleware
from store import init_db
from lens_context import LensContextMiddleware, patch_ad_analysis_endpoints
from lens_routes import router as lens_router
from transcription import router as transcribe_router
from ads_reports_endpoints import router as ads_reports_router
from boards_endpoints import router as boards_router
from atria_endpoints import router as atria_router
from ads_library_endpoints import router as ads_library_router

app = FastAPI(
    title="Odylic Lens API",
    version="0.1.0",
    description=(
        "Self-hosted Meta Marketing API analyzer. BYO Meta App. "
        "Creative Analysis ported from ad-connector / Atelier."
    ),
)

# CORS for the Vite dev server (and any prod web origin set in env).
_origins = [
    os.environ.get("WEB_ORIGIN", "http://localhost:5173"),
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    # Tightened from `["*"]` to the explicit verbs we actually use. CORS
    # with credentials + wildcard verbs/headers is technically allowed
    # but lets a future XS-leak chain hit any endpoint we add without
    # the operator noticing. Adding a new verb? Update this list.
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Requested-With", "Cookie"],
)
app.add_middleware(SecurityHeadersMiddleware)
# LensContextMiddleware must run AFTER session-cookie parsing (which
# Starlette does as part of every request), so registration order here
# is fine. middleware is wrapped in LIFO order, this runs innermost.
app.add_middleware(LensContextMiddleware)

init_db()

# Optional Meta mock for E2E tests. see test_mock.py.
try:
    from test_mock import install_if_enabled as _install_mock
    if _install_mock():
        print("[odylic-lens] LENS_TEST_MOCK_META=1. Meta API mocked")
except Exception as e:
    print(f"[odylic-lens] mock install failed: {e}")

app.include_router(auth_router)
app.include_router(integrations_router)
# Real Reports + Boards + Atria routers must mount BEFORE lens_router
# so they win the path matching. lens_routes still ships placeholder
# stubs at some of these paths for fallback / pre-config preview.
app.include_router(ads_reports_router)
app.include_router(boards_router)
app.include_router(atria_router)
app.include_router(ads_library_router)
app.include_router(lens_router)
app.include_router(transcribe_router)

# Atelier-ported Creative Analysis router. Import BEFORE the patch so the
# module exists, then patch.
from ad_analysis_endpoints import router as ad_analysis_router
patch_ad_analysis_endpoints()
app.include_router(ad_analysis_router)


LENS_VERSION = "0.3.0"


@app.get("/api/status")
def status():
    return {
        "service": "odylic-lens-api",
        "version": LENS_VERSION,
        "meta_app_configured": bool(os.environ.get("META_APP_ID") and os.environ.get("META_APP_SECRET")),
        "secret_key_configured": bool(os.environ.get("LENS_SECRET_KEY")),
    }


@app.get("/api/update-check")
def update_check(force: bool = False):
    """Lightweight update probe used by the UI to show an "Update
    available" chip. Cached to disk for 24h so we don't hit GitHub on
    every page load. Returns:
       {current: "0.3.0", latest: "0.3.1", needs_update: true}
    Falls back to {needs_update: false} on any failure. never blocks
    the UI on network problems.

    Pass `?force=1` to bypass the 24h cache. used by the "Check now"
    button in Settings so the user can manually refresh.
    """
    import json as _json
    import time as _time
    from pathlib import Path as _Path

    cache_dir = _Path(os.environ.get("LENS_DATA_DIR", str(_Path.home() / ".odylic-lens")))
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / "update_check.json"

    # 24h debounce unless force=1.
    now = _time.time()
    if not force and cache_file.exists():
        try:
            cached = _json.loads(cache_file.read_text())
            if (now - cached.get("ts", 0)) < 86400:
                return {**cached.get("payload", {}), "cached": True}
        except Exception:
            pass

    payload: dict = {"current": LENS_VERSION, "latest": LENS_VERSION, "needs_update": False}
    try:
        import httpx
        repo = os.environ.get("LENS_UPDATE_REPO", "peterquads/odylic-lens")
        r = httpx.get(
            f"https://api.github.com/repos/{repo}/releases/latest",
            timeout=5.0,
            headers={"Accept": "application/vnd.github+json"},
        )
        if r.status_code == 200:
            data = r.json()
            latest = (data.get("tag_name") or "").lstrip("v")
            if latest:
                payload["latest"] = latest
                # Lexical compare on version strings is good enough for
                # the major.minor.patch scheme. ditches the dependency
                # on packaging.version.
                payload["needs_update"] = latest != LENS_VERSION
                payload["html_url"] = data.get("html_url")
    except Exception:
        # Network problems shouldn't break the UI. swallow + return
        # the "no update" payload.
        pass

    try:
        cache_file.write_text(_json.dumps({"ts": now, "payload": payload}))
    except Exception:
        pass
    return payload


# Static SPA fallback. only mounts if a built bundle exists.
_WEB_DIST = _HERE.parent / "web" / "dist"
if _WEB_DIST.exists():
    from fastapi.staticfiles import StaticFiles
    from fastapi.responses import FileResponse

    app.mount("/assets", StaticFiles(directory=_WEB_DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa_fallback(path: str):
        target = _WEB_DIST / path
        if path and target.exists() and target.is_file():
            return FileResponse(target)
        return FileResponse(_WEB_DIST / "index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=int(os.environ.get("PORT", 8765)), reload=False)
