"""AI Ad Analysis + Asset Tracking. FastAPI router.

Exposes endpoints for fetching ad-level creatives from Meta, running
Claude vision analysis on them, and generating copy variants. Analyses
are cached on disk to `ad_analysis_cache.json` so repeated views don't
re-hit Claude.

Mount from `api_server.py` via:
    from ad_analysis_endpoints import router as ad_analysis_router
    app.include_router(ad_analysis_router)

Schema contract (FileAnalysis. mirrors bulk-ad-analyzer types.ts):
    Core Strategy:  angle, hook, concept, persona, brand
    Audience:       marketAwareness, demographics, marketSophistication
    Funnel/Offer:   funnelPosition, offer
    Copy:           headline, bodyCopy, cta, sentiment
    Visual:         style, template, productionQuality, layoutDescription,
                    textOverlay, colors, products, compositionAnalysis
    Technical:      format, aspectRatio, intendedPlacement
    Thematic:       emotion, marketingMoment, category, collection, tags
    Performance:    creativeClarityScore, creativeClarityFeedback,
                    visualDifferentiationScore/Summary,
                    messagingDifferentiationScore/Summary
    Focus Group:    focusGroupResults, focusGroupScore

Bump ANALYSIS_SCHEMA_VERSION when the extracted schema changes so stale
cache entries get re-analyzed on first call.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import FileResponse, Response

# Reuse META_ACCOUNTS from api_server. We import lazily inside functions
# to avoid circular imports at module load.

CACHE_FILE = os.path.join(os.path.dirname(__file__), "ad_analysis_cache.json")

# Serializes the load→modify→save sequence around CACHE_FILE so concurrent
# /analyze workers (kicked off by /analyze-if-missing's thread pool) don't
# clobber each other's writes. Reads outside the lock are still fine. a
# stale read at most causes a redundant analyze, never data loss.
_CACHE_LOCK = threading.RLock()

# Bump this when the FileAnalysis shape changes. old entries will be
# considered stale and re-analyzed on next view.
# v3. full FileAnalysis with visual/messaging differentiation scores,
# base64 image fetch (instead of URL) to skirt robots.txt blocks on the
# Meta scontent CDN.
# v4. cache is now keyed by `creative_hash` alone (not `ad_id::hash`).
# `_creative_hash` switched to SHA256(image_hash||video_id||name[:32]).
# Stale v3 entries are automatically re-keyed on module load; any that
# survive will still be re-analyzed on first access because the version
# check fails here.
# v5. local pre-extraction (rapidocr OCR + colorgram + Pillow stats) now
# runs before Haiku and the results are injected into the prompt as
# ground truth for textOverlay / textPlacements / colors / aspectRatio /
# productionQuality. Haiku no longer hallucinates these fields.
ANALYSIS_SCHEMA_VERSION = 5

# Max bytes we'll hand to Claude directly before resizing. 5MB matches
# Anthropic's per-image cap comfortably; in practice scontent CDN images
# are 100-800KB so resize is rare.
MAX_IMAGE_BYTES = 5 * 1024 * 1024
# Max pixel dimension when we do need to shrink. preserves enough detail
# for vision analysis without blowing the token budget.
MAX_IMAGE_DIMENSION = 1568

# Browser-like headers. Meta's scontent CDN serves .jpg fine to any UA,
# but some CDNs 403 on default python-requests/httpx UAs and we also want
# a Referer so Facebook doesn't treat this as hotlinking.
_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/121.0.0.0 Safari/537.36"
)

# Headers for image-byte fetches against scontent.fbcdn.net. The Origin /
# Referer pair pretends the request is coming from a Meta-hosted preview
# iframe. empirically this is what the CDN's signature policy accepts
# for the post-based dark-post creatives Kinn runs.
_BROWSER_HEADERS = {
    "User-Agent": _USER_AGENT,
    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://business.facebook.com",
    "Referer": "https://business.facebook.com/",
    "Sec-Fetch-Dest": "image",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "cross-site",
}

# Separate headers for HTML / iframe fetches against business.facebook.com
# itself. Setting Origin to business.facebook.com on a request *to*
# business.facebook.com triggers a 400 (Facebook treats it as a
# same-origin attack), so we omit Origin entirely and use document-style
# Sec-Fetch hints instead. Verified via end-to-end test 2026-05-04: the
# image-headers above produced 400, these produce 200.
_IFRAME_FETCH_HEADERS = {
    "User-Agent": _USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "iframe",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "cross-site",
}

# Haiku is the right tier for creative analysis. fast, cheap, batch-friendly.
HAIKU_MODEL = "claude-haiku-4-5"

# Module-level Anthropic client. Constructed lazily on first use so import
# order doesn't matter. Reusing one client across worker threads lets httpx
# multiplex requests over a single keep-alive HTTP/2 connection. far more
# stable under concurrency than 12 threads each doing their own TLS
# handshake. The SDK is documented as thread-safe.
_anthropic_client_lock = threading.Lock()
_anthropic_client: Any = None

# Module-level thread pool for in-call fan-out (text-only Haiku running in
# parallel with the vision call inside a single analyze_creative). Sized
# generously. workers are short-lived and idle most of the time. Living
# alongside the per-batch ThreadPoolExecutor in /analyze-if-missing means
# the worst case is `max_concurrent_batch * 2` Haiku calls in flight,
# which still fits comfortably under Anthropic's per-key rate limits.
_ANALYZE_POOL = ThreadPoolExecutor(max_workers=24, thread_name_prefix="analyze-fanout")


def _resolve_anthropic_key() -> Optional[str]:
    """Find the Anthropic API key.

    Order of precedence:
      1. ``ANTHROPIC_API_KEY`` env var (matches Atelier + dev shells).
      2. Encrypted ``anthropic`` row in Lens's integrations store
         (where the Settings UI saves it).

    Returns the key string or None if nothing is set. The Anthropic SDK
    raises a verbose "Could not resolve authentication method" error if
    we construct ``Anthropic()`` without a key. we'd rather raise a
    clear 503 from the caller side. The env-proxy interception in
    ``lens_context.py`` isn't enough by itself because the SDK reads
    the key once at construction time, before the request context
    middleware has run.
    """
    key = os.environ.get("ANTHROPIC_API_KEY")
    if key:
        return key
    try:
        from store import get_integration_key
        stored = get_integration_key("anthropic")
        if stored:
            return stored
    except Exception:
        pass
    return None


def _invalidate_anthropic_client(provider: str, _key: Optional[str]) -> None:
    """Drop the cached Anthropic client when the `anthropic` key
    changes in Settings. Without this the process keeps using the old
    key (or fails) until the API is restarted — confusing UX."""
    global _anthropic_client
    if provider != "anthropic":
        return
    with _anthropic_client_lock:
        _anthropic_client = None


# Wire the hook once at import time. The store fires it on every
# save_integration_key / delete_integration_key.
try:
    from store import register_integration_key_hook
    register_integration_key_hook(_invalidate_anthropic_client)
except Exception:
    pass


def _get_anthropic_client() -> Any:
    """Lazy singleton Anthropic client.

    Re-resolves the API key every time the cached client is None (i.e.
    after a process restart, or if a previous instantiation failed) so
    the user can paste their key in Settings without restarting the
    API. Once a working client is cached, subsequent calls reuse it
    across worker threads (the SDK is documented thread-safe).
    """
    global _anthropic_client
    if _anthropic_client is not None:
        return _anthropic_client
    with _anthropic_client_lock:
        if _anthropic_client is None:
            from anthropic import Anthropic
            key = _resolve_anthropic_key()
            if not key:
                # Bail with a clear message. better than the SDK's
                # cryptic "Expected one of api_key/auth_token/credentials".
                # Caller's try/except will surface this to the UI as a
                # "Claude analysis failed: …" line.
                raise RuntimeError(
                    "No Anthropic API key configured. "
                    "Add one in Settings → Anthropic (it should start with sk-ant-)."
                )
            # 180s per-call timeout: vision Haiku can take 20-60s under
            # parallel load, well under the SDK default but explicit so a
            # stalled call fails fast and the worker retries the next ad.
            _anthropic_client = Anthropic(api_key=key, timeout=180.0, max_retries=2)
    return _anthropic_client

# Simple in-memory cache for the creative listing. Creative content is
# effectively immutable per `creative_hash` (our key derivation already
# includes image_hash / video_id), so a 15-minute TTL was burning Meta
# app-level quota on `gr:get:/<video_id>` refetches for no real staleness
# benefit. Bumped to 24 h. the /refresh and /refresh-urls endpoints and
# the nightly prewarmer handle any cases where we actually need fresh data.
_creative_cache: dict[str, tuple[float, Any]] = {}
CREATIVE_CACHE_TTL = 86400  # 24h (was 900s. rate-limit mitigation 2026-04-23)

# Video metadata (source/picture/permalink/embed/thumbnails) is fetched
# per creative-miss inside `_fetch_ad_creative`. It lives behind its own
# disk-backed cache keyed by `video_id` so sibling ads and cross-brand
# reuses don't re-hit `gr:get:/<video_id>`. Thumbnails and permalinks are
# effectively immutable; `source` URLs carry a rotating signature but are
# cheap to refetch on demand when playback actually fails.
_VIDEO_CACHE_TTL = 7 * 86400  # 7 days
VIDEO_META_CACHE_FILE = os.path.join(
    os.path.dirname(__file__), "video_meta_cache.json"
)

# Separate cache bucket for per-ad daily timeseries (same TTL). Keyed by
# (brand, sorted ad_ids, start, end) so a page re-render with the same
# selection is free.
_timeseries_cache: dict[str, tuple[float, Any]] = {}
TIMESERIES_CACHE_TTL = 900

# Comments cache. comments update slowly but fresh-ish is nice. 10 min TTL
# keyed by (brand, ad_id).
_comments_cache: dict[str, tuple[float, Any]] = {}
COMMENTS_CACHE_TTL = 600

# ---------------------------------------------------------------------------
# Comment sentiment / emotion analysis
# ---------------------------------------------------------------------------
#
# Libraries are library-only (no LLM): VADER for compound sentiment score
# and NRCLex for 8-emotion NRC Word-Emotion Association Lexicon frequencies.
# Both import lazily and the module degrades gracefully. if either import
# fails we skip the `summary` block entirely instead of 500'ing the comments
# endpoint. A small disk cache keyed by comment_id avoids re-scoring known
# comments on pagination / refresh / cross-endpoint rollup calls.
COMMENTS_ANALYSIS_FILE = os.path.join(
    os.path.dirname(__file__), "comments_analysis.json"
)

# Per-creative VADER score store. Keyed by creative_hash (or ad_id when hash
# is missing). the same creative_hash ⇒ same body+title text ⇒ same score,
# so we compute once and reuse across every dashboard request for any brand.
# Shape: {key: {"score": float, "label": str|None, "brand": str, "ts": iso}}
CREATIVE_SENTIMENT_FILE = os.path.join(
    os.path.dirname(__file__), "creative_sentiment_cache.json"
)
_creative_sentiment_cache: Optional[dict] = None
_creative_sentiment_dirty: bool = False

# VADER's compound score is in [-1, 1]. These thresholds follow the VADER
# paper's recommended cutoffs for social-media-length text (Hutto & Gilbert
# 2014): >=0.05 positive, <=-0.05 negative. We widen to +/-0.1 so mildly
# positive / negative comments land in "neutral". ad comments tend to skew
# superlative ("love this!" / "worst product ever") so a stricter cutoff
# better highlights the genuine signal.
SENTIMENT_POS_THRESHOLD = 0.1
SENTIMENT_NEG_THRESHOLD = -0.1

# NRC core emotions. 8 Plutchik emotions. NRCLex also tracks `positive` /
# `negative` polarity buckets but we surface those via VADER instead. The
# ordering here is stable so rollups produce deterministic JSON.
EMOTION_KEYS = (
    "anger", "anticipation", "disgust", "fear",
    "joy", "sadness", "surprise", "trust",
)

# In-process sentiment scorer cache. survives across requests, keyed by
# comment_id so pagination doesn't re-score. Shape mirrors the persisted
# per-comment entry for easy passthrough.
_comment_score_cache: dict[str, dict] = {}

# Lazily initialized RoBERTa sentiment + emotion models. They handle
# sarcasm, emoji context, and implicit negatives. the things VADER can't.
# ~500MB on disk per model, ~5s cold-load to RAM, then ~30-50ms per comment.
_sentiment_model: Any = None  # cardiffnlp/twitter-roberta-base-sentiment-latest
_sentiment_tokenizer: Any = None
_emotion_model: Any = None    # j-hartmann/emotion-english-distilroberta-base
_emotion_tokenizer: Any = None
_sentiment_libs_loaded: Optional[bool] = None

# Bumped whenever the scoring engine changes. entries with an older
# `model_version` get re-scored on next read so cached VADER junk doesn't
# linger forever. v1 = VADER+NRC, v2 = RoBERTa.
SENTIMENT_MODEL_VERSION = 2


def _load_sentiment_libs() -> bool:
    """Lazy-load the HuggingFace sentiment + emotion models. Returns True
    iff both load successfully. Caches across calls so failures are cheap.

    Graceful degradation: any ImportError / model-load failure leaves
    `_sentiment_libs_loaded=False` and the caller skips analysis.
    """
    global _sentiment_model, _sentiment_tokenizer, _emotion_model, _emotion_tokenizer, _sentiment_libs_loaded
    if _sentiment_libs_loaded is not None:
        return _sentiment_libs_loaded
    try:
        from transformers import AutoTokenizer, AutoModelForSequenceClassification
        sm = "cardiffnlp/twitter-roberta-base-sentiment-latest"
        em = "j-hartmann/emotion-english-distilroberta-base"
        _sentiment_tokenizer = AutoTokenizer.from_pretrained(sm)
        _sentiment_model = AutoModelForSequenceClassification.from_pretrained(sm)
        _emotion_tokenizer = AutoTokenizer.from_pretrained(em)
        _emotion_model = AutoModelForSequenceClassification.from_pretrained(em)
        _sentiment_model.eval()
        _emotion_model.eval()
        _sentiment_libs_loaded = True
        print("[comments-sentiment] RoBERTa sentiment + emotion models loaded", flush=True)
    except Exception as e:
        print(f"[comments-sentiment] libs unavailable: {e}", flush=True)
        _sentiment_libs_loaded = False
    return _sentiment_libs_loaded


def _load_comments_analysis() -> dict:
    """Disk-backed store of {ad_id: {brand, analyzed_at, comment_scores: {...}}}.

    Kept separate from `ad_analysis_cache.json` because comment scoring
    has a completely different lifecycle (updated whenever new comments
    arrive, not whenever the creative changes).
    """
    try:
        with open(COMMENTS_ANALYSIS_FILE) as f:
            data = json.load(f)
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def _save_comments_analysis(data: dict) -> None:
    try:
        tmp = COMMENTS_ANALYSIS_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, COMMENTS_ANALYSIS_FILE)
    except Exception as e:
        print(f"[comments-sentiment] failed to persist: {e}", flush=True)


def _load_creative_sentiment() -> dict:
    """Disk-backed creative-sentiment store. Loaded once per process."""
    global _creative_sentiment_cache
    if _creative_sentiment_cache is not None:
        return _creative_sentiment_cache
    try:
        with open(CREATIVE_SENTIMENT_FILE) as f:
            data = json.load(f)
            if isinstance(data, dict):
                _creative_sentiment_cache = data
                return data
    except Exception:
        pass
    _creative_sentiment_cache = {}
    return _creative_sentiment_cache


def _save_creative_sentiment() -> None:
    """Flush the in-memory cache to disk if it has new entries."""
    global _creative_sentiment_dirty
    if not _creative_sentiment_dirty or _creative_sentiment_cache is None:
        return
    try:
        tmp = CREATIVE_SENTIMENT_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(_creative_sentiment_cache, f)
        os.replace(tmp, CREATIVE_SENTIMENT_FILE)
        _creative_sentiment_dirty = False
    except Exception as e:
        print(f"[creative-sentiment] failed to persist: {e}", flush=True)


_EMOJI_SUBSTITUTIONS = {
    # Positive. VADER's default lexicon misses these so an ad caption
    # full of "🔥🔥🔥" was scoring 0 (or worse, drifting negative when
    # paired with edge words like "obsessed"). Substitute the emoji with
    # an unambiguously-scored synonym.
    "🔥": " awesome ",
    "❤": " love ",
    "❤️": " love ",
    "💖": " love ",
    "💕": " love ",
    "🚀": " amazing ",
    "💯": " perfect ",
    "🎉": " celebrate ",
    "✨": " wonderful ",
    "👏": " applaud ",
    "💪": " strong ",
    "😍": " love ",
    "🤩": " amazing ",
    "🥰": " love ",
    "😊": " happy ",
    "😂": " hilarious ",
    "👍": " great ",
    "✅": " good ",
    "⭐": " excellent ",
    "🌟": " excellent ",
    "💎": " premium ",
    # Negative
    "👎": " bad ",
    "😢": " sad ",
    "😭": " sad ",
    "😡": " angry ",
    "🤬": " angry ",
    "💩": " awful ",
    "😞": " disappointed ",
    "❌": " bad ",
}


def _preprocess_for_vader(text: str) -> str:
    """Translate common ad-copy emojis into VADER-scored tokens. The default
    VADER lexicon ships with limited emoji coverage and misses 🔥/💯/🚀 -
    the emoji that dominate paid social copy. Substitute before scoring."""
    if not text:
        return text
    for emo, repl in _EMOJI_SUBSTITUTIONS.items():
        if emo in text:
            text = text.replace(emo, repl)
    return text


def _vader_score_text(text: str) -> Optional[float]:
    """Return a compound sentiment score in [-1, 1] for a string, or None
    if libs aren't loaded / text is empty.

    Name is historical. the engine was migrated from VADER to RoBERTa
    (SENTIMENT_MODEL_VERSION=2). We delegate to `_score_comment_text` so
    creative-level scoring uses the same model as comment scoring instead
    of a stale `_vader_analyzer` reference that no longer exists.
    """
    if not text or not text.strip():
        return None
    scored = _score_comment_text(text)
    if not scored:
        return None
    compound = scored.get("compound")
    if compound is None:
        return None
    try:
        return round(float(compound), 3)
    except Exception:
        return None


_vader_analyzer: Any = None  # lazy lightweight fallback when RoBERTa unavailable


def _vader_score(text: str) -> Optional[dict]:
    """Lightweight VADER fallback for when transformers+torch aren't in
    the venv. VADER ships in ~125KB, no heavy ML deps, and gives a
    decent compound score in the same [-1, +1] band RoBERTa returns -
    so downstream thresholds + rollups don't have to branch.

    Emotion fields all return 0 (VADER has no emotion taxonomy); the
    frontend filters zero-only emotion blocks so the missing emotions
    just disappear from the UI rather than appearing as flat bars.
    """
    global _vader_analyzer
    try:
        if _vader_analyzer is None:
            from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
            _vader_analyzer = SentimentIntensityAnalyzer()
        scores = _vader_analyzer.polarity_scores(text)
        compound = float(scores.get("compound", 0.0))
    except Exception as e:
        print(f"[comments-sentiment] vader scoring failed: {e}", flush=True)
        return None
    if compound >= SENTIMENT_POS_THRESHOLD:
        label = "positive"
    elif compound <= SENTIMENT_NEG_THRESHOLD:
        label = "negative"
    else:
        label = "neutral"
    return {
        "compound": round(compound, 4),
        "sentiment": label,
        "emotions": {k: 0.0 for k in EMOTION_KEYS},
        "model_version": SENTIMENT_MODEL_VERSION,
    }


def _score_comment_text(text: str) -> Optional[dict]:
    """Return `{compound, sentiment, emotions}` for a single comment string.

    Returns None if the text is empty after trimming. Prefers RoBERTa
    (cardiffnlp/twitter-roberta) when transformers+torch are installed;
    otherwise falls back to VADER so sentiment still populates on
    fresh installs that don't carry the ~1GB of ML deps.
    """
    if not text or not text.strip():
        return None
    if not _load_sentiment_libs():
        # Lightweight VADER fallback. keeps sentiment populating even
        # without transformers/torch in the venv.
        return _vader_score(text)
    try:
        import torch

        # Sentiment via cardiffnlp/twitter-roberta. handles sarcasm + emojis.
        s_inputs = _sentiment_tokenizer(text, return_tensors="pt", truncation=True, max_length=256)
        with torch.no_grad():
            s_out = _sentiment_model(**s_inputs)
        s_probs = torch.softmax(s_out.logits, dim=-1)[0].tolist()
        # Model labels: 0=negative, 1=neutral, 2=positive
        neg, neu, pos = s_probs[0], s_probs[1], s_probs[2]
        # Compound score on VADER's [-1, +1] scale = pos − neg, so existing
        # thresholds and downstream rollups continue to work.
        compound = float(pos - neg)
        if compound >= SENTIMENT_POS_THRESHOLD:
            label = "positive"
        elif compound <= SENTIMENT_NEG_THRESHOLD:
            label = "negative"
        else:
            label = "neutral"

        # Emotion via DistilRoBERTa. labels: anger/disgust/fear/joy/neutral/
        # sadness/surprise. NRC's `anticipation` and `trust` aren't in this
        # taxonomy, so we surface zeros for them to keep the JSON shape
        # backward-compatible (frontend filters zero-emotion entries out).
        e_inputs = _emotion_tokenizer(text, return_tensors="pt", truncation=True, max_length=256)
        with torch.no_grad():
            e_out = _emotion_model(**e_inputs)
        e_probs = torch.softmax(e_out.logits, dim=-1)[0].tolist()
        labels = _emotion_model.config.id2label  # {0: 'anger', ...}
        by_label = {labels[i].lower(): float(p) for i, p in enumerate(e_probs)}
        emotions = {k: by_label.get(k, 0.0) for k in EMOTION_KEYS}

        return {
            "compound": round(compound, 4),
            "sentiment": label,
            "emotions": {k: round(v, 4) for k, v in emotions.items()},
            "model_version": SENTIMENT_MODEL_VERSION,
        }
    except Exception as e:
        # Don't blow up the comments endpoint over a single bad string.
        print(f"[comments-sentiment] scoring failed: {e}", flush=True)
        return None


def _analyze_comments(
    comments: list[dict],
    brand: str,
    ad_id: str,
) -> tuple[list[dict], Optional[dict]]:
    """Attach `sentiment` + `emotions` to each comment in-place (returning
    a new list for clarity) and build the top-level summary block.

    Reuses cached scores per comment_id. both from the in-process cache
    AND the on-disk store. so pagination / refresh / rollup calls don't
    re-run VADER on comments we've already seen.

    Returns ``(enriched_comments, summary_or_none)``. Summary is None if
    the sentiment libs aren't available (graceful degradation path).
    """
    # NB: we used to early-return here when transformers/torch weren't
    # installed. That blocked the VADER fallback at the per-comment
    # scoring layer. sentiment never populated even though VADER
    # was available. Now we always proceed and let `_score_comment_text`
    # pick the best available scorer (RoBERTa > VADER > None).
    disk_store = _load_comments_analysis()
    ad_bucket = disk_store.get(ad_id) or {}
    existing_scores = ad_bucket.get("comment_scores") or {}
    new_scores: dict[str, dict] = {}

    enriched: list[dict] = []
    for c in comments:
        cid = str(c.get("id") or "")
        msg = c.get("message") or ""

        # 1) in-process cache
        cached = _comment_score_cache.get(cid)
        # 2) disk cache
        if cached is None and cid and cid in existing_scores:
            cached = existing_scores[cid]
            _comment_score_cache[cid] = cached
        # 2.5) invalidate stale model versions. drops VADER (v1) results so
        # the new RoBERTa scorer re-runs on next read.
        if cached is not None and cached.get("model_version", 1) < SENTIMENT_MODEL_VERSION:
            cached = None
        # 3) score from scratch
        if cached is None:
            cached = _score_comment_text(msg)
            if cached and cid:
                _comment_score_cache[cid] = cached
                new_scores[cid] = cached

        enriched_c = dict(c)
        if cached:
            enriched_c["sentiment"] = {
                "label": cached["sentiment"],
                "score": cached["compound"],
            }
            enriched_c["emotions"] = cached["emotions"]
        enriched.append(enriched_c)

    # Persist any newly-scored comments back to disk so the next call
    # reuses them. Keep existing entries untouched. comments are
    # append-only from our perspective (deletes on FB/IG side just means
    # a stale row survives, which is fine for summary stats).
    if new_scores:
        merged = dict(existing_scores)
        merged.update(new_scores)
        disk_store[ad_id] = {
            "brand": brand,
            "analyzed_at": int(time.time()),
            "comment_scores": merged,
        }
        _save_comments_analysis(disk_store)

    # Build the summary block. Only count comments that actually got a
    # score (empty-message rows were skipped).
    scored = [c for c in enriched if "sentiment" in c]
    count = len(scored)
    if count == 0:
        return enriched, {
            "count": 0,
            "sentiment": {"positive_pct": 0, "neutral_pct": 0, "negative_pct": 0, "avg_compound": 0.0},
            "emotions": {k: 0.0 for k in EMOTION_KEYS},
            "top_emotion": None,
            "top_quotes": {"positive": None, "negative": None},
        }

    pos = sum(1 for c in scored if c["sentiment"]["label"] == "positive")
    neg = sum(1 for c in scored if c["sentiment"]["label"] == "negative")
    neu = count - pos - neg
    avg_compound = sum(c["sentiment"]["score"] for c in scored) / count

    # Average emotion across all scored comments. NRCLex returns a freq
    # already normalized to [0, 1] within a single comment, so a straight
    # mean gives us the brand-level distribution.
    emotion_sums = {k: 0.0 for k in EMOTION_KEYS}
    for c in scored:
        for k in EMOTION_KEYS:
            emotion_sums[k] += float(c.get("emotions", {}).get(k, 0.0))
    emotion_avgs = {k: round(emotion_sums[k] / count, 4) for k in EMOTION_KEYS}
    top_emotion = max(emotion_avgs.items(), key=lambda kv: kv[1])[0]
    if emotion_avgs[top_emotion] == 0:
        top_emotion = None

    # Top positive + top negative quotes. highest/lowest compound with
    # non-empty text. Useful for the UI blockquote pair.
    pos_quote = None
    neg_quote = None
    pos_sorted = sorted(scored, key=lambda c: c["sentiment"]["score"], reverse=True)
    neg_sorted = sorted(scored, key=lambda c: c["sentiment"]["score"])
    if pos_sorted and pos_sorted[0]["sentiment"]["score"] >= SENTIMENT_POS_THRESHOLD:
        pos_quote = pos_sorted[0].get("message") or None
    if neg_sorted and neg_sorted[0]["sentiment"]["score"] <= SENTIMENT_NEG_THRESHOLD:
        neg_quote = neg_sorted[0].get("message") or None

    summary = {
        "count": count,
        "sentiment": {
            "positive_pct": round(100.0 * pos / count, 1),
            "neutral_pct": round(100.0 * neu / count, 1),
            "negative_pct": round(100.0 * neg / count, 1),
            "avg_compound": round(avg_compound, 4),
        },
        "emotions": emotion_avgs,
        "top_emotion": top_emotion,
        "top_quotes": {"positive": pos_quote, "negative": neg_quote},
    }
    return enriched, summary

# Disk-backed creatives cache. survives process restarts and shields the
# user from the 10-30s Meta Graph warmup whenever the in-memory cache is
# cold (first request after server boot, or after the 15 min TTL expires).
# We deliberately keep the disk TTL much longer than memory: if the data
# is up to 2h old we still prefer it to making the user wait.
CREATIVES_DISK_CACHE_FILE = os.path.join(
    os.path.dirname(__file__), "creatives_cache.json"
)
# 6 hours. creative inventory + spend rarely shifts hour-over-hour and the
# user-visible cost of waiting for a Meta refetch is worse than slightly-
# stale numbers. The background prewarmer + force-refresh button cover the
# case where someone genuinely needs the latest data.
CREATIVES_DISK_CACHE_TTL = 6 * 60 * 60  # 6 hours

# On-disk image proxy cache. We hash the upstream URL and write the raw
# bytes to ``image_cache/<hash>.<ext>`` so repeat hits skip the Meta CDN
# (which is both slow and subject to expiring signatures). Cache keys are
# stable across restarts. the filename is the SHA256 of the full URL.
IMAGE_CACHE_DIR = os.path.join(os.path.dirname(__file__), "image_cache")
try:
    os.makedirs(IMAGE_CACHE_DIR, exist_ok=True)
except Exception as _cache_dir_err:  # noqa: BLE001. don't block boot on FS issues
    print(f"[ad-analysis] could not init image cache dir: {_cache_dir_err}", flush=True)

# API version. matches api_server.py pattern
META_API_VERSION = "v25.0"


router = APIRouter(prefix="/api/ads", tags=["ad-analysis"])


# ---------------------------------------------------------------------------
# Cache helpers
# ---------------------------------------------------------------------------


def _load_analysis_cache() -> dict:
    try:
        with open(CACHE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def _save_analysis_cache(data: dict) -> None:
    # Atomic write. drop to a tempfile then rename so a crash mid-write
    # can't leave behind a truncated JSON file (which would wipe every
    # cached analysis the next time we read).
    try:
        tmp = CACHE_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, CACHE_FILE)
    except Exception as e:
        # Don't crash the request if disk write fails
        print(f"[ad-analysis] failed to persist cache: {e}")


# --- Creatives listing: disk cache -----------------------------------------
#
# Keyed by ``{brand}::{start}::{end}::{limit}``. Stored value is
# ``{"ts": epoch, "payload": <list_creatives response>}``. TTL checked at
# read time. expired entries are ignored but not purged (the prewarmer
# overwrites them soon enough).

def _load_creatives_disk_cache() -> dict:
    try:
        with open(CREATIVES_DISK_CACHE_FILE) as f:
            data = json.load(f)
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def _save_creatives_disk_cache(data: dict) -> None:
    try:
        tmp = CREATIVES_DISK_CACHE_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, CREATIVES_DISK_CACHE_FILE)
    except Exception as e:
        print(f"[prewarm] failed to persist creatives cache: {e}", flush=True)


# --- Video metadata cache ---------------------------------------------------
#
# Disk-backed, keyed by `video_id`. Stored value shape:
#     {"ts": epoch, "payload": {source, picture, permalink_url,
#                               embed_html, thumbnails}}
# TTL checked at read time; expired entries ignored.
_video_meta_cache_mem: dict[str, tuple[float, dict]] = {}


def _load_video_meta_disk_cache() -> dict:
    try:
        with open(VIDEO_META_CACHE_FILE) as f:
            data = json.load(f)
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def _save_video_meta_disk_cache(data: dict) -> None:
    # Atomic write. mirrors `_save_creatives_disk_cache` pattern so a
    # crash mid-write can't corrupt the cache.
    try:
        tmp = VIDEO_META_CACHE_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, VIDEO_META_CACHE_FILE)
    except Exception as e:
        print(f"[ad-analysis] failed to persist video meta cache: {e}", flush=True)


def _get_video_metadata(video_id: str, token: str, force: bool = False) -> dict:
    """Fetch + cache Meta video metadata.

    Returns the raw Meta response dict
    ``{source, picture, permalink_url, embed_html, thumbnails}`` or an
    empty dict on error. Checks memory → disk → network, honoring a
    7-day TTL. Respects the global rate-limit pause and raises
    :class:`RateLimitedError` when the app is in cooldown.

    The ``source`` URL in the payload is a Meta CDN link that expires in
    a few hours even though the metadata itself is stable. when the
    caller knows the playback URL is dead (e.g. force-refresh button),
    it passes ``force=True`` to skip the cache and re-sign.
    """
    if not video_id:
        return {}

    if not force:
        # Memory tier
        hit = _video_meta_cache_mem.get(video_id)
        if hit:
            ts, payload = hit
            if (time.time() - ts) <= _VIDEO_CACHE_TTL:
                return payload

        # Disk tier
        disk = _load_video_meta_disk_cache()
        entry = disk.get(video_id)
        if isinstance(entry, dict):
            ts = float(entry.get("ts") or 0)
            if (time.time() - ts) <= _VIDEO_CACHE_TTL:
                payload = entry.get("payload") or {}
                _video_meta_cache_mem[video_id] = (ts, payload)
                return payload
    else:
        # Force path. evict any stale entry upfront so a concurrent
        # caller doesn't race us to the memory tier check above.
        _video_meta_cache_mem.pop(video_id, None)
        try:
            disk = _load_video_meta_disk_cache()
            if video_id in disk:
                disk.pop(video_id, None)
                _save_video_meta_disk_cache(disk)
        except Exception:
            pass

    disk = _load_video_meta_disk_cache()

    # Network tier. will raise RateLimitedError if the app is paused.
    _check_rate_limit_pause()
    import requests as req  # lazy, matches existing pattern

    try:
        vr = req.get(
            f"https://graph.facebook.com/{META_API_VERSION}/{video_id}",
            params={
                "access_token": token,
                "fields": (
                    "source,picture,permalink_url,embed_html,length,"
                    "thumbnails{uri,height,width,is_preferred}"
                ),
            },
            timeout=30,
        )
    except Exception as e:
        print(f"[ad-analysis] video fetch failed for {video_id}: {e}", flush=True)
        return {}

    # Watch rate-limit headers on every Meta response.
    try:
        _observe_meta_usage_headers(getattr(vr, "headers", {}) or {})
    except Exception:
        pass

    try:
        vd = vr.json()
    except Exception:
        return {}
    if not isinstance(vd, dict) or vd.get("error"):
        if isinstance(vd, dict):
            _note_meta_rate_limit(vd.get("error") or {})
        return {}

    payload = {
        "source": vd.get("source"),
        "picture": vd.get("picture"),
        "permalink_url": vd.get("permalink_url"),
        "embed_html": vd.get("embed_html"),
        "thumbnails": vd.get("thumbnails"),
        # Meta `length` is seconds (float). Cached per-video alongside the
        # rest so the bulk /video-lengths endpoint can answer from disk
        # for any creative whose detail panel has already been opened.
        "length": float(vd["length"]) if vd.get("length") is not None else None,
    }

    # Reels fallback: Meta's Graph API refuses to populate `source` (and
    # increasingly `permalink_url` too) for reels/restricted videos. When
    # permalink is missing we synthesize one from the video_id and try
    # both the /reel/ and /watch/ shapes. Meta redirects the wrong one
    # to the right one. m.facebook.com then serves the mp4 URL inline.
    #
    # Once we have a working mp4 URL we ALSO download it to a local
    # cache and replace `source` with our own `/api/ads/video/<id>.mp4`
    # path. Meta's scontent mp4 URLs expire in hours (Atria-style rehost
    # gets around this permanently. same trick their cdn.tryatria.com
    # uses).
    if not payload.get("source"):
        local_path = _video_file_cache_lookup(video_id)
        if local_path:
            payload["source"] = f"/api/ads/video/{video_id}.mp4"
        else:
            candidate_urls: list[str] = []
            if payload.get("permalink_url"):
                candidate_urls.append(payload["permalink_url"])
            candidate_urls.extend([
                f"https://www.facebook.com/reel/{video_id}/",
                f"https://www.facebook.com/watch/?v={video_id}",
            ])
            for url in candidate_urls:
                scraped = _scrape_reel_playback_url(url)
                if scraped:
                    # Try to download + rehost. If that fails (rare -
                    # e.g. CDN flaky mid-download), fall back to serving
                    # the scraped URL directly. playback works, just
                    # for a few hours until the URL expires.
                    if _download_video_to_cache(scraped, video_id):
                        payload["source"] = f"/api/ads/video/{video_id}.mp4"
                    else:
                        payload["source"] = scraped
                    if not payload.get("permalink_url"):
                        payload["permalink_url"] = url
                    break

    now = time.time()
    _video_meta_cache_mem[video_id] = (now, payload)
    disk[video_id] = {"ts": now, "payload": payload}
    _save_video_meta_disk_cache(disk)
    return payload


VIDEO_FILE_CACHE_DIR = os.path.join(os.path.dirname(__file__), "video_cache")


def _video_file_cache_lookup(video_id: str) -> Optional[str]:
    """Return the absolute path to a cached mp4 if it exists, else None."""
    if not video_id:
        return None
    p = os.path.join(VIDEO_FILE_CACHE_DIR, f"{video_id}.mp4")
    if os.path.exists(p) and os.path.getsize(p) > 0:
        return p
    return None


def _download_video_to_cache(url: str, video_id: str) -> bool:
    """Stream the Meta CDN mp4 to a local file so we can serve it back
    without expiration (Atria-style rehost).

    Returns True on success, False on any failure (caller can fall back
    to serving the live CDN URL directly. works briefly until it
    expires). Downloads in 256 KB chunks to a .tmp file then atomically
    renames, so partial files can't poison the cache.
    """
    if not url or not video_id:
        return False
    try:
        os.makedirs(VIDEO_FILE_CACHE_DIR, exist_ok=True)
        final = os.path.join(VIDEO_FILE_CACHE_DIR, f"{video_id}.mp4")
        tmp = final + ".tmp"
        import requests as req
        with req.get(url, stream=True, timeout=45, headers={
            "User-Agent": (
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) "
                "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
            ),
            "Referer": "https://m.facebook.com/",
        }) as r:
            if r.status_code != 200:
                return False
            total = 0
            with open(tmp, "wb") as fh:
                for chunk in r.iter_content(chunk_size=262_144):
                    if not chunk:
                        continue
                    fh.write(chunk)
                    total += len(chunk)
                    # Cap at 200 MB so a hostile stream can't fill disk.
                    if total > 200 * 1024 * 1024:
                        break
            if total <= 0:
                try: os.remove(tmp)
                except Exception: pass
                return False
        os.replace(tmp, final)
        return True
    except Exception as e:
        print(f"[ad-analysis] video download failed for {video_id}: {e}", flush=True)
        try: os.remove(os.path.join(VIDEO_FILE_CACHE_DIR, f"{video_id}.mp4.tmp"))
        except Exception: pass
        return False


@router.get("/video-lengths")
def video_lengths(
    video_ids: str = "",
    pairs: str = "",
    brand: str = "",
    fetch: bool = True,
    max_fetch: int = 50,
):
    """Return ``{video_id: length_seconds}`` for a comma-separated list.

    Four-tier lookup per video_id:
      1. memory cache (per-video_id, populated this process)
      2. disk cache  (per-video_id, 7-day TTL)
      3. Meta `/{video_id}?fields=length`. direct video metadata
      4. Insights `video_play_curve_actions` for the corresponding ad -
         derives length from the curve array (one entry per second).
         This is the lifeline for videos where the Meta app token can
         read insights but is blocked on direct video metadata
         (`(#10) Application does not have permission for this action`,
         common for many ad accounts).

    Inputs:
      - ``video_ids``. comma-separated, used for tiers 1-3 (legacy shape).
      - ``pairs``   . ``video_id:ad_id,video_id:ad_id,...``. required for
                       tier 4 since the insights call needs ad.id. When
                       both are present, ``pairs`` takes precedence and
                       expands video_ids implicitly.
      - ``brand``   . required for tier 4 only, to look up account_id.
    """
    pair_list: list[tuple[str, str]] = []
    if pairs:
        for chunk in pairs.split(","):
            chunk = chunk.strip()
            if not chunk or ":" not in chunk:
                continue
            vid, aid = chunk.split(":", 1)
            vid = vid.strip(); aid = aid.strip()
            if vid:
                pair_list.append((vid, aid))
    if not pair_list:
        pair_list = [(v.strip(), "") for v in (video_ids or "").split(",") if v.strip()]
    if not pair_list:
        return {"lengths": {}}

    disk = _load_video_meta_disk_cache()
    out: dict[str, float] = {}
    missing: list[tuple[str, str]] = []  # (video_id, ad_id) pairs we still need

    for vid, aid in pair_list:
        mem = _video_meta_cache_mem.get(vid)
        if mem:
            _ts, payload = mem
            length = (payload or {}).get("length")
            if isinstance(length, (int, float)):
                out[vid] = float(length)
                continue
        entry = disk.get(vid)
        if isinstance(entry, dict):
            payload = entry.get("payload") or {}
            length = payload.get("length")
            if isinstance(length, (int, float)):
                out[vid] = float(length)
                continue
        missing.append((vid, aid))

    if not fetch or not missing:
        return {"lengths": out}

    token = os.environ.get("META_ACCESS_TOKEN")
    if not token:
        return {"lengths": out}

    # --- Tier 3: direct video metadata ---
    still_missing: list[tuple[str, str]] = []
    for vid, aid in missing[:max_fetch]:
        try:
            payload = _get_video_metadata(vid, token, force=True)
        except RateLimitedError:
            return {"lengths": out}
        except Exception:
            still_missing.append((vid, aid))
            continue
        length = (payload or {}).get("length")
        if isinstance(length, (int, float)):
            out[vid] = float(length)
        elif aid:
            still_missing.append((vid, aid))

    # --- Tier 4: insights video_play_curve_actions fallback ---
    if still_missing and brand:
        accounts = _get_meta_accounts()
        account_id = accounts.get(brand)
        if account_id:
            for vid, aid in still_missing:
                params = {
                    "access_token": token,
                    "level": "ad",
                    "filtering": json.dumps([{"field": "ad.id", "operator": "IN", "value": [aid]}]),
                    "fields": "video_play_curve_actions",
                    "limit": 1,
                    "date_preset": "maximum",
                }
                d = _meta_insights_get(
                    f"https://graph.facebook.com/{META_API_VERSION}/{account_id}/insights",
                    params, timeout=30,
                )
                if "error" in d:
                    continue
                rows = d.get("data") or []
                if not rows:
                    continue
                curve_actions = rows[0].get("video_play_curve_actions") or []
                length: Optional[float] = None
                for entry in curve_actions:
                    raw = entry.get("value") or entry.get("values")
                    if isinstance(raw, str):
                        try: raw = json.loads(raw)
                        except Exception: raw = []
                    if isinstance(raw, list) and raw:
                        # Trim trailing zeros so length is the actual end-of-video second.
                        trimmed = list(raw)
                        while trimmed and (trimmed[-1] in (0, "0", None)):
                            trimmed.pop()
                        if trimmed:
                            length = float(len(trimmed))
                            break
                if length is None:
                    continue
                out[vid] = length
                # Write back into the per-video_id cache so the next
                # /video-lengths call doesn't pay the insights cost again.
                existing = (disk.get(vid) or {}).get("payload") or {}
                existing["length"] = length
                disk[vid] = {"ts": time.time(), "payload": existing}
                _video_meta_cache_mem[vid] = (time.time(), existing)
            _save_video_meta_disk_cache(disk)

    return {"lengths": out}


@router.get("/video-bytes")
def proxy_video_bytes(u: str = Query(..., description="Upstream video URL (mp4)")):
    """Same-origin proxy for video bytes so browser-side Whisper / the
    Download menu can fetch a Meta CDN mp4 without tripping CORS.

    Buffers the whole upstream response into memory once and returns it
    as a single Response. The previous streaming-generator pattern
    suffered a lifecycle race. the httpx context closed before the
    generator yielded, leaving the client with a 200 OK + zero bytes.
    Buffering is fine here: Meta CDN mp4s are bounded (max ~25-50MB)
    and this endpoint is hit once per ad transcribe / download, not
    on a hot path.
    """
    if not u or not isinstance(u, str) or not u.startswith("http"):
        raise HTTPException(status_code=400, detail="bad url")
    try:
        import httpx

        with httpx.Client(
            timeout=120.0,
            follow_redirects=True,
            headers=_BROWSER_HEADERS,
        ) as client:
            resp = client.get(u)
        if resp.status_code != 200:
            raise HTTPException(
                status_code=502,
                detail=f"upstream HTTP {resp.status_code}",
            )
        return Response(
            content=resp.content,
            media_type=resp.headers.get("content-type", "video/mp4"),
            headers={
                "Cache-Control": "private, max-age=300",
                "Content-Length": str(len(resp.content)),
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"proxy fetch failed: {e}")


@router.get("/video/{video_id}.mp4")
def serve_cached_video(video_id: str):
    """Stream a locally-cached mp4 back to the browser.

    Supports HTTP Range requests so the <video> element can seek. The
    local cache is populated the first time a scrape lands a Meta CDN
    URL for a given ``video_id``. see ``_download_video_to_cache``.
    """
    # Basic path traversal guard. the video_id is a Meta-supplied
    # integer-ish string, not user input, but belt+suspenders.
    if "/" in video_id or "\\" in video_id or ".." in video_id:
        raise HTTPException(status_code=400, detail="bad video_id")
    path = _video_file_cache_lookup(video_id)
    if not path:
        raise HTTPException(status_code=404, detail="video not cached")
    from fastapi.responses import FileResponse
    # Meta videos are always mp4; serve with inline content-disposition
    # so the browser plays in-place rather than offering to download.
    return FileResponse(
        path,
        media_type="video/mp4",
        headers={
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=604800, immutable",
        },
    )


def _scrape_reel_playback_url(permalink: str) -> Optional[str]:
    """Pull the raw mp4 URL out of a public Reel/video page.

    Desktop facebook.com ships a JS shell with no video metadata. the
    actual stream URL comes from an async GraphQL fetch the client makes
    after load. Without headless-browser infra we can't wait for it.

    The **mobile** site (``m.facebook.com``) still server-side-renders
    the mp4 URL directly into the HTML for JS-disabled / old-mobile
    clients. Same scontent .mp4 the desktop site eventually serves, and
    it plays in any browser's ``<video>`` tag with no chrome.

    Returns None on any failure. Safe to call even when the video is
    private or geo-restricted. we just get no mp4 URL back and the
    caller falls through to its iframe fallback.
    """
    if not permalink or not isinstance(permalink, str):
        return None

    # Rewrite www / plain facebook.com → m.facebook.com for the scrape.
    # The permalink format Meta returns is ``https://www.facebook.com/reel/<id>/``
    #. swap only the host so trailing slashes / path stay intact.
    import re as _re
    mob = _re.sub(
        r"^https?://(?:www\.|web\.)?facebook\.com/",
        "https://m.facebook.com/",
        permalink,
    )
    if not mob.startswith("https://m.facebook.com/"):
        mob = permalink  # permalink wasn't a fb.com URL. use as-is

    try:
        import requests as req  # late import. matches existing pattern
        # Mobile Safari UA so Meta serves the mobile-web variant. A
        # desktop UA here gets redirected back to the JS shell.
        resp = req.get(
            mob,
            timeout=12,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) "
                    "AppleWebKit/605.1.15 (KHTML, like Gecko) "
                    "Mobile/15E148"
                ),
                "Accept-Language": "en-US,en;q=0.9",
            },
            allow_redirects=True,
        )
        if resp.status_code != 200 or not resp.text:
            return None
        html = resp.text
    except Exception as e:
        print(f"[ad-analysis] reel scrape fetch failed for {mob}: {e}", flush=True)
        return None

    # m.facebook.com renders the mp4 URL inline as either a bare HTTPS
    # link or inside a JSON blob. A generic match on `*.mp4` with query
    # params is the most resilient. Meta has rotated the JSON field
    # names multiple times in the last year. Prefer longer matches
    # since the full URL includes the signing params we need.
    candidates: list[str] = []
    for m in _re.finditer(r'(https?:[^"\s<>\\]+\.mp4[^"\s<>\\]*)', html):
        candidates.append(m.group(1))
    if not candidates:
        return None
    # De-HTML-escape (&amp; → &) and pick the longest candidate. those
    # carry the full sig params and are usually the HD variant.
    cleaned = [
        u.replace("&amp;", "&").replace("\\/", "/").replace("\\u0026", "&")
        for u in candidates
    ]
    cleaned.sort(key=len, reverse=True)
    return cleaned[0]


def _disk_cache_get(cache_key: str) -> Optional[Any]:
    data = _load_creatives_disk_cache()
    entry = data.get(cache_key)
    if not isinstance(entry, dict):
        return None
    ts = entry.get("ts") or 0
    if (time.time() - ts) > CREATIVES_DISK_CACHE_TTL:
        return None
    return entry.get("payload")


def _disk_cache_put(cache_key: str, payload: Any) -> None:
    data = _load_creatives_disk_cache()
    data[cache_key] = {"ts": time.time(), "payload": payload}
    _save_creatives_disk_cache(data)


def _migrate_cache_keys_to_hash(cache: dict) -> tuple[dict, int, int]:
    """Re-key entries from ``ad_id::creative_hash`` to just ``creative_hash``.

    Idempotent. entries that are already hash-only are left untouched.
    When multiple ad_ids share the same creative_hash, we keep the
    entry with the latest ``analyzed_at`` timestamp so the most recent
    Claude output wins.

    Returns ``(new_cache, rekeyed_count, dropped_count)``.
    """
    new_cache: dict = {}
    rekeyed = 0
    dropped = 0
    for key, entry in cache.items():
        if not isinstance(entry, dict):
            dropped += 1
            continue
        # Derive the target hash. prefer the stored field, otherwise
        # parse it out of the legacy compound key.
        target = entry.get("creative_hash")
        if not target and "::" in key:
            target = key.split("::", 1)[1]
        if not target:
            # No way to re-key. skip but don't lose it; keep under the
            # original key so a future schema migration can recover.
            new_cache[key] = entry
            continue
        if key != target:
            rekeyed += 1
        prior = new_cache.get(target)
        if prior is None:
            new_cache[target] = entry
            continue
        # Collision. keep newest by analyzed_at, else keep the one
        # that actually has an analysis payload.
        prior_ts = int(prior.get("analyzed_at") or 0)
        entry_ts = int(entry.get("analyzed_at") or 0)
        if entry_ts > prior_ts:
            new_cache[target] = entry
        elif entry_ts == prior_ts:
            if "analysis" in entry and "analysis" not in prior:
                new_cache[target] = entry
        # else: drop the older duplicate
    return new_cache, rekeyed, dropped


def _run_cache_migration_once() -> dict[str, int]:
    """One-shot migration at module load. Safe to call multiple times -
    on the second run everything is already hash-keyed so the function
    is a no-op. Writes the migrated cache back atomically.
    """
    cache = _load_analysis_cache()
    if not cache:
        return {"total": 0, "rekeyed": 0, "dropped": 0}
    new_cache, rekeyed, dropped = _migrate_cache_keys_to_hash(cache)
    if rekeyed or dropped or (len(new_cache) != len(cache)):
        _save_analysis_cache(new_cache)
    return {
        "total": len(new_cache),
        "rekeyed": rekeyed,
        "dropped": dropped,
    }


# Fire the migration as the module loads. Idempotent. re-keying a
# cache that already uses hash-only keys leaves it untouched.
try:
    _MIGRATION_STATS = _run_cache_migration_once()
    if _MIGRATION_STATS.get("rekeyed") or _MIGRATION_STATS.get("dropped"):
        print(
            f"[ad-analysis] cache migration: rekeyed="
            f"{_MIGRATION_STATS['rekeyed']} dropped="
            f"{_MIGRATION_STATS['dropped']} total="
            f"{_MIGRATION_STATS['total']}"
        )
except Exception as _migration_err:  # noqa: BLE001. don't block boot on migration
    print(f"[ad-analysis] cache migration skipped: {_migration_err}")
    _MIGRATION_STATS = {"total": 0, "rekeyed": 0, "dropped": 0, "error": str(_migration_err)}


def _compute_creative_hash(creative: dict) -> str:
    """Canonical creative fingerprint. SHA256 truncated to 16 chars.

    Inputs (concatenated with ``||`` as the separator so empty fields
    don't collapse into the same hash as other combinations):

        image_hash || video_id || (creative_name or '')[:32]

    ``image_hash`` is Meta's own per-asset md5. stable across ads that
    share the image. ``video_id`` plays the same role for videos. The
    creative name prefix distinguishes two creatives that happen to
    reuse the same raw asset but with different wrapping copy.

    Falls back to ``ad_id`` if every input is blank (paid-social ads in
    weird states sometimes come back without any asset fields, and we
    still need a cache key that won't collide with other entries).
    """
    image_hash = (creative.get("image_hash") or "").strip()
    video_id = (creative.get("video_id") or "").strip()
    name = (creative.get("creative_name") or creative.get("ad_name") or "").strip()[:32]
    fp_string = f"{image_hash}||{video_id}||{name}"
    if not image_hash and not video_id and not name:
        # Everything is blank. fall back to ad_id so entries still key
        # uniquely instead of all collapsing to the SHA of "||||".
        aid = (creative.get("ad_id") or "").strip()
        if aid:
            return hashlib.sha256(f"ad_id::{aid}".encode()).hexdigest()[:16]
    return hashlib.sha256(fp_string.encode()).hexdigest()[:16]


# Backwards-compat alias. plenty of call sites import ``_creative_hash``.
_creative_hash = _compute_creative_hash


def _get_meta_accounts() -> dict:
    """Import lazily so api_server is already loaded."""
    try:
        from api_server import META_ACCOUNTS
        return META_ACCOUNTS
    except Exception:
        # Fallback to env-less dict. caller will see the empty match
        return {}


# ---------------------------------------------------------------------------
# Meta fetch helpers
# ---------------------------------------------------------------------------


def _fetch_ad_insights(account_id: str, start: str, end: str, token: str) -> list[dict]:
    """Fetch per-ad insights for a date range. Level=ad gives us one row per
    ad, already aggregated over the period. Include ad_id + ad_name so we
    can later enrich with creative fields.
    """
    import requests as req

    # Ask for per-ad aggregate (no time_increment) so we get one row per ad
    fields = (
        "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,"
        "spend,impressions,clicks,reach,frequency,cpm,cpc,cpp,ctr,"
        "unique_outbound_clicks,"
        "actions,action_values,video_30_sec_watched_actions,"
        "video_play_actions,video_thruplay_watched_actions,"
        "video_p25_watched_actions,video_p50_watched_actions,"
        "video_p75_watched_actions,video_p100_watched_actions"
    )
    params = {
        "access_token": token,
        "level": "ad",
        "time_range": json.dumps({"since": start, "until": end}),
        "fields": fields,
        "limit": 500,
    }
    url = f"https://graph.facebook.com/{META_API_VERSION}/{account_id}/insights"
    rows: list[dict] = []
    next_url: Optional[str] = None
    for _ in range(10):  # up to 10 pages (5,000 ads. far more than real-world)
        resp = req.get(next_url or url, params=None if next_url else params, timeout=120)
        data = resp.json()
        if "error" in data:
            _note_meta_rate_limit(data["error"])
            raise HTTPException(status_code=502, detail=data["error"].get("message", "Meta API error"))
        rows.extend(data.get("data", []))
        next_url = data.get("paging", {}).get("next")
        if not next_url:
            break
    return rows


def _fetch_ad_insights_with_breakdowns(
    account_id: str,
    start: str,
    end: str,
    token: str,
    breakdowns: str,
) -> list[dict]:
    """Per-ad insights split by demographic breakdown.

    `breakdowns` is a Meta-flavored CSV like ``"age,gender"`` or ``"region"``.
    The response shape grows by row count: one row per (ad, demo cell).
    For typical age × gender (~14 cells) on a 100-ad brand that's ~1400
    rows. Region by itself returns one row per (ad, state/province).

    Smaller field set than the main insights call. we only need spend +
    audience signals + purchase totals, not the full video-engagement
    suite, since the funnel-by-demo view doesn't show those metrics.
    Smaller payload = faster page + fewer Meta tokens burned.
    """
    import requests as req

    fields = (
        "ad_id,ad_name,adset_id,campaign_id,"
        "spend,impressions,reach,frequency,cpm,ctr,"
        "actions,action_values"
    )
    params = {
        "access_token": token,
        "level": "ad",
        "time_range": json.dumps({"since": start, "until": end}),
        "breakdowns": breakdowns,
        "fields": fields,
        "limit": 500,
    }
    url = f"https://graph.facebook.com/{META_API_VERSION}/{account_id}/insights"
    rows: list[dict] = []
    next_url: Optional[str] = None
    # Higher page cap because breakdowns multiply row count. 25 pages × 500
    # rows = 12,500 cells, comfortably above what any single brand produces
    # for a 30-day window.
    for _ in range(25):
        resp = req.get(next_url or url, params=None if next_url else params, timeout=120)
        data = resp.json()
        if "error" in data:
            _note_meta_rate_limit(data["error"])
            raise HTTPException(
                status_code=502,
                detail=data["error"].get("message", "Meta API error"),
            )
        rows.extend(data.get("data", []))
        next_url = data.get("paging", {}).get("next")
        if not next_url:
            break
    return rows


# ---------------------------------------------------------------------------
# Real funnel mix. Meta's `user_segment_key` breakdown reports the ACTUAL
# spend Meta delivered to prospecting (New) / engaged (MOF) / existing (BOF)
# per ad — verified live to work at ad level across ASC *and* manual
# campaigns. This replaces the old frequency+CPMr *guess* with a real,
# per-creative segment blend. An `unknown` bucket exists and can be large
# (~15% for some accounts), so we keep it as a first-class value rather than
# forcing every dollar into a lane.
#
# Resilience: Meta relabels these segments periodically. We normalize by
# prefix/substring into four stable buckets and ALSO keep the raw labels in
# `_raw`, so a rename degrades gracefully into `unknown` instead of breaking.
# ---------------------------------------------------------------------------

def _normalize_segment(raw: Optional[str]) -> str:
    """Map a raw Meta ``user_segment_key`` value to a stable bucket.

    Stable buckets: prospecting | engaged | existing | unknown. Matching is
    deliberately loose (prefix/substring) so Meta's periodic relabels still
    land somewhere sensible; anything unrecognized falls to ``unknown``.
    """
    s = (raw or "").strip().lower()
    if not s or s in ("unknown", "none", "n/a", "not_available"):
        return "unknown"
    if s.startswith("prospect") or s.startswith("new") or "acquisition" in s:
        return "prospecting"
    if s.startswith("engag") or "consider" in s:
        return "engaged"
    if (s.startswith("exist") or s.startswith("repeat") or "purchas" in s
            or "customer" in s or "return" in s or "retention" in s or "loyal" in s):
        return "existing"
    return "unknown"


def _empty_segment_spend() -> dict:
    return {"prospecting": 0.0, "engaged": 0.0, "existing": 0.0, "unknown": 0.0, "_raw": {}}


def _fetch_ad_segment_spend(account_id: str, start: str, end: str, token: str) -> dict[str, dict]:
    """``{ad_id: {prospecting, engaged, existing, unknown, _raw}}`` from the
    ``user_segment_key`` breakdown. Best-effort: any failure returns ``{}`` so
    the creatives endpoint (critical infra) never breaks on this enrichment.
    """
    try:
        rows = _fetch_ad_insights_with_breakdowns(
            account_id, start, end, token, "user_segment_key"
        )
    except Exception as e:  # noqa: BLE001 — enrichment must never be fatal
        print(f"[funnel] user_segment_key breakdown failed: {e}", flush=True)
        return {}
    out: dict[str, dict] = {}
    for r in rows:
        ad_id = r.get("ad_id")
        if not ad_id:
            continue
        ad_id = str(ad_id)
        raw = r.get("user_segment_key") or "unknown"
        seg = _normalize_segment(raw)
        spend = float(r.get("spend", 0) or 0)
        entry = out.setdefault(ad_id, _empty_segment_spend())
        entry[seg] += spend
        entry["_raw"][raw] = entry["_raw"].get(raw, 0.0) + spend
    return out


# ---------------------------------------------------------------------------
# Reactivation inference. Meta has no native "reactivation" segment, so we
# infer it from ad-set targeting: an ad set that INCLUDES a customer/purchaser
# custom audience AND EXCLUDES another audience (i.e. suppresses recent buyers)
# is a winback/lapsed-customer shape. Also matches obvious name conventions.
# Best-effort; targeting names aren't guaranteed, so this is a hint, not truth.
# ---------------------------------------------------------------------------
_REACTIVATION_NAME_RE = re.compile(
    r"react|re-?engage|win-?back|winback|lapsed|dormant|churn|lost", re.I
)
_CUSTOMER_AUD_RE = re.compile(
    r"purchas|customer|buyer|order|ltv|vip|klaviyo|subscriber|list|retention", re.I
)


def _is_reactivation_adset(adset: dict) -> bool:
    name = adset.get("name") or ""
    if _REACTIVATION_NAME_RE.search(name):
        return True
    t = adset.get("targeting") or {}
    incl = t.get("custom_audiences") or []
    excl = t.get("excluded_custom_audiences") or []
    has_customer_incl = any(
        _CUSTOMER_AUD_RE.search(a.get("name") or "") for a in incl if isinstance(a, dict)
    )
    # Including a customer list while excluding *any* audience is the classic
    # winback suppression shape (include buyers, exclude recent buyers).
    return has_customer_incl and len(excl) > 0


def _fetch_adset_reactivation(account_id: str, token: str) -> set[str]:
    """Set of ad-set ids that look like reactivation/winback. Best-effort."""
    import requests as req

    params = {
        "access_token": token,
        "fields": "id,name,targeting",
        "limit": 200,
    }
    url = f"https://graph.facebook.com/{META_API_VERSION}/{account_id}/adsets"
    flagged: set[str] = set()
    next_url: Optional[str] = None
    try:
        for _ in range(20):
            resp = req.get(next_url or url, params=None if next_url else params, timeout=120)
            data = resp.json()
            if "error" in data:
                _note_meta_rate_limit(data["error"])
                break
            for a in data.get("data", []):
                if _is_reactivation_adset(a):
                    flagged.add(str(a.get("id")))
            next_url = data.get("paging", {}).get("next")
            if not next_url:
                break
    except Exception as e:  # noqa: BLE001 — enrichment must never be fatal
        print(f"[funnel] adset reactivation fetch failed: {e}", flush=True)
    return flagged


# ---------------------------------------------------------------------------
# Image URL normalization. strip Meta's `stp=` transform to get full-res
# ---------------------------------------------------------------------------
#
# Meta's scontent CDN serves image_url responses with a `stp=` query parameter
# that pegs the asset to a specific transform (e.g. `stp=dst-jpg_tt6` for a
# thumbnail-ish 480-ish px output). Drop the parameter and the CDN falls back
# to serving the full-resolution original. We keep the original URL on
# `thumbnail_url_low` so callers that want the cheap variant (grid thumbs at
# scale) still have access.
_STP_COUNT_SENTINEL: dict[str, int] = {"stripped": 0}


def _strip_stp_transform(image_url: Optional[str]) -> Optional[str]:
    """Remove Meta's size-limiting ``stp=<transform>`` query param, if present.

    Meta returns the full-resolution original when the transform param is
    absent. Also collapses any ``?&`` / trailing ``?&`` artifacts that may
    remain after a leading ``stp=`` is dropped.
    """
    if not image_url or not isinstance(image_url, str):
        return image_url
    if "stp=" not in image_url:
        return image_url
    cleaned = re.sub(r"&?stp=[^&]*", "", image_url)
    cleaned = cleaned.replace("?&", "?").rstrip("?&")
    if cleaned != image_url:
        _STP_COUNT_SENTINEL["stripped"] += 1
    return cleaned


# ---------------------------------------------------------------------------
# Image hash -> full-res URL batch resolver
# ---------------------------------------------------------------------------
#
# Meta's /{account_id}/adimages?hashes=[..] returns { url_128, url_1080,
# url_full } for each hash. significantly higher res than the transform URLs
# embedded in the creative. We batch the lookup per-brand on first access so
# we avoid per-ad round trips, and keep the result in-memory with a short TTL.
_image_hash_cache: dict[str, tuple[float, dict[str, dict]]] = {}
IMAGE_HASH_CACHE_TTL = 2 * 60 * 60  # 2 hours. matches creatives disk cache


def _fetch_image_hash_urls_bulk(
    account_id: str,
    hashes: list[str],
    token: str,
) -> dict[str, dict]:
    """Resolve a batch of ``image_hash`` values to ``{url_128, url_1080, url_full}``.

    ``account_id`` is expected to be the ``act_…`` form. Meta caps query
    string length so we chunk the hash list at 50 per call. far below the
    limit in practice but we never want to silently truncate. Returns a
    dict keyed by hash; entries for hashes that failed or were missing
    simply aren't present. Cached in-memory per account.
    """
    if not hashes:
        return {}
    cache_key = account_id
    now = time.time()
    entry = _image_hash_cache.get(cache_key)
    have: dict[str, dict] = {}
    if entry and (now - entry[0]) < IMAGE_HASH_CACHE_TTL:
        have = dict(entry[1])  # shallow copy so we can extend with misses
    # Any hashes already cached are skipped
    missing = [h for h in hashes if h and h not in have]
    if not missing:
        return have

    import requests as req

    url = f"https://graph.facebook.com/{META_API_VERSION}/{account_id}/adimages"
    for i in range(0, len(missing), 50):
        chunk = missing[i:i + 50]
        try:
            resp = req.get(
                url,
                params={
                    "access_token": token,
                    "hashes": json.dumps(chunk),
                    "fields": "hash,url_128,url_1080,url_full,permalink_url",
                },
                timeout=30,
            )
            data = resp.json()
        except Exception as e:
            print(f"[ad-analysis] adimages bulk fetch failed: {e}", flush=True)
            continue
        if "error" in data:
            _note_meta_rate_limit(data["error"])
            # Permission issues on adimages. log once per batch and move on
            print(
                f"[ad-analysis] adimages error for {account_id}: "
                f"{data['error'].get('message', '?')}",
                flush=True,
            )
            continue
        for row in data.get("data", []) or []:
            h = row.get("hash")
            if h:
                have[h] = {
                    "url_128": row.get("url_128"),
                    "url_1080": row.get("url_1080"),
                    "url_full": row.get("url_full"),
                    "permalink_url": row.get("permalink_url"),
                }

    _image_hash_cache[cache_key] = (time.time(), have)
    return have


def _fetch_ad_creative(
    ad_id: str,
    token: str,
    force: bool = False,
    brand: Optional[str] = None,
    account_id: Optional[str] = None,
) -> dict:
    """Fetch creative metadata for one ad. Returns a flattened dict with
    image_url, video_id, thumbnail_url, body, title, video_source_url, etc.

    Raises :class:`RateLimitedError` if the global Meta cooldown is active;
    FastAPI handlers translate that to a 503 + Retry-After.

    ``force=True`` is threaded through to ``_get_video_metadata`` so
    ``/refresh-urls`` can bypass the 7-day video cache. playback URLs
    expire in hours even though the metadata itself is stable.

    Hot path: check the DuckDB warehouse first (item #14. Atria-style
    persistent creative cache). Most ads don't change post-launch, so
    a 7-day TTL hit covers ~95% of dashboard loads with zero Meta
    calls. ``force=True`` bypasses the warehouse so the explicit
    Refresh button always re-pulls from Graph.
    """
    import requests as req

    if not force:
        try:
            from creative_warehouse import get_cached
            cached = get_cached(str(ad_id))
            if cached is not None:
                return cached
        except Exception as e:
            # Warehouse failures are non-fatal. fall through to Meta.
            print(f"[creative-warehouse] read failed: {e}", flush=True)

    # Short-circuit before we even dial Meta when we're in cooldown. the
    # caller will surface 503 + Retry-After to the client.
    _check_rate_limit_pause()

    # We ask Meta for the ad, with a nested creative{} expansion. The
    # `image_url` on an AdCreative is the full-size asset; `thumbnail_url`
    # is always present (including for videos). `effective_object_story_id`
    # is the published post id, useful for linking back to Ads Manager.
    # Ad-level fields (effective_status / configured_status / updated_time)
    # let the UI render the live/paused dot + last-state-change tooltip.
    # `effective_status` reflects whether the ad is actually delivering
    # (it can differ from the user-configured status if a parent adset
    # is paused, the campaign is over, etc.).
    # NOTE: `status` was deprecated on the Ad node in Meta Marketing API
    # v17+. v23.0 returns error code 100 "Tried accessing nonexistent
    # field (status) on node type (Ad)". `effective_status` (actual
    # delivery state) + `configured_status` (user-set state) are the
    # current replacements; both are still requested below.
    fields = (
        "id,name,effective_status,configured_status,updated_time,"
        "creative{"
        "id,name,image_url,image_hash,video_id,thumbnail_url,title,body,"
        "call_to_action_type,effective_object_story_id,object_story_spec,"
        "asset_feed_spec"
        "}"
    )
    url = f"https://graph.facebook.com/{META_API_VERSION}/{ad_id}"
    resp = req.get(url, params={"access_token": token, "fields": fields}, timeout=60)
    try:
        _observe_meta_usage_headers(getattr(resp, "headers", {}) or {})
    except Exception:
        pass
    data = resp.json()
    if "error" in data:
        return {}
    creative = data.get("creative", {}) or {}

    # Meta's creative may only have asset_feed_spec for dynamic creative
    # ads. dig into it if image_url is missing.
    if not creative.get("image_url") and isinstance(creative.get("asset_feed_spec"), dict):
        afs = creative["asset_feed_spec"]
        imgs = afs.get("images") or []
        if imgs:
            # First image in the asset feed. `permalink_url` or `url`
            first = imgs[0] or {}
            creative["image_url"] = first.get("url") or first.get("permalink_url")
        vids = afs.get("videos") or []
        if vids and not creative.get("video_id"):
            creative["video_id"] = vids[0].get("video_id")
            creative["thumbnail_url"] = vids[0].get("thumbnail_url") or creative.get("thumbnail_url")
        bodies = afs.get("bodies") or []
        if bodies and not creative.get("body"):
            creative["body"] = bodies[0].get("text", "")
        titles = afs.get("titles") or []
        if titles and not creative.get("title"):
            creative["title"] = titles[0].get("text", "")

    video_source_url: Optional[str] = None
    video_permalink: Optional[str] = None
    video_embed_html: Optional[str] = None

    # Video ads need a separate hop to resolve both a high-quality thumbnail
    # and the playable source URL. Meta sometimes refuses to serve `source`
    # on restricted videos. the frontend falls back to a "Watch on Facebook"
    # CTA using `video_permalink` when that happens. Routed through the
    # per-video disk cache (`_get_video_metadata`) so we don't re-hit
    # `gr:get:/<video_id>` for every creative cache miss.
    if creative.get("video_id"):
        vd = _get_video_metadata(creative["video_id"], token, force=force)
        if vd:
            if vd.get("picture") and not creative.get("thumbnail_url"):
                creative["thumbnail_url"] = vd["picture"]
            thumbs = (vd.get("thumbnails") or {}).get("data") or []
            preferred = next((t for t in thumbs if t.get("is_preferred")), None)
            if preferred and preferred.get("uri"):
                # Editorial "is_preferred" thumb beats the auto-picked frame.
                creative["thumbnail_url"] = preferred.get("uri")
            video_source_url = vd.get("source")
            video_permalink = vd.get("permalink_url")
            video_embed_html = vd.get("embed_html")
            if video_permalink and not video_permalink.startswith("http"):
                # Meta sometimes returns permalink_url as a path ("/…/videos/…")
                video_permalink = f"https://www.facebook.com{video_permalink}"

    # Normalize the image URL. strip Meta's size-limiting `stp=` transform
    # so we serve the full-resolution original. Keep the original as the
    # "low" variant for card grids that want the cheap asset at scale.
    raw_image_url = creative.get("image_url")
    stripped_image_url = _strip_stp_transform(raw_image_url)
    # Strip the thumbnail transform too. helps posters for video ads look
    # less pixelated when we don't have a full-res alternative.
    stripped_thumbnail_url = _strip_stp_transform(creative.get("thumbnail_url"))

    out = {
        "ad_id": data.get("id"),
        "ad_name": data.get("name"),
        "creative_id": creative.get("id"),
        "creative_name": creative.get("name"),
        "image_url": stripped_image_url,
        "thumbnail_url_low": raw_image_url if (raw_image_url and raw_image_url != stripped_image_url) else None,
        "image_hash": creative.get("image_hash"),
        "video_id": creative.get("video_id"),
        "thumbnail_url": stripped_thumbnail_url,
        "video_source_url": video_source_url,
        "video_permalink": video_permalink,
        "video_embed_html": video_embed_html,
        "title": creative.get("title", ""),
        "body": creative.get("body", ""),
        "call_to_action_type": creative.get("call_to_action_type"),
        "effective_object_story_id": creative.get("effective_object_story_id"),
        # Ad lifecycle. drives the live/paused dot on cards + status pill
        # in the table view. `effective_status` is what's actually
        # delivering (could be PAUSED if a parent adset is off even when
        # the ad itself is configured ACTIVE). `updated_time` is the last
        # state-change timestamp Meta surfaces.
        "effective_status": data.get("effective_status"),
        "configured_status": data.get("configured_status") or data.get("status"),
        "updated_time": data.get("updated_time"),
    }
    # Warm the persistent warehouse so subsequent loads of this ad
    # don't pay another Graph round-trip. Failures are non-fatal -
    # the response we just built is fine to return regardless.
    try:
        from creative_warehouse import upsert as _wh_upsert
        # Stamp brand/account_id so warehouse rows are scoped. the
        # callers that have those values pass them in.
        wh_payload = dict(out)
        if brand:
            wh_payload["brand"] = brand
        if account_id:
            wh_payload["account_id"] = account_id
        _wh_upsert(wh_payload)
    except Exception as e:
        print(f"[creative-warehouse] write failed: {e}", flush=True)
    return out


def _meta_insights_get(url: str, params: dict, timeout: int = 60, attempts: int = 3) -> dict:
    """GET a Meta /insights URL with exponential-backoff retry on transient
    failures. Returns the parsed JSON dict (or `{"error": ...}` once Meta
    has clearly settled into a permanent error).

    Retries on:
      • requests-level exceptions (connection reset, DNS, timeout)
      • HTTP 5xx
      • Meta `error.is_transient == True`
      • Meta error codes 1, 2, 4 (transient / rate-limited / app-rate-limit)
    Doesn't retry on 4xx-with-permanent-error or successful payloads -
    the caller can decide what an empty `data: []` means.

    Backoff: 0.6s, 1.6s, 3.6s. Tuned to ride out the typical 1-2s
    blip without hammering Meta or making the user wait forever.
    """
    import requests as req
    last_payload: dict = {}
    delay = 0.6
    for attempt in range(attempts):
        try:
            r = req.get(url, params=params, timeout=timeout)
            try:
                payload = r.json()
            except Exception:
                payload = {"error": {"message": f"non-json response: {r.text[:200]}"}}
            last_payload = payload
            # Hard 5xx → retry
            if 500 <= r.status_code < 600:
                pass
            elif "error" in payload:
                err = payload.get("error") or {}
                code = err.get("code")
                if err.get("is_transient") or code in (1, 2, 4):
                    pass  # transient → retry
                else:
                    return payload  # permanent error, bubble up
            else:
                return payload  # success
        except Exception as e:
            last_payload = {"error": {"message": str(e)}}
        if attempt < attempts - 1:
            time.sleep(delay)
            delay *= 2.5
    return last_payload


def _parse_perf(r: dict) -> dict:
    """Pull out the metrics we care about for an ad-level row."""
    actions = r.get("actions") or []
    action_values = r.get("action_values") or []

    def act(t):
        for a in actions:
            if a.get("action_type") == t:
                return float(a.get("value", 0))
        return 0

    def aval(t):
        for a in action_values:
            if a.get("action_type") == t:
                return float(a.get("value", 0))
        return 0

    # Meta returns the video engagement counters as action-style arrays with
    # a single "video_view" bucket. Sum over all buckets defensively.
    def _sum_action_list(key: str) -> float:
        arr = r.get(key) or []
        total = 0.0
        for a in arr:
            try:
                total += float(a.get("value", 0) or 0)
            except Exception:
                pass
        return total

    spend = float(r.get("spend", 0) or 0)
    purchases = int(act("purchase") or act("offsite_conversion.fb_pixel_purchase"))
    revenue = aval("purchase") or aval("offsite_conversion.fb_pixel_purchase")
    clicks = int(r.get("clicks", 0) or 0)
    impressions = int(r.get("impressions", 0) or 0)
    link_clicks = int(act("link_click"))
    add_to_cart = int(act("add_to_cart") or act("offsite_conversion.fb_pixel_add_to_cart"))

    # Video engagement. needed for hook/hold/completion rate calculations in
    # the frontend's custom metrics.
    video_3s_views = int(_sum_action_list("video_play_actions"))
    thruplays = int(_sum_action_list("video_thruplay_watched_actions"))
    video_p25 = int(_sum_action_list("video_p25_watched_actions"))
    video_p50 = int(_sum_action_list("video_p50_watched_actions"))
    video_p75 = int(_sum_action_list("video_p75_watched_actions"))
    video_p100 = int(_sum_action_list("video_p100_watched_actions"))

    # Motion-style extras: outbound clicks, landing page views, ATC value,
    # post reactions/comments/shares, video avg watch time, 15s views,
    # "see more" clicks. These back the engagement + funnel groups in the
    # UI. Each missing action just resolves to 0.
    outbound_clicks = int(act("outbound_click"))
    # Meta returns unique_outbound_clicks as an action-style array; sum buckets.
    unique_outbound_clicks = 0
    uoc_arr = r.get("unique_outbound_clicks") or []
    if isinstance(uoc_arr, list):
        for a in uoc_arr:
            try:
                unique_outbound_clicks += int(float(a.get("value", 0) or 0))
            except Exception:
                pass
    elif isinstance(uoc_arr, (int, float, str)):
        try:
            unique_outbound_clicks = int(float(uoc_arr))
        except Exception:
            unique_outbound_clicks = 0
    landing_page_views = int(act("landing_page_view"))
    add_to_cart_value = aval("add_to_cart") or aval("offsite_conversion.fb_pixel_add_to_cart")
    leads = int(
        act("lead") or act("onsite_web_lead") or act("offsite_conversion.fb_pixel_lead")
    )
    initiate_checkout = int(
        act("initiate_checkout") or act("offsite_conversion.fb_pixel_initiate_checkout")
    )
    post_reactions = int(
        act("post_reaction") or act("like") or act("post_like")
    )
    post_comments = int(act("comment") or act("post_comment"))
    post_shares = int(act("post") or act("post_share") or act("share"))
    post_engagement = int(act("post_engagement"))
    post_saves = int(act("onsite_conversion.post_save") or act("post_save"))
    page_follows = int(
        act("onsite_conversion.like")
        or act("follow")
        or act("page_like")
        or act("onsite_conversion.follow")
    )
    see_more_clicks = int(
        act("link_click_see_more") or act("onsite_conversion.see_more")
    )
    video_15s_views = int(_sum_action_list("video_15_sec_watched_actions"))
    # avg time watched is seconds, already aggregated by Meta in the
    # video_avg_time_watched_actions key.
    video_avg_time_watched = 0.0
    avg_arr = r.get("video_avg_time_watched_actions") or []
    if isinstance(avg_arr, list):
        for a in avg_arr:
            try:
                val = float(a.get("value", 0) or 0)
                if val > video_avg_time_watched:
                    video_avg_time_watched = val
            except Exception:
                pass

    return {
        "spend": round(spend, 2),
        "impressions": impressions,
        "clicks": clicks,
        "link_clicks": link_clicks,
        "outbound_clicks": outbound_clicks,
        "reach": int(r.get("reach", 0) or 0),
        "frequency": float(r.get("frequency", 0) or 0),
        "ctr": float(r.get("ctr", 0) or 0),
        "cpc": float(r.get("cpc", 0) or 0),
        "cpm": float(r.get("cpm", 0) or 0),
        # Meta's Cost per 1,000 Accounts Center people reached
        "cpp": float(r.get("cpp", 0) or 0),
        "unique_outbound_clicks": unique_outbound_clicks,
        "purchases": purchases,
        "revenue": round(revenue, 2),
        "roas": round(revenue / spend, 2) if spend > 0 else 0,
        "add_to_cart": add_to_cart,
        "add_to_cart_value": round(add_to_cart_value, 2),
        "initiate_checkout": initiate_checkout,
        "leads": leads,
        "landing_page_views": landing_page_views,
        "cost_per_purchase": round(spend / purchases, 2) if purchases > 0 else 0,
        # Engagement counters (Motion parity)
        "post_reactions": post_reactions,
        "post_comments": post_comments,
        "post_shares": post_shares,
        "post_engagement": post_engagement,
        "post_saves": post_saves,
        "page_follows": page_follows,
        "see_more_clicks": see_more_clicks,
        # Video engagement. 0 when not a video ad
        "video_3s_views": video_3s_views,
        "video_views": video_3s_views,
        "video_15s_views": video_15s_views,
        "video_avg_time_watched": round(video_avg_time_watched, 2),
        "thruplays": thruplays,
        "video_p25": video_p25,
        "video_p50": video_p50,
        "video_p75": video_p75,
        "video_p100": video_p100,
    }


# ---------------------------------------------------------------------------
# Naming convention parser
# ---------------------------------------------------------------------------
#
# Ad names at this agency follow a loose pipe-delimited convention, e.g.:
#     CanoopsyiPhone17Launch093112082025 | DR | UGC | Whitelisting |
#       Single Profile Identity | Canoopsy l | September 2025 | HP
#
# Adset names follow a slash/dash/pipe convention, e.g.:
#     OM | TOF-CONVERSION-ABO-LC-CREATIVE_TEST-NC
#
# We parse best-effort. each token is optional and unknown tokens are
# retained under ``extras`` so the UI can surface them.

_OBJECTIVE_TOKENS = {
    "DR": "Direct Response",
    "AWARENESS": "Awareness",
    "AW": "Awareness",
    "TRAFFIC": "Traffic",
    "ENGAGEMENT": "Engagement",
    "LEADS": "Leads",
    "CONVERSION": "Conversion",
    "CONVERSIONS": "Conversion",
}
_FORMAT_TOKENS = {
    "UGC": "UGC",
    "STATIC": "Static",
    "VIDEO": "Video",
    "GIF": "GIF",
    "CAROUSEL": "Carousel",
    "COLLECTION": "Collection",
    "STORY": "Story",
    "REEL": "Reel",
    "REELS": "Reel",
}
_TYPE_TOKENS = {
    "WHITELISTING": "Whitelisting",
    "WHITELIST": "Whitelisting",
    "STANDARD": "Standard",
    "PARTNERSHIP": "Partnership",
    "DARK": "Dark Post",
    "ORGANIC": "Organic",
}
_FUNNEL_TOKENS = {
    "TOF": "TOF",
    "MOF": "MOF",
    "BOF": "BOF",
    "RA": "Reactivation",
    "REACTIVATION": "Reactivation",
    "RETARGETING": "MOF",
    "RT": "MOF",
    "PROSPECTING": "TOF",
}
_BIDDING_TOKENS = {
    "ABO": "ABO",
    "CBO": "CBO",
    "LC": "Lowest Cost",
    "LCB": "Lowest Cost w/ Bid Cap",
    "COST_CAP": "Cost Cap",
    "TARGET_COST": "Target Cost",
    "ROAS": "Minimum ROAS",
}
_AUDIENCE_TOKENS = {
    "NC": "New Customer",
    "RC": "Returning Customer",
    "LAL": "Lookalike",
    "BROAD": "Broad",
    "INTEREST": "Interest",
    "CUSTOM": "Custom Audience",
}
_DATE_MMDDYYYY = re.compile(r"(?<!\d)(\d{2})(\d{2})(\d{4})(?!\d)")
_DATE_ISOISH = re.compile(r"(20\d{2})[-_/]?(\d{2})[-_/]?(\d{2})")
_MONTH_NAMES = (
    "january|february|march|april|may|june|july|august|september|october|november|december|"
    "jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec"
)
_MONTH_YEAR_RE = re.compile(rf"\b({_MONTH_NAMES})\s+(20\d{{2}})\b", re.IGNORECASE)


def _extract_date_hint(text: str) -> Optional[str]:
    """Pull a date-ish token out of free text. Returns ISO-like ``YYYY-MM-DD``
    when possible, else ``Month YYYY``, else None.
    """
    if not text:
        return None
    m = _DATE_ISOISH.search(text)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = _DATE_MMDDYYYY.search(text)
    if m:
        return f"{m.group(3)}-{m.group(1)}-{m.group(2)}"
    m = _MONTH_YEAR_RE.search(text)
    if m:
        return f"{m.group(1).title()} {m.group(2)}"
    return None


def _token_match(token: str, table: dict) -> Optional[str]:
    t = re.sub(r"[^A-Z0-9]", "", token.upper())
    return table.get(t)


def parse_ad_name(name: Optional[str]) -> dict:
    """Parse a pipe-delimited ad name into structured tokens.

    Returns a dict of extracted fields; all keys optional. Unknown tokens
    are collected in ``extras`` so the UI can surface them as loose tags.
    """
    out: dict[str, Any] = {"raw": name or "", "extras": []}
    if not name:
        return out
    parts = [p.strip() for p in name.split("|") if p.strip()]
    if not parts:
        return out

    # Date heuristics: check the whole name for anything date-looking, and
    # also try each token.
    date_hint = _extract_date_hint(name)
    if date_hint:
        out["date"] = date_hint

    used_indices: set[int] = set()

    # First token is typically the concept/launch slug. keep it as
    # ``concept`` if we can't classify it as anything else.
    for idx, tok in enumerate(parts):
        matched = False
        if (obj := _token_match(tok, _OBJECTIVE_TOKENS)):
            out.setdefault("objective", obj)
            matched = True
        if (fmt := _token_match(tok, _FORMAT_TOKENS)):
            out.setdefault("format", fmt)
            matched = True
        if (typ := _token_match(tok, _TYPE_TOKENS)):
            out.setdefault("type", typ)
            matched = True
        if (fun := _token_match(tok, _FUNNEL_TOKENS)):
            out.setdefault("funnel", fun)
            matched = True
        if (bid := _token_match(tok, _BIDDING_TOKENS)):
            out.setdefault("bidding", bid)
            matched = True
        if (aud := _token_match(tok, _AUDIENCE_TOKENS)):
            out.setdefault("audience", aud)
            matched = True
        # Token itself is a date string
        if not matched:
            d = _extract_date_hint(tok)
            if d:
                out.setdefault("launch_date", d)
                matched = True
        if matched:
            used_indices.add(idx)

    unmatched = [parts[i] for i in range(len(parts)) if i not in used_indices]
    # Heuristic: first unmatched token tends to be the concept slug (brand +
    # product + launch ID). The last unmatched token is often a flight /
    # placement marker like "HP". The middle unmatched tokens are typically
    # concept/persona labels.
    if unmatched:
        out.setdefault("concept", unmatched[0])
    if len(unmatched) >= 2:
        # The last short (<=4 char) unmatched token is usually a flight/placement
        last = unmatched[-1]
        if len(last) <= 4:
            out.setdefault("flight", last)
            unmatched = unmatched[:-1]
    if len(unmatched) >= 2:
        # If we still have middle tokens, take the longest as the persona hint.
        middle = unmatched[1:]
        if middle:
            persona = max(middle, key=len)
            out.setdefault("persona_hint", persona)
    out["extras"] = unmatched
    return out


def parse_adset_name(name: Optional[str]) -> dict:
    """Parse an adset name like ``OM | TOF-CONVERSION-ABO-LC-CREATIVE_TEST-NC``.

    The owner initials appear as an isolated 2-3 letter token, typically
    the first pipe segment. The rest is a hyphenated payload we scan for
    funnel / campaign-type / bidding / test-flag tokens.
    """
    out: dict[str, Any] = {"raw": name or "", "extras": []}
    if not name:
        return out

    # Split on pipes first, then flatten hyphen-separated segments.
    pipe_parts = [p.strip() for p in name.split("|") if p.strip()]
    tokens: list[str] = []
    for part in pipe_parts:
        sub = re.split(r"[-/]", part)
        for s in sub:
            s = s.strip()
            if s:
                tokens.append(s)

    # Owner initials. first pure-alpha 2-3 letter token at the start.
    if pipe_parts:
        first = pipe_parts[0].strip()
        if re.fullmatch(r"[A-Z]{2,3}", first):
            out["owner"] = first

    test_flag_hit = False
    for tok in tokens:
        norm = tok.upper()
        if (fun := _token_match(tok, _FUNNEL_TOKENS)):
            out.setdefault("funnel", fun)
            continue
        if (obj := _token_match(tok, _OBJECTIVE_TOKENS)):
            out.setdefault("campaign_type", obj)
            continue
        if (bid := _token_match(tok, _BIDDING_TOKENS)):
            # ABO/CBO vs LC go into different slots so they don't overwrite
            # each other.
            if norm in ("ABO", "CBO"):
                out.setdefault("bidding", bid)
            else:
                out.setdefault("bid_strategy", bid)
            continue
        if (aud := _token_match(tok, _AUDIENCE_TOKENS)):
            out.setdefault("audience", aud)
            continue
        if "CREATIVE_TEST" in norm or norm == "TEST":
            out["test_flag"] = True
            test_flag_hit = True
            continue
        out["extras"].append(tok)

    if not test_flag_hit and out.get("extras"):
        # Some teams use just "CT" for creative test.
        if any(e.upper() in ("CT", "CT_TEST") for e in out["extras"]):
            out["test_flag"] = True
    return out


# ---------------------------------------------------------------------------
# Image fetching. base64 so Claude doesn't refuse hotlinked Meta CDN URLs
# ---------------------------------------------------------------------------


def _mime_from_bytes(data: bytes, fallback: str = "image/jpeg") -> str:
    """Sniff image MIME from magic bytes. Claude accepts jpeg/png/gif/webp."""
    if len(data) < 12:
        return fallback
    sig = data[:12]
    if sig.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if sig.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if sig.startswith(b"GIF87a") or sig.startswith(b"GIF89a"):
        return "image/gif"
    if sig[:4] == b"RIFF" and sig[8:12] == b"WEBP":
        return "image/webp"
    return fallback


def _maybe_resize(data: bytes, mime: str) -> tuple[bytes, str]:
    """If the image is over 5MB or an unsupported MIME, try PIL to shrink/
    convert. Fall back to the raw bytes if PIL isn't available or fails -
    Claude can handle 5-10MB images in most cases.
    """
    # Claude accepts jpeg/png/gif/webp. Everything else goes through PIL.
    needs_convert = mime not in ("image/jpeg", "image/png", "image/gif", "image/webp")
    needs_shrink = len(data) > MAX_IMAGE_BYTES
    if not needs_convert and not needs_shrink:
        return data, mime
    try:
        from PIL import Image  # type: ignore

        img = Image.open(io.BytesIO(data))
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGB")
        if needs_shrink:
            w, h = img.size
            scale = min(MAX_IMAGE_DIMENSION / max(w, h), 1.0)
            if scale < 1.0:
                img = img.resize(
                    (int(w * scale), int(h * scale)), Image.LANCZOS
                )
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85, optimize=True)
        return buf.getvalue(), "image/jpeg"
    except Exception:
        # PIL failure is non-fatal. ship raw and let Claude decide.
        return data, mime


def _ad_img_disk_cached_bytes(
    ad_id: str,
    story_id: Optional[str] = None,
) -> Optional[tuple[bytes, str]]:
    """Return cached bytes that the grid card already downloaded for this
    ad. Checks both cache namespaces:

      1. ``post-thumb:{story_id}``. what the grid uses now (pure og:image
         scrape, no Graph credits)
      2. ``img-by-ad:{ad_id}:auto``. legacy Graph-based path

    Lets analysis reuse those bytes instead of refetching the Meta CDN
    URL whose signature has often already expired (which produces the
    "Image fetch returned HTTP 403" error).
    """
    candidates: list[str] = []
    if story_id:
        candidates.append(f"post-thumb:{story_id}")
    candidates.append(f"img-by-ad:{ad_id}:auto")
    for cache_seed in candidates:
        digest = hashlib.sha256(cache_seed.encode("utf-8")).hexdigest()
        hit = _image_cache_lookup(digest)
        if not hit:
            continue
        path, ext = hit
        try:
            with open(path, "rb") as fp:
                return fp.read(), _content_type_for_ext(ext)
        except Exception:
            continue
    return None


def _fetch_image_base64(
    image_url: str,
    timeout: float = 15.0,
) -> tuple[str, str]:
    """Download an image with browser-like headers and return (b64, mime).

    Why: Claude's URL image fetcher respects the serving site's robots.txt
    and Meta's scontent CDN sporadically blocks it. Downloading server-side
    and handing base64 to Claude sidesteps the issue entirely. Adds a
    Referer: facebook.com header so Meta's CDN doesn't treat the fetch as
    hotlinking.

    Reuses the /api/ads/img disk cache (keyed by sha256 of the upstream URL)
    so if the frontend has already rendered a thumbnail for this creative,
    we skip the Meta round-trip entirely. This matters when Meta's signed
    URL has since expired. the cached bytes still work.
    """
    import httpx

    digest = hashlib.sha256(image_url.encode("utf-8")).hexdigest()
    hit = _image_cache_lookup(digest)
    if hit is not None:
        path, ext = hit
        try:
            with open(path, "rb") as fp:
                data = fp.read()
            mime = _content_type_for_ext(ext)
            data, mime = _maybe_resize(data, mime)
            return base64.b64encode(data).decode("ascii"), mime
        except Exception:
            pass  # fall through to live fetch

    try:
        with httpx.Client(
            headers=_BROWSER_HEADERS,
            follow_redirects=True,
            timeout=timeout,
        ) as client:
            resp = client.get(image_url)
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch image: {e}",
        )
    if resp.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"Image fetch returned HTTP {resp.status_code}",
        )
    data = resp.content
    if not data:
        raise HTTPException(status_code=502, detail="Empty image response")
    # Trust the Content-Type header first, then sniff magic bytes.
    ctype = (resp.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    mime = ctype if ctype.startswith("image/") else _mime_from_bytes(data)
    # Persist to disk so /api/ads/img hits and future analyze calls share
    # the same bytes. Write pre-resize so the proxy serves original quality.
    try:
        ext = _ext_for_content_type(mime)
        path = os.path.join(IMAGE_CACHE_DIR, f"{digest}.{ext}")
        tmp = path + ".tmp"
        with open(tmp, "wb") as fp:
            fp.write(data)
        os.replace(tmp, path)
    except Exception:
        pass
    # Guard against huge / unsupported images
    data, mime = _maybe_resize(data, mime)
    b64 = base64.b64encode(data).decode("ascii")
    return b64, mime


def _image_content_block(image_url: str) -> dict:
    """Build a Claude vision content block from a URL, preferring base64."""
    try:
        b64, mime = _fetch_image_base64(image_url)
        return {
            "type": "image",
            "source": {"type": "base64", "media_type": mime, "data": b64},
        }
    except HTTPException:
        # Re-raise so the caller can surface a clean error to the client.
        raise
    except Exception as e:
        # Last-ditch fallback to URL (may still fail on robots.txt). Better
        # than crashing the whole analyze call on a transient fetch error.
        print(f"[ad-analysis] base64 fetch failed, falling back to URL: {e}")
        return {
            "type": "image",
            "source": {"type": "url", "url": image_url},
        }


# ---------------------------------------------------------------------------
# JSON extraction helpers. Claude sometimes wraps JSON in prose or fences
# ---------------------------------------------------------------------------


def _try_close_truncated_json(text: str) -> Optional[dict]:
    """Best-effort repair when Haiku hits max_tokens mid-object.

    Walks the string and tracks open braces/brackets/quotes. If we exit the
    loop mid-structure, we append the minimum sequence of closers to make
    it parseable.
    """
    start = text.find("{")
    if start < 0:
        return None
    stack: list[str] = []  # stack of expected close chars
    in_str = False
    esc = False
    last_good = -1
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append("}" if ch == "{" else "]")
        elif ch in "}]":
            if stack:
                stack.pop()
            if not stack:
                last_good = i
    # Try truncating to last balanced position first
    if last_good > 0:
        try:
            return json.loads(text[start:last_good + 1])
        except Exception:
            pass
    # If still stuck, append closers + try. Strip trailing partial key/value first.
    body = text[start:].rstrip()
    # Drop any trailing ", or trailing partial string
    if in_str:
        body += '"'
    # Drop a trailing comma before the close, if present
    body = re.sub(r",\s*$", "", body)
    body += "".join(reversed(stack))
    try:
        return json.loads(body)
    except Exception:
        return None


def _extract_json_object(raw: str) -> Optional[dict]:
    """Pull the first top-level JSON object out of Claude's response.

    Handles:
      - bare JSON
      - ```json ... ``` fences
      - prose prefix/suffix around a JSON object
    """
    text = raw.strip()
    # Strip code fences
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```\s*$", "", text)
    # Try direct parse first
    try:
        return json.loads(text)
    except Exception:
        pass
    # Brace-balanced extraction so we grab the full nested object, not just
    # the first closing brace a regex finds.
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start:i + 1])
                    except Exception:
                        return None
    return None


def _extract_json_array(raw: str) -> Optional[list]:
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```\s*$", "", text)
    try:
        return json.loads(text)
    except Exception:
        pass
    m = re.search(r"\[\s*\{.*\}\s*\]", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            return None
    return None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


def _list_creatives_impl(brand: str, start: str, end: str, limit: int = 100) -> dict:
    """Core fetch logic for /api/ads/creatives. Also callable from the
    background prewarmer. that's why it's factored out of the endpoint.

    Cache tiers (checked in order):
      1. In-memory (15 min). fastest, cleared on restart
      2. Disk (2 h)        . survives restarts, shields cold-cache users
      3. Meta Graph        . the slow path we're trying to avoid
    """
    cache_key = f"creatives:{brand}:{start}:{end}:{limit}"

    # Tier 1. in-memory
    entry = _creative_cache.get(cache_key)
    if entry and (time.time() - entry[0]) < CREATIVE_CACHE_TTL:
        return entry[1]

    # Tier 2. disk. Promote into memory so subsequent calls in this
    # process stay free even after memory cold-start.
    disk_payload = _disk_cache_get(cache_key)
    if disk_payload is not None:
        _creative_cache[cache_key] = (time.time(), disk_payload)
        return disk_payload

    # Tier 3. Meta Graph
    accounts = _get_meta_accounts()
    account_id = accounts.get(brand)
    if not account_id:
        raise HTTPException(status_code=404, detail=f"Brand '{brand}' not in META_ACCOUNTS")

    token = os.environ.get("META_ACCESS_TOKEN")
    if not token:
        raise HTTPException(status_code=500, detail="META_ACCESS_TOKEN not configured")

    insights = _fetch_ad_insights(account_id, start, end, token)
    # Sort by spend desc, drop zero-spend rows (they have no data worth showing)
    insights.sort(key=lambda r: float(r.get("spend", 0) or 0), reverse=True)
    insights = [r for r in insights if float(r.get("spend", 0) or 0) > 0][:limit]

    # Real funnel mix (user_segment_key) + inferred reactivation flag. Both are
    # best-effort enrichments fetched once per brand; failures degrade to empty
    # so the core creatives payload always ships.
    segment_by_ad = _fetch_ad_segment_spend(account_id, start, end, token)
    reactivation_adsets = _fetch_adset_reactivation(account_id, token)

    # Fetch creative metadata for each ad. If Meta's rate-limit cooldown
    # trips mid-loop, stop calling Meta and still return what we've built
    # so far. better than a blank page. The frontend will receive 503 on
    # the next explicit refresh.
    result = []
    rate_limit_tripped = False
    for row in insights:
        ad_id = row.get("ad_id")
        if not ad_id:
            continue
        if rate_limit_tripped:
            creative = {}
        else:
            try:
                creative = _fetch_ad_creative(ad_id, token, brand=brand, account_id=account_id)
            except RateLimitedError:
                rate_limit_tripped = True
                creative = {}
        # When Meta rate-limits us mid-loop, `creative` becomes `{}` and
        # the merged ad row loses status / thumbnail / copy. Fall back
        # to the warehouse with stale-OK semantics so the user sees
        # *something* useful instead of a blank card. Better to ship
        # week-old status than no status.
        if not creative:
            try:
                from creative_warehouse import get_cached as _wh_get
                stale = _wh_get(str(ad_id), stale_ok=True)
                if stale:
                    creative = stale
            except Exception:
                pass
        perf = _parse_perf(row)
        ad_name = row.get("ad_name")
        adset_name = row.get("adset_name")
        merged = {
            "ad_id": ad_id,
            "ad_name": ad_name,
            "adset_id": row.get("adset_id"),
            "adset_name": adset_name,
            "campaign_id": row.get("campaign_id"),
            "campaign_name": row.get("campaign_name"),
            # Exposed so the frontend can build an Ads Manager deep-link
            # without re-deriving the account mapping.
            "account_id": account_id,
            **creative,
            **perf,
        }
        merged["creative_hash"] = _creative_hash(creative)
        merged["is_video"] = bool(creative.get("video_id"))
        # Real per-creative funnel mix + inferred reactivation. Drives lane
        # placement in the Hypothetical Funnel Viewer (replaces the freq/CPMr
        # guess). Empty blend is a valid state (ad had no segmented delivery).
        merged["segment_spend"] = segment_by_ad.get(str(ad_id)) or _empty_segment_spend()
        merged["reactivation"] = str(row.get("adset_id")) in reactivation_adsets
        # Parse naming conventions on both ad + adset so the UI can light
        # up Funnel / Bidding / Persona-hint columns without a round trip.
        merged["name_convention"] = {
            "ad": parse_ad_name(ad_name),
            "adset": parse_adset_name(adset_name),
        }
        result.append(merged)

    # Batch-resolve image hashes → url_1080 / url_full for full-res previews
    # in the detail panel. One call per brand (per cache window), not per ad.
    image_hashes = sorted({r.get("image_hash") for r in result if r.get("image_hash")})
    if image_hashes:
        try:
            hash_urls = _fetch_image_hash_urls_bulk(account_id, list(image_hashes), token)
        except Exception as e:
            print(f"[ad-analysis] hash bulk resolve failed: {e}", flush=True)
            hash_urls = {}
        for r in result:
            h = r.get("image_hash")
            if not h:
                continue
            info = hash_urls.get(h)
            if not info:
                continue
            # Prefer the highest-quality URL Meta will return. url_full and
            # url_1080 aren't always populated for every account/token combo
            # (Meta only returns them to tokens with ads_read on the account).
            # `permalink_url` is a Facebook redirect that fetches the full
            # original asset and works across restricted setups, so we use
            # it as a final fallback before giving up.
            hd = (
                info.get("url_full")
                or info.get("url_1080")
                or info.get("permalink_url")
            )
            if hd:
                r["image_url_hd"] = hd

    payload = {"brand": brand, "start": start, "end": end, "ads": result}
    _creative_cache[cache_key] = (time.time(), payload)
    # Persist to disk too so a restart doesn't lose the warm cache.
    try:
        _disk_cache_put(cache_key, payload)
    except Exception as e:
        print(f"[prewarm] disk cache write failed for {cache_key}: {e}", flush=True)
    return payload


@router.get("/creatives")
def list_creatives(
    brand: str,
    start: str,
    end: str,
    limit: int = Query(100, ge=1, le=500),
):
    """List ad creatives with aggregate performance for the period.

    Pipeline:
      1) pull per-ad insights (level=ad) for the date range
      2) sort by spend desc, take top `limit`
      3) for each, fetch creative metadata in parallel-ish
    """
    return _list_creatives_impl(brand=brand, start=start, end=end, limit=limit)


# ---------------------------------------------------------------------------
# Aggregated dashboard endpoint. one request for {creatives, analyses,
# statuses}. The Ad Analysis tab used to fire three sequential calls on
# mount; this collapses that into a single round trip so the time-to-first-
# meaningful-paint drops by ~2 RTTs on cold loads.
# ---------------------------------------------------------------------------


def _analyses_for_hashes(creative_hashes: set[str], ad_ids: set[str]) -> tuple[dict, dict]:
    """Local version of /api/ads/analysis-bulk. pulled out so the
    dashboard aggregator doesn't pay the HTTP overhead. Returns
    ``(analyses_by_hash, ad_id_to_hash)``.
    """
    if not creative_hashes and not ad_ids:
        return {}, {}
    cache = _load_analysis_cache()
    out: dict[str, dict] = {}
    ad_id_to_hash: dict[str, str] = {}
    for key, entry in cache.items():
        if not isinstance(entry, dict):
            continue
        if entry.get("schema_version") != ANALYSIS_SCHEMA_VERSION:
            continue
        chash = key if "::" not in key else entry.get("creative_hash")
        if not chash:
            continue
        aid = entry.get("ad_id")

        matched = False
        if creative_hashes and chash in creative_hashes:
            matched = True
        if not matched and ad_ids and aid in ad_ids:
            matched = True
        if not matched:
            continue

        # Skip cached-error entries so the frontend re-triggers analysis
        # after stale Meta URLs expire. A successful analysis payload has
        # the FileAnalysis schema (rating, composition, etc.); error
        # entries only carry `error` / `raw` / `stop_reason` keys.
        analysis_dict = entry.get("analysis") or {}
        if isinstance(analysis_dict, dict) and analysis_dict.get("error"):
            continue

        payload = {
            "creative_hash": chash,
            "ad_id": aid,
            "analysis": entry.get("analysis"),
            "analyzed_at": entry.get("analyzed_at"),
            "focus_group": entry.get("focus_group"),
        }
        prior = out.get(chash)
        if prior is None or (entry.get("analyzed_at", 0) > (prior.get("analyzed_at") or 0)):
            out[chash] = payload
        if aid:
            ad_id_to_hash[aid] = chash
    return out, ad_id_to_hash


def _statuses_for_hashes(creative_hashes: set[str], ad_ids: set[str]) -> dict:
    """Local version of /api/planner/statuses-for-ads. Imported lazily so
    the ad_analysis module doesn't pull planner at load.
    """
    if not creative_hashes and not ad_ids:
        return {}
    try:
        from planner_endpoints import _load_creatives as _load_planner_creatives
    except Exception as e:
        print(f"[ad-analysis] planner import failed: {e}", flush=True)
        return {}
    out: dict[str, dict] = {}
    for c in _load_planner_creatives():
        linked_ad = str(c.get("linked_ad_id") or "")
        linked_hash = str(c.get("linked_creative_hash") or "")
        payload = {
            "status": c.get("status"),
            "ucid": c.get("ucid"),
            "linked_ad_id": linked_ad or None,
            "linked_creative_hash": linked_hash or None,
        }
        if linked_ad and linked_ad in ad_ids:
            out[linked_ad] = payload
        if linked_hash and linked_hash in creative_hashes:
            out[linked_hash] = payload
    return out


# ---------------------------------------------------------------------------
# Per-ad demographic breakdowns. feeds the demo-segmented funnel view
# ---------------------------------------------------------------------------
#
# Meta /insights with `breakdowns=age,gender` returns one row per
# (ad, age_bucket, gender) tuple. Same for `breakdowns=region` →
# (ad, state/province). We keep them as separate calls because Meta
# rejects requests that combine demo + region breakdowns (cell explosion).
# The frontend joins demo cells with the existing /creatives ad metadata
# by ad_id so we don't refetch creatives here. saves a round trip and
# keeps the cache simple.

_DEMO_CACHE_TTL = 3600  # 1h. demos don't drift fast within a day


def _purchase_count(actions: list[dict]) -> int:
    """Sum offsite_conversion.fb_pixel_purchase action counts."""
    if not isinstance(actions, list):
        return 0
    total = 0
    for a in actions:
        if not isinstance(a, dict):
            continue
        if a.get("action_type") == "offsite_conversion.fb_pixel_purchase":
            try:
                total += int(float(a.get("value") or 0))
            except (ValueError, TypeError):
                pass
    return total


def _purchase_value(action_values: list[dict]) -> float:
    if not isinstance(action_values, list):
        return 0.0
    total = 0.0
    for a in action_values:
        if not isinstance(a, dict):
            continue
        if a.get("action_type") == "offsite_conversion.fb_pixel_purchase":
            try:
                total += float(a.get("value") or 0)
            except (ValueError, TypeError):
                pass
    return total


@router.get("/creatives-by-demo")
def list_creatives_by_demo(
    brand: str = Query(...),
    start: str = Query(..., description="ISO YYYY-MM-DD"),
    end: str = Query(..., description="ISO YYYY-MM-DD"),
):
    """Return per-(ad, demo cell) performance rows for the funnel-by-demo view.

    Two parallel breakdowns are fetched and merged into one cell list:

      - ``age,gender`` → cells like ``{age: "25-34", gender: "female"}``
      - ``region``     → cells like ``{region: "California"}``

    Each cell carries spend, impressions, reach, frequency plus computed
    purchases / revenue / CPMR. The frontend ranks cells across both
    dimensions, picks the top 3 by spend × stat-sig, and renders a funnel
    per cohort.

    Cached on disk (per brand × date range) for 1h. Cache hit serves in
    <50ms; miss takes 5–30s depending on row count.
    """
    cache_dir = os.path.join(os.path.dirname(__file__), ".demo_breakdown_cache")
    os.makedirs(cache_dir, exist_ok=True)
    cache_key = hashlib.sha256(f"{brand}|{start}|{end}".encode()).hexdigest()[:24]
    cache_path = os.path.join(cache_dir, f"{cache_key}.json")
    if os.path.exists(cache_path):
        try:
            mtime = os.path.getmtime(cache_path)
            if time.time() - mtime < _DEMO_CACHE_TTL:
                with open(cache_path) as fp:
                    return json.load(fp)
        except Exception:
            pass

    accounts = _get_meta_accounts()
    account_id = accounts.get(brand)
    if not account_id:
        raise HTTPException(status_code=404, detail=f"Brand '{brand}' not in META_ACCOUNTS")
    token = os.environ.get("META_ACCESS_TOKEN")
    if not token:
        raise HTTPException(status_code=500, detail="META_ACCESS_TOKEN not configured")

    cells: list[dict] = []
    errors: list[str] = []

    # --- age × gender -------------------------------------------------------
    try:
        age_gender_rows = _fetch_ad_insights_with_breakdowns(
            account_id, start, end, token, "age,gender",
        )
        for row in age_gender_rows:
            ad_id = row.get("ad_id")
            if not ad_id:
                continue
            spend = float(row.get("spend") or 0)
            if spend <= 0:
                continue
            reach = float(row.get("reach") or 0)
            cells.append({
                "ad_id": ad_id,
                "dim": "age_gender",
                "age": row.get("age") or "Unknown",
                "gender": row.get("gender") or "Unknown",
                "region": None,
                "spend": spend,
                "impressions": int(float(row.get("impressions") or 0)),
                "reach": int(reach),
                "frequency": float(row.get("frequency") or 0),
                "purchases": _purchase_count(row.get("actions") or []),
                "revenue": _purchase_value(row.get("action_values") or []),
                "cpmr": (spend / reach * 1000) if reach > 0 else 0.0,
            })
    except HTTPException as e:
        errors.append(f"age_gender: {e.detail}")
    except Exception as e:  # noqa: BLE001
        errors.append(f"age_gender: {type(e).__name__}: {e}")

    # --- region -------------------------------------------------------------
    try:
        region_rows = _fetch_ad_insights_with_breakdowns(
            account_id, start, end, token, "region",
        )
        for row in region_rows:
            ad_id = row.get("ad_id")
            if not ad_id:
                continue
            spend = float(row.get("spend") or 0)
            if spend <= 0:
                continue
            reach = float(row.get("reach") or 0)
            cells.append({
                "ad_id": ad_id,
                "dim": "region",
                "age": None,
                "gender": None,
                "region": row.get("region") or "Unknown",
                "spend": spend,
                "impressions": int(float(row.get("impressions") or 0)),
                "reach": int(reach),
                "frequency": float(row.get("frequency") or 0),
                "purchases": _purchase_count(row.get("actions") or []),
                "revenue": _purchase_value(row.get("action_values") or []),
                "cpmr": (spend / reach * 1000) if reach > 0 else 0.0,
            })
    except HTTPException as e:
        errors.append(f"region: {e.detail}")
    except Exception as e:  # noqa: BLE001
        errors.append(f"region: {type(e).__name__}: {e}")

    payload = {
        "brand": brand,
        "start": start,
        "end": end,
        "cells": cells,
        "errors": errors,  # surfaced so the frontend can warn the user
    }
    try:
        tmp = cache_path + ".tmp"
        with open(tmp, "w") as fp:
            json.dump(payload, fp)
        os.replace(tmp, cache_path)
    except Exception as e:
        print(f"[creatives-by-demo] cache write failed: {e}", flush=True)

    return payload


@router.get("/quick-pull")
def quick_pull(
    brand: str = Query(...),
    start: str = Query(..., description="ISO YYYY-MM-DD"),
    end: str = Query(..., description="ISO YYYY-MM-DD"),
    include_google: bool = Query(True),
) -> dict:
    """Direct LLM-free brand-perf pull. Takes brand + date range, runs
    ``ads_pull.py --range start..end`` (Meta + Google live API), returns
    parsed metrics as JSON. No tool selection, no agent deliberation -
    just numbers in ~2s. Zero token cost.
    """
    import subprocess
    import sys as _sys
    from pathlib import Path as _Path
    import re as _re

    script = _Path.home() / ".claude" / "skills" / "ad-connector-pull" / "ads_pull.py"
    if not script.exists():
        raise HTTPException(500, f"ads_pull.py missing at {script}")

    args = [_sys.executable, str(script), brand, "--range", f"{start}..{end}"]
    if include_google:
        args.append("--include-google")
    try:
        out = subprocess.check_output(
            args,
            cwd=str(_Path.home() / "ad-connector"),
            stderr=subprocess.STDOUT,
            text=True,
            timeout=60,
        )
    except subprocess.CalledProcessError as e:
        raise HTTPException(502, f"ads_pull failed: {e.output[:400]}")
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "ads_pull timed out (Meta rate limit?)")

    # Parse the canonical brand row. The script formats with right-aligned
    # money columns ("$  213.61") so we can't rely on whitespace splitting.
    # Pull values by regex pattern instead.
    metrics: dict[str, object] = {}
    for line in out.splitlines():
        s = line.strip()
        if not s or s.startswith("Period") or s.startswith("brand ") or s.startswith("---"):
            continue
        if not brand.split()[0].lower() in s.lower():
            continue
        # Money pattern: $1,234 or $1,234.56 or $123 or $  213.61 (with internal spaces).
        # The first 3 monetary tokens are spend / revenue / [aov hits later as well]
        money_tokens = _re.findall(r"\$\s*[\d,]+(?:\.\d+)?", s)
        roas_match = _re.search(r"(\d+(?:\.\d+)?)x\b", s)
        # Find the integer 'orders' column. it sits between the roas value
        # and the trailing AOV ('$' prefix). Look for an integer that's NOT
        # adjacent to '$'.
        orders_match = _re.search(r"\bx\s+(\d+)\s+\$", s)

        def _to_money(tok: str) -> float | None:
            try:
                return float(_re.sub(r"[\$,\s]", "", tok))
            except Exception:
                return None

        try:
            metrics = {
                "brand": s.split()[0] if " " in s else brand,
                "spend": _to_money(money_tokens[0]) if len(money_tokens) > 0 else None,
                "revenue": _to_money(money_tokens[1]) if len(money_tokens) > 1 else None,
                "roas": float(roas_match.group(1)) if roas_match else None,
                "orders": int(orders_match.group(1)) if orders_match else None,
                "aov": _to_money(money_tokens[2]) if len(money_tokens) > 2 else None,
            }
        except Exception:
            pass
        break

    return {
        "brand": brand,
        "start": start,
        "end": end,
        "include_google": include_google,
        "metrics": metrics,
        "raw_output": out,
    }


@router.get("/dashboard")
def ads_dashboard(
    brand: str,
    start: str,
    end: str,
    compare_start: Optional[str] = None,
    compare_end: Optional[str] = None,
    limit: int = Query(100, ge=1, le=500),
):
    """Combined response for the Ad Analysis tab's initial load.

    Returns::

        {
          "brand": ..., "start": ..., "end": ...,
          "ads":      [ ... list of creatives ... ],
          "analyses": { <creative_hash>: { analysis, ad_id, ... } },
          "statuses": { <ad_id_or_hash>: { status, ucid, ... } },
          "ad_id_to_hash": { <ad_id>: <creative_hash> }
        }

    Creatives reuse the tiered cache (memory → disk → Meta). Analyses and
    statuses are computed from local stores. effectively free once the
    creatives payload is in hand. Eliminates two round-trips vs. hitting
    ``/creatives`` + ``/analysis-bulk`` + ``/planner/statuses-for-ads``
    sequentially.
    """
    payload = _list_creatives_impl(brand=brand, start=start, end=end, limit=limit)
    ads = payload.get("ads") or []

    # Backfill missing campaign_name / adset_name on cache hits too -
    # without this, group-by-Campaign and group-by-AdSet are mostly
    # "(unanalyzed)" because Meta's /insights returns null names for
    # paused/archived parents on a sizeable fraction of ads.
    try:
        token = os.environ.get("META_ACCESS_TOKEN")
        if token:
            _backfill_campaign_adset_names(ads, token)
    except Exception as e:
        print(f"[ads-dashboard] name backfill skipped: {e}", flush=True)

    # Stamp content-hash on ads whose post-thumb is already disk-cached.
    # Lets the frontend dedupe visually-identical creatives that share
    # neither image_hash nor video_id (the case where copy-based dedupe
    # over-collapsed earlier).
    try:
        _attach_image_content_sha(ads)
    except Exception as e:
        print(f"[ads-dashboard] image_content_sha attach skipped: {e}", flush=True)

    # Compare-period merge: when the client supplies a compare window, pull
    # the same account's insights for that window and stamp prev-period
    # perf fields onto each ad (keyed by ad_id). Ads that didn't exist in
    # the compare window keep their current-period values only. The
    # detail panel already knows how to compute deltas from `prev_*` keys.
    if compare_start and compare_end and ads:
        try:
            prev_payload = _list_creatives_impl(
                brand=brand, start=compare_start, end=compare_end, limit=500
            )
            prev_ads = prev_payload.get("ads") or []
            prev_by_id = {str(a.get("ad_id")): a for a in prev_ads if a.get("ad_id")}
            # Keys we surface as prev-period comparisons. These mirror what
            # `_parse_perf` returns. spend, revenue, derived rate metrics,
            # reach/frequency, purchases, etc.
            PERF_KEYS = (
                "spend", "revenue", "purchases", "impressions", "clicks",
                "roas", "cpm", "cpp", "cpc", "ctr", "cvr", "aov",
                "reach", "frequency", "link_clicks", "ctr_link",
                "hook_rate", "hold_rate", "atc_rate", "video_avg_watch_time",
            )
            for a in ads:
                prev = prev_by_id.get(str(a.get("ad_id")))
                if not prev:
                    continue
                for k in PERF_KEYS:
                    if k in prev and prev[k] is not None:
                        a[f"prev_{k}"] = prev[k]
        except Exception as e:
            print(f"[ads-dashboard] compare-period fetch failed: {e}", flush=True)

    hashes = {str(a.get("creative_hash")) for a in ads if a.get("creative_hash")}
    ids = {str(a.get("ad_id")) for a in ads if a.get("ad_id")}
    analyses, ad_id_to_hash = _analyses_for_hashes(hashes, ids)
    statuses = _statuses_for_hashes(hashes, ids)

    # Derive `sentiment_score` per ad from the AI analysis label so the
    # frontend can treat sentiment as a numeric metric (sortable, filterable,
    # group-by-able). Maps the qualitative label Claude returns to a
    # roughly VADER-aligned [-1, +1] scale.
    #
    # Three rules:
    #   1) No label at all → return None (frontend shows "-", not 0).
    #      Distinguishes "ad hasn't been analyzed" from "neutral sentiment".
    #   2) Label exists but doesn't match any keyword → return None so the
    #      user can see we couldn't classify it (better than silently
    #      reporting 0 and pretending we did).
    #   3) Compound labels ("Inspirational/Aspirational", "Bold and confident")
    #      are split on common separators and any keyword match wins.
    POSITIVE_WEIGHTS = {
        "positive": 0.7, "inspirational": 0.7, "inspiring": 0.7,
        "aspirational": 0.6, "aspiring": 0.6,
        "joyful": 0.8, "joy": 0.8, "happy": 0.7, "excited": 0.7, "exciting": 0.7,
        "uplifting": 0.7, "warm": 0.5, "celebratory": 0.7, "celebrating": 0.7,
        "confident": 0.5, "playful": 0.6, "humorous": 0.6, "funny": 0.6,
        "optimistic": 0.7, "hopeful": 0.6, "empowering": 0.7, "empowered": 0.7,
        "bold": 0.5, "confident": 0.5, "energetic": 0.6, "vibrant": 0.6,
        "loving": 0.7, "love": 0.6, "grateful": 0.7, "wholesome": 0.6,
        "delightful": 0.7, "enthusiastic": 0.7, "fun": 0.6, "cheerful": 0.7,
        "luxurious": 0.4, "elegant": 0.4, "sophisticated": 0.4,
        "curious": 0.3, "intriguing": 0.4, "fascinating": 0.5,
        "calm": 0.2, "relaxing": 0.3, "peaceful": 0.4, "serene": 0.4,
        "trustworthy": 0.5, "credible": 0.4, "authoritative": 0.3,
        "satisfying": 0.6, "rewarding": 0.6,
    }
    NEUTRAL_WEIGHTS = {
        "neutral": 0.0, "informational": 0.0, "informative": 0.0,
        "instructive": 0.0, "explanatory": 0.0, "factual": 0.0,
        "reflective": 0.0, "matter-of-fact": 0.0, "objective": 0.0,
        "educational": 0.0, "professional": 0.0, "clinical": 0.0,
        "descriptive": 0.0, "straightforward": 0.0,
    }
    NEGATIVE_WEIGHTS = {
        "negative": -0.7, "fearful": -0.6, "fear": -0.6,
        "anxious": -0.5, "anxiety": -0.5, "worried": -0.4,
        "urgent": -0.3, "urgency": -0.3, "fomo": -0.4,
        "alarming": -0.7, "alarm": -0.7,
        "frustrated": -0.5, "frustration": -0.5, "frustrating": -0.5,
        "angry": -0.7, "anger": -0.7, "sad": -0.6, "sadness": -0.6,
        "concerning": -0.4, "stressful": -0.5, "stressed": -0.5,
        "desperate": -0.6, "tired": -0.3, "exhausted": -0.4,
        "skeptical": -0.3, "doubtful": -0.3, "regretful": -0.4,
        "scary": -0.6, "intimidating": -0.4, "harsh": -0.4,
    }

    import re as _re_sent
    def _sentiment_to_score(label: Optional[str]) -> Optional[float]:
        if not label or not str(label).strip():
            return None
        # Split compound labels on common separators (slash, comma, ampersand,
        # "and"/"or", em/en dash). Take the first matching keyword's score so
        # "Inspirational/Aspirational" reads as the dominant tone.
        parts = _re_sent.split(r"[\/,&]| and | or |-|–|-", str(label).lower())
        for part in parts:
            s = part.strip()
            if not s:
                continue
            for word, score in POSITIVE_WEIGHTS.items():
                if word in s:
                    return score
            for word, score in NEUTRAL_WEIGHTS.items():
                if word in s:
                    return score
            for word, score in NEGATIVE_WEIGHTS.items():
                if word in s:
                    return score
        return None  # label exists but didn't match anything we know

    # VADER fallback. when an ad has no AI sentiment label cached, look up
    # (or compute once and persist) the VADER compound score on its
    # title+body. The score is keyed by creative_hash so it's reused across
    # brands and across requests; cold compute happens at most once per
    # creative for the lifetime of the cache file.
    global _creative_sentiment_dirty
    sent_store = _load_creative_sentiment()

    for a in ads:
        chash = str(a.get("creative_hash") or "")
        entry = analyses.get(chash) if chash else None
        analysis = (entry or {}).get("analysis") or {}
        label = analysis.get("sentiment") if isinstance(analysis, dict) else None
        score = _sentiment_to_score(label)
        if score is None:
            key = chash or str(a.get("ad_id") or "")
            cached = sent_store.get(key) if key else None
            if cached and cached.get("score") is not None:
                score = float(cached["score"])
            elif key:
                # Compute once, persist forever. Title+body capped at 600
                # chars so VADER doesn't choke on whole-page captions.
                text = " ".join(
                    str(t) for t in (a.get("title"), a.get("body")) if t
                )[:600]
                computed = _vader_score_text(text)
                if computed is not None:
                    score = computed
                    sent_store[key] = {
                        "score": computed,
                        "label": None,
                        "brand": brand,
                        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    }
                    _creative_sentiment_dirty = True
        a["sentiment_label"] = label
        a["sentiment_score"] = score

    if _creative_sentiment_dirty:
        _save_creative_sentiment()

    # Fire-and-forget thumbnail pre-warm: fetch every Meta CDN URL we know
    # about into the disk cache in parallel, so by the time the browser
    # asks via /api/ads/img the bytes are already local. Browsers cap at
    # ~6 concurrent requests per origin, which would serialise 120 cards
    # behind the proxy for several seconds on cold cache; this kicks the
    # work off in 16 parallel workers and returns immediately.
    _spawn_thumbnail_prewarm(ads)

    return {
        "brand": brand,
        "start": start,
        "end": end,
        "compare_start": compare_start,
        "compare_end": compare_end,
        "ads": ads,
        "analyses": analyses,
        "ad_id_to_hash": ad_id_to_hash,
        "statuses": statuses,
    }


# ---------------------------------------------------------------------------
# Image proxy. caches Meta CDN images on disk so repeated loads don't pay
# the 200-800ms scontent round-trip. Frontend rewrites its <img src> to
# /api/ads/img?u=<url>, which hashes the URL and serves from
# image_cache/<hash>.<ext> (or fetches on first hit).
# ---------------------------------------------------------------------------

_IMG_CACHE_HEADERS = {
    # 7-day browser + CDN cache. Images are content-addressed by upstream
    # URL, so stale serves aren't a concern. if Meta rotates the URL the
    # frontend simply asks for a different hash.
    "Cache-Control": "public, max-age=604800, immutable",
}

# 1x1 transparent PNG. served in place of a 500 when the upstream fetch
# fails (expired URL, 403, DNS, timeout…). The frontend's onError fallback
# covers the UI side but we prefer a 200+placeholder so the <img> tag
# doesn't flash broken during redraws.
_PIXEL_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\x00"
    b"\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


def _ext_for_content_type(ct: Optional[str]) -> str:
    """Best-effort file extension from a Content-Type header."""
    if not ct:
        return "bin"
    ct = ct.split(";", 1)[0].strip().lower()
    return {
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/gif": "gif",
        "image/avif": "avif",
    }.get(ct, "bin")


def _content_type_for_ext(ext: str) -> str:
    return {
        "jpg": "image/jpeg",
        "png": "image/png",
        "webp": "image/webp",
        "gif": "image/gif",
        "avif": "image/avif",
    }.get(ext, "application/octet-stream")


_PLACEHOLDER_BYTE_THRESHOLD = 200  # bytes. anything smaller is a 1×1
                                    # placeholder PNG or similar dud.
_MIN_USEFUL_DIMENSION = 200         # pixels. Meta serves p64x64 / p32x32 /
                                    # p16x16 baked-into-URL transforms when
                                    # the only available creative field is
                                    # `thumbnail_url`. These render as
                                    # blurry 64-pixel squares on cards. A
                                    # real product photo is ≥256 in either
                                    # dim. anything smaller is a thumbnail
                                    # we should reject so the next
                                    # candidate (or the preview-extract
                                    # fallback) gets a chance.

# Hash blacklist. exact SHA256s of generic FB / IG placeholders that the
# CDN serves when the public post URL hits a logged-out or "post not
# available" wall. Each is the same 189×97 social-icons collage webp,
# meaning 16 unrelated ads share one cached file and render the same
# wrong image. Detected post-fetch and treated as a useful-bytes failure
# so the Thumbnail chain advances to the next source.
_PLACEHOLDER_HASH_BLACKLIST: set[str] = {
    # FB social-icons collage served by lookaside.fbsbx.com / scontent
    # when the post URL redirects to a generic landing page.
    "46c9bc9ff99575bb7e687683ee13d1dcbb874638089cab44aeaa7b5836b221b8",
    # Newer FB social-icons mosaic. 1200×628 WEBP, the user reported it
    # was rendering on ~30 cards on 2026-05-05.
    "b909a4dac6621d10f86929ee6014d3ce90168e5d8f3ee432ecb640939740c1bd",
}


# Auto-discover additional placeholder hashes by scanning the disk cache
# for content collisions. A single content_sha shared by ≥ COLLISION
# THRESHOLD distinct cache-seed digests is overwhelmingly likely a
# placeholder (Meta serving a generic "post not available" image for
# unrelated story_ids). The threshold is set conservatively so we don't
# accidentally blacklist a real creative that happens to be reused across
# many ads. empirically those top out around 13 collisions per brand.
_PLACEHOLDER_COLLISION_THRESHOLD = 18


def _bootstrap_placeholder_blacklist() -> None:
    """Populate ``_PLACEHOLDER_HASH_BLACKLIST`` with high-collision
    content hashes from the disk cache, and delete those cache files so
    the next request re-resolves via the (working) preview-extract path.

    Called once at module import. Cheap. ~1700 small files = a few
    hundred ms of SHA256 hashing.
    """
    if not os.path.isdir(IMAGE_CACHE_DIR):
        return
    from collections import defaultdict
    content_to_paths: dict[str, list[str]] = defaultdict(list)
    for name in os.listdir(IMAGE_CACHE_DIR):
        path = os.path.join(IMAGE_CACHE_DIR, name)
        if not os.path.isfile(path):
            continue
        try:
            with open(path, "rb") as fp:
                h = hashlib.sha256(fp.read()).hexdigest()
        except OSError:
            continue
        content_to_paths[h].append(path)
    discovered = 0
    purged = 0
    for sha, paths in content_to_paths.items():
        if len(paths) < _PLACEHOLDER_COLLISION_THRESHOLD:
            continue
        if sha in _PLACEHOLDER_HASH_BLACKLIST:
            # Already known. still purge any leftover cache files.
            for p in paths:
                try: os.remove(p); purged += 1
                except OSError: pass
            continue
        _PLACEHOLDER_HASH_BLACKLIST.add(sha)
        discovered += 1
        for p in paths:
            try: os.remove(p); purged += 1
            except OSError: pass
    if discovered or purged:
        print(
            f"[placeholder-bootstrap] discovered {discovered} hashes, "
            f"purged {purged} cache files (threshold={_PLACEHOLDER_COLLISION_THRESHOLD})",
            flush=True,
        )


_bootstrap_placeholder_blacklist()


# In-memory cache: cache-file path → SHA256 of the file's contents. The
# disk cache key is sha256(cache_seed). NOT a content hash. so to dedupe
# ads by visual identity we have to hash the bytes themselves. Keep this
# in-process so a fresh dashboard request doesn't re-read 100s of files.
_CONTENT_SHA_CACHE: dict[str, tuple[float, str]] = {}


def _content_sha_for_path(path: str) -> Optional[str]:
    """Return the SHA256 of the file's CONTENTS (not of its name).

    Memoized by (path, mtime) so we hash each cached image at most once
    per process lifetime per write.
    """
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return None
    cached = _CONTENT_SHA_CACHE.get(path)
    if cached and cached[0] == mtime:
        return cached[1]
    try:
        h = hashlib.sha256()
        with open(path, "rb") as fp:
            for chunk in iter(lambda: fp.read(65536), b""):
                h.update(chunk)
        sha = h.hexdigest()
    except OSError:
        return None
    _CONTENT_SHA_CACHE[path] = (mtime, sha)
    return sha


def _attach_image_content_sha(ads: list[dict]) -> None:
    """Stamp ``image_content_sha`` on each ad by hashing the bytes of
    whichever thumbnail cache has resolved for it.

    Lookup order: post-thumb (story_id og:image scrape) → img-by-ad
    (Graph creative resolve). The first cache hit wins; the resulting
    SHA256 is the ad's visual-identity key, used by the frontend to
    dedupe creatives that share an asset across ad_ids.

    Skipped ads (neither cache populated yet) keep ``image_content_sha``
    unset and a background prefetch warms post-thumb so subsequent
    dashboard loads see them deduped.
    """
    missing_story: list[str] = []
    missing_ad: list[tuple[str, str]] = []  # (ad_id, brand)
    for ad in ads:
        if ad.get("image_content_sha"):
            continue
        sha: Optional[str] = None
        sid = ad.get("effective_object_story_id")
        if sid:
            digest = hashlib.sha256(f"post-thumb:{sid}".encode("utf-8")).hexdigest()
            hit = _image_cache_lookup(digest)
            if hit:
                sha = _content_sha_for_path(hit[0])
        if not sha:
            ad_id = ad.get("ad_id")
            if ad_id:
                # img-by-ad uses kind=auto in the resolution chain. check
                # that variant too.
                for kind in ("auto", "image", "thumbnail"):
                    digest = hashlib.sha256(
                        f"img-by-ad:{ad_id}:{kind}".encode("utf-8")
                    ).hexdigest()
                    hit = _image_cache_lookup(digest)
                    if hit:
                        sha = _content_sha_for_path(hit[0])
                        if sha:
                            break
        if sha:
            ad["image_content_sha"] = sha
        else:
            if sid:
                missing_story.append(sid)
            ad_id = ad.get("ad_id")
            brand_v = ad.get("_brand") or ""
            if ad_id and brand_v:
                missing_ad.append((str(ad_id), str(brand_v)))
    # Kick off background warm-up for the misses. Subsequent dashboard
    # requests will see those thumbs in the cache and dedupe correctly.
    # Capped to avoid hammering Meta when a brand has 500+ ads.
    if missing_story:
        _start_post_thumb_prefetch(missing_story[:120])


_PREFETCH_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="post-thumb-prefetch")
_PREFETCH_INFLIGHT: set[str] = set()
_PREFETCH_INFLIGHT_LOCK = threading.Lock()


def _start_post_thumb_prefetch(story_ids: list[str]) -> None:
    """Fire off post-thumb resolution for story_ids whose thumbs aren't
    yet on disk. Idempotent. duplicate story_ids in flight are ignored.
    """
    import httpx
    fresh: list[str] = []
    with _PREFETCH_INFLIGHT_LOCK:
        for sid in story_ids:
            if sid in _PREFETCH_INFLIGHT:
                continue
            _PREFETCH_INFLIGHT.add(sid)
            fresh.append(sid)
    if not fresh:
        return

    def _warm(sid: str) -> None:
        try:
            # Bounded timeout so a single dead URL can't tie up a worker
            # for 20s and starve other prefetches.
            with httpx.Client(timeout=10.0) as client:
                client.get(
                    "http://127.0.0.1:3001/api/ads/post-thumb",
                    params={"story_id": sid},
                )
        except Exception:
            pass
        finally:
            with _PREFETCH_INFLIGHT_LOCK:
                _PREFETCH_INFLIGHT.discard(sid)

    for sid in fresh:
        _PREFETCH_POOL.submit(_warm, sid)


# ---------------------------------------------------------------------------
# Runtime collision detection for post-thumb. When the public post URL
# doesn't have its own og:image (archived posts, dark posts, DPA, etc.)
# Facebook serves the brand's PAGE-level social card. The same image
# then ends up cached for many distinct story_ids. visually wrong: e.g.
# every Kinn ad without a specific creative shows Kinn's hero gold-ring
# photo. Detect this dynamically: when ≥ COLLISION_THRESHOLD distinct
# story_ids resolve to the same content sha256, mark the hash as a
# fallback and 502 future requests so the Thumbnail chain advances.
# ---------------------------------------------------------------------------

_POST_THUMB_COLLISION_PATH = os.path.join(
    os.path.dirname(__file__), "post_thumb_collisions.json"
)
_POST_THUMB_COLLISION_LOCK = threading.Lock()
_POST_THUMB_COLLISION_THRESHOLD = 4  # 4+ distinct story_ids → fallback
# {content_sha256: [story_id, ...]}. capped per-hash so we don't grow
# unbounded for legitimately popular shared creatives.
_POST_THUMB_SEEN: dict[str, list[str]] = {}
_POST_THUMB_DYNAMIC_BLACKLIST: set[str] = set()
_POST_THUMB_STATE_LOADED = False


def _load_post_thumb_state() -> None:
    """Hydrate the collision tracker from disk so blacklist survives restarts."""
    global _POST_THUMB_SEEN, _POST_THUMB_DYNAMIC_BLACKLIST, _POST_THUMB_STATE_LOADED
    if _POST_THUMB_STATE_LOADED:
        return
    try:
        if os.path.exists(_POST_THUMB_COLLISION_PATH):
            with open(_POST_THUMB_COLLISION_PATH) as fp:
                data = json.load(fp)
            seen = data.get("seen", {})
            if isinstance(seen, dict):
                _POST_THUMB_SEEN = {k: list(v)[:50] for k, v in seen.items() if isinstance(v, list)}
            bl = data.get("blacklist", [])
            if isinstance(bl, list):
                _POST_THUMB_DYNAMIC_BLACKLIST = set(bl)
    except Exception as e:
        print(f"[post-thumb] state load failed: {e}", flush=True)
    _POST_THUMB_STATE_LOADED = True


def _save_post_thumb_state() -> None:
    try:
        tmp = _POST_THUMB_COLLISION_PATH + ".tmp"
        with open(tmp, "w") as fp:
            json.dump({
                "seen": {k: v[:50] for k, v in _POST_THUMB_SEEN.items()},
                "blacklist": sorted(_POST_THUMB_DYNAMIC_BLACKLIST),
            }, fp)
        os.replace(tmp, _POST_THUMB_COLLISION_PATH)
    except Exception as e:
        print(f"[post-thumb] state save failed: {e}", flush=True)


def _record_post_thumb_observation(content_sha: str, story_id: str) -> bool:
    """Record (content_sha, story_id) and return True iff the content is now
    blacklisted. Caller should treat True as a fallback hit and 502.
    """
    if not content_sha or not story_id:
        return False
    _load_post_thumb_state()
    with _POST_THUMB_COLLISION_LOCK:
        if content_sha in _POST_THUMB_DYNAMIC_BLACKLIST:
            return True
        bucket = _POST_THUMB_SEEN.setdefault(content_sha, [])
        if story_id not in bucket:
            bucket.append(story_id)
            if len(bucket) > 50:
                bucket[:] = bucket[-50:]
        crossed = len(bucket) >= _POST_THUMB_COLLISION_THRESHOLD
        if crossed:
            _POST_THUMB_DYNAMIC_BLACKLIST.add(content_sha)
        # Persist on every change. file is small (a few KB).
        _save_post_thumb_state()
        return crossed


def _is_post_thumb_fallback(content_sha: str) -> bool:
    if not content_sha:
        return False
    _load_post_thumb_state()
    return content_sha in _POST_THUMB_DYNAMIC_BLACKLIST


def _is_useful_image_bytes(content: bytes) -> bool:
    """True iff the bytes decode to an image with min(W, H) ≥ threshold.

    Used as a post-fetch gate before caching: rejects p64x64 thumbnails
    that pass the byte-size check but render as garbage on the card grid.
    Also rejects known generic-placeholder bytes via SHA256 blacklist.
    """
    if not content or len(content) < _PLACEHOLDER_BYTE_THRESHOLD:
        return False
    if hashlib.sha256(content).hexdigest() in _PLACEHOLDER_HASH_BLACKLIST:
        return False
    try:
        from PIL import Image  # noqa: WPS433. local import to keep cold start fast
        import io
        with Image.open(io.BytesIO(content)) as im:
            w, h = im.size
        return min(w, h) >= _MIN_USEFUL_DIMENSION
    except Exception:
        # If we can't decode, assume useful. better to serve real bytes
        # than to drop something a browser might still render.
        return True


# Module-level pool so successive dashboard requests share workers.
# 16 parallel fetches is enough to saturate residential bandwidth without
# triggering Meta's per-IP throttle in practice.
import concurrent.futures as _futures
_PREWARM_POOL = _futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="thumb-prewarm")


def _prewarm_one_url(url: str) -> None:
    """Fetch one Meta CDN URL into the disk cache if not already cached.

    Mirrors the cache-write path in ``proxy_image`` but without the HTTP
    response wrapping. Silently no-ops on every failure mode. this is
    pure best-effort warmup.
    """
    if not url or not isinstance(url, str) or not url.startswith("http"):
        return
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
    if _image_cache_lookup(digest) is not None:
        return
    try:
        import httpx
        with httpx.Client(timeout=15.0, follow_redirects=True, headers=_BROWSER_HEADERS) as client:
            resp = client.get(url)
        if resp.status_code != 200 or not resp.content:
            return
        if len(resp.content) < _PLACEHOLDER_BYTE_THRESHOLD:
            return
        ct = resp.headers.get("content-type", "")
        if not ct.startswith("image/"):
            return
        ext = _ext_for_content_type(ct)
        path = os.path.join(IMAGE_CACHE_DIR, f"{digest}.{ext}")
        tmp = path + ".tmp"
        with open(tmp, "wb") as fp:
            fp.write(resp.content)
        os.replace(tmp, path)
    except Exception:
        pass  # best-effort; the regular /img endpoint will retry on demand


# Module-level cache for resolved campaign/adset names so we don't hit
# Meta with the same ids on every dashboard request. Keyed by node id -
# campaigns and adsets share the namespace (Meta ids are unique).
_NAME_RESOLVE_CACHE: dict[str, str] = {}


def _backfill_campaign_adset_names(rows: list[dict], token: str) -> None:
    """Mutate `rows` in place to populate missing campaign_name and
    adset_name. Two-phase resolve because Meta's /insights endpoint can
    return rows with EITHER no name (but an id we can look up) OR no id
    at all (paused/archived parents).

    Phase 1: for ads missing both campaign_id and campaign_name (or
    adset_id and adset_name), batch-fetch the ad node directly to get
    its parent ids and names. `/?ids=ad1,ad2&fields=campaign{id,name},adset{id,name}`
    works regardless of campaign status.

    Phase 2: for any rows still missing a name but holding an id, resolve
    via the generic `/?ids=...` lookup. Cached module-wide so warm
    dashboard hits are free.
    """
    if not rows or not token:
        return
    import requests as req

    # ---- Phase 1: resolve via ad nodes when parent ids are missing ----
    ad_ids_needing_parents: list[str] = []
    for r in rows:
        ad_id = r.get("ad_id")
        if not ad_id:
            continue
        needs_camp = not r.get("campaign_id") and not r.get("campaign_name")
        needs_set = not r.get("adset_id") and not r.get("adset_name")
        if needs_camp or needs_set:
            # Skip ads we've already resolved by ad_id this session.
            if str(ad_id) not in _NAME_RESOLVE_CACHE:
                ad_ids_needing_parents.append(str(ad_id))

    BATCH = 50
    for i in range(0, len(ad_ids_needing_parents), BATCH):
        batch = ad_ids_needing_parents[i:i + BATCH]
        try:
            resp = req.get(
                f"https://graph.facebook.com/{META_API_VERSION}/",
                params={
                    "access_token": token,
                    "ids": ",".join(batch),
                    "fields": "campaign{id,name},adset{id,name}",
                },
                timeout=30,
            )
            if resp.status_code != 200:
                continue
            payload = resp.json() or {}
            for ad_id, info in payload.items():
                if not isinstance(info, dict):
                    continue
                # Mark this ad_id as visited so we don't re-fetch.
                _NAME_RESOLVE_CACHE[str(ad_id)] = ""  # sentinel
                camp = info.get("campaign") or {}
                aset = info.get("adset") or {}
                if camp.get("id"):
                    _NAME_RESOLVE_CACHE[str(camp["id"])] = camp.get("name") or ""
                if aset.get("id"):
                    _NAME_RESOLVE_CACHE[str(aset["id"])] = aset.get("name") or ""
                # Stamp directly back onto matching rows. We re-walk so
                # we can also fill the parent ids when they were missing.
                for r in rows:
                    if str(r.get("ad_id")) != str(ad_id):
                        continue
                    if camp.get("id"):
                        r["campaign_id"] = camp["id"]
                        if camp.get("name"):
                            r["campaign_name"] = camp["name"]
                    if aset.get("id"):
                        r["adset_id"] = aset["id"]
                        if aset.get("name"):
                            r["adset_name"] = aset["name"]
        except Exception:
            continue

    # ---- Phase 2: resolve any remaining ids → names ----
    needed_ids: set[str] = set()
    for r in rows:
        if not r.get("campaign_name") and r.get("campaign_id"):
            cid = str(r["campaign_id"])
            if cid not in _NAME_RESOLVE_CACHE:
                needed_ids.add(cid)
        if not r.get("adset_name") and r.get("adset_id"):
            aid = str(r["adset_id"])
            if aid not in _NAME_RESOLVE_CACHE:
                needed_ids.add(aid)

    ids_list = sorted(needed_ids)
    for i in range(0, len(ids_list), BATCH):
        batch = ids_list[i:i + BATCH]
        try:
            resp = req.get(
                f"https://graph.facebook.com/{META_API_VERSION}/",
                params={
                    "access_token": token,
                    "ids": ",".join(batch),
                    "fields": "name",
                },
                timeout=30,
            )
            if resp.status_code != 200:
                continue
            payload = resp.json() or {}
            for nid, info in payload.items():
                name = (info or {}).get("name")
                if name:
                    _NAME_RESOLVE_CACHE[str(nid)] = str(name)
        except Exception:
            continue

    # Apply cached names back to the rows.
    for r in rows:
        if not r.get("campaign_name") and r.get("campaign_id"):
            n = _NAME_RESOLVE_CACHE.get(str(r["campaign_id"]))
            if n:
                r["campaign_name"] = n
        if not r.get("adset_name") and r.get("adset_id"):
            n = _NAME_RESOLVE_CACHE.get(str(r["adset_id"]))
            if n:
                r["adset_name"] = n


def _spawn_thumbnail_prewarm(ads: list[dict]) -> None:
    """Submit pre-warm tasks for every ad's preferred image URL.

    Picks the same URL Thumbnail tries first (image_url_hd → image_url →
    thumbnail_url) so one cache hit covers the dominant render path.
    """
    seen: set[str] = set()
    for a in ads or []:
        url = a.get("image_url_hd") or a.get("image_url") or a.get("thumbnail_url")
        if not url or not isinstance(url, str) or not url.startswith("http"):
            continue
        if url in seen:
            continue
        seen.add(url)
        try:
            _PREWARM_POOL.submit(_prewarm_one_url, url)
        except RuntimeError:
            # Pool was shut down. ignore. /img will lazy-fetch.
            return


def _image_cache_lookup(digest: str) -> Optional[tuple[str, str]]:
    """Return ``(path, ext)`` if a cached file exists for this hash.

    We sniff by extension because we don't persist a sidecar manifest -
    the filename alone carries the content type.

    Files under ``_PLACEHOLDER_BYTE_THRESHOLD`` are treated as misses and
    deleted on the spot. Past code accidentally cached the 1×1 transparent
    PNG when an upstream resolve failed; the resulting file would be
    served as a happy 200 OK forever, leaving the UI with a sea of blanks.
    """
    for ext in ("jpg", "png", "webp", "gif", "avif", "bin"):
        path = os.path.join(IMAGE_CACHE_DIR, f"{digest}.{ext}")
        if os.path.exists(path):
            try:
                if os.path.getsize(path) < _PLACEHOLDER_BYTE_THRESHOLD:
                    os.remove(path)
                    continue
                # Hash-blacklist eviction. files matching a known generic
                # placeholder (e.g. FB social-icons collage) are deleted so
                # subsequent loads re-fetch and have a chance to advance
                # past the og:image stage of the chain. Hash is memoized
                # by (path, mtime) so this is cheap on repeat lookups even
                # for larger files. Bumped from 32 KB → 128 KB after a
                # 33 KB FB social-icons WEBP slipped past the old limit.
                try:
                    if os.path.getsize(path) <= 131072:
                        sha = _content_sha_for_path(path)
                        if sha and sha in _PLACEHOLDER_HASH_BLACKLIST:
                            os.remove(path)
                            continue
                except Exception:
                    pass
                # Lazy-evict tiny-dimension thumbnails (p64x64 et al)
                # cached before the dimension gate existed. Skips files
                # ≥ 64 KB so we don't waste a Pillow decode on real
                # product photos.
                try:
                    if os.path.getsize(path) < 65536:
                        from PIL import Image  # noqa: WPS433
                        with Image.open(path) as im:
                            w, h = im.size
                        if min(w, h) < _MIN_USEFUL_DIMENSION:
                            os.remove(path)
                            continue
                except Exception:
                    pass
            except OSError:
                pass
            return path, ext
    return None


_preview_cache: dict[str, tuple[float, dict]] = {}
_PREVIEW_CACHE_TTL = 3600  # 1 h


@router.get("/preview")
def ad_preview(
    ad_id: str,
    ad_format: str = Query(
        "DESKTOP_FEED_STANDARD",
        description=(
            "Meta preview format. DESKTOP_FEED_STANDARD, "
            "MOBILE_FEED_STANDARD, INSTAGRAM_STANDARD, INSTAGRAM_STORY, etc."
        ),
    ),
):
    """Render a native Meta ad preview via Graph API ``/{ad_id}/previews``.

    Returns ``{"body": "<iframe html>", "ad_format": ...}``. The frontend
    drops the HTML into an iframe srcDoc so the user sees the ad with
    FB/IG chrome (Like / Comment / Share / CTA). same as Atria's "eye"
    preview.
    """
    token = os.environ.get("META_ACCESS_TOKEN")
    if not token:
        raise HTTPException(status_code=500, detail="META_ACCESS_TOKEN not configured")

    cache_key = f"{ad_id}:{ad_format}"
    entry = _preview_cache.get(cache_key)
    if entry and (time.time() - entry[0]) < _PREVIEW_CACHE_TTL:
        return entry[1]

    import httpx

    # If the caller didn't insist on a specific format, cascade through
    # common formats and return the first one Meta actually has. This is
    # critical because many ads target a subset of placements (mobile-only,
    # IG-only, etc.). Meta returns an empty array for formats outside
    # the ad's delivery scope.
    fallback_formats = [
        ad_format,
        "MOBILE_FEED_STANDARD",
        "DESKTOP_FEED_STANDARD",
        "INSTAGRAM_STANDARD",
        "INSTAGRAM_REELS",
        "INSTAGRAM_STORY",
        "FACEBOOK_REELS_MOBILE",
        "FACEBOOK_STORY_MOBILE",
    ]
    seen: set[str] = set()
    url = f"https://graph.facebook.com/{META_API_VERSION}/{ad_id}/previews"
    last_error: Optional[str] = None
    for fmt in fallback_formats:
        if fmt in seen:
            continue
        seen.add(fmt)
        try:
            with httpx.Client(timeout=30.0) as client:
                r = client.get(url, params={"access_token": token, "ad_format": fmt})
            data = r.json()
        except Exception as e:
            last_error = f"Preview fetch failed: {e}"
            continue
        if isinstance(data, dict) and "error" in data:
            last_error = str(data["error"].get("message") or data["error"])
            continue
        previews = data.get("data") or []
        if previews and previews[0].get("body"):
            out = {"body": previews[0]["body"], "ad_format": fmt}
            _preview_cache[cache_key] = (time.time(), out)
            return out

    raise HTTPException(
        status_code=404,
        detail=last_error or "No preview available for any placement format on this ad",
    )


# Global rate-limit cooldown. Any Meta fetch checks this before firing;
# if set, callers receive a RateLimitedError which the FastAPI handlers
# translate to a 503 with a Retry-After header. We set it when Meta's
# `X-App-Usage` / `X-Business-Use-Case-Usage` headers report any of
# call_count / total_cputime / total_time above 85, or when we see an
# explicit rate-limit error code. 5-minute cool-down gives Meta's sliding
# window room to recover without starving the UI.
_RATE_LIMIT_PAUSE_UNTIL: float = 0.0
_RATE_LIMIT_PAUSE_SECONDS = 300  # 5 min cooldown
_RATE_LIMIT_USAGE_THRESHOLD = 85  # pct


class RateLimitedError(Exception):
    """Raised by Meta-fetch helpers when the global pause is active.

    ``retry_after`` is seconds remaining on the cooldown. FastAPI
    handlers translate this into a 503 with ``Retry-After``.
    """

    def __init__(self, retry_after: int, message: str = "Meta rate limit cooldown active"):
        super().__init__(message)
        self.retry_after = max(1, int(retry_after))
        self.message = message


def _check_rate_limit_pause() -> None:
    """Raise RateLimitedError if we're inside the cooldown window."""
    global _RATE_LIMIT_PAUSE_UNTIL
    now = time.time()
    if _RATE_LIMIT_PAUSE_UNTIL and now < _RATE_LIMIT_PAUSE_UNTIL:
        raise RateLimitedError(int(_RATE_LIMIT_PAUSE_UNTIL - now))


