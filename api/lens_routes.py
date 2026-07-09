"""Lens-native top-level API endpoints.

These mirror Atelier's ``api_server.py`` routes but adapted for a
per-user data model. Specifically:

* ``GET /api/brands``. list the logged-in user's ad accounts (treating
  each ad account as a "brand"). Returns a payload shape compatible with
  the Atelier ``BrandSelector`` component.
* ``GET /api/metrics``. static metric catalog (Meta only; no Google).
* ``GET /api/profile``. brand-profile lookup (favicon, domain,
  description). Stored per-user in ``~/.odylic-lens/brand_profile.json``.
* ``POST /api/profile/generate-deep``. currently a 501 stub (used by
  BrandSettingsView's "deep research" button).

Plus small stubs for endpoints the ported BrandSettingsView /
AdAnalysisView reach for that don't have a real backend in Lens yet:
* ``GET/POST /api/brand-profiles/...``
* ``GET /api/planner/taxonomy*`` (returns an empty taxonomy)
* ``GET /api/trends/keywords`` (returns empty list)
* ``GET /api/planner/statuses-for-ads``, ``/api/planner/ucid-for-ad/...``
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Cookie, HTTPException, Query, Request
from pydantic import BaseModel

from auth import current_user_id
from store import (
    list_ad_accounts,
    get_brand_section,
    save_brand_section,
    list_brand_sections,
)

router = APIRouter()

# ---------------------------------------------------------------------------
# Profile store. small JSON-on-disk keyed by (user, brand).
# ---------------------------------------------------------------------------

def _profile_path() -> Path:
    base = Path(os.environ.get("LENS_DATA_DIR", str(Path.home() / ".odylic-lens")))
    base.mkdir(parents=True, exist_ok=True)
    return base / "brand_profile.json"


def _load_profiles() -> dict:
    p = _profile_path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except Exception:
        return {}


def _save_profiles(d: dict) -> None:
    p = _profile_path()
    p.write_text(json.dumps(d, indent=2))


# ---------------------------------------------------------------------------
# Brand list
# ---------------------------------------------------------------------------

@router.get("/api/brands")
def list_brands(lens_session: Optional[str] = Cookie(None)) -> list[dict]:
    """List the logged-in user's connected Meta ad accounts as 'brands'.

    The Atelier frontend uses ``brand.name`` as the canonical identifier;
    here we use the account's friendly_name (or Meta name). Google is
    always false in Lens. we only do Meta. The Meta account_id is
    returned without the ``act_`` prefix to match Atelier's format.
    """
    uid = current_user_id(lens_session)
    if not uid:
        return []
    rows = list_ad_accounts(uid)
    result: list[dict] = []
    seen: set[str] = set()
    for r in rows:
        if r.get("hidden"):
            continue
        name = (r.get("friendly_name") or r.get("name") or str(r.get("account_id") or "")).strip()
        if not name or name in seen:
            continue
        seen.add(name)
        aid = str(r.get("account_id") or "").strip()
        if aid.startswith("act_"):
            aid = aid[4:]
        result.append({
            "name": name,
            "meta": True,
            "google": False,
            "meta_account_id": aid,
            "google_account_ids": [],
        })
    result.sort(key=lambda x: x["name"].lower())
    return result


# ---------------------------------------------------------------------------
# Metrics catalog. copied verbatim from Atelier api_server.py (Meta only).
# Google catalog is dropped (Lens is Meta-only). meta_breakdowns is kept.
# ---------------------------------------------------------------------------

@router.get("/api/metrics")
def list_metrics() -> dict:
    return {
        "meta": _META_METRICS,
        "google": [],  # Lens is Meta-only; kept for shape compatibility.
        "meta_breakdowns": _META_BREAKDOWNS,
    }


_META_METRICS = [
    {"key": "spend", "label": "Spend", "format": "dollar"},
    {"key": "impressions", "label": "Impressions", "format": "number"},
    {"key": "reach", "label": "Accounts Reached", "format": "number"},
    {"key": "frequency", "label": "Frequency", "format": "decimal"},
    {"key": "clicks", "label": "Clicks (All)", "format": "number"},
    {"key": "unique_clicks", "label": "Unique Clicks", "format": "number"},
    {"key": "link_clicks", "label": "Link Clicks", "format": "number"},
    {"key": "inline_link_clicks", "label": "Inline Link Clicks", "format": "number"},
    {"key": "outbound_clicks", "label": "Outbound Clicks", "format": "number"},
    {"key": "unique_outbound_clicks", "label": "Unique Outbound Clicks", "format": "number"},
    {"key": "ctr", "label": "CTR (All)", "format": "percent"},
    {"key": "unique_ctr", "label": "Unique CTR", "format": "percent"},
    {"key": "outbound_ctr", "label": "Outbound CTR", "format": "percent"},
    {"key": "unique_outbound_ctr", "label": "Unique Outbound CTR", "format": "percent"},
    {"key": "website_ctr", "label": "Website CTR", "format": "percent"},
    {"key": "inline_link_click_ctr", "label": "Inline Link CTR", "format": "percent"},
    {"key": "unique_link_clicks_ctr", "label": "Unique Link CTR", "format": "percent"},
    {"key": "cpc", "label": "CPC (All)", "format": "dollar"},
    {"key": "cost_per_unique_click", "label": "Unique CPC", "format": "dollar"},
    {"key": "cost_per_inline_link_click", "label": "Cost per Inline Link", "format": "dollar"},
    {"key": "cpm", "label": "CPM", "format": "dollar"},
    {"key": "cpp", "label": "Cost/1K Reached", "format": "dollar"},
    {"key": "purchases", "label": "Purchases", "format": "number"},
    {"key": "revenue", "label": "Purchase Conv Value", "format": "dollar"},
    {"key": "roas", "label": "ROAS", "format": "decimal"},
    {"key": "cost_per_purchase", "label": "Cost per Purchase", "format": "dollar"},
    {"key": "add_to_cart", "label": "Add to Cart", "format": "number"},
    {"key": "atc_value", "label": "ATC Value", "format": "dollar"},
    {"key": "cost_per_atc", "label": "Cost per ATC", "format": "dollar"},
    {"key": "initiate_checkout", "label": "Initiate Checkout", "format": "number"},
    {"key": "ic_value", "label": "IC Value", "format": "dollar"},
    {"key": "cost_per_ic", "label": "Cost per IC", "format": "dollar"},
    {"key": "view_content", "label": "View Content", "format": "number"},
    {"key": "vc_value", "label": "View Content Value", "format": "dollar"},
    {"key": "cost_per_vc", "label": "Cost per View Content", "format": "dollar"},
    {"key": "leads", "label": "Leads", "format": "number"},
    {"key": "lead_value", "label": "Lead Value", "format": "dollar"},
    {"key": "cost_per_lead", "label": "Cost per Lead", "format": "dollar"},
    {"key": "landing_page_views", "label": "Landing Page Views", "format": "number"},
    {"key": "cost_per_lpv", "label": "Cost per LPV", "format": "dollar"},
    {"key": "purchase_cvr", "label": "Purchase CVR", "format": "percent"},
    {"key": "atc_cvr", "label": "ATC CVR", "format": "percent"},
    {"key": "ic_cvr", "label": "IC CVR", "format": "percent"},
    {"key": "post_engagement", "label": "Post Engagement", "format": "number"},
    {"key": "post_reactions", "label": "Post Reactions", "format": "number"},
    {"key": "post_comments", "label": "Comments", "format": "number"},
    {"key": "post_shares", "label": "Shares", "format": "number"},
    {"key": "post_saves", "label": "Saves", "format": "number"},
    {"key": "video_views", "label": "Video Views", "format": "number"},
    {"key": "thruplays", "label": "ThruPlays", "format": "number"},
    {"key": "video_p25", "label": "Video Plays 25%", "format": "number"},
    {"key": "video_p50", "label": "Video Plays 50%", "format": "number"},
    {"key": "video_p75", "label": "Video Plays 75%", "format": "number"},
    {"key": "video_p95", "label": "Video Plays 95%", "format": "number"},
    {"key": "video_p100", "label": "Video Plays 100%", "format": "number"},
    {"key": "quality_ranking", "label": "Quality Ranking", "format": "text"},
    {"key": "engagement_rate_ranking", "label": "Engagement Ranking", "format": "text"},
    {"key": "conversion_rate_ranking", "label": "Conversion Ranking", "format": "text"},
]


_META_BREAKDOWNS = [
    {"key": "none", "label": "No Breakdown"},
    {"key": "age", "label": "Age"},
    {"key": "gender", "label": "Gender"},
    {"key": "age,gender", "label": "Age & Gender"},
    {"key": "publisher_platform", "label": "Platform (FB/IG/AN)"},
    {"key": "platform_position", "label": "Platform Position"},
    {"key": "publisher_platform,platform_position", "label": "Platform & Placement"},
    {"key": "impression_device", "label": "Device"},
    {"key": "country", "label": "Country"},
    {"key": "region", "label": "Region"},
    {"key": "dma", "label": "DMA"},
    {"key": "product_id", "label": "Product ID"},
]


# ---------------------------------------------------------------------------
# Profile endpoints
# ---------------------------------------------------------------------------

@router.get("/api/profile")
def get_profile(brand: str, lens_session: Optional[str] = Cookie(None)) -> dict:
    """Lookup brand profile (favicon, domain, description, etc.).

    Reads from the per-user bucket first, then falls back to the global
    bucket (``__lens_global__``) used by Atelier-ported endpoints like
    ``/api/ads/naming-convention``. The global bucket is per-deploy shared
    state. naming conventions are deploy-wide, not per-operator.
    """
    uid = current_user_id(lens_session)
    if not uid:
        return {}
    all_profiles = _load_profiles()
    per_user = all_profiles.get(uid, {}).get(brand, {}) or {}
    glob = all_profiles.get("__lens_global__", {}).get(brand, {}) or {}
    # Merge: per-user wins for keys it sets, global fills the rest.
    return {**glob, **per_user}


class ProfileSave(BaseModel):
    brand: str
    profile: dict


@router.post("/api/profile")
def save_profile(body: ProfileSave, lens_session: Optional[str] = Cookie(None)) -> dict:
    uid = current_user_id(lens_session)
    if not uid:
        raise HTTPException(401, "Not authenticated")
    all_profiles = _load_profiles()
    user_profiles = all_profiles.setdefault(uid, {})
    user_profiles[body.brand] = body.profile
    # Mirror naming_convention into the global bucket so Atelier-ported
    # endpoints (which don't carry a user_id) can read it back. Other
    # per-user fields like deep_research don't get mirrored. only the
    # deploy-wide ones the parser layer needs.
    nc = (body.profile or {}).get("naming_convention")
    if nc:
        glob = all_profiles.setdefault("__lens_global__", {})
        brand_glob = glob.setdefault(body.brand, {})
        brand_glob["naming_convention"] = nc
        # Also write ad_name_convention for the heuristic-override path
        # used by ad_analysis_endpoints.get_naming_convention.
        brand_glob["ad_name_convention"] = nc
    _save_profiles(all_profiles)
    return {"ok": True}


_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/126.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


def _fetch_url(url: str, timeout: float = 6.0, max_bytes: int = 500_000) -> str:
    """Best-effort GET. Returns body text or empty string on failure.

    Uses `requests` rather than urllib because the Python.org universal2
    installer doesn't ship a CA bundle that urllib can find by default,
    so HTTPS calls fail with CERTIFICATE_VERIFY_FAILED. requests bundles
    certifi's CA chain and works out of the box.
    """
    try:
        import requests
        resp = requests.get(
            url, headers=_BROWSER_HEADERS, timeout=timeout,
            allow_redirects=True, stream=True,
        )
        if resp.status_code >= 400:
            return ""
        # Cap bytes to avoid pulling multi-MB product pages into RAM.
        body = resp.raw.read(max_bytes, decode_content=True) or b""
        if not isinstance(body, (bytes, bytearray)):
            body = bytes(body)
        return body.decode("utf-8", errors="ignore")
    except Exception:
        return ""


def _extract_visible_text(html: str, max_chars: int) -> str:
    """Strip scripts/styles/SVG, collapse whitespace, return text only."""
    import re as _re
    body = _re.sub(r"<(script|style|noscript|svg)[^>]*>.*?</\1>", " ",
                   html, flags=_re.I | _re.S)
    text = _re.sub(r"<[^>]+>", " ", body)
    return _re.sub(r"\s+", " ", text).strip()[:max_chars]


def _extract_visual_hints(html_pages: list[str]) -> dict:
    """Mine the HTML / inline CSS for brand visual signals: hex colors,
    font-family declarations, Google Fonts links, theme-color meta.
    Returns a dict the prompt embeds so Claude doesn't have to guess.
    """
    import re as _re
    from collections import Counter

    combined = "\n".join(html_pages)
    hex_counter: Counter[str] = Counter()
    for m in _re.finditer(r"#([0-9a-fA-F]{6})\b", combined):
        h = "#" + m.group(1).upper()
        # Filter out white/black/grey-ish boilerplate noise so the top
        # hits surface actual brand colors rather than reset.css greys.
        if h in {"#FFFFFF", "#000000"}:
            continue
        hex_counter[h] += 1

    # font-family: 'X', 'Y', sans-serif;  — pick the first quoted entry
    font_counter: Counter[str] = Counter()
    for m in _re.finditer(
        r"font-family\s*:\s*['\"]([^'\"]+)['\"]", combined, _re.I
    ):
        f = m.group(1).strip()
        # Skip generic system stacks (rarely the brand font).
        if f.lower() in {"sans-serif", "serif", "monospace", "system-ui", "inherit", "initial"}:
            continue
        font_counter[f] += 1

    # <link href="https://fonts.googleapis.com/css?family=Source+Serif+Pro:..."
    gfonts: list[str] = []
    for m in _re.finditer(
        r'fonts\.googleapis\.com/css2?[^"\'\s>]*?family=([A-Za-z0-9+_-]+)',
        combined,
    ):
        fam = m.group(1).replace("+", " ")
        if fam not in gfonts:
            gfonts.append(fam)

    # <meta name="theme-color" content="#ABCDEF">
    theme_colors: list[str] = []
    for m in _re.finditer(
        r'<meta[^>]+name=["\']theme-color["\'][^>]+content=["\']([^"\']+)["\']',
        combined, _re.I,
    ):
        theme_colors.append(m.group(1))

    return {
        "top_hex_colors": [c for c, _ in hex_counter.most_common(10)],
        "theme_colors": theme_colors,
        "font_families_in_css": [f for f, _ in font_counter.most_common(6)],
        "google_fonts_loaded": gfonts[:6],
    }


# Paths we try in addition to /. About + values pages give the brand
# story; product / collection lists give voice + categories. Each
# page caps at ~6s so the total worst case is bounded even if every
# fetch hangs.
_SITE_PATHS = [
    "",                # homepage
    "/about",
    "/pages/about",
    "/pages/about-us",
    "/about-us",
    "/our-story",
    "/pages/our-story",
    "/values",
    "/pages/values",
    "/collections/all",
    "/pages/contact",
]


def _scrape_brand_site(domain: str, max_chars_total: int = 60000) -> tuple[str, dict]:
    """Best-effort multi-page fetch to give Claude actual ground truth.

    Returns ``(text_excerpt, visual_hints)``. The text excerpt
    concatenates head meta + visible-text from homepage and a small
    set of common about/values/contact pages. visual_hints contains
    mined hex colors + font families pulled directly from inline CSS.

    Why this exists: brands like `roen.nyc` don't appear in Claude's
    training data, so the model has nothing to anchor on and returns
    `null` for most fields. Feeding it the actual marketing copy +
    structured visual signals lets every dossier section get filled in.
    """
    if not domain:
        return "", {}

    import re as _re
    base = f"https://{domain}" if not domain.startswith("http") else domain
    base = base.rstrip("/")

    # Fetch homepage first; it's required. Then opportunistically try
    # the other paths, dropping any that 404 / redirect away.
    pages: list[tuple[str, str]] = []
    raw_html_pages: list[str] = []

    home = _fetch_url(base)
    if not home:
        return "", {}
    raw_html_pages.append(home)
    pages.append(("homepage", home))

    # Limit ourselves to ~4 additional pages so total fetch time stays
    # under ~30s on a slow site. Stop early once we hit the budget.
    extra_count = 0
    for path in _SITE_PATHS[1:]:
        if extra_count >= 4:
            break
        body = _fetch_url(base + path)
        if not body or len(body) < 500:
            continue
        # De-dup. Some Shopify themes redirect missing pages to /.
        if any(body == p for _, p in pages):
            continue
        raw_html_pages.append(body)
        pages.append((path, body))
        extra_count += 1

    # Mine visual hints from ALL pages we fetched (inline CSS often
    # lives in product templates not the homepage).
    visual_hints = _extract_visual_hints(raw_html_pages)

    # Build the text excerpt.
    out_parts: list[str] = []
    char_budget = max_chars_total

    for label, html in pages:
        if char_budget <= 0:
            break
        # Head metadata for this page.
        head_bits: list[str] = []
        title_m = _re.search(r"<title[^>]*>([^<]+)</title>", html, _re.I)
        if title_m:
            head_bits.append(f"title: {title_m.group(1).strip()}")
        for m in _re.finditer(
            r'<meta[^>]+(?:name|property)\s*=\s*["\']'
            r'(og:[^"\']+|description|keywords|theme-color|application-name)'
            r'["\'][^>]+content\s*=\s*["\']([^"\']+)["\']',
            html, _re.I,
        ):
            head_bits.append(f"{m.group(1)}: {m.group(2)}")

        head_text = "\n".join(head_bits)
        # Visible text gets the bulk of the budget on the homepage,
        # less on follow-up pages so we don't fill the prompt with
        # product-listing chaff.
        page_budget = min(char_budget - len(head_text), 20000 if label == "homepage" else 8000)
        if page_budget < 200:
            break
        body_text = _extract_visible_text(html, page_budget)
        block = f"--- {label} ({domain}) ---\n{head_text}\n\n{body_text}\n"
        out_parts.append(block)
        char_budget -= len(block)

    return "\n".join(out_parts), visual_hints


def _fetch_recent_ads_for_prompt(brand: str, max_ads: int = 15, countries: tuple[str, ...] = ("US",)) -> str:
    """Pull the brand's recent public Meta ads via the Ads Library API,
    formatted as a compact text block for the deep-profile prompt.

    Returns an empty string when:
      - no Library token is configured (Library mode disabled),
      - the brand name returns zero ads,
      - the Library API errors.

    Best-effort by design — brand discovery should still work without
    ads (just with poorer voice/positioning fidelity). We use
    ``search_terms=<brand>`` rather than ``search_page_ids`` so a user
    researching a competitor brand they don't own the Page ID for
    still gets results.

    Output shape is one ad per block:
        [<page_name>] (start_date → end_date | platforms)
        TITLE: ...
        BODY: ...
    Trimmed to ~6000 chars total so it doesn't dominate the prompt.
    """
    import requests as _requests

    try:
        from ads_library_endpoints import _bundled_token, LIBRARY_TIMEOUT
        from meta_client import GRAPH_BASE as _GRAPH
    except Exception:
        return ""

    token = _bundled_token()
    if not token:
        return ""

    countries_lit = f"[{','.join(repr(c) for c in countries)}]"
    params = [
        ("access_token", token),
        ("ad_reached_countries", countries_lit),
        ("ad_active_status", "ALL"),
        ("ad_type", "ALL"),
        ("fields", "ad_creative_bodies,ad_creative_link_titles,ad_delivery_start_time,ad_delivery_stop_time,publisher_platforms,page_name"),
        ("search_terms", brand),
        ("limit", str(max_ads)),
    ]
    try:
        r = _requests.get(f"{_GRAPH}/ads_archive", params=params, timeout=LIBRARY_TIMEOUT)
        j = r.json()
    except Exception as e:
        print(f"[deep-profile] Ads Library fetch failed for {brand!r}: {e}", flush=True)
        return ""
    if "error" in j or not isinstance(j.get("data"), list):
        return ""

    # Filter to ads whose page_name actually looks like the brand. The
    # Library does fuzzy text matching on ad copy, so a search for
    # "Allbirds" can return ads from random shoe retailers that just
    # mention Allbirds. Heuristic: page_name must share a token with
    # the brand name (case-insensitive).
    brand_tokens = {t for t in brand.lower().split() if len(t) > 2}
    rows: list[dict] = []
    for ad in j["data"]:
        pn = (ad.get("page_name") or "").lower()
        if brand_tokens and not any(t in pn for t in brand_tokens):
            continue
        rows.append(ad)
    if not rows:
        # Fallback: if filtering killed everything, return the raw set
        # rather than nothing. Better to give Claude noisy data than
        # zero data.
        rows = j["data"]

    parts: list[str] = []
    budget = 6000
    for ad in rows:
        pn = ad.get("page_name") or brand
        start = (ad.get("ad_delivery_start_time") or "").split("T")[0]
        stop = (ad.get("ad_delivery_stop_time") or "").split("T")[0]
        platforms = ", ".join(ad.get("publisher_platforms") or [])
        title = (ad.get("ad_creative_link_titles") or [None])[0]
        body = (ad.get("ad_creative_bodies") or [None])[0]
        # Drop nothing-useful entries (Meta sometimes returns ads where
        # the creative body is just a single emoji or whitespace).
        if not (title or body):
            continue
        block = (
            f"[{pn}] ({start}{f' → {stop}' if stop else ' → present'}"
            f"{f' | {platforms}' if platforms else ''})\n"
        )
        if title:
            block += f"TITLE: {title.strip()}\n"
        if body:
            # Cap individual ad bodies at 600 chars so one long ad
            # doesn't eat the budget.
            block += f"BODY: {body.strip()[:600]}\n"
        if len(block) > budget:
            break
        parts.append(block)
        budget -= len(block)

    return "\n".join(parts)


@router.post("/api/profile/generate-deep")
def generate_deep_profile(brand: str, lens_session: Optional[str] = Cookie(None)) -> dict:
    """Generate a rich brand profile via Claude Sonnet, merged into any
    existing saved profile (so naming convention / manual edits the
    user already made aren't clobbered).

    Strategy:
      1. Fetch the brand's homepage HTML if a domain is on file. this
         lets the model anchor on actual marketing copy / OG tags /
         visible product names rather than guessing from training data
         (which fails on long-tail DTC brands like roen.nyc).
      2. Hand Claude the brand name + homepage extract and demand the
         full JSON schema. Use null only for fields the homepage
         genuinely doesn't surface.
      3. Merge into the existing profile (manual fields like
         naming_convention always win).

    Errors during JSON parsing return {"error": "..."} (not HTTP 500)
    so the frontend can surface a clean toast rather than a blank panel.
    """
    import json as _json
    import re as _re

    if not brand:
        raise HTTPException(400, "brand is required")

    uid = current_user_id(lens_session)
    if not uid:
        raise HTTPException(401, "Not authenticated")

    # Load the user's existing brand profile so we can preserve any
    # manual fields (naming_convention, custom positioning notes, etc).
    all_profiles = _load_profiles()
    existing = all_profiles.get(uid, {}).get(brand, {}) or {}
    seed_domain = (existing.get("domain") or "").strip()

    # Resolve the Anthropic key (env or encrypted SQLite). Same path
    # the ad-analysis code uses. keeps us off the SDK's confusing
    # "Could not resolve authentication method" error.
    try:
        from ad_analysis_endpoints import _resolve_anthropic_key
        api_key = _resolve_anthropic_key()
    except Exception:
        api_key = None
    if not api_key:
        raise HTTPException(
            503,
            "No Anthropic API key configured. Add one in Settings → Anthropic.",
        )

    # Pull the homepage + about/values pages so Claude has actual brand
    # voice to read. Times out fast on each page so the UI doesn't hang
    # on a slow server.
    site_excerpt, visual_hints = _scrape_brand_site(seed_domain) if seed_domain else ("", {})

    # Pull recent Meta ads via the public Ads Library API. This gives
    # Claude access to the brand's *paid* voice — ad hooks, value props
    # they actually run in market, current promo angles — which is often
    # sharper than homepage copy (homepages get stale, ads churn weekly).
    # Best-effort: if no Library token is configured or the brand has no
    # recent ads, we silently skip. We DON'T pull from the brand's
    # private Insights API here, even if Lens is BYO-connected — Library
    # is the right source because it works for any brand the user is
    # researching, not just the ones they own ad accounts on.
    ads_excerpt = _fetch_recent_ads_for_prompt(brand)

    # Build the prompt. If the user supplied a domain, pin Claude to it
    # so it doesn't wander off into a same-name brand in another market.
    domain_clause = (
        f"\nThe brand's website is `{seed_domain}`. use this as the source of truth "
        "for domain, products, colors, fonts."
        if seed_domain
        else ""
    )
    site_clause = (
        f"\n\n--- SITE EXTRACT ({seed_domain}) ---\n{site_excerpt}\n--- END EXTRACT ---\n"
        if site_excerpt
        else ""
    )
    visual_clause = ""
    if visual_hints and any(visual_hints.values()):
        visual_clause = (
            "\n--- VISUAL SIGNALS MINED FROM THE SITE'S INLINE CSS ---\n"
            f"Most-used hex colors: {visual_hints.get('top_hex_colors') or []}\n"
            f"<meta theme-color>: {visual_hints.get('theme_colors') or []}\n"
            f"font-family declarations: {visual_hints.get('font_families_in_css') or []}\n"
            f"Google Fonts loaded: {visual_hints.get('google_fonts_loaded') or []}\n"
            "Use these as ground truth for brand_colors / color_primary / color_secondary "
            "and brand_fonts / typography_display / typography_body. Don't invent random hex codes.\n"
            "--- END VISUAL SIGNALS ---\n"
        )
    ads_clause = ""
    if ads_excerpt:
        ads_clause = (
            "\n--- RECENT META ADS (public Ads Library) ---\n"
            f"{ads_excerpt}\n"
            "Treat these as the brand's CURRENT paid voice. Use ad copy as primary "
            "evidence for do_say / dont_say / example_snippets / voice_tone / voice_attributes / "
            "proof_points / objections / unique_value_props. Where homepage copy and ad copy "
            "disagree, prefer the ad copy — it's what the brand is putting money behind right now.\n"
            "--- END RECENT META ADS ---\n"
        )
    prompt = (
        f'You are a Senior Brand Strategist building a COMPREHENSIVE brand identity '
        f'dossier for the DTC brand "{brand}".{domain_clause}{site_clause}{visual_clause}{ads_clause}\n\n'
        'Return ONLY a single JSON object with this exact shape (no prose, no code fences). '
        'Every field listed must be populated. Use `null` ONLY when the site extract, '
        'visual signals, AND your training knowledge all genuinely lack the information.\n\n'
        '{\n'
        '  /* ── Identity ── */\n'
        '  "domain": "brand.com",\n'
        '  "description": "2-3 sentence brand/product description, plain language",\n'
        '  "tagline": "Short marketing tagline if one is visible on the site",\n'
        '  "founded_year": "YYYY or null",\n'
        '  "hq_location": "City, State/Country or null",\n'
        '  "mission_statement": "1-2 sentences — what the brand exists to do",\n'
        '  "logo_url": "https://full-url-to-brand-logo.png or null if unknown",\n'
        '  "favicon": null,\n'
        '\n'
        '  /* ── Positioning ── */\n'
        '  "category": "Specific market category (e.g. \\"premium leather handbags\\")",\n'
        '  "competitive_frame": "Adjacent set the brand competes against (e.g. \\"Polène, Cuyana, Mansur Gavriel\\")",\n'
        '  "differentiator": "1 sentence — what makes this brand specifically different",\n'
        '  "positioning_statement": "For [audience], [brand] is the [category] that [differentiator].",\n'
        '  "proof_points": ["concrete proof 1", "concrete proof 2", "concrete proof 3"],\n'
        '\n'
        '  /* ── Brand Pyramid ── */\n'
        '  "brand_essence": "2-3 word essence (e.g. \\"Quiet confidence\\")",\n'
        '  "brand_values": ["value 1", "value 2", "value 3", "value 4"],\n'
        '  "personality_traits": ["adjective 1", "adjective 2", "adjective 3", "adjective 4"],\n'
        '  "functional_benefits": ["benefit 1", "benefit 2", "benefit 3"],\n'
        '  "emotional_benefits": ["benefit 1", "benefit 2", "benefit 3"],\n'
        '\n'
        '  /* ── Audience ── */\n'
        '  "primary_persona": "Name + 2 sentence sketch of the single sharpest customer.",\n'
        '  "target_personas": [\n'
        '    {"name": "First name", "description": "1-2 sentences covering age, lifestyle, motivation"}\n'
        '  ],\n'
        '  "secondary_personas": [\n'
        '    {"name": "First name", "description": "1-2 sentences"}\n'
        '  ],\n'
        '  "jobs_to_be_done": ["functional + emotional + social JTBD 1", "JTBD 2", "JTBD 3"],\n'
        '  "objections": ["likely objection 1", "objection 2", "objection 3"],\n'
        '\n'
        '  /* ── Voice & Tone ── */\n'
        '  "voice_tone": "Short paragraph describing the brand voice (formal/casual, warm/clinical, etc).",\n'
        '  "voice_attributes": ["adjective 1", "adjective 2", "adjective 3", "adjective 4"],\n'
        '  "do_say": ["phrase or word the brand uses", "another", "another", "another"],\n'
        '  "dont_say": ["phrase the brand never uses", "another", "another"],\n'
        '  "example_snippets": ["one real headline pulled from the site", "another", "another"],\n'
        '\n'
        '  /* ── Visual ── */\n'
        '  "brand_colors": [\n'
        '    {"hex": "#1A1A1A", "name": "Near Black", "usage": "primary"},\n'
        '    {"hex": "#F2F0ED", "name": "Cream", "usage": "background"}\n'
        '  ],\n'
        '  "color_primary": "#1A1A1A",\n'
        '  "color_secondary": "#F2F0ED",\n'
        '  "brand_fonts": {"primary": "Display font family", "secondary": "Body font family"},\n'
        '  "typography_display": "Display font family",\n'
        '  "typography_body": "Body font family",\n'
        '  "logo_dos": ["do 1", "do 2"],\n'
        '  "logo_donts": ["dont 1", "dont 2"],\n'
        '\n'
        '  /* ── Products ── */\n'
        '  "hero_products": ["top seller 1", "top seller 2", "top seller 3"],\n'
        '  "categories": ["category 1", "category 2", "category 3"],\n'
        '  "products": [\n'
        '    {"name": "Product name", "description": "One-sentence summary", '
        '"hero_image": null, "price_range": "$29-$49", "sku": null}\n'
        '  ],\n'
        '  "price_range": "$X - $Y across the catalog",\n'
        '  "merchandising_notes": "Anything notable about how the catalog is organized (drops, seasons, collabs)",\n'
        '\n'
        '  /* ── Social ── */\n'
        '  "social_links": {"instagram": "https://… or null", "tiktok": "https://… or null", "website": "https://brand.com"},\n'
        '\n'
        '  /* ── Performance benchmarks (best-guess targets, not actuals) ── */\n'
        '  "cac_target": "Estimated healthy CAC for this category, e.g. \\"$45-$70\\"",\n'
        '  "ltv_target": "Estimated 12-month LTV, e.g. \\"$180-$240\\"",\n'
        '  "margin_target": "Typical gross margin band, e.g. \\"55-65%\\"",\n'
        '  "top_channels": ["Meta", "Google", "TikTok", "Email"],\n'
        '\n'
        '  /* ── Compliance ── */\n'
        '  "claims_allowed": ["claim the brand can safely make", "another", "another"],\n'
        '  "claims_avoided": ["claim the brand should avoid making", "another"],\n'
        '  "trademarks": ["™ or ® mark visible on site", "another"],\n'
        '\n'
        '  /* ── Strategic context ── */\n'
        '  "competitors": ["direct competitor 1", "direct competitor 2", "direct competitor 3"],\n'
        '  "unique_value_props": ["uvp 1", "uvp 2", "uvp 3"]\n'
        '}\n\n'
        'Requirements: 3-5 hero_products, 2-4 categories, 2-3 target_personas, '
        '2-4 brand_colors, 3-6 products, 3-5 unique_value_props, 2-4 competitors, '
        '3-5 brand_values, 3-4 personality_traits, 3-5 do_say items, 2-4 dont_say items, '
        '3 example_snippets pulled VERBATIM from the site extract when possible. '
        'Plain language. No em dashes. Short sentences. domain should be '
        '`brand.com` format (no https://). \n\n'
        'IMPORTANT: When a site extract is provided above, treat it as '
        'ground truth and EXTRACT real product names, real categories, real '
        'value props, real headlines, and the real voice/tone from that copy. '
        'Do not fall back to null when the site gives evidence — even partial '
        'evidence is better than null. When visual signals are provided, use the '
        'top hex colors and font families directly (do not invent alternative '
        'colors). For cac/ltv/margin targets it is OK to give a benchmark '
        'estimate for the category if the site itself doesn\'t state numbers — '
        'mark these as targets, not actuals. Return ONLY valid JSON.'
    )

    try:
        from anthropic import Anthropic
        client = Anthropic(api_key=api_key, timeout=180.0)
        msg = client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=12000,
            messages=[{"role": "user", "content": prompt}],
        )
        parts = [getattr(b, "text", "") for b in msg.content if getattr(b, "text", None)]
        raw = "\n".join(parts).strip()
    except Exception as e:
        # Mirror Atelier's error envelope so the frontend can surface a
        # message instead of a 500-page.
        return {"error": f"Claude call failed: {e}"}

    # Strip code fences and pluck the outermost JSON object.
    cleaned = _re.sub(r"^```(?:json)?\s*|\s*```$", "", raw).strip()
    m = _re.search(r"\{[\s\S]*\}", cleaned)
    json_body = m.group(0) if m else cleaned
    # The prompt embeds /* … */ section dividers as a structural hint to
    # the model. Claude sometimes preserves them in the output, which
    # json.loads rejects. Strip block comments + trailing-comma noise
    # before parsing so we don't lose an otherwise-valid response.
    json_body = _re.sub(r"/\*[\s\S]*?\*/", "", json_body)
    json_body = _re.sub(r",\s*([}\]])", r"\1", json_body)
    try:
        deep = _json.loads(json_body)
    except _json.JSONDecodeError as e:
        return {"error": f"JSON parse failed: {e}", "raw": raw[:500]}

    # Normalize the domain (strip schema + trailing slash) and synthesize
    # the favicon URL Lens uses everywhere.
    domain = (deep.get("domain") or seed_domain or "").replace("https://", "").replace("http://", "").strip("/")
    if domain:
        deep["domain"] = domain
        deep["favicon"] = f"https://www.google.com/s2/favicons?domain={domain}&sz=64"

    # Merge: user's existing manual fields win for things the user
    # typed by hand (naming_convention, ad_name_convention, taxonomy,
    # uploaded_docs, etc). The AI-generated dossier fields below ALWAYS
    # overwrite when the model returned non-null evidence, because the
    # user explicitly asked to regenerate them.
    merged: dict = {**deep, **existing}
    AI_FIELDS = (
        # Identity
        "description", "tagline", "founded_year", "hq_location",
        "mission_statement", "logo_url", "favicon",
        # Positioning
        "category", "competitive_frame", "differentiator",
        "positioning_statement", "proof_points",
        # Pyramid
        "brand_essence", "brand_values", "personality_traits",
        "functional_benefits", "emotional_benefits",
        # Audience
        "primary_persona", "target_personas", "secondary_personas",
        "jobs_to_be_done", "objections",
        # Voice
        "voice_tone", "voice_attributes", "do_say", "dont_say",
        "example_snippets",
        # Visual
        "brand_colors", "color_primary", "color_secondary",
        "brand_fonts", "typography_display", "typography_body",
        "logo_dos", "logo_donts",
        # Products
        "hero_products", "categories", "products", "price_range",
        "merchandising_notes",
        # Social
        "social_links",
        # Performance benchmarks
        "cac_target", "ltv_target", "margin_target", "top_channels",
        # Compliance
        "claims_allowed", "claims_avoided", "trademarks",
        # Strategic context
        "competitors", "unique_value_props",
    )
    for k in AI_FIELDS:
        if k in deep and deep[k] is not None:
            merged[k] = deep[k]

    # Persist back to per-user store.
    user_profiles = all_profiles.setdefault(uid, {})
    user_profiles[brand] = merged
    # Also mirror naming_convention into global bucket (same as save_profile).
    nc = merged.get("naming_convention")
    if nc:
        glob = all_profiles.setdefault("__lens_global__", {})
        brand_glob = glob.setdefault(brand, {})
        brand_glob["naming_convention"] = nc
        brand_glob["ad_name_convention"] = nc
    _save_profiles(all_profiles)
    return merged


# ---------------------------------------------------------------------------
# Brand-profile (multi-section). generic per-(brand, section) JSON-blob
# storage backed by SQLite. Used by the AdAnalysisView dashboard to
# auto-save its widget list, layout, and velocity-threshold config so
# the user's customizations survive across devices and incognito
# windows. Falls back to localStorage on the frontend if a fetch fails.
# ---------------------------------------------------------------------------

@router.get("/api/brand-profiles/{brand}")
def get_brand_profile(brand: str) -> dict:
    return {"brand": brand, "sections": list_brand_sections(brand)}


@router.post("/api/brand-profiles/{brand}")
def save_brand_profile(brand: str, body: dict) -> dict:
    # Bulk save: body may be either {"sections": {section: data, ...}}
    # or a bare {section: data, ...} dict. We accept both forms so the
    # frontend can save several at once without an extra envelope.
    sections = body.get("sections") if isinstance(body, dict) and "sections" in body else body
    if not isinstance(sections, dict):
        sections = {}
    for section, data in sections.items():
        if isinstance(data, dict):
            save_brand_section(brand, section, data)
    return {"ok": True, "brand": brand, "sections_saved": list(sections.keys())}


@router.get("/api/brand-profiles/{brand}/section/{section}")
def get_brand_profile_section(brand: str, section: str) -> dict:
    data = get_brand_section(brand, section)
    return {"brand": brand, "section": section, "data": data or {}}


@router.post("/api/brand-profiles/{brand}/section/{section}")
async def save_brand_profile_section(brand: str, section: str, request: Request) -> dict:
    # Accept either a raw JSON dict or {"data": {...}} envelope so that
    # navigator.sendBeacon clients (which can only POST text/plain
    # blobs) and regular fetch clients both work without front-end
    # special cases.
    body_bytes = await request.body()
    try:
        body = json.loads(body_bytes.decode("utf-8") or "{}")
    except Exception:
        body = {}
    if isinstance(body, dict) and "data" in body and isinstance(body["data"], dict):
        data = body["data"]
    elif isinstance(body, dict):
        data = body
    else:
        data = {}
    save_brand_section(brand, section, data)
    return {"ok": True, "brand": brand, "section": section}


# ---------------------------------------------------------------------------
# Planner taxonomy + trends + planner status. Lens stubs.
# These endpoints exist in Atelier; the BrandSettingsView calls them but
# Lens doesn't ship the planner. We return empty payloads so the UI
# renders without errors.
# ---------------------------------------------------------------------------

@router.get("/api/planner/taxonomy")
def planner_taxonomy(brand: str = "") -> dict:
    return {"brand": brand, "taxonomy": {}, "lists": {}}


@router.post("/api/planner/taxonomy")
def save_planner_taxonomy(body: dict) -> dict:
    return {"ok": True}


@router.get("/api/planner/taxonomy/template")
def planner_taxonomy_template() -> dict:
    return {"template": {}}


@router.post("/api/planner/taxonomy/import")
def planner_taxonomy_import(body: dict) -> dict:
    return {"ok": True, "imported": 0}


@router.get("/api/planner/statuses-for-ads")
def planner_statuses_for_ads(brand: str = "", ad_ids: str = "") -> dict:
    return {"brand": brand, "statuses": {}}


@router.get("/api/planner/ucid-for-ad/{ad_id}")
def planner_ucid_for_ad(ad_id: str) -> dict:
    return {"ad_id": ad_id, "ucid": None}


@router.get("/api/planner/ucid-for-hash/{img_hash}")
def planner_ucid_for_hash(img_hash: str) -> dict:
    return {"img_hash": img_hash, "ucid": None}


@router.get("/api/trends/keywords")
def trends_keywords(brand: str = "") -> dict:
    return {"brand": brand, "keywords": []}


@router.post("/api/trends/keywords")
def save_trends_keywords(body: dict) -> dict:
    return {"ok": True}


# Boards, Reports, and Atria are all served by their own routers
# (boards_endpoints.py / ads_reports_endpoints.py / atria_endpoints.py),
# mounted ahead of this one in main.py. Nothing else to stub here.
