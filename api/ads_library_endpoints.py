"""Meta Ads Library API — public, no-OAuth path.

This is the "browse mode" of Odylic Lens. The Ads Library API at
``/ads_archive`` is open: any app access token (``{app_id}|{app_secret}``)
can hit it, and it returns public delivery data for ads currently or
recently shown on Meta's platforms.

Why the separate router
-----------------------
The Insights/Marketing API (``/act_<id>/ads``, ``/insights``, etc.) is
gated by per-user OAuth and App Review. Ads Library isn't. So we keep
Library calls behind their own router with their own token resolver and
explicitly *don't* require ``require_meta``. A user can install Lens,
skip the Setup wizard entirely, and immediately browse ads.

Field coverage caveat
---------------------
For ``ad_type=ALL`` (commercial ads — what DTC researchers want), Meta
returns a narrow field set: page name, creative bodies/titles/captions,
ad snapshot URL, delivery window, reached countries, publisher
platforms. The rich fields — exact impressions, spend, demographic
distribution, delivery_by_region — are only populated for
``ad_type=POLITICAL_AND_ISSUE_ADS`` (US) or EU ads under DSA. We expose
both modes; the frontend grays out fields the current mode can't fill.
"""
from __future__ import annotations

import os
import time
from typing import Any, Optional

import requests
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from meta_client import GRAPH_BASE


router = APIRouter(prefix="/api/ads-library", tags=["ads-library"])

LIBRARY_TIMEOUT = 30


# Fields the Library API returns for ad_type=ALL (commercial). Anything
# requiring DSA / political-ads data lives in _RICH_FIELDS below and we
# only request it when the caller opts in.
_BASE_FIELDS = ",".join([
    "id",
    "ad_creation_time",
    "ad_creative_bodies",
    "ad_creative_link_captions",
    "ad_creative_link_descriptions",
    "ad_creative_link_titles",
    "ad_delivery_start_time",
    "ad_delivery_stop_time",
    "ad_snapshot_url",
    "languages",
    "page_id",
    "page_name",
    "publisher_platforms",
    "ad_reached_countries",
])

_RICH_FIELDS = ",".join([
    "bylines",
    "currency",
    "delivery_by_region",
    "demographic_distribution",
    "estimated_audience_size",
    "impressions",
    "spend",
    "target_ages",
    "target_gender",
    "target_locations",
])


# Module-level token cache — the app access token doesn't expire so we
# memoise it for the process lifetime. Set on first /search call.
_TOKEN_CACHE: dict[str, Any] = {"token": None, "fetched_at": 0.0}


def _bundled_token() -> Optional[str]:
    """Resolve the Library token without going through user OAuth.

    Resolution order (highest priority first):
      1. UI-pasted token from Settings → Ads Library (stored encrypted
         via the integrations store as provider ``ads_library``). Lets
         the user override the default with a token from a different
         Meta App or an Odylic-hosted token.
      2. ``LENS_LIBRARY_TOKEN`` — explicit pre-baked token (for headless
         deploys or if we ship a hosted token-mint endpoint later).
      3. ``META_APP_ID|META_APP_SECRET`` — concatenated form is a valid
         app access token for ``/ads_archive`` per Meta's docs. We do
         the trivial concat locally rather than minting via
         ``oauth/access_token`` because Meta documents both as
         equivalent for public endpoints and the local form skips a
         network round-trip on every cold start.
      4. UI-stored Meta App creds via ``store.load_app_credentials`` —
         same as #3 but for users who configured via the Setup wizard.

    Returns ``None`` if no source is configured; callers should 503.

    NOTE: cache is intentionally bypassed when a Settings override is
    set, because the UI's "Save" needs to take effect immediately
    without a process restart.
    """
    # Settings override first. Don't cache. saves are infrequent and
    # the lookup is a cheap SQLite read.
    try:
        from store import get_integration_key
        override = get_integration_key("ads_library")
        if override:
            return override
    except Exception:
        pass

    cached = _TOKEN_CACHE.get("token")
    if cached:
        return cached

    pre_baked = os.environ.get("LENS_LIBRARY_TOKEN")
    if pre_baked:
        _TOKEN_CACHE["token"] = pre_baked
        _TOKEN_CACHE["fetched_at"] = time.time()
        return pre_baked

    app_id = os.environ.get("META_APP_ID")
    app_secret = os.environ.get("META_APP_SECRET")
    if not (app_id and app_secret):
        try:
            from store import load_app_credentials
            stored = load_app_credentials() or {}
            app_id = app_id or stored.get("META_APP_ID")
            app_secret = app_secret or stored.get("META_APP_SECRET")
        except Exception:
            pass

    if app_id and app_secret:
        token = f"{app_id}|{app_secret}"
        _TOKEN_CACHE["token"] = token
        _TOKEN_CACHE["fetched_at"] = time.time()
        return token

    return None


def _require_token() -> str:
    t = _bundled_token()
    if not t:
        raise HTTPException(
            status_code=503,
            detail=(
                "Ads Library mode unavailable — no LENS_LIBRARY_TOKEN set "
                "and no META_APP_ID/SECRET configured. Either bake a token "
                "into your install or finish the Setup wizard."
            ),
        )
    return t