def _trip_rate_limit_pause(reason: str = "") -> None:
    """Arm the global cooldown. Idempotent. extends the window if already set."""
    global _RATE_LIMIT_PAUSE_UNTIL
    until = time.time() + _RATE_LIMIT_PAUSE_SECONDS
    if until > _RATE_LIMIT_PAUSE_UNTIL:
        _RATE_LIMIT_PAUSE_UNTIL = until
    # Also stamp the legacy banner state so the existing meta-status
    # endpoint + its banner surface something useful.
    _META_RATE_LIMIT["at"] = time.time()
    if reason:
        _META_RATE_LIMIT["message"] = reason[:200]
    print(
        f"[ad-analysis] rate-limit cooldown armed for {_RATE_LIMIT_PAUSE_SECONDS}s "
        f"(reason: {reason or 'unspecified'})",
        flush=True,
    )


def _observe_meta_usage_headers(headers: Any) -> None:
    """Parse Meta's usage headers and trip the cooldown if any dimension is hot.

    Headers of interest:
      - ``X-App-Usage``: {"call_count", "total_cputime", "total_time"}
      - ``X-Business-Use-Case-Usage``: {"<biz_id>": [{"call_count", ...}]}
      - ``X-Ad-Account-Usage``: {"acc_id_util_pct": <int>, ...}

    All values are percentages (0-100). We pause when any exceeds the
    threshold to give Meta's sliding window time to recover.
    """
    if not headers:
        return

    def _getter(name: str) -> Optional[str]:
        try:
            # Support both dict and httpx/requests Headers (case-insensitive).
            return headers.get(name) if hasattr(headers, "get") else None
        except Exception:
            return None

    def _max_pct(blob: Any) -> float:
        """Walk a parsed-JSON usage blob and return the highest percentage seen."""
        best = 0.0
        stack = [blob]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                for k, v in node.items():
                    if k in ("call_count", "total_cputime", "total_time") and isinstance(v, (int, float)):
                        if v > best:
                            best = float(v)
                    else:
                        stack.append(v)
            elif isinstance(node, list):
                stack.extend(node)
        return best

    raw_app = _getter("X-App-Usage") or _getter("x-app-usage")
    raw_buc = _getter("X-Business-Use-Case-Usage") or _getter("x-business-use-case-usage")

    max_pct = 0.0
    for raw in (raw_app, raw_buc):
        if not raw:
            continue
        try:
            parsed = json.loads(raw)
        except Exception:
            continue
        seen = _max_pct(parsed)
        if seen > max_pct:
            max_pct = seen

    if max_pct >= _RATE_LIMIT_USAGE_THRESHOLD:
        _trip_rate_limit_pause(f"Meta usage at {int(max_pct)}% (threshold {_RATE_LIMIT_USAGE_THRESHOLD}%)")


