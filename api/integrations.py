"""Third-party integration API key management for Odylic Lens.

Single-tenant: keys are global to the deployment. The current Lens
session is required so anonymous internet traffic can't poke at
configuration. Plaintext keys are never returned over the API.

Providers:
  - atria    . creative search (https://app.tryatria.com/), keys typically
                start `atria_`
  - anthropic. Deep profile + AI tagging, keys start `sk-ant-`

OpenAI was removed in v0.2: audio transcription now runs entirely in
the user's browser via @huggingface/transformers. no hosted fallback.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Cookie, Depends, HTTPException
from pydantic import BaseModel

from auth import require_user
from security import rate_limited
from store import (
    delete_integration_key,
    get_integration_meta,
    list_integrations,
    save_integration_key,
)

router = APIRouter(prefix="/api/integrations", tags=["integrations"])


# ─────────────────────────────────────────────────────────────────────
# Validation
# ─────────────────────────────────────────────────────────────────────

_KNOWN_PROVIDERS = {"atria", "anthropic", "ads_library"}


class SaveKeyRequest(BaseModel):
    api_key: str


def _validate(provider: str, api_key: str) -> str:
    """Sanity-check the key format. Returns the trimmed key.
    Raises HTTPException(400) on obvious problems.

    Intentionally permissive. Atria's key prefix is `atria_` today, but
    we don't fail hard if it changes; we just require *something* non-empty.
    """
    key = (api_key or "").strip()
    if not key:
        raise HTTPException(400, "api_key is required.")
    if len(key) < 8:
        raise HTTPException(400, "api_key looks too short to be valid.")
    if provider == "anthropic":
        if not key.startswith("sk-ant-"):
            raise HTTPException(
                400,
                "Anthropic API keys start with 'sk-ant-'. Get one at https://console.anthropic.com/settings/keys."
            )
    if provider == "ads_library":
        # App access tokens are `{app_id}|{app_secret}`; user access
        # tokens (rarer here) are long opaque strings. Accept either —
        # the only hard requirement is the pipe-form looks well-formed
        # if a pipe is present, so we catch the common paste error of
        # forgetting half.
        if "|" in key:
            left, _, right = key.partition("|")
            if not left.isdigit() or not right:
                raise HTTPException(
                    400,
                    "App access token must be `{app_id}|{app_secret}` — App ID is all digits, secret is a long hex string."
                )
    # Atria: prefer keys like `atria_xxx` but don't reject. Atria has been
    # known to issue keys with different prefixes for partner integrations.
    return key


def _meta_or_empty(provider: str) -> dict:
    """Public response shape. never leaks the plaintext key."""
    meta = get_integration_meta(provider)
    if not meta:
        return {"provider": provider, "configured": False, "last_4": None, "updated_at": None}
    return {
        "provider": provider,
        "configured": True,
        "last_4": meta.get("last_4"),
        "updated_at": meta.get("updated_at"),
    }


# ─────────────────────────────────────────────────────────────────────
# Generic provider endpoints (factored to avoid copy-paste)
# ─────────────────────────────────────────────────────────────────────


def _save(provider: str, body: SaveKeyRequest, lens_session: Optional[str]) -> dict:
    require_user(lens_session)
    key = _validate(provider, body.api_key)
    save_integration_key(provider, key)
    return {"ok": True, "provider": provider, "last_4": _meta_or_empty(provider)["last_4"]}


def _get(provider: str, lens_session: Optional[str]) -> dict:
    require_user(lens_session)
    return _meta_or_empty(provider)


def _delete(provider: str, lens_session: Optional[str]) -> dict:
    require_user(lens_session)
    delete_integration_key(provider)
    return {"ok": True, "provider": provider}


# ─────────────────────────────────────────────────────────────────────
# Atria
# ─────────────────────────────────────────────────────────────────────


@router.post("/atria")
def save_atria(
    body: SaveKeyRequest,
    lens_session: Optional[str] = Cookie(None),
    _rl=Depends(rate_limited("integrations/atria/save", limit=10)),
):
    return _save("atria", body, lens_session)


@router.get("/atria")
def get_atria(lens_session: Optional[str] = Cookie(None)):
    return _get("atria", lens_session)


@router.delete("/atria")
def delete_atria(lens_session: Optional[str] = Cookie(None)):
    return _delete("atria", lens_session)


# Anthropic. powers Deep profile generation and any AI-tagged columns
# in Creative Analysis (sentiment, angle/persona/template classification,
# video script extraction). Lens v0.1 also accepts ANTHROPIC_API_KEY from
# the environment as a fallback when no stored key exists, so single-
# operator self-hosted deploys don't have to use this UI.

@router.post("/anthropic")
def save_anthropic(
    body: SaveKeyRequest,
    lens_session: Optional[str] = Cookie(None),
    _rl=Depends(rate_limited("integrations/anthropic/save", limit=10)),
):
    return _save("anthropic", body, lens_session)


@router.get("/anthropic")
def get_anthropic(lens_session: Optional[str] = Cookie(None)):
    return _get("anthropic", lens_session)


@router.delete("/anthropic")
def delete_anthropic(lens_session: Optional[str] = Cookie(None)):
    return _delete("anthropic", lens_session)


# ─────────────────────────────────────────────────────────────────────
# Ads Library token. Public, no-OAuth path.
#
# Default resolution (in ``ads_library_endpoints._bundled_token``) is
# ``LENS_LIBRARY_TOKEN`` env → ``META_APP_ID|META_APP_SECRET`` env →
# UI-stored Meta App creds. A user who wants to override the default
# (e.g. with a token from a different Meta App, or an Odylic-hosted
# token) can paste it here and we read it before falling back to env.
# ─────────────────────────────────────────────────────────────────────

@router.post("/ads_library")
def save_ads_library(
    body: SaveKeyRequest,
    lens_session: Optional[str] = Cookie(None),
    _rl=Depends(rate_limited("integrations/ads_library/save", limit=10)),
):
    return _save("ads_library", body, lens_session)


@router.get("/ads_library")
def get_ads_library(lens_session: Optional[str] = Cookie(None)):
    return _get("ads_library", lens_session)


@router.delete("/ads_library")
def delete_ads_library(lens_session: Optional[str] = Cookie(None)):
    return _delete("ads_library", lens_session)


# ─────────────────────────────────────────────────────────────────────
# List
# ─────────────────────────────────────────────────────────────────────


@router.get("")
@router.get("/")
def list_all(lens_session: Optional[str] = Cookie(None)):
    """Safe metadata for every configured integration. Always returns the
    full known-provider set with `configured: false` for missing ones so
    the UI doesn't have to special-case absence."""
    require_user(lens_session)
    by_provider = {row["provider"]: row for row in list_integrations()}
    out = []
    for provider in sorted(_KNOWN_PROVIDERS):
        if provider in by_provider:
            row = by_provider[provider]
            out.append({
                "provider": provider,
                "configured": True,
                "last_4": row.get("last_4"),
                "updated_at": row.get("updated_at"),
            })
        else:
            out.append({"provider": provider, "configured": False, "last_4": None, "updated_at": None})
    return {"integrations": out}