@router.get("/status")
def status():
    """Tell the frontend whether the Library path is usable.

    The Landing page calls this to decide whether to show the "Browse
    Ads Library" CTA alongside the BYO-app Setup flow.
    """
    settings_override = False
    try:
        from store import get_integration_key
        settings_override = bool(get_integration_key("ads_library"))
    except Exception:
        pass

    return {
        "available": bool(_bundled_token()),
        "source": (
            "settings_override" if settings_override
            else "env_token" if os.environ.get("LENS_LIBRARY_TOKEN")
            else "env_app" if (os.environ.get("META_APP_ID") and os.environ.get("META_APP_SECRET"))
            else "file_app" if _bundled_token()
            else "unset"
        ),
    }


@router.get("/search")
def search(
    search_terms: Optional[str] = Query(None, description="Keyword search across ad text."),
    search_page_ids: Optional[str] = Query(None, description="Comma-separated Facebook Page IDs."),
    ad_reached_countries: str = Query("US", description="Comma-separated ISO country codes. Required by Meta."),
    ad_active_status: str = Query("ALL", description="ALL | ACTIVE | INACTIVE."),
    ad_type: str = Query("ALL", description="ALL (commercial) | POLITICAL_AND_ISSUE_ADS (richer fields)."),
    ad_delivery_date_min: Optional[str] = Query(None, description="YYYY-MM-DD."),
    ad_delivery_date_max: Optional[str] = Query(None, description="YYYY-MM-DD."),
    publisher_platforms: Optional[str] = Query(None, description="Comma-separated: FACEBOOK,INSTAGRAM,AUDIENCE_NETWORK,MESSENGER,THREADS."),
    languages: Optional[str] = Query(None, description="Comma-separated ISO language codes."),
    limit: int = Query(50, ge=1, le=500),
    after: Optional[str] = Query(None, description="Pagination cursor from a prior response."),
):
    """Proxy ``GET /ads_archive`` with sensible defaults.

    Notes:
    * ``ad_reached_countries`` is required by Meta; we default to ``US``
      so a naked ``/search?search_terms=skincare`` call works.
    * For commercial creative research, leave ``ad_type=ALL``. The richer
      ``impressions``/``spend``/``demographic_distribution`` fields will
      be empty for those ads, which is what the frontend gray-out hint
      is for.
    """
    if not (search_terms or search_page_ids):
        raise HTTPException(400, "Provide either search_terms or search_page_ids.")

    token = _require_token()
    fields = _BASE_FIELDS
    if ad_type == "POLITICAL_AND_ISSUE_ADS" or ad_reached_countries.upper().startswith(("EU", "DE", "FR", "IT", "ES", "NL", "BE", "AT", "PL", "SE", "DK", "FI", "PT", "IE", "GR", "CZ")):
        fields = f"{_BASE_FIELDS},{_RICH_FIELDS}"

    params: list[tuple[str, Any]] = [
        ("access_token", token),
        ("ad_reached_countries", f"[{','.join(repr(c.strip()) for c in ad_reached_countries.split(','))}]"),
        ("ad_active_status", ad_active_status),
        ("ad_type", ad_type),
        ("fields", fields),
        ("limit", str(limit)),
    ]
    if search_terms:
        params.append(("search_terms", search_terms))
    if search_page_ids:
        params.append(("search_page_ids", f"[{','.join(repr(p.strip()) for p in search_page_ids.split(','))}]"))
    if ad_delivery_date_min:
        params.append(("ad_delivery_date_min", ad_delivery_date_min))
    if ad_delivery_date_max:
        params.append(("ad_delivery_date_max", ad_delivery_date_max))
    if publisher_platforms:
        params.append(("publisher_platforms", f"[{','.join(repr(p.strip()) for p in publisher_platforms.split(','))}]"))
    if languages:
        params.append(("languages", f"[{','.join(repr(l.strip()) for l in languages.split(','))}]"))
    if after:
        params.append(("after", after))

    try:
        r = requests.get(f"{GRAPH_BASE}/ads_archive", params=params, timeout=LIBRARY_TIMEOUT)
    except requests.RequestException as e:
        raise HTTPException(502, f"Ads Library request failed: {type(e).__name__}: {e}")

    j = r.json()
    if "error" in j:
        # Pass through Meta's error so the frontend toast is meaningful.
        return JSONResponse(status_code=r.status_code or 502, content=j)
    return j


@router.get("/page-lookup")
def page_lookup(q: str = Query(..., description="Page name fragment.")):
    """Convenience helper: search the Ads Library and return distinct
    ``(page_id, page_name)`` tuples from the first 100 hits so the
    frontend can offer typeahead before committing to a full search."""
    token = _require_token()
    params: list[tuple[str, Any]] = [
        ("access_token", token),
        ("ad_reached_countries", "['US']"),
        ("ad_active_status", "ACTIVE"),
        ("ad_type", "ALL"),
        ("fields", "page_id,page_name"),
        ("search_terms", q),
        ("limit", "100"),
    ]
    try:
        r = requests.get(f"{GRAPH_BASE}/ads_archive", params=params, timeout=LIBRARY_TIMEOUT)
        j = r.json()
    except requests.RequestException as e:
        raise HTTPException(502, f"Ads Library request failed: {type(e).__name__}: {e}")
    if "error" in j:
        return JSONResponse(status_code=r.status_code or 502, content=j)
    seen: dict[str, str] = {}
    for row in j.get("data", []):
        pid = row.get("page_id")
        pname = row.get("page_name")
        if pid and pname and pid not in seen:
            seen[pid] = pname
    return {"pages": [{"page_id": k, "page_name": v} for k, v in seen.items()]}