# Meta rate-limit tracker. any path that sees a rate-limit error code
# from Meta writes (timestamp, message) here so the frontend can surface
# a banner. Error codes we treat as rate limits: 4 (app-level),
# 17 (user-level), 80000-80004 (account-level).
_META_RATE_LIMIT: dict[str, Any] = {"at": 0, "message": "", "code": None}


def _note_meta_rate_limit(err: Any) -> bool:
    """Inspect a Meta error payload. If it's a rate-limit error, stamp the
    global state and return True. Callers can branch on this to degrade
    gracefully (skip retries, return stale data, etc.).
    """
    if not isinstance(err, dict):
        return False
    code = err.get("code")
    msg = err.get("message") or ""
    rate_codes = {4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004}
    if code in rate_codes or "limit reached" in msg.lower() or "too many calls" in msg.lower():
        _META_RATE_LIMIT["at"] = time.time()
        _META_RATE_LIMIT["message"] = str(msg)[:200]
        _META_RATE_LIMIT["code"] = code
        # Arm the global cooldown so subsequent Meta fetches short-circuit
        # with 503 + Retry-After instead of piling on the failing app.
        _trip_rate_limit_pause(f"Meta error code {code}: {msg}")
        return True
    return False


@router.get("/meta-status")
def meta_status():
    """Report whether Meta has rate-limited our app recently.

    Frontend polls this to decide whether to show a banner. We consider a
    rate limit "active" for an hour after the last observed error -
    Meta's windows are typically 1 h for app-level and 5 min for
    account-level, so 60 min covers the common cases.
    """
    at = float(_META_RATE_LIMIT.get("at") or 0)
    age = time.time() - at if at else None
    throttled = bool(at and age is not None and age < 3600)
    # Short-window cooldown (header-triggered, 5 min default). Independent
    # from the 1h banner window above. the frontend reads `retry_after_s`
    # when surfacing an exact countdown for 503-driven pauses.
    now = time.time()
    cooldown_remaining = max(0, int(_RATE_LIMIT_PAUSE_UNTIL - now)) if _RATE_LIMIT_PAUSE_UNTIL else 0
    return {
        "throttled": throttled,
        "message": _META_RATE_LIMIT.get("message") if throttled else None,
        "code": _META_RATE_LIMIT.get("code") if throttled else None,
        "age_seconds": int(age) if age is not None else None,
        "cooldown": cooldown_remaining > 0,
        "retry_after_s": cooldown_remaining,
    }


# Per-ad debounce for /refresh-urls. a single broken-image onError on the
# frontend can fan out dozens of parallel /refresh-urls calls when an ad
# grid re-renders with expired CDN URLs. Keep the last successful payload
# in memory for 60 s keyed by ad_id so fanout resolves from memory.
_REFRESH_URLS_DEBOUNCE_S = 60
_refresh_urls_cache: dict[str, tuple[float, dict]] = {}


@router.get("/refresh-urls")
def refresh_urls(brand: str, ad_id: str):
    """Re-resolve fresh image/video URLs for a single ad from Meta.

    Meta's scontent CDN URLs carry signed tokens that expire in a few
    hours. When the frontend's `<img onError>` fires, it calls this
    endpoint to swap in fresh URLs without needing a full cache refresh.
    Bypasses every caching tier and hits Meta directly.
    """
    accounts = _get_meta_accounts()
    if not accounts.get(brand):
        raise HTTPException(status_code=404, detail=f"Brand '{brand}' not in META_ACCOUNTS")
    token = os.environ.get("META_ACCESS_TOKEN")
    if not token:
        raise HTTPException(status_code=500, detail="META_ACCESS_TOKEN not configured")

    # Debounce. serve the last successful payload if the same ad_id was
    # refreshed within the last 60 s. Fanout from a grid of broken images
    # would otherwise turn into N parallel Meta Graph calls.
    cached = _refresh_urls_cache.get(ad_id)
    if cached:
        ts, payload = cached
        if (time.time() - ts) <= _REFRESH_URLS_DEBOUNCE_S:
            return payload

    # Translate a RateLimitedError (raised from _fetch_ad_creative) into a
    # 503 with Retry-After so the frontend can stop firing further
    # /refresh-urls calls for the window.
    #
    # ``force=True`` is essential: otherwise the nested video-metadata
    # lookup hits its 7-day disk cache and returns the expired ``source``
    # URL that triggered this refresh in the first place.
    try:
        creative = _fetch_ad_creative(ad_id, token, force=True)
    except RateLimitedError as rle:
        raise HTTPException(
            status_code=503,
            detail=rle.message,
            headers={"Retry-After": str(rle.retry_after)},
        )
    if not creative:
        raise HTTPException(status_code=404, detail="Creative not resolved")

    # Also bust the in-memory + disk creative cache for this brand so the
    # next /dashboard call re-pulls fresh URLs for every ad.
    prefix = f"creatives:{brand}:"
    for k in list(_creative_cache.keys()):
        if k.startswith(prefix):
            _creative_cache.pop(k, None)
    try:
        data = _load_creatives_disk_cache()
        for k in list(data.keys()):
            if k.startswith(prefix):
                data.pop(k, None)
        _save_creatives_disk_cache(data)
    except Exception:
        pass

    payload = {
        "ad_id": ad_id,
        "image_url": creative.get("image_url"),
        "image_url_hd": creative.get("image_url_hd"),
        "thumbnail_url": creative.get("thumbnail_url"),
        "video_source_url": creative.get("video_source_url"),
        "video_permalink": creative.get("video_permalink"),
    }
    _refresh_urls_cache[ad_id] = (time.time(), payload)
    return payload


# Stable-key image endpoint. Solves the "Meta CDN URLs expire in seconds"
# problem: instead of the frontend caching a URL string and racing the
# signature lifetime, it requests by ad_id. The first hit fetches a fresh
# URL from Graph and downloads bytes immediately (within the URL's live
# window); subsequent hits serve from disk forever.
@router.get("/img-by-ad")
def img_by_ad(
    ad_id: str = Query(..., description="Ad ID"),
    brand: str = Query(..., description="Brand name (for token + account)"),
    kind: str = Query("auto", description="auto | image | thumbnail | hd"),
):
    """Resolve a fresh Meta CDN URL for the ad and serve image bytes.

    Cache is keyed by ``ad_id::kind`` so the URL signature lifetime
    becomes invisible. If a previous fetch succeeded, the disk hit is
    served immediately. no Graph call. Only the first hit per ad pays
    the resolve+fetch cost.
    """
    cache_seed = f"img-by-ad:{ad_id}:{kind}"
    digest = hashlib.sha256(cache_seed.encode("utf-8")).hexdigest()

    hit = _image_cache_lookup(digest)
    if hit is not None:
        path, ext = hit
        return FileResponse(
            path,
            media_type=_content_type_for_ext(ext),
            headers={**_IMG_CACHE_HEADERS, "X-Img-Source": "disk-cache"},
        )

    accounts = _get_meta_accounts()
    if not accounts.get(brand):
        raise HTTPException(status_code=404, detail=f"Brand '{brand}' not in META_ACCOUNTS")
    token = os.environ.get("META_ACCESS_TOKEN")
    if not token:
        raise HTTPException(status_code=500, detail="META_ACCESS_TOKEN not configured")

    # Fetch creative directly from Graph. DO NOT use _fetch_ad_creative
    # because it strips the `stp=` query param. Despite Meta's
    # `no-vary-search` header claiming `stp` isn't part of the URL
    # signature, it actually IS. stripping it produces "URL signature
    # mismatch" 403s on every request.
    import requests as req
    try:
        _check_rate_limit_pause()
    except RateLimitedError as rle:
        raise HTTPException(status_code=503, detail=rle.message,
                            headers={"Retry-After": str(rle.retry_after)})
    fields = "creative{image_url,thumbnail_url,image_hash,video_id,effective_object_story_id}"
    gr = req.get(f"https://graph.facebook.com/{META_API_VERSION}/{ad_id}",
                 params={"access_token": token, "fields": fields}, timeout=30)
    try:
        _observe_meta_usage_headers(getattr(gr, "headers", {}) or {})
    except Exception:
        pass
    creative = (gr.json().get("creative") or {}) if gr.status_code == 200 else {}
    if not creative:
        return Response(status_code=404, content=_PIXEL_PNG, media_type="image/png",
                        headers={"X-Img-Fail-Kind": "creative-missing"})

    # Quality upgrades:
    # 1) Static images. `image_url` from creative carries an `stp` transform
    #    that often delivers a small variant. The /adimages?hashes= endpoint
    #    returns url_full / url_1080 / permalink_url which are the full-res
    #    originals. Use those when we have an image_hash.
    # 2) Video ads. `creative.thumbnail_url` is typically a 64×64 poster
    #    (`p64x64` baked into stp). The video metadata endpoint returns
    #    `thumbnails.data[]` with multiple sizes; pick the largest by
    #    width × height so cards render sharp.
    image_hash = creative.get("image_hash")
    if image_hash:
        try:
            account_id = accounts[brand]
            hash_urls = _fetch_image_hash_urls_bulk(account_id, [image_hash], token)
            info = hash_urls.get(image_hash) or {}
            full = info.get("url_full") or info.get("url_1080") or info.get("permalink_url")
            if full:
                creative["image_url"] = full
        except Exception:
            pass

    # For static ads with no image_url (often duplicates / "Copy" ads),
    # try the post URL og:image scrape. it returns a 500-700px ad creative
    # (`t45.1600-4`) instead of the 64×64 thumbnail Meta surfaces by default.
    if not creative.get("image_url") and not creative.get("image_hash") and not creative.get("video_id"):
        try:
            sid = creative.get("effective_object_story_id") or ""
            if "_" in sid:
                post_id = sid.split("_", 1)[1]
                og = _scrape_og_image(f"https://www.facebook.com/{post_id}")
                if og:
                    creative["image_url"] = og
        except Exception:
            pass

    video_id = creative.get("video_id")
    if video_id:
        # Two paths to a higher-res video poster than the 64×64 baked into
        # `creative.thumbnail_url`:
        #   1) Graph `<video_id>?fields=thumbnails{...}`. works only with
        #      ads_management+pages_read scope, often blocked by app perms.
        #   2) Public og:image scrape on `facebook.com/<post_id>`. no auth,
        #      consistently returns the full-res (e.g. 640×1136) poster.
        # We try (2) first since it's the path that actually works with the
        # app token configurations we have.
        try:
            story_id = creative.get("effective_object_story_id") or ""
            post_id = video_id
            if story_id and "_" in story_id:
                post_id = story_id.split("_", 1)[1]
            og = _scrape_og_image(f"https://www.facebook.com/{post_id}")
            if og:
                creative["thumbnail_url"] = og
        except Exception:
            pass
        if not creative.get("thumbnail_url") or "p64x64" in (creative.get("thumbnail_url") or ""):
            # Fallback: try the authenticated thumbnails endpoint anyway.
            try:
                vfields = "thumbnails{uri,width,height,is_preferred}"
                vr = req.get(f"https://graph.facebook.com/{META_API_VERSION}/{video_id}",
                             params={"access_token": token, "fields": vfields}, timeout=20)
                if vr.status_code == 200:
                    thumbs = ((vr.json().get("thumbnails") or {}).get("data") or [])
                    thumbs.sort(key=lambda t: (
                        int(t.get("width") or 0) * int(t.get("height") or 0),
                        1 if t.get("is_preferred") else 0,
                    ), reverse=True)
                    if thumbs and thumbs[0].get("uri"):
                        creative["thumbnail_url"] = thumbs[0]["uri"]
            except Exception:
                pass

    # Resolve order based on `kind`. `auto` prefers static image, falling
    # back to video poster. both raw, signed, unstripped.
    if kind == "image":
        candidates = [creative.get("image_url")]
    elif kind == "thumbnail":
        candidates = [creative.get("thumbnail_url"), creative.get("image_url")]
    else:
        candidates = [creative.get("image_url"), creative.get("thumbnail_url")]
    candidates = [u for u in candidates if u]
    # Final fallback: render the ad via /previews and extract the creative
    # image URL from the rendered iframe HTML. This is the path that
    # works for DPA/dark-post/dynamic-creative ads where no
    # image_url/image_hash/video_id is exposed on the creative directly.
    if not candidates:
        preview_url = _extract_preview_creative_url(ad_id, token)
        if preview_url:
            candidates = [preview_url]
        else:
            return Response(status_code=404, content=_PIXEL_PNG, media_type="image/png",
                            headers={"X-Img-Fail-Kind": "no-url"})

    import httpx
    last_status: Optional[int] = None
    for url in candidates:
        try:
            with httpx.Client(timeout=20.0, follow_redirects=True, headers=_BROWSER_HEADERS) as client:
                resp = client.get(url)
            last_status = resp.status_code
            if resp.status_code == 200 and resp.content and (resp.headers.get("content-type", "").startswith("image/")) and _is_useful_image_bytes(resp.content):
                ct = resp.headers.get("content-type", "")
                ext = _ext_for_content_type(ct)
                path = os.path.join(IMAGE_CACHE_DIR, f"{digest}.{ext}")
                tmp = path + ".tmp"
                with open(tmp, "wb") as fp:
                    fp.write(resp.content)
                os.replace(tmp, path)
                return Response(content=resp.content, media_type=_content_type_for_ext(ext),
                                headers={**_IMG_CACHE_HEADERS, "X-Img-Source": "fresh-fetch"})
        except Exception:
            continue
    # All candidate URLs failed OR returned tiny p64x64 thumbnails.
    # Render the ad via /previews and extract the real creative URL -
    # this is the path that works for dark-post / dynamic-creative ads
    # where Graph exposes only thumbnail_url.
    preview_url = _extract_preview_creative_url(ad_id, token)
    if preview_url:
        try:
            with httpx.Client(timeout=20.0, follow_redirects=True, headers=_BROWSER_HEADERS) as client:
                resp = client.get(preview_url)
            if resp.status_code == 200 and resp.content and resp.headers.get("content-type", "").startswith("image/") and _is_useful_image_bytes(resp.content):
                ct = resp.headers.get("content-type", "")
                ext = _ext_for_content_type(ct)
                path = os.path.join(IMAGE_CACHE_DIR, f"{digest}.{ext}")
                tmp = path + ".tmp"
                with open(tmp, "wb") as fp:
                    fp.write(resp.content)
                os.replace(tmp, path)
                return Response(content=resp.content, media_type=_content_type_for_ext(ext),
                                headers={**_IMG_CACHE_HEADERS, "X-Img-Source": "preview-extract"})
        except Exception:
            pass
    return Response(status_code=last_status or 502, content=_PIXEL_PNG, media_type="image/png",
                    headers={"X-Img-Fail-Kind": "upstream",
                             "X-Upstream-Status": str(last_status) if last_status else "-"})


def _extract_preview_creative_url(ad_id: str, token: str) -> Optional[str]:
    """Render the ad via /previews and extract a creative image URL.

    Why: DPA / dark-post / dynamic-creative ads expose no static
    image_url, image_hash, or video_id on their `creative` object. only
    the rendered preview iframe contains a real image. We fetch the
    `preview_iframe.php` URL (which carries an embedded auth token) and
    parse the resulting HTML for the first scontent.fbcdn.net t45/t39
    creative-image path, ignoring page avatars (t39.1997 / t39.7142).

    Returns the first matching URL, or None if rendering / parsing
    fails. Cheap to call. leverages the global /preview cache so a
    single ad pays at most one Graph round-trip.
    """
    import httpx
    import re as _re

    # Reuse the global preview cache. We try mobile feed first because
    # it renders the cleanest single-image variant for DPA ads.
    fmt_chain = [
        "MOBILE_FEED_STANDARD",
        "DESKTOP_FEED_STANDARD",
        "INSTAGRAM_STANDARD",
    ]
    iframe_src: Optional[str] = None
    for fmt in fmt_chain:
        cache_key = f"{ad_id}:{fmt}"
        entry = _preview_cache.get(cache_key)
        body: Optional[str] = None
        if entry and (time.time() - entry[0]) < _PREVIEW_CACHE_TTL:
            body = (entry[1] or {}).get("body")
        else:
            try:
                with httpx.Client(timeout=20.0) as client:
                    r = client.get(
                        f"https://graph.facebook.com/{META_API_VERSION}/{ad_id}/previews",
                        params={"access_token": token, "ad_format": fmt},
                    )
                data = r.json()
                if isinstance(data, dict) and "error" not in data:
                    previews = data.get("data") or []
                    if previews and previews[0].get("body"):
                        body = previews[0]["body"]
                        _preview_cache[cache_key] = (
                            time.time(),
                            {"body": body, "ad_format": fmt},
                        )
            except Exception:
                continue
        if not body:
            continue
        # Meta sometimes returns the iframe src wrapped in either ", ',
        # or HTML-entity-escaped &quot;. Match all three.
        m = (_re.search(r'src=["\']([^"\']*preview_iframe\.php[^"\']*)["\']', body)
             or _re.search(r'src=&quot;([^&]*preview_iframe\.php[^&]*?)&quot;', body))
        if m:
            iframe_src = (m.group(1)
                          .replace("&amp;", "&")
                          .replace("&#x2F;", "/")
                          .replace("&#x3D;", "="))
            break

    if not iframe_src:
        return None

    # Fetch the rendered iframe HTML. its embedded access_token grants
    # access to the rendered ad creative. Then parse for a t45/t39 image.
    #
    # The image URLs are buried inside JS bundles in the iframe HTML, so
    # we unescape JS string sequences (`\/` → `/`, `/` → `/`, etc.)
    # BEFORE running the regex. Without this step the regex finds only
    # static UI assets (rsrc.php URLs) and misses the actual creative,
    # which is exactly the case the user hit on 2026-05-04. every
    # post-based Kinn ad rendered "No preview" because the real
    # scontent-cdn URL lived behind escaped slashes.
    try:
        # Use HTML/iframe headers. _BROWSER_HEADERS is for image fetches
        # and triggers a 400 from business.facebook.com (Origin mismatch).
        with httpx.Client(timeout=20.0, follow_redirects=True, headers=_IFRAME_FETCH_HEADERS) as client:
            r = client.get(iframe_src)
        if r.status_code != 200 or not r.text:
            return None
        # Unescape JS string sequences. `/` and `&` are how
        # JSON-embedded URLs encode `/` and `&`; `\/` is the JS-string
        # form of `/`.
        # JS-escape unwinding: `\/` is the JS-string form of `/`, and
        # `\uXXXX` covers the JSON-style numeric escapes Meta sometimes
        # emits (`/` for `/`, `&` for `&`, etc.). Regex-decode
        # every \uXXXX so the subsequent URL regex sees plain text.
        text = r.text.replace(r"\/", "/").replace("&amp;", "&")
        text = _re.sub(
            r"\\u([0-9a-fA-F]{4})",
            lambda mm: chr(int(mm.group(1), 16)),
            text,
        )
        unescaped = text
        # Prefer the longest matching URL. Meta embeds both a small
        # `t39.30808-1` page-avatar AND the full-res `t45.1600-4` creative
        # in the same HTML. Longest URL ≈ most query params ≈ real
        # creative; the avatar paths are also blacklisted explicitly.
        best: Optional[str] = None
        best_len = 0
        for m in _AD_IMG_PATH_RE.finditer(unescaped):
            url = m.group(0)
            if any(b in url for b in _BLACKLIST_IMG_PATHS):
                continue
            if len(url) > best_len:
                best = url
                best_len = len(url)
        return best
    except Exception:
        return None


# Ring buffer of recent image-proxy failures, exposed via /api/ads/img-debug
# so the user can see WHY images are failing (403, network, content-type, etc.)
# without having to tail server logs.
_IMG_FAILURE_LOG: list[dict] = []
_IMG_FAILURE_LOG_MAX = 100


def _log_img_failure(url: str, kind: str, status: int | None, detail: str) -> None:
    """Record a single image-proxy failure for /img-debug visibility."""
    import datetime as _dt
    entry = {
        "ts": _dt.datetime.utcnow().isoformat() + "Z",
        "url": url[:200],
        "url_host": (url.split("/")[2] if url.startswith("http") and "/" in url[8:] else "?"),
        "kind": kind,         # 'http' | 'network' | 'content_type' | 'empty' | 'invalid'
        "status": status,     # upstream HTTP status, or None if pre-network
        "detail": detail[:300],
    }
    _IMG_FAILURE_LOG.append(entry)
    if len(_IMG_FAILURE_LOG) > _IMG_FAILURE_LOG_MAX:
        del _IMG_FAILURE_LOG[: len(_IMG_FAILURE_LOG) - _IMG_FAILURE_LOG_MAX]
    print(
        f"[ad-analysis][img-fail] kind={kind} status={status} host={entry['url_host']} url={url[:80]}… detail={detail[:120]}",
        flush=True,
    )


@router.get("/warehouse-stats")
def warehouse_stats():
    """Return creative-warehouse counts so the UI/ops can verify the
    DuckDB cache is doing its job. Cheap. three quick SELECTs against
    the local DB, no Meta calls.
    """
    try:
        from creative_warehouse import stats
        return stats()
    except Exception as e:
        return {"error": str(e)}


@router.get("/img-debug")
def img_debug(limit: int = 50):
    """Return the recent image-proxy failure log (newest first) so the
    frontend or operator can diagnose why thumbnails went blank without
    tailing server logs. Includes upstream status, host, and short detail."""
    items = list(reversed(_IMG_FAILURE_LOG))[:max(1, min(int(limit), _IMG_FAILURE_LOG_MAX))]
    by_kind: dict[str, int] = {}
    by_status: dict[str, int] = {}
    for e in items:
        by_kind[e["kind"]] = by_kind.get(e["kind"], 0) + 1
        s = str(e["status"]) if e["status"] is not None else "-"
        by_status[s] = by_status.get(s, 0) + 1
    return {
        "total_recent": len(items),
        "by_kind": by_kind,
        "by_status": by_status,
        "items": items,
    }


@router.get("/img")
def proxy_image(u: str = Query(..., description="Upstream image URL")):
    """Proxy + disk-cache an upstream image URL.

    Call shape: ``/api/ads/img?u=<urlencoded meta url>``. The URL itself
    is hashed to derive a stable filename. the client never needs to
    pass a hash explicitly.

    First hit: fetches with browser UA + FB referer, writes bytes to
    ``image_cache/<sha256>.<ext>``, returns them. Subsequent hits: serve
    straight from disk. On failure we return a non-2xx status with
    diagnostic headers (`X-Upstream-Status`, `X-Img-Fail-Kind`) so the
    frontend can branch on the actual failure mode and surface it to the
    user (instead of a silent broken-image icon).
    """
    if not u or not isinstance(u, str) or not u.startswith("http"):
        _log_img_failure(str(u or ""), "invalid", None, "url not http(s) or empty")
        return Response(
            content=_PIXEL_PNG,
            status_code=400,
            media_type="image/png",
            headers={
                "Cache-Control": "public, max-age=300",
                "X-Img-Fail-Kind": "invalid",
            },
        )

    digest = hashlib.sha256(u.encode("utf-8")).hexdigest()

    hit = _image_cache_lookup(digest)
    if hit is not None:
        path, ext = hit
        return FileResponse(
            path,
            media_type=_content_type_for_ext(ext),
            headers={**_IMG_CACHE_HEADERS, "X-Img-Source": "disk-cache"},
        )

    upstream_status: int | None = None
    try:
        import httpx

        with httpx.Client(
            timeout=20.0,
            follow_redirects=True,
            headers=_BROWSER_HEADERS,
        ) as client:
            resp = client.get(u)
        upstream_status = resp.status_code
        if resp.status_code != 200:
            _log_img_failure(u, "http", resp.status_code, f"upstream HTTP {resp.status_code}")
            return Response(
                status_code=resp.status_code if resp.status_code in (403, 404, 410, 451) else 502,
                content=_PIXEL_PNG,
                media_type="image/png",
                headers={
                    "Cache-Control": "public, max-age=5",
                    "X-Upstream-Status": str(resp.status_code),
                    "X-Img-Fail-Kind": "http",
                },
            )
        if not resp.content:
            _log_img_failure(u, "empty", 200, "empty body despite HTTP 200")
            return Response(
                status_code=502,
                content=_PIXEL_PNG,
                media_type="image/png",
                headers={
                    "Cache-Control": "public, max-age=5",
                    "X-Upstream-Status": "200",
                    "X-Img-Fail-Kind": "empty",
                },
            )
        ct = resp.headers.get("content-type", "")
        if not ct.startswith("image/"):
            _log_img_failure(u, "content_type", 200, f"non-image content-type: {ct[:60]}")
            return Response(
                status_code=502,
                content=_PIXEL_PNG,
                media_type="image/png",
                headers={
                    "Cache-Control": "public, max-age=5",
                    "X-Upstream-Status": "200",
                    "X-Img-Fail-Kind": "content_type",
                    "X-Upstream-Content-Type": ct[:60],
                },
            )
        if len(resp.content) < _PLACEHOLDER_BYTE_THRESHOLD:
            # Meta sometimes returns a 1×1 transparent PNG with image/png
            # content-type for retired posts / expired signatures. Treat
            # it as upstream failure rather than caching the dud.
            return Response(
                status_code=502, content=_PIXEL_PNG, media_type="image/png",
                headers={"Cache-Control": "public, max-age=5",
                         "X-Img-Fail-Kind": "placeholder-sized"},
            )
        ext = _ext_for_content_type(ct)
        path = os.path.join(IMAGE_CACHE_DIR, f"{digest}.{ext}")
        tmp = path + ".tmp"
        with open(tmp, "wb") as fp:
            fp.write(resp.content)
        os.replace(tmp, path)
        return Response(
            content=resp.content,
            media_type=_content_type_for_ext(ext),
            headers={**_IMG_CACHE_HEADERS, "X-Img-Source": "fresh-fetch"},
        )
    except Exception as e:
        _log_img_failure(u, "network", upstream_status, f"{type(e).__name__}: {e}")
        return Response(
            status_code=502,
            content=_PIXEL_PNG,
            media_type="image/png",
            headers={
                "Cache-Control": "public, max-age=5",
                "X-Img-Fail-Kind": "network",
                "X-Upstream-Status": str(upstream_status) if upstream_status else "-",
                "X-Img-Fail-Detail": f"{type(e).__name__}",
            },
        )



# ---------------------------------------------------------------------------
# Public post-level thumbnail. Scrapes og:image from the ad's underlying
# Facebook/Instagram post page using a Googlebot UA. no Graph API call,
# no token, no app-quota. Every published ad has a public permalink
# (effective_object_story_id = "{page_id}_{post_id}"), and the rendered
# post page exposes a stable og:image meta tag pointing to scontent CDN.
# We disk-cache the resolved image bytes so the grid keeps loading even
# when our app token is mid-rate-limit-cooldown.
# ---------------------------------------------------------------------------

_OG_SCRAPE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
}

_OG_IMAGE_RE = re.compile(
    r'<meta\s+property=["\']og:image["\']\s+content=["\']([^"\']+)["\']',
    re.IGNORECASE,
)

# Meta CDN paths that indicate an actual ad creative (the kind a user
# gets by right-clicking the rendered post image), as opposed to page
# avatars or share badges.
#   t45.1600-4 → paid ad creatives served from Ads Manager
#   t39.30808  → organic post photos
#   t51.36359  → catalog product images
# Profile pics live under t39.1997 / t39.7142. those are explicitly
# excluded so we never confuse a page avatar for the creative.
# Accept any scontent.fbcdn.net path EXCEPT the page-avatar/profile ones
# (t39.1997 / t39.7142 / s60x60 / p64x64). Catches ad creative paths
# we hadn't seen yet (e.g. t39.16327 for some catalog-feed renders,
# t15.13418 for video posters) without us having to enumerate them.
_AD_IMG_PATH_RE = re.compile(
    r'https?://[^"\'<>\s]*?(?:scontent|fbcdn)[^"\'<>\s]*?'
    r'\.(?:jpg|jpeg|png|webp)[^"\'<>\s]*'
)
_BLACKLIST_IMG_PATHS = (
    # Page-avatar paths. never a real creative.
    't39.1997', 't39.7142',
    # Tiny thumbnail variants. Meta serves these when no real creative is
    # available. Catching them here prevents low-res poster art from
    # masquerading as the ad image.
    'p64x64', 's60x60', 's40x40',
    # Facebook site-default og:image fallbacks. Returned when the post
    # page itself has no og:image. the scrape silently inherits the
    # site-wide FB-logo placeholder ("giant blue F" the user reported on
    # 2026-05-04). Block by URL substring so we never recommend them.
    'fb_icon', 'fb_logo', 'rsrc.php',
)


def _scrape_og_image(page_url: str) -> Optional[str]:
    """Fetch ``page_url`` as Googlebot. First tries to pull a real ad
    creative URL out of the body (t45.1600-4 / t39.30808 / t51.36359),
    falls back to og:image for genuinely static posts. Page-avatar paths
    (t39.1997 / t39.7142) are blacklisted so we never thumbnail an ad as
    its page profile picture.
    """
    try:
        import httpx

        with httpx.Client(
            timeout=15.0,
            follow_redirects=True,
            headers=_OG_SCRAPE_HEADERS,
        ) as client:
            r = client.get(page_url)
        if r.status_code != 200 or not r.text:
            return None
        body = r.text
        import urllib.parse as _up
        # First pass: real ad creative paths embedded in the post HTML.
        for m in _AD_IMG_PATH_RE.finditer(body):
            url = m.group(0).replace("&amp;", "&")
            if any(b in url for b in _BLACKLIST_IMG_PATHS):
                continue
            # Same external/emg unwrap as the og:image branch. the
            # post HTML often embeds the same proxy-wrapped URL.
            try:
                parsed = _up.urlparse(url)
                if "fbcdn.net" in parsed.netloc and "/emg" in parsed.path:
                    qs = _up.parse_qs(parsed.query)
                    inner = (qs.get("url") or [None])[0]
                    if inner and inner.startswith(("http://", "https://")):
                        return inner
            except Exception:
                pass
            return url
        # Second pass: og:image, but only if it doesn't look like a
        # page avatar.
        m = _OG_IMAGE_RE.search(body)
        if not m:
            return None
        og = m.group(1).replace("&amp;", "&")
        if any(b in og for b in _BLACKLIST_IMG_PATHS):
            return None
        # Meta serves og:image through the `external-*.xx.fbcdn.net/emg1/`
        # proxy, which returns a 1×1 placeholder when fetched without a
        # facebook.com Origin/Referer. The proxy URL embeds the real source
        # (Shopify CDN, etc.) as a `?url=` query param. unwrap it so the
        # caller gets a URL it can actually fetch.
        try:
            import urllib.parse as _up
            parsed = _up.urlparse(og)
            if "fbcdn.net" in parsed.netloc and "/emg" in parsed.path:
                qs = _up.parse_qs(parsed.query)
                inner = (qs.get("url") or [None])[0]
                if inner and inner.startswith(("http://", "https://")):
                    return inner
        except Exception:
            pass
        return og
    except Exception:
        return None


@router.get("/post-thumb")
def post_thumb(
    story_id: str = Query(
        "",
        description=(
            "Facebook effective_object_story_id, formatted as "
            "'{page_id}_{post_id}'. Either this or ig_url is required."
        ),
    ),
    ig_url: str = Query(
        "",
        description="Instagram permalink_url. used when the ad is IG-only.",
    ),
):
    """Resolve and serve the public thumbnail for an ad's underlying post.

    Tries (in order) the bare post-id URL, the canonical page/posts URL,
    and the embed plugin URL. The first that yields an og:image meta tag
    wins; the bytes are then disk-cached by the same machinery as
    ``/api/ads/img``. Returns 404 when none resolve, so the frontend can
    fall back to the Meta-CDN ``image_url`` proxy chain.
    """
    if not story_id and not ig_url:
        raise HTTPException(status_code=400, detail="story_id or ig_url required")

    # Cache key derived from input (not from the resolved og:image), so
    # we don't re-scrape on every render. Post URLs are stable forever
    # even when the og:image signature rotates.
    cache_seed = f"post-thumb:{story_id or ig_url}"
    digest = hashlib.sha256(cache_seed.encode("utf-8")).hexdigest()

    hit = _image_cache_lookup(digest)
    if hit is not None:
        path, ext = hit
        return FileResponse(
            path,
            media_type=_content_type_for_ext(ext),
            headers={**_IMG_CACHE_HEADERS, "X-Img-Source": "disk-cache"},
        )

    candidates: list[str] = []
    if ig_url:
        candidates.append(ig_url)
    if story_id and "_" in story_id:
        page_id, post_id = story_id.split("_", 1)
        # Bare post-id route. FB redirects to canonical permalink and
        # serves og:image inline. Works for most ad-only "dark" posts.
        candidates.append(f"https://www.facebook.com/{post_id}")
        candidates.append(f"https://www.facebook.com/{page_id}/posts/{post_id}")
        # FB-blessed unauth render. last resort.
        from urllib.parse import quote as _q
        embed_target = f"https://www.facebook.com/{page_id}/posts/{post_id}"
        candidates.append(
            "https://www.facebook.com/plugins/post.php?href=" + _q(embed_target, safe="")
        )

    og_url: Optional[str] = None
    for url in candidates:
        og_url = _scrape_og_image(url)
        if og_url:
            break

    if not og_url:
        return Response(
            status_code=404,
            content=_PIXEL_PNG,
            media_type="image/png",
            headers={
                "Cache-Control": "public, max-age=300",
                "X-Img-Fail-Kind": "no-og-image",
            },
        )

    try:
        import httpx

        # Googlebot UA: lookaside.fbsbx.com only serves image bytes to
        # crawlers. under a regular browser UA it returns an HTML stub.
        # The scontent CDN happily serves either way, so Googlebot is the
        # safer default for og:image hops across both hosts.
        og_fetch_headers = {
            "User-Agent": _OG_SCRAPE_HEADERS["User-Agent"],
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.facebook.com/",
        }
        # Tight timeout: real og:image fetches return in <2s. Anything
        # slower is the dead-fallback path and we want to fail fast so the
        # frontend chain can advance. Was 20s, which made misses feel
        # broken on the grid.
        with httpx.Client(
            timeout=6.0,
            follow_redirects=True,
            headers=og_fetch_headers,
        ) as client:
            resp = client.get(og_url)
        if resp.status_code != 200 or not resp.content:
            return Response(
                status_code=502,
                content=_PIXEL_PNG,
                media_type="image/png",
                headers={
                    "Cache-Control": "public, max-age=5",
                    "X-Upstream-Status": str(resp.status_code),
                    "X-Img-Fail-Kind": "og-fetch",
                },
            )
        if len(resp.content) < _PLACEHOLDER_BYTE_THRESHOLD:
            return Response(
                status_code=502, content=_PIXEL_PNG, media_type="image/png",
                headers={"Cache-Control": "public, max-age=5",
                         "X-Img-Fail-Kind": "og-placeholder-sized"},
            )
        content_sha = hashlib.sha256(resp.content).hexdigest()
        # Static hash-blacklist gate. known generic placeholders.
        if content_sha in _PLACEHOLDER_HASH_BLACKLIST:
            return Response(
                status_code=502, content=_PIXEL_PNG, media_type="image/png",
                headers={"Cache-Control": "public, max-age=60",
                         "X-Img-Fail-Kind": "og-placeholder-blacklisted"},
            )
        # Dimension gate. Meta sometimes serves a 16×16 / 32×32 stub for
        # archived posts. Real ad creatives are always ≥200px on both
        # sides; anything smaller is a placeholder regardless of hash.
        try:
            from PIL import Image as _Img  # noqa: WPS433
            with _Img.open(io.BytesIO(resp.content)) as _im:
                _w, _h = _im.size
            if min(_w, _h) < _MIN_USEFUL_DIMENSION:
                return Response(
                    status_code=502, content=_PIXEL_PNG, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=60",
                             "X-Img-Fail-Kind": "og-placeholder-tiny",
                             "X-Img-Fail-Dims": f"{_w}x{_h}"},
                )
        except Exception:
            pass
        # Runtime collision gate. pages without a creative-specific og:image
        # share the brand's hero social card across many ads. Track distinct
        # story_ids per content sha; once ≥ threshold, mark as a page-level
        # fallback and 502 forever (persisted across restarts).
        story_id_key = story_id or ig_url or ""
        if _record_post_thumb_observation(content_sha, story_id_key):
            return Response(
                status_code=502, content=_PIXEL_PNG, media_type="image/png",
                headers={"Cache-Control": "public, max-age=60",
                         "X-Img-Fail-Kind": "og-page-level-fallback",
                         "X-Collision-Hash": content_sha[:16]},
            )
        ct = resp.headers.get("content-type", "")
        if not ct.startswith("image/"):
            return Response(
                status_code=502,
                content=_PIXEL_PNG,
                media_type="image/png",
                headers={
                    "X-Img-Fail-Kind": "og-content-type",
                    "X-Upstream-Content-Type": ct[:60],
                },
            )
        ext = _ext_for_content_type(ct)
        path = os.path.join(IMAGE_CACHE_DIR, f"{digest}.{ext}")
        tmp = path + ".tmp"
        with open(tmp, "wb") as fp:
            fp.write(resp.content)
        os.replace(tmp, path)
        return Response(
            content=resp.content,
            media_type=_content_type_for_ext(ext),
            headers={**_IMG_CACHE_HEADERS, "X-Img-Source": "og-scrape"},
        )
    except Exception as e:
        return Response(
            status_code=502,
            content=_PIXEL_PNG,
            media_type="image/png",
            headers={
                "X-Img-Fail-Kind": "og-network",
                "X-Img-Fail-Detail": type(e).__name__,
            },
        )


@router.post("/prefetch-thumbs")
def prefetch_thumbs(payload: dict = Body(...)):
    """Warm post-thumb / img-by-ad disk caches for a list of ads.

    Body: ``{"items": [{"ad_id": "...", "brand": "...", "story_id": "..."}, ...]}``

    Skips items whose caches are already populated. Dispatches the rest
    into the global ``_PREFETCH_POOL`` and returns immediately. the call
    is fire-and-forget. The frontend uses this on grid mount + scroll so
    that by the time individual ``<img>`` requests arrive, bytes are
    already on disk and served in <5ms.
    """
    raw = payload.get("items") or []
    if not isinstance(raw, list):
        raise HTTPException(status_code=400, detail="items must be a list")

    queued_story = 0
    queued_ad = 0
    skipped_cached = 0
    fresh_story_ids: list[str] = []

    # Story-id pass. populate post-thumb cache where the ad has a
    # public post URL. Cheaper than img-by-ad (no Graph credits).
    seen_sids: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        sid = (item.get("story_id") or "").strip()
        if not sid or "_" not in sid or sid in seen_sids:
            continue
        seen_sids.add(sid)
        digest = hashlib.sha256(f"post-thumb:{sid}".encode("utf-8")).hexdigest()
        if _image_cache_lookup(digest) is not None:
            skipped_cached += 1
            continue
        fresh_story_ids.append(sid)

    # Cap the per-call fan-out so a 500-ad dump can't queue 500 background
    # fetches at once. The window the user is actually looking at is small.
    if fresh_story_ids:
        _start_post_thumb_prefetch(fresh_story_ids[:80])
        queued_story = min(len(fresh_story_ids), 80)

    # ad_id pass. img-by-ad fallback for ads without a story_id (DPA,
    # dark posts, dynamic-creative). Skipped when post-thumb already
    # covers it; we don't want both caches firing in parallel.
    import httpx
    seen_ad_ids: set[str] = set()
    fresh_ad: list[tuple[str, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        ad_id = (item.get("ad_id") or "").strip()
        brand = (item.get("brand") or "").strip()
        sid = (item.get("story_id") or "").strip()
        if not ad_id or not brand or ad_id in seen_ad_ids:
            continue
        seen_ad_ids.add(ad_id)
        # If post-thumb is already cached for the same ad, skip img-by-ad.
        if sid and "_" in sid:
            sd = hashlib.sha256(f"post-thumb:{sid}".encode("utf-8")).hexdigest()
            if _image_cache_lookup(sd) is not None:
                skipped_cached += 1
                continue
        d = hashlib.sha256(f"img-by-ad:{ad_id}:auto".encode("utf-8")).hexdigest()
        if _image_cache_lookup(d) is not None:
            skipped_cached += 1
            continue
        fresh_ad.append((ad_id, brand))

    def _warm_ad(ad_id: str, brand: str) -> None:
        try:
            with httpx.Client(timeout=10.0) as client:
                client.get(
                    "http://127.0.0.1:3001/api/ads/img-by-ad",
                    params={"ad_id": ad_id, "brand": brand, "kind": "auto"},
                )
        except Exception:
            pass

    for ad_id, brand in fresh_ad[:60]:
        _PREFETCH_POOL.submit(_warm_ad, ad_id, brand)
    queued_ad = min(len(fresh_ad), 60)

    return {
        "queued_story": queued_story,
        "queued_ad": queued_ad,
        "skipped_cached": skipped_cached,
        "received": len(raw),
    }


@router.get("/preview-iframe-src")
def preview_iframe_src(
    ad_id: str,
    ad_format: str = Query(
        "MOBILE_FEED_STANDARD",
        description="Meta preview format passed to /previews",
    ),
):
    """Return just the inner iframe src URL parsed from Meta's preview HTML.

    Matches ``/preview`` but skips serializing the full HTML body. the
    grid only needs the iframe src so it can render the rendered ad in
    place of "No preview". Hits the same in-process ``_preview_cache``
    so this is free for ads any other tab has previewed in the last hour.
    """
    cache_key = f"{ad_id}:{ad_format}"
    entry = _preview_cache.get(cache_key)
    body: Optional[str] = None
    if entry and (time.time() - entry[0]) < _PREVIEW_CACHE_TTL:
        body = (entry[1] or {}).get("body")

    if not body:
        token = os.environ.get("META_ACCESS_TOKEN")
        if not token:
            raise HTTPException(status_code=500, detail="META_ACCESS_TOKEN not configured")
        import httpx
        try:
            with httpx.Client(timeout=20.0) as client:
                r = client.get(
                    f"https://graph.facebook.com/{META_API_VERSION}/{ad_id}/previews",
                    params={"access_token": token, "ad_format": ad_format},
                )
            data = r.json()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Preview fetch failed: {e}")
        if isinstance(data, dict) and "error" in data:
            raise HTTPException(status_code=404, detail=str(data["error"].get("message") or data["error"]))
        previews = (data or {}).get("data") or []
        if not previews or not previews[0].get("body"):
            raise HTTPException(status_code=404, detail="No preview body available")
        body = previews[0]["body"]
        _preview_cache[cache_key] = (time.time(), {"body": body, "ad_format": ad_format})

    m = re.search(r'<iframe[^>]+src=["\']([^"\']+)["\']', body or "")
    if not m:
        raise HTTPException(status_code=404, detail="No iframe src in preview body")
    src = m.group(1).replace("&amp;", "&")
    return {"src": src}


@router.get("/creative/{ad_id}")
def get_creative(
    ad_id: str,
    brand: str,
    start: str,
    end: str,
):
    """Single ad with per-day performance over the date range."""
    accounts = _get_meta_accounts()
    account_id = accounts.get(brand)
    if not account_id:
        raise HTTPException(status_code=404, detail=f"Brand '{brand}' not in META_ACCOUNTS")

    token = os.environ.get("META_ACCESS_TOKEN")
    if not token:
        raise HTTPException(status_code=500, detail="META_ACCESS_TOKEN not configured")

    import requests as req

    # Daily performance. time_increment=1 + filter to this ad_id
    fields = (
        "ad_id,ad_name,date_start,date_stop,spend,impressions,clicks,ctr,cpc,cpm,"
        "actions,action_values"
    )
    params = {
        "access_token": token,
        "level": "ad",
        "time_range": json.dumps({"since": start, "until": end}),
        "time_increment": 1,
        "filtering": json.dumps([{"field": "ad.id", "operator": "IN", "value": [ad_id]}]),
        "fields": fields,
        "limit": 500,
    }
    data = _meta_insights_get(
        f"https://graph.facebook.com/{META_API_VERSION}/{account_id}/insights",
        params, timeout=120,
    )
    if "error" in data:
        raise HTTPException(status_code=502, detail=data["error"].get("message", "Meta API error"))

    daily = []
    for r in data.get("data", []):
        p = _parse_perf(r)
        p["date"] = r.get("date_start", "")
        daily.append(p)
    daily.sort(key=lambda r: r["date"])

    try:
        creative = _fetch_ad_creative(ad_id, token)
    except RateLimitedError as rle:
        raise HTTPException(
            status_code=503,
            detail=rle.message,
            headers={"Retry-After": str(rle.retry_after)},
        )

    # Attach a full-resolution image_url_hd when we can. the detail panel
    # prefers this over the stp-stripped image_url for crisp previews.
    try:
        img_hash = creative.get("image_hash")
        if img_hash:
            hash_urls = _fetch_image_hash_urls_bulk(account_id, [img_hash], token)
            info = hash_urls.get(img_hash) or {}
            hd = (
                info.get("url_full")
                or info.get("url_1080")
                or info.get("permalink_url")
            )
            if hd:
                creative["image_url_hd"] = hd
    except Exception as e:
        # Non-fatal. detail panel will fall back to image_url.
        print(f"[ad-analysis] hd resolve failed for ad {ad_id}: {e}", flush=True)

    # Aggregate totals
    total = {"spend": 0.0, "impressions": 0, "clicks": 0, "purchases": 0, "revenue": 0.0}
    for d in daily:
        total["spend"] += d["spend"]
        total["impressions"] += d["impressions"]
        total["clicks"] += d["clicks"]
        total["purchases"] += d["purchases"]
        total["revenue"] += d["revenue"]
    total["roas"] = round(total["revenue"] / total["spend"], 2) if total["spend"] > 0 else 0
    total["ctr"] = round((total["clicks"] / total["impressions"]) * 100, 2) if total["impressions"] > 0 else 0
    total["cpm"] = round((total["spend"] / total["impressions"]) * 1000, 2) if total["impressions"] > 0 else 0
    total["spend"] = round(total["spend"], 2)
    total["revenue"] = round(total["revenue"], 2)

    return {
        "ad_id": ad_id,
        "creative": creative,
        "daily": daily,
        "totals": total,
        "creative_hash": _creative_hash(creative),
        "is_video": bool(creative.get("video_id")),
    }


# Demographics breakdown cache. Meta returns a chunky payload per
# (ad_id, range) so we hold a small in-memory map to make tab-switches
# free. 15 min TTL matches the existing timeseries cache.
_demo_cache: dict[str, tuple[float, Any]] = {}
DEMO_CACHE_TTL = 900


@router.get("/creative/{ad_id}/breakdowns")
def get_creative_breakdowns(
    ad_id: str,
    brand: str,
    start: str,
    end: str,
):
    """Return age / gender breakdown rows for a single ad.

    Response shape:
        {
          "age":    [{bucket: "25-34", spend, impressions, purchases, revenue}, ...],
          "gender": [{bucket: "female", spend, impressions, purchases, revenue}, ...],
          "age_gender": [{age, gender, spend, impressions, purchases, revenue}, ...],
        }
    The stacked-bar charts on the detail panel render `age_gender` as
    one bar per age bucket, stacked by gender. The flat `age` / `gender`
    series are useful for headline numbers or simpler views.
    """
    cache_key = f"{brand}::{ad_id}::{start}::{end}"
    hit = _demo_cache.get(cache_key)
    if hit and (time.time() - hit[0]) <= DEMO_CACHE_TTL:
        return hit[1]

    accounts = _get_meta_accounts()
    account_id = accounts.get(brand)
    if not account_id:
        raise HTTPException(status_code=404, detail=f"Brand '{brand}' not in META_ACCOUNTS")
    token = os.environ.get("META_ACCESS_TOKEN")
    if not token:
        raise HTTPException(status_code=500, detail="META_ACCESS_TOKEN not configured")

    import requests as req

    def _fetch(breakdowns: str) -> list[dict]:
        params = {
            "access_token": token,
            "level": "ad",
            "time_range": json.dumps({"since": start, "until": end}),
            "filtering": json.dumps([{"field": "ad.id", "operator": "IN", "value": [ad_id]}]),
            "fields": "ad_id,spend,impressions,clicks,actions,action_values",
            "breakdowns": breakdowns,
            "limit": 500,
        }
        d = _meta_insights_get(
            f"https://graph.facebook.com/{META_API_VERSION}/{account_id}/insights",
            params, timeout=60,
        )
        if "error" in d:
            print(f"[ad-analysis] demo error {breakdowns} {ad_id}: {d['error']}", flush=True)
            return []
        return d.get("data") or []

    def _flatten(rows: list[dict], dim_keys: list[str]) -> list[dict]:
        out: list[dict] = []
        for r in rows:
            perf = _parse_perf(r)
            entry: dict = {
                "spend": round(perf.get("spend", 0), 2),
                "impressions": int(perf.get("impressions", 0)),
                "clicks": int(perf.get("clicks", 0)),
                "purchases": int(perf.get("purchases", 0)),
                "revenue": round(perf.get("revenue", 0), 2),
            }
            for k in dim_keys:
                v = r.get(k)
                entry[k] = str(v) if v is not None else "unknown"
            out.append(entry)
        return out

    age_rows = _flatten(_fetch("age"), ["age"])
    gender_rows = _flatten(_fetch("gender"), ["gender"])
    cross_rows = _flatten(_fetch("age,gender"), ["age", "gender"])

    # Surface the buckets the frontend expects: rename `age` → `bucket`
    # for the single-dim series so the chart code can use a uniform key.
    age = [{"bucket": r.pop("age"), **r} for r in age_rows]
    gender = [{"bucket": r.pop("gender"), **r} for r in gender_rows]

    # Sort age buckets by Meta's canonical ordering. Genders alphabetical.
    AGE_ORDER = ["13-17", "18-24", "25-34", "35-44", "45-54", "55-64", "65+", "unknown"]
    age.sort(key=lambda r: AGE_ORDER.index(r["bucket"]) if r["bucket"] in AGE_ORDER else 999)
    gender.sort(key=lambda r: r["bucket"])

    payload = {"age": age, "gender": gender, "age_gender": cross_rows}
    _demo_cache[cache_key] = (time.time(), payload)
    return payload


# Placement breakdown cache. different shape from demo, separate bucket.
_placement_cache: dict[str, tuple[float, Any]] = {}
PLACEMENT_CACHE_TTL = 900


@router.get("/creative/{ad_id}/placements")
def get_creative_placements(
    ad_id: str,
    brand: str,
    start: str,
    end: str,
):
    """Return performance broken down by publisher_platform × platform_position.

    Response shape:
        {
          "placements": [
            {"placement": "instagram/feed", "platform": "instagram", "position": "feed",
             "spend": 1234.56, "impressions": 12345, "clicks": 123, "purchases": 5,
             "revenue": 789.10, "roas": 0.64, "cpm": 100.05, "ctr": 0.99},
            ...
          ]
        }
    Sorted by spend desc so the busiest placements lead. ROAS/CPM/CTR
    derived server-side so the chart doesn't have to recompute on every
    metric toggle.
    """
    cache_key = f"{brand}::{ad_id}::{start}::{end}"
    hit = _placement_cache.get(cache_key)
    if hit and (time.time() - hit[0]) <= PLACEMENT_CACHE_TTL:
        return hit[1]

    accounts = _get_meta_accounts()
    account_id = accounts.get(brand)
    if not account_id:
        raise HTTPException(status_code=404, detail=f"Brand '{brand}' not in META_ACCOUNTS")
    token = os.environ.get("META_ACCESS_TOKEN")
    if not token:
        raise HTTPException(status_code=500, detail="META_ACCESS_TOKEN not configured")

    params = {
        "access_token": token,
        "level": "ad",
        "time_range": json.dumps({"since": start, "until": end}),
        "filtering": json.dumps([{"field": "ad.id", "operator": "IN", "value": [ad_id]}]),
        "fields": "ad_id,spend,impressions,clicks,actions,action_values",
        "breakdowns": "publisher_platform,platform_position",
        "limit": 500,
    }
    d = _meta_insights_get(
        f"https://graph.facebook.com/{META_API_VERSION}/{account_id}/insights",
        params, timeout=60,
    )
    if "error" in d:
        raise HTTPException(status_code=502, detail=d["error"].get("message", "Meta API error"))

    placements: list[dict] = []
    for row in d.get("data", []) or []:
        perf = _parse_perf(row)
        spend = float(perf.get("spend", 0) or 0)
        impressions = int(perf.get("impressions", 0) or 0)
        clicks = int(perf.get("clicks", 0) or 0)
        purchases = int(perf.get("purchases", 0) or 0)
        revenue = float(perf.get("revenue", 0) or 0)
        platform = str(row.get("publisher_platform") or "unknown")
        position = str(row.get("platform_position") or "unknown")
        placements.append({
            "placement": f"{platform}/{position}",
            "platform": platform,
            "position": position,
            "spend": round(spend, 2),
            "impressions": impressions,
            "clicks": clicks,
            "purchases": purchases,
            "revenue": round(revenue, 2),
            "roas": round(revenue / spend, 2) if spend > 0 else 0,
            "cpm": round((spend / impressions) * 1000, 2) if impressions > 0 else 0,
            "ctr": round((clicks / impressions) * 100, 2) if impressions > 0 else 0,
            "cpa": round(spend / purchases, 2) if purchases > 0 else 0,
        })
    placements.sort(key=lambda p: p["spend"], reverse=True)

    payload = {"placements": placements}
    _placement_cache[cache_key] = (time.time(), payload)
    return payload


# Video play curve cache. keyed by (brand, ad_id, range).
_video_curve_cache: dict[str, tuple[float, Any]] = {}
VIDEO_CURVE_CACHE_TTL = 900


@router.get("/creative/{ad_id}/video-curve")
def get_video_play_curve(
    ad_id: str,
    brand: str,
    start: str,
    end: str,
):
    """Return per-second video retention as ``{points: [{second, viewers}, ...]}``.

    Meta's ``video_play_curve_actions`` is the same data the Ads Manager
    retention chart uses: a list of {action_type, value} pairs where
    `value` is the number of viewers still watching at each integer
    second. We project it into the shape the chart wants and stop at
    the end of the video (Meta returns trailing zeros for some ads).
    """
    cache_key = f"{brand}::{ad_id}::{start}::{end}"
    hit = _video_curve_cache.get(cache_key)
    if hit and (time.time() - hit[0]) <= VIDEO_CURVE_CACHE_TTL:
        return hit[1]

    accounts = _get_meta_accounts()
    account_id = accounts.get(brand)
    if not account_id:
        raise HTTPException(status_code=404, detail=f"Brand '{brand}' not in META_ACCOUNTS")
    token = os.environ.get("META_ACCESS_TOKEN")
    if not token:
        raise HTTPException(status_code=500, detail="META_ACCESS_TOKEN not configured")

    params = {
        "access_token": token,
        "level": "ad",
        "time_range": json.dumps({"since": start, "until": end}),
        "filtering": json.dumps([{"field": "ad.id", "operator": "IN", "value": [ad_id]}]),
        "fields": "video_play_curve_actions",
        "limit": 1,
    }
    d = _meta_insights_get(
        f"https://graph.facebook.com/{META_API_VERSION}/{account_id}/insights",
        params, timeout=60,
    )
    if "error" in d:
        raise HTTPException(status_code=502, detail=d["error"].get("message", "Meta API error"))

    rows = d.get("data") or []
    if not rows:
        payload = {"points": []}
        _video_curve_cache[cache_key] = (time.time(), payload)
        return payload

    curve_actions = rows[0].get("video_play_curve_actions") or []
    # Meta returns one entry per action_type ('video_view' usually).
    # Each entry has `value` as a JSON array of integers (viewers per
    # second). Older shapes use `values` instead. handle both.
    points: list[dict] = []
    for entry in curve_actions:
        raw = entry.get("value") or entry.get("values")
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except Exception:
                raw = []
        if not isinstance(raw, list):
            continue
        for second, viewers in enumerate(raw):
            try:
                viewers_n = int(viewers)
            except Exception:
                viewers_n = 0
            points.append({"second": second, "viewers": viewers_n})
        break  # one curve is enough

    # Trim trailing zeros. Meta sometimes pads to the longest video in
    # the placement set; the curve hits 0 at the actual end of the video.
    while points and points[-1]["viewers"] == 0 and len(points) > 1:
        points.pop()

    payload = {"points": points}
    _video_curve_cache[cache_key] = (time.time(), payload)
    return payload


def _render_ground_truth(local: Optional[dict]) -> str:
    """Format local_extract output as a prompt section Haiku can read.

    Returns a paragraph the prompt template inlines verbatim. Falls back
    to a "no local extraction" stub so the {ground_truth} placeholder is
    always satisfied. Empty/missing OCR shows up as "(no text detected)"
    so Haiku knows it should write "none" for textOverlay rather than
    re-extracting.
    """
    if not local:
        return "GROUND TRUTH FROM LOCAL EXTRACTION: (unavailable. extract from image directly)"

    dims = local.get("dimensions") or {}
    w, h = dims.get("width", 0), dims.get("height", 0)
    aspect = dims.get("aspect_ratio") or "Unknown"
    pq = local.get("production_quality") or "Unknown"
    sharpness = local.get("sharpness")
    colors = local.get("colors") or []

    ocr = (local.get("ocr") or {})
    placements = ocr.get("text_placements") or []

    lines = [
        "GROUND TRUTH FROM LOCAL EXTRACTION (use these values verbatim. do not re-extract):",
        f"  • image dimensions: {w}x{h}px",
        f"  • aspectRatio: {aspect}",
        f"  • productionQuality (heuristic from sharpness {sharpness} + resolution): {pq}",
    ]

    if colors:
        lines.append(f"  • colors[] (in order, dominant first): {colors}")

    if placements:
        lines.append("  • text placements (use ALL of these for compositionAnalysis.textPlacements[]):")
        for i, p in enumerate(placements):
            lines.append(
                f"     {i+1}. text={p['text']!r} position={p['position']!r} scale={p['scale']!r} confidence={p['confidence']}"
            )
        joined = ocr.get("text_overlay") or ""
        lines.append(f"  • textOverlay (joined verbatim, preserve order): {joined!r}")
    else:
        lines.append("  • textOverlay: (no text detected. set to \"none\")")
        lines.append("  • compositionAnalysis.textPlacements[]: []")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Deep-analysis prompt. mirrors bulk-ad-analyzer FileAnalysis shape
# ---------------------------------------------------------------------------

_DEEP_ANALYSIS_PROMPT = """You are a senior performance-creative strategist analyzing a Meta paid social ad.

{context}

{ground_truth}

Return ONLY a single JSON object (no prose, no code fences) matching this exact TypeScript interface:

interface FileAnalysis {{
  // Core Strategy
  angle: string;               // The strategic angle / value-prop framing (e.g. "Risk reversal", "Community belonging")
  hook: string;                // The attention grab in the first 1-2s. what makes someone stop scrolling
  concept: string;             // The core creative idea in 1-2 sentences
  persona: string;             // Who this ad is aimed at. 1-2 sentences of audience archetype
  brand: string;               // Brand name if visible/known

  // Audience (visual cues)
  demographics: string;        // Age range, gender skew, income tier, lifestyle markers

  // Funnel & Offer
  offer: string;               // The specific offer/promotion if any, else a brief description of what's being sold

  // Copy Breakdown
  headline: string;            // Main headline (from image or provided text)
  bodyCopy: string;            // Supporting body text
  cta: string;                 // Call-to-action text

  // Visual & Production
  style: "Minimalist" | "Bold/Vibrant" | "Editorial" | "UGC" | "Product-Centric" | "Lifestyle" | "Infographic" | "Luxury" | "Vintage" | "Modern";
  template: "UGC" | "Product Feature" | "Us vs. Them" | "Text Overlay" | "Testimonial/Quote" | "Meme/Viral" | "Explainer/Demo" | "Before & After" | "Problem/Solution" | "Lifestyle" | "Brand Story" | "Influencer Marketing" | "Animation" | "Other" | "N/A";
  productionQuality: "High" | "Medium" | "Low" | "Unknown";
  layoutDescription: string;   // 1-2 sentences describing layout, framing, focal point
  textOverlay: string;         // Verbatim on-image copy, or "none"
  colors: string[];            // 3-6 dominant colors (hex like "#E87A2D" preferred, or color names)
  products: string[];          // Specific product names visible

  // Detailed composition
  compositionAnalysis: {{
    subjectBoundingBox: {{ x: number, y: number, width: number, height: number }};  // 0-1 normalized coords of primary subject
    textPlacements: Array<{{
      text: string;                      // the actual text
      type: string;                      // "headline" | "subheadline" | "cta" | "logo" | "disclaimer" | etc.
      placementDescription: string;      // "top-center", "lower-third left-aligned", etc.
      scaleDescription: string;          // "dominant", "medium", "small"
      fontStyleDescription: string;      // "bold sans-serif", "elegant serif italic", etc.
    }}>;
    negativeSpaceDescription: string;    // where empty/breathing room is and how it's used
    overallComposition: string;          // 1-2 sentences on rule-of-thirds, symmetry, visual hierarchy
  }};

  // Technical
  format: string;              // "Static image", "Video thumbnail", "Carousel", "GIF", etc.
  aspectRatio: string;         // "1:1", "4:5", "9:16", "16:9"
  intendedPlacement: "Feed" | "Story/Reels" | "News Feed" | "Meta Audience Network" | "Unknown";

  // Thematic (visual)
  emotion: "Trust" | "Excitement" | "Urgency" | "Calm" | "Sophistication" | "Humor" | "Inspiration" | "Confidence" | "Desire" | "Nostalgia";
  category: string;            // Product category (e.g. "Skincare", "Apparel", "SaaS")
  collection: string;          // Specific product line if applicable
  tags: string[];              // 5-10 descriptive tags useful for filtering

  // Performance & Differentiation scores (vision-derived)
  creativeClarityScore: number;         // 0-100. how clearly the value prop is communicated
  creativeClarityFeedback: string;      // 1-2 sentences explaining the score with concrete reasoning
  visualDifferentiationScore: number;   // 0-100. how visually distinct / scroll-stopping vs. typical Meta ads in this vertical
  visualDifferentiationSummary: string; // 1-2 sentences on what makes the visual (or doesn't)
}}

STRICT RULES:
1. Scores (0-100):
   - creativeClarityScore: A simple "Product on White" with no text/context = 10-40. Clear value prop + strong hook + coherent visual hierarchy = 70-95. Reserve 90+ for genuinely standout work.
   - visualDifferentiationScore: 10-30 if this looks like a generic category shot (white bg, studio product photo with stock text). 40-65 if there's 1 distinguishing choice (bold color, unusual angle, personality). 70-90 if the visual would stop a scroll in the category feed. Reserve 90+ for genuinely disruptive work.
2. Use ONLY the enum values specified. If uncertain, use "Unknown" where allowed, else pick the closest enum value.
3. compositionAnalysis.subjectBoundingBox: all four values MUST be between 0 and 1 (normalized to image dimensions). x,y are top-left corner.
4. Return every field. if a field is genuinely not applicable, use "N/A" for strings, [] for arrays. Scores must always be an honest estimate (never 0 as a cop-out).
5. Base everything on what you actually see. no platitudes, no generic advice.
6. Output ONLY the JSON object. No prose before or after. No code fences.
7. **GROUND-TRUTH FIELDS**. when local-extraction values are provided above, use them VERBATIM:
   - `textOverlay`: copy the OCR'd text verbatim (preserve casing, line breaks). Don't paraphrase. If "(no text detected)", set "none".
   - `compositionAnalysis.textPlacements[]`: build one entry per OCR region using the supplied text/position/scale. You still write `type` (headline/cta/disclaimer/etc) and `fontStyleDescription` based on visual inspection.
   - `colors[]`: copy the supplied hex codes verbatim, in order. Do not invent hexes.
   - `aspectRatio`: copy the supplied ratio verbatim.
   - `productionQuality`: the supplied value is a heuristic from sharpness + resolution; you MAY override based on lighting / styling / composition, but only if you have strong visual reason.
"""


# Text-only prompt. runs in parallel with the vision call. The 7 fields it
# produces are copy-driven (Schwartz framework, sentiment, funnel position,
# messaging differentiation, marketing moment). none of them require seeing
# the image. Splitting them off slims the vision call's output by ~25% and
# lets the work run in parallel.
_TEXT_ONLY_PROMPT = """You are a senior performance-creative strategist analyzing the COPY of a Meta paid social ad.

{context}

{ocr_overlay}

Return ONLY a single JSON object (no prose, no code fences) matching this exact TypeScript interface:

interface CopyAnalysis {{
  // Audience & Market. Eugene Schwartz framework, derived from copy alone
  marketAwareness: "Unaware" | "Problem Aware" | "Solution Aware" | "Product Aware" | "Most Aware" | "Unknown";
  marketSophistication: "Level 1: First in Market" | "Level 2: Competition Arrives" | "Level 3: Feature/Mechanism" | "Level 4: Elaboration/Experience" | "Level 5: Identification";

  // Funnel position. inferred from CTA + offer structure
  funnelPosition: "Awareness" | "TOF" | "MOF" | "BOF" | "Reactivation" | "Unknown";

  // Tone of the copy
  sentiment: "Positive" | "Neutral" | "Negative" | "Urgent" | "Inspirational" | "Informative" | "Humorous";

  // Seasonal / event hook present in the copy (e.g. "Black Friday", "New Year", or "Evergreen")
  marketingMoment: string;

  // Messaging differentiation. copy-only, ignore the visual
  messagingDifferentiationScore: number;     // 0-100. how distinct the copy angle is vs. generic category messaging
  messagingDifferentiationSummary: string;   // 1-2 sentences on what makes the messaging stand out (or doesn't)
}}

STRICT RULES:
1. messagingDifferentiationScore: 10-30 if the copy could live on any competitor's ad ("Shop now", "Premium quality"). 40-65 if there's a distinct angle or voice. 70-90 if the hook/angle is specific and unowned. 90+ for genuinely category-defining messaging.
2. Use ONLY the enum values specified.
3. Output ONLY the JSON object. No prose. No fences.
"""

# Fields produced by the text-only call. used to merge results back into the
# combined FileAnalysis dict that the cache expects.
_TEXT_ONLY_FIELDS = (
    "marketAwareness",
    "marketSophistication",
    "funnelPosition",
    "sentiment",
    "marketingMoment",
    "messagingDifferentiationScore",
    "messagingDifferentiationSummary",
)

# Default values used when the text-only call fails. keeps the analysis
# entry shape stable so downstream filters/columns don't break.
_TEXT_ONLY_DEFAULTS = {
    "marketAwareness": "Unknown",
    "marketSophistication": "Level 2: Competition Arrives",
    "funnelPosition": "Unknown",
    "sentiment": "Neutral",
    "marketingMoment": "Evergreen",
    "messagingDifferentiationScore": 0,
    "messagingDifferentiationSummary": "Text-only analysis unavailable.",
}


def _build_text_only_context(
    brand: str,
    ad_name: str,
    title: str,
    body_text: str,
    cta: str,
    is_video: bool,
) -> str:
    bits = []
    if brand:
        bits.append(f"Brand: {brand}")
    if ad_name:
        bits.append(f"Ad name: {ad_name}")
    if title:
        bits.append(f"Headline: {title}")
    if body_text:
        bits.append(f"Body copy: {body_text}")
    if cta:
        bits.append(f"CTA: {cta}")
    if is_video:
        bits.append("Format: video ad")
    return "\n".join(bits) if bits else "(No copy provided.)"


def _build_context(brand: str, ad_name: str, title: str, body_text: str, is_video: bool) -> str:
    bits = []
    if brand:
        bits.append(f"Brand: {brand}")
    if ad_name:
        bits.append(f"Ad name: {ad_name}")
    if title:
        bits.append(f"Headline (provided): {title}")
    if body_text:
        bits.append(f"Body copy (provided): {body_text}")
    if is_video:
        bits.append("NOTE: this is a VIDEO ad. you're seeing the thumbnail frame only.")
    return "\n".join(bits) if bits else "(No additional context provided. analyze purely from the image.)"


@router.post("/analyze")
def analyze_creative(
    ad_id: str,
    brand: str,
    force: bool = False,
    payload: dict = Body(default={}),
):
    """Run Claude Haiku vision analysis on an ad's creative.

    Produces the full FileAnalysis schema (~30 fields) matching
    bulk-ad-analyzer's types.ts. Cached by (ad_id, creative_hash,
    schema_version) so rotating creatives re-analyze automatically,
    stable ones don't, and schema bumps invalidate stale entries.

    Body may contain { image_url, thumbnail_url, title, body, ad_name,
    is_video, brand } so the frontend doesn't need to round-trip back to
    /creative/{ad_id} just to analyze. If omitted, we fetch from Meta.
    """
    # Resolve creative. trust payload if it carries a URL, else fetch
    image_url: Optional[str] = payload.get("image_url") or payload.get("thumbnail_url")
    title = payload.get("title", "")
    body_text = payload.get("body", "")
    ad_name = payload.get("ad_name", "")
    is_video = bool(payload.get("is_video"))
    creative_hash = payload.get("creative_hash")
    story_id: Optional[str] = payload.get("effective_object_story_id")

    if not image_url:
        token = os.environ.get("META_ACCESS_TOKEN")
        if not token:
            raise HTTPException(status_code=500, detail="META_ACCESS_TOKEN not configured")
        try:
            creative = _fetch_ad_creative(ad_id, token)
        except RateLimitedError as rle:
            raise HTTPException(
                status_code=503,
                detail=rle.message,
                headers={"Retry-After": str(rle.retry_after)},
            )
        image_url = creative.get("image_url") or creative.get("thumbnail_url")
        title = title or creative.get("title", "")
        body_text = body_text or creative.get("body", "")
        ad_name = ad_name or creative.get("ad_name", "")
        is_video = bool(creative.get("video_id"))
        creative_hash = creative_hash or _creative_hash(creative)
        story_id = story_id or creative.get("effective_object_story_id")

    if not image_url:
        raise HTTPException(status_code=400, detail="No image or thumbnail available for this creative")
    if not creative_hash:
        # Last-ditch. synthesize something stable off the image URL so
        # the cache still keys uniquely rather than colliding.
        creative_hash = hashlib.sha256(image_url.encode()).hexdigest()[:16]

    cache = _load_analysis_cache()
    # Cache key is now the creative_hash alone (schema v4+). Multiple
    # ads that share one creative all resolve to the same entry.
    cache_key = creative_hash
    existing = cache.get(cache_key)
    if (
        not force
        and existing
        and "analysis" in existing
        and existing.get("schema_version") == ANALYSIS_SCHEMA_VERSION
    ):
        return existing

    try:
        client = _get_anthropic_client()

        # Resolve image bytes *once*, then build both the local-extract
        # pipeline input and the Haiku image_block from the same source.
        # Two paths: disk cache (preferred. usually warm) or live fetch.
        image_bytes: Optional[bytes] = None
        image_mime: str = "image/jpeg"

        cached = _ad_img_disk_cached_bytes(ad_id, story_id)
        if cached:
            image_bytes, image_mime = cached
        else:
            try:
                block = _image_content_block(image_url)
                image_bytes = base64.b64decode(block["source"]["data"])
                image_mime = block["source"].get("media_type") or "image/jpeg"
            except HTTPException as img_err:
                # Stale Meta CDN signature → refresh once via a force Graph
                # fetch. Usually wins; sometimes the underlying asset is
                # placeholder-served by Meta (DPA / deleted creative) and
                # the retry also 403s. we surface the original error.
                token = os.environ.get("META_ACCESS_TOKEN")
                refreshed_url: Optional[str] = None
                if token and img_err.status_code in (502, 503):
                    try:
                        fresh = _fetch_ad_creative(ad_id, token, force=True)
                        refreshed_url = (
                            fresh.get("image_url_hd")
                            or fresh.get("image_url")
                            or fresh.get("thumbnail_url")
                        )
                    except Exception:
                        refreshed_url = None
                if not refreshed_url or refreshed_url == image_url:
                    raise
                try:
                    block = _image_content_block(refreshed_url)
                    image_bytes = base64.b64decode(block["source"]["data"])
                    image_mime = block["source"].get("media_type") or "image/jpeg"
                    image_url = refreshed_url
                except HTTPException:
                    raise img_err

        # Resize once for both downstream consumers. _maybe_resize is a
        # no-op when the image is already under MAX_IMAGE_DIMENSION.
        image_bytes, image_mime = _maybe_resize(image_bytes or b"", image_mime)

        # Local pre-extraction (OCR + colors + dims + sharpness). Cheap
        # (~1s on warm engine), entirely local, and the output goes into
        # the Haiku prompt as ground truth. Best-effort: a failure here
        # doesn't block the LLM call, Haiku just falls back to extracting
        # those fields itself.
        local_data: Optional[dict] = None
        try:
            from local_extract import extract_local
            local_data = extract_local(image_bytes)
        except Exception as e:
            print(f"[analyze] local extract failed for {ad_id}: {e}", flush=True)

        ctx = _build_context(brand, ad_name, title, body_text, is_video)
        prompt = _DEEP_ANALYSIS_PROMPT.format(
            context=ctx,
            ground_truth=_render_ground_truth(local_data),
        )

        image_block = {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": image_mime,
                "data": base64.b64encode(image_bytes).decode("ascii"),
            },
        }

        # ----- Text-only Haiku call (parallel with vision) ---------------
        # 7 copy-driven fields (Schwartz framework, sentiment, funnel, msg
        # differentiation, marketing moment) don't need the image. Run them
        # in a separate small text-only call concurrently with the vision
        # call. Net effect: vision call output schema shrinks by ~25% (so
        # finishes faster) and text-only finishes well before the vision
        # call does.
        cta_text = ""
        try:
            from anthropic import Anthropic  # noqa: F401. only for typing
        except Exception:
            pass
        # OCR overlay context for text-only. gives the LLM the on-image
        # copy too, not just the headline/body fields, so its messaging
        # analysis is grounded in everything the viewer reads.
        ocr_overlay = ""
        if local_data:
            ot = (local_data.get("ocr") or {}).get("text_overlay") or ""
            if ot:
                ocr_overlay = f"On-image text (OCR'd verbatim):\n{ot}"
        text_ctx = _build_text_only_context(brand, ad_name, title, body_text, cta_text, is_video)
        text_prompt = _TEXT_ONLY_PROMPT.format(context=text_ctx, ocr_overlay=ocr_overlay)

        def _run_text_only() -> Optional[dict]:
            try:
                t = time.time()
                m = client.messages.create(
                    model=HAIKU_MODEL,
                    max_tokens=1500,
                    messages=[
                        {"role": "user", "content": [{"type": "text", "text": text_prompt}]},
                        {"role": "assistant", "content": "{"},
                    ],
                )
                txt_parts = [getattr(b, "text", "") for b in m.content if getattr(b, "text", None)]
                txt_raw = "\n".join(txt_parts).strip()
                if txt_raw and not txt_raw.lstrip().startswith("{"):
                    txt_raw = "{" + txt_raw
                parsed = _extract_json_object(txt_raw) or _try_close_truncated_json(txt_raw)
                if isinstance(parsed, dict):
                    parsed["_text_only_latency_ms"] = int((time.time() - t) * 1000)
                    return parsed
            except Exception as te:
                print(f"[analyze] text-only call failed for {ad_id}: {te}", flush=True)
            return None

        text_future = _ANALYZE_POOL.submit(_run_text_only)

        # Prefill the assistant turn with "{". Anthropic lets us seed the
        # response so the model is forced to continue a valid JSON object
        # instead of prefixing prose / code fences.
        base_messages = [
            {
                "role": "user",
                "content": [
                    image_block,
                    {"type": "text", "text": prompt},
                ],
            },
            {"role": "assistant", "content": "{"},
        ]

        t0 = time.time()
        msg = client.messages.create(
            model=HAIKU_MODEL,
            max_tokens=6000,
            messages=base_messages,
        )
        latency_ms = int((time.time() - t0) * 1000)

        parts = [getattr(b, "text", "") for b in msg.content if getattr(b, "text", None)]
        raw = "\n".join(parts).strip()
        stop_reason = getattr(msg, "stop_reason", None)

        # Because we prefilled "{", the model's continuation omits the
        # opening brace. Restore it so our extractor / json.loads see a
        # complete object. If Claude decided to include "{" anyway, don't
        # double it up.
        if raw and not raw.lstrip().startswith("{"):
            raw = "{" + raw

        analysis = _extract_json_object(raw)
        # Fallback: try the truncated-JSON repairer if normal extraction failed.
        # Common cause is Haiku hitting max_tokens mid-object. stop_reason
        # will be 'max_tokens' and the JSON ends abruptly.
        if not isinstance(analysis, dict):
            repaired = _try_close_truncated_json(raw)
            if isinstance(repaired, dict):
                analysis = repaired
                analysis["_repaired"] = True

        # Retry once with a tighter, strict-JSON prompt if prefill + repair
        # both failed. A single retry is cheap and kills the long tail of
        # malformed responses. we stop here even if the retry fails to
        # avoid an infinite loop on genuinely impossible inputs.
        retried = False
        if not isinstance(analysis, dict):
            retried = True
            retry_prompt = (
                "Your previous response was unparseable. Output ONLY valid JSON "
                "matching the FileAnalysis schema below. Do NOT include any "
                "explanation, prose, or markdown code fences. Start your "
                "response with `{` and end with `}`.\n\n"
                + prompt
            )
            try:
                t1 = time.time()
                msg2 = client.messages.create(
                    model=HAIKU_MODEL,
                    max_tokens=6000,
                    messages=[
                        {
                            "role": "user",
                            "content": [
                                image_block,
                                {"type": "text", "text": retry_prompt},
                            ],
                        },
                        {"role": "assistant", "content": "{"},
                    ],
                )
                latency_ms += int((time.time() - t1) * 1000)
                parts2 = [getattr(b, "text", "") for b in msg2.content if getattr(b, "text", None)]
                raw2 = "\n".join(parts2).strip()
                stop_reason = getattr(msg2, "stop_reason", stop_reason)
                if raw2 and not raw2.lstrip().startswith("{"):
                    raw2 = "{" + raw2
                analysis = _extract_json_object(raw2)
                if not isinstance(analysis, dict):
                    repaired = _try_close_truncated_json(raw2)
                    if isinstance(repaired, dict):
                        analysis = repaired
                        analysis["_repaired"] = True
                if isinstance(analysis, dict):
                    analysis["_retried"] = True
                # If retry gave us nothing, keep `raw2` as the surfaced
                # payload for the final error entry.
                if not isinstance(analysis, dict):
                    raw = raw2
            except Exception as retry_err:
                print(
                    f"[analyze] retry failed for ad {ad_id}: {retry_err}",
                    flush=True,
                )

        if not isinstance(analysis, dict):
            print(
                f"[analyze] JSON parse failed for ad {ad_id} (stop={stop_reason}, "
                f"len={len(raw)}, retried={retried}). First 400 chars:\n"
                f"{raw[:400]}\n...last 200:\n{raw[-200:]}",
                flush=True,
            )
            analysis = {
                "raw": raw[:2000],
                "error": "Claude response was not valid JSON",
                "stop_reason": stop_reason,
            }

        # Wait on the parallel text-only call. By now the vision call has
        # finished, so the text-only result should already be ready (text
        # call is much smaller and finishes first ~always).
        text_result: Optional[dict] = None
        try:
            text_result = text_future.result(timeout=30)
        except Exception as te:
            print(f"[analyze] text-only future failed for {ad_id}: {te}", flush=True)
            text_result = None

        # Merge text-only fields into the vision analysis. If the text
        # call failed, fill those keys with explicit defaults so downstream
        # filters/columns don't see undefined values. The vision call's
        # output schema doesn't include these keys.
        if isinstance(analysis, dict) and "error" not in analysis:
            text_latency = 0
            for key in _TEXT_ONLY_FIELDS:
                if isinstance(text_result, dict) and key in text_result:
                    analysis[key] = text_result[key]
                else:
                    analysis[key] = _TEXT_ONLY_DEFAULTS[key]
            if isinstance(text_result, dict):
                text_latency = int(text_result.get("_text_only_latency_ms") or 0)
            analysis["_text_only_latency_ms"] = text_latency
            if text_result is None:
                analysis["_text_only_failed"] = True

        entry = {
            "ad_id": ad_id,
            "creative_hash": creative_hash,
            "image_url": image_url,
            "is_video": is_video,
            "analysis": analysis,
            "analyzed_at": int(time.time()),
            "schema_version": ANALYSIS_SCHEMA_VERSION,
            "model": HAIKU_MODEL,
            "latency_ms": latency_ms,
        }
        # Re-read under the lock so concurrent workers don't lose each other's
        # entries. The earlier `cache` snapshot can be stale by the time we
        # finish the LLM round-trip. only the merge-and-save needs to be
        # serialized, not the analysis itself.
        with _CACHE_LOCK:
            fresh_cache = _load_analysis_cache()
            prior = fresh_cache.get(cache_key)
            # Preserve any existing focus_group entries on re-analysis
            if isinstance(prior, dict) and isinstance(prior.get("focus_group"), dict):
                entry["focus_group"] = prior["focus_group"]
            elif existing and isinstance(existing.get("focus_group"), dict):
                entry["focus_group"] = existing["focus_group"]
            fresh_cache[cache_key] = entry
            _save_analysis_cache(fresh_cache)
        return entry

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Claude analysis failed: {e}")


@router.post("/analyze-if-missing")
def analyze_if_missing(payload: dict = Body(default={})):
    """Synchronously analyze any creatives whose hash isn't already cached.

    Body:
        {
            "brand": "Canoopsy",
            "creatives": [
                {
                    "ad_id": "120..." ,
                    "creative_hash": "abc123..." ,    # optional. computed if missing
                    "image_url": "https://...",
                    "thumbnail_url": "https://...",   # optional fallback
                    "ad_name": "...",
                    "title": "...",
                    "body": "...",
                    "is_video": false,
                    "image_hash": "...",              # used to compute hash if creative_hash missing
                    "video_id": "...",
                    "creative_name": "..."
                },
                ...
            ]
        }

    For every creative whose hash isn't already in the cache at the
    current schema version, run analyze_creative synchronously. Returns:

        {
            "analyzed": <int>,
            "cached":   <int>,
            "failed":   <int>,
            "results":  [ {creative_hash, ad_id, status: "analyzed|cached|failed", error?} ]
        }

    Intended for the Creative Planner: when new creatives enter the
    system, kick this endpoint so the analysis is ready by the time
    the user opens the Ad Analysis tab. Safe to call repeatedly. the
    cache short-circuits already-analyzed creatives.
    """
    brand = payload.get("brand") or ""
    creatives = payload.get("creatives") or []
    if not isinstance(creatives, list) or not creatives:
        raise HTTPException(status_code=400, detail="creatives[] required")

    cache = _load_analysis_cache()
    cached_results: list[dict] = []
    pending: list[tuple[str, str, dict]] = []  # (creative_hash, ad_id, payload)

    for c in creatives:
        if not isinstance(c, dict):
            continue
        ad_id = c.get("ad_id") or ""
        creative_hash = c.get("creative_hash")
        if not creative_hash:
            creative_hash = _compute_creative_hash(c)

        existing = cache.get(creative_hash)
        if (
            existing
            and isinstance(existing, dict)
            and "analysis" in existing
            and existing.get("schema_version") == ANALYSIS_SCHEMA_VERSION
        ):
            cached_results.append({
                "creative_hash": creative_hash,
                "ad_id": ad_id,
                "status": "cached",
            })
            continue

        analyze_payload = {
            "image_url": c.get("image_url"),
            "thumbnail_url": c.get("thumbnail_url"),
            "title": c.get("title", ""),
            "body": c.get("body", ""),
            "ad_name": c.get("ad_name", ""),
            "is_video": bool(c.get("is_video")),
            "creative_hash": creative_hash,
        }
        pending.append((creative_hash, ad_id, analyze_payload))

    # Dedupe pending by creative_hash. multiple ads can share one creative,
    # and we only want one Haiku call per unique creative. Subsequent ads on
    # the same hash will see the cache populated and short-circuit.
    seen_hashes: set[str] = set()
    deduped: list[tuple[str, str, dict]] = []
    duplicate_followups: list[tuple[str, str]] = []
    for ch, aid, pl in pending:
        if ch in seen_hashes:
            duplicate_followups.append((ch, aid))
            continue
        seen_hashes.add(ch)
        deduped.append((ch, aid, pl))

    def _run_one(ch: str, aid: str, pl: dict) -> dict:
        try:
            analyze_creative(
                ad_id=aid or ch,
                brand=brand,
                force=False,
                payload=pl,
            )
            return {"creative_hash": ch, "ad_id": aid, "status": "analyzed"}
        except HTTPException as he:
            print(f"[analyze-if-missing] http err ad={aid} hash={ch}: {he.detail}", flush=True)
            return {
                "creative_hash": ch,
                "ad_id": aid,
                "status": "failed",
                "error": str(he.detail),
            }
        except Exception as e:  # noqa: BLE001
            import traceback
            print(
                f"[analyze-if-missing] exc ad={aid} hash={ch}: "
                f"{type(e).__name__}: {e}\n{traceback.format_exc()}",
                flush=True,
            )
            return {
                "creative_hash": ch,
                "ad_id": aid,
                "status": "failed",
                "error": f"{type(e).__name__}: {e}",
            }

    # Concurrency cap. 10 sits comfortably within Anthropic's per-key
    # rate limits when paired with the shared module-level client (which
    # multiplexes httpx requests over a stable connection pool). Earlier
    # testing at 12 with per-worker clients caused parallel TLS
    # handshake contention; sharing one client neutralized that.
    max_workers = min(10, max(1, len(deduped)))
    parallel_results: list[dict] = []
    if deduped:
        with ThreadPoolExecutor(max_workers=max_workers) as ex:
            futures = [ex.submit(_run_one, ch, aid, pl) for ch, aid, pl in deduped]
            for fut in as_completed(futures):
                parallel_results.append(fut.result())

    # After workers finish, replay duplicate followups against the now-warm
    # cache so callers still see one result row per submitted creative.
    final_cache = _load_analysis_cache() if duplicate_followups else None
    duplicate_results: list[dict] = []
    for ch, aid in duplicate_followups:
        entry = (final_cache or {}).get(ch)
        if (
            isinstance(entry, dict)
            and "analysis" in entry
            and entry.get("schema_version") == ANALYSIS_SCHEMA_VERSION
        ):
            duplicate_results.append({
                "creative_hash": ch,
                "ad_id": aid,
                "status": "cached",
            })
        else:
            duplicate_results.append({
                "creative_hash": ch,
                "ad_id": aid,
                "status": "failed",
                "error": "primary worker for this creative_hash did not produce a cached entry",
            })

    results = cached_results + parallel_results + duplicate_results
    analyzed = sum(1 for r in results if r["status"] == "analyzed")
    cached = sum(1 for r in results if r["status"] == "cached")
    failed = sum(1 for r in results if r["status"] == "failed")

    return {
        "analyzed": analyzed,
        "cached": cached,
        "failed": failed,
        "results": results,
    }


# ---------------------------------------------------------------------------
# Focus group simulation. run Claude against a list of personas
# ---------------------------------------------------------------------------


# Lightweight default personas for the "Run Focus Group" demo button. Full
# persona management is out of scope for this upgrade. once a persona
# library exists, the frontend can send full objects instead of these IDs.
DEMO_PERSONAS: dict[str, dict] = {
    "busy-mom": {
        "id": "busy-mom",
        "name": "Sarah",
        "role": "Busy mom of two, suburban",
        "demographics": {"age": 36, "gender": "Female", "incomeBracket": "$75k - $100k", "location": "Austin, TX"},
        "psychographics": {"goals": ["Save time", "Buy quality without overthinking"], "fears": ["Wasting money", "Shady brands"]},
        "behavioral": {"decisionDrivers": ["Trust signals", "Clear benefits", "Social proof"]},
    },
    "gen-z-creator": {
        "id": "gen-z-creator",
        "name": "Jordan",
        "role": "Gen Z creator, aesthetic-driven",
        "demographics": {"age": 22, "gender": "Non-binary", "incomeBracket": "$30k - $50k", "location": "Brooklyn, NY"},
        "psychographics": {"goals": ["Stay ahead of trends", "Find authentic brands"], "fears": ["Being seen as basic", "Overt ads"]},
        "behavioral": {"decisionDrivers": ["Aesthetic", "UGC vibes", "Creator endorsement"]},
    },
    "value-hunter": {
        "id": "value-hunter",
        "name": "Marcus",
        "role": "Deal-seeking dad, price-first",
        "demographics": {"age": 45, "gender": "Male", "incomeBracket": "$50k - $75k", "location": "Phoenix, AZ"},
        "psychographics": {"goals": ["Stretch dollar", "Dependable products"], "fears": ["Hidden fees", "Hype-only products"]},
        "behavioral": {"decisionDrivers": ["Price", "Reviews", "Warranty"]},
    },
}


def _personas_hash(personas: list[dict]) -> str:
    ids = sorted([p.get("id", "") for p in personas if p.get("id")])
    return hashlib.sha1("|".join(ids).encode()).hexdigest()[:12]


_FOCUS_GROUP_PROMPT = """You are role-playing a specific consumer persona reviewing a Meta ad in their social feed.

PERSONA:
{persona_json}

AD CONTEXT:
{ad_context}

AD ANALYSIS (what the creative is actually doing):
{analysis_summary}

Respond AS this persona. use their voice, their priorities, their skepticism. Return ONLY a single JSON object:

{{
  "personaId": "{persona_id}",
  "personaName": "{persona_name}",
  "reaction": "1-2 sentences, first-person voice. what they think/feel when this ad hits their feed",
  "stopPower": 0-100,         // how likely they are to stop scrolling (0=scroll past, 100=full stop)
  "resonanceScore": 0-100,    // how much the message resonates with their goals/fears
  "overallScore": 0-100,      // overall ad effectiveness for THIS persona (not generic)
  "recommendation": "1 sentence of concrete, persona-grounded advice to improve performance for this audience"
}}

Be ruthlessly honest. A mismatch between ad and persona should show in low scores and a pointed recommendation.
Output ONLY the JSON object. No prose. No fences.
"""


@router.post("/focus-group")
def focus_group(
    ad_id: str,
    brand: str = "",
    force: bool = False,
    payload: dict = Body(default={}),
):
    """Run a persona-based focus group simulation on an ad's creative.

    Body:
      {
        "persona_ids": ["busy-mom", "gen-z-creator"],     // demo personas, OR
        "personas": [{id, name, role, demographics, ...}], // full objects
        "image_url" / "thumbnail_url" / "title" / "body" / "ad_name" / "is_video" / "creative_hash"
      }

    Cached per (ad_id, creative_hash, persona_set_hash) under the
    corresponding analysis entry's `focus_group` key.
    """
    # Resolve persona list
    personas: list[dict] = []
    full = payload.get("personas")
    if isinstance(full, list) and full:
        personas = [p for p in full if isinstance(p, dict) and p.get("id")]
    else:
        ids = payload.get("persona_ids") or list(DEMO_PERSONAS.keys())
        for pid in ids:
            if pid in DEMO_PERSONAS:
                personas.append(DEMO_PERSONAS[pid])

    if not personas:
        raise HTTPException(status_code=400, detail="No personas provided")

    # Resolve creative
    image_url: Optional[str] = payload.get("image_url") or payload.get("thumbnail_url")
    title = payload.get("title", "")
    body_text = payload.get("body", "")
    ad_name = payload.get("ad_name", "")
    is_video = bool(payload.get("is_video"))
    creative_hash = payload.get("creative_hash")
    story_id: Optional[str] = payload.get("effective_object_story_id")

    if not image_url or not creative_hash:
        token = os.environ.get("META_ACCESS_TOKEN")
        if token:
            try:
                creative = _fetch_ad_creative(ad_id, token)
            except RateLimitedError as rle:
                raise HTTPException(
                    status_code=503,
                    detail=rle.message,
                    headers={"Retry-After": str(rle.retry_after)},
                )
            image_url = image_url or creative.get("image_url") or creative.get("thumbnail_url")
            title = title or creative.get("title", "")
            body_text = body_text or creative.get("body", "")
            ad_name = ad_name or creative.get("ad_name", "")
            is_video = is_video or bool(creative.get("video_id"))
            creative_hash = creative_hash or _creative_hash(creative)
            story_id = story_id or creative.get("effective_object_story_id")

    if not image_url:
        raise HTTPException(status_code=400, detail="No image available for focus group")
    if not creative_hash:
        creative_hash = hashlib.sha256(image_url.encode()).hexdigest()[:16]

    cache = _load_analysis_cache()
    # Hash-only key (schema v4+). See analyze_creative for rationale.
    cache_key = creative_hash
    entry = cache.get(cache_key) or {}
    fg_hash = _personas_hash(personas)

    # Return cached if present
    cached_fg = entry.get("focus_group") if isinstance(entry, dict) else None
    if not force and isinstance(cached_fg, dict) and cached_fg.get("personas_hash") == fg_hash:
        return cached_fg

    # Summarize existing analysis to ground personas in the creative
    analysis = entry.get("analysis") if isinstance(entry, dict) else None
    if isinstance(analysis, dict) and "error" not in analysis:
        summary_bits = []
        for key in ("angle", "hook", "concept", "template", "sentiment", "style", "emotion"):
            val = analysis.get(key)
            if val:
                summary_bits.append(f"{key}: {val}")
        analysis_summary = "\n".join(summary_bits) if summary_bits else "(no prior analysis)"
    else:
        analysis_summary = "(no prior analysis)"

    ad_ctx = _build_context(brand, ad_name, title, body_text, is_video)

    try:
        client = _get_anthropic_client()

        # Reuse the same base64 image across all personas. one fetch.
        # Prefer the post-thumb / img-by-ad disk cache so we don't race
        # the Meta CDN URL signature lifetime (cause of the 403s).
        cached = _ad_img_disk_cached_bytes(ad_id, story_id)
        if cached:
            cached_bytes, cached_mime = cached
            cached_bytes, cached_mime = _maybe_resize(cached_bytes, cached_mime)
            image_block = {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": cached_mime,
                    "data": base64.b64encode(cached_bytes).decode("ascii"),
                },
            }
        else:
            image_block = _image_content_block(image_url)

        results: list[dict] = []
        t0 = time.time()
        for persona in personas:
            persona_prompt = _FOCUS_GROUP_PROMPT.format(
                persona_json=json.dumps(persona, indent=2),
                ad_context=ad_ctx,
                analysis_summary=analysis_summary,
                persona_id=persona.get("id", ""),
                persona_name=persona.get("name", "Unknown"),
            )

            msg = client.messages.create(
                model=HAIKU_MODEL,
                max_tokens=1000,
                messages=[{
                    "role": "user",
                    "content": [
                        image_block,
                        {"type": "text", "text": persona_prompt},
                    ],
                }],
            )
            parts = [getattr(b, "text", "") for b in msg.content if getattr(b, "text", None)]
            raw = "\n".join(parts).strip()
            obj = _extract_json_object(raw)
            if isinstance(obj, dict):
                # Ensure persona id/name are set even if Claude omitted them
                obj.setdefault("personaId", persona.get("id", ""))
                obj.setdefault("personaName", persona.get("name", "Unknown"))
                results.append(obj)
            else:
                results.append({
                    "personaId": persona.get("id", ""),
                    "personaName": persona.get("name", "Unknown"),
                    "reaction": "(parsing error)",
                    "stopPower": 0,
                    "resonanceScore": 0,
                    "overallScore": 0,
                    "recommendation": raw[:200],
                })
        latency_ms = int((time.time() - t0) * 1000)

        scores = [r.get("overallScore", 0) for r in results if isinstance(r.get("overallScore"), (int, float))]
        blended = round(sum(scores) / len(scores), 1) if scores else 0

        payload_out = {
            "ad_id": ad_id,
            "creative_hash": creative_hash,
            "personas_hash": fg_hash,
            "results": results,
            "focusGroupScore": blended,
            "model": HAIKU_MODEL,
            "latency_ms": latency_ms,
            "run_at": int(time.time()),
        }
        # Persist under the analysis cache entry so a re-analyze doesn't
        # wipe the focus group output (see analyze_creative).
        if not isinstance(entry, dict) or not entry:
            entry = {
                "ad_id": ad_id,
                "creative_hash": creative_hash,
                "image_url": image_url,
                "is_video": is_video,
                "schema_version": ANALYSIS_SCHEMA_VERSION,
            }
        entry["focus_group"] = payload_out
        cache[cache_key] = entry
        _save_analysis_cache(cache)
        return payload_out

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Focus group failed: {e}")


@router.get("/focus-group/demo-personas")
def demo_personas():
    """Expose the demo persona set so the UI can preview names/roles
    before firing the (billable) focus-group call."""
    return {"personas": list(DEMO_PERSONAS.values())}


@router.post("/variants")
def generate_variants(
    ad_id: str,
    brand: str,
    payload: dict = Body(default={}),
):
    """Generate 3-5 copy/headline variants based on the creative + perf.
    Uses the cached vision analysis if available so Claude understands
    the visual context without a second vision call.

    Body: { title, body, ad_name, perf: {spend, roas, ctr, ...}, image_url, is_video }
    """
    title = payload.get("title", "")
    body_text = payload.get("body", "")
    ad_name = payload.get("ad_name", "")
    perf = payload.get("perf", {}) or {}
    image_url = payload.get("image_url") or payload.get("thumbnail_url")
    is_video = bool(payload.get("is_video"))
    creative_hash = payload.get("creative_hash") or ""

    # Pull cached vision analysis so variants are grounded in what's shown
    cache = _load_analysis_cache()
    cache_key = creative_hash if creative_hash else None
    analysis = None
    if cache_key and cache_key in cache:
        analysis = cache[cache_key].get("analysis")

    try:
        client = _get_anthropic_client()

        perf_bits = []
        if perf:
            if perf.get("spend"):
                perf_bits.append(f"spend ${perf['spend']:,.0f}")
            if perf.get("roas"):
                perf_bits.append(f"ROAS {perf['roas']}")
            if perf.get("ctr"):
                perf_bits.append(f"CTR {perf['ctr']}%")
            if perf.get("cpm"):
                perf_bits.append(f"CPM ${perf['cpm']}")
            if perf.get("purchases"):
                perf_bits.append(f"{perf['purchases']} purchases")
        perf_str = ", ".join(perf_bits) if perf_bits else "n/a"

        vision_str = ""
        if analysis:
            if isinstance(analysis, dict):
                # The new deep-analysis shape. prefer rich fields
                vision_str = (
                    f"Concept: {analysis.get('concept','')}\n"
                    f"Angle: {analysis.get('angle','')}\n"
                    f"Hook: {analysis.get('hook','')}\n"
                    f"Tone: {analysis.get('sentiment','')} / {analysis.get('emotion','')}\n"
                    f"Persona: {analysis.get('persona','')}\n"
                    f"Template: {analysis.get('template','')}\n"
                    f"Style: {analysis.get('style','')}"
                ).strip()

        user_content: list[Any] = []
        # Include image if we have it AND no cached analysis, so Claude still
        # sees what it's writing for. Use the server-side base64 fetch so
        # Meta CDN robots.txt doesn't reject the image.
        if image_url and not analysis:
            try:
                user_content.append(_image_content_block(image_url))
            except HTTPException:
                pass  # fall through. generate text-only variants

        prompt = f"""You are a direct-response copywriter generating Meta ad variants.

Brand: {brand}
Ad name: {ad_name}
Current headline: "{title or '(none)'}"
Current body: "{body_text or '(none)'}"
Performance: {perf_str}
{vision_str}
{"(Video thumbnail shown. write for a video ad.)" if is_video else ""}

Generate 4 distinct copy variants. Each should have a DIFFERENT angle
(e.g. problem/solution, benefit-driven, social proof, urgency, curiosity).
Match the brand voice implied by the current copy; keep headlines <= 40
chars, body <= 125 chars.

Return ONLY a JSON array (no prose, no fences):
[
  {{
    "angle": "short label (e.g. 'Benefit-led')",
    "headline": "...",
    "body": "...",
    "why": "1 sentence on why this angle might outperform"
  }},
  ...
]"""

        user_content.append({"type": "text", "text": prompt})

        msg = client.messages.create(
            model=HAIKU_MODEL,
            max_tokens=1500,
            messages=[{"role": "user", "content": user_content}],
        )
        parts = [getattr(b, "text", "") for b in msg.content if getattr(b, "text", None)]
        raw = "\n".join(parts).strip()
        variants = _extract_json_array(raw)
        if variants is None:
            return {"variants": [], "raw": raw[:1000], "error": "Could not parse JSON"}

        return {"variants": variants, "ad_id": ad_id, "generated_at": int(time.time())}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Variant generation failed: {e}")


@router.get("/creative-timeseries")
def creative_timeseries(
    brand: str,
    ad_ids: str = Query(..., description="Comma-separated ad IDs"),
    start: str = Query(...),
    end: str = Query(...),
):
    """Return daily per-ad performance rows for a set of ad IDs.

    Shape:
        {
          "brand": "...",
          "start": "...", "end": "...",
          "series": {
            "<ad_id>": [
              {date, spend, impressions, clicks, purchases, revenue,
               roas, cpm, cpc, ctr, reach, frequency, link_clicks,
               add_to_cart, cost_per_purchase},
              ...
            ]
          }
        }

    Gotchas:
      - Meta's `filtering=[{field:"ad.id",operator:"IN",value:[...]}]`
        works at level=ad, but the list is capped around ~50 ids per call
        before the API starts returning truncated/empty pages. We batch
        in chunks of 25 to stay well under that ceiling.
      - Days with zero delivery never appear in insights; the frontend
        has to tolerate sparse series.
    """
    ids = [s.strip() for s in ad_ids.split(",") if s.strip()]
    if not ids:
        raise HTTPException(status_code=400, detail="ad_ids required")
    # Safety cap. frontend limits to ~10 lines but guard the endpoint anyway
    if len(ids) > 50:
        raise HTTPException(status_code=400, detail="max 50 ad_ids per call")

    cache_key = f"ts:{brand}:{','.join(sorted(ids))}:{start}:{end}"
    entry = _timeseries_cache.get(cache_key)
    if entry and (time.time() - entry[0]) < TIMESERIES_CACHE_TTL:
        return entry[1]

    accounts = _get_meta_accounts()
    account_id = accounts.get(brand)
    if not account_id:
        raise HTTPException(status_code=404, detail=f"Brand '{brand}' not in META_ACCOUNTS")

    token = os.environ.get("META_ACCESS_TOKEN")
    if not token:
        raise HTTPException(status_code=500, detail="META_ACCESS_TOKEN not configured")

    import requests as req

    fields = (
        "ad_id,ad_name,date_start,date_stop,spend,impressions,clicks,reach,"
        "frequency,ctr,cpc,cpm,actions,action_values"
    )

    series: dict[str, list[dict]] = {aid: [] for aid in ids}

    # Chunk to stay under Meta's filter size ceiling
    CHUNK = 25
    for i in range(0, len(ids), CHUNK):
        batch = ids[i:i + CHUNK]
        params = {
            "access_token": token,
            "level": "ad",
            "time_range": json.dumps({"since": start, "until": end}),
            "time_increment": 1,
            "filtering": json.dumps([
                {"field": "ad.id", "operator": "IN", "value": batch}
            ]),
            "fields": fields,
            "limit": 500,
        }
        url = f"https://graph.facebook.com/{META_API_VERSION}/{account_id}/insights"
        next_url: Optional[str] = None
        for _ in range(20):  # paginate generously. daily rows x many ads
            resp = req.get(next_url or url, params=None if next_url else params, timeout=120)
            data = resp.json()
            if "error" in data:
                raise HTTPException(status_code=502, detail=data["error"].get("message", "Meta API error"))
            for r in data.get("data", []):
                aid = r.get("ad_id")
                if aid not in series:
                    continue
                p = _parse_perf(r)
                p["date"] = r.get("date_start", "")
                series[aid].append(p)
            next_url = data.get("paging", {}).get("next")
            if not next_url:
                break

    # Sort each series chronologically
    for aid in series:
        series[aid].sort(key=lambda r: r["date"])

    payload = {
        "brand": brand,
        "start": start,
        "end": end,
        "series": series,
    }
    _timeseries_cache[cache_key] = (time.time(), payload)
    return payload


@router.get("/analysis-bulk")
def analysis_bulk(
    ad_ids: Optional[str] = Query(None, description="Comma-separated ad IDs"),
    creative_hashes: Optional[str] = Query(
        None,
        description="Comma-separated creative_hash values (preferred. hash-keyed lookup)",
    ),
):
    """Return the subset of cached analyses for a set of ads or creative
    hashes.

    Used by the table view so we can light up analysis-derived columns
    (template, funnelPosition, persona, etc.) without re-hitting Claude.

    - If ``creative_hashes`` is provided, the returned ``analyses`` map
      is keyed by ``creative_hash``. this is the preferred path now
      that the cache is hash-primary.
    - If only ``ad_ids`` is provided (legacy path), we still return a
      hash-keyed map so callers can migrate. We additionally include
      an ``ad_id_to_hash`` lookup for callers that only know ad_ids.

    Absent entries are silently omitted. ``analysis`` is the full
    FileAnalysis object so the frontend can surface any field it needs
    (differentiation scores etc.) without extending this endpoint every
    time a field is added to the schema.
    """
    requested_hashes = {
        s.strip() for s in (creative_hashes or "").split(",") if s.strip()
    }
    requested_ads = {s.strip() for s in (ad_ids or "").split(",") if s.strip()}
    if not requested_hashes and not requested_ads:
        return {"analyses": {}, "ad_id_to_hash": {}}

    cache = _load_analysis_cache()
    out: dict[str, dict] = {}
    ad_id_to_hash: dict[str, str] = {}
    for key, entry in cache.items():
        if not isinstance(entry, dict):
            continue
        # Only surface entries at the current schema version. stale
        # entries should refetch via /analyze.
        if entry.get("schema_version") != ANALYSIS_SCHEMA_VERSION:
            continue
        # Post-migration the key IS the creative_hash, but fall back to
        # the field just in case an older entry slipped through.
        chash = key if "::" not in key else entry.get("creative_hash")
        if not chash:
            continue
        aid = entry.get("ad_id")

        matched = False
        if requested_hashes and chash in requested_hashes:
            matched = True
        if not matched and requested_ads and aid in requested_ads:
            matched = True
        if not matched:
            continue

        payload = {
            "creative_hash": chash,
            "ad_id": aid,
            "analysis": entry.get("analysis"),
            "analyzed_at": entry.get("analyzed_at"),
            "focus_group": entry.get("focus_group"),
        }
        prior = out.get(chash)
        if prior is None or (entry.get("analyzed_at", 0) > (prior.get("analyzed_at") or 0)):
            out[chash] = payload
        if aid:
            ad_id_to_hash[aid] = chash
    return {"analyses": out, "ad_id_to_hash": ad_id_to_hash}


# ---------------------------------------------------------------------------
# Comments endpoint. surface FB + IG comments on the ad's published post
# so the AI-analysis panel can show audience reactions alongside metrics.
# ---------------------------------------------------------------------------


_PAGE_TOKEN_CACHE: dict[str, str] = {}
_PAGE_TOKEN_CACHE_PATH = os.path.join(os.path.dirname(__file__), "page_tokens.json")


def _load_page_tokens_disk() -> dict[str, str]:
    """Load cached page tokens from disk. Page tokens don't expire unless
    the user revokes access. caching them eliminates per-request lookups.
    """
    global _PAGE_TOKEN_CACHE
    if _PAGE_TOKEN_CACHE:
        return _PAGE_TOKEN_CACHE
    try:
        if os.path.exists(_PAGE_TOKEN_CACHE_PATH):
            with open(_PAGE_TOKEN_CACHE_PATH, "r") as fp:
                _PAGE_TOKEN_CACHE = json.load(fp) or {}
    except Exception:
        _PAGE_TOKEN_CACHE = {}
    return _PAGE_TOKEN_CACHE


def _save_page_tokens_disk() -> None:
    try:
        with open(_PAGE_TOKEN_CACHE_PATH, "w") as fp:
            json.dump(_PAGE_TOKEN_CACHE, fp)
    except Exception:
        pass


def _resolve_page_token(page_id: str, user_token: str) -> Optional[str]:
    """Return the page access token for the given page_id.

    First checks the in-memory + on-disk cache. On miss, hits
    ``/me/accounts`` once to discover every page the user manages,
    caches all of them, then returns the requested one. The user token
    needs ``pages_show_list`` (and ``pages_read_engagement`` for the
    downstream ``/comments`` call to succeed).
    """
    cache = _load_page_tokens_disk()
    if page_id in cache:
        return cache[page_id]
    import httpx
    try:
        url = f"https://graph.facebook.com/{META_API_VERSION}/me/accounts"
        with httpx.Client(timeout=20.0) as client:
            r = client.get(url, params={"access_token": user_token, "fields": "id,access_token,name", "limit": 200})
        data = r.json()
        if isinstance(data, dict) and data.get("data"):
            for p in data["data"]:
                pid = str(p.get("id") or "")
                tok = p.get("access_token")
                if pid and tok:
                    cache[pid] = tok
            _save_page_tokens_disk()
    except Exception as e:
        print(f"[comments] page-token discovery failed: {e}", flush=True)
    return cache.get(page_id)


def _fetch_fb_page_comments(
    object_story_id: str, token: str, limit: int = 100,
) -> tuple[list[dict], Optional[str]]:
    """Fetch comments on a FB page post via the Graph API.

    Returns ``(comments, error_message)``. When the caller's token lacks
    scopes, Graph API returns a 403 with a human-readable OAuth message;
    we surface that verbatim so the UI can show it in a ``notes`` field
    rather than blowing up the whole request.
    """
    import httpx

    url = f"https://graph.facebook.com/{META_API_VERSION}/{object_story_id}/comments"
    params = {
        "access_token": token,
        # from{id,name,picture} gets us author name + avatar in one hop.
        "fields": "id,message,from{id,name,picture},created_time,like_count",
        "limit": min(max(1, limit), 100),
        # Chronological newest-last via Graph; we sort desc client-side below.
        "order": "chronological",
    }
    try:
        with httpx.Client(timeout=20.0, follow_redirects=True) as client:
            resp = client.get(url, params=params)
    except httpx.HTTPError as e:
        return [], f"FB comments fetch failed: {e}"
    try:
        data = resp.json()
    except Exception:
        return [], f"FB comments returned HTTP {resp.status_code}"
    if isinstance(data, dict) and "error" in data:
        return [], str(data["error"].get("message") or data["error"])
    return data.get("data", []) if isinstance(data, dict) else [], None


def _fetch_ig_media_comments(
    ig_media_id: str, token: str, limit: int = 100,
) -> tuple[list[dict], Optional[str]]:
    """Fetch comments on an IG media object.

    IG comments require ``instagram_basic`` + ``pages_read_engagement`` +
    ``instagram_manage_comments`` / ``pages_manage_engagement`` scopes.
    The user's token currently has ``pages_read_engagement`` +
    ``pages_show_list``. likely insufficient. so we return a notes
    string when the call 403s.
    """
    import httpx

    url = f"https://graph.facebook.com/{META_API_VERSION}/{ig_media_id}/comments"
    params = {
        "access_token": token,
        "fields": "id,text,username,timestamp,like_count",
        "limit": min(max(1, limit), 100),
    }
    try:
        with httpx.Client(timeout=20.0, follow_redirects=True) as client:
            resp = client.get(url, params=params)
    except httpx.HTTPError as e:
        return [], f"IG comments fetch failed: {e}"
    try:
        data = resp.json()
    except Exception:
        return [], f"IG comments returned HTTP {resp.status_code}"
    if isinstance(data, dict) and "error" in data:
        return [], str(data["error"].get("message") or data["error"])
    return data.get("data", []) if isinstance(data, dict) else [], None


def _normalize_fb_comment(raw: dict) -> dict:
    """Normalize a Graph /page_post/comments row into our UI shape."""
    author = raw.get("from") or {}
    pic = (author.get("picture") or {}).get("data") or {}
    return {
        "id": str(raw.get("id") or ""),
        "author": author.get("name") or "Facebook user",
        "avatar": pic.get("url") or "",
        "platform": "fb",
        "message": raw.get("message") or "",
        "created_time": raw.get("created_time") or "",
        "like_count": int(raw.get("like_count") or 0),
    }


def _normalize_ig_comment(raw: dict) -> dict:
    """Normalize an IG /media/comments row into our UI shape.

    IG's Graph API does NOT return an avatar URL for commenters (only
    the username), so the frontend falls back to initials.
    """
    return {
        "id": str(raw.get("id") or ""),
        "author": raw.get("username") or "Instagram user",
        "avatar": "",
        "platform": "ig",
        "message": raw.get("text") or "",
        "created_time": raw.get("timestamp") or "",
        "like_count": int(raw.get("like_count") or 0),
    }


@router.get("/comments")
def get_ad_comments(brand: str, ad_id: str):
    """Return FB + IG comments on the ad's published post.

    Flow:
      1. Fetch the ad's creative to get effective_object_story_id +
         object_story_spec.
      2. Hit /{object_story_id}/comments for the FB-side thread.
      3. If the creative is linked to an IG media id, hit
         /{ig_media_id}/comments for the IG-side thread (best-effort -
         requires additional scopes beyond the current token).
      4. Merge, normalize, sort by created_time desc, cache 10min.

    When scopes are insufficient for IG, we still return FB comments and
    set ``notes`` so the frontend can display a hint. Dynamic creative
    and carousel ads that don't resolve to a single published post also
    return a helpful notes string.
    """
    cache_key = f"comments:{brand}:{ad_id}"
    entry = _comments_cache.get(cache_key)
    if entry and (time.time() - entry[0]) < COMMENTS_CACHE_TTL:
        return entry[1]

    accounts = _get_meta_accounts()
    if not accounts.get(brand):
        raise HTTPException(status_code=404, detail=f"Brand '{brand}' not in META_ACCOUNTS")

    token = os.environ.get("META_ACCESS_TOKEN")
    if not token:
        raise HTTPException(status_code=500, detail="META_ACCESS_TOKEN not configured")

    import httpx

    # Step 1. fetch creative to resolve object_story_id + spec.
    ad_fields = (
        "id,name,creative{"
        "id,effective_object_story_id,object_story_spec,"
        "instagram_permalink_url,effective_instagram_media_id"
        "}"
    )
    ad_url = f"https://graph.facebook.com/{META_API_VERSION}/{ad_id}"
    try:
        with httpx.Client(timeout=30.0, follow_redirects=True) as client:
            ad_resp = client.get(ad_url, params={"access_token": token, "fields": ad_fields})
        ad_data = ad_resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch ad: {e}")

    if isinstance(ad_data, dict) and "error" in ad_data:
        err = ad_data["error"].get("message") or "Meta API error"
        raise HTTPException(status_code=502, detail=err)

    creative = (ad_data.get("creative") or {}) if isinstance(ad_data, dict) else {}
    story_id = creative.get("effective_object_story_id")
    spec = creative.get("object_story_spec") or {}
    has_ig_link = bool(spec.get("instagram_actor_id") or spec.get("instagram_user_id"))
    ig_media_id = creative.get("effective_instagram_media_id")

    notes_parts: list[str] = []
    out: list[dict] = []
    unresolvable_post = False

    # Step 2. FB page post comments. Use a page access token if we can
    # resolve one (user tokens are per-page-scoped and frequently 403 on
    # individual pages the user has granted). Page tokens inherit all the
    # per-page scopes granted at install time, so they bypass the limit.
    if story_id:
        page_token = token
        page_id = story_id.split("_", 1)[0] if "_" in story_id else None
        if page_id:
            resolved = _resolve_page_token(page_id, token)
            if resolved:
                page_token = resolved
        fb_raw, fb_err = _fetch_fb_page_comments(story_id, page_token)
        if fb_err and page_token != token:
            # Fall back to the user token if the page token fails. some
            # pages only expose comments via the user's grant.
            fb_raw, fb_err = _fetch_fb_page_comments(story_id, token)
        if fb_err:
            notes_parts.append(f"FB: {fb_err}")
        else:
            out.extend(_normalize_fb_comment(c) for c in fb_raw)
    else:
        # Dynamic-creative / carousel / asset_feed_spec ads often don't
        # resolve to a single published post until they've delivered.
        unresolvable_post = True
        notes_parts.append(
            "This ad does not resolve to a single published post "
            "(dynamic creative or carousel). no FB comment thread available."
        )

    # Step 3. IG media comments (best-effort).
    if ig_media_id:
        ig_raw, ig_err = _fetch_ig_media_comments(ig_media_id, token)
        if ig_err:
            notes_parts.append(
                "IG comments require pages_manage_engagement + "
                "instagram_manage_comments + a linked IG business account "
                f"({ig_err})"
            )
        else:
            out.extend(_normalize_ig_comment(c) for c in ig_raw)
    elif has_ig_link and not unresolvable_post:
        notes_parts.append(
            "IG comments require pages_manage_engagement + linked IG account"
        )

    # Step 4. sort desc by created_time (ISO strings sort lexicographically).
    out.sort(key=lambda c: c.get("created_time") or "", reverse=True)

    # Step 5. sentiment + emotion analysis. Degrades gracefully: if libs
    # aren't available, `summary` is omitted entirely rather than 500'ing.
    enriched, summary = _analyze_comments(out, brand, ad_id)

    payload: dict[str, Any] = {
        "brand": brand,
        "ad_id": ad_id,
        "comments": enriched,
        "notes": " ".join(notes_parts) if notes_parts else None,
    }
    if summary is not None:
        payload["summary"] = summary
    _comments_cache[cache_key] = (time.time(), payload)
    return payload


# ---------------------------------------------------------------------------
# Comments sentiment rollup. aggregate across all analyzed ads for a brand,
# grouped by a taxonomy dimension pulled from the ad_analysis_cache. This is
# scaffolding for the "sentiment by product / category / angle / persona"
# view. Frontend doesn't consume it yet.
# ---------------------------------------------------------------------------


# Whitelist of group_by dimensions. Each maps to a FileAnalysis field name.
# - product. uses `products[0]` if present, else `collection`
# - category. uses `category`
# - angle. uses `angle`
# - persona. uses `persona`
_ROLLUP_DIMENSIONS = {"product", "category", "angle", "persona"}


def _analysis_taxonomy_value(analysis: dict, group_by: str) -> Optional[str]:
    """Pick the grouping key out of a FileAnalysis payload.

    Some analyses are stored as `{"raw": "...", "error": "..."}` (Claude
    didn't return valid JSON). those can't contribute to the rollup and
    are silently skipped by returning None.
    """
    if not isinstance(analysis, dict) or analysis.get("error"):
        return None
    if group_by == "product":
        products = analysis.get("products")
        if isinstance(products, list) and products:
            first = str(products[0]).strip()
            if first:
                return first
        coll = analysis.get("collection")
        if isinstance(coll, str) and coll.strip() and coll.strip().lower() not in ("n/a", "unknown"):
            return coll.strip()
        return None
    value = analysis.get(group_by)
    if isinstance(value, str):
        v = value.strip()
        if v and v.lower() not in ("n/a", "unknown"):
            return v
    return None


@router.get("/comments/sentiment-rollup")
def get_comments_sentiment_rollup(
    brand: str,
    group_by: str = Query("product", description="product|category|angle|persona"),
):
    """Aggregate comment sentiment + emotions across every ad we've
    analyzed for this brand, grouped by one of the brand's taxonomy
    dimensions joined via `ad_analysis_cache.json`.

    Payload:
        {
          "brand": "X",
          "group_by": "product",
          "rows": [
            {"value": "Mint C&C", "ads": 12, "comments": 234,
             "avg_compound": 0.42, "top_emotion": "joy",
             "positive_pct": 58.1, "neutral_pct": 24.0, "negative_pct": 17.9},
            ...
          ]
        }

    Ads with no analyzed comments, or whose analysis is missing the
    requested taxonomy field, are silently omitted. Sorted by comment
    count desc so the most-commented groups surface first.
    """
    if group_by not in _ROLLUP_DIMENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"group_by must be one of {sorted(_ROLLUP_DIMENSIONS)}",
        )

    # Pull the full ad_analysis cache. we need the FileAnalysis for
    # every ad to resolve its taxonomy value. Cache is keyed by
    # creative_hash (post-migration), with `ad_id` stored in the entry.
    analysis_cache = _load_analysis_cache()
    # ad_id -> taxonomy value
    ad_to_value: dict[str, str] = {}
    for _key, entry in analysis_cache.items():
        if not isinstance(entry, dict):
            continue
        if entry.get("schema_version") != ANALYSIS_SCHEMA_VERSION:
            continue
        aid = entry.get("ad_id")
        if not aid:
            continue
        value = _analysis_taxonomy_value(entry.get("analysis") or {}, group_by)
        if value:
            ad_to_value[str(aid)] = value

    # Pull persisted comment scores. this is our pre-scored history per
    # ad. Filter to ads under the requested brand.
    comments_store = _load_comments_analysis()

    # value -> accumulator
    grp: dict[str, dict] = {}
    for ad_id, bucket in comments_store.items():
        if not isinstance(bucket, dict):
            continue
        if bucket.get("brand") != brand:
            continue
        value = ad_to_value.get(str(ad_id))
        if not value:
            continue
        scores = bucket.get("comment_scores") or {}
        if not isinstance(scores, dict) or not scores:
            continue
        g = grp.setdefault(value, {
            "value": value,
            "ads": 0,
            "comments": 0,
            "compound_sum": 0.0,
            "pos": 0,
            "neu": 0,
            "neg": 0,
            "emotions": {k: 0.0 for k in EMOTION_KEYS},
        })
        g["ads"] += 1
        for _cid, s in scores.items():
            if not isinstance(s, dict):
                continue
            g["comments"] += 1
            compound = float(s.get("compound") or 0.0)
            g["compound_sum"] += compound
            lbl = s.get("sentiment")
            if lbl == "positive":
                g["pos"] += 1
            elif lbl == "negative":
                g["neg"] += 1
            else:
                g["neu"] += 1
            emos = s.get("emotions") or {}
            for k in EMOTION_KEYS:
                g["emotions"][k] += float(emos.get(k) or 0.0)

    rows: list[dict] = []
    for value, g in grp.items():
        n = g["comments"] or 1
        avg_emotions = {k: round(g["emotions"][k] / n, 4) for k in EMOTION_KEYS}
        top_emotion = max(avg_emotions.items(), key=lambda kv: kv[1])[0]
        if avg_emotions[top_emotion] == 0:
            top_emotion = None
        rows.append({
            "value": value,
            "ads": g["ads"],
            "comments": g["comments"],
            "avg_compound": round(g["compound_sum"] / n, 4),
            "positive_pct": round(100.0 * g["pos"] / n, 1),
            "neutral_pct": round(100.0 * g["neu"] / n, 1),
            "negative_pct": round(100.0 * g["neg"] / n, 1),
            "top_emotion": top_emotion,
            "emotions": avg_emotions,
        })
    rows.sort(key=lambda r: r["comments"], reverse=True)
    return {"brand": brand, "group_by": group_by, "rows": rows}


# ---------------------------------------------------------------------------
# Naming-convention endpoints. surface parsed tokens for the UI so the
# user can override / edit per-brand patterns. Reads + writes land on the
# brand profile under ``ad_name_convention``.
# ---------------------------------------------------------------------------


_DEFAULT_CONVENTIONS = {
    # Seeded for Canoopsy. the user's example brand. Other brands inherit
    # the generic pipe-delimited parser until they customize.
    "Canoopsy": {
        "ad_name_pattern": (
            "<concept><launch_date> | <objective> | <format> | <type> | "
            "<persona> | <brand> | <month_year> | <flight>"
        ),
        "adset_name_pattern": "<owner> | <funnel>-<campaign_type>-<bidding>-<bid_strategy>-<test_flag>-<audience>",
    }
}


@router.get("/naming-convention")
def get_naming_convention(brand: str):
    """Return the brand's saved naming convention (if any) plus defaults."""
    try:
        from brand_profile_store import get_profile

        profile = get_profile(brand)
    except Exception:
        profile = {}
    convention = profile.get("ad_name_convention") if isinstance(profile, dict) else None
    if not convention:
        convention = _DEFAULT_CONVENTIONS.get(brand, {})
    return {"brand": brand, "convention": convention or {}}


@router.post("/naming-convention")
def set_naming_convention(brand: str, payload: dict = Body(default={})):
    """Persist the brand's naming convention. Payload: {convention: {...}}."""
    convention = payload.get("convention") or {}
    try:
        from brand_profile_store import get_profile, save_profile

        profile = get_profile(brand) or {}
        profile["ad_name_convention"] = convention
        save_profile(brand, profile)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Save failed: {e}")
    return {"brand": brand, "convention": convention}


@router.post("/parse-names")
def parse_names(payload: dict = Body(default={})):
    """Preview parser output for a given ad + adset name. Used by the
    detail panel so the user can see how the regex will tokenize their
    naming convention without hitting Meta.
    """
    return {
        "ad": parse_ad_name(payload.get("ad_name")),
        "adset": parse_adset_name(payload.get("adset_name")),
    }


@router.get("/cache")
def cache_stats():
    """Debug endpoint. how many analyses are cached."""
    cache = _load_analysis_cache()
    return {
        "count": len(cache),
        "schema_version": ANALYSIS_SCHEMA_VERSION,
        "keys": list(cache.keys())[:20],
    }


# ---------------------------------------------------------------------------
# Background pre-warmer. keeps the M2D creatives cache hot for every brand
# ---------------------------------------------------------------------------
#
# Motivation: the first /api/ads/creatives call per (brand, date range)
# can take 10–30s because we have to walk Meta Insights + fetch creative
# metadata for every ad. That's a brutal first-load experience. This
# thread refreshes the month-to-date window for every brand every hour
# so the UI can serve from in-memory cache on arrival.

from datetime import datetime, timedelta

_PREWARM_STARTED = False
_PREWARM_LOCK = threading.Lock()
# Bumped from 1h -> 2h because we now warm 4 windows per brand instead of 1.
# A full cycle takes roughly (11 brands * 4 ranges * ~15s) ~ 11 min when every
# range is cold; with the smart-skip check below typical cycles finish far
# faster because recently-fetched ranges are left alone.
_PREWARM_INTERVAL_SEC = 12 * 60 * 60  # 12 hours between full cycles (was 2h -
                                       # too aggressive for dev-tier Meta budget)
_PREWARM_BETWEEN_BRANDS_SEC = 30      # 30s spacing between brands (was 10s)
_PREWARM_BETWEEN_RANGES_SEC = 3   # light pause between ranges for a single brand
_PREWARM_STARTUP_DELAY_SEC = 5   # let FastAPI finish init before first fetch
# If a given (brand, range) was fetched (by a user or a prior cycle) within
# this window it's already warm in memory. no point re-hitting Meta.
_PREWARM_RECENT_SKIP_SEC = 30 * 60  # 30 min

# Exposed via /api/ads/prewarm-status
# brand -> { "ranges": { range_label -> {...}}, "last_run_at": iso }
_PREWARM_STATUS: dict[str, Any] = {
    "last_run": None,
    "next_run_at": None,
    "brands": {},
}


def _m2d_window() -> tuple[str, str]:
    """Month-to-date window: first-of-month through yesterday (local/UTC).

    Using `datetime.now()` gives local time, which aligns with how Meta
    Insights reports daily rollups for these accounts. We stop at
    yesterday because today's numbers are partial and noisy.
    """
    now = datetime.now()
    start = now.replace(day=1).strftime("%Y-%m-%d")
    end = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    return start, end


def _last_n_days_window(n: int) -> tuple[str, str]:
    """Rolling "last N days" ending yesterday (avoids partial today)."""
    now = datetime.now()
    end = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    start = (now - timedelta(days=n)).strftime("%Y-%m-%d")
    return start, end


def _prewarm_ranges() -> list[tuple[str, tuple[str, str]]]:
    """Ranges the prewarmer keeps hot. Labels are for status surfacing only;
    the cache key the endpoint uses is ``(brand, start, end, limit)``.
    """
    return [
        ("m2d", _m2d_window()),
        ("last_7", _last_n_days_window(7)),
        ("last_14", _last_n_days_window(14)),
        ("last_30", _last_n_days_window(30)),
    ]


def _get_brand_list() -> list[str]:
    """Lazy import to dodge the api_server <-> ad_analysis_endpoints cycle."""
    try:
        from api_server import META_ACCOUNTS
        return list(META_ACCOUNTS.keys())
    except Exception as e:
        print(f"[prewarm] could not import META_ACCOUNTS: {e}", flush=True)
        return []


def _recent_cache_hit(brand: str, start: str, end: str, limit: int = 100) -> bool:
    """True if the in-memory cache has a fresh entry for this range. Lets the
    prewarmer skip ranges a user (or the last cycle) already warmed, so we
    don't redundantly pound Meta every 2 h on ranges that haven't gone stale.
    """
    cache_key = f"creatives:{brand}:{start}:{end}:{limit}"
    entry = _creative_cache.get(cache_key)
    if not entry:
        return False
    age = time.time() - entry[0]
    return age < _PREWARM_RECENT_SKIP_SEC


def _prewarm_one_range(brand: str, label: str, start: str, end: str) -> dict:
    """Warm a single (brand, range) cell. Never raises.

    Returns a status dict so the caller can slot it into the broader
    prewarm-status tree without another lookup.
    """
    if _recent_cache_hit(brand, start, end):
        status = {
            "ads": None,
            "seconds": 0.0,
            "at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
            "window": {"start": start, "end": end},
            "skipped": "fresh-in-memory",
        }
        print(f"[prewarm] {brand} {label}: skip (fresh in-memory)", flush=True)
        return status
    t0 = time.time()
    try:
        payload = _list_creatives_impl(brand=brand, start=start, end=end, limit=100)
        elapsed = time.time() - t0
        ads_count = len(payload.get("ads") or [])
        print(f"[prewarm] {brand} {label}: {ads_count} ads in {elapsed:.1f}s", flush=True)
        return {
            "ads": ads_count,
            "seconds": round(elapsed, 2),
            "at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
            "window": {"start": start, "end": end},
        }
    except Exception as e:
        elapsed = time.time() - t0
        print(f"[prewarm] {brand} {label} FAILED in {elapsed:.1f}s: {e}", flush=True)
        return {
            "ads": 0,
            "seconds": round(elapsed, 2),
            "at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
            "window": {"start": start, "end": end},
            "error": str(e),
        }


def _prewarm_one_brand(brand: str) -> None:
    """Refresh the cache for a brand across every range in `_prewarm_ranges`.
    Never raises. records per-range status into _PREWARM_STATUS.
    """
    ranges = _prewarm_ranges()
    brand_status = _PREWARM_STATUS["brands"].get(brand) or {}
    # Keep the legacy "window/ads/seconds" top-level fields pointing at M2D
    # so the old /prewarm-status consumers still see meaningful data even
    # before they know about the nested "ranges" map.
    ranges_status: dict[str, Any] = dict(brand_status.get("ranges") or {})
    for idx, (label, (start, end)) in enumerate(ranges):
        ranges_status[label] = _prewarm_one_range(brand, label, start, end)
        if idx < len(ranges) - 1:
            time.sleep(_PREWARM_BETWEEN_RANGES_SEC)
    m2d = ranges_status.get("m2d", {})
    _PREWARM_STATUS["brands"][brand] = {
        "ranges": ranges_status,
        # Back-compat flat fields. reflect the M2D slot.
        "ads": m2d.get("ads"),
        "seconds": m2d.get("seconds"),
        "at": m2d.get("at"),
        "window": m2d.get("window"),
        "error": m2d.get("error"),
    }


def _prewarm_loop() -> None:
    """Daemon loop: cycle every brand sequentially, sleep, repeat.

    Sequential on purpose. Meta rate-limits aggressively per-account
    and per-token, and a ThreadPoolExecutor here would spike both. The
    user doesn't care whether the warm completes in 2 minutes or 5;
    they only care that the cache is warm by the time they open the tab.
    """
    # Give FastAPI a moment to finish binding before we start pounding
    # Meta on its behalf.
    time.sleep(_PREWARM_STARTUP_DELAY_SEC)

    while True:
        brands = _get_brand_list()
        if not brands:
            print("[prewarm] no brands discovered. sleeping 60s and retrying", flush=True)
            time.sleep(60)
            continue

        cycle_start = time.time()
        print(f"[prewarm] starting cycle across {len(brands)} brands", flush=True)

        for idx, brand in enumerate(brands):
            _prewarm_one_brand(brand)
            # Stagger to avoid a burst of Graph calls. skip the trailing
            # sleep after the last brand so we don't delay the status
            # update.
            if idx < len(brands) - 1:
                time.sleep(_PREWARM_BETWEEN_BRANDS_SEC)

        _PREWARM_STATUS["last_run"] = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
        next_at = datetime.utcnow() + timedelta(seconds=_PREWARM_INTERVAL_SEC)
        _PREWARM_STATUS["next_run_at"] = next_at.strftime("%Y-%m-%dT%H:%M:%SZ")
        cycle_elapsed = time.time() - cycle_start
        print(
            f"[prewarm] cycle complete in {cycle_elapsed:.1f}s. "
            f"sleeping {_PREWARM_INTERVAL_SEC}s",
            flush=True,
        )
        time.sleep(_PREWARM_INTERVAL_SEC)


def _start_prewarmer() -> None:
    """Idempotent launcher. safe to call repeatedly (the module import
    system already guarantees single-load, but the extra lock guards
    against test-harness reimports and reload-on-edit dev servers).
    """
    global _PREWARM_STARTED
    with _PREWARM_LOCK:
        if _PREWARM_STARTED:
            return
        if os.environ.get("ATELIER_DISABLE_PREWARM") == "1":
            print("[prewarm] disabled via ATELIER_DISABLE_PREWARM=1", flush=True)
            _PREWARM_STARTED = True
            return
        t = threading.Thread(
            target=_prewarm_loop,
            name="ad-creatives-prewarmer",
            daemon=True,
        )
        t.start()
        _PREWARM_STARTED = True
        print("[prewarm] background thread started", flush=True)


# Kick the thread off at module load. It sleeps 5s before hitting
# anything, so even though api_server imports this module partway through
# its own startup, the first Graph call happens after FastAPI is ready.
_start_prewarmer()


@router.get("/prewarm-status")
def prewarm_status():
    """Health check for the background M2D prewarmer."""
    last_run_iso = _PREWARM_STATUS.get("last_run")
    next_run_iso = _PREWARM_STATUS.get("next_run_at")
    next_in_sec: Optional[int] = None
    if next_run_iso:
        try:
            target = datetime.strptime(next_run_iso, "%Y-%m-%dT%H:%M:%SZ")
            delta = (target - datetime.utcnow()).total_seconds()
            next_in_sec = max(0, int(delta))
        except Exception:
            next_in_sec = None
    return {
        "last_run": last_run_iso,
        "next_run_at": next_run_iso,
        "next_run_in_sec": next_in_sec,
        "started": _PREWARM_STARTED,
        "disabled": os.environ.get("ATELIER_DISABLE_PREWARM") == "1",
        "brands": _PREWARM_STATUS.get("brands", {}),
    }
