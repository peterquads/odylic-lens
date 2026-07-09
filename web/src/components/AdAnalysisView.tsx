import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Loader2, Play, RefreshCw,
  LayoutGrid, BarChart3, LineChart as LineIcon, Table2, ChevronDown,
  CheckSquare, Square, Check, X as XIcon, ArrowUp, ArrowDown, ArrowUpDown, Search,
  Settings2, Layers3, LayoutDashboard, ChartScatter, Plus, Workflow,
  Sparkles, Download, Image as ImageIcon, FileSpreadsheet, FolderArchive,
  Info, PieChart as PieChartIcon, Hash,
} from 'lucide-react'
import { toPng } from 'html-to-image'
import JSZip from 'jszip'
import { FunnelView } from './FunnelView'
import { HypotheticalFunnelView } from './HypotheticalFunnelView'
import { DemoFunnelView } from './DemoFunnelView'
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  ScatterChart, Scatter, ZAxis, Cell,
  PieChart, Pie,
} from 'recharts'
import { AdDetailPanel } from './AdDetailPanel'
import { AtriaExploreView } from './AtriaExploreView'
import { withCustomMetrics, deriveAssetType } from './ads/customMetrics'
import {
  FilterPillButton,
  DimensionFilterPopover, MetricFilterPopover,
  matchesFilters, matchesDimensionFilters,
  type MetricFilter, type JoinMode, type DimensionFilter,
  type DimensionFieldDef, type MetricOption,
} from './ads/FilterBuilder'
import { GroupByPill } from './ads/GroupBy'
import { groupAds, GROUP_BY_FIELDS } from './ads/groupByData'
import type { GroupByKey, GroupedRow } from './ads/groupByData'
import {
  type NamingConvention, ncFieldKey, parseAdName,
} from './ads/namingConvention'
import { ReportsMenu, type SavedReport } from './ads/ReportsMenu'
// BoardsMenu removed from Creative Analysis. only used on AtriaExploreView now.
import { BoardDetailModal } from './ads/BoardDetailModal'
import { useVirtualGrid, ZOOM_ROW_HEIGHT_GUESS, ZOOM_COLS_AT_XL } from './ads/useVirtualGrid'

// Parsed naming-convention tokens, attached by the backend.
export type NameConvention = {
  raw?: string
  objective?: string
  format?: string
  type?: string
  funnel?: string
  persona_hint?: string
  concept?: string
  flight?: string
  launch_date?: string
  date?: string
  owner?: string
  bidding?: string
  bid_strategy?: string
  audience?: string
  campaign_type?: string
  test_flag?: boolean
  extras?: string[]
}

export type AdCreative = {
  ad_id: string
  ad_name?: string
  adset_id?: string
  adset_name?: string
  campaign_id?: string
  campaign_name?: string
  creative_id?: string
  creative_hash: string
  // Meta's content-addressed image hash. Stable across ads that reuse the
  // same uploaded asset. the right key for "same visual creative" dedupe
  // (creative_hash is per-ad, not per-content).
  image_hash?: string | null
  // Backend-computed SHA256 of the resolved post-thumb image bytes. The
  // only reliable dedupe key for post-based ads where Meta doesn't
  // populate image_hash. Backend stamps this from the post-thumb disk
  // cache; null means we haven't resolved+cached the thumb yet (next
  // dashboard load will populate it).
  image_content_sha?: string | null
  image_url?: string | null
  // Full-resolution variant resolved via Meta's /adimages?hashes=… endpoint.
  // The detail panel prefers this; cards stay on `image_url` for bandwidth.
  image_url_hd?: string | null
  // Original (stp=-transformed) URL kept around in case we want the cheap
  // thumbnail in the grid even after the backend strips the transform.
  thumbnail_url_low?: string | null
  thumbnail_url?: string | null
  video_id?: string | null
  // Playable video source from Meta Graph. may be absent when Meta
  // restricts the video, in which case we surface `video_permalink`.
  video_source_url?: string | null
  video_permalink?: string | null
  video_embed_html?: string | null
  is_video?: boolean
  title?: string
  body?: string
  call_to_action_type?: string | null
  // Meta account id the ad belongs to ("act_1234…"), used for deep links.
  account_id?: string
  // "{page_id}_{post_id}". drives the public post-thumb scrape, which
  // bypasses the rate-limited Meta CDN signed URLs entirely.
  effective_object_story_id?: string | null
  // perf. base
  spend: number
  impressions: number
  clicks: number
  ctr: number
  cpm: number
  cpc: number
  purchases: number
  revenue: number
  roas: number
  reach?: number
  frequency?: number
  cost_per_purchase?: number
  cpp?: number
  unique_outbound_clicks?: number
  link_clicks?: number
  outbound_clicks?: number
  add_to_cart?: number
  add_to_cart_value?: number
  initiate_checkout?: number
  leads?: number
  landing_page_views?: number
  thruplays?: number
  video_3s_views?: number
  video_views?: number
  video_15s_views?: number
  video_avg_time_watched?: number
  video_p25?: number
  video_p50?: number
  video_p75?: number
  video_p100?: number
  // Engagement (Motion parity)
  post_reactions?: number
  post_comments?: number
  post_shares?: number
  post_engagement?: number
  post_saves?: number
  page_follows?: number
  see_more_clicks?: number
  // Derived fields attached client-side
  asset_type?: string
  planner_status?: string
  // Naming convention tokens from backend parser
  name_convention?: { ad?: NameConvention; adset?: NameConvention }
  // Pre-computed custom metrics (hook/hold/etc.) attached by withCustomMetrics
  hook_rate?: number
  hold_rate?: number
  conversion_rate?: number
  video_completion_rate?: number
  cpa?: number
  aov?: number
  hook_to_hold?: number
  stop_rate?: number
  ctr_link?: number
  ctr_outbound?: number
  cpc_link?: number
  cpc_outbound?: number
  follow_like_rate?: number
  comment_rate?: number
  engagement_rate?: number
  psr?: number
  see_more_rate?: number
  first_frame_retention?: number
  sustain_rate?: number
  v15_to_3s?: number
  click_quality?: number
  click_to_atc?: number
  click_to_leads?: number
  click_to_purchase?: number
  atc_to_purchase?: number
  cost_per_atc?: number
  cost_per_1k_ac_reached?: number
  cost_per_unique_outbound_click?: number
  // AI-derived sentiment, numeric (−1 .. +1 ish, see backend mapping).
  sentiment_score?: number
  sentiment_label?: string | null
  // Meta ad lifecycle. drives the live/paused dot on cards + status
  // pill in the table view.
  effective_status?: string | null   // ACTIVE | PAUSED | ARCHIVED | …
  configured_status?: string | null
  updated_time?: string | null       // ISO timestamp of last state change
  // Real funnel mix from Meta's user_segment_key breakdown (spend $ per
  // segment) + inferred reactivation flag. Drives the Hypothetical Funnel
  // Viewer's lane placement. Empty/absent = no segmented delivery for this ad.
  segment_spend?: {
    prospecting?: number
    engaged?: number
    existing?: number
    unknown?: number
    _raw?: Record<string, number>
  } | null
  reactivation?: boolean
  // Demo/sample ad (local image, no real Meta ad) → preview shows the image
  // directly instead of fetching Meta's preview iframe.
  is_demo?: boolean
}

type ChartMode = 'dashboard' | 'cards' | 'table' | 'bar' | 'line' | 'scatter' | 'funnel' | 'funnel-real' | 'funnel-demo'

// Frozen snapshot payload passed by the standalone report HTML. when
// present, every network fetch in this view is short-circuited and the
// dataset is hydrated from this object instead. The image proxy is also
// bypassed so the HTML renders offline against Meta's public CDN directly.
export type ReportSnapshot = {
  ads: AdCreative[]
  // Raw shape from /api/ads/dashboard. keyed by creative_hash or ad_id,
  // with { analysis: {...}, ad_id } entries. Passed straight into
  // hydrateAuxiliary so no transformation happens at read time.
  analyses: Record<string, any>
  // Raw shape from /api/ads/dashboard. keyed by ad_id, with { status } entries.
  statuses: Record<string, any>
  adIdToHash: Record<string, string>
  // Pre-computed per-ad timeseries so Line view works without a backend.
  timeseries?: Record<string, any[]>
}

interface Props {
  brand: string
  start: string
  end: string
  // Optional compare window threaded from the main-app date picker. When
  // supplied, pushed into the AdDetailPanel so the "vs." label matches the
  // user's chosen comparison instead of a trailing auto-window.
  compareStart?: string
  compareEnd?: string
  // When provided, the view renders in read-only "report" mode: no
  // fetches, no Save/Refresh affordances, image proxy bypassed so the
  // standalone report HTML works against Meta's CDN directly.
  snapshot?: ReportSnapshot
}

// Metric types + catalog live in ./ads/metrics for clean Fast Refresh
// (this file is a React component, so any non-component export here
// would invalidate HMR on every save). Re-exported for back-compat
// with downstream importers (ReachView, etc.).
export { METRIC_GROUP_ORDER, ALL_METRICS, METRICS_BY_KEY } from './ads/metrics'
export type { MetricGroup, MetricDef } from './ads/metrics'
import { ALL_METRICS, METRICS_BY_KEY, METRIC_GROUP_ORDER } from './ads/metrics'
import type { MetricGroup, MetricDef } from './ads/metrics'

// Subset of FileAnalysis we surface on the table row. Keyed by ad_id so the
// table can merge cached analyses into the existing AdCreative rows without
// a schema change upstream.
type AdAnalysisSummary = {
  template?: string
  funnelPosition?: string
  persona?: string
  sentiment?: string
  creativeClarityScore?: number
  creativeClarityFeedback?: string
  // Extended fields for dimension filters / group-by. Populated best-effort
  // from whatever the analysis cache has; missing values sink into the
  // "(unanalyzed)" bucket at the bottom.
  angle?: string
  marketAwareness?: string
  category?: string
  collection?: string
  offer?: string
  marketingMoment?: string
  emotion?: string
  // Differentiation scores (full FileAnalysis schema)
  visualDifferentiationScore?: number
  visualDifferentiationSummary?: string
  messagingDifferentiationScore?: number
  messagingDifferentiationSummary?: string
}


// Map MetricDef.format → MetricOption.unit for the unit badge ($/%/x/#) shown
// on the right of the value input in the metric filter popover.
function metricUnit(def: MetricDef): MetricOption['unit'] {
  if (def.format === 'dollar') return 'dollar'
  if (def.format === 'percent') return 'percent'
  if (def.format === 'decimal') return 'decimal'
  return 'number'
}

const DEFAULT_METRICS = ['campaign_name', 'effective_status', 'spend', 'roas', 'ctr', 'cpm', 'purchases']
// Fallback card-grid metrics. only used when the user hasn't picked any
// metrics in the Metrics picker. Otherwise cards reflect the picker set.
const DEFAULT_CARD_METRIC_KEYS = ['spend', 'roas', 'ctr', 'cpm']
const MAX_CHART_LINES = 10

// Fields excluded from the global row search. ad_id / creative_hash are
// long opaque identifiers (would produce spurious hits on short queries);
// image/thumbnail/video urls are binary-ish and noisy; asset_type /
// planner_status already have dedicated dimension filters so matching them
// here would just double-count. Pre-computed numeric metrics stay out of
// the scan. metric filters cover those with real operators.
const SEARCH_EXCLUDED_KEYS = new Set<string>([
  'ad_id',
  'creative_id',
  'creative_hash',
  'image_url',
  'thumbnail_url',
  'video_id',
  'is_video',
  'asset_type',
  'planner_status',
  'name_convention',
  'spend', 'impressions', 'clicks', 'ctr', 'cpm', 'cpc', 'cpp',
  'purchases', 'revenue', 'roas', 'reach', 'frequency',
  'cost_per_purchase', 'link_clicks', 'outbound_clicks', 'unique_outbound_clicks',
  'cost_per_atc', 'cost_per_1k_ac_reached', 'cost_per_unique_outbound_click',
  'account_id',
  'add_to_cart',
  'add_to_cart_value', 'initiate_checkout', 'leads', 'landing_page_views',
  'thruplays', 'video_3s_views', 'video_views', 'video_15s_views',
  'video_avg_time_watched',
  'video_p25', 'video_p50', 'video_p75', 'video_p100',
  'post_reactions', 'post_comments', 'post_shares',
  'post_engagement', 'post_saves', 'page_follows', 'see_more_clicks',
  'hook_rate', 'hold_rate', 'conversion_rate',
  'video_completion_rate', 'cpa', 'aov', 'hook_to_hold', 'stop_rate',
  'ctr_link', 'ctr_outbound', 'cpc_link', 'cpc_outbound',
  'follow_like_rate', 'comment_rate', 'engagement_rate', 'psr', 'see_more_rate',
  'first_frame_retention', 'sustain_rate', 'v15_to_3s',
  'click_quality', 'click_to_atc', 'click_to_leads', 'click_to_purchase',
  'atc_to_purchase',
  'analysis_creativeClarityScore',
  'analysis_visualDiffScore', 'analysis_messagingDiffScore',
])

// Case-insensitive substring match against every *textual* field on an ad
// row. Kept from the prior version: when the user sets Ad Name +
// `contains`, we widen the match to hit campaign/adset/title/body/CTA/
// analysis-tag text so "video" finds every video creative.
function matchesGlobalSearch(row: Record<string, any>, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  for (const [k, v] of Object.entries(row)) {
    if (SEARCH_EXCLUDED_KEYS.has(k)) continue
    if (v == null) continue
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    if (s.toLowerCase().includes(needle)) return true
  }
  return false
}

// Same palette as ChartView.tsx. consistent across the dashboard
const COLORS = [
  '#B7410E', '#2563eb', '#059669', '#dc2626', '#7c3aed',
  '#0891b2', '#ca8a04', '#be185d', '#0d9488', '#4b5563',
]

function fmt$(n: number): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '-'
  if (n >= 1000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  return `$${n.toFixed(2)}`
}
function fmtNum(n: number): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '-'
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}
function fmtPct(n: number): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '-'
  return `${n.toFixed(2)}%`
}
function fmtDec(n: number): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '-'
  return n.toFixed(2)
}

function fmtMetric(v: number | undefined | null, def: MetricDef): string {
  if (def.format === 'text') return String(v ?? '-')
  // Distinguish "metric not available" (null/undefined) from "actually 0".
  // sentiment_score in particular uses null for unanalyzed ads. rendering
  // them as 0.00 (neutral) would lie to the user about what we know.
  if (v === null || v === undefined) return '-'
  const n = Number(v)
  if (Number.isNaN(n)) return '-'
  if (def.format === 'dollar') return fmt$(n)
  if (def.format === 'percent') return fmtPct(n)
  if (def.format === 'decimal') return fmtDec(n)
  return fmtNum(n)
}

// Lower-is-better metrics. for these, an upward delta is bad (red).
// Mirrors the LOWER_IS_BETTER set in AdDetailPanel so the table /
// card delta chips paint the same way as the detail-panel deltas.
const LOWER_IS_BETTER_KEYS = new Set<string>([
  'cpm', 'cpc', 'cpc_link', 'cpc_outbound', 'cpa', 'cost_per_purchase',
  'cost_per_atc', 'cost_per_1k_ac_reached', 'cost_per_unique_outbound_click',
  'stop_rate',
])

// Inline period-over-period delta chip. Renders nothing when there's
// no prev value or the prev is zero (can't compute a meaningful pct).
// Compact enough to sit inside a table cell next to the formatted value.
function DeltaChip({
  current, prev, metricKey,
}: {
  current: number | undefined | null
  prev: number | undefined | null
  metricKey: string
}) {
  if (current === undefined || current === null || prev === undefined || prev === null) return null
  const cur = Number(current); const pv = Number(prev)
  if (!Number.isFinite(cur) || !Number.isFinite(pv) || pv === 0) return null
  const pct = ((cur - pv) / Math.abs(pv)) * 100
  if (!Number.isFinite(pct) || pct === 0) return null
  const up = pct > 0
  const lowerBetter = LOWER_IS_BETTER_KEYS.has(metricKey)
  const good = lowerBetter ? !up : up
  const color = good ? '#15803d' : '#b91c1c'
  // ±NN%, capped at three significant digits, no trailing decimals when integer.
  const txt = `${up ? '+' : ''}${Math.abs(pct) >= 100 ? pct.toFixed(0) : pct.toFixed(1)}%`
  return (
    <span
      className="ml-1 inline-flex items-center text-[9px] tabular-nums align-middle"
      style={{ color }}
      title={`vs prior period: ${pv.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
    >
      {up ? '↑' : '↓'}{txt.replace(/^[-+]/, '')}
    </span>
  )
}

// Compact label for charts. "Foo Campaign / FOO_AD_V3" can be 60+ chars
function shortLabel(ad: AdCreative): string {
  const n = ad.ad_name || ad.ad_id
  return n.length > 28 ? n.slice(0, 26) + '…' : n
}

// localStorage keys. follow the `ac.*` convention from the main dashboard
const LS_METRICS = 'ac.ads.metrics'
const LS_VIEW = 'ac.ads.chartMode'
const LS_ZOOM = 'atelier.ads.gridZoom'
const LS_SORT = 'atelier.ads.sort'

// ---------------------------------------------------------------------------
// Stale-while-revalidate client cache for /api/ads/creatives.
//
// Keyed by `{brand}::{start}::{end}`. Memory map (`MEM_CREATIVES_CACHE`) is
// the primary store; `sessionStorage` is a secondary persistence layer so
// tab switches within the SPA (and brief page navigations) don't pay the
// network cost. Persistence is best-effort. we skip sessionStorage if the
// serialized payload trips the 2 MB safety cap, and we silently ignore any
// quota errors.
//
// We deliberately store ONLY the creatives row array (no AI analysis. that
// contains per-ad base64 imagery and blows past quota instantly).
// ---------------------------------------------------------------------------
type CreativesCacheEntry = { ts: number; ads: AdCreative[] }
const MEM_CREATIVES_CACHE = new Map<string, CreativesCacheEntry>()
// v5. adds effective_status / configured_status / updated_time / sentiment_score
// onto each ad. Bumping the prefix invalidates stale v4 entries that don't
// carry those fields, otherwise the L/P/A keyboard filters drop everything.
const SS_CREATIVES_PREFIX = 'ac.ads.creatives.v5::'
// Upper bound on one serialized entry. Keeps one very-large brand's payload
// from filling the ~5 MB total sessionStorage quota for the origin.
const SS_CREATIVES_MAX_BYTES = 2 * 1024 * 1024

function creativesCacheKey(brand: string, start: string, end: string): string {
  return `${brand}::${start}::${end}`
}

function readCreativesCache(brand: string, start: string, end: string): AdCreative[] | null {
  if (!brand || !start || !end) return null
  const key = creativesCacheKey(brand, start, end)
  const mem = MEM_CREATIVES_CACHE.get(key)
  if (mem) return mem.ads
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(SS_CREATIVES_PREFIX + key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.ads)) return null
    // Hydrate the memory tier so subsequent reads stay instant.
    MEM_CREATIVES_CACHE.set(key, { ts: Number(parsed.ts) || Date.now(), ads: parsed.ads })
    return parsed.ads as AdCreative[]
  } catch {
    return null
  }
}

function writeCreativesCache(brand: string, start: string, end: string, ads: AdCreative[]): void {
  if (!brand || !start || !end) return
  const key = creativesCacheKey(brand, start, end)
  MEM_CREATIVES_CACHE.set(key, { ts: Date.now(), ads })
  if (typeof window === 'undefined') return
  try {
    const json = JSON.stringify({ ts: Date.now(), ads })
    // Rough byte estimate. UTF-16 in memory but bytes-on-disk are close
    // enough to JSON length in bytes for the 2 MB guardrail.
    if (json.length > SS_CREATIVES_MAX_BYTES) return
    window.sessionStorage.setItem(SS_CREATIVES_PREFIX + key, json)
  } catch {
    // Quota / privacy-mode errors are non-fatal. memory tier still serves.
  }
}

// ---------------------------------------------------------------------------
// Preload cache. populated by `preloadAds()` on sidebar click, consumed by
// the component on mount. Purely in-memory; the sessionStorage layer above
// still handles cross-tab / cross-navigation survival.
//
// Key shape intentionally matches `creativesCacheKey` so a future migration
// can fold these into the same Map.
// ---------------------------------------------------------------------------
type PreloadPayload = {
  ads: AdCreative[]
  analyses: Record<string, any>
  statuses: Record<string, string>
  adIdToHash: Record<string, string>
}
const PRELOAD_CACHE = new Map<string, { ts: number; payload: PreloadPayload }>()
const PRELOAD_TTL_MS = 5 * 60 * 1000

// Per-page-load nonce stamped onto image URLs so stale browser
// HTTP-cache entries (e.g. 502 placeholder responses from a brief
// upstream rate-limit window) can't poison the cards grid for an
// entire session. Re-rolls every full reload but stable across
// component re-renders within one session.
// Use millisecond precision + a random salt so even rapid back-to-back
// reloads (under a second apart) get distinct nonces and bypass any
// browser-cached 502 placeholders from prior rate-limit windows.
const SESSION_NONCE = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
// In-flight preloads. dedupes rapid sidebar clicks / overlapping mounts.
const PRELOAD_INFLIGHT = new Map<string, Promise<PreloadPayload | null>>()

function preloadKey(brand: string, start: string, end: string): string {
  return creativesCacheKey(brand, start, end)
}

function readPreloadCache(brand: string, start: string, end: string): PreloadPayload | null {
  if (!brand || !start || !end) return null
  const entry = PRELOAD_CACHE.get(preloadKey(brand, start, end))
  if (!entry) return null
  if (Date.now() - entry.ts > PRELOAD_TTL_MS) {
    PRELOAD_CACHE.delete(preloadKey(brand, start, end))
    return null
  }
  return entry.payload
}

/**
 * Kick off the Ad Analysis data fetch before the component mounts. Wired to
 * the sidebar tab icon so clicking "Ad Analysis" begins network I/O during
 * the same click that will eventually switch tabs. shaving ~1-2 s off
 * perceived load for cold caches. Safe to call repeatedly; concurrent
 * calls share the same in-flight promise.
 */
export function preloadAds(brand: string, start: string, end: string): Promise<PreloadPayload | null> {
  if (!brand || !start || !end) return Promise.resolve(null)
  const key = preloadKey(brand, start, end)
  const existing = PRELOAD_INFLIGHT.get(key)
  if (existing) return existing
  const fresh = readPreloadCache(brand, start, end)
  if (fresh) return Promise.resolve(fresh)
  const p = (async () => {
    try {
      const r = await fetch(
        `/api/ads/dashboard?brand=${encodeURIComponent(brand)}&start=${start}&end=${end}&limit=120`
      )
      if (!r.ok) return null
      const d = await r.json()
      if (d?.detail) return null
      const payload: PreloadPayload = {
        ads: Array.isArray(d.ads) ? (d.ads as AdCreative[]) : [],
        analyses: d.analyses || {},
        statuses: d.statuses || {},
        adIdToHash: d.ad_id_to_hash || {},
      }
      PRELOAD_CACHE.set(key, { ts: Date.now(), payload })
      // Also hydrate the SWR cache so the existing cache-first code path
      // sees the ads array immediately. whichever reader fires first wins.
      writeCreativesCache(brand, start, end, payload.ads)
      return payload
    } catch {
      return null
    } finally {
      PRELOAD_INFLIGHT.delete(key)
    }
  })()
  PRELOAD_INFLIGHT.set(key, p)
  return p
}

// ---------------------------------------------------------------------------
// Image proxy. rewrites Meta scontent CDN URLs to /api/ads/img?u=<url>
// so the backend can serve from its disk cache on repeat hits. Non-Meta
// URLs pass through unchanged (e.g. already-cached proxy URLs, data URIs).
// ---------------------------------------------------------------------------
export function toProxyImg(url: string | null | undefined): string | null | undefined {
  if (!url) return url
  if (typeof url !== 'string') return url
  // Already a data URI / blob / same-origin proxy URL. don't double-wrap.
  if (url.startsWith('data:') || url.startsWith('blob:')) return url
  if (url.startsWith('/api/ads/img')) return url
  // Only proxy external images. This keeps relative / local URLs intact.
  if (!/^https?:\/\//i.test(url)) return url
  // In report mode (standalone HTML with no backend), hit Meta's public
  // CDN directly instead of routing through the proxy endpoint.
  if (typeof window !== 'undefined' && (window as any).__REPORT__) return url
  return `/api/ads/img?u=${encodeURIComponent(url)}`
}

// Prefer the public post thumbnail (og:image scrape, no Meta API hit) when
// we have a story_id. Falls back to the rate-limited Meta CDN proxy. The
// returned URL is what an `<img src>` should start with; on failure the
// caller's onError handler is responsible for swapping in the legacy chain.
export function postThumbSrc(ad: { effective_object_story_id?: string | null }): string | null {
  const story = ad.effective_object_story_id
  if (!story || typeof story !== 'string' || !story.includes('_')) return null
  if (typeof window !== 'undefined' && (window as any).__REPORT__) return null
  return `/api/ads/post-thumb?story_id=${encodeURIComponent(story)}`
}

export function bestThumb(ad: AdCreative): string | null | undefined {
  return postThumbSrc(ad) ?? toProxyImg(ad.image_url || ad.thumbnail_url)
}

// =============================================================================
// Thumbnail. unified creative-preview component used by every surface in
// the Ad Analysis tab (cards grid, table, timeline strip, hover preview,
// bar-chart axis, group rollup). Replaces the ad-hoc <img> blocks that each
// view used to write. so any URL that resolves on one surface resolves on
// all of them.
//
// Resolution chain (in order, advances on <img onError>):
//   1. og:image scrape. only if the ad has effective_object_story_id.
//      Skips the Meta API entirely. Misses for dark / DPA / unpublished ads
//      and for static feed creatives without a story_id (the failure mode
//      the user reported on 2026-04-28).
//   2. image_url proxy. uses the cached image URL the dashboard already
//      pulled. Cheap. CDN signatures rotate, so this can 403 mid-session.
//   3. /api/ads/img-by-ad. authenticated Meta Graph fetch. Catches every
//      surviving case (statics, dark posts, archived). Disk-cached forever
//      by ad_id on the backend.
//
// On terminal failure: hits /api/ads/refresh-urls once to ask Meta for fresh
// CDN signatures, then re-mounts the apiThumb <img> with a cache-busting
// nonce. Only after THAT also fails do we render "No preview".
//
// Eager loading by default. `loading="lazy"` was deferring requests until
// the user scrolled near, which manifested as static-feed thumbnails staying
// blank until clicked. Pulsing skeleton bridges the loading gap.
// =============================================================================
// Bulk-fetched video durations keyed by video_id. Provided at the
// AdAnalysisView root after each ads load so Thumbnail can overlay an
// "Xs" duration badge on video cards. Falls back to "Video" when the
// length isn't cached server-side yet. see /api/ads/video-lengths.
const VideoLengthContext = createContext<Record<string, number>>({})

function fmtVideoLen(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}

function VideoDurationBadge({ videoId }: { videoId: string | null }) {
  const lengths = useContext(VideoLengthContext)
  const len = videoId ? lengths[videoId] : undefined
  const label = len ? fmtVideoLen(len) : 'Video'
  return (
    <div className="absolute top-2 right-2 glass rounded-full px-1.5 py-0.5 flex items-center gap-1 text-[10px] pointer-events-none">
      <Play size={8} fill="currentColor" /> {label}
    </div>
  )
}

export function Thumbnail({
  ad,
  brand,
  className = '',
  imgClassName = '',
  showVideoBadge = false,
  alt,
  retryNonce = 0,
}: {
  ad: AdCreative
  brand?: string
  className?: string
  imgClassName?: string
  showVideoBadge?: boolean
  alt?: string
  // Bump to force a re-attempt of this thumbnail — but only if it hasn't
  // loaded yet. Loaded thumbnails ignore it (no flicker). Used by the funnel
  // viewer's "refresh" button and its auto-retry poll.
  retryNonce?: number
}) {
  // Two-stage chain. Proxy URL first (fast. Meta-signed URL already in
  // the dashboard response, server has it disk-cached or fetches once
  // and caches forever). Falls back to img-by-ad ONLY on terminal proxy
  // failure (fresh resolve via Graph API, slower but bulletproof).
  // The single-path version forced 120 simultaneous Meta-API calls on
  // freshly-ingested brands and the whole grid stalled.
  const isReport = typeof window !== 'undefined' && (window as any).__REPORT__
  const sources = useMemo(() => {
    if (isReport || !brand || !ad.ad_id) return [] as string[]
    const out: string[] = []
    // Stage 1. public og:image scrape via story_id. Bypasses Meta API
    // entirely. Catches the static-feed-creative case where the signed
    // CDN proxy URL has rotated since the dashboard pulled it. Detail
    // panel already does this; grid was skipping it (cause of "preview
    // only shows after clicking").
    const proxyUrl = toProxyImg(ad.image_url_hd || ad.image_url || ad.thumbnail_url)
    const isLocal = typeof proxyUrl === 'string' && (proxyUrl.startsWith('data:') || proxyUrl.startsWith('blob:'))
    if (isLocal) {
      // Demo/sample ads carry a self-contained data-URI — use it directly,
      // no Meta resolve needed.
      out.push(proxyUrl as string)
      return out
    }
    const post = postThumbSrc(ad)
    if (post) out.push(post)
    // img-by-ad (fresh Graph resolve, disk-cached) BEFORE the stored proxy URL.
    // The stored image_url_hd/image_url are signed Meta CDN links whose
    // `oh=`/`oe=` signatures expire within hours of the pull → the proxy 403s
    // on them. img-by-ad re-resolves live and reliably 200s, so trying it
    // first (after the free og:image scrape) is what actually fills the grid.
    out.push(
      `/api/ads/img-by-ad?ad_id=${encodeURIComponent(ad.ad_id)}&brand=${encodeURIComponent(brand)}&kind=auto&s=${SESSION_NONCE}`,
    )
    if (proxyUrl && typeof proxyUrl === 'string') out.push(proxyUrl)
    return out
  }, [ad.effective_object_story_id, ad.image_url_hd, ad.image_url, ad.thumbnail_url, ad.ad_id, brand, isReport])

  const [stage, setStage] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [terminallyBroken, setTerminallyBroken] = useState(false)
  const [nonce, setNonce] = useState(0)
  // Number of times we've cycled the full chain after a terminal failure.
  // Image resolution can fail transiently (Meta rate limits, signature
  // mismatch, prefetch hasn't populated cache yet); the user reported
  // detail-panel previews loading after a delay even when the grid said
  // "No preview". Retrying every few seconds covers that case without
  // requiring a manual refresh.
  const [retryCount, setRetryCount] = useState(0)
  const RETRY_LIMIT = 4
  const RETRY_DELAY_MS = 6_000
  // Final fallback: when every <img>-based path has failed, fetch Meta's
  // own rendered preview and render it as an iframe. This is the same
  // path the detail panel uses (the user explicitly noted the detail
  // view shows the creative even when the grid card says "No preview"),
  // so it's the most reliable recourse for ads where image extraction
  // fails. Iframes are heavy, so we only fire this after the image
  // chain + retries are exhausted.
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)

  // Reset state on ad identity change so virtual-scroll reuse doesn't
  // carry the previous ad's flags.
  useEffect(() => {
    setStage(0)
    setLoaded(false)
    setTerminallyBroken(false)
    setNonce(0)
    setRetryCount(0)
    setPreviewSrc(null)
    setPreviewLoading(false)
  }, [ad.ad_id])

  // Manual refresh (retryNonce bumped by the funnel viewer): re-attempt the
  // whole resolution chain, but ONLY if this thumbnail hasn't loaded — loaded
  // ones are left alone so they don't flicker. A loaded image reloads from
  // browser cache anyway; only the failed ones actually re-hit the network.
  const loadedRef = useRef(loaded)
  loadedRef.current = loaded
  useEffect(() => {
    if (!retryNonce || loadedRef.current) return
    setStage(0)
    setTerminallyBroken(false)
    setRetryCount(0)
    setNonce(n => n + 1)   // cache-bust the api stage so it re-fetches
  }, [retryNonce])

  // Auto-retry after a terminal failure. Backend prefetches keep filling
  // disk caches in the background; by the time we retry, img-by-ad may
  // succeed where it 502'd a moment ago.
  useEffect(() => {
    if (!terminallyBroken) return
    if (retryCount >= RETRY_LIMIT) return
    const t = setTimeout(() => {
      setStage(0)
      setLoaded(false)
      setNonce(n => n + 1)
      setTerminallyBroken(false)
      setRetryCount(c => c + 1)
    }, RETRY_DELAY_MS)
    return () => clearTimeout(t)
  }, [terminallyBroken, retryCount])

  // Race the iframe fallback alongside the image chain. We used to wait
  // for terminallyBroken + 2 retries × 6s = ~12s of failed attempts
  // before even *requesting* the iframe. root cause of "preview never
  // loads on grid". Now: 2.5s after mount, if the image still hasn't
  // loaded, fetch Meta's preview iframe src in parallel. The 1h
  // _preview_cache absorbs repeat calls across cards, so this is at most
  // one Meta hit per ad per hour.
  useEffect(() => {
    if (loaded || previewSrc || previewLoading) return
    if (!ad.ad_id || isReport) return
    const exhausted = terminallyBroken && retryCount >= RETRY_LIMIT
    const delayMs = exhausted ? 0 : 2500
    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled || loaded) return
      setPreviewLoading(true)
      fetch(`/api/ads/preview-iframe-src?ad_id=${encodeURIComponent(ad.ad_id)}&ad_format=MOBILE_FEED_STANDARD`)
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (cancelled) return
          if (d && typeof d.src === 'string' && d.src) setPreviewSrc(d.src)
        })
        .catch(() => { /* keep current state */ })
        .finally(() => { if (!cancelled) setPreviewLoading(false) })
    }, delayMs)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [loaded, previewSrc, previewLoading, terminallyBroken, retryCount, ad.ad_id, isReport])

  // If the browser has the bytes in HTTP cache, onLoad won't fire on
  // remount. the img is `complete` immediately. Without this, scrolling
  // away and back makes thumbnails flash blank for a frame.
  useEffect(() => {
    const el = imgRef.current
    if (el && el.complete && el.naturalWidth > 4) {
      setLoaded(true)
    }
  })

  const baseSrc = sources[stage]
  // Cache-bust only the api stage; the proxied direct URLs are content-
  // addressed by Meta's URL signature and don't need a nonce.
  const isApiStage = !!baseSrc && baseSrc.startsWith('/api/ads/img-by-ad')
  const src = baseSrc && nonce > 0 && isApiStage ? `${baseSrc}&n=${nonce}` : baseSrc

  const handleLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    // Detect the 1×1 transparent PNG placeholder the backend used to serve
    // (and which can persist in the browser HTTP cache). A real Meta
    // creative is at least 64×64.
    const img = e.currentTarget
    if (img.naturalWidth <= 4 && img.naturalHeight <= 4) {
      handleError()
      return
    }
    setLoaded(true)
  }

  const handleError = () => {
    // Walk to the next source.
    if (stage < sources.length - 1) {
      setStage(stage + 1)
      setLoaded(false)
      return
    }
    // On the apiThumb final stage: bump a cache-busting nonce ONCE to force
    // the browser to bypass any stale cached placeholder, before giving up.
    if (isApiStage && nonce === 0) {
      setNonce(1)
      setLoaded(false)
      return
    }
    setTerminallyBroken(true)
  }

  // Catalog / DPA ads embed `{{product.*}}` template tokens that don't
  // resolve to a single static image. the entire creative is a carousel
  // of dynamic product cards. The image-chain stages here all fail
  // silently and the grid lands on a generic broken-image icon. Detect
  // Render priority:
  //   1. Catalog ad → labeled placeholder (image chain is meaningless)
  //   2. Image, if it's already loaded (it's showing. don't yank it)
  //   3. Iframe-preview, if the race kicked in and we have a src
  //   4. Image still trying (skeleton + hidden img)
  //   5. Skeleton / "No preview" terminal state
  // The iframe may arrive before the img loads. when it does, we swap
  // to it so the user isn't staring at a skeleton.
  const showImage = !terminallyBroken && !!src && (loaded || !previewSrc)
  const showIframePreview = !!previewSrc && !loaded

  return (
    <div className={`relative w-full h-full overflow-hidden bg-black/[0.04] ${className}`}>
      {showImage ? (
        <>
          {!loaded && <div className="absolute inset-0 ac-thumb-skeleton" aria-hidden="true" />}
          <img
            ref={imgRef}
            key={src}
            src={src}
            alt={alt ?? ad.ad_name ?? ad.ad_id ?? ''}
            decoding="async"
            onLoad={handleLoad}
            onError={handleError}
            className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'} ${imgClassName}`}
          />
        </>
      ) : showIframePreview ? (
        // Iframe fallback. same Meta preview the detail panel uses.
        // Inner iframe is intrinsically ~400px wide; scale down to fit
        // the card and crop to the hero area (drop chrome / reactions).
        <iframe
          src={previewSrc!}
          title={ad.ad_name ?? ad.ad_id ?? 'ad preview'}
          className="absolute pointer-events-none"
          style={{
            width: 400,
            height: 720,
            border: 0,
            top: 0,
            left: '50%',
            transform: 'translateX(-50%) scale(var(--thumb-scale, 0.4))',
            transformOrigin: 'top center',
          }}
          scrolling="no"
          sandbox="allow-scripts allow-same-origin"
        />
      ) : terminallyBroken && retryCount >= RETRY_LIMIT && !previewLoading ? (
        // Intentional "no preview" placeholder — reads as deliberate, not broken.
        // Meta doesn't always return a fetchable creative image (dark posts,
        // dynamic/catalog ads, rotated CDN signatures); the ad is still real.
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-neutral-400"
          style={{ background: 'linear-gradient(135deg,#f3f2f0,#e9e7e3)' }} aria-label="No preview available">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2.5" />
            <circle cx="8.5" cy="8.5" r="1.6" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
          <span className="text-[9px] font-sans tracking-wide">No preview</span>
        </div>
      ) : (
        <div className="absolute inset-0 ac-thumb-skeleton" aria-hidden="true" />
      )}
      {showVideoBadge && ad.is_video && (
        <VideoDurationBadge videoId={ad.video_id || null} />
      )}
    </div>
  )
}

// Motion-style card grid: zoom level drives Tailwind grid-cols breakpoints.
// Level 1 (compact, ~8/row @ 1280) → Level 5 (large, 3/row @ 1280).
// Level 3 is the default. matches the prior tightened sizing.
const GRID_ZOOM_CLASSES: Record<number, string> = {
  1: 'grid-cols-4 sm:grid-cols-6 md:grid-cols-7 lg:grid-cols-8 xl:grid-cols-10 2xl:grid-cols-12',
  2: 'grid-cols-3 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-8 2xl:grid-cols-10',
  3: 'grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8',
  4: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7',
  5: 'grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6',
}
// Density-aware metric chip sizing. small zoom = hide some fields
const GRID_ZOOM_METRIC_COUNT: Record<number, number> = { 1: 4, 2: 4, 3: 6, 4: 6, 5: 6 }

// Planner status cache. bulk fetch is cheap but we also keep an in-memory
// cache per brand for the session (5 min TTL).
const STATUS_CACHE: Record<string, { ts: number; data: Record<string, string> }> = {}

// Brand-profile cache. naming convention rarely changes so a session-long
// cache eliminates a fetch every brand-switch. 5 min TTL is safe enough
// that an edit on the Profile tab still surfaces here on next visit.
const PROFILE_CACHE = new Map<string, { ts: number; data: any }>()
const PROFILE_TTL_MS = 5 * 60_000

// /api/status is brand-invariant. load once per session.
type BreakdownOpt = { key: string; label: string }
let META_BREAKDOWN_OPTIONS: BreakdownOpt[] | null = null
let META_BREAKDOWN_LOADING: Promise<BreakdownOpt[]> | null = null
const STATUS_TTL_MS = 5 * 60 * 1000

// Static dimension option lists. mirror the planner taxonomy values
// surfaced elsewhere in the app. Dynamic dimensions (campaign / adset /
// analysis tags) resolve options from the current dataset at runtime.
const ASSET_TYPES = ['Image', 'Video', 'Carousel']
const PLANNER_STATUSES = [
  'Planning', 'In Production', 'Internal Review',
  'Ready for External Review', 'Approved', 'Live', 'Archived', 'Unlinked',
]

// Dimension field catalog for the filter popover. Static lists carry their
// own options; the rest resolve via `getOptions` at render time.
const DIMENSION_FIELDS: DimensionFieldDef[] = [
  { key: 'campaign_name', label: 'Campaign' },
  { key: 'adset_name', label: 'Ad Set' },
  { key: 'ad_name', label: 'Ad Name' },
  { key: 'asset_type', label: 'Asset Type', options: ASSET_TYPES },
  { key: 'planner_status', label: 'Status', options: PLANNER_STATUSES },
  // Naming convention tokens. populated by the backend parser
  { key: 'nc_objective', label: 'Objective (name)' },
  { key: 'nc_format', label: 'Format (name)' },
  { key: 'nc_type', label: 'Type (name)' },
  { key: 'nc_funnel', label: 'Funnel (name)' },
  { key: 'nc_persona_hint', label: 'Persona (name)' },
  { key: 'nc_owner', label: 'Owner (adset)' },
  { key: 'nc_bidding', label: 'Bidding (adset)' },
  { key: 'nc_audience', label: 'Audience (adset)' },
  { key: 'nc_concept', label: 'Concept (name)' },
  // AI analysis
  { key: 'analysis_angle', label: 'Angle' },
  { key: 'analysis_persona', label: 'Persona' },
  { key: 'analysis_template', label: 'Template' },
  { key: 'analysis_funnelPosition', label: 'Funnel Position' },
  { key: 'analysis_marketAwareness', label: 'Market Awareness' },
  { key: 'analysis_sentiment', label: 'Sentiment' },
  { key: 'analysis_category', label: 'Category' },
  { key: 'analysis_collection', label: 'Collection' },
  { key: 'analysis_offer', label: 'Offer' },
  { key: 'analysis_marketingMoment', label: 'Moment' },
  { key: 'analysis_emotion', label: 'Emotion' },
]

// Pretty label for the currently active group-by dimension.
function groupByLabel(k: GroupByKey): string {
  switch (k) {
    case 'campaign_name': return 'Campaign'
    case 'adset_name': return 'Ad Set'
    case 'ad_name': return 'Ad Name'
    case 'asset_type': return 'Asset Type'
    case 'planner_status': return 'Status'
    case 'nc_objective': return 'Objective (name)'
    case 'nc_format': return 'Format (name)'
    case 'nc_type': return 'Type (name)'
    case 'nc_funnel': return 'Funnel (name)'
    case 'nc_persona_hint': return 'Persona (name)'
    case 'nc_owner': return 'Owner'
    case 'nc_bidding': return 'Bidding'
    case 'nc_audience': return 'Audience'
    case 'nc_concept': return 'Concept'
    case 'analysis_angle': return 'Angle'
    case 'analysis_persona': return 'Persona'
    case 'analysis_template': return 'Template'
    case 'analysis_funnelPosition': return 'Funnel Position'
    case 'analysis_marketAwareness': return 'Market Awareness'
    case 'analysis_sentiment': return 'Sentiment'
    case 'analysis_category': return 'Category'
    case 'analysis_collection': return 'Collection'
    case 'analysis_offer': return 'Offer'
    case 'analysis_marketingMoment': return 'Moment'
    case 'analysis_emotion': return 'Emotion'
    default: return 'Group'
  }
}

// ---------------------------------------------------------------------------
// /api/ads/refresh-urls. module-level debounce + batching
// ---------------------------------------------------------------------------
//
// A single batch of expired Meta CDN URLs can surface as 30-50 near-simultaneous
// `<img onError>` events. Firing /api/ads/refresh-urls per failed image burns
// Meta app-level quota fast. We coalesce in three layers:
//   1. Per-session dedupe. once we've refreshed an ad_id successfully in
//      this tab, we never fire again for it (fresh URLs stick in state).
//   2. Per-ad cooldown. after any attempt (success or failure), skip the
//      same ad_id for REFRESH_AD_COOLDOWN_MS before trying again.
//   3. Window debounce. onError events within REFRESH_BATCH_WINDOW_MS are
//      collected, then fired as one promise per unique ad_id.
//   4. Global 503 lockout. if the backend returns 503 with Retry-After,
//      stop firing refresh-urls entirely for that window.
//
// The global lockout timestamp is also exposed via a subscribe() hook so
// the banner at the top of AdAnalysisView can surface a countdown.

const REFRESH_BATCH_WINDOW_MS = 5_000
const REFRESH_AD_COOLDOWN_MS = 5 * 60_000 // 5 min before retrying the same id

type RefreshResult = {
  ad_id: string
  image_url?: string | null
  image_url_hd?: string | null
  thumbnail_url?: string | null
  video_source_url?: string | null
  video_permalink?: string | null
}

type PendingEntry = {
  brand: string
  resolvers: Array<(r: RefreshResult | null) => void>
}

const _refreshPending: Map<string, PendingEntry> = new Map()
const _refreshLastAttempt: Map<string, number> = new Map()
const _refreshInFlight: Map<string, Promise<RefreshResult | null>> = new Map()
let _refreshFlushTimer: ReturnType<typeof setTimeout> | null = null
let _refreshGlobalLockoutUntil = 0
const _lockoutSubscribers = new Set<(until: number) => void>()

function _notifyLockoutSubscribers() {
  for (const fn of _lockoutSubscribers) {
    try { fn(_refreshGlobalLockoutUntil) } catch {}
  }
}

export function subscribeRefreshLockout(fn: (until: number) => void): () => void {
  _lockoutSubscribers.add(fn)
  // Fire once so the caller hydrates with the current state.
  try { fn(_refreshGlobalLockoutUntil) } catch {}
  return () => { _lockoutSubscribers.delete(fn) }
}

function _setGlobalLockout(retryAfterSeconds: number) {
  const until = Date.now() + Math.max(1, retryAfterSeconds) * 1000
  if (until > _refreshGlobalLockoutUntil) {
    _refreshGlobalLockoutUntil = until
    _notifyLockoutSubscribers()
  }
}

async function _flushRefreshBatch() {
  _refreshFlushTimer = null
  const batch = Array.from(_refreshPending.entries())
  _refreshPending.clear()

  // Honor the global lockout. reject every queued resolver without
  // touching Meta. The banner is already surfaced by the subscriber.
  if (Date.now() < _refreshGlobalLockoutUntil) {
    for (const [, entry] of batch) {
      for (const resolve of entry.resolvers) resolve(null)
    }
    return
  }

  for (const [ad_id, entry] of batch) {
    const last = _refreshLastAttempt.get(ad_id) || 0
    if (Date.now() - last < REFRESH_AD_COOLDOWN_MS) {
      for (const resolve of entry.resolvers) resolve(null)
      continue
    }
    // Coalesce concurrent requests for the same ad_id into a single fetch.
    let p = _refreshInFlight.get(ad_id)
    if (!p) {
      p = (async () => {
        _refreshLastAttempt.set(ad_id, Date.now())
        try {
          const r = await fetch(`/api/ads/refresh-urls?brand=${encodeURIComponent(entry.brand)}&ad_id=${encodeURIComponent(ad_id)}`)
          if (r.status === 503) {
            const retry = Number(r.headers.get('Retry-After') || '300')
            _setGlobalLockout(Number.isFinite(retry) && retry > 0 ? retry : 300)
            return null
          }
          if (!r.ok) return null
          return (await r.json()) as RefreshResult
        } catch {
          return null
        } finally {
          // Clear after a microtask so siblings in the same batch can reuse.
          setTimeout(() => { _refreshInFlight.delete(ad_id) }, 0)
        }
      })()
      _refreshInFlight.set(ad_id, p)
    }
    p.then(res => {
      for (const resolve of entry.resolvers) resolve(res)
    })
  }
}

/**
 * Force a fresh Meta CDN URL pull for every ad_id regardless of the
 * module-level cooldowns. The standard path (`requestRefreshUrls`) is
 * tuned to minimize background noise, but when the user explicitly asks
 * for "re-sign every thumbnail now" (blank-tile wall after CDN signatures
 * rotate), we bypass the 5-min per-ad cooldown and the 503 lockout in
 * flight. the backend's own /refresh-urls debounce still protects Meta.
 *
 * Concurrency is capped at 8 parallel requests. Results arrive as they
 * land; the `onProgress` callback fires after each so the UI can tick a
 * "12 / 120 refreshed" counter.
 */
export async function forceRefreshUrls(
  brand: string,
  ad_ids: string[],
  onProgress?: (done: number, total: number, latest?: RefreshResult | null) => void,
  concurrency = 8,
): Promise<Array<RefreshResult | null>> {
  const results: Array<RefreshResult | null> = new Array(ad_ids.length).fill(null)
  let done = 0
  let next = 0

  async function worker() {
    while (next < ad_ids.length) {
      const i = next++
      const ad_id = ad_ids[i]
      try {
        // Bump the cooldown timestamp *before* firing so any concurrent
        // onError handler from the same card doesn't double-request.
        _refreshLastAttempt.set(ad_id, Date.now())
        const r = await fetch(
          `/api/ads/refresh-urls?brand=${encodeURIComponent(brand)}&ad_id=${encodeURIComponent(ad_id)}`,
        )
        if (r.status === 503) {
          const retry = Number(r.headers.get('Retry-After') || '300')
          _setGlobalLockout(Number.isFinite(retry) && retry > 0 ? retry : 300)
          results[i] = null
        } else if (r.ok) {
          results[i] = (await r.json()) as RefreshResult
        } else {
          results[i] = null
        }
      } catch {
        results[i] = null
      }
      done += 1
      if (onProgress) onProgress(done, ad_ids.length, results[i])
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, ad_ids.length) },
    worker,
  )
  await Promise.all(workers)
  return results
}

/**
 * Request fresh Meta CDN URLs for a single ad. Multiple callers for the same
 * ad_id in a 5-second window coalesce to one backend call. Returns null when
 * the backend is rate-limited or the ad is in its cooldown window.
 */
export function requestRefreshUrls(brand: string, ad_id: string): Promise<RefreshResult | null> {
  // Short-circuit when we're inside the 503 lockout. no network hit.
  if (Date.now() < _refreshGlobalLockoutUntil) return Promise.resolve(null)
  // Per-ad cooldown. skip if we just tried.
  const last = _refreshLastAttempt.get(ad_id) || 0
  if (last && Date.now() - last < REFRESH_AD_COOLDOWN_MS) {
    return Promise.resolve(null)
  }

  return new Promise<RefreshResult | null>(resolve => {
    const existing = _refreshPending.get(ad_id)
    if (existing) {
      existing.resolvers.push(resolve)
    } else {
      _refreshPending.set(ad_id, { brand, resolvers: [resolve] })
    }
    if (!_refreshFlushTimer) {
      _refreshFlushTimer = setTimeout(_flushRefreshBatch, REFRESH_BATCH_WINDOW_MS)
    }
  })
}

function _useRefreshLockout(): number {
  const [until, setUntil] = useState(_refreshGlobalLockoutUntil)
  useEffect(() => subscribeRefreshLockout(setUntil), [])
  // Re-render when the window expires so the banner can dismiss itself.
  useEffect(() => {
    if (!until || until <= Date.now()) return
    const id = setTimeout(() => setUntil(_refreshGlobalLockoutUntil), until - Date.now() + 100)
    return () => clearTimeout(id)
  }, [until])
  return until
}

function MetaRateLimitInlineBanner() {
  const until = _useRefreshLockout()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!until || until <= Date.now()) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [until])
  if (!until || until <= now) return null
  const mins = Math.max(1, Math.round((until - now) / 60_000))
  return (
    <div className="glass rounded-lg px-3 py-2 text-[11px] text-amber-700 bg-amber-50/80 flex items-center gap-2">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
      <span>
        Meta rate-limited. retrying in ~{mins} min. Thumbnails may stay blank until the window clears.
      </span>
    </div>
  )
}

export function AdAnalysisView({ brand, start, end, compareStart, compareEnd, snapshot }: Props) {
  // Frozen-snapshot mode: every network fetch in this component is gated on
  // this flag so the standalone report HTML runs offline. When true, the
  // dataset comes from `snapshot` at mount and never changes.
  const reportMode = !!snapshot
  const [chartMode, setChartMode] = useState<ChartMode>(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem(LS_VIEW) : null
    return (saved as ChartMode) || 'cards'
  })
  // AI Search toggle. when on, the body swaps for the AtriaExploreView
  // and the rest of the toolbar/filters hides. We persist the choice so
  // a user who lives in explore mode doesn't have to re-toggle on every
  // session, but we never default to it (the page's primary job is still
  // local Meta creative analysis).
  const [atriaMode, setAtriaMode] = useState<boolean>(() => {
    if (typeof window === 'undefined' || reportMode) return false
    return localStorage.getItem('atelier.ads.atriaMode') === '1'
  })
  useEffect(() => {
    if (typeof window === 'undefined' || reportMode) return
    localStorage.setItem('atelier.ads.atriaMode', atriaMode ? '1' : '0')
  }, [atriaMode, reportMode])
  const [ads, setAds] = useState<AdCreative[]>([])
  const [namingConv, setNamingConv] = useState<NamingConvention | null>(null)
  // Breakdown dropdown. mirrors the dashboard's "breakdown" pill so the
  // user can split each ad's metrics by age/gender/platform/etc. Options
  // come from /api/status; the selection is passed through to the
  // creatives endpoint via a query param.
  const [breakdown, setBreakdown] = useState<string>('none')
  const [breakdownOptions, setBreakdownOptions] = useState<{ key: string; label: string }[]>([])
  const [breakdownOpen, setBreakdownOpen] = useState(false)
  const breakdownRef = useRef<HTMLDivElement>(null)
  // Accumulator for horizontal-scroll zoom (MX Master / trackpad). Wheel
  // events fire many small deltaX values; we step zoom once the magnitude
  // crosses ZOOM_HSCROLL_STEP. Reset between gestures.
  const hScrollAccum = useRef(0)
  // Wrapper around the card grid. html-to-image snapshots whatever is
  // currently rendered at native CSS size when the user picks "PNG".
  const cardGridRef = useRef<HTMLDivElement | null>(null)
  const [loading, setLoading] = useState(false)
  // True when rendering from the SWR cache while a background fetch is in
  // flight. Distinct from `loading` so the UI can keep showing real cards
  // and just ghost a small refresh dot in the header.
  const [refreshing, setRefreshing] = useState(false)
  // Progress state for the force-refresh-thumbnails button (null = idle).
  const [thumbRefreshProgress, setThumbRefreshProgress] =
    useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Guards against a stale network response winning over a newer request
  // (e.g. user flips brand while the previous fetch is still resolving).
  const latestRequestRef = useRef(0)
  // Set to true once /api/ads/dashboard has already populated statuses /
  // analyses. downstream useEffect fetchers see the flag and skip their
  // redundant /statuses-for-ads and /analysis-bulk round trips. Cleared
  // on brand/date change in the reset-on-deps effect below.
  const statusesPrimedRef = useRef(false)
  const analysisPrimedRef = useRef(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Sort state is hydrated from localStorage so the user's preference
  // survives reload, defaulting to spend desc. Shared across all 4 views.
  const [sort, setSort] = useState<string>(() => {
    if (typeof window === 'undefined') return 'spend'
    try {
      const raw = localStorage.getItem(LS_SORT)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed.field === 'string') return parsed.field
      }
    } catch {}
    return 'spend'
  })
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(() => {
    if (typeof window === 'undefined') return 'desc'
    try {
      const raw = localStorage.getItem(LS_SORT)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && (parsed.dir === 'asc' || parsed.dir === 'desc')) return parsed.dir
      }
    } catch {}
    return 'desc'
  })

  // Popover flags for the sort + reports pills.
  const sortPillRef = useRef<HTMLButtonElement>(null)
  const [sortPopoverOpen, setSortPopoverOpen] = useState(false)
  const [sortSearch, setSortSearch] = useState('')

  // Multi-selection for charts
  const [checked, setChecked] = useState<Set<string>>(new Set())

  // Chosen metrics (used for grid table columns + chart axes)
  const [metrics, setMetrics] = useState<string[]>(() => {
    if (typeof window === 'undefined') return DEFAULT_METRICS
    try {
      const saved = localStorage.getItem(LS_METRICS)
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length) return parsed
      }
    } catch {}
    return DEFAULT_METRICS
  })
  const [metricPickerOpen, setMetricPickerOpen] = useState(false)
  const [metricSearch, setMetricSearch] = useState('')
  const metricMenuRef = useRef<HTMLDivElement>(null)

  // Timeseries data. loaded lazily when user switches to Line view
  const [timeseries, setTimeseries] = useState<Record<string, any[]>>({})
  // Prior-period timeseries for compare overlays. Same shape as
  // `timeseries`, dates SHIFTED to align with the current window so
  // recharts can plot them on the same X axis. Empty when no compare
  // window is active.
  const [prevTimeseries, setPrevTimeseries] = useState<Record<string, any[]>>({})
  const [tsLoading, setTsLoading] = useState(false)
  const [tsError, setTsError] = useState<string | null>(null)

  // Cached analysis summaries keyed by ad_id. populated when any analysis
  // column is chosen, when the table is active, or when a dimension filter
  // / group-by targets an analysis field.
  const [analysisByAd, setAnalysisByAd] = useState<Record<string, AdAnalysisSummary>>({})
  // Parallel map holding the FULL analysis dict (FileAnalysis shape) so
  // the detail panel can render without a /analyze round-trip. same
  // entries the dashboard payload already includes under `analyses`.
  const [fullAnalysisByAd, setFullAnalysisByAd] = useState<Record<string, any>>({})

  // Planner statuses keyed by ad_id (for the "Status" dimension filter).
  // Fetched in bulk from /api/planner/statuses-for-ads with 5-min cache.
  const [statusByAd, setStatusByAd] = useState<Record<string, string>>({})

  // Quick keyboard status filter. pressing L on the page filters to
  // ACTIVE ads, P to PAUSED, A to ARCHIVED, Esc clears it. Stored as
  // the Meta `effective_status` value or null when no filter is active.
  // Decoupled from `dimRules` so the user can layer it on top of their
  // other filters and clear it independently.
  const [quickStatus, setQuickStatus] = useState<string | null>(null)

  // Velocity bucket selection. the four scorecards (New Launched /
  // Scaling / Winners / Losers) double as a quick filter. When non-empty
  // the grid + table show only ads in the selected bucket(s). Stored as
  // a Set so multi-select feels natural.
  const [velocityFilter, setVelocityFilter] = useState<Set<VelocityBucketLabel>>(new Set())
  const toggleVelocity = (label: VelocityBucketLabel) => {
    setVelocityFilter(prev => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }
  // Thresholds live here (not just inside VelocityScorecards) so the
  // filter pill + scorecards stay in sync without prop drilling state up.
  const [velocityThresholds, setVelocityThresholds] = useState<VelocityThresholds>(() => loadThresholds(brand || ''))
  useEffect(() => { setVelocityThresholds(loadThresholds(brand || '')) }, [brand])
  const velocitySets = useMemo(
    () => classifyVelocity(ads, velocityThresholds),
    [ads, velocityThresholds],
  )

  // Active board. clicking a board opens a dedicated modal view of
  // its pins rather than silently filtering the current grid (the old
  // behavior surprised people when pins fell outside the date range).
  const [openBoard, setOpenBoard] = useState<{ id: string; name: string } | null>(null)

  // Video durations. bulk-fetched after each ads load. The endpoint
  // tries memory → disk cache → live Meta fetch, capped per call so a
  // 200-video brand doesn't pay all 200 round-trips up front. We loop
  // until either every video has a length or a response brings nothing
  // new (cap reached / Meta rate-limited / all genuinely missing).
  const [videoLengths, setVideoLengths] = useState<Record<string, number>>({})
  useEffect(() => {
    // Build pairs of `video_id:ad_id` so the backend can fall back to
    // the insights `video_play_curve_actions` path when the direct
    // /video/{id} metadata call hits "Application does not have
    // permission" (most ad accounts can't read raw video metadata but
    // can read insights. same data, different scope).
    const pairs: { vid: string; aid: string }[] = []
    const seen = new Set<string>()
    for (const a of ads) {
      if (!a.is_video || !a.video_id || !a.ad_id) continue
      if (seen.has(a.video_id)) continue
      seen.add(a.video_id)
      pairs.push({ vid: a.video_id, aid: a.ad_id })
    }
    if (!pairs.length || !brand) return
    let cancelled = false
    ;(async () => {
      let known = { ...videoLengths }
      for (let iter = 0; iter < 10; iter++) {
        const missing = pairs.filter(p => !(p.vid in known))
        if (!missing.length) return
        const CHUNK = 50  // backend max_fetch defaults to 50
        let gotAny = false
        for (let i = 0; i < missing.length; i += CHUNK) {
          const slice = missing.slice(i, i + CHUNK)
          const pairsParam = slice.map(p => `${p.vid}:${p.aid}`).join(',')
          try {
            const r = await fetch(
              `/api/ads/video-lengths?brand=${encodeURIComponent(brand)}&pairs=${encodeURIComponent(pairsParam)}`,
            )
            if (!r.ok) continue
            const d = await r.json()
            if (cancelled) return
            const got: Record<string, number> = d?.lengths || {}
            const newKeys = Object.keys(got).filter(k => !(k in known))
            if (newKeys.length === 0) continue
            gotAny = true
            known = { ...known, ...got }
            setVideoLengths(prev => ({ ...prev, ...got }))
          } catch {
            // Background enrichment. silently skip on failure.
          }
        }
        if (!gotAny) return
        await new Promise(res => setTimeout(res, 800))
      }
    })()
    return () => { cancelled = true }
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [ads, brand])

  // Motion-style filter rules
  const [dimRules, setDimRules] = useState<DimensionFilter[]>([])
  const [dimJoin, setDimJoin] = useState<JoinMode>('AND')
  const [metricFilters, setMetricFilters] = useState<MetricFilter[]>([])
  const [metricJoin, setMetricJoin] = useState<JoinMode>('AND')

  // Popover anchors + open flags
  const dimPillRef = useRef<HTMLButtonElement>(null)
  const metricPillRef = useRef<HTMLButtonElement>(null)
  const [dimPopoverOpen, setDimPopoverOpen] = useState(false)
  const [metricPopoverOpen, setMetricPopoverOpen] = useState(false)

  // Group-by dimension
  const [groupBy, setGroupBy] = useState<GroupByKey>('none')

  // Card-grid zoom (1..5). Level 3 is the current default size.
  const [gridZoom, setGridZoom] = useState<number>(() => {
    if (typeof window === 'undefined') return 3
    const saved = Number(localStorage.getItem(LS_ZOOM))
    return Number.isFinite(saved) && saved >= 1 && saved <= 5 ? saved : 3
  })

  // Saved Reports state. tracks the currently-loaded report + dirty flag.
  // A report snapshot captures filters / picked metrics / sort / groupBy /
  // view / zoom / compare window / date range. When the user mutates any
  // of those after loading a report, we flip `reportDirty` so the menu
  // surfaces a "Save changes" affordance.
  const [activeReport, setActiveReport] = useState<string | null>(null)
  const [reportDirty, setReportDirty] = useState(false)

  useEffect(() => {
    try { localStorage.setItem(LS_METRICS, JSON.stringify(metrics)) } catch {}
  }, [metrics])

  useEffect(() => {
    try { localStorage.setItem(LS_VIEW, chartMode) } catch {}
  }, [chartMode])

  useEffect(() => {
    try { localStorage.setItem(LS_ZOOM, String(gridZoom)) } catch {}
  }, [gridZoom])

  // Load the brand's naming convention so ad_name parses into custom
  // group-by fields (Persona, Angle, Concept, …). Refetches when brand
  // changes; failures collapse to no convention rather than breaking the
  // tab.
  useEffect(() => {
    if (!brand || reportMode) { setNamingConv(null); return }
    let cancelled = false
    const cached = PROFILE_CACHE.get(brand)
    if (cached && (Date.now() - cached.ts) < PROFILE_TTL_MS) {
      setNamingConv(cached.data?.naming_convention || null)
      return
    }
    fetch(`/api/profile?brand=${encodeURIComponent(brand)}`)
      .then(r => r.json())
      .then((p) => {
        if (cancelled) return
        PROFILE_CACHE.set(brand, { ts: Date.now(), data: p })
        setNamingConv((p && p.naming_convention) || null)
      })
      .catch(() => { if (!cancelled) setNamingConv(null) })
    return () => { cancelled = true }
  }, [brand, reportMode])

  // Load breakdown options (Meta-only) so the dropdown matches the
  // dashboard's. Brand-invariant. cached once per session via a shared
  // module-level promise so concurrent mounts don't fan out duplicate
  // requests.
  useEffect(() => {
    if (reportMode) return
    let cancelled = false
    if (META_BREAKDOWN_OPTIONS) {
      setBreakdownOptions(META_BREAKDOWN_OPTIONS)
      return
    }
    if (!META_BREAKDOWN_LOADING) {
      META_BREAKDOWN_LOADING = fetch('/api/status')
        .then(r => r.json())
        .then(d => {
          const opts = d?.meta_breakdowns || []
          META_BREAKDOWN_OPTIONS = opts
          return opts
        })
        .catch(() => {
          META_BREAKDOWN_LOADING = null  // allow retry on next mount
          return []
        })
    }
    META_BREAKDOWN_LOADING.then(opts => { if (!cancelled) setBreakdownOptions(opts) })
    return () => { cancelled = true }
  }, [reportMode])

  useEffect(() => {
    if (!breakdownOpen) return
    const onClick = (e: MouseEvent) => {
      if (breakdownRef.current && !breakdownRef.current.contains(e.target as Node)) setBreakdownOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [breakdownOpen])

  // Persist sort selection. Shared across all 4 views (cards order, table
  // order, bar x-axis order, line legend order).
  useEffect(() => {
    try { localStorage.setItem(LS_SORT, JSON.stringify({ field: sort, dir: sortDir })) } catch {}
  }, [sort, sortDir])

  // Any state change after a report has been loaded flips the dirty flag
  // so the Reports menu can show "Save changes". We mark it here in a
  // dedicated effect that depends on all the report-captured state slices.
  useEffect(() => {
    if (!activeReport) return
    setReportDirty(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    metrics, chartMode, gridZoom, sort, sortDir,
    dimRules, dimJoin, metricFilters, metricJoin, groupBy,
  ])

  // Snapshot current view into a JSON-safe config object for Save-as.
  const captureReportConfig = (): Record<string, any> => ({
    filters: {
      dimRules,
      dimJoin,
      metricFilters,
      metricJoin,
    },
    pickedMetrics: metrics,
    sort: { field: sort, dir: sortDir },
    groupBy,
    view: chartMode,
    zoom: gridZoom,
    compareStart: compareStart || '',
    compareEnd: compareEnd || '',
    start,
    end,
  })

  // Hydrate every piece of state from a saved report snapshot. Whatever
  // keys are missing in the config just keep their current value.
  const applyReportConfig = (cfg: Record<string, any>) => {
    if (!cfg || typeof cfg !== 'object') return
    try {
      if (cfg.filters && typeof cfg.filters === 'object') {
        if (Array.isArray(cfg.filters.dimRules)) setDimRules(cfg.filters.dimRules)
        if (cfg.filters.dimJoin === 'AND' || cfg.filters.dimJoin === 'OR') setDimJoin(cfg.filters.dimJoin)
        if (Array.isArray(cfg.filters.metricFilters)) setMetricFilters(cfg.filters.metricFilters)
        if (cfg.filters.metricJoin === 'AND' || cfg.filters.metricJoin === 'OR') setMetricJoin(cfg.filters.metricJoin)
      }
      if (Array.isArray(cfg.pickedMetrics)) setMetrics(cfg.pickedMetrics.filter((k: any) => typeof k === 'string'))
      if (cfg.sort && typeof cfg.sort === 'object') {
        if (typeof cfg.sort.field === 'string') setSort(cfg.sort.field)
        if (cfg.sort.dir === 'asc' || cfg.sort.dir === 'desc') setSortDir(cfg.sort.dir)
      }
      if (typeof cfg.groupBy === 'string') setGroupBy(cfg.groupBy as GroupByKey)
      if (cfg.view === 'cards' || cfg.view === 'table' || cfg.view === 'bar' || cfg.view === 'line') {
        setChartMode(cfg.view)
      }
      if (typeof cfg.zoom === 'number' && cfg.zoom >= 1 && cfg.zoom <= 5) setGridZoom(cfg.zoom)
    } catch (e) {
      console.warn('[reports] applyReportConfig failed', e)
    }
  }

  const handleReportLoad = (r: SavedReport) => {
    applyReportConfig(r.config || {})
    setActiveReport(r.name)
    // Reset dirty flag on the next tick (after the state propagates), since
    // applying the config will trigger the dirty-effect above.
    setTimeout(() => setReportDirty(false), 0)
  }
  const handleReportSaved = (r: SavedReport) => {
    setActiveReport(r.name)
    setReportDirty(false)
  }
  const handleReportDeleted = (name: string) => {
    if (activeReport === name) {
      setActiveReport(null)
      setReportDirty(false)
    }
  }
  const handleReportRenamed = (oldName: string, newName: string) => {
    if (activeReport === oldName) setActiveReport(newName)
  }
  // Exit-report: clear the active selection so the pill goes back to a
  // neutral "Reports" state. We deliberately DON'T mutate filters /
  // metric picks / dates here. the user often wants to fork off a
  // saved report's config to make a new variant. If they really want
  // a fresh canvas they can hit "Reset" or reload the page.
  const handleReportClear = () => {
    setActiveReport(null)
    setReportDirty(false)
  }

  // Keyboard shortcuts for quick status filter:
  //   L → live (ACTIVE), P → paused, A → archived, Esc → clear
  // Ignored when the user is typing in an input/textarea so we don't
  // hijack search boxes. Easy to extend later (D for disapproved, etc.).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 'l') { setQuickStatus(p => p === 'ACTIVE' ? null : 'ACTIVE'); e.preventDefault() }
      else if (k === 'p') { setQuickStatus(p => p === 'PAUSED' ? null : 'PAUSED'); e.preventDefault() }
      else if (k === 'a' && !e.shiftKey) { setQuickStatus(p => p === 'ARCHIVED' ? null : 'ARCHIVED'); e.preventDefault() }
      else if (e.key === 'Escape') { setQuickStatus(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Close metric picker on outside click
  useEffect(() => {
    if (!metricPickerOpen) return
    const onClick = (e: MouseEvent) => {
      if (metricMenuRef.current && !metricMenuRef.current.contains(e.target as Node)) {
        setMetricPickerOpen(false)
      }
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [metricPickerOpen])

  // Hydrate the analysis + status maps from a /dashboard payload. Shared
  // between the normal load path and the preload-cache fast path so both
  // produce identical state shapes. downstream effects that re-derive
  // these can short-circuit (see `statusesPrimedRef` / `analysisPrimedRef`).
  const hydrateAuxiliary = (
    ads: AdCreative[],
    rawAnalyses: Record<string, any>,
    rawStatuses: Record<string, any>,
    rawAdToHash: Record<string, string>,
  ) => {
    const analysisMap: Record<string, AdAnalysisSummary> = {}
    const fullMap: Record<string, any> = {}
    for (const key of Object.keys(rawAnalyses || {})) {
      const entry = rawAnalyses[key] || {}
      const a = entry.analysis || {}
      const summary: AdAnalysisSummary = {
        template: a.template,
        funnelPosition: a.funnelPosition,
        persona: a.persona,
        sentiment: a.sentiment,
        creativeClarityScore: typeof a.creativeClarityScore === 'number' ? a.creativeClarityScore : undefined,
        creativeClarityFeedback: a.creativeClarityFeedback,
        visualDifferentiationScore: typeof a.visualDifferentiationScore === 'number' ? a.visualDifferentiationScore : undefined,
        visualDifferentiationSummary: a.visualDifferentiationSummary,
        messagingDifferentiationScore: typeof a.messagingDifferentiationScore === 'number' ? a.messagingDifferentiationScore : undefined,
        messagingDifferentiationSummary: a.messagingDifferentiationSummary,
        angle: a.angle,
        marketAwareness: a.marketAwareness,
        category: a.category,
        collection: a.collection,
        offer: a.offer,
        marketingMoment: a.marketingMoment,
        emotion: a.emotion,
      }
      analysisMap[key] = summary
      fullMap[key] = a
      const aid = entry.ad_id
      if (aid && aid !== key) {
        analysisMap[aid] = summary
        fullMap[aid] = a
      }
    }
    for (const aid of Object.keys(rawAdToHash || {})) {
      const h = rawAdToHash[aid]
      if (h && analysisMap[h] && !analysisMap[aid]) analysisMap[aid] = analysisMap[h]
      if (h && fullMap[h] && !fullMap[aid]) fullMap[aid] = fullMap[h]
    }
    if (Object.keys(analysisMap).length) setAnalysisByAd(analysisMap)
    if (Object.keys(fullMap).length) setFullAnalysisByAd(fullMap)

    const statusMap: Record<string, string> = {}
    for (const k of Object.keys(rawStatuses || {})) {
      const s = rawStatuses[k]?.status
      if (s) statusMap[k] = String(s)
    }
    // Sidecar cache key mirrors the status effect's own cache layout so
    // a later mount doesn't re-fire the status call.
    if (ads.length) {
      const ids = ads.map(a => a.ad_id).sort().join(',')
      STATUS_CACHE[`${brand}::${ids}`] = { ts: Date.now(), data: statusMap }
    }
    setStatusByAd(statusMap)
    // Flip primed flags so the standalone effects below skip their
    // redundant /analysis-bulk and /statuses-for-ads hits.
    statusesPrimedRef.current = true
    analysisPrimedRef.current = true
  }

  // Core loader. `force` = true bypasses the SWR cache (used by the Refresh
  // pill). When `false`, cached rows render immediately and we kick a
  // background fetch to update them in place. this is the "feels instant"
  // path for repeat visits / tab switches.
  //
  // Uses the aggregated /api/ads/dashboard endpoint. one round trip
  // returns creatives, cached analyses, and planner statuses so the tab
  // doesn't fire three sequential fetches on mount.
  const load = async (opts?: { force?: boolean }) => {
    if (!brand || !start || !end) return
    const force = !!opts?.force
    setError(null)

    // Stamp this request so a slower response from a prior brand/date can't
    // clobber a fresher one.
    const requestId = ++latestRequestRef.current

    let servedFromCache = false
    if (!force) {
      // Preload cache (populated by sidebar click) wins over SWR.
      const preloaded = readPreloadCache(brand, start, end)
      if (preloaded) {
        setAds(preloaded.ads)
        hydrateAuxiliary(preloaded.ads, preloaded.analyses, preloaded.statuses, preloaded.adIdToHash)
        setLoading(false)
        setRefreshing(true)
        servedFromCache = true
      } else {
        const cached = readCreativesCache(brand, start, end)
        if (cached && cached.length) {
          setAds(cached)
          setLoading(false)
          setRefreshing(true)
          servedFromCache = true
        }
      }
    }
    if (!servedFromCache) {
      // On force-refresh we keep the existing cards on screen (ads state
      // is untouched) but flip the refreshing dot on; the big skeleton is
      // only used when we genuinely have nothing to show yet.
      if (force && ads.length) {
        setLoading(false)
        setRefreshing(true)
      } else {
        setLoading(true)
        setRefreshing(false)
      }
    }

    try {
      const cmp = (compareStart && compareEnd)
        ? `&compare_start=${compareStart}&compare_end=${compareEnd}`
        : ''
      const bd = breakdown && breakdown !== 'none' ? `&breakdown=${encodeURIComponent(breakdown)}` : ''
      const r = await fetch(`/api/ads/dashboard?brand=${encodeURIComponent(brand)}&start=${start}&end=${end}${cmp}${bd}&limit=120`)
      // Defensive parse. when the server returns an empty body or HTML
      // error page (proxy hiccup / cancelled mid-stream / 502 from
      // upstream), `r.json()` raises a confusing SyntaxError that bubbles
      // up as the page-level error banner. Read once as text, sniff for
      // JSON before parsing.
      const raw = await r.text()
      if (requestId !== latestRequestRef.current) return  // stale. drop
      if (!r.ok) {
        setError(`Backend ${r.status}${raw ? `: ${raw.slice(0, 120)}` : ''}`)
        if (!servedFromCache) setAds([])
        if (requestId === latestRequestRef.current) {
          setLoading(false)
          setRefreshing(false)
        }
        return
      }
      let d: any = {}
      if (raw && raw.trim()) {
        try { d = JSON.parse(raw) } catch {
          // Non-JSON 200. keep cached ads, surface a soft warning.
          setError('Server returned a non-JSON response. Try refreshing.')
          if (requestId === latestRequestRef.current) {
            setLoading(false)
            setRefreshing(false)
          }
          return
        }
      }
      if (d.detail) {
        setError(String(d.detail))
        if (!servedFromCache) setAds([])
      } else {
        const next: AdCreative[] = d.ads || []
        setAds(next)
        writeCreativesCache(brand, start, end, next)
        hydrateAuxiliary(next, d.analyses || {}, d.statuses || {}, d.ad_id_to_hash || {})
        PRELOAD_CACHE.set(preloadKey(brand, start, end), {
          ts: Date.now(),
          payload: {
            ads: next,
            analyses: d.analyses || {},
            statuses: d.statuses || {},
            adIdToHash: d.ad_id_to_hash || {},
          },
        })
      }
    } catch (e: any) {
      if (requestId === latestRequestRef.current) setError(String(e))
    }
    if (requestId === latestRequestRef.current) {
      setLoading(false)
      setRefreshing(false)
    }
  }

  // Mount + brand/date change: paint from cache instantly (if any) and
  // revalidate in the background. On first visit we fall through to a
  // normal loading state and render the skeleton grid below.
  //
  // In report mode we skip the fetch entirely and hydrate once from the
  // frozen snapshot payload. the file is meant to work offline.
  useEffect(() => {
    if (reportMode && snapshot) {
      setAds(snapshot.ads || [])
      hydrateAuxiliary(
        snapshot.ads || [],
        snapshot.analyses || {},
        snapshot.statuses as any || {},
        snapshot.adIdToHash || {},
      )
      if (snapshot.timeseries) setTimeseries(snapshot.timeseries)
      statusesPrimedRef.current = true
      analysisPrimedRef.current = true
      setLoading(false)
      setRefreshing(false)
      return
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand, start, end, breakdown])

  // Reset selection when brand or date range changes. ad_ids from a prior
  // brand are meaningless against the new Meta account. Also drop the
  // primed flags so the aux fetchers re-fire for the new dataset.
  useEffect(() => {
    setChecked(new Set())
    setTimeseries({})
    statusesPrimedRef.current = false
    analysisPrimedRef.current = false
  }, [brand, start, end])

  // Enrich every ad with derived fields (asset_type, planner_status, name
  // convention tokens flattened as `nc_*` for group-by / dim-filter use)
  // and the pre-computed custom metrics. Runs whenever the dataset or
  // status map changes. cheap, one pass per ad.
  const enrichedAds = useMemo(() => {
    // Drop catalog / DPA ads outright. They render as dynamic product
    // carousels with `{{product.*}}` template tokens. no static
    // creative, no per-ad-level performance we can meaningfully chart,
    // and the placeholder previews were causing more noise than value.
    // User asked for them gone from Analytics entirely on 2026-05-15.
    const isCatalog = (a: AdCreative) => {
      const tokenish = (v?: string | null) =>
        typeof v === 'string' && /\{\{\s*product\./i.test(v)
      return tokenish(a.title) || tokenish(a.body) || tokenish(a.image_url) || tokenish(a.thumbnail_url)
    }
    return ads.filter(a => !isCatalog(a)).map(a => {
      const adNc = a.name_convention?.ad || {}
      const setNc = a.name_convention?.adset || {}
      const withDerived: any = {
        ...a,
        asset_type: deriveAssetType(a as any),
        planner_status: statusByAd[a.ad_id] || 'Unlinked',
        // Flattened naming-convention tokens. prefer adset for funnel/owner,
        // prefer ad-level for objective/format/type/persona_hint/concept.
        nc_objective: adNc.objective || '',
        nc_format: adNc.format || '',
        nc_type: adNc.type || '',
        nc_funnel: setNc.funnel || adNc.funnel || '',
        nc_persona_hint: adNc.persona_hint || '',
        nc_concept: adNc.concept || '',
        nc_owner: setNc.owner || '',
        nc_bidding: setNc.bidding || adNc.bidding || '',
        nc_audience: setNc.audience || adNc.audience || '',
      }
      return withCustomMetrics(withDerived) as AdCreative
    })
  }, [ads, statusByAd])

  // Merge analysis fields onto each row as `analysis_*` keys BEFORE
  // filtering so dimension filters / group-by see them.
  // Lookup is hash-primary with ad_id fallback. two ads sharing one
  // creative both light up with a single analyze call.
  const adsWithAnalysis = useMemo(() => {
    const hasAnalysis = Object.keys(analysisByAd).length > 0
    const hasNaming = !!(namingConv?.positions?.length)
    if (!hasAnalysis && !hasNaming) return enrichedAds
    return enrichedAds.map(a => {
      const key = a.creative_hash || a.ad_id
      const aa = hasAnalysis ? (analysisByAd[key] || analysisByAd[a.ad_id]) : null
      let next: any = a
      if (aa) {
        next = {
          ...next,
          analysis_template: aa.template,
          analysis_funnelPosition: aa.funnelPosition,
          analysis_persona: aa.persona,
          analysis_sentiment: aa.sentiment,
          analysis_creativeClarityScore: aa.creativeClarityScore,
          analysis_visualDiffScore: aa.visualDifferentiationScore,
          analysis_messagingDiffScore: aa.messagingDifferentiationScore,
          analysis_angle: aa.angle,
          analysis_marketAwareness: aa.marketAwareness,
          analysis_category: aa.category,
          analysis_collection: aa.collection,
          analysis_offer: aa.offer,
          analysis_marketingMoment: aa.marketingMoment,
          analysis_emotion: aa.emotion,
        }
      }
      if (hasNaming) {
        const parsed = parseAdName((next.ad_name as string) || '', namingConv!)
        next = { ...next }
        for (const pos of namingConv!.positions) {
          if (!pos.label) continue
          next[ncFieldKey(pos.label)] = parsed[pos.label] ?? ''
        }
      }
      return next as AdCreative
    })
  }, [enrichedAds, analysisByAd, namingConv])

  // Extra group-by entries derived from the brand naming convention.
  // Each defined position becomes a dropdown option keyed by its slug.
  const namingExtraGroupBy = useMemo(() => {
    if (!namingConv?.positions?.length) return []
    return namingConv.positions
      .filter(p => p.label && p.label.trim())
      .map(p => ({ key: ncFieldKey(p.label), label: p.label }))
  }, [namingConv])

  // Same set of naming-convention slots surfaced into the Dimension
  // Filter dropdown. Without this, users can group by their custom
  // positions but can't filter by them. which is what was happening
  // before this was added (DIMENSION_FIELDS is a static const).
  const namingExtraDimensions = useMemo((): DimensionFieldDef[] => {
    if (!namingConv?.positions?.length) return []
    return namingConv.positions
      .filter(p => p.label && p.label.trim())
      .map(p => ({ key: ncFieldKey(p.label), label: p.label }))
  }, [namingConv])

  // Unique values per dimension, pulled from the current dataset. Cheap:
  // datasets cap at ~120 ads.
  const uniqueDimensionValues = useMemo(() => {
    const baseKeys = [
      'campaign_name', 'adset_name', 'ad_name',
      // Legacy backend-parsed name fields (kept for back-compat with old datasets)
      'nc_objective', 'nc_format', 'nc_type', 'nc_funnel',
      'nc_persona_hint', 'nc_owner', 'nc_bidding', 'nc_audience', 'nc_concept',
      // AI analysis
      'analysis_angle', 'analysis_persona', 'analysis_template',
      'analysis_funnelPosition', 'analysis_marketAwareness',
      'analysis_sentiment', 'analysis_category', 'analysis_collection',
      'analysis_offer', 'analysis_marketingMoment', 'analysis_emotion',
    ]
    // Also include the dynamic nc_custom_* slugs from the brand's naming
    // convention, so the "is one of" value picker populates.
    const dynamicKeys = namingExtraDimensions.map(d => d.key)
    const keys = [...baseKeys, ...dynamicKeys]
    const out: Record<string, string[]> = {}
    for (const k of keys) {
      const set = new Set<string>()
      for (const a of adsWithAnalysis) {
        const v = (a as any)[k]
        if (v === undefined || v === null || v === '') continue
        set.add(String(v))
      }
      out[k] = Array.from(set).sort()
    }
    return out
  }, [adsWithAnalysis, namingExtraDimensions])

  const getDimensionOptions = (field: string): string[] => uniqueDimensionValues[field] || []

  // Numeric metrics available to the metric filter popover. analysis text
  // columns are excluded (those filter via dimensions instead). Dedup by
  // key since some metrics (revenue) appear in multiple picker groups.
  const METRIC_OPTIONS: MetricOption[] = useMemo(() => {
    const seen = new Set<string>()
    const out: MetricOption[] = []
    for (const m of ALL_METRICS) {
      const k = String(m.key)
      if (seen.has(k)) continue
      if (m.format === 'text') continue
      seen.add(k)
      out.push({ key: k, label: m.label, unit: metricUnit(m) })
    }
    return out
  }, [])

  const filteredAds = useMemo(() => {
    // Atria-style solo view: when an ad is open in the detail panel, the
    // underlying grid filters to just that ad. Closing the panel restores
    // the full list (selectedId → null clears the filter).
    if (selectedId) {
      const only = adsWithAnalysis.filter(a => a.ad_id === selectedId)
      if (only.length) return only
    }

    let list = [...adsWithAnalysis]

    // Quick status filter (L/P/A keys). Layers on top of everything else.
    if (quickStatus) {
      list = list.filter(a => (a.effective_status || '').toUpperCase() === quickStatus)
    }

    // Velocity bucket filter. ad must be in at least one selected
    // bucket (OR across buckets, since an ad can be both Winner and
    // Scaling and the user clicking both probably means "either").
    if (velocityFilter.size > 0) {
      const union = new Set<string>()
      for (const label of velocityFilter) {
        for (const id of velocitySets[label]) union.add(id)
      }
      list = list.filter(a => union.has(a.ad_id))
    }


    // Dimension filters. Special-case `ad_name` + `contains`. widens into a
    // global cross-field search (preserves prior behavior so typing "video"
    // surfaces every video ad, not just ones whose ad_name contains "video").
    if (dimRules.length) {
      const nameContainsRule = dimRules.find(r =>
        r.field === 'ad_name' && r.op === 'contains' && r.text.trim()
      )
      if (nameContainsRule) {
        const otherRules = dimRules.filter(r => r.id !== nameContainsRule.id)
        const q = nameContainsRule.text.trim()
        list = list.filter(a => matchesGlobalSearch(a as unknown as Record<string, any>, q))
        if (otherRules.length) {
          list = list.filter(a => matchesDimensionFilters(a as any, otherRules, dimJoin))
        }
      } else {
        list = list.filter(a => matchesDimensionFilters(a as any, dimRules, dimJoin))
      }
    }

    if (metricFilters.length) {
      list = list.filter(a => matchesFilters(a as any, metricFilters, metricJoin))
    }

    // String sorts for ad_name / created_time, numeric for everything else.
    const stringSortKeys = new Set(['ad_name', 'created_time', 'campaign_name', 'adset_name'])
    list.sort((a, b) => {
      if (stringSortKeys.has(sort)) {
        const av = String((a as any)[sort] ?? '')
        const bv = String((b as any)[sort] ?? '')
        const cmp = av.localeCompare(bv)
        return sortDir === 'desc' ? -cmp : cmp
      }
      const av = Number((a as any)[sort] ?? 0)
      const bv = Number((b as any)[sort] ?? 0)
      return sortDir === 'desc' ? bv - av : av - bv
    })
    return list
  }, [adsWithAnalysis, sort, sortDir, dimRules, dimJoin, metricFilters, metricJoin, selectedId, quickStatus, velocityFilter, velocitySets])

  // IMPORTANT: read from `adsWithAnalysis`, NOT raw `ads`.
  // adsWithAnalysis runs through withCustomMetrics + analysis-field merge
  // so the detail panel sees cost_per_1k_ac_reached, hook_rate, hold_rate,
  // CPA, click_to_purchase, click_to_atc, etc. Reading from raw `ads`
  // means none of the derived/custom metrics reach the metric tiles -
  // which is what caused "missing CPA / hook rate / click-to-purchase"
  // even though they were defined in DETAIL_GROUPS + CUSTOM_METRICS.
  const selectedAd = useMemo(
    () => adsWithAnalysis.find(a => a.ad_id === selectedId) || null,
    [adsWithAnalysis, selectedId]
  )

  const checkedAds = useMemo(
    () => filteredAds.filter(a => checked.has(a.ad_id)),
    [filteredAds, checked]
  )

  const metricDefs = useMemo(() => {
    return metrics.map(k => METRICS_BY_KEY[k]).filter(Boolean) as MetricDef[]
  }, [metrics])

  // Grouped rows when Group-by is active.
  const groupedRows = useMemo<GroupedRow[]>(() => {
    if (groupBy === 'none') return []
    return groupAds(filteredAds, groupBy)
  }, [filteredAds, groupBy])

  const isGrouped = groupBy !== 'none'

  // Chart source: grouped mode uses group rows (not individual ads). In
  // ungrouped mode, use the user's selection if any, else the top-N visible.
  const chartAds = useMemo(() => {
    if (isGrouped) return [] as AdCreative[]
    if (checkedAds.length) return checkedAds
    return filteredAds.slice(0, 8)
  }, [checkedAds, filteredAds, isGrouped])

  const toggleAd = (id: string) => {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const selectAllVisible = () => {
    setChecked(new Set(filteredAds.map(a => a.ad_id)))
  }
  const clearSelection = () => setChecked(new Set())

  // Lazy-load timeseries when user enters Line view with selected ads.
  // When compareStart/compareEnd are set, ALSO fetch the prior-window
  // timeseries in parallel and shift each date forward by the window
  // gap so prior + current align on the same recharts X axis.
  useEffect(() => {
    if (reportMode) return  // timeseries is baked into the snapshot
    if (chartMode !== 'line') return
    if (isGrouped) return
    if (!brand || !start || !end) return
    if (!chartAds.length) return
    const ids = chartAds.slice(0, MAX_CHART_LINES).map(a => a.ad_id).sort().join(',')
    const have = Object.keys(timeseries).sort().join(',')
    if (have === ids) return

    let cancelled = false
    setTsLoading(true)
    setTsError(null)
    ;(async () => {
      try {
        // Current-window fetch
        const currentP = fetch(
          `/api/ads/creative-timeseries?brand=${encodeURIComponent(brand)}&ad_ids=${encodeURIComponent(ids)}&start=${start}&end=${end}`,
        ).then(r => r.json())
        // Prior-window fetch in parallel when a compare range is set.
        const wantCompare = !!(compareStart && compareEnd)
        const priorP = wantCompare
          ? fetch(
              `/api/ads/creative-timeseries?brand=${encodeURIComponent(brand)}&ad_ids=${encodeURIComponent(ids)}&start=${compareStart}&end=${compareEnd}`,
            ).then(r => r.json())
          : Promise.resolve(null)
        const [cur, prev] = await Promise.all([currentP, priorP])
        if (cancelled) return
        if (cur.detail) { setTsError(String(cur.detail)); setTimeseries({}) }
        else setTimeseries(cur.series || {})

        // Shift prior dates forward by the gap between current `start`
        // and compareStart so the dashed overlay aligns visually.
        if (wantCompare && prev && !prev.detail) {
          const shiftDays = Math.round(
            (new Date(`${start}T00:00:00`).getTime() - new Date(`${compareStart}T00:00:00`).getTime()) /
              86400000,
          )
          const shifted: Record<string, any[]> = {}
          for (const [adId, rows] of Object.entries(prev.series || {})) {
            shifted[adId] = (rows as any[]).map(r => {
              const d = new Date(`${r.date}T00:00:00`)
              d.setDate(d.getDate() + shiftDays)
              const yyyy = d.getFullYear()
              const mm = String(d.getMonth() + 1).padStart(2, '0')
              const dd = String(d.getDate()).padStart(2, '0')
              return { ...r, date: `${yyyy}-${mm}-${dd}` }
            })
          }
          setPrevTimeseries(shifted)
        } else {
          setPrevTimeseries({})
        }
      } catch (e: any) {
        if (!cancelled) setTsError(String(e))
      } finally {
        if (!cancelled) setTsLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [chartMode, brand, start, end, chartAds, isGrouped, compareStart, compareEnd])

  const addMetric = (k: string) => {
    setMetrics(prev => prev.includes(k) ? prev.filter(m => m !== k) : [...prev, k])
  }

  // Fetch cached analyses when needed: table view, any analysis column, a
  // group-by targeting an analysis field, or a dimension filter that does.
  const needAnalyses = useMemo(() => {
    if (chartMode === 'table') return true
    if (metrics.some(k => String(k).startsWith('analysis_'))) return true
    if (String(groupBy).startsWith('analysis_')) return true
    if (dimRules.some(r => r.field.startsWith('analysis_'))) return true
    return false
  }, [chartMode, metrics, groupBy, dimRules])

  useEffect(() => {
    if (reportMode) return  // analyses are baked into the snapshot
    if (!needAnalyses) return
    if (!ads.length) return
    // The aggregated /dashboard endpoint already returned analyses for
    // this dataset. skip the redundant /analysis-bulk call.
    if (analysisPrimedRef.current) return
    // Prefer hash-keyed lookup (server-side cache is hash-primary now);
    // fall back to ad_ids for ads missing a hash for any reason.
    const hashes = ads.map(a => a.creative_hash).filter(Boolean).join(',')
    const ids = ads.map(a => a.ad_id).join(',')
    if (!hashes && !ids) return
    let cancelled = false
    // Small grace window. when ads paint from SWR cache the dashboard
    // refetch is usually in flight. Wait briefly so its hydrate primes
    // the ref instead of us also firing /analysis-bulk.
    const t = window.setTimeout(() => {
      if (cancelled || analysisPrimedRef.current) return
      runFetch()
    }, 400)
    const runFetch = async () => {
      try {
        const qs = new URLSearchParams()
        if (hashes) qs.set('creative_hashes', hashes)
        if (ids) qs.set('ad_ids', ids)
        const r = await fetch(`/api/ads/analysis-bulk?${qs.toString()}`)
        const d = await r.json()
        if (cancelled) return
        const map: Record<string, AdAnalysisSummary> = {}
        const fullMap: Record<string, any> = {}
        const by = d.analyses || {}
        // Server now keys by creative_hash. Populate under BOTH the
        // hash and (when present) the ad_id so downstream lookups that
        // only know one of the two still hit.
        for (const key of Object.keys(by)) {
          const entry = by[key] || {}
          const a = entry.analysis || {}
          const summary: AdAnalysisSummary = {
            template: a.template,
            funnelPosition: a.funnelPosition,
            persona: a.persona,
            sentiment: a.sentiment,
            creativeClarityScore: typeof a.creativeClarityScore === 'number' ? a.creativeClarityScore : undefined,
            creativeClarityFeedback: a.creativeClarityFeedback,
            visualDifferentiationScore: typeof a.visualDifferentiationScore === 'number' ? a.visualDifferentiationScore : undefined,
            visualDifferentiationSummary: a.visualDifferentiationSummary,
            messagingDifferentiationScore: typeof a.messagingDifferentiationScore === 'number' ? a.messagingDifferentiationScore : undefined,
            messagingDifferentiationSummary: a.messagingDifferentiationSummary,
            angle: a.angle,
            marketAwareness: a.marketAwareness,
            category: a.category,
            collection: a.collection,
            offer: a.offer,
            marketingMoment: a.marketingMoment,
            emotion: a.emotion,
          }
          map[key] = summary
          fullMap[key] = a
          const aid = entry.ad_id
          if (aid && aid !== key) {
            map[aid] = summary
            fullMap[aid] = a
          }
        }
        // Also fan out using the server's ad_id_to_hash reverse map so
        // every ad sharing a hash lights up from a single entry.
        const adToHash: Record<string, string> = d.ad_id_to_hash || {}
        for (const aid of Object.keys(adToHash)) {
          const h = adToHash[aid]
          if (h && map[h] && !map[aid]) map[aid] = map[h]
          if (h && fullMap[h] && !fullMap[aid]) fullMap[aid] = fullMap[h]
        }
        setAnalysisByAd(map)
        setFullAnalysisByAd(prev => ({ ...prev, ...fullMap }))
      } catch {
        // Non-fatal. analysis columns / dims just show nothing
      }
    }
    return () => { cancelled = true; window.clearTimeout(t) }
  }, [needAnalyses, ads])

  // Bulk-fetch planner statuses for the visible ads. Cached for 5 min by
  // (brand, sorted ad_ids). keeps the dimension filter chip snappy.
  useEffect(() => {
    if (reportMode) return  // statuses are baked into the snapshot
    if (!ads.length) return
    // Dashboard endpoint already hydrated statuses for this load.
    if (statusesPrimedRef.current) return
    const ids = ads.map(a => a.ad_id).sort().join(',')
    if (!ids) return
    const cacheKey = `${brand}::${ids}`
    const entry = STATUS_CACHE[cacheKey]
    if (entry && (Date.now() - entry.ts) < STATUS_TTL_MS) {
      setStatusByAd(entry.data)
      return
    }
    let cancelled = false
    // Grace window. let the dashboard hydrate prime statuses first.
    const t = window.setTimeout(async () => {
      if (cancelled || statusesPrimedRef.current) return
      try {
        const r = await fetch(`/api/planner/statuses-for-ads?ad_ids=${encodeURIComponent(ids)}`)
        const d = await r.json()
        if (cancelled) return
        const out: Record<string, string> = {}
        const by = d.statuses || {}
        for (const k of Object.keys(by)) {
          if (by[k]?.status) out[k] = String(by[k].status)
        }
        STATUS_CACHE[cacheKey] = { ts: Date.now(), data: out }
        setStatusByAd(out)
      } catch {
        // Non-fatal. status dim filter will show everything as Unlinked.
      }
    }, 400)
    return () => { cancelled = true; window.clearTimeout(t) }
  }, [ads, brand])

  const resetAllFilters = () => {
    setDimRules([])
    setMetricFilters([])
  }
  const hasAnyFilter = dimRules.length > 0 || metricFilters.length > 0

  return (
    <VideoLengthContext.Provider value={videoLengths}>
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Dynamic title. flips between the analytics view of your own
            ads and the search view across Atria's library. Fixed width
            so the segmented control next to it doesn't slide when the
            title text changes length. */}
        <h2 className="font-display text-base font-medium w-[160px] shrink-0">
          {atriaMode ? 'Creative Search' : 'Creative Analysis'}
        </h2>

        {/* Apple-style segmented control. two icon-only states. The
            inactive side is dim, the active side gets the white "lifted"
            tile with a soft shadow (iOS segmented control idiom). No
            words: the icons (chart + magnifier) carry the meaning and
            the title above tells you which mode you're in. Hidden in
            report mode so static report HTMLs don't try to flip into
            the live Atria explorer. */}
        {!reportMode && (
          <div
            role="tablist"
            aria-label="View mode"
            className="inline-flex items-center p-0.5 rounded-full bg-black/[0.06]"
          >
            <button
              role="tab"
              aria-selected={!atriaMode}
              onClick={() => setAtriaMode(false)}
              title="Your ads · performance analytics"
              className={`p-1.5 rounded-full transition-colors ${
                !atriaMode
                  ? 'bg-white text-text-primary shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              <BarChart3 size={12} />
            </button>
            <button
              role="tab"
              aria-selected={atriaMode}
              onClick={() => setAtriaMode(true)}
              title="Search ~25M ads across Meta + TikTok"
              className={`p-1.5 rounded-full transition-colors ${
                atriaMode
                  ? 'bg-white text-text-primary shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              <Search size={12} />
            </button>
          </div>
        )}

        <div className="ml-auto flex items-center gap-1">
          {refreshing && !loading && (
            <span
              className="w-1.5 h-1.5 rounded-full bg-[#B7410E] animate-pulse"
              title="Refreshing from Meta…"
              aria-label="Refreshing"
            />
          )}
          {!atriaMode && (
            // DownloadMenu visible in report mode too. that's where the
            // user expects CSV / PDF export of the saved report (it sits
            // right next to the Refresh button now).
            <DownloadMenu
              gridRef={cardGridRef}
              ads={filteredAds}
              selectedAds={checkedAds}
              metricDefs={metricDefs}
              brand={brand}
              chartMode={chartMode}
            />
          )}
          {!reportMode && (
            // Single Refresh button. re-fetches ads from Meta AND re-signs
            // every CDN URL (the old "Refresh thumbs" was a niche subset
            // that just confused operators alongside the main button).
            <button
              onClick={async () => {
                load({ force: true })
                if (ads.length && brand) {
                  setThumbRefreshProgress({ done: 0, total: ads.length })
                  const ids = ads.map(a => a.ad_id).filter(Boolean) as string[]
                  const results = await forceRefreshUrls(brand, ids, (done, total) => {
                    setThumbRefreshProgress({ done, total })
                  })
                  const byId = new Map<string, RefreshResult>()
                  for (const r of results) if (r?.ad_id) byId.set(r.ad_id, r)
                  setAds(prev => prev.map(a => {
                    const r = byId.get(a.ad_id)
                    if (!r) return a
                    return {
                      ...a,
                      image_url: r.image_url ?? a.image_url,
                      image_url_hd: r.image_url_hd ?? a.image_url_hd,
                      thumbnail_url: r.thumbnail_url ?? a.thumbnail_url,
                      video_source_url: r.video_source_url ?? a.video_source_url,
                      video_permalink: r.video_permalink ?? a.video_permalink,
                    }
                  }))
                  setTimeout(() => setThumbRefreshProgress(null), 1200)
                }
              }}
              disabled={loading || refreshing || !!thumbRefreshProgress}
              className="glass glass-hover px-2 py-1 rounded-full text-[11px] flex items-center gap-1 whitespace-nowrap"
              title="Re-fetch ads from Meta + re-sign every thumbnail / video URL"
            >
              {(loading || refreshing || thumbRefreshProgress)
                ? <Loader2 size={11} className="animate-spin" />
                : <RefreshCw size={11} />}
              {thumbRefreshProgress
                ? `Refreshing ${thumbRefreshProgress.done}/${thumbRefreshProgress.total}`
                : 'Refresh'}
            </button>
          )}
        </div>
      </div>

      {/* When AI Search is on, the Atria-powered global explorer replaces
          the entire local-creative body. We still render the header above
          so the user can toggle back; everything below (filters, charts,
          detail panel) is suppressed to avoid two competing scroll areas. */}
      {atriaMode ? (
        <AtriaExploreView
          brandName={brand}
          onClose={() => setAtriaMode(false)}
        />
      ) : false ? null : (
      <>

      {error && (
        <div className="glass rounded-lg p-3 text-xs text-red-600">{error}</div>
      )}

      {/* Rate-limit cooldown banner. shown when /refresh-urls comes back 503. */}
      <MetaRateLimitInlineBanner />

      {/* Motion-style filter bar: metrics picker + dimension + metric filters
          + group-by. Metrics moved to the leftmost slot per user request. it's
          the first thing they reach for, so it leads the bar. */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Metrics picker. Motion-style grouped headers. Same position as
            other filter pills so it visually anchors the bar's left edge. */}
        <div className="relative" ref={metricMenuRef}>
          <button onClick={() => setMetricPickerOpen(v => !v)}
            className={`h-7 px-2.5 rounded-full text-[11px] flex items-center gap-1.5 transition-colors ${
              metricPickerOpen
                ? 'bg-[#B7410E]/10 border border-[#B7410E]/30 text-[#b55719]'
                : 'glass glass-hover text-text-secondary'
            }`}>
            Metrics ({metrics.length}) <ChevronDown size={9} />
          </button>
          {metricPickerOpen && (
            <div className="absolute left-0 top-full mt-1 z-50 bg-white rounded-lg py-1 shadow-xl min-w-[260px] max-h-[440px] overflow-y-auto border border-black/[0.06]">
              <div className="px-2 py-1.5 sticky top-0 bg-white z-10">
                <input type="text" placeholder="Search metrics..." value={metricSearch}
                  onChange={e => setMetricSearch(e.target.value)} autoFocus
                  className="w-full bg-white/60 border border-black/[0.08] rounded-lg px-2 py-1 text-xs focus:outline-none" />
              </div>
              {(() => {
                const q = metricSearch.toLowerCase()
                const grouped: Partial<Record<MetricGroup, MetricDef[]>> = {}
                const seenKeys = new Set<string>()
                for (const m of ALL_METRICS) {
                  const k = String(m.key)
                  if (seenKeys.has(k)) continue
                  seenKeys.add(k)
                  if (q && !m.label.toLowerCase().includes(q)) continue
                  const g = (m.group || 'Performance') as MetricGroup
                  ;(grouped[g] ||= []).push(m)
                }
                return METRIC_GROUP_ORDER.map(g => {
                  const rows = grouped[g] || []
                  if (!rows.length) return null
                  return (
                    <div key={g} className="py-0.5">
                      <div className="px-3 pt-2 pb-0.5 text-[9px] uppercase tracking-widest text-text-muted font-medium sticky top-[34px] bg-white/95 backdrop-blur-sm">
                        {g}
                      </div>
                      {rows.map(m => (
                        <label key={String(m.key)}
                          className="flex items-center gap-2 px-3 py-1 text-xs hover:bg-white/60 cursor-pointer"
                          title={m.description || ''}>
                          <input type="checkbox" checked={metrics.includes(String(m.key))}
                            onChange={() => addMetric(String(m.key))}
                            className="rounded accent-[#B7410E]" />
                          {m.label}
                        </label>
                      ))}
                    </div>
                  )
                })
              })()}
            </div>
          )}
        </div>

        <FilterPillButton
          ref={dimPillRef}
          label="Dimension filter"
          count={dimRules.length}
          active={dimPopoverOpen}
          onClick={() => setDimPopoverOpen(v => !v)}
        />
        <FilterPillButton
          ref={metricPillRef}
          label="Metric filter"
          count={metricFilters.length}
          active={metricPopoverOpen}
          onClick={() => setMetricPopoverOpen(v => !v)}
        />
        {!reportMode && breakdownOptions.length > 0 && (() => {
          const current = breakdownOptions.find(b => b.key === breakdown)
          const active = breakdown !== 'none'
          return (
            <div className="relative" ref={breakdownRef}>
              <button
                onClick={() => setBreakdownOpen(v => !v)}
                className={`h-7 px-2.5 rounded-full text-[11px] flex items-center gap-1.5 transition-colors ${
                  active
                    ? 'bg-[#B7410E]/10 border border-[#B7410E]/30 text-[#b55719]'
                    : 'glass glass-hover text-text-secondary'
                }`}
                title="Split each ad's metrics by a Meta breakdown dimension"
              >
                <Layers3 size={10} />
                Breakdown{active ? `: ${current?.label || breakdown}` : ''}
                <ChevronDown size={9} />
              </button>
              {breakdownOpen && (
                <div className="absolute left-0 top-full mt-1 z-[70] bg-white rounded-md shadow-[0_6px_24px_-4px_rgba(0,0,0,0.18)] border border-black/[0.08] py-1 max-h-[320px] overflow-y-auto min-w-[220px]">
                  {breakdownOptions.map(b => (
                    <button
                      key={b.key}
                      onClick={() => { setBreakdown(b.key); setBreakdownOpen(false) }}
                      className={`w-full text-left px-3 py-1.5 text-[12px] hover:bg-black/[0.04] ${
                        breakdown === b.key ? 'text-[#B7410E]' : 'text-text-primary'
                      }`}
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })()}
        <GroupByPill value={groupBy} onChange={setGroupBy} extraFields={namingExtraGroupBy} />

        {/* Sort pill. explicit alongside Group By per user request. Default
            spend desc, persisted to localStorage in the existing useEffect.
            Column-header sort still works on the table view; this is the
            cross-view path so the same sort applies to cards/funnel/etc. */}
        <SortPill
          ref={sortPillRef}
          sort={sort}
          sortDir={sortDir}
          active={sortPopoverOpen}
          onClick={() => setSortPopoverOpen(o => !o)}
        />
        {sortPopoverOpen && (
          <SortPopover
            anchorRef={sortPillRef}
            metrics={Object.keys(METRICS_BY_KEY)}
            sort={sort}
            sortDir={sortDir}
            search={sortSearch}
            onSearchChange={setSortSearch}
            onChange={(field, dir) => { setSort(field); setSortDir(dir) }}
            onClose={() => setSortPopoverOpen(false)}
          />
        )}

        {/* Saved Reports submenu. hidden in standalone report HTML */}
        {!reportMode && <ReportsMenu
          brand={brand}
          captureConfig={captureReportConfig}
          onLoad={handleReportLoad}
          activeName={activeReport}
          dirty={reportDirty}
          onSaved={handleReportSaved}
          onDeleted={handleReportDeleted}
          onRenamed={handleReportRenamed}
          onClear={handleReportClear}
        />}

        {/* Boards used to live here next to Reports. Removed from
            Creative Analysis per UX request. boards now live only on
            the Atria search surface (AtriaExploreView), where ad pinning
            actually happens. The board-id state below is still kept
            because openBoard is also driven from URL params for share
            links. */}

        {/* Velocity bucket filter lives on the dashboard scorecards
            (click a tile to toggle), not as a dropdown here. An active
            chip surfaces below so the filter is still clearable from
            any view. */}

        {quickStatus && (() => {
          const info = statusInfo(quickStatus)
          return (
            <button
              onClick={() => setQuickStatus(null)}
              className="h-7 px-2.5 rounded-full text-[11px] flex items-center gap-1.5 transition-colors"
              style={{ background: info.ring, color: info.bg }}
              title="Clear quick status filter (Esc)"
            >
              <span className="inline-block rounded-full" style={{ width: 6, height: 6, background: info.bg }} />
              {info.label} only · Esc
            </button>
          )
        })()}

        {velocityFilter.size > 0 && (
          <button
            onClick={() => setVelocityFilter(new Set())}
            className="h-7 px-2.5 rounded-full text-[11px] flex items-center gap-1.5 bg-[#B7410E]/10 border border-[#B7410E]/30 text-[#b55719] transition-colors"
            title="Clear velocity filter"
          >
            <Sparkles size={10} />
            {[...velocityFilter].join(' · ')}
            <XIcon size={10} />
          </button>
        )}


        {hasAnyFilter && (
          <button
            onClick={resetAllFilters}
            className="text-[11px] text-text-muted hover:text-red-600"
          >
            Reset all filters
          </button>
        )}

        <div className="ml-auto text-[10px] text-text-muted">
          {isGrouped ? `${groupedRows.length} groups` : `${filteredAds.length} of ${ads.length}`}
        </div>
      </div>

      {/* Popovers. absolute-positioned below their anchor buttons. Rendered
          conditionally so their draft state resets on close. */}
      {dimPopoverOpen && (
        <DimensionFilterPopover
          fields={[...DIMENSION_FIELDS, ...namingExtraDimensions]}
          rules={dimRules}
          onChange={setDimRules}
          join={dimJoin}
          onJoinChange={setDimJoin}
          anchorRef={dimPillRef}
          getOptions={getDimensionOptions}
          onClose={() => setDimPopoverOpen(false)}
        />
      )}
      {metricPopoverOpen && (
        <MetricFilterPopover
          metrics={METRIC_OPTIONS}
          rules={metricFilters}
          onChange={setMetricFilters}
          join={metricJoin}
          onJoinChange={setMetricJoin}
          anchorRef={metricPillRef}
          onClose={() => setMetricPopoverOpen(false)}
        />
      )}

      {/* View toggles + metric picker + selection controls */}
      <div className="flex items-center gap-1 flex-wrap">
        {/* View toggles */}
        <div className="flex items-center gap-0.5">
          {([
            { k: 'dashboard', icon: LayoutDashboard, title: 'Dashboard view (scorecards + custom slots)' },
            { k: 'cards', icon: LayoutGrid, title: 'Creative grid' },
            { k: 'table', icon: Table2, title: 'Table view' },
            { k: 'bar', icon: BarChart3, title: 'Bar chart' },
            { k: 'line', icon: LineIcon, title: 'Line chart' },
            { k: 'scatter', icon: ChartScatter, title: 'Dot plot. pick X/Y axes, hover dots to preview' },
            { k: 'funnel', icon: Workflow, title: 'Funnel position. TOF/MOF/BOF lanes by freq + CPMR distance from median' },
            { k: 'funnel-real', icon: Layers3, title: 'Funnel viewer. lanes by REAL Meta segment delivery (new/engaged/existing) + reactivation. Drag to re-tag, click to open in Meta.' },
            // funnel-demo retired. the demo-split funnels view was rarely
            // used and added noise to the toggle strip. The same cohort
            // breakdown is reachable via the per-ad detail panel's demo
            // tabs, so no functionality is actually lost.
          ] as const).map(({ k, icon: Icon, title }) => (
            <button key={k} onClick={() => setChartMode(k)} title={title}
              className={`p-1 rounded transition-colors ${chartMode === k ? 'text-text-primary' : 'text-black/25 hover:text-text-secondary'}`}>
              <Icon size={11} />
            </button>
          ))}
        </div>

        {/* Selection controls. hidden in grouped mode since each "row" is
            an aggregate, not a single ad to toggle. */}
        {!isGrouped && (
          <div className="flex items-center gap-1 ml-1 text-[11px]">
            <button onClick={selectAllVisible}
              className="glass glass-hover px-2 py-1 rounded-full flex items-center gap-1 text-text-secondary"
              title="Select all visible">
              <CheckSquare size={10} /> All
            </button>
            {checked.size > 0 && (
              <button onClick={clearSelection}
                className="glass glass-hover px-2 py-1 rounded-full flex items-center gap-1 text-text-secondary">
                <XIcon size={10} /> Clear ({checked.size})
              </button>
            )}
          </div>
        )}
      </div>

      {/* Body */}
      {loading && !ads.length ? (
        <>
          {/* Loading banner. tells the user which brand is being pulled
              + how long it's been, so a 10-30s Meta cold-fetch doesn't
              look broken. The skeleton sits underneath unchanged. */}
          <LoadingBanner brand={brand} />
          <CardGridSkeleton zoom={gridZoom} />
        </>
      ) : !ads.length ? (
        <div className="glass rounded-lg p-16 text-center text-text-muted text-sm">
          No ads with spend in this range. Try widening the date window.
        </div>
      ) : isGrouped ? (
        chartMode === 'bar' ? (
          <GroupedBarChart rows={groupedRows} metricDefs={metricDefs} groupLabel={groupByLabel(groupBy)} />
        ) : chartMode === 'line' ? (
          <GroupedLineChart rows={groupedRows} metricDefs={metricDefs} groupLabel={groupByLabel(groupBy)} />
        ) : chartMode === 'scatter' ? (
          <DotPlotView
            ads={chartAds}
            groupedRows={groupedRows}
            onOpen={id => setSelectedId(id)}
            brand={brand}
          />
        ) : (
          <GroupedTable
            rows={groupedRows}
            metricDefs={metricDefs}
            groupLabel={groupByLabel(groupBy)}
            sort={sort}
            sortDir={sortDir}
            onSort={(k) => {
              if (sort === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
              else { setSort(k); setSortDir('desc') }
            }}
            onDrillIn={(groupKey, groupValue) => {
              // Drop the group dimension into the regular dimension
              // filter rail, then turn off Group By so the user sees
              // the underlying ads in that bucket. same view they'd
              // get from clicking the corresponding analytics chart
              // segment. Keeps any other active filters intact.
              if (groupBy === 'none') return
              setDimRules(prev => [
                ...prev,
                {
                  id: `drill-${Date.now().toString(36)}`,
                  field: String(groupBy),
                  op: 'is',
                  values: [groupKey],
                  text: groupValue,
                },
              ])
              setGroupBy('none')
            }}
          />
        )
      ) : chartMode === 'dashboard' ? (
        <CustomDashboardView
          ads={ads}
          chartAds={chartAds}
          metricDefs={metricDefs}
          brand={brand}
          onOpen={id => setSelectedId(id)}
          velocityFilter={velocityFilter}
          onToggleVelocity={toggleVelocity}
          velocityThresholds={velocityThresholds}
          onChangeVelocityThresholds={setVelocityThresholds}
        />
      ) : chartMode === 'funnel' ? (
        <FunnelView
          ads={chartAds}
          brand={brand}
          onOpen={id => setSelectedId(id)}
        />
      ) : chartMode === 'funnel-real' ? (
        <HypotheticalFunnelView
          ads={chartAds}
          brand={brand}
        />
      ) : chartMode === 'funnel-demo' ? (
        <DemoFunnelView
          ads={chartAds}
          brand={brand}
          start={start}
          end={end}
          onOpen={id => setSelectedId(id)}
        />
      ) : isGrouped && chartMode === 'cards' ? (
        // Cards view doesn't support grouped rendering. there's no
        // "GroupedCards" component yet. When the user has set group-by,
        // surface the grouped table so the rollup actually shows up
        // instead of silently ignoring the dropdown.
        <div className="flex flex-col gap-2">
          <div className="text-[10px] text-text-muted px-1">
            Cards view doesn't aggregate by group. showing the rollup table for {groupByLabel(groupBy)}.
          </div>
          <GroupedTable
            rows={groupedRows}
            metricDefs={metricDefs}
            groupLabel={groupByLabel(groupBy)}
            sort={sort}
            sortDir={sortDir}
            onSort={(k) => {
              if (sort === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
              else { setSort(k); setSortDir('desc') }
            }}
            onDrillIn={(groupKey, groupValue) => {
              // Drop the group dimension into the regular dimension
              // filter rail, then turn off Group By so the user sees
              // the underlying ads in that bucket. same view they'd
              // get from clicking the corresponding analytics chart
              // segment. Keeps any other active filters intact.
              if (groupBy === 'none') return
              setDimRules(prev => [
                ...prev,
                {
                  id: `drill-${Date.now().toString(36)}`,
                  field: String(groupBy),
                  op: 'is',
                  values: [groupKey],
                  text: groupValue,
                },
              ])
              setGroupBy('none')
            }}
          />
        </div>
      ) : chartMode === 'cards' && filteredAds.length === 0 ? (
        <div className="glass rounded-lg p-10 flex flex-col items-center gap-3 text-center">
          <div className="text-[12.5px] text-text-secondary">
            No ads match the current filters.
          </div>
          {quickStatus && (
            <button
              onClick={() => setQuickStatus(null)}
              className="h-7 px-2.5 rounded-full text-[11px] glass glass-hover text-text-secondary"
            >
              Clear quick status filter (Esc)
            </button>
          )}
          <div className="text-[11px] text-text-muted">
            If you just enabled the L/P shortcut, status data may still be
            loading. give it a few seconds and try again.
          </div>
        </div>
      ) : chartMode === 'cards' ? (
        <>
          <div
            ref={cardGridRef}
            onWheel={(e) => {
              // Two zoom gestures supported on the card grid:
              //   - Shift + vertical scroll  (laptop trackpad)
              //   - Pure horizontal scroll   (MX Master tilt-wheel, magic
              //     mouse). Threshold prevents runaway because tilt-wheels
              //     emit many small deltaX events per nudge.
              if (e.shiftKey) {
                e.preventDefault()
                const dir = e.deltaY > 0 ? -1 : 1
                setGridZoom(z => Math.min(5, Math.max(1, z + dir)))
                return
              }
              const ax = Math.abs(e.deltaX)
              const ay = Math.abs(e.deltaY)
              if (ax > ay && ax > 0) {
                e.preventDefault()
                hScrollAccum.current += e.deltaX
                const STEP = 60
                while (Math.abs(hScrollAccum.current) >= STEP) {
                  // Right scroll (positive deltaX) zooms IN. bigger cards,
                  // fewer per row. Left scroll zooms OUT.
                  const dir = hScrollAccum.current > 0 ? 1 : -1
                  setGridZoom(z => Math.min(5, Math.max(1, z + dir)))
                  hScrollAccum.current -= dir * STEP
                }
              }
            }}
          >
            <CardGrid
              ads={filteredAds}
              checked={checked}
              onToggle={toggleAd}
              onOpen={id => setSelectedId(id)}
              zoom={gridZoom}
              metricDefs={metricDefs}
              brand={brand}
            />
          </div>
          <ZoomSlider value={gridZoom} onChange={setGridZoom} />
        </>
      ) : chartMode === 'table' ? (
        <AdTable
          ads={filteredAds}
          metricDefs={metricDefs}
          checked={checked}
          onToggle={toggleAd}
          onOpen={id => setSelectedId(id)}
          brand={brand}
          sort={sort} sortDir={sortDir}
          onSort={(k) => {
            if (sort === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
            else { setSort(k); setSortDir('desc') }
          }}
        />
      ) : chartMode === 'bar' ? (
        <BarChartView
          ads={chartAds}
          metricDefs={metricDefs}
          usingSelection={checkedAds.length > 0}
          onOpen={id => setSelectedId(id)}
          brand={brand}
        />
      ) : chartMode === 'scatter' ? (
        <DotPlotView
          ads={chartAds}
          onOpen={id => setSelectedId(id)}
          brand={brand}
        />
      ) : (
        <LineChartView
          ads={chartAds.slice(0, MAX_CHART_LINES)}
          allSelected={chartAds.length}
          metricDefs={metricDefs}
          timeseries={timeseries}
          prevTimeseries={prevTimeseries}
          loading={tsLoading}
          error={tsError}
          usingSelection={checkedAds.length > 0}
          onOpen={id => setSelectedId(id)}
        />
      )}

      {openBoard && (
        <BoardDetailModal
          boardId={openBoard.id}
          boardName={openBoard.name}
          onClose={() => setOpenBoard(null)}
          onOpenAtelierAd={(adId) => setSelectedId(adId)}
        />
      )}

      {selectedAd && (() => {
        // Step prev/next through the currently-filtered+sorted ad list
        // so the detail panel respects the user's view context. Wraps
        // at the ends so power users can keep tapping ←/→ without
        // bouncing off the boundary.
        const idx = filteredAds.findIndex(a => a.ad_id === selectedAd.ad_id)
        const total = filteredAds.length
        const goPrev = () => {
          if (total === 0) return
          const next = filteredAds[(idx - 1 + total) % total]
          if (next) setSelectedId(next.ad_id)
        }
        const goNext = () => {
          if (total === 0) return
          const next = filteredAds[(idx + 1) % total]
          if (next) setSelectedId(next.ad_id)
        }
        return (
          <AdDetailPanel
            ad={selectedAd}
            brand={brand}
            start={start}
            end={end}
            compareStart={compareStart}
            compareEnd={compareEnd}
            preloadedAnalysis={fullAnalysisByAd[selectedAd.ad_id] || null}
            onClose={() => setSelectedId(null)}
            onPrev={total > 1 ? goPrev : undefined}
            onNext={total > 1 ? goNext : undefined}
            position={total > 0 ? { current: idx + 1, total } : undefined}
          />
        )
      })()}

      </>
      )}
    </div>
    </VideoLengthContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

// Skeleton cards rendered on first-time load (no cache available). Sized to
// match the real CardGrid at the active zoom level so the transition from
// skeleton -> real cards doesn't shift the layout. We render ~12 placeholders
//. enough to cover a typical viewport at any zoom without over-drawing.
// Brand-switch progress banner. Ticks an elapsed-seconds counter so a
// 10-30s Meta cold-fetch on a new brand doesn't feel frozen. Hidden
// after first paint of real data (caller gates on `loading && !ads`).
function LoadingBanner({ brand }: { brand: string }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    setElapsed(0)
    const t = window.setInterval(() => setElapsed(s => s + 1), 1000)
    return () => window.clearInterval(t)
  }, [brand])
  const hint =
    elapsed < 5  ? 'Fetching from Meta…' :
    elapsed < 15 ? 'Still pulling. first-load against Meta is slow.' :
    elapsed < 30 ? `${elapsed}s elapsed. large accounts can take 30-60s on cold cache.` :
                   `${elapsed}s elapsed. if this hangs past 90s, check the API log.`
  return (
    <div className="glass rounded-lg px-3 py-2 mb-2 flex items-center gap-2 text-[11px] text-text-secondary">
      <Loader2 size={12} className="animate-spin shrink-0 text-[#B7410E]" />
      <span className="font-medium text-text-primary">{brand || 'Loading'}</span>
      <span className="text-text-muted">·</span>
      <span className="text-text-muted">{hint}</span>
      <span className="ml-auto tabular-nums text-text-muted/70 text-[10px]">{elapsed}s</span>
    </div>
  )
}

function CardGridSkeleton({ zoom }: { zoom: number }) {
  const cls = GRID_ZOOM_CLASSES[zoom] || GRID_ZOOM_CLASSES[3]
  const metricCount = GRID_ZOOM_METRIC_COUNT[zoom] || 6
  const colsPerRow = metricCount >= 6 ? 3 : 2
  // Padding the count up a touch so widescreen layouts don't show a half-
  // empty grid; extra cards just clip below the fold on smaller screens.
  const PLACEHOLDER_COUNT = 12
  return (
    <div className={`grid ${cls} gap-2`} aria-busy="true" aria-label="Loading creatives">
      {Array.from({ length: PLACEHOLDER_COUNT }).map((_, i) => (
        <div
          key={i}
          className="glass rounded-lg overflow-hidden flex flex-col animate-pulse"
        >
          <div className="aspect-square bg-black/[0.06]" />
          <div
            className="px-2 pt-2 pb-1.5 grid gap-x-1.5 gap-y-1 border-b border-black/[0.04]"
            style={{ gridTemplateColumns: `repeat(${colsPerRow}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: metricCount }).map((__, j) => (
              <div key={j} className="flex flex-col leading-tight gap-0.5">
                <div className="h-[8px] w-10 rounded bg-black/[0.05]" />
                <div className="h-[10px] w-12 rounded bg-black/[0.08]" />
              </div>
            ))}
          </div>
          <div className="px-2 pt-1.5 pb-2">
            <div className="h-[10.5px] w-4/5 rounded bg-black/[0.06]" />
          </div>
        </div>
      ))}
    </div>
  )
}

// Threshold below which we skip virtualization. small lists don't benefit
// and the extra DOM work (measurement, rAF scroll handler) is noise.
const VIRTUALIZE_MIN = 50

function CardGrid({
  ads, checked, onToggle, onOpen, zoom, metricDefs, brand,
}: {
  ads: AdCreative[]
  checked: Set<string>
  onToggle: (id: string) => void
  onOpen: (id: string) => void
  zoom: number
  metricDefs: MetricDef[]
  brand?: string
}) {
  const cls = GRID_ZOOM_CLASSES[zoom] || GRID_ZOOM_CLASSES[3]
  const metricCount = GRID_ZOOM_METRIC_COUNT[zoom] || 6

  // Card metric source: user's picked metrics, minus text / analysis fields
  // (which render as pills, not compact KPI values). If the user picked
  // nothing we fall back to the prior curated default set.
  const cardMetrics = useMemo<MetricDef[]>(() => {
    const picked = metricDefs.filter(m => m.format !== 'text' && !m.analysisField)
    if (picked.length) return picked
    return DEFAULT_CARD_METRIC_KEYS
      .map(k => METRICS_BY_KEY[k])
      .filter(Boolean) as MetricDef[]
  }, [metricDefs])

  if (ads.length < VIRTUALIZE_MIN) {
    return (
      <div className={`grid ${cls} gap-2`}>
        {ads.map(ad => (
          <AdCard
            key={ad.ad_id}
            ad={ad}
            isChecked={checked.has(ad.ad_id)}
            onToggle={() => onToggle(ad.ad_id)}
            onClick={() => onOpen(ad.ad_id)}
            metricCount={metricCount}
            metricDefs={cardMetrics}
          />
        ))}
      </div>
    )
  }

  return (
    <VirtualizedCardGrid
      ads={ads}
      checked={checked}
      onToggle={onToggle}
      onOpen={onOpen}
      zoom={zoom}
      metricCount={metricCount}
      metricDefs={cardMetrics}
      cls={cls}
      brand={brand}
    />
  )
}

// Virtualization wrapper. Uses the responsive grid class as-is (so columns
// still adapt to viewport) but renders only the cards within a sliding
// window computed by useVirtualGrid. Padding spacers at top/bottom keep
// the scroll geometry honest.
function VirtualizedCardGrid({
  ads, checked, onToggle, onOpen, zoom, metricCount, metricDefs, cls, brand,
}: {
  ads: AdCreative[]
  checked: Set<string>
  onToggle: (id: string) => void
  onOpen: (id: string) => void
  zoom: number
  metricCount: number
  metricDefs: MetricDef[]
  cls: string
  brand?: string
}) {
  const colsPerRow = ZOOM_COLS_AT_XL[zoom] || 7
  const estimatedRowHeight = ZOOM_ROW_HEIGHT_GUESS[zoom] || 260
  const { hostRef, sentinelRef, visibleStart, visibleEnd, paddingTop, paddingBottom } =
    useVirtualGrid({
      total: ads.length,
      colsPerRow,
      estimatedRowHeight,
      // Wide buffer prevents cards from unmounting on casual scroll -
      // when they remount the <img> re-fires and the shimmer flashes
      // back even though the browser cache has the bytes. 8 rows is
      // ~1500px of mounted-but-offscreen content.
      overscanRows: 8,
    })
  const slice = ads.slice(visibleStart, visibleEnd)
  // Bulk-warm post-thumb / img-by-ad disk caches for the visible window
  // so individual <img> requests hit cache instead of triggering a fresh
  // og:image scrape per card. Debounced so scroll bursts don't flood the
  // backend; tracks already-sent ad_ids in a ref so we don't re-warm on
  // every scroll tick.
  const warmedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!brand || slice.length === 0) return
    const t = setTimeout(() => {
      const items: { ad_id: string; brand: string; story_id?: string }[] = []
      for (const ad of slice) {
        if (!ad.ad_id) continue
        if (warmedRef.current.has(ad.ad_id)) continue
        warmedRef.current.add(ad.ad_id)
        items.push({
          ad_id: ad.ad_id,
          brand,
          story_id: ad.effective_object_story_id || undefined,
        })
      }
      if (items.length === 0) return
      fetch('/api/ads/prefetch-thumbs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      }).catch(() => { /* best-effort warm */ })
    }, 250)
    return () => clearTimeout(t)
  }, [visibleStart, visibleEnd, brand, ads])
  return (
    <div ref={hostRef}>
      <div ref={sentinelRef} aria-hidden="true" />
      <div style={{ paddingTop, paddingBottom }}>
        <div className={`grid ${cls} gap-2`}>
          {slice.map(ad => (
            <AdCard
              key={ad.ad_id}
              ad={ad}
              isChecked={checked.has(ad.ad_id)}
              onToggle={() => onToggle(ad.ad_id)}
              onClick={() => onOpen(ad.ad_id)}
              metricCount={metricCount}
              metricDefs={metricDefs}
              brand={brand}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function AdCard({
  ad, isChecked, onToggle, onClick, metricCount, metricDefs, brand,
}: {
  ad: AdCreative
  isChecked: boolean
  onToggle: () => void
  onClick: () => void
  metricCount: number
  metricDefs: MetricDef[]
  brand?: string
}) {
  // Card KPIs reflect the user's Metrics picker (user feedback: if AOV is
  // checked it should appear under the creative). Zoom controls how many
  // metric chips fit in the first row; any extras wrap onto subsequent rows.
  // Each chip pulls its prior-period value (prev_<key>) from the same row
  // so the compare-period delta lights up alongside the current value.
  const inline = metricDefs.map(def => {
    const raw = (ad as any)[def.key]
    const prevRaw = (ad as any)[`prev_${def.key}`]
    const cls = def.key === 'roas' && typeof raw === 'number'
      ? (raw >= 2 ? 'text-emerald-600' : raw >= 1 ? 'text-text-secondary' : 'text-red-500')
      : undefined
    return {
      key: String(def.key),
      label: def.label,
      value: fmtMetric(raw as any, def),
      raw: typeof raw === 'number' ? raw : undefined,
      prev: typeof prevRaw === 'number' ? prevRaw : undefined,
      cls,
    }
  })
  // Columns-per-row is driven by zoom (3 cols at zoom >=3, else 2). The
  // first `metricCount` chips always fit inside the initial rows; anything
  // more wraps so the user gets room for more metrics when they pick them.
  const colsPerRow = metricCount >= 6 ? 3 : 2

  return (
    <div
      data-vcard
      className={`group glass glass-hover rounded-lg overflow-hidden text-left flex flex-col transition-all hover:shadow-lg hover:-translate-y-0.5 relative ${
        isChecked ? 'ring-2 ring-[#B7410E]' : ''
      }`}
    >
      {/* Checkbox overlay. solid square, orange when checked. */}
      <div
        role="checkbox"
        aria-checked={isChecked}
        tabIndex={0}
        onClick={(e) => { e.stopPropagation(); onToggle() }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onToggle() } }}
        className={`absolute top-2 left-2 z-10 w-[18px] h-[18px] rounded-[4px] flex items-center justify-center cursor-pointer transition-colors select-none ${
          isChecked
            ? 'bg-[#B7410E] shadow-sm ring-1 ring-[#B7410E]/30'
            : 'bg-white/85 backdrop-blur-sm ring-1 ring-black/15 hover:ring-black/30'
        }`}
        title={isChecked ? 'Deselect' : 'Select for chart'}
      >
        {isChecked && (
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 8.5 6.5 12 13 5" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>

      <button onClick={onClick} className="flex flex-col text-left w-full">
        {/* 4:5 portrait. most Meta creatives are portrait-shot for mobile
            feed (4:5 / 9:16). Forcing a 1:1 square hides the top and bottom
            of every creative; 4:5 keeps the same width but lets the image
            show its native vertical context. Matches the Atria search grid
            so toggling between modes feels visually continuous. */}
        <div className="relative aspect-[4/5]">
          <Thumbnail
            ad={ad}
            brand={brand}
            showVideoBadge
            imgClassName="group-hover:scale-105"
          />
        </div>

        {/* Inline metrics row. mirrors the Metrics picker selection. */}
        {inline.length > 0 && (
          <div
            className="px-2 pt-2 pb-1.5 grid gap-x-1.5 gap-y-1 border-b border-black/[0.04]"
            style={{ gridTemplateColumns: `repeat(${colsPerRow}, minmax(0, 1fr))` }}
          >
            {inline.map(m => (
              <div key={m.key} className="flex flex-col leading-tight min-w-0">
                <span className="text-[8px] uppercase tracking-wider text-text-muted truncate">{m.label}</span>
                <span className={`text-[10.5px] tabular-nums font-medium truncate ${m.cls || 'text-text-primary'} inline-flex items-baseline`}>
                  <span className="truncate">{m.value}</span>
                  <DeltaChip current={m.raw} prev={m.prev} metricKey={m.key} />
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Footer. status dot + ad name. The dot's color reflects Meta's
            `effective_status` (what's actually delivering, may differ
            from `configured_status` if a parent adset is paused).
            Hover surfaces the last-state-change timestamp. */}
        <div className="px-2 pt-1.5 pb-2 min-w-0 flex items-center gap-1.5">
          <StatusDot status={ad.effective_status} updatedTime={ad.updated_time} />
          <div className="text-[10.5px] font-medium text-text-primary truncate flex-1" title={ad.ad_name}>
            {ad.ad_name || 'Untitled ad'}
          </div>
        </div>
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Status dot. small circle whose color reflects an ad's Meta lifecycle.
// Reused on the card grid + table view so the visual language is consistent.
// `status` is the value Meta returns for `effective_status`:
//   ACTIVE / PAUSED / DELETED / PENDING_REVIEW / DISAPPROVED / PREAPPROVED /
//   PENDING_BILLING_INFO / CAMPAIGN_PAUSED / ARCHIVED / ADSET_PAUSED / IN_PROCESS / WITH_ISSUES
// ---------------------------------------------------------------------------

const STATUS_COLOR: Record<string, { bg: string; ring: string; label: string }> = {
  ACTIVE:               { bg: '#10b981', ring: 'rgba(16,185,129,0.30)', label: 'Active' },
  PAUSED:               { bg: '#9ca3af', ring: 'rgba(156,163,175,0.30)', label: 'Paused' },
  ADSET_PAUSED:         { bg: '#9ca3af', ring: 'rgba(156,163,175,0.30)', label: 'Adset paused' },
  CAMPAIGN_PAUSED:      { bg: '#9ca3af', ring: 'rgba(156,163,175,0.30)', label: 'Campaign paused' },
  ARCHIVED:             { bg: '#6b7280', ring: 'rgba(107,114,128,0.30)', label: 'Archived' },
  DELETED:              { bg: '#6b7280', ring: 'rgba(107,114,128,0.30)', label: 'Deleted' },
  PENDING_REVIEW:       { bg: '#f59e0b', ring: 'rgba(245,158,11,0.30)', label: 'Pending review' },
  IN_PROCESS:           { bg: '#f59e0b', ring: 'rgba(245,158,11,0.30)', label: 'In review' },
  PREAPPROVED:          { bg: '#84cc16', ring: 'rgba(132,204,22,0.30)', label: 'Pre-approved' },
  DISAPPROVED:          { bg: '#ef4444', ring: 'rgba(239,68,68,0.30)', label: 'Disapproved' },
  PENDING_BILLING_INFO: { bg: '#f59e0b', ring: 'rgba(245,158,11,0.30)', label: 'Awaiting billing' },
  WITH_ISSUES:          { bg: '#ef4444', ring: 'rgba(239,68,68,0.30)', label: 'Issues' },
}

function statusInfo(status?: string | null): { bg: string; ring: string; label: string } {
  if (!status) return { bg: '#d1d5db', ring: 'rgba(0,0,0,0.06)', label: 'Unknown' }
  return STATUS_COLOR[status] || { bg: '#d1d5db', ring: 'rgba(0,0,0,0.06)', label: status.replace(/_/g, ' ').toLowerCase() }
}

function StatusDot({ status, updatedTime }: { status?: string | null; updatedTime?: string | null }) {
  const info = statusInfo(status)
  const tip = updatedTime
    ? `${info.label} · last change ${new Date(updatedTime).toLocaleString()}`
    : info.label
  return (
    <span
      className="inline-block rounded-full shrink-0"
      style={{ width: 7, height: 7, background: info.bg, boxShadow: `0 0 0 2px ${info.ring}` }}
      title={tip}
      aria-label={info.label}
    />
  )
}

function StatusPill({ status, updatedTime }: { status?: string | null; updatedTime?: string | null }) {
  const info = statusInfo(status)
  const tip = updatedTime
    ? `${info.label} · last change ${new Date(updatedTime).toLocaleString()}`
    : info.label
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
      style={{ background: info.ring, color: info.bg }}
      title={tip}
    >
      <span className="inline-block rounded-full" style={{ width: 5, height: 5, background: info.bg }} />
      {info.label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Velocity scorecards (item #6). four spark-style cards above the grid:
//   New Launched · Scaling · Winners · Losers
// Defaults are tuned for ad-account scale; eventually these become user-
// configurable in the brand settings panel (deferred to a follow-up so we
// can ship the visual today).
// ---------------------------------------------------------------------------

type VelocityBucket = {
  label: string
  count: number
  delta?: number     // % change vs previous period (UI shows ↑/↓)
  helper: string     // tooltip hint about the rule used
}

// ---------------------------------------------------------------------------
// Dot plot (item #10). scatter chart with user-selectable X/Y axes pulled
// from the metric registry. Each dot is one ad, color-coded by ROAS bucket.
// Hover triggers a small preview popover with the creative thumbnail; click
// opens the detail panel just like the cards/table views.
// ---------------------------------------------------------------------------

const DOT_PLOT_DEFAULT_X = 'roas'
const DOT_PLOT_DEFAULT_Y = 'spend'
const DOT_PLOT_DEFAULT_Z = 'impressions'  // bubble size metric. defaults to a high-magnitude counter so bubbles separate visibly

function DotPlotView({ ads, groupedRows, onOpen, brand }: {
  ads: AdCreative[]
  // When the user has Group By active, the chart pivots: each group
  // becomes one dot whose X/Y are the aggregate metrics across all ads
  // in that bucket (sums for raw counters, derived for ratios). The
  // tooltip then shows the group label + member count instead of an
  // individual ad's thumbnail.
  groupedRows?: GroupedRow[]
  onOpen: (id: string) => void
  brand?: string
}) {
  const isGrouped = !!(groupedRows && groupedRows.length > 0)
  const [xKey, setXKey] = useState<string>(() => {
    try { return localStorage.getItem('ac.dotplot.x') || DOT_PLOT_DEFAULT_X } catch { return DOT_PLOT_DEFAULT_X }
  })
  // Y is optional. when cleared the dot plot collapses to a 1D strip
  // showing the X distribution only. Each dot gets a tiny vertical
  // jitter so overlapping ads stay visible. localStorage stores '' for
  // "no Y" so a refresh remembers the choice.
  const [yKey, setYKey] = useState<string>(() => {
    try {
      const v = localStorage.getItem('ac.dotplot.y')
      return v === null ? DOT_PLOT_DEFAULT_Y : v
    } catch { return DOT_PLOT_DEFAULT_Y }
  })
  // Z axis = bubble size. Empty string = uniform dots (the old behaviour).
  // Defaults to impressions so bubbles separate visibly across orders
  // of magnitude. spend works too but tends to cluster.
  const [zKey, setZKey] = useState<string>(() => {
    try {
      const v = localStorage.getItem('ac.dotplot.z')
      return v === null ? DOT_PLOT_DEFAULT_Z : v
    } catch { return DOT_PLOT_DEFAULT_Z }
  })
  const [trendline, setTrendline] = useState<boolean>(() => {
    try { return localStorage.getItem('ac.dotplot.trend') === '1' } catch { return false }
  })
  useEffect(() => { try { localStorage.setItem('ac.dotplot.x', xKey) } catch {} }, [xKey])
  useEffect(() => { try { localStorage.setItem('ac.dotplot.y', yKey) } catch {} }, [yKey])
  useEffect(() => { try { localStorage.setItem('ac.dotplot.z', zKey) } catch {} }, [zKey])
  useEffect(() => { try { localStorage.setItem('ac.dotplot.trend', trendline ? '1' : '0') } catch {} }, [trendline])

  const xDef = METRICS_BY_KEY[xKey] || ALL_METRICS[0]
  const yDef = yKey ? (METRICS_BY_KEY[yKey] || null) : null
  const zDef = zKey ? (METRICS_BY_KEY[zKey] || null) : null
  const has_y = !!yDef
  const has_z = !!zDef

  const data = useMemo(() => {
    // Grouped mode: one bubble per bucket. Size pulled from the
    // group's aggregated z metric (or ad_count when z is off. that
    // way grouped bubbles still scale by member count by default).
    if (isGrouped && groupedRows) {
      return groupedRows.map((g, i) => ({
        ad_id: '',
        ad_name: g.group_value,
        ad: null,
        is_video: false,
        is_group: true,
        group_label: g.group_value,
        ad_count: g.ad_count,
        effective_status: null,
        x: Number(g[xKey] ?? 0),
        y: has_y
          ? Number(g[yKey] ?? 0)
          : ((i * 9301 + 49297) % 233280) / 233280 * 2 - 1,
        z: has_z ? Math.max(0, Number(g[zKey] ?? 0)) : g.ad_count,
        roas: Number(g.roas || 0),
      })).filter(d => Number.isFinite(d.x) && Number.isFinite(d.y))
    }
    return ads.map((a, i) => ({
      ad_id: a.ad_id,
      ad_name: a.ad_name,
      ad: a,
      is_video: !!a.is_video,
      is_group: false,
      group_label: '',
      ad_count: 0,
      effective_status: a.effective_status,
      x: Number((a as any)[xKey] ?? 0),
      y: has_y
        ? Number((a as any)[yKey] ?? 0)
        : ((i * 9301 + 49297) % 233280) / 233280 * 2 - 1,
      // Bubble size. clamp negatives to 0 (some derived metrics like
      // ROAS-delta can go negative; Recharts ZAxis treats negatives as
      // 0 anyway but we normalize for the tooltip).
      z: has_z ? Math.max(0, Number((a as any)[zKey] ?? 0)) : 1,
      roas: Number(a.roas || 0),
    })).filter(d => Number.isFinite(d.x) && Number.isFinite(d.y))
  }, [ads, groupedRows, isGrouped, xKey, yKey, zKey, has_y, has_z])

  // Linear regression. least-squares slope + intercept across the
  // current points. Returns the two endpoints to draw a line. Skips
  // when fewer than 2 distinct X values (no line to fit) or when
  // we're in 1D mode (Y is jittered, regression is meaningless).
  const trendPoints = useMemo<Array<{ x: number; y: number }> | null>(() => {
    if (!trendline || !has_y || data.length < 2) return null
    const n = data.length
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0
    let minX = Infinity, maxX = -Infinity
    for (const d of data) {
      sumX += d.x
      sumY += d.y
      sumXY += d.x * d.y
      sumXX += d.x * d.x
      if (d.x < minX) minX = d.x
      if (d.x > maxX) maxX = d.x
    }
    const denom = (n * sumXX) - (sumX * sumX)
    if (denom === 0 || !Number.isFinite(denom)) return null
    const slope = ((n * sumXY) - (sumX * sumY)) / denom
    const intercept = (sumY - slope * sumX) / n
    if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return null
    return [
      { x: minX, y: minX * slope + intercept },
      { x: maxX, y: maxX * slope + intercept },
    ]
  }, [data, trendline, has_y])

  // Color buckets. orange for high ROAS, gray for mid, dim for low,
  // matches the Atelier accent system.
  const colorFor = (roas: number) =>
    roas >= 2 ? '#B7410E'
    : roas >= 1 ? '#9a4912'
    : roas > 0 ? '#9ca3af'
    : '#d1d5db'

  // Numeric metrics only. text/categorical fields don't plot on
  // either axis. Group the picker by metric category so users can
  // navigate it the same way as the metrics dropdown.
  const numericMetrics = useMemo(
    () => ALL_METRICS.filter(m => m.format !== 'text' && !m.analysisField),
    []
  )

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <AxisPicker label="X" value={xKey} onChange={setXKey} options={numericMetrics} />
        <AxisPicker
          label="Y"
          value={yKey}
          onChange={setYKey}
          options={numericMetrics}
          clearable
          placeholder="None"
        />
        <AxisPicker
          label="Size"
          value={zKey}
          onChange={setZKey}
          options={numericMetrics}
          clearable
          placeholder={isGrouped ? 'Ad count' : 'Uniform'}
        />
        <DotPlotSettings
          trendline={trendline}
          onToggleTrendline={() => setTrendline(v => !v)}
        />
      </div>
      <div className="atelier-tile" style={{ height: 460 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 12, right: 16, bottom: 32, left: 36 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
            <XAxis
              type="number"
              dataKey="x"
              name={xDef.label}
              tick={{ fontSize: 10, fill: '#6b7280' }}
              tickFormatter={v => fmtDotAxis(v, xDef.format)}
              label={{ value: xDef.label, position: 'insideBottom', offset: -10, fontSize: 11, fill: '#6b7280' }}
            />
            <YAxis
              type="number"
              dataKey="y"
              name={yDef ? yDef.label : ''}
              domain={has_y ? undefined : [-2, 2]}
              hide={!has_y}
              tick={{ fontSize: 10, fill: '#6b7280' }}
              tickFormatter={v => has_y && yDef ? fmtDotAxis(v, yDef.format) : ''}
              label={has_y && yDef
                ? { value: yDef.label, angle: -90, position: 'insideLeft', offset: 8, fontSize: 11, fill: '#6b7280' }
                : undefined}
            />
            {/* When sized (z metric picked, or grouped with default
                ad_count), Recharts auto-scales bubble area across the
                z range linearly within [40, 900] px². Otherwise a flat
                80 px² keeps the legacy dot look. */}
            <ZAxis
              type="number"
              dataKey="z"
              range={has_z || isGrouped ? [40, 900] : [80, 80]}
              name={has_z && zDef ? zDef.label : (isGrouped ? 'Ad count' : '')}
            />
            <Tooltip
              cursor={false}
              content={(props) => (
                <DotPlotTooltip
                  {...props}
                  xLabel={xDef.label} yLabel={yDef?.label} zLabel={has_z && zDef ? zDef.label : (isGrouped ? 'Ads in group' : undefined)}
                  xFormat={xDef.format} yFormat={yDef?.format} zFormat={has_z && zDef ? zDef.format : 'number'}
                  brand={brand}
                />
              )}
            />
            <Scatter
              data={data}
              onClick={(p: any) => { if (p?.ad_id && !p.is_group) onOpen(p.ad_id) }}
              cursor={isGrouped ? 'default' : 'pointer'}
            >
              {data.map((d, i) => (
                <Cell key={i} fill={colorFor(d.roas)} fillOpacity={0.75} />
              ))}
            </Scatter>
            {/* Linear best-fit line. rendered as a line-shape Scatter
                so it shares the chart's X/Y scales without needing a
                separate axis. Dashed orange to call out it's an
                aggregate, not a real datapoint. */}
            {trendPoints && (
              <Scatter
                data={trendPoints}
                line={{ stroke: '#B7410E', strokeWidth: 1.5, strokeDasharray: '5 4' }}
                shape={() => <g />}
                legendType="none"
                isAnimationActive={false}
              />
            )}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function fmtDotAxis(v: number, fmt: MetricDef['format']): string {
  if (!Number.isFinite(v)) return ''
  if (fmt === 'dollar') return v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`
  if (fmt === 'percent') return `${v.toFixed(1)}%`
  if (fmt === 'decimal') return v.toFixed(2)
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)
}

function AxisPicker({ label, value, onChange, options, clearable, placeholder }: {
  label: string
  value: string
  onChange: (v: string) => void
  options: MetricDef[]
  // When `clearable`, clicking the currently-selected option in the
  // popover toggles it off (calls onChange('')) instead of being a
  // no-op. Used for the dot-plot Y picker so the user can collapse to
  // a 1D view by clicking the same metric again.
  clearable?: boolean
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])
  // Reset search when the popover closes so re-opening starts fresh.
  useEffect(() => { if (!open) setSearch('') }, [open])

  const current = options.find(o => String(o.key) === value)

  // Group options by metric category. same shape as the main Metrics
  // picker so users feel at home: section headers, search box, single-
  // select bullets instead of checkboxes.
  const grouped = useMemo<Partial<Record<MetricGroup, MetricDef[]>>>(() => {
    const q = search.toLowerCase()
    const out: Partial<Record<MetricGroup, MetricDef[]>> = {}
    const seen = new Set<string>()
    for (const m of options) {
      const k = String(m.key)
      if (seen.has(k)) continue
      seen.add(k)
      if (q && !m.label.toLowerCase().includes(q)) continue
      const g = (m.group || 'Performance') as MetricGroup
      ;(out[g] ||= []).push(m)
    }
    return out
  }, [options, search])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        className="h-6 px-2 rounded-full text-[10px] inline-flex items-center gap-1 border border-black/[0.08] bg-white/60 hover:bg-white/90 text-text-secondary transition-colors"
      >
        <span className="text-text-muted">{label}:</span>
        <span className="text-text-primary">
          {current?.label || (value ? value : (placeholder || 'Pick…'))}
        </span>
        <ChevronDown size={9} />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 rounded-lg py-1 shadow-xl min-w-[260px] max-h-[440px] overflow-y-auto border border-black/[0.06]"
          style={{ background: 'rgba(255,255,255,0.94)', backdropFilter: 'blur(20px) saturate(180%)' }}>
          {/* Search. sticky to top so scrolling within sections doesn't lose it. */}
          <div className="px-2 py-1.5 sticky top-0 bg-white/95 backdrop-blur-sm z-10">
            <input
              type="text"
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search metrics…"
              className="w-full bg-white/60 border border-black/[0.08] rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-[#B7410E]"
            />
          </div>
          {METRIC_GROUP_ORDER.map(g => {
            const rows = grouped[g] || []
            if (!rows.length) return null
            return (
              <div key={g} className="py-0.5">
                <div className="px-3 pt-2 pb-0.5 text-[9px] uppercase tracking-widest text-text-muted font-medium sticky top-[34px] bg-white/95 backdrop-blur-sm">
                  {g}
                </div>
                {rows.map(o => {
                  const isSelected = value === String(o.key)
                  return (
                    <button
                      key={String(o.key)}
                      onClick={() => {
                        if (clearable && isSelected) onChange('')
                        else onChange(String(o.key))
                        setOpen(false)
                      }}
                      title={o.description || ''}
                      className="w-full text-left px-3 py-1 text-xs hover:bg-black/[0.04] flex items-center gap-2"
                    >
                      {/* Radio bullet. orange filled when selected. */}
                      <span
                        className="w-3 h-3 rounded-full border-[1.5px] flex-shrink-0 flex items-center justify-center"
                        style={{
                          borderColor: isSelected ? '#B7410E' : 'rgba(0,0,0,0.20)',
                          background: isSelected ? '#B7410E' : 'transparent',
                        }}
                      >
                        {isSelected && (
                          <span className="block w-1 h-1 rounded-full bg-white" />
                        )}
                      </span>
                      <span className={isSelected ? 'text-[#B7410E] font-medium' : 'text-text-secondary'}>
                        {o.label}
                      </span>
                      {clearable && isSelected && (
                        <span className="ml-auto text-[10px] text-[#B7410E] opacity-70">
                          click to remove
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )
          })}
          {Object.values(grouped).every(g => !g || g.length === 0) && (
            <div className="px-3 py-3 text-[11px] text-text-muted">
              No metrics match "{search}"
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// SmaPicker. inline multi-select pill for moving-average windows on
// the line chart. Mirrors AxisPicker's visual language (h-6 px-2
// rounded-full border bg-white/60), but allows multi-select via a
// checkbox-style popover. Each window has its own color matching the
// dashed line color in the chart so the legend is implicit.
function SmaPicker<K extends string>({
  options, active, onToggle, colorFor,
}: {
  options: { key: K; label: string }[]
  active: Set<K>
  onToggle: (k: K) => void
  colorFor: (k: K) => string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])
  const summary = active.size === 0
    ? 'Off'
    : Array.from(active)
        .sort()
        .map(k => k.slice(3) + 'd')
        .join(', ')
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        className="h-6 px-2 rounded-full text-[10px] inline-flex items-center gap-1 border border-black/[0.08] bg-white/60 hover:bg-white/90 text-text-secondary transition-colors"
      >
        <span className="text-text-muted">MA:</span>
        <span className="text-text-primary">{summary}</span>
        <ChevronDown size={9} />
      </button>
      {open && (
        <div
          className="absolute left-0 top-full mt-1 z-50 rounded-lg py-1 shadow-xl min-w-[140px] border border-black/[0.06]"
          style={{ background: 'rgba(255,255,255,0.94)', backdropFilter: 'blur(20px) saturate(180%)' }}
        >
          {options.map(o => {
            const isOn = active.has(o.key)
            return (
              <button
                key={o.key}
                onClick={() => onToggle(o.key)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] hover:bg-black/[0.04] text-left"
              >
                <span
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{
                    background: isOn ? colorFor(o.key) : 'rgba(0,0,0,0.08)',
                    border: `1px solid ${isOn ? colorFor(o.key) : 'rgba(0,0,0,0.12)'}`,
                  }}
                />
                <span className="flex-1 text-text-primary">{o.label}</span>
                {isOn && <Check size={10} className="text-text-muted" />}
              </button>
            )
          })}
          {active.size > 0 && (
            <button
              onClick={() => options.forEach(o => active.has(o.key) && onToggle(o.key))}
              className="w-full text-left px-3 py-1.5 text-[10px] text-text-muted hover:bg-black/[0.04] border-t border-black/[0.04] mt-0.5"
            >
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function DotPlotSettings({ trendline, onToggleTrendline }: {
  trendline: boolean
  onToggleTrendline: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        className="h-6 w-6 rounded-full border border-black/[0.08] bg-white/60 hover:bg-white/90 text-text-secondary flex items-center justify-center transition-colors"
        title="Dot plot settings"
      >
        <Settings2 size={10} />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 rounded-lg py-1 shadow-xl min-w-[220px] border border-black/[0.06]"
          style={{ background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(20px) saturate(180%)' }}>
          <button
            onClick={onToggleTrendline}
            className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-black/[0.04] flex items-center justify-between"
          >
            <span>Linear best fit</span>
            <span
              className="w-7 h-4 rounded-full relative transition-colors flex-shrink-0"
              style={{ background: trendline ? '#B7410E' : 'rgba(0,0,0,0.15)' }}
            >
              <span
                className="absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform"
                style={{ transform: trendline ? 'translateX(12px)' : 'translateX(0)' }}
              />
            </span>
          </button>
        </div>
      )}
    </div>
  )
}

function DotPlotTooltip(props: any) {
  const { active, payload, xLabel, yLabel, zLabel, xFormat, yFormat, zFormat, brand } = props
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  if (!p || (!p.ad && !p.is_group)) return null

  if (p.is_group) {
    return (
      <div className="rounded-lg bg-white/95 border border-black/[0.08] shadow-xl p-2.5 max-w-[220px] backdrop-blur-md">
        <div className="text-[10px] uppercase tracking-widest text-text-muted font-medium mb-0.5">
          {p.ad_count} ad{p.ad_count === 1 ? '' : 's'}
        </div>
        <div className="text-[12px] font-medium text-text-primary line-clamp-2 mb-1">
          {p.group_label || '(unanalyzed)'}
        </div>
        <div className="text-[10px] text-text-muted tabular-nums flex flex-col gap-0.5">
          <span>{xLabel}: {fmtDotAxis(p.x, xFormat)}</span>
          {yLabel && <span>{yLabel}: {fmtDotAxis(p.y, yFormat)}</span>}
          {zLabel && <span>{zLabel}: {fmtDotAxis(p.z, zFormat || 'number')}</span>}
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg bg-white/95 border border-black/[0.08] shadow-xl p-2.5 max-w-[220px] backdrop-blur-md">
      <div className="aspect-square w-[180px] rounded-lg overflow-hidden mb-1.5">
        <Thumbnail ad={p.ad} brand={brand} />
      </div>
      <div className="text-[11px] font-medium text-text-primary line-clamp-2 mb-1">
        {p.ad_name || p.ad_id}
      </div>
      <div className="text-[10px] text-text-muted tabular-nums flex flex-col gap-0.5">
        <span>{xLabel}: {fmtDotAxis(p.x, xFormat)}</span>
        {yLabel && <span>{yLabel}: {fmtDotAxis(p.y, yFormat)}</span>}
        {zLabel && <span>{zLabel}: {fmtDotAxis(p.z, zFormat || 'number')}</span>}
        {p.is_video && <span className="text-[#B7410E]">▶ Video</span>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Custom dashboard view (item #11). user picks which widgets show.
// Each widget toggle is persisted to localStorage so the layout sticks
// across reloads. Future expansion: drag-drop reordering, custom spark
// chart slots, mini-mosaic with user-picked filters.
// ---------------------------------------------------------------------------

type DashboardWidget = 'velocity' | 'top_grid' | 'top_table' | 'kpi_strip'
const ALL_WIDGETS: { key: DashboardWidget; label: string; hint: string }[] = [
  { key: 'velocity', label: 'Velocity scorecards', hint: 'New launched · scaling · winners · losers' },
  { key: 'kpi_strip', label: 'KPI strip', hint: 'Spend · Revenue · ROAS · Purchases · CTR' },
  { key: 'top_grid',  label: 'Top creatives (grid)', hint: 'Best 6 ads by ROAS as a mini-mosaic' },
  { key: 'top_table', label: 'Top performers (table)', hint: 'Top 10 by spend with key metrics' },
]
const DEFAULT_DASH_WIDGETS: DashboardWidget[] = ['velocity', 'kpi_strip', 'top_grid', 'top_table']

// Default KPI metrics for the KPI-strip widget. User-configurable per-tile
// in edit mode. pick any numeric metric for any cell.
const DEFAULT_KPI_KEYS = ['spend', 'revenue', 'roas', 'purchases', 'ctr', 'cpa']

// 6-dot grip icon used as the drag handle on dashboard widget tiles.
function DragGripIcon() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" fill="none" aria-hidden="true">
      {[3, 7, 11].flatMap(y => [
        <circle key={`l${y}`} cx="2" cy={y} r="1.2" fill="currentColor" />,
        <circle key={`r${y}`} cx="8" cy={y} r="1.2" fill="currentColor" />,
      ])}
    </svg>
  )
}

// Per-cell metric picker on the KPI strip. single-select dropdown that
// reuses the search-and-section AxisPicker styling. Compact (icon-only
// trigger) so it doesn't crowd the KPI value.
function KpiCellPicker({ value, options, onChange }: {
  value: string
  options: MetricDef[]
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // Position the popover anchored to the trigger button. Recompute on
  // open, scroll, and resize so the popover stays glued to the gear
  // icon. Portaled to document.body so it escapes the dashboard grid's
  // stacking context (the bug was the ad-grid tiles painting OVER the
  // popover because the popover's z-50 only applied within a clipped
  // ancestor stack).
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const compute = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const WIDTH = 260
      const vw = window.innerWidth
      const vh = window.innerHeight
      let left = rect.right - WIDTH
      if (left < 12) left = Math.max(12, Math.min(rect.left, vw - WIDTH - 12))
      // Flip above when below would overflow the viewport. The
      // KpiCellPicker popover caps at max-h: 360, so use that for the
      // height estimate when the actual measurement isn't ready yet.
      const estHeight = popRef.current?.offsetHeight || 360
      const below = rect.bottom + 6
      const aboveTop = rect.top - estHeight - 6
      const overflowsBelow = below + estHeight + 12 > vh
      const top = overflowsBelow && aboveTop >= 12 ? aboveTop : Math.min(below, Math.max(12, vh - estHeight - 12))
      setPos({ top, left })
    }
    compute()
    const raf = requestAnimationFrame(compute)
    window.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', compute, true)
      window.removeEventListener('resize', compute)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (popRef.current && popRef.current.contains(e.target as Node)) return
      if (triggerRef.current && triggerRef.current.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  useEffect(() => { if (!open) setSearch('') }, [open])

  const grouped = useMemo<Partial<Record<MetricGroup, MetricDef[]>>>(() => {
    const q = search.toLowerCase()
    const out: Partial<Record<MetricGroup, MetricDef[]>> = {}
    const seen = new Set<string>()
    for (const m of options) {
      const k = String(m.key)
      if (seen.has(k)) continue
      seen.add(k)
      if (q && !m.label.toLowerCase().includes(q)) continue
      const g = (m.group || 'Performance') as MetricGroup
      ;(out[g] ||= []).push(m)
    }
    return out
  }, [options, search])

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen(v => !v)}
        className="h-5 w-5 rounded-full text-text-muted hover:text-text-primary flex items-center justify-center"
        title="Pick metric"
      >
        <Settings2 size={10} />
      </button>
      {open && pos && createPortal(
        <div
          ref={popRef}
          className="rounded-lg py-1 shadow-xl min-w-[240px] max-h-[360px] overflow-y-auto border border-black/[0.06]"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: 260,
            zIndex: 10100,
            background: 'rgba(255,255,255,0.97)',
            backdropFilter: 'blur(20px) saturate(180%)',
          }}
        >
          <div className="px-2 py-1.5 sticky top-0 bg-white/95 backdrop-blur-sm z-10">
            <input
              type="text"
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search metrics…"
              className="w-full bg-white/60 border border-black/[0.08] rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-[#B7410E]"
            />
          </div>
          {METRIC_GROUP_ORDER.map(g => {
            const rows = grouped[g] || []
            if (!rows.length) return null
            return (
              <div key={g} className="py-0.5">
                <div className="px-3 pt-2 pb-0.5 text-[9px] uppercase tracking-widest text-text-muted font-medium sticky top-[34px] bg-white/95 backdrop-blur-sm">
                  {g}
                </div>
                {rows.map(o => {
                  const isSelected = value === String(o.key)
                  return (
                    <button
                      key={String(o.key)}
                      onClick={() => { onChange(String(o.key)); setOpen(false) }}
                      title={o.description || ''}
                      className="w-full text-left px-3 py-1 text-xs hover:bg-black/[0.04] flex items-center gap-2"
                    >
                      <span
                        className="w-3 h-3 rounded-full border-[1.5px] flex-shrink-0 flex items-center justify-center"
                        style={{
                          borderColor: isSelected ? '#B7410E' : 'rgba(0,0,0,0.20)',
                          background: isSelected ? '#B7410E' : 'transparent',
                        }}
                      >
                        {isSelected && <span className="block w-1 h-1 rounded-full bg-white" />}
                      </span>
                      <span className={isSelected ? 'text-[#B7410E] font-medium' : 'text-text-secondary'}>
                        {o.label}
                      </span>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>,
        document.body,
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Custom widget builder (item #17). beyond the four canonical dashboard
// widgets the user can add an unlimited number of "custom" chart tiles
// (line / scatter / bar / pie / funnel / KPI scorecard). Each tile owns
// its type, source metric(s), optional group-by, and a title. State is
// persisted to the backend via /api/brand-profiles/{brand}/section/dashboard
// (with localStorage as a fast-path cache) so layouts survive across
// devices.
// ---------------------------------------------------------------------------

export type CustomWidgetType = 'line' | 'scatter' | 'bar' | 'funnel' | 'pie' | 'kpi'

// Tile width on the dashboard grid. Mapped to a 6-column responsive
// grid below so neighbors snap together cleanly:
//   third       = 2 cols  (3 per row)
//   half        = 3 cols  (2 per row)
//   two-thirds  = 4 cols  (one main tile + a third sidekick)
//   full        = 6 cols  (whole row)
export type WidgetSize = 'third' | 'half' | 'two-thirds' | 'full'

// Per-type default size. KPI scorecards want a small tile because
// they're a single number; line / bar / funnel benefit from width.
const DEFAULT_WIDGET_SIZE: Record<CustomWidgetType, WidgetSize> = {
  line:    'two-thirds',
  bar:     'half',
  scatter: 'half',
  pie:     'third',
  funnel:  'two-thirds',
  kpi:     'third',
}

const WIDGET_SIZE_CYCLE: WidgetSize[] = ['third', 'half', 'two-thirds', 'full']

// Tailwind col-span class per size. 6-col grid base.
const WIDGET_SIZE_CLASS: Record<WidgetSize, string> = {
  'third':      'md:col-span-2',
  'half':       'md:col-span-3',
  'two-thirds': 'md:col-span-4',
  'full':       'md:col-span-6',
}

const WIDGET_SIZE_GLYPH: Record<WidgetSize, string> = {
  'third':      '⅓',
  'half':       '½',
  'two-thirds': '⅔',
  'full':       '⛶',
}

const WIDGET_SIZE_LABEL: Record<WidgetSize, string> = {
  'third':      'Third',
  'half':       'Half',
  'two-thirds': 'Two-thirds',
  'full':       'Full',
}

export type CustomWidget = {
  id: string
  type: CustomWidgetType
  title: string
  metricX?: string         // primary metric (Y for line/bar/kpi/pie, X for scatter)
  metricY?: string         // scatter Y, or line right-axis metric
  metricZ?: string         // scatter Z (bubble size). uniform when blank
  groupBy?: GroupByKey     // dimension to bucket by (bar/pie/funnel ignore for now)
  color?: string           // accent color (defaults to brand orange)
  // Line chart overlays. moving-average windows to plot as dashed
  // lines on top of the primary series.
  smaWindows?: ('sma7' | 'sma14' | 'sma30' | 'sma90')[]
}

const CUSTOM_WIDGET_TYPES: { key: CustomWidgetType; label: string; hint: string; icon: any }[] = [
  { key: 'line',    label: 'Line chart',     hint: 'Metric over time (per day)', icon: LineIcon },
  { key: 'bar',     label: 'Bar chart',      hint: 'Metric grouped by a dimension', icon: BarChart3 },
  { key: 'scatter', label: 'Scatter / dot',  hint: 'Two metrics, one dot per ad', icon: ChartScatter },
  { key: 'pie',     label: 'Pie chart',      hint: 'Metric share by dimension', icon: PieChartIcon },
  { key: 'funnel',  label: 'Funnel',         hint: 'TOF / MOF / BOF lanes by frequency', icon: Workflow },
  { key: 'kpi',     label: 'KPI scorecard',  hint: 'Single big number for one metric', icon: Hash },
]

function defaultCustomWidget(type: CustomWidgetType): CustomWidget {
  const id = `cw_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`
  const base: CustomWidget = { id, type, title: '', color: '#B7410E' }
  if (type === 'line')    return { ...base, title: 'Spend over time',          metricX: 'spend' }
  if (type === 'bar')     return { ...base, title: 'Spend by campaign',        metricX: 'spend', groupBy: 'campaign_name' }
  if (type === 'scatter') return { ...base, title: 'ROAS vs Spend',            metricX: 'roas',  metricY: 'spend' }
  if (type === 'pie')     return { ...base, title: 'Spend share by asset',     metricX: 'spend', groupBy: 'asset_type' }
  if (type === 'funnel')  return { ...base, title: 'Funnel position',          metricX: 'spend' }
  return { ...base, title: 'Total spend', metricX: 'spend' }
}

// Numeric metric picker. compact, reusable. Mirrors KpiCellPicker but
// dropdown-trigger is a labeled button instead of an icon-only gear.
function MetricSelect({ value, options, onChange, placeholder }: {
  value: string | undefined
  options: MetricDef[]
  onChange: (v: string) => void
  placeholder?: string
}) {
  const current = value ? METRICS_BY_KEY[value] : undefined
  return (
    <select
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      className="bg-white/70 border border-black/[0.10] rounded-lg px-2 py-1 text-[11px] focus:outline-none focus:border-[#B7410E]"
    >
      <option value="" disabled>{placeholder || 'Pick metric…'}</option>
      {options.map(o => (
        <option key={String(o.key)} value={String(o.key)}>{o.label}</option>
      ))}
      {value && !current && (
        <option value={value}>{value}</option>
      )}
    </select>
  )
}

// "+ Add widget" button + portaled picker popover. Portals to body so
// the popover isn't trapped under the dashboard grid's stacking context.
function AddWidgetButton({
  open, onOpenChange, availableToAdd, addCustomWidget, addWidget,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  availableToAdd: { key: any; label: string; hint: string }[]
  addCustomWidget: (type: CustomWidgetType) => void
  addWidget: (key: any) => void
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const compute = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const WIDTH = 260
      const vw = window.innerWidth
      const vh = window.innerHeight
      let left = rect.right - WIDTH
      if (left < 12) left = Math.max(12, Math.min(rect.left, vw - WIDTH - 12))
      const estHeight = popRef.current?.offsetHeight || 320
      const below = rect.bottom + 6
      const aboveTop = rect.top - estHeight - 6
      const overflowsBelow = below + estHeight + 12 > vh
      const top = overflowsBelow && aboveTop >= 12 ? aboveTop : Math.min(below, Math.max(12, vh - estHeight - 12))
      setPos({ top, left })
    }
    compute()
    const raf = requestAnimationFrame(compute)
    window.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', compute, true)
      window.removeEventListener('resize', compute)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (popRef.current && popRef.current.contains(e.target as Node)) return
      if (triggerRef.current && triggerRef.current.contains(e.target as Node)) return
      onOpenChange(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open, onOpenChange])

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => onOpenChange(!open)}
        className={`h-7 px-2.5 rounded-full text-[11px] flex items-center gap-1.5 transition-colors ${
          open
            ? 'bg-[#B7410E]/10 border border-[#B7410E]/30 text-[#b55719]'
            : 'glass glass-hover text-text-secondary'
        }`}
        title="Add a chart, KPI, or funnel widget"
      >
        <Plus size={11} /> Add widget
      </button>
      {open && pos && createPortal(
        <div
          ref={popRef}
          className="rounded-lg shadow-xl border border-black/[0.08] py-1"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: 260,
            zIndex: 10100,
            background: 'rgba(255,255,255,0.97)',
            backdropFilter: 'blur(20px) saturate(180%)',
          }}
        >
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-widest text-text-muted font-medium">
            Custom widget
          </div>
          {CUSTOM_WIDGET_TYPES.map(t => {
            const Icon = t.icon
            return (
              <button
                key={t.key}
                onClick={() => addCustomWidget(t.key)}
                className="w-full flex items-center gap-2 text-left px-3 py-1.5 hover:bg-black/[0.04]"
              >
                <Icon size={12} style={{ color: '#B7410E' }} />
                <div className="flex flex-col">
                  <span className="text-[12px] font-medium text-text-primary">{t.label}</span>
                  <span className="text-[10px] text-text-muted">{t.hint}</span>
                </div>
              </button>
            )
          })}
          {availableToAdd.length > 0 && (
            <>
              <div className="px-3 py-1.5 mt-1 text-[10px] uppercase tracking-widest text-text-muted font-medium border-t border-black/[0.06]">
                Standard widget
              </div>
              {availableToAdd.map(w => (
                <button
                  key={w.key}
                  onClick={() => { addWidget(w.key); onOpenChange(false) }}
                  className="w-full flex items-center justify-between text-left px-3 py-1.5 hover:bg-black/[0.04]"
                >
                  <div className="flex flex-col">
                    <span className="text-[12px] font-medium text-text-primary">{w.label}</span>
                    <span className="text-[10px] text-text-muted">{w.hint}</span>
                  </div>
                  <Plus size={11} style={{ color: '#B7410E' }} />
                </button>
              ))}
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}

// Single custom-widget tile. Extracted so each tile owns its own ref
// for the settings gear icon. CustomWidgetSettings portals to body
// and needs to know where its trigger is in screen coordinates. Loops
// can't useRef per-iteration, so the extraction is the cleanest path.
function CustomWidgetTile({
  widget, editing, size, span, meta, Icon,
  isSettingsOpen,
  onToggleSize, onToggleSettings, onUpdate, onCloseSettings, onRemove,
  numericMetrics,
  children,
}: {
  widget: CustomWidget
  editing: boolean
  size: WidgetSize
  span: string
  meta: { key: CustomWidgetType; label: string; hint: string; icon: any } | undefined
  Icon: any
  isSettingsOpen: boolean
  onToggleSize: () => void
  onToggleSettings: () => void
  onUpdate: (next: CustomWidget) => void
  onCloseSettings: () => void
  onRemove: () => void
  numericMetrics: MetricDef[]
  children: React.ReactNode
}) {
  const settingsTriggerRef = useRef<HTMLButtonElement>(null)
  return (
    <div className={`atelier-tile relative flex flex-col gap-2 ${span}`}>
      {/* X (remove). same affordance + position as the standard
          widgets above. Only visible in edit mode. Pairs with the
          gear icon (which opens settings) inside the header row;
          users now consistently remove via the floating X and
          customize via the gear, across both widget kinds. */}
      {editing && (
        <div className="absolute -top-2 -right-2 z-20 flex items-center gap-1">
          <button
            onClick={onRemove}
            className="h-6 w-6 rounded-full bg-white border border-black/[0.10] shadow-sm flex items-center justify-center text-text-muted hover:text-red-600"
            title="Remove widget"
          >
            <XIcon size={11} />
          </button>
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon size={11} style={{ color: widget.color || '#B7410E' }} />
          <div className="text-[12px] font-medium text-text-primary truncate" title={widget.title}>
            {widget.title || meta?.label || 'Widget'}
          </div>
        </div>
        <div className="flex items-center gap-1 relative">
          {editing && (
            <button
              onClick={onToggleSize}
              title={`Size: ${WIDGET_SIZE_LABEL[size]}. click to cycle`}
              className="h-5 w-5 rounded-full text-text-muted hover:text-text-primary flex items-center justify-center text-[11px]"
            >
              {WIDGET_SIZE_GLYPH[size]}
            </button>
          )}
          <button
            ref={settingsTriggerRef}
            onClick={onToggleSettings}
            className={`h-5 w-5 rounded-full flex items-center justify-center ${
              isSettingsOpen ? 'text-[#B7410E]' : 'text-text-muted hover:text-text-primary'
            }`}
            title="Widget settings"
          >
            <Settings2 size={10} />
          </button>
          {isSettingsOpen && (
            <CustomWidgetSettings
              widget={widget}
              onUpdate={onUpdate}
              onClose={onCloseSettings}
              onRemove={onRemove}
              allMetrics={numericMetrics}
              groupByOptions={GROUP_BY_FIELDS as any}
              anchorRef={settingsTriggerRef}
            />
          )}
        </div>
      </div>
      {children}
    </div>
  )
}

// Per-widget configuration popover. Triggered by the gear icon in the
// widget header while editing. Form fields are conditional on widget
// type. scatter has X+Y, bar/pie have metric+group-by, etc.
function CustomWidgetSettings({ widget, onUpdate, onClose, onRemove, allMetrics, groupByOptions, anchorRef }: {
  widget: CustomWidget
  onUpdate: (next: CustomWidget) => void
  onClose: () => void
  onRemove: () => void
  allMetrics: MetricDef[]
  groupByOptions: { key: GroupByKey; label: string }[]
  /** Trigger element this popover is anchored to. We portal the popover
   *  to body to escape the dashboard grid's stacking context (ad-card
   *  tiles paint OVER non-portaled popovers); position is computed from
   *  this ref's getBoundingClientRect. */
  anchorRef?: React.RefObject<HTMLElement | null>
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    const compute = () => {
      const rect = anchorRef?.current?.getBoundingClientRect()
      if (!rect) return
      const WIDTH = 300
      const vw = window.innerWidth
      const vh = window.innerHeight
      let left = rect.right - WIDTH
      if (left < 12) left = Math.max(12, Math.min(rect.left, vw - WIDTH - 12))
      // Vertical: prefer below the trigger, but flip above when the
      // popover would overflow the viewport bottom. Measure the actual
      // popover height (the settings panel grows depending on widget
      // type, so a static estimate misses). When ref isn't measured
      // yet, fall back to 360 (covers the largest scatter+Y+Z+color
      // form factor).
      const estHeight = ref.current?.offsetHeight || 360
      const below = rect.bottom + 6
      const aboveTop = rect.top - estHeight - 6
      const overflowsBelow = below + estHeight + 12 > vh
      const top = overflowsBelow && aboveTop >= 12 ? aboveTop : Math.min(below, Math.max(12, vh - estHeight - 12))
      setPos({ top, left })
    }
    compute()
    // Recompute again on the next frame so estHeight reflects the
    // actual popover height once it's mounted.
    const raf = requestAnimationFrame(compute)
    window.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', compute, true)
      window.removeEventListener('resize', compute)
    }
  }, [anchorRef])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && ref.current.contains(e.target as Node)) return
      if (anchorRef?.current && anchorRef.current.contains(e.target as Node)) return
      onClose()
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [onClose, anchorRef])
  const set = <K extends keyof CustomWidget>(k: K, v: CustomWidget[K]) => onUpdate({ ...widget, [k]: v })
  const t = widget.type

  if (!pos) return null
  return createPortal(
    <div
      ref={ref}
      className="rounded-lg shadow-xl border border-black/[0.08] p-3"
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        width: 300,
        zIndex: 10100,
        background: 'rgba(255,255,255,0.97)',
        backdropFilter: 'blur(20px) saturate(180%)',
      }}
    >
      <div className="flex flex-col gap-2">
        <div className="text-[10px] uppercase tracking-widest text-text-muted font-medium">
          {CUSTOM_WIDGET_TYPES.find(c => c.key === t)?.label || 'Widget'} · settings
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-text-muted">Title</span>
          <input
            type="text"
            value={widget.title}
            onChange={e => set('title', e.target.value)}
            className="bg-white/70 border border-black/[0.10] rounded-lg px-2 py-1 text-[12px] focus:outline-none focus:border-[#B7410E]"
          />
        </label>
        {(t === 'line' || t === 'bar' || t === 'pie' || t === 'kpi' || t === 'funnel') && (
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-text-muted">{t === 'line' ? 'Y metric' : 'Metric'}</span>
            <MetricSelect value={widget.metricX} options={allMetrics} onChange={v => set('metricX', v)} />
          </label>
        )}
        {t === 'line' && (
          <>
            {/* Right Y axis. optional secondary metric. Mirrors the
                full-page LineChartView's Right Y picker so the widget
                has feature parity with the view it represents. */}
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-text-muted">Right Y (optional)</span>
              <MetricSelect
                value={widget.metricY || ''}
                options={allMetrics}
                onChange={v => set('metricY', v || undefined)}
                placeholder="None. single axis"
              />
            </label>
            {/* Moving-average windows. multi-select, dashed overlay
                lines. Same 7d/14d/30d/90d set as the full view. */}
            <div className="flex flex-col gap-1">
              <span className="text-[10px] text-text-muted">Moving averages</span>
              <div className="flex flex-wrap gap-1.5">
                {(['sma7', 'sma14', 'sma30', 'sma90'] as const).map(w => {
                  const on = (widget.smaWindows || []).includes(w)
                  return (
                    <button
                      key={w}
                      onClick={() => {
                        const cur = widget.smaWindows || []
                        const next = on ? cur.filter(x => x !== w) : [...cur, w]
                        set('smaWindows', next.length ? next : undefined)
                      }}
                      className={`h-6 px-2 rounded-full text-[10px] inline-flex items-center gap-1 border transition-colors ${
                        on
                          ? 'border-[#B7410E]/30 bg-[#B7410E]/10 text-[#b55719]'
                          : 'border-black/[0.08] bg-white/60 text-text-secondary hover:bg-white/90'
                      }`}
                    >
                      {w.slice(3)}d
                    </button>
                  )
                })}
              </div>
            </div>
          </>
        )}
        {t === 'scatter' && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-text-muted">X metric</span>
              <MetricSelect value={widget.metricX} options={allMetrics} onChange={v => set('metricX', v)} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-text-muted">Y metric</span>
              <MetricSelect value={widget.metricY} options={allMetrics} onChange={v => set('metricY', v)} />
            </label>
            {/* Z / bubble-size metric. parity with the dot-plot view. */}
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-text-muted">Size (optional)</span>
              <MetricSelect
                value={widget.metricZ || ''}
                options={allMetrics}
                onChange={v => set('metricZ', v || undefined)}
                placeholder="Uniform dots"
              />
            </label>
          </>
        )}
        {(t === 'bar' || t === 'pie') && (
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-text-muted">Group by</span>
            <select
              value={widget.groupBy || 'campaign_name'}
              onChange={e => set('groupBy', e.target.value as GroupByKey)}
              className="bg-white/70 border border-black/[0.10] rounded-lg px-2 py-1 text-[11px] focus:outline-none focus:border-[#B7410E]"
            >
              {groupByOptions.filter(g => g.key !== 'none').map(g => (
                <option key={String(g.key)} value={String(g.key)}>{g.label}</option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-text-muted">Color</span>
          <div className="flex flex-wrap gap-1">
            {COLORS.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => set('color', c)}
                className="h-5 w-5 rounded-full border-2"
                style={{
                  background: c,
                  borderColor: widget.color === c ? '#111' : 'rgba(0,0,0,0.10)',
                }}
                title={c}
              />
            ))}
          </div>
        </label>
        <div className="flex items-center justify-end pt-1">
          {/* "Remove widget" lives on the tile now. the floating X
              top-right matches the standard widgets. Gear is for
              settings only. */}
          <button onClick={onClose} className="text-[11px] text-text-secondary hover:text-text-primary">Done</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// Render a custom widget's chart body. Falls back to a placeholder when
// the metric / group-by config is incomplete or there's no data.
function CustomWidgetBody({ widget, ads, chartAds, brand, onOpen }: {
  widget: CustomWidget
  ads: AdCreative[]
  chartAds: AdCreative[]
  brand: string
  onOpen: (id: string) => void
}) {
  const color = widget.color || '#B7410E'
  const t = widget.type
  const xDef = widget.metricX ? METRICS_BY_KEY[widget.metricX] : null
  const yDef = widget.metricY ? METRICS_BY_KEY[widget.metricY] : null

  if (t === 'kpi') {
    if (!xDef) return <CustomWidgetEmpty msg="Pick a metric in settings." />
    let sum = 0, n = 0
    for (const a of chartAds) {
      const v = (a as any)[widget.metricX!]
      if (v == null || !Number.isFinite(Number(v))) continue
      sum += Number(v); n += 1
    }
    const isRatio = xDef.format === 'percent' || xDef.format === 'decimal'
    const value = !n ? 0 : isRatio ? sum / n : sum
    return (
      <div className="flex items-baseline justify-between">
        <div className="font-display text-3xl font-medium tabular-nums atelier-kpi-number" style={{ color }}>
          {fmtMetric(value, xDef)}
        </div>
        <div className="text-[10px] text-text-muted">
          {n} ad{n === 1 ? '' : 's'}
        </div>
      </div>
    )
  }

  if (t === 'line') {
    if (!xDef) return <CustomWidgetEmpty msg="Pick a Y metric in settings." />
    // Aggregate daily values across the visible ads for the primary Y
    // metric and, if set, the right-axis metric. Each row carries a
    // `daily` series of {date, <metric>...}.
    type Row = { date: string; y: number; ry?: number }
    const byDate = new Map<string, Row>()
    for (const a of chartAds) {
      const series = (a as any).daily as { date: string; [k: string]: any }[] | undefined
      if (!Array.isArray(series)) continue
      for (const row of series) {
        const cell = byDate.get(row.date) || { date: row.date, y: 0, ry: yDef ? 0 : undefined }
        cell.y += Number(row[widget.metricX!] || 0)
        if (yDef) cell.ry = (cell.ry || 0) + Number(row[widget.metricY!] || 0)
        byDate.set(row.date, cell)
      }
    }
    const data: Row[] = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date))
    // Synthetic fallback when no daily array exists. one point per ad.
    if (!data.length) {
      chartAds.slice(0, 30).forEach((a, i) => {
        data.push({
          date: a.ad_name?.slice(0, 12) || `#${i + 1}`,
          y: Number((a as any)[widget.metricX!] || 0),
          ry: yDef ? Number((a as any)[widget.metricY!] || 0) : undefined,
        })
      })
    }
    // Moving-average overlays. same compute as the full LineChartView.
    // Partial average for early days so the line doesn't chop short
    // when the visible window is shorter than the MA period.
    const smaWindows = widget.smaWindows || []
    const dataWithMa: any[] = data.map(r => ({ ...r }))
    for (const sma of smaWindows) {
      const W = parseInt(sma.slice(3), 10)
      const win: number[] = []
      for (let i = 0; i < dataWithMa.length; i++) {
        win.push(Number(dataWithMa[i].y ?? 0))
        if (win.length > W) win.shift()
        dataWithMa[i][`y:${sma}`] = win.reduce((a, b) => a + b, 0) / win.length
      }
      if (yDef) {
        const win2: number[] = []
        for (let i = 0; i < dataWithMa.length; i++) {
          win2.push(Number(dataWithMa[i].ry ?? 0))
          if (win2.length > W) win2.shift()
          dataWithMa[i][`ry:${sma}`] = win2.reduce((a, b) => a + b, 0) / win2.length
        }
      }
    }
    const hasRight = !!yDef
    return (
      <div style={{ height: 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={dataWithMa} margin={{ top: 5, right: hasRight ? 40 : 10, left: 0, bottom: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
            <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#6b7280' }} angle={-20} textAnchor="end" height={40} />
            <YAxis yAxisId="left" tick={{ fontSize: 9, fill: '#6b7280' }} />
            {hasRight && (
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 9, fill: '#6b7280' }} />
            )}
            <Tooltip
              formatter={(v: any, name: any) => {
                if (name === xDef.label) return [fmtMetric(Number(v), xDef), xDef.label]
                if (yDef && name === yDef.label) return [fmtMetric(Number(v), yDef), yDef.label]
                return [Number(v).toLocaleString(), name]
              }}
              contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid rgba(0,0,0,0.08)' }}
            />
            <Line type="monotone" dataKey="y" yAxisId="left" stroke={color} strokeWidth={2} dot={false} name={xDef.label} />
            {hasRight && (
              <Line type="monotone" dataKey="ry" yAxisId="right" stroke="#475569" strokeWidth={2} dot={false} name={yDef!.label} />
            )}
            {smaWindows.map(sma => (
              <React.Fragment key={sma}>
                <Line
                  type="monotone"
                  dataKey={`y:${sma}`}
                  yAxisId="left"
                  stroke={SMA_COLORS[sma]}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  strokeOpacity={0.85}
                  dot={false}
                  legendType="none"
                  name={`${sma.slice(3)}d MA`}
                />
                {hasRight && (
                  <Line
                    type="monotone"
                    dataKey={`ry:${sma}`}
                    yAxisId="right"
                    stroke={SMA_COLORS[sma]}
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    strokeOpacity={0.55}
                    dot={false}
                    legendType="none"
                    name={`${sma.slice(3)}d MA (right)`}
                  />
                )}
              </React.Fragment>
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    )
  }

  if (t === 'scatter') {
    if (!xDef || !yDef) return <CustomWidgetEmpty msg="Pick X and Y metrics in settings." />
    const zDef = widget.metricZ ? METRICS_BY_KEY[widget.metricZ] : null
    const data = chartAds.map(a => ({
      ad_id: a.ad_id,
      ad_name: a.ad_name || a.ad_id,
      x: Number((a as any)[widget.metricX!] || 0),
      y: Number((a as any)[widget.metricY!] || 0),
      z: zDef ? Math.max(0, Number((a as any)[widget.metricZ!] || 0)) : 1,
    })).filter(d => Number.isFinite(d.x) && Number.isFinite(d.y))
    return (
      <div style={{ height: 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 5, right: 10, left: 0, bottom: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
            <XAxis type="number" dataKey="x" name={xDef.label} tick={{ fontSize: 9, fill: '#6b7280' }} />
            <YAxis type="number" dataKey="y" name={yDef.label} tick={{ fontSize: 9, fill: '#6b7280' }} />
            {zDef && <ZAxis type="number" dataKey="z" name={zDef.label} range={[20, 220]} />}
            <Tooltip
              cursor={{ strokeDasharray: '3 3' }}
              formatter={(v: any, name: any) => {
                if (name === xDef.label) return [fmtMetric(Number(v), xDef), xDef.label]
                if (name === yDef.label) return [fmtMetric(Number(v), yDef), yDef.label]
                if (zDef && name === zDef.label) return [fmtMetric(Number(v), zDef), zDef.label]
                return [v, name]
              }}
              contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid rgba(0,0,0,0.08)' }}
            />
            <Scatter
              data={data}
              fill={color}
              onClick={(_e: any, _i: number, payload: any) => {
                const id = payload?.payload?.ad_id
                if (id) onOpen(id)
              }}
            />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    )
  }

  if (t === 'bar' || t === 'pie') {
    if (!xDef) return <CustomWidgetEmpty msg="Pick a metric in settings." />
    const group = widget.groupBy || 'campaign_name'
    const rows = groupAds(chartAds, group as GroupByKey)
    const data = rows.map(r => ({
      name: r.group_value.length > 20 ? r.group_value.slice(0, 18) + '…' : r.group_value,
      value: Number((r as any)[widget.metricX!] || 0),
    })).sort((a, b) => b.value - a.value).slice(0, 12)
    if (!data.length) return <CustomWidgetEmpty msg={`No ${group} groups in the current filter.`} />
    if (t === 'bar') {
      return (
        <div style={{ height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 40 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
              <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#6b7280' }} angle={-25} textAnchor="end" interval={0} height={60} />
              <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} />
              <Tooltip
                formatter={(v: any) => [fmtMetric(Number(v), xDef), xDef.label]}
                contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid rgba(0,0,0,0.08)' }}
              />
              <Bar dataKey="value" fill={color} name={xDef.label} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )
    }
    // Pie
    return (
      <div style={{ height: 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} labelLine={false}>
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              formatter={(v: any, name: any) => [fmtMetric(Number(v), xDef), name]}
              contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid rgba(0,0,0,0.08)' }}
            />
            <Legend wrapperStyle={{ fontSize: 10 }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    )
  }

  if (t === 'funnel') {
    // Funnel widget. Lens currently ships a stubbed FunnelView (item
    // #5 in the strip-down). Render it inline so the user gets the
    // full TOF/MOF/BOF lanes if FunnelView is real; otherwise the
    // FunnelView placeholder renders its own "not yet" message.
    return (
      <div className="atelier-tile p-0 overflow-hidden" style={{ minHeight: 220 }}>
        <FunnelView ads={chartAds} brand={brand} onOpen={onOpen} />
      </div>
    )
  }

  return <CustomWidgetEmpty msg="Unknown widget type." />
}

function CustomWidgetEmpty({ msg }: { msg: string }) {
  return (
    <div className="glass rounded-lg p-6 text-center text-[11px] text-text-muted">
      {msg}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Backend persistence helper for the dashboard section. Best-effort -
// every failure is swallowed silently so a flaky network doesn't break
// the dashboard. localStorage stays the canonical cache.
// ---------------------------------------------------------------------------

type DashboardSectionPayload = {
  widgetOrder?: DashboardWidget[]
  kpiKeys?: string[]
  customWidgets?: CustomWidget[]
  velocityThresholds?: VelocityThresholds
}

async function fetchDashboardSection(brand: string): Promise<DashboardSectionPayload | null> {
  if (!brand) return null
  try {
    const r = await fetch(`/api/brand-profiles/${encodeURIComponent(brand)}/section/dashboard`, {
      credentials: 'include',
    })
    if (!r.ok) return null
    const json = await r.json()
    const data = json?.data
    return (data && typeof data === 'object') ? data as DashboardSectionPayload : null
  } catch { return null }
}

async function postDashboardSection(brand: string, data: DashboardSectionPayload): Promise<void> {
  if (!brand) return
  try {
    await fetch(`/api/brand-profiles/${encodeURIComponent(brand)}/section/dashboard`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  } catch {}
}

function beaconDashboardSection(brand: string, data: DashboardSectionPayload): void {
  if (!brand) return
  try {
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
    // sendBeacon survives page unload where fetch would be killed mid-flight.
    navigator.sendBeacon?.(
      `/api/brand-profiles/${encodeURIComponent(brand)}/section/dashboard`,
      blob,
    )
  } catch {}
}

function CustomDashboardView({ ads, chartAds, metricDefs, brand, onOpen, velocityFilter, onToggleVelocity, velocityThresholds, onChangeVelocityThresholds }: {
  ads: AdCreative[]
  chartAds: AdCreative[]
  metricDefs: MetricDef[]
  brand: string
  onOpen: (id: string) => void
  velocityFilter: Set<VelocityBucketLabel>
  onToggleVelocity: (label: VelocityBucketLabel) => void
  velocityThresholds: VelocityThresholds
  onChangeVelocityThresholds: (next: VelocityThresholds) => void
}) {
  // Ordered list of widgets. supports drag-reorder. Layout persists per-
  // user via localStorage AND server-side (via dashboard auto-save).
  // ALL_WIDGETS gives us the available type set; the user's order in
  // `widgetOrder` controls render sequence.
  const [widgetOrder, setWidgetOrder] = useState<DashboardWidget[]>(() => {
    try {
      const raw = localStorage.getItem('ac.dashboard.order')
      if (raw) {
        const parsed = JSON.parse(raw) as DashboardWidget[]
        if (Array.isArray(parsed)) return parsed
      }
    } catch {}
    return [...DEFAULT_DASH_WIDGETS]
  })
  // KPI-strip per-cell metric assignment. Falls back to defaults if the
  // saved value is missing/corrupt.
  const [kpiKeys, setKpiKeys] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('ac.dashboard.kpis')
      if (raw) {
        const parsed = JSON.parse(raw) as string[]
        if (Array.isArray(parsed) && parsed.length === 6) return parsed
      }
    } catch {}
    return DEFAULT_KPI_KEYS
  })
  // User-added custom widgets (line / scatter / bar / pie / funnel / kpi).
  // The four canonical widgets stay in widgetOrder; everything new lives
  // here so a v1 user with the old layout still gets their tiles back.
  const [customWidgets, setCustomWidgets] = useState<CustomWidget[]>(() => {
    try {
      const raw = localStorage.getItem(`ac.dashboard.custom.${brand}`)
      if (raw) {
        const parsed = JSON.parse(raw) as CustomWidget[]
        if (Array.isArray(parsed)) return parsed
      }
    } catch {}
    return []
  })
  // Widget sizing. four steps, mapped onto a 6-column grid so they fit
  // cleanly side-by-side:
  //   third       = 2/6  (3 tiles per row)
  //   half        = 3/6  (2 per row)
  //   two-thirds  = 4/6  (one tile + a third)
  //   full        = 6/6  (full row)
  // Default per-type lives in DEFAULT_WIDGET_SIZE. line / bar / funnel
  // benefit from more width, KPI scorecards want less. The cycle
  // toggle walks through all four in order.
  const [customSizes, setCustomSizes] = useState<Record<string, WidgetSize>>(() => {
    try {
      const raw = localStorage.getItem(`ac.dashboard.custom.sizes.${brand}`)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') {
          // Migrate v1 'half'|'full' values. anything else falls through.
          const out: Record<string, WidgetSize> = {}
          for (const [k, v] of Object.entries(parsed)) {
            if (v === 'half' || v === 'full' || v === 'third' || v === 'two-thirds') {
              out[k] = v as WidgetSize
            }
          }
          return out
        }
      }
    } catch {}
    return {}
  })
  const [editing, setEditing] = useState(false)
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null)
  const [dropTargetIdx, setDropTargetIdx] = useState<number | null>(null)
  const [widgetPickerOpen, setWidgetPickerOpen] = useState(false)
  const [openSettingsFor, setOpenSettingsFor] = useState<string | null>(null)

  useEffect(() => {
    try { localStorage.setItem('ac.dashboard.order', JSON.stringify(widgetOrder)) } catch {}
  }, [widgetOrder])
  useEffect(() => {
    try { localStorage.setItem('ac.dashboard.kpis', JSON.stringify(kpiKeys)) } catch {}
  }, [kpiKeys])
  useEffect(() => {
    try { localStorage.setItem(`ac.dashboard.custom.${brand}`, JSON.stringify(customWidgets)) } catch {}
  }, [customWidgets, brand])
  useEffect(() => {
    try { localStorage.setItem(`ac.dashboard.custom.sizes.${brand}`, JSON.stringify(customSizes)) } catch {}
  }, [customSizes, brand])

  // -------------------------------------------------------------------
  // Backend hydration + auto-save (item #18).
  //
  // On mount (and whenever brand changes), fetch the saved dashboard
  // section and overwrite local state if it has data. After hydration,
  // every subsequent state change kicks a 500ms debounced POST. A
  // sendBeacon goes out on beforeunload so closing the tab doesn't
  // discard in-flight changes.
  // -------------------------------------------------------------------
  const hydratedRef = useRef(false)
  const saveTimerRef = useRef<number | null>(null)
  useEffect(() => {
    hydratedRef.current = false
    let cancelled = false
    fetchDashboardSection(brand).then(data => {
      if (cancelled || !data) {
        hydratedRef.current = true
        return
      }
      if (Array.isArray(data.widgetOrder)) setWidgetOrder(data.widgetOrder)
      if (Array.isArray(data.kpiKeys) && data.kpiKeys.length === 6) setKpiKeys(data.kpiKeys)
      if (Array.isArray(data.customWidgets)) setCustomWidgets(data.customWidgets)
      if (data.velocityThresholds && typeof data.velocityThresholds === 'object') {
        // Don't overwrite if the parent already loaded a different config
        // from localStorage. just sync the saved server values forward.
        onChangeVelocityThresholds({ ...DEFAULT_THRESHOLDS, ...data.velocityThresholds })
      }
      hydratedRef.current = true
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand])

  useEffect(() => {
    if (!hydratedRef.current || !brand) return
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    const payload: DashboardSectionPayload = {
      widgetOrder, kpiKeys, customWidgets, velocityThresholds,
    }
    saveTimerRef.current = window.setTimeout(() => {
      postDashboardSection(brand, payload)
    }, 500)
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    }
  }, [widgetOrder, kpiKeys, customWidgets, velocityThresholds, brand])

  // Flush in-flight changes on unload via sendBeacon (regular fetch
  // gets killed by the browser when the page is closing).
  useEffect(() => {
    const onBeforeUnload = () => {
      if (!hydratedRef.current || !brand) return
      beaconDashboardSection(brand, {
        widgetOrder, kpiKeys, customWidgets, velocityThresholds,
      })
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [widgetOrder, kpiKeys, customWidgets, velocityThresholds, brand])

  const removeWidget = (k: DashboardWidget) => {
    setWidgetOrder(prev => prev.filter(w => w !== k))
  }
  const addWidget = (k: DashboardWidget) => {
    setWidgetOrder(prev => prev.includes(k) ? prev : [...prev, k])
  }
  const moveWidget = (from: number, to: number) => {
    setWidgetOrder(prev => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev
      const next = [...prev]
      const [removed] = next.splice(from, 1)
      next.splice(to, 0, removed)
      return next
    })
  }
  const updateKpiKey = (idx: number, newKey: string) => {
    setKpiKeys(prev => prev.map((k, i) => i === idx ? newKey : k))
  }
  const enabled = new Set(widgetOrder)
  const availableToAdd = ALL_WIDGETS.filter(w => !enabled.has(w.key))

  // Custom widget operations.
  const addCustomWidget = (t: CustomWidgetType) => {
    const w = defaultCustomWidget(t)
    setCustomWidgets(prev => [...prev, w])
    setWidgetPickerOpen(false)
    // Open the settings popover immediately so the user can rename /
    // pick metrics without an extra click. they just hit "Add Bar
    // chart" intending to configure it anyway.
    setOpenSettingsFor(w.id)
    if (!editing) setEditing(true)
  }
  const updateCustomWidget = (id: string, next: CustomWidget) => {
    setCustomWidgets(prev => prev.map(w => w.id === id ? next : w))
  }
  const removeCustomWidget = (id: string) => {
    setCustomWidgets(prev => prev.filter(w => w.id !== id))
    setCustomSizes(prev => { const { [id]: _omit, ...rest } = prev; return rest })
    if (openSettingsFor === id) setOpenSettingsFor(null)
  }
  // Cycle width through the four-step list (third → half → two-thirds
  // → full → third → …). Falls back to the type's default when the
  // current size isn't in the cycle (defensive against migration).
  const toggleCustomSize = (id: string) => {
    setCustomSizes(prev => {
      const widget = customWidgets.find(w => w.id === id)
      const current = prev[id] || (widget ? DEFAULT_WIDGET_SIZE[widget.type] : 'half')
      const idx = WIDGET_SIZE_CYCLE.indexOf(current)
      const next = WIDGET_SIZE_CYCLE[(idx + 1) % WIDGET_SIZE_CYCLE.length]
      return { ...prev, [id]: next }
    })
  }

  // Numeric metric universe for the custom-widget picker. drop text /
  // analysis-string metrics since they don't aggregate.
  const numericMetrics = useMemo(
    () => ALL_METRICS.filter(m => m.format !== 'text' && !m.analysisField),
    [],
  )

  // Aggregates for the KPI strip. sum across the visible (filtered) ads
  // so toggling a dim filter changes what the dashboard reflects too.
  const kpis = useMemo(() => {
    let spend = 0, revenue = 0, purchases = 0, impressions = 0, clicks = 0
    for (const a of chartAds) {
      spend += Number(a.spend || 0)
      revenue += Number(a.revenue || 0)
      purchases += Number(a.purchases || 0)
      impressions += Number(a.impressions || 0)
      clicks += Number(a.clicks || 0)
    }
    return {
      spend, revenue, purchases,
      roas: spend > 0 ? revenue / spend : 0,
      ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
      cpa: purchases > 0 ? spend / purchases : 0,
    }
  }, [chartAds])

  // Per-cell aggregate for arbitrary metrics. rebuilds when chartAds
  // changes. Used by the KPI strip when the user picks any metric beyond
  // the canonical six. For sums we sum; for ratios we recompute from
  // sums so weighted averages are correct.
  const kpiValueFor = (key: string): { value: number; def: MetricDef } => {
    const def = METRICS_BY_KEY[key] || METRICS_BY_KEY['spend']
    if (key in kpis) {
      return { value: (kpis as any)[key], def }
    }
    // Sum the value across chartAds for an unknown metric. Most ratio
    // metrics still produce a meaningful average for a "current page"
    // KPI strip, so fall back to mean(non-null) for percent/decimal.
    let sum = 0, n = 0, hasAny = false
    for (const a of chartAds) {
      const v = (a as any)[key]
      if (v == null || !Number.isFinite(Number(v))) continue
      sum += Number(v)
      n += 1
      hasAny = true
    }
    if (!hasAny) return { value: 0, def }
    if (def.format === 'percent' || def.format === 'decimal') {
      return { value: sum / n, def }
    }
    return { value: sum, def }
  }

  const top6 = useMemo(() => {
    return [...chartAds]
      .filter(a => Number(a.spend || 0) >= 50)
      .sort((a, b) => Number(b.roas || 0) - Number(a.roas || 0))
      .slice(0, 6)
  }, [chartAds])

  // Render a single widget body keyed by type. Centralized so the
  // drag-reorder loop stays simple and so adding a new widget type
  // only touches one switch.
  const renderWidget = (key: DashboardWidget) => {
    if (key === 'velocity') return (
      <VelocityScorecards
        ads={ads}
        brand={brand}
        selected={velocityFilter}
        onToggle={onToggleVelocity}
        thresholds={velocityThresholds}
        onChangeThresholds={onChangeVelocityThresholds}
      />
    )
    if (key === 'kpi_strip') {
      // Numeric metrics are user-pickable per cell (defined outside the
      // render switch to avoid recreating on every render).
      return (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
          {kpiKeys.map((k, i) => {
            const { value, def } = kpiValueFor(k)
            return (
              <div key={i} className="atelier-tile relative">
                <div className="flex items-center justify-between gap-1">
                  <div className="text-[10px] uppercase tracking-widest text-text-muted font-medium truncate">
                    {def.label}
                  </div>
                  {editing && (
                    <KpiCellPicker
                      value={k}
                      options={numericMetrics}
                      onChange={(v) => updateKpiKey(i, v)}
                    />
                  )}
                </div>
                <div className="font-display text-xl font-medium tabular-nums mt-0.5">
                  {fmtMetric(value, def)}
                </div>
              </div>
            )
          })}
        </div>
      )
    }
    if (key === 'top_grid') {
      // User feedback: dashboard top-performers used to render a bespoke
      // tile (aspect-square + 3 horizontal metric rows) that looked
      // nothing like the Mosaic/Creative-grid card. They wanted these to
      // be "literally the same thing." We now reuse the exact AdCard
      // component the mosaic view uses — same 4:5 image area, same
      // status dot, same compact metric grid, same hover lift. The only
      // difference is the checkbox is a no-op here (dashboard doesn't
      // build chart selections).
      const tileMetrics = metricDefs.filter(m => m.format !== 'text' && !m.analysisField)
      const tileMetricSet: MetricDef[] = tileMetrics.length
        ? tileMetrics
        : (DEFAULT_CARD_METRIC_KEYS.map(k => METRICS_BY_KEY[k]).filter(Boolean) as MetricDef[])
      return (
        <div>
          <div className="text-[10px] uppercase tracking-widest text-text-muted font-medium mb-2">
            Top performers (by ROAS, ≥$50 spend)
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
            {top6.map(a => (
              <AdCard
                key={a.ad_id}
                ad={a}
                isChecked={false}
                onToggle={() => { /* dashboard tiles don't drive chart selection */ }}
                onClick={() => onOpen(a.ad_id)}
                metricCount={6}
                metricDefs={tileMetricSet}
                brand={brand}
              />
            ))}
            {top6.length === 0 && (
              <div className="col-span-full text-[11px] text-text-muted text-center py-6">
                Need at least one ad with ≥$50 spend to populate.
              </div>
            )}
          </div>
        </div>
      )
    }
    if (key === 'top_table') {
      return (
        <div>
          <div className="text-[10px] uppercase tracking-widest text-text-muted font-medium mb-2">
            Top 10 by spend
          </div>
          <div className="atelier-tile p-0 overflow-hidden">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-black/[0.06]">
                  <th className="text-left px-3 py-2 text-[10px] uppercase tracking-widest text-text-muted font-medium">Ad</th>
                  {metricDefs.slice(0, 4).map(m => (
                    <th key={String(m.key)} className="text-right px-3 py-2 text-[10px] uppercase tracking-widest text-text-muted font-medium">
                      {m.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...chartAds].sort((a, b) => Number(b.spend || 0) - Number(a.spend || 0)).slice(0, 10).map(a => (
                  <tr key={a.ad_id} onClick={() => onOpen(a.ad_id)} className="border-b border-black/[0.03] hover:bg-white/40 cursor-pointer">
                    <td className="px-3 py-1.5 truncate max-w-[280px]" title={a.ad_name || a.ad_id}>
                      {a.ad_name || a.ad_id}
                    </td>
                    {metricDefs.slice(0, 4).map(m => {
                      const raw = (a as any)[m.key]
                      const prev = (a as any)[`prev_${m.key}`]
                      return (
                        <td key={String(m.key)} className="text-right px-3 py-1.5 tabular-nums text-text-secondary">
                          {fmtMetric(raw, m)}
                          <DeltaChip current={Number(raw)} prev={prev} metricKey={String(m.key)} />
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )
    }
    return null
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Edit toolbar */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-[10px] uppercase tracking-widest text-text-muted font-medium">
          Dashboard · {widgetOrder.length + customWidgets.length} widget{(widgetOrder.length + customWidgets.length) === 1 ? '' : 's'}
          {editing && <span className="text-[#b55719] ml-2 normal-case tracking-normal">drag the ⋮⋮ handle to reorder</span>}
        </div>
        <div className="flex items-center gap-1 relative">
          <AddWidgetButton
            open={widgetPickerOpen}
            onOpenChange={setWidgetPickerOpen}
            availableToAdd={availableToAdd}
            addCustomWidget={addCustomWidget}
            addWidget={addWidget}
          />
          <button
            onClick={() => setEditing(v => !v)}
            className={`h-7 px-2.5 rounded-full text-[11px] flex items-center gap-1.5 transition-colors ${
              editing
                ? 'bg-[#B7410E]/10 border border-[#B7410E]/30 text-[#b55719]'
                : 'glass glass-hover text-text-secondary'
            }`}
          >
            <Settings2 size={11} /> {editing ? 'Done' : 'Edit'}
          </button>
        </div>
      </div>

      {/* Widget list. drag handles + remove button only visible while editing. */}
      {widgetOrder.map((key, idx) => {
        const meta = ALL_WIDGETS.find(w => w.key === key)
        if (!meta) return null
        const isDragging = draggedIdx === idx
        const isDropTarget = dropTargetIdx === idx && draggedIdx !== null && draggedIdx !== idx
        return (
          <div
            key={key}
            draggable={editing}
            onDragStart={(e) => {
              if (!editing) return
              setDraggedIdx(idx)
              e.dataTransfer.effectAllowed = 'move'
              try { e.dataTransfer.setData('text/plain', key) } catch {}
            }}
            onDragOver={(e) => {
              if (!editing || draggedIdx === null) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (dropTargetIdx !== idx) setDropTargetIdx(idx)
            }}
            onDragLeave={() => {
              if (dropTargetIdx === idx) setDropTargetIdx(null)
            }}
            onDrop={(e) => {
              if (!editing || draggedIdx === null) return
              e.preventDefault()
              moveWidget(draggedIdx, idx)
              setDraggedIdx(null)
              setDropTargetIdx(null)
            }}
            onDragEnd={() => { setDraggedIdx(null); setDropTargetIdx(null) }}
            className={`relative transition-opacity ${isDragging ? 'opacity-40' : ''} ${
              isDropTarget ? 'ring-2 ring-[#B7410E]/40 ring-offset-2 ring-offset-transparent rounded-lg' : ''
            }`}
          >
            {editing && (
              <div className="absolute -top-2 -right-2 z-20 flex items-center gap-1">
                <button
                  onClick={() => removeWidget(key)}
                  className="h-6 w-6 rounded-full bg-white border border-black/[0.10] shadow-sm flex items-center justify-center text-text-muted hover:text-red-600"
                  title={`Remove ${meta.label}`}
                >
                  <XIcon size={11} />
                </button>
              </div>
            )}
            {editing && (
              <div className="absolute top-2 left-2 z-20 cursor-move text-text-muted/60 hover:text-text-secondary"
                title="Drag to reorder">
                <DragGripIcon />
              </div>
            )}
            <div className={editing ? 'pl-6 transition-all' : ''}>
              {renderWidget(key)}
            </div>
          </div>
        )
      })}

      {/* Custom widgets. rendered as a 2-column responsive grid so a
          "half" tile sits next to another half tile, full takes the
          row. Each tile owns its own settings popover. */}
      {customWidgets.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
          {customWidgets.map(w => {
            const size: WidgetSize = customSizes[w.id] || DEFAULT_WIDGET_SIZE[w.type] || 'half'
            const span = WIDGET_SIZE_CLASS[size]
            const meta = CUSTOM_WIDGET_TYPES.find(c => c.key === w.type)
            const Icon = meta?.icon || Settings2
            return (
              <CustomWidgetTile
                key={w.id}
                widget={w}
                editing={editing}
                size={size}
                span={span}
                meta={meta}
                Icon={Icon}
                isSettingsOpen={openSettingsFor === w.id}
                onToggleSize={() => toggleCustomSize(w.id)}
                onToggleSettings={() => setOpenSettingsFor(openSettingsFor === w.id ? null : w.id)}
                onUpdate={next => updateCustomWidget(w.id, next)}
                onCloseSettings={() => setOpenSettingsFor(null)}
                onRemove={() => removeCustomWidget(w.id)}
                numericMetrics={numericMetrics}
              >
                <CustomWidgetBody
                  widget={w}
                  ads={ads}
                  chartAds={chartAds}
                  brand={brand}
                  onOpen={onOpen}
                />
              </CustomWidgetTile>
            )
          })}
        </div>
      )}

      {widgetOrder.length === 0 && customWidgets.length === 0 && (
        <div className="glass rounded-lg p-12 text-center text-[12.5px] text-text-secondary">
          No widgets. Click <strong>+ Add widget</strong> above to add some.
        </div>
      )}
    </div>
  )
}

// Velocity threshold settings (item #16). per-brand, configurable
// definitions for what "Winner" / "Loser" / "Scaling" / "New Launched"
// mean. Stored in localStorage scoped by brand (server-side via
// brand-profiles section data is the source of truth; localStorage
// is a cache so the UI renders instantly before the GET resolves).
//
// classify_by picks the metric used to rank Winners / Losers:
//   • 'roas'     . return on ad spend (higher is better)
//   • 'cpa'      . cost per action / purchase (LOWER is better)
//   • 'spend_pct'. spend percentile within the period
// winner_threshold / loser_threshold are interpreted in the units of
// the chosen metric (ratio for ROAS, $ for CPA, percentile 0-100 for
// spend_pct). The number inputs in the popover swap units to match.
export type VelocityClassifyMetric = 'roas' | 'cpa' | 'spend_pct'

type VelocityThresholds = {
  // Common
  min_spend: number
  top_pct: number              // Winners = top X%, Losers = bottom X%
  classify_by: VelocityClassifyMetric
  // Per-metric cutoffs (units vary by classify_by; see comment above)
  winner_threshold: number     // ROAS ≥, CPA ≤, spend_pct ≥
  loser_threshold: number      // ROAS ≤, CPA ≥, spend_pct ≤
  // Scaling. by spend delta vs previous period (default 50% increase)
  scaling_spend_delta_pct: number   // current ≥ prev × (1 + delta_pct/100)
  scaling_min_prev_spend: number
  // New Launched. ads created in the last N days OR with no prior spend
  new_launched_days: number
  // Legacy keys (kept so we can hydrate v1 saved configs without losing
  // user choice). The classifier prefers the new keys; we only read
  // these on load to backfill.
  winner_roas_min?: number
  loser_roas_max?: number
  scaling_multiplier?: number
}
const DEFAULT_THRESHOLDS: VelocityThresholds = {
  min_spend: 50,
  top_pct: 20,
  classify_by: 'roas',
  winner_threshold: 1.5,
  loser_threshold: 0.7,
  scaling_spend_delta_pct: 50,
  scaling_min_prev_spend: 50,
  new_launched_days: 7,
}

// Per-metric defaults the popover snaps to when the user switches
// classify_by (so flipping from ROAS → CPA doesn't leave a "≥ 1.5"
// CPA threshold sitting there silently filtering out everything).
const CLASSIFY_BY_DEFAULTS: Record<VelocityClassifyMetric, { winner: number; loser: number }> = {
  roas:      { winner: 1.5, loser: 0.7 },
  cpa:       { winner: 25,  loser: 75 },     // $/purchase. winner ≤ $25, loser ≥ $75
  spend_pct: { winner: 80,  loser: 20 },     // percentile cutoffs
}

function loadThresholds(brand: string): VelocityThresholds {
  try {
    const raw = localStorage.getItem(`ac.velocity.thresholds.${brand}`)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<VelocityThresholds>
      const merged: VelocityThresholds = { ...DEFAULT_THRESHOLDS, ...saved }
      // Back-compat: migrate v1 keys → new keys when classify_by is roas.
      if (saved.winner_roas_min !== undefined && saved.winner_threshold === undefined) {
        merged.winner_threshold = saved.winner_roas_min
      }
      if (saved.loser_roas_max !== undefined && saved.loser_threshold === undefined) {
        // v1 used "ROAS <". we store "ROAS ≤" now; close enough numerically.
        merged.loser_threshold = saved.loser_roas_max
      }
      if (saved.scaling_multiplier !== undefined && saved.scaling_spend_delta_pct === undefined) {
        merged.scaling_spend_delta_pct = Math.max(0, (saved.scaling_multiplier - 1) * 100)
      }
      return merged
    }
  } catch {}
  return { ...DEFAULT_THRESHOLDS }
}
function saveThresholds(brand: string, t: VelocityThresholds) {
  try { localStorage.setItem(`ac.velocity.thresholds.${brand}`, JSON.stringify(t)) } catch {}
}

export const VELOCITY_BUCKETS = ['New Launched', 'Scaling', 'Winners', 'Losers'] as const
export type VelocityBucketLabel = typeof VELOCITY_BUCKETS[number]

// Plain-English description of the current threshold definition, used
// by the per-bucket Info tooltip so the user always knows what the
// number actually represents.
export function velocityBucketDefinition(
  label: VelocityBucketLabel, t: VelocityThresholds,
): string {
  if (label === 'New Launched') {
    return `Ads launched in the last ${t.new_launched_days} day${t.new_launched_days === 1 ? '' : 's'} ` +
      `(or with spend this period and none in the compare period).`
  }
  if (label === 'Scaling') {
    return `Current spend ≥ ${t.scaling_spend_delta_pct.toFixed(0)}% over the previous period ` +
      `(min $${t.scaling_min_prev_spend} of prior spend to qualify).`
  }
  const minSpend = `, min $${t.min_spend} spend`
  if (t.classify_by === 'roas') {
    return label === 'Winners'
      ? `Top ${t.top_pct}% by ROAS, ROAS ≥ ${t.winner_threshold.toFixed(2)}${minSpend}.`
      : `Bottom ${t.top_pct}% by ROAS, ROAS ≤ ${t.loser_threshold.toFixed(2)}${minSpend}.`
  }
  if (t.classify_by === 'cpa') {
    return label === 'Winners'
      ? `Top ${t.top_pct}% by CPA (low → high), CPA ≤ $${t.winner_threshold.toFixed(0)}${minSpend}.`
      : `Bottom ${t.top_pct}% by CPA, CPA ≥ $${t.loser_threshold.toFixed(0)}${minSpend}.`
  }
  // spend_pct
  return label === 'Winners'
    ? `Spend in top ${100 - t.winner_threshold}% of the period (≥ p${t.winner_threshold} spend)${minSpend}.`
    : `Spend in bottom ${t.loser_threshold}% of the period (≤ p${t.loser_threshold} spend)${minSpend}.`
}

// Returns the comparison metric value used by classifyVelocity for an
// ad given the chosen classify_by. extracted so the test surface stays
// small (one place to mock ROAS/CPA/spend-percentile).
function _velocityMetricValue(a: AdCreative, metric: VelocityClassifyMetric): number {
  if (metric === 'roas') return Number(a.roas || 0)
  if (metric === 'cpa') {
    // Prefer the explicit cpa metric attached by withCustomMetrics; fall
    // back to spend/purchases. Ads with no purchases return Infinity so
    // they sort to the loser end naturally.
    const explicit = Number(a.cpa || 0)
    if (explicit > 0) return explicit
    const p = Number(a.purchases || 0)
    return p > 0 ? Number(a.spend || 0) / p : Number.POSITIVE_INFINITY
  }
  // spend_pct. caller assigns a percentile rank, so we return raw spend
  // here and let the classifier do the percentile math once.
  return Number(a.spend || 0)
}

// Classify a list of ads into the four velocity buckets defined by the
// brand-specific thresholds. Returns a map of label → ad_id Set so callers
// can use it for both displaying counts and applying per-bucket filters.
// An ad can appear in multiple buckets (e.g. a winner that's also scaling).
export function classifyVelocity(
  ads: AdCreative[],
  t: VelocityThresholds,
): Record<VelocityBucketLabel, Set<string>> {
  const valid = ads.filter(a => a.ad_id)
  const eligible = valid.filter(a => Number(a.spend || 0) >= t.min_spend)
  const metric = t.classify_by
  const higherIsBetter = metric === 'roas' || metric === 'spend_pct'

  // For spend_pct we want percentile-based selection: rank ads by spend
  // and a winner = percentile ≥ winner_threshold. We compute percentiles
  // upfront so the threshold-check stays a single comparison per ad.
  let pctByAd = new Map<string, number>()
  if (metric === 'spend_pct') {
    const sorted = [...eligible].sort(
      (a, b) => Number(a.spend || 0) - Number(b.spend || 0),
    )
    const n = sorted.length
    sorted.forEach((a, i) => {
      // 0..100 inclusive, evenly spaced
      pctByAd.set(a.ad_id, n <= 1 ? 100 : (i / (n - 1)) * 100)
    })
  }

  const scored = eligible
    .map(a => ({
      ad: a,
      // For winners-by-best ranking: higher score = better placement.
      score: metric === 'spend_pct'
        ? (pctByAd.get(a.ad_id) ?? 0)
        : higherIsBetter
          ? _velocityMetricValue(a, metric)
          : -_velocityMetricValue(a, metric), // CPA: invert so higher score = lower CPA = winner
    }))
    .sort((a, b) => b.score - a.score)

  const sliceN = Math.max(1, Math.ceil(scored.length * (t.top_pct / 100)))
  const winners = new Set<string>()
  const losers = new Set<string>()
  for (const { ad } of scored.slice(0, sliceN)) {
    const v = metric === 'spend_pct'
      ? (pctByAd.get(ad.ad_id) ?? 0)
      : _velocityMetricValue(ad, metric)
    const ok = metric === 'cpa'
      ? v <= t.winner_threshold
      : v >= t.winner_threshold
    if (ok) winners.add(ad.ad_id)
  }
  for (const { ad } of scored.slice(-sliceN)) {
    const v = metric === 'spend_pct'
      ? (pctByAd.get(ad.ad_id) ?? 0)
      : _velocityMetricValue(ad, metric)
    const ok = metric === 'cpa'
      ? v >= t.loser_threshold
      : v <= t.loser_threshold
    if (ok) losers.add(ad.ad_id)
  }

  // Scaling: spend up X% vs prior period, with a $ floor on prior spend
  // so a $0.05 → $1 ad doesn't flag as "scaling."
  const scalingMultiplier = 1 + (t.scaling_spend_delta_pct / 100)
  const scaling = new Set(
    valid.filter(a => {
      const cur = Number(a.spend || 0)
      const prev = Number((a as any).prev_spend || 0)
      return prev >= t.scaling_min_prev_spend && cur >= prev * scalingMultiplier
    }).map(a => a.ad_id),
  )

  // New Launched: created in the last N days OR no prior-period spend
  // (covers Meta accounts where created_time isn't surfaced. same v1
  // behaviour, just additive). created_time is a string column the
  // backend attaches when available.
  const cutoff = Date.now() - t.new_launched_days * 86400 * 1000
  const newLaunched = new Set(
    valid.filter(a => {
      const cur = Number(a.spend || 0)
      const prev = Number((a as any).prev_spend || 0)
      const createdStr = (a as any).created_time
      let recent = false
      if (createdStr) {
        const ts = Date.parse(createdStr)
        if (Number.isFinite(ts)) recent = ts >= cutoff
      }
      return recent || (cur > 0 && prev === 0)
    }).map(a => a.ad_id),
  )
  return {
    'New Launched': newLaunched,
    'Scaling': scaling,
    'Winners': winners,
    'Losers': losers,
  }
}

function ThresholdField({ label, value, onChange, suffix, step, hint }: {
  label: string
  value: number
  onChange: (v: number) => void
  suffix?: string
  step?: number
  hint?: string
}) {
  return (
    <label className="flex flex-col gap-1" title={hint}>
      <span className="text-[10px] text-text-muted">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          value={value}
          step={step ?? 1}
          onChange={e => onChange(Number(e.target.value) || 0)}
          className="flex-1 bg-white/70 border border-black/[0.10] rounded-lg px-2 py-1 text-[12px] tabular-nums focus:outline-none focus:border-[#B7410E]"
        />
        {suffix && <span className="text-[11px] text-text-muted w-3">{suffix}</span>}
      </div>
    </label>
  )
}

function VelocityScorecards({ ads, brand, selected, onToggle, thresholds: externalThresholds, onChangeThresholds }: {
  ads: AdCreative[]
  brand: string
  selected?: Set<VelocityBucketLabel>
  onToggle?: (label: VelocityBucketLabel) => void
  // Optional controlled-state. When the parent owns thresholds (so the
  // table-view filter pill stays in sync), pass these in. Otherwise we
  // keep the local-state behaviour from v1.
  thresholds?: VelocityThresholds
  onChangeThresholds?: (next: VelocityThresholds) => void
}) {
  // Collapse toggle removed in v0.3. the widget X (edit mode) is now
  // the single removal affordance for every widget, so the collapsed
  // "Show velocity scorecards" link rendered as an invisible-looking
  // empty line at the top of the dashboard.
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [localThresholds, setLocalThresholds] = useState<VelocityThresholds>(() => loadThresholds(brand))
  // Reload thresholds when brand changes (per-brand config). Only the
  // uncontrolled local copy needs this. controlled callers pass new
  // thresholds on brand change themselves.
  useEffect(() => { setLocalThresholds(loadThresholds(brand)) }, [brand])
  const thresholds = externalThresholds ?? localThresholds
  const setThresholds = (updater: VelocityThresholds | ((prev: VelocityThresholds) => VelocityThresholds)) => {
    const compute = (prev: VelocityThresholds) =>
      typeof updater === 'function' ? (updater as any)(prev) : updater
    if (onChangeThresholds) {
      onChangeThresholds(compute(thresholds))
    } else {
      setLocalThresholds(prev => compute(prev))
    }
  }
  const updateThreshold = <K extends keyof VelocityThresholds>(k: K, v: VelocityThresholds[K]) => {
    setThresholds(prev => {
      const next = { ...prev, [k]: v }
      saveThresholds(brand, next)
      return next
    })
  }

  const buckets = useMemo<VelocityBucket[]>(() => {
    const T = thresholds
    const sets = classifyVelocity(ads, T)
    return (['New Launched', 'Scaling', 'Winners', 'Losers'] as VelocityBucketLabel[])
      .map(label => ({
        label,
        count: sets[label].size,
        helper: velocityBucketDefinition(label, T),
      }))
  }, [ads, thresholds])

  // Switching classify_by snaps the winner/loser cutoffs to sensible
  // defaults for the new metric. otherwise a ROAS-tuned "≥ 1.5" lingers
  // as a $1.50 CPA winner threshold and surprises nobody pleasantly.
  const setClassifyBy = (m: VelocityClassifyMetric) => {
    setThresholds(prev => {
      const defaults = CLASSIFY_BY_DEFAULTS[m]
      const next: VelocityThresholds = {
        ...prev,
        classify_by: m,
        winner_threshold: defaults.winner,
        loser_threshold: defaults.loser,
      }
      saveThresholds(brand, next)
      return next
    })
  }
  const classifyUnit = thresholds.classify_by === 'cpa'
    ? '$'
    : thresholds.classify_by === 'spend_pct'
      ? 'p'
      : ''
  const classifyLabel = thresholds.classify_by === 'cpa'
    ? 'CPA'
    : thresholds.classify_by === 'spend_pct'
      ? 'Spend percentile'
      : 'ROAS'

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-widest text-text-muted font-medium">
          Velocity · {brand}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setSettingsOpen(v => !v)}
            className={`h-6 px-2 rounded-full text-[10px] flex items-center gap-1 transition-colors ${
              settingsOpen
                ? 'bg-[#B7410E]/10 border border-[#B7410E]/30 text-[#b55719]'
                : 'glass glass-hover text-text-secondary'
            }`}
            title="Define what Winner / Loser / Scaling / New Launched mean"
          >
            <Settings2 size={10} /> Thresholds
          </button>
        </div>
      </div>

      {settingsOpen && (
        <div className="atelier-tile flex flex-col gap-3">
          <div className="text-[10px] uppercase tracking-widest text-text-muted font-medium">
            Velocity thresholds ({brand})
          </div>

          {/* Classify-by metric. radio group that swaps the winner/loser
              unit downstream so "≥ 1.5" doesn't mean three different things. */}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-text-muted">Classify Winners / Losers by</span>
            <div className="flex flex-wrap gap-1">
              {([
                { key: 'roas',      label: 'ROAS', hint: 'Return on ad spend (higher = better)' },
                { key: 'cpa',       label: 'Cost per Action', hint: '$/purchase (lower = better)' },
                { key: 'spend_pct', label: 'Spend percentile', hint: 'Rank by spend within the period' },
              ] as const).map(o => {
                const active = thresholds.classify_by === o.key
                return (
                  <button key={o.key}
                    onClick={() => setClassifyBy(o.key)}
                    title={o.hint}
                    className={`h-6 px-2.5 rounded-full text-[11px] flex items-center gap-1.5 transition-colors ${
                      active
                        ? 'bg-[#B7410E]/10 border border-[#B7410E]/30 text-[#b55719]'
                        : 'glass glass-hover text-text-secondary'
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full ${active ? 'bg-[#B7410E]' : 'bg-black/15'}`} />
                    {o.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <ThresholdField
              label={`Winners ${thresholds.classify_by === 'cpa' ? '≤' : '≥'}`}
              suffix={classifyUnit}
              value={thresholds.winner_threshold}
              onChange={v => updateThreshold('winner_threshold', v)}
              step={thresholds.classify_by === 'roas' ? 0.1 : 1}
              hint={`${classifyLabel} bar to count as a Winner`}
            />
            <ThresholdField
              label={`Losers ${thresholds.classify_by === 'cpa' ? '≥' : '≤'}`}
              suffix={classifyUnit}
              value={thresholds.loser_threshold}
              onChange={v => updateThreshold('loser_threshold', v)}
              step={thresholds.classify_by === 'roas' ? 0.1 : 1}
              hint={`${classifyLabel} ceiling for Loser bucket`}
            />
            <ThresholdField label="Min spend" suffix="$" value={thresholds.min_spend}
              onChange={v => updateThreshold('min_spend', v)} hint="Floor for Winner/Loser eligibility" />
            <ThresholdField label="Top / Bottom %" suffix="%" value={thresholds.top_pct}
              onChange={v => updateThreshold('top_pct', v)} hint="Winners are top X% / Losers are bottom X%" />
            <ThresholdField label="New launched window" suffix="d"
              value={thresholds.new_launched_days}
              onChange={v => updateThreshold('new_launched_days', Math.max(1, Math.round(v)))}
              hint="Ads launched in the last N days count as New" />
            <ThresholdField label="Scaling spend Δ vs prior" suffix="%"
              value={thresholds.scaling_spend_delta_pct}
              onChange={v => updateThreshold('scaling_spend_delta_pct', Math.max(0, v))}
              hint="Current spend up at least this % over the previous period" />
            <ThresholdField label="Scaling min prev spend" suffix="$"
              value={thresholds.scaling_min_prev_spend}
              onChange={v => updateThreshold('scaling_min_prev_spend', v)}
              hint="Ignore scaling-from-pennies edge cases" />
          </div>
          <button
            onClick={() => { setThresholds({ ...DEFAULT_THRESHOLDS }); saveThresholds(brand, DEFAULT_THRESHOLDS) }}
            className="self-start text-[10px] text-text-muted hover:text-text-primary"
          >
            Reset to defaults
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {buckets.map(b => {
          const isActive = selected?.has(b.label as VelocityBucketLabel) || false
          const clickable = !!onToggle
          const helper = clickable
            ? `${b.helper} · Click to ${isActive ? 'clear' : 'filter to'} ${b.label}.`
            : b.helper
          const Tag: any = clickable ? 'button' : 'div'
          return (
            <Tag
              key={b.label}
              onClick={clickable ? () => onToggle!(b.label as VelocityBucketLabel) : undefined}
              type={clickable ? 'button' : undefined}
              title={helper}
              className={`atelier-tile text-left transition-all ${
                clickable ? 'cursor-pointer hover:shadow-sm' : ''
              } ${
                isActive ? 'ring-2 ring-[#B7410E]/40 bg-[#B7410E]/[0.04]' : ''
              }`}
            >
              <div className="flex items-center gap-1">
                <div className="text-[10px] uppercase tracking-widest text-text-muted font-medium">
                  {b.label}
                </div>
                {/* Info dot. surfaces the active rule on hover so a
                    glance at "23 Winners" never leaves the user
                    wondering what counts as a winner today. */}
                <span
                  className="text-text-muted/70 hover:text-text-secondary cursor-help"
                  title={b.helper}
                  onClick={e => e.stopPropagation()}
                >
                  <Info size={9} />
                </span>
              </div>
              <div className="font-display text-2xl font-medium tabular-nums mt-0.5">
                {b.count}
              </div>
              {b.delta !== undefined && (
                <div className={`text-[10px] tabular-nums mt-0.5 ${b.delta >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                  {b.delta >= 0 ? '↑' : '↓'} {Math.abs(b.delta).toFixed(0)}%
                </div>
              )}
            </Tag>
          )
        })}
      </div>
    </div>
  )
}

// Zoom slider for the card grid. light-gray track, small round thumb.
// Sticky to bottom of viewport, centered, minimal chrome.
// ---------------------------------------------------------------------------
// DownloadMenu. single button + dropdown with three exports:
//   • PNG of the currently-rendered card grid
//   • ZIP of source images (one file per ad, named by ad_name)
//   • CSV of the filtered ad rows with the user's picked metrics
// All three operate on what's already on screen (post filter / sort), so the
// user gets exactly what they see. Network fetches for the ZIP go through
// no-cors so signed-CDN headers stay valid; the resulting blobs are added
// directly to the zip without re-encoding.
// ---------------------------------------------------------------------------

function DownloadMenu({
  gridRef, ads, selectedAds, metricDefs, brand, chartMode,
}: {
  gridRef: React.RefObject<HTMLDivElement | null>
  ads: AdCreative[]
  /** Optional. If non-empty, every download path (PNG / ZIP / CSV /
   *  PDF) operates on this subset rather than the full filtered grid.
   *  Lets the user check 3 cards and grab "just those" instead of
   *  the whole 200-ad view. */
  selectedAds?: AdCreative[]
  metricDefs: MetricDef[]
  brand?: string
  chartMode: string
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<'png' | 'zip' | 'csv' | null>(null)
  const [zipProgress, setZipProgress] = useState<{ done: number; total: number } | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  // Toast that confirms a successful download. Bottom-right of viewport,
  // auto-dismisses after 4s. The user reported the previous PNG download
  // gave no confirmation and they couldn't tell where the file went —
  // this toast names the saved filename + reminds them of the browser's
  // Downloads folder so they don't have to go hunting.
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 4000)
    return () => window.clearTimeout(t)
  }, [toast])

  // Effective set: use the selection when one exists, else the full
  // filtered view. selecting just two cards now means only those two
  // land in the PNG / ZIP / CSV, which matches what every screenshot
  // / batch tool does and what the user expected.
  const effectiveAds = (selectedAds && selectedAds.length > 0) ? selectedAds : ads
  const isSelection = !!(selectedAds && selectedAds.length > 0)
  const countLabel = `${effectiveAds.length} ${isSelection ? 'selected' : 'shown'}`

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const stamp = () => {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
  }
  const baseName = `${(brand || 'ads').replace(/[^a-z0-9-_]+/gi, '_')}-${stamp()}`
  const triggerDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const downloadPng = async () => {
    if (!gridRef.current) return
    setBusy('png')
    try {
      const dataUrl = await toPng(gridRef.current, {
        pixelRatio: 2,
        backgroundColor: '#f6f3ee',
        cacheBust: true,
        // Skip the floating zoom slider. it's chrome, not content.
        filter: (node) => !(node instanceof HTMLElement && node.classList.contains('atelier-zoom-range')),
      })
      const blob = await (await fetch(dataUrl)).blob()
      const filename = `${baseName}-grid${isSelection ? `-${effectiveAds.length}sel` : ''}.png`
      triggerDownload(blob, filename)
      setToast(`Saved ${filename} → check your Downloads folder`)
    } finally {
      setBusy(null)
      setOpen(false)
    }
  }

  const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)

  const downloadZip = async () => {
    setBusy('zip')
    setZipProgress({ done: 0, total: effectiveAds.length })
    try {
      const zip = new JSZip()
      let done = 0
      // Sequential rather than parallel. we don't want to hammer Meta's
      // CDN with 500 concurrent fetches. ~5 in flight at a time would be
      // a nice middle ground but a simple loop is fine for a few hundred.
      for (const ad of effectiveAds) {
        const url = ad.image_url_hd || ad.image_url || ad.thumbnail_url
        if (url) {
          try {
            const r = await fetch(url, { mode: 'cors' })
            if (r.ok) {
              const blob = await r.blob()
              const ext = (blob.type.split('/')[1] || 'jpg').split(';')[0]
              const name = safeName(`${ad.ad_name || ad.ad_id}`)
              zip.file(`${name}.${ext}`, blob)
            }
          } catch {
            // Skip individual failures. the zip still gets the rest.
          }
        }
        done += 1
        setZipProgress({ done, total: effectiveAds.length })
      }
      const blob = await zip.generateAsync({ type: 'blob' })
      const filename = `${baseName}-images${isSelection ? `-${effectiveAds.length}sel` : ''}.zip`
      triggerDownload(blob, filename)
      setToast(`Saved ${filename} (${effectiveAds.length} ad${effectiveAds.length === 1 ? '' : 's'}) → check your Downloads folder`)
    } finally {
      setBusy(null)
      setZipProgress(null)
      setOpen(false)
    }
  }

  const downloadCsv = () => {
    setBusy('csv')
    try {
      // AI Analysis + sentiment columns we ALWAYS include in the CSV,
      // regardless of whether the user has them ticked in the metrics
      // picker. The fields are merged onto every row by AdAnalysisView's
      // `adsWithAnalysis` step (which feeds `filteredAds` → this menu),
      // so all we need to do here is name them in the header list.
      //
      // Listed in roughly the order people read them: sentiment first
      // (because it's the headline AI label), then strategic tags
      // (angle / persona / template / funnel / awareness), then taxonomy.
      const ALWAYS_INCLUDE: { key: string; label: string }[] = [
        { key: 'analysis_sentiment',       label: 'AI: sentiment' },
        { key: 'sentiment_score',          label: 'AI: sentiment score' },
        { key: 'analysis_angle',           label: 'AI: angle' },
        { key: 'analysis_persona',         label: 'AI: persona' },
        { key: 'analysis_template',        label: 'AI: template' },
        { key: 'analysis_funnelPosition',  label: 'AI: funnel position' },
        { key: 'analysis_marketAwareness', label: 'AI: market awareness' },
        { key: 'analysis_category',        label: 'AI: category' },
        { key: 'analysis_collection',      label: 'AI: collection' },
        { key: 'analysis_offer',           label: 'AI: offer' },
        { key: 'analysis_marketingMoment', label: 'AI: marketing moment' },
        { key: 'analysis_emotion',         label: 'AI: emotion' },
      ]
      // Dedup: if a picked metric overlaps with the always-include list,
      // keep the picked-metric position (preserves the user's column
      // ordering on metric picks) and drop the duplicate at the tail.
      const pickedKeys = new Set(metricDefs.map(d => String(d.key)))
      const tail = ALWAYS_INCLUDE.filter(c => !pickedKeys.has(c.key))

      const headerKeys: { key: string; label: string; def?: MetricDef }[] = [
        { key: '__ad_id', label: 'ad_id' },
        { key: '__ad_name', label: 'ad_name' },
        { key: '__effective_status', label: 'effective_status' },
        ...metricDefs.map(d => ({ key: String(d.key), label: d.label, def: d })),
        ...tail,
      ]
      const escape = (v: string) => {
        if (v == null) return ''
        if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`
        return v
      }
      const lines: string[] = []
      lines.push(headerKeys.map(h => escape(h.label)).join(','))
      for (const ad of effectiveAds) {
        const row = headerKeys.map(h => {
          if (h.key === '__ad_id') return escape(ad.ad_id || '')
          if (h.key === '__ad_name') return escape(ad.ad_name || '')
          if (h.key === '__effective_status') return escape(ad.effective_status || '')
          const raw = (ad as any)[h.key]
          if (h.def && h.def.format !== 'text') {
            return escape(raw == null ? '' : String(raw))
          }
          return escape(raw == null ? '' : String(raw))
        })
        lines.push(row.join(','))
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
      const filename = `${baseName}-table${isSelection ? `-${effectiveAds.length}sel` : ''}.csv`
      triggerDownload(blob, filename)
      setToast(`Saved ${filename} (${effectiveAds.length} row${effectiveAds.length === 1 ? '' : 's'}) → check your Downloads folder`)
    } finally {
      setBusy(null)
      setOpen(false)
    }
  }

  const pngDisabled = chartMode !== 'cards'

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen(o => !o)}
        disabled={!!busy || effectiveAds.length === 0}
        className={`glass glass-hover px-2 py-1 rounded-full text-[11px] flex items-center gap-1 whitespace-nowrap disabled:opacity-50 ${
          isSelection ? 'ring-1 ring-[#B7410E]/50' : ''
        }`}
        title={
          isSelection
            ? `Download the ${effectiveAds.length} selected ad${effectiveAds.length === 1 ? '' : 's'}`
            : `Download the ${effectiveAds.length} ad${effectiveAds.length === 1 ? '' : 's'} on screen`
        }
      >
        {busy ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
        {busy === 'zip' && zipProgress
          ? `Zipping ${zipProgress.done}/${zipProgress.total}`
          : `Download (${countLabel})`}
        <ChevronDown size={9} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-40 w-[260px] bg-white rounded-lg shadow-[0_8px_28px_-4px_rgba(0,0,0,0.18)] border border-black/[0.08] overflow-hidden">
          {/* Scope strip — explicit about what every export operates on
              so the user doesn't have to guess whether their checkbox
              selection took effect. */}
          <div className={`px-3 py-1.5 text-[10px] uppercase tracking-widest font-medium border-b border-black/[0.05] ${
            isSelection ? 'text-[#B7410E] bg-[#B7410E]/[0.06]' : 'text-text-muted bg-black/[0.02]'
          }`}>
            {isSelection
              ? `Exporting ${effectiveAds.length} selected ad${effectiveAds.length === 1 ? '' : 's'}`
              : `Exporting all ${effectiveAds.length} ad${effectiveAds.length === 1 ? '' : 's'} on screen`}
          </div>
          <button
            onClick={downloadPng}
            disabled={pngDisabled}
            className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-black/[0.03] disabled:opacity-50 disabled:hover:bg-transparent"
            title={pngDisabled ? 'Switch to card view to capture a screenshot' : 'PNG of the current grid'}
          >
            <ImageIcon size={13} className="mt-0.5 text-text-secondary shrink-0" />
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-text-primary">Grid screenshot</div>
              <div className="text-[10.5px] text-text-muted leading-tight">PNG of what's on screen</div>
            </div>
          </button>
          <button
            onClick={downloadZip}
            className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-black/[0.03]"
            title="ZIP of source images, one per ad"
          >
            <FolderArchive size={13} className="mt-0.5 text-text-secondary shrink-0" />
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-text-primary">All assets (ZIP)</div>
              <div className="text-[10.5px] text-text-muted leading-tight">{effectiveAds.length} image{effectiveAds.length === 1 ? '' : 's'} as individual files</div>
            </div>
          </button>
          <button
            onClick={downloadCsv}
            className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-black/[0.03]"
            title="CSV of the current rows. includes picked metrics + every AI analysis field (sentiment, angle, persona, template, etc)"
          >
            <FileSpreadsheet size={13} className="mt-0.5 text-text-secondary shrink-0" />
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-text-primary">Table (CSV) · with AI</div>
              <div className="text-[10.5px] text-text-muted leading-tight">{effectiveAds.length} row{effectiveAds.length === 1 ? '' : 's'} · picked metrics + sentiment, angle, persona, template, funnel, awareness</div>
            </div>
          </button>
          <button
            onClick={() => {
              // Use the browser's native print-to-PDF rather than bundling
              // a 300KB+ PDF lib. Works in every browser; user gets full
              // control over format / page size / margins from the print
              // dialog and can pick "Save as PDF".
              setOpen(false)
              setTimeout(() => window.print(), 50)
            }}
            className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-black/[0.03]"
            title="Print the current view. pick 'Save as PDF' in the print dialog"
          >
            <FileSpreadsheet size={13} className="mt-0.5 text-text-secondary shrink-0" />
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-text-primary">Report (PDF)</div>
              <div className="text-[10.5px] text-text-muted leading-tight">Opens print dialog · save as PDF</div>
            </div>
          </button>
        </div>
      )}
      {toast && (
        <div
          className="fixed bottom-5 right-5 z-[10001] glass rounded-lg px-3 py-2 text-[11px] text-text-primary shadow-[0_8px_28px_-4px_rgba(0,0,0,0.18)] border border-black/[0.08] max-w-[420px] flex items-start gap-2"
          role="status"
          aria-live="polite"
        >
          <span style={{ color: '#2d8a4e' }} aria-hidden>✓</span>
          <span>{toast}</span>
        </div>
      )}
    </div>
  )
}

function ZoomSlider({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="sticky bottom-3 z-20 flex justify-center pointer-events-none">
      <div
        className="pointer-events-auto flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/80 backdrop-blur-md shadow-sm border border-black/[0.06]"
        title="Card size"
      >
        <input
          type="range"
          min={1}
          max={5}
          step={1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label="Card size"
          className="atelier-zoom-range w-40 h-1 appearance-none bg-black/[0.08] rounded-full outline-none cursor-pointer"
        />
      </div>
    </div>
  )
}

function AdTable({
  ads, metricDefs, checked, onToggle, onOpen, sort, sortDir, onSort, brand,
}: {
  ads: AdCreative[]
  metricDefs: MetricDef[]
  checked: Set<string>
  onToggle: (id: string) => void
  onOpen: (id: string) => void
  sort: string
  sortDir: 'asc' | 'desc'
  onSort: (k: string) => void
  brand?: string
}) {
  return (
    <div className="glass rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-black/[0.06]">
              <th className="px-3 py-1.5 w-8"></th>
              <th className="px-3 py-1.5 w-10"></th>
              <th className="px-3 py-1.5 text-left text-[10px] font-medium uppercase tracking-widest text-text-muted">Ad</th>
              {metricDefs.map(m => {
                const isText = m.format === 'text'
                return (
                  <th key={String(m.key)} onClick={() => onSort(String(m.key))}
                    className={`px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest text-text-muted cursor-pointer hover:text-text-primary transition-colors ${
                      isText ? 'text-left' : 'text-right'
                    }`}>
                    <span className="inline-flex items-center gap-1">
                      {m.label}
                      {sort === m.key && <span className="text-[9px]">{sortDir === 'desc' ? '▼' : '▲'}</span>}
                    </span>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {ads.map(ad => {
              const isChecked = checked.has(ad.ad_id)
              return (
                <tr key={ad.ad_id}
                  className={`border-b border-black/[0.04] hover:bg-white/40 transition-colors ${
                    isChecked ? 'bg-[#B7410E]/[0.05]' : ''
                  }`}>
                  <td className="px-3 py-2 align-middle">
                    <button onClick={() => onToggle(ad.ad_id)}
                      className="p-0.5 hover:bg-black/[0.04] rounded"
                      title={isChecked ? 'Deselect' : 'Select'}>
                      {isChecked
                        ? <CheckSquare size={14} className="text-[#B7410E]" />
                        : <Square size={14} className="text-text-muted" />}
                    </button>
                  </td>
                  <td className="px-2 py-2 align-middle">
                    <button
                      type="button"
                      onClick={() => onOpen(ad.ad_id)}
                      title="Open ad detail"
                      className="block w-8 h-8 rounded overflow-hidden cursor-pointer hover:ring-2 hover:ring-[#B7410E]/40 transition"
                    >
                      <Thumbnail ad={ad} brand={brand} />
                    </button>
                  </td>
                  <td className="px-3 py-2 align-middle">
                    <button onClick={() => onOpen(ad.ad_id)}
                      className="text-[11px] text-text-primary hover:text-[#B7410E] text-left max-w-[220px] truncate block"
                      title={ad.ad_name}>
                      {ad.ad_name || ad.ad_id}
                    </button>
                  </td>
                  {metricDefs.map(m => {
                    const raw = (ad as any)[m.key]
                    if (m.analysisField) {
                      return (
                        <td key={String(m.key)} className="px-3 py-2 text-left align-middle">
                          <AnalysisCell metricKey={String(m.key)} value={raw} />
                        </td>
                      )
                    }
                    // effective_status renders as the colored StatusPill so
                    // the status column keeps its prior visual when toggled
                    // on, even though it's now driven from the metric picker.
                    if (m.key === 'effective_status') {
                      return (
                        <td key={String(m.key)} className="px-3 py-2 text-left align-middle">
                          <StatusPill status={ad.effective_status} updatedTime={ad.updated_time} />
                        </td>
                      )
                    }
                    if (m.format === 'text') {
                      return (
                        <td key={String(m.key)} className="px-3 py-2 text-left align-middle">
                          <div className="text-[11px] text-text-muted max-w-[180px] truncate" title={String(raw ?? '')}>
                            {raw || '-'}
                          </div>
                        </td>
                      )
                    }
                    // Compare-period delta chip next to numeric values
                    // when the backend stamped a `prev_<key>` field.
                    const prevKey = `prev_${String(m.key)}`
                    const prevRaw = (ad as any)[prevKey]
                    return (
                      <td key={String(m.key)} className="px-3 py-2 text-right tabular-nums text-[11px] text-text-primary align-middle">
                        {fmtMetric(raw, m)}
                        <DeltaChip current={Number(raw)} prev={prevRaw} metricKey={String(m.key)} />
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// Grouped table. thumbnail column hidden (no single creative per row).
// Text / analysis-tag columns are meaningless on an aggregate so we drop
// them; only numeric / derived metrics show.
function GroupedTable({
  rows, metricDefs, groupLabel, sort, sortDir, onSort, onDrillIn,
}: {
  rows: GroupedRow[]
  metricDefs: MetricDef[]
  groupLabel: string
  sort: string
  sortDir: 'asc' | 'desc'
  onSort: (k: string) => void
  // Click a group's label cell → drill into the ads inside it.
  // Parent decides what that means (typically: clear groupBy + add a
  // dimension filter equal to the row's group_key).
  onDrillIn?: (groupKey: string, groupValue: string) => void
}) {
  const visibleDefs = metricDefs.filter(m => {
    if (m.key === 'campaign_name' || m.key === 'adset_name') return false
    return true
  })
  // Allow the user to sort by the implicit columns too (group name,
  // ad count). both are useful when grouped by Campaign / Adset.
  const sorted = useMemo(() => {
    const out = [...rows]
    const isAdCount = sort === 'ad_count'
    const isGroupName = sort === 'group_value' || sort === 'group_key'
    const def = visibleDefs.find(d => String(d.key) === sort)
    const isText = isGroupName || (def?.format === 'text')
    out.sort((a, b) => {
      if (a.group_key === '(unanalyzed)') return 1
      if (b.group_key === '(unanalyzed)') return -1
      if (isText) {
        const av = String((isGroupName ? a.group_value : a[sort]) ?? '')
        const bv = String((isGroupName ? b.group_value : b[sort]) ?? '')
        const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' })
        return sortDir === 'desc' ? -cmp : cmp
      }
      const av = Number((isAdCount ? a.ad_count : a[sort]) ?? 0)
      const bv = Number((isAdCount ? b.ad_count : b[sort]) ?? 0)
      return sortDir === 'desc' ? bv - av : av - bv
    })
    return out
  }, [rows, sort, sortDir, visibleDefs])

  const SortIndicator = ({ k }: { k: string }) =>
    sort === k ? <span className="text-[9px]">{sortDir === 'desc' ? '▼' : '▲'}</span> : null

  return (
    <div className="glass rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-black/[0.06]">
              <th
                onClick={() => onSort('group_value')}
                className="px-3 py-1.5 text-left text-[10px] font-medium uppercase tracking-widest text-text-muted cursor-pointer hover:text-text-primary transition-colors"
              >
                <span className="inline-flex items-center gap-1">
                  {groupLabel}<SortIndicator k="group_value" />
                </span>
              </th>
              <th
                onClick={() => onSort('ad_count')}
                className="px-3 py-1.5 text-right text-[10px] font-medium uppercase tracking-widest text-text-muted cursor-pointer hover:text-text-primary transition-colors"
              >
                <span className="inline-flex items-center gap-1">
                  Ads<SortIndicator k="ad_count" />
                </span>
              </th>
              {visibleDefs.map(m => {
                const isText = m.format === 'text'
                return (
                  <th key={String(m.key)} onClick={() => onSort(String(m.key))}
                    className={`px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest text-text-muted cursor-pointer hover:text-text-primary transition-colors ${
                      isText ? 'text-left' : 'text-right'
                    }`}>
                    <span className="inline-flex items-center gap-1">
                      {m.label}<SortIndicator k={String(m.key)} />
                    </span>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map(row => {
              const drillable = !!onDrillIn && row.group_key !== '(unanalyzed)'
              return (
                <tr key={row.group_key}
                  className={`border-b border-black/[0.04] hover:bg-white/40 transition-colors ${
                    row.group_key === '(unanalyzed)' ? 'text-text-muted italic' : ''
                  }`}>
                  <td className="px-3 py-2 align-middle">
                    {drillable ? (
                      <button
                        onClick={() => onDrillIn!(row.group_key, row.group_value)}
                        className="text-[12px] text-text-primary font-medium text-left hover:text-[#B7410E] hover:underline underline-offset-2"
                        title="Drill into the ads in this group"
                      >
                        {row.group_value}
                      </button>
                    ) : (
                      <div className="text-[12px] text-text-primary font-medium">
                        {row.group_value}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[11px] text-text-muted align-middle">
                    {row.ad_count}
                  </td>
                  {visibleDefs.map(m => {
                    const key = String(m.key)
                    const raw = row[key]
                    if (m.format === 'text') {
                      const mode = raw == null || raw === '' ? '-' : String(raw)
                      const variety = Number(row[`${key}__variety`] || 0)
                      return (
                        <td key={key} className="px-3 py-2 text-left text-[11px] align-middle">
                          <div className="max-w-[180px] truncate" title={mode}>
                            {mode === '-' ? <span className="text-text-muted">-</span> : (
                              <span className="text-text-primary">{mode}</span>
                            )}
                            {variety > 1 && (
                              <span className="text-text-muted ml-1.5">+{variety - 1}</span>
                            )}
                          </div>
                        </td>
                      )
                    }
                    return (
                      <td key={key} className="px-3 py-2 text-right tabular-nums text-[11px] text-text-primary align-middle">
                        {fmtMetric(Number(raw ?? 0), m)}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function GroupedBarChart({
  rows, metricDefs, groupLabel,
}: {
  rows: GroupedRow[]
  metricDefs: MetricDef[]
  groupLabel: string
}) {
  const numericDefs = metricDefs.filter(m => m.format !== 'text' && !m.analysisField)
  const data = useMemo(() => rows.map(r => {
    const row: any = { name: r.group_value.length > 24 ? r.group_value.slice(0, 22) + '…' : r.group_value }
    for (const m of numericDefs) row[String(m.key)] = Number(r[String(m.key)] ?? 0)
    return row
  }), [rows, numericDefs])

  if (!numericDefs.length) {
    return (
      <div className="glass rounded-lg p-10 text-center text-text-muted text-sm">
        Pick at least one numeric metric from the Metrics picker.
      </div>
    )
  }
  if (!rows.length) {
    return (
      <div className="glass rounded-lg p-10 text-center text-text-muted text-sm">
        No {groupLabel.toLowerCase()} groups in the current filter set.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[10px] text-text-muted px-1">
        Grouped by {groupLabel}. one bar per group. Rates (ROAS / CTR / CPM / hook / hold) recompute from summed inputs.
      </div>
      <div className="glass rounded-lg p-4" style={{ height: 460 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 10, right: 20, left: 10, bottom: 60 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#6b7280' }}
              angle={-20} textAnchor="end" interval={0} height={70} />
            <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} />
            <Tooltip
              formatter={(value: any, name: any) => {
                const def = numericDefs.find(d => d.label === name || String(d.key) === name)
                return [def ? fmtMetric(Number(value), def) : value, def?.label || name]
              }}
              contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid rgba(0,0,0,0.08)' }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {numericDefs.map((m, i) => (
              <Bar key={String(m.key)} dataKey={String(m.key)} name={m.label}
                fill={COLORS[i % COLORS.length]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// Grouped line chart placeholder. we don't have per-group timeseries data
// from the server (timeseries is per-ad). Render an explanatory card so the
// user isn't left staring at an empty chart.
function GroupedLineChart({
  rows, groupLabel,
}: {
  rows: GroupedRow[]
  metricDefs: MetricDef[]
  groupLabel: string
}) {
  return (
    <div className="glass rounded-lg p-10 text-center text-text-muted text-sm flex flex-col items-center gap-2">
      <div>Line chart is not available in Group-by ({groupLabel}) mode.</div>
      <div className="text-[10px] text-text-muted">
        Daily timeseries are fetched per-ad. Switch to the Bar or Table view to
        see the {rows.length} {groupLabel.toLowerCase()} groups.
      </div>
    </div>
  )
}

// Renders an analysis-derived cell. pill for enums, progress bar for
// clarity score, truncated text for persona. 'N/A' if uncached.
function AnalysisCell({ metricKey, value }: { metricKey: string; value: any }) {
  if (value == null || value === '') {
    return <span className="text-[10px] text-text-muted italic">-</span>
  }
  if (
    metricKey === 'analysis_creativeClarityScore' ||
    metricKey === 'analysis_visualDiffScore' ||
    metricKey === 'analysis_messagingDiffScore'
  ) {
    const s = Math.max(0, Math.min(100, Math.round(Number(value) || 0)))
    const color = s >= 70 ? '#10b981' : s >= 40 ? '#f59e0b' : '#dc2626'
    return (
      <div className="flex items-center gap-1.5 min-w-[80px]">
        <div className="relative h-1 w-12 rounded-full bg-black/[0.06] overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${s}%`, background: color }} />
        </div>
        <span className="text-[11px] tabular-nums" style={{ color }}>{s}</span>
      </div>
    )
  }
  if (metricKey === 'analysis_persona') {
    return (
      <div className="text-[10.5px] text-text-secondary max-w-[180px] truncate" title={String(value)}>
        {String(value)}
      </div>
    )
  }
  const tone = pillToneForCell(metricKey, String(value))
  return <TablePill value={String(value)} tone={tone} />
}

type CellPillTone = 'primary' | 'secondary' | 'good' | 'warn' | 'bad' | 'muted'

function TablePill({ value, tone }: { value: string; tone: CellPillTone }) {
  const styles: Record<CellPillTone, { bg: string; fg: string }> = {
    primary:   { bg: 'rgba(183,65,14,0.12)', fg: '#b55719' },
    secondary: { bg: 'rgba(37,99,235,0.10)',  fg: '#1e3a8a' },
    good:      { bg: 'rgba(16,185,129,0.12)', fg: '#065f46' },
    warn:      { bg: 'rgba(245,158,11,0.14)', fg: '#92400e' },
    bad:       { bg: 'rgba(220,38,38,0.10)',  fg: '#991b1b' },
    muted:     { bg: 'rgba(0,0,0,0.04)',      fg: '#6b7280' },
  }
  const st = styles[tone]
  return (
    <span className="text-[10px] font-medium rounded-full px-2 py-0.5 whitespace-nowrap"
      style={{ background: st.bg, color: st.fg }}>
      {value}
    </span>
  )
}

function pillToneForCell(key: string, v: string): CellPillTone {
  const lower = v.toLowerCase()
  if (lower === 'unknown' || lower === 'n/a') return 'muted'
  if (key === 'analysis_sentiment') {
    if (lower.includes('positive') || lower.includes('inspirational')) return 'good'
    if (lower.includes('urgent') || lower.includes('negative')) return 'warn'
    if (lower.includes('humorous')) return 'primary'
    return 'secondary'
  }
  if (key === 'analysis_funnelPosition') {
    if (lower === 'bof') return 'primary'
    if (lower === 'mof') return 'secondary'
    if (lower === 'tof' || lower === 'awareness') return 'good'
    if (lower === 'reactivation') return 'warn'
    return 'muted'
  }
  if (key === 'analysis_template') {
    if (lower.includes('ugc') || lower.includes('testimonial')) return 'primary'
    if (lower.includes('before') || lower.includes('problem')) return 'warn'
    if (lower.includes('product feature') || lower.includes('explainer')) return 'secondary'
    if (lower.includes('lifestyle') || lower.includes('brand story')) return 'good'
    return 'muted'
  }
  return 'muted'
}

// Custom x-axis tick for the Bar chart. tiny 32x32 thumbnail + truncated
// ad name under each bar. Looked up by the string category value (the
// shortLabel) since recharts only passes the category value into the tick.
// The thumbnail is clickable; the click bubbles through via `onOpen(ad_id)`
// so the Ad Detail panel opens the same way it does from the card grid.
function ThumbnailBarTick(props: any) {
  const { x, y, payload, thumbMap, onOpen, onToggleHidden, brand } = props
  const meta = thumbMap?.[payload?.value]
  const name = meta?.name || payload?.value || ''
  const short = name.length > 14 ? name.slice(0, 13) + '…' : name
  const adId: string | undefined = meta?.ad_id
  const canOpen = !!(adId && onOpen)
  const canToggle = !!(adId && onToggleHidden)
  return (
    <g transform={`translate(${x},${y})`}>
      <foreignObject x={-20} y={4} width={40} height={40} style={{ overflow: 'visible' }}>
        <div
          onClick={() => { if (canToggle) onToggleHidden(adId) }}
          role={canToggle ? 'button' : undefined}
          title={canToggle ? `Hide ${name}` : undefined}
          style={{
            width: 32, height: 32, borderRadius: 6, overflow: 'hidden',
            background: meta?.color || '#e5e7eb', margin: '0 auto',
            cursor: canToggle ? 'pointer' : 'default',
          }}
        >
          {meta?.ad ? (
            <Thumbnail ad={meta.ad} brand={brand} />
          ) : null}
        </div>
      </foreignObject>
      <text x={0} y={52} textAnchor="middle" fill="#6b7280" fontSize={10}
        onClick={() => { if (canOpen) onOpen(adId) }}
        style={{ cursor: canOpen ? 'pointer' : 'default' }}>
        {short}
      </text>
    </g>
  )
}

// Per-chart customization. Held in component state today (resets when the
// user closes the tab); not persisted across sessions because the metric
// pickers, hidden-ad list, and date window already drive the chart's
// memory.
export type ChartSettings = {
  // When true, dollar metrics get a "$" prefix on axis ticks and percent
  // metrics get a "%" suffix. Off by default would feel like a regression
  // since the prior YAxis was purely numeric.
  showCurrency: boolean
  // Metric keys whose series go on the secondary (right) Y-axis. Empty
  // list = single-axis chart.
  rightAxisMetrics: string[]
  // Rolling-mean overlays (line chart only). Multi-select. each entry adds
  // an N-day simple moving average per visible series. 'sma7' / 'sma14' /
  // 'sma30' / 'sma90'. Empty array = no overlay. The legacy 'trendline'
  // single-value field is retained on read for back-compat with stored
  // settings (see DEFAULT_CHART_SETTINGS).
  trendline?: 'none' | 'sma7' | 'sma14' | 'sma30' | 'sma90'
  trendlines: ('sma7' | 'sma14' | 'sma30' | 'sma90')[]
}

export const DEFAULT_CHART_SETTINGS: ChartSettings = {
  showCurrency: true,
  rightAxisMetrics: [],
  trendlines: [],
}

// Distinct color per SMA window so users can tell 7d / 14d / 30d / 90d
// overlays apart at a glance even when multiple are active.
export const SMA_COLORS: Record<string, string> = {
  sma7: '#f59e0b',
  sma14: '#10b981',
  sma30: '#3b82f6',
  sma90: '#8b5cf6',
}

// Compact axis-tick formatter that optionally adds currency / percent
// affixes based on the metric's format. Falls back to a plain number if
// no metric def is supplied (e.g. mixed-metric axis).
export function fmtAxis(v: any, def: MetricDef | undefined, showCurrency: boolean): string {
  const n = Number(v)
  if (!isFinite(n)) return ''
  const abs = Math.abs(n)
  let core: string
  if (abs >= 1_000_000) core = (n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1) + 'M'
  else if (abs >= 1_000) core = (n / 1_000).toFixed(abs >= 10_000 ? 0 : 1) + 'k'
  else core = abs >= 10 || abs === 0 ? Math.round(n).toString() : n.toFixed(1)
  if (def && showCurrency) {
    if (def.format === 'dollar') return '$' + core
    if (def.format === 'percent') return core + '%'
  }
  return core
}

export function ChartSettingsButton({
  settings, onChange, metricDefs, allowTrendline,
}: {
  settings: ChartSettings
  onChange: (s: ChartSettings) => void
  metricDefs: MetricDef[]
  allowTrendline?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [open])

  const toggleRight = (key: string) => {
    const set = new Set(settings.rightAxisMetrics)
    if (set.has(key)) set.delete(key); else set.add(key)
    onChange({ ...settings, rightAxisMetrics: Array.from(set) })
  }

  return (
    <div className="relative flex justify-end" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        title="Chart settings"
        className="text-text-muted hover:text-text-primary p-1 rounded hover:bg-black/[0.04]"
      >
        <Settings2 size={12} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-[70] bg-white rounded-lg shadow-[0_8px_24px_-6px_rgba(0,0,0,0.18)] border border-black/[0.08] py-2 min-w-[240px] text-xs">
          <div className="px-3 pb-1 text-[10px] uppercase tracking-widest text-text-muted">Display</div>
          <label className="flex items-center justify-between px-3 py-1 hover:bg-black/[0.02] cursor-pointer">
            <span className="text-text-secondary">Currency / % symbols</span>
            <input
              type="checkbox"
              checked={settings.showCurrency}
              onChange={e => onChange({ ...settings, showCurrency: e.target.checked })}
            />
          </label>
          {metricDefs.length > 0 && (
            <>
              <div className="border-t border-black/[0.05] mt-1.5 pt-1.5" />
              <div className="px-3 pb-1 text-[10px] uppercase tracking-widest text-text-muted">Right Y-axis</div>
              <div className="max-h-[180px] overflow-y-auto">
                {metricDefs.map(m => (
                  <label key={String(m.key)} className="flex items-center justify-between px-3 py-1 hover:bg-black/[0.02] cursor-pointer">
                    <span className="text-text-secondary truncate pr-2">{m.label}</span>
                    <input
                      type="checkbox"
                      checked={settings.rightAxisMetrics.includes(String(m.key))}
                      onChange={() => toggleRight(String(m.key))}
                    />
                  </label>
                ))}
              </div>
            </>
          )}
          {allowTrendline && (
            <>
              <div className="border-t border-black/[0.05] mt-1.5 pt-1.5" />
              <div className="px-3 pb-1 text-[10px] uppercase tracking-widest text-text-muted">SMA overlays</div>
              <div className="flex gap-1 px-3 py-1 flex-wrap">
                {(['sma7', 'sma14', 'sma30', 'sma90'] as const).map(t => {
                  const active = (settings.trendlines || []).includes(t)
                  return (
                    <button
                      key={t}
                      onClick={() => {
                        const cur = settings.trendlines || []
                        const next = active ? cur.filter(x => x !== t) : [...cur, t]
                        onChange({ ...settings, trendlines: next })
                      }}
                      className={`px-2.5 py-0.5 rounded-full text-[10px] flex items-center gap-1 ${
                        active
                          ? 'text-white border'
                          : 'bg-black/[0.04] text-text-secondary hover:bg-black/[0.06] border border-transparent'
                      }`}
                      style={active ? { background: SMA_COLORS[t], borderColor: SMA_COLORS[t] } : undefined}
                    >
                      {!active && <span className="inline-block w-2 h-2 rounded-full" style={{ background: SMA_COLORS[t] }} />}
                      {`${t.slice(3)}d`}
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function BarChartView({
  ads, metricDefs, usingSelection, onOpen, brand,
}: {
  ads: AdCreative[]
  metricDefs: MetricDef[]
  usingSelection: boolean
  onOpen: (id: string) => void
  brand?: string
}) {
  // Per-ad hide toggle. Clicking a thumbnail in the X-axis tick removes
  // that ad from the chart; clicking it again brings it back. Persists
  // only for the lifetime of the view.
  const [hiddenAdIds, setHiddenAdIds] = useState<Set<string>>(new Set())
  const [settings, setSettings] = useState<ChartSettings>(DEFAULT_CHART_SETTINGS)
  const toggleHidden = (id: string) => {
    setHiddenAdIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const visibleAds = useMemo(() => ads.filter(a => !hiddenAdIds.has(a.ad_id)), [ads, hiddenAdIds])
  // Pick a representative metric for each axis so the tick formatter knows
  // whether to render "$" / "%". Mixed-format axes fall back to plain
  // numbers (no affix).
  const axisRepresentative = (keys: Set<string>): MetricDef | undefined => {
    const matching = metricDefs.filter(m => keys.has(String(m.key)))
    if (!matching.length) return undefined
    const fmt = matching[0].format
    return matching.every(m => m.format === fmt) ? matching[0] : undefined
  }
  const rightKeys = new Set(settings.rightAxisMetrics)
  const leftKeys = new Set(metricDefs.map(m => String(m.key)).filter(k => !rightKeys.has(k)))
  const leftAxisDef = axisRepresentative(leftKeys)
  const rightAxisDef = axisRepresentative(rightKeys)
  const hasRightAxis = rightKeys.size > 0

  // Detect compare-period presence by checking any visible row for any
  // `prev_<m.key>` field. Backend stamps these only when a compare
  // window was passed to /api/ads/dashboard, so a single hit is enough.
  const hasCompare = useMemo(() => {
    for (const a of visibleAds) {
      for (const m of metricDefs) {
        if ((a as any)[`prev_${m.key}`] != null) return true
      }
    }
    return false
  }, [visibleAds, metricDefs])

  const data = useMemo(() => visibleAds.map(a => {
    const row: any = {
      name: shortLabel(a),
      ad_id: a.ad_id,
    }
    for (const m of metricDefs) {
      row[String(m.key)] = Number((a as any)[m.key] ?? 0)
      if (hasCompare) {
        // Paired prior-period bar. only emit when the row actually
        // has a prev value (avoids drawing zero-height fake bars on
        // ads that didn't exist in the compare window).
        const pv = (a as any)[`prev_${m.key}`]
        if (pv != null) row[`prev:${String(m.key)}`] = Number(pv)
      }
    }
    return row
  }), [visibleAds, metricDefs, hasCompare])

  // thumbMap lets the custom tick resolve an ad's thumbnail + name from the
  // x-axis category string (which is the shortLabel value).
  // Includes ALL ads (visible and hidden) so the hidden-ad toggle row
  // below can reuse the same lookup.
  const thumbMap = useMemo(() => {
    const out: Record<string, { ad: AdCreative; name: string; ad_id: string; color: string }> = {}
    ads.forEach((a, i) => {
      const label = shortLabel(a)
      out[label] = {
        ad: a,
        name: a.ad_name || a.ad_id,
        ad_id: a.ad_id,
        color: COLORS[i % COLORS.length],
      }
    })
    return out
  }, [ads])

  if (!metricDefs.length) {
    return (
      <div className="glass rounded-lg p-10 text-center text-text-muted text-sm">
        Pick at least one metric from the Metrics picker.
      </div>
    )
  }
  if (!ads.length) {
    return (
      <div className="glass rounded-lg p-10 text-center text-text-muted text-sm">
        No ads to chart.
      </div>
    )
  }

  const hiddenAds = ads.filter(a => hiddenAdIds.has(a.ad_id))

  return (
    <div className="flex flex-col gap-2">
      {!usingSelection && (
        <div className="text-[10px] text-text-muted px-1">
          Showing top {ads.length} ads. Check boxes on creatives to compare a specific set.
        </div>
      )}
      <div className="glass rounded-lg p-4" style={{ height: 500 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 10, right: hasRightAxis ? 40 : 20, left: 10, bottom: 80 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
            <XAxis dataKey="name" interval={0} height={80}
              tick={<ThumbnailBarTick thumbMap={thumbMap} onOpen={onOpen} onToggleHidden={toggleHidden} brand={brand} />} />
            <YAxis yAxisId="left" tick={{ fontSize: 10, fill: '#6b7280' }}
              tickFormatter={(v) => fmtAxis(v, leftAxisDef, settings.showCurrency)} />
            {hasRightAxis && (
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: '#6b7280' }}
                tickFormatter={(v) => fmtAxis(v, rightAxisDef, settings.showCurrency)} />
            )}
            <Tooltip
              formatter={(value: any, name: any) => {
                const def = metricDefs.find(d => d.label === name || String(d.key) === name)
                return [def ? fmtMetric(Number(value), def) : value, def?.label || name]
              }}
              contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid rgba(0,0,0,0.08)' }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {metricDefs.map((m, i) => (
              <Bar
                key={String(m.key)}
                dataKey={String(m.key)}
                name={m.label}
                yAxisId={rightKeys.has(String(m.key)) ? 'right' : 'left'}
                fill={COLORS[i % COLORS.length]}
              />
            ))}
            {/* Compare-period paired bars. one extra bar per metric,
                styled with the same color but at 35% opacity + a
                dashed stroke so it reads as "prior" without needing
                a separate legend entry. legendType="none" keeps the
                bottom strip from doubling in size. */}
            {hasCompare && metricDefs.map((m, i) => (
              <Bar
                key={`prev:${String(m.key)}`}
                dataKey={`prev:${String(m.key)}`}
                name={`${m.label} · prior`}
                yAxisId={rightKeys.has(String(m.key)) ? 'right' : 'left'}
                fill={COLORS[i % COLORS.length]}
                fillOpacity={0.35}
                stroke={COLORS[i % COLORS.length]}
                strokeDasharray="3 2"
                strokeWidth={1}
                legendType="none"
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ChartSettingsButton settings={settings} onChange={setSettings} metricDefs={metricDefs} />
      {hiddenAds.length > 0 && (
        <div className="flex items-center flex-wrap gap-1.5 px-1 pt-1">
          <span className="text-[10px] text-text-muted">Hidden:</span>
          {hiddenAds.map(a => (
            <button
              key={a.ad_id}
              onClick={() => toggleHidden(a.ad_id)}
              title={`Show ${a.ad_name || a.ad_id}`}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-black/[0.08] bg-white/60 hover:bg-white text-[10px] text-text-secondary"
            >
              <span className="w-3.5 h-3.5 rounded overflow-hidden">
                <Thumbnail ad={a} brand={brand} />
              </span>
              <span className="max-w-[120px] truncate">{shortLabel(a)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function LineChartView({
  ads, allSelected, metricDefs, timeseries, prevTimeseries, loading, error, usingSelection, onOpen,
}: {
  ads: AdCreative[]
  allSelected: number
  metricDefs: MetricDef[]
  timeseries: Record<string, any[]>
  // Prior-period timeseries with dates SHIFTED forward to align with
  // the current window's X axis. Empty when no compare range is set.
  // Rendered as dotted overlay lines per visible series.
  prevTimeseries?: Record<string, any[]>
  loading: boolean
  error: string | null
  usingSelection: boolean
  onOpen: (id: string) => void
}) {
  // Per-ad hide toggle (scoped to this view). Clicking a thumbnail in the
  // legend hides every line for that ad; click again to bring them back.
  const [hiddenAdIds, setHiddenAdIds] = useState<Set<string>>(new Set())

  // Inline scatter-style Y / Right-Y axis pickers. Replaces the prior
  // metricDefs × ads grid + the gear popover (SMA / right-axis-selector)
  // because the user wanted visual + interaction parity with scatter,
  // and explicitly said the moving-average overlays "weren't really
  // working out well anyway."
  //
  // X is always `date` for a line chart so we don't expose it. Y and
  // Right Y are persisted to localStorage so picks survive reloads -
  // matches the dot-plot picker.
  const numericLineMetrics = useMemo(
    () => ALL_METRICS.filter(m => m.format !== 'text' && !m.analysisField),
    []
  )
  const defaultY = metricDefs[0]?.key ? String(metricDefs[0].key) : 'spend'
  const [yKey, setYKey] = useState<string>(() => {
    try { return localStorage.getItem('ac.line.y') || defaultY } catch { return defaultY }
  })
  const [ryKey, setRyKey] = useState<string>(() => {
    try { return localStorage.getItem('ac.line.ry') || '' } catch { return '' }
  })
  useEffect(() => { try { localStorage.setItem('ac.line.y', yKey) } catch {} }, [yKey])
  useEffect(() => { try { localStorage.setItem('ac.line.ry', ryKey) } catch {} }, [ryKey])

  // X-axis aggregation. Date = daily (no aggregation); Week = weekly
  // sum starting Monday; Month = monthly sum. Visual parity with the
  // scatter's X picker; here it controls how we bucket the timeseries.
  type XGran = 'date' | 'week' | 'month'
  const [xGran, setXGran] = useState<XGran>(() => {
    try { return (localStorage.getItem('ac.line.x') as XGran) || 'date' } catch { return 'date' }
  })
  useEffect(() => { try { localStorage.setItem('ac.line.x', xGran) } catch {} }, [xGran])
  const xOptions = useMemo(() => ([
    { key: 'date',  label: 'Date',  format: 'text', group: 'Performance' as MetricGroup },
    { key: 'week',  label: 'Week',  format: 'text', group: 'Performance' as MetricGroup },
    { key: 'month', label: 'Month', format: 'text', group: 'Performance' as MetricGroup },
  ] as any), [])

  const yDef = METRICS_BY_KEY[yKey] || metricDefs[0] || ALL_METRICS[0]
  const ryDef = ryKey ? METRICS_BY_KEY[ryKey] : null
  // Build the metric list the chart actually plots from these picks
  // instead of the global metricDefs.
  const activeMetricDefs: MetricDef[] = useMemo(
    () => [yDef, ryDef].filter(Boolean) as MetricDef[],
    [yDef, ryDef]
  )

  // Moving-average overlays. Re-added in v0.3 as a third inline pill
  // (alongside Y / Right Y) per user request. earlier removal left
  // people without a way to see smoothed trend on noisy daily data.
  // Multi-select: pick any subset of 7d / 14d / 30d / 90d. Each
  // selected window adds a dashed colored line per series (no extra
  // legend entries. legend stays clean).
  type SmaKey = 'sma7' | 'sma14' | 'sma30' | 'sma90'
  const SMA_OPTIONS: { key: SmaKey; label: string }[] = [
    { key: 'sma7',  label: '7d MA' },
    { key: 'sma14', label: '14d MA' },
    { key: 'sma30', label: '30d MA' },
    { key: 'sma90', label: '90d MA' },
  ]
  const [smaActive, setSmaActive] = useState<Set<SmaKey>>(() => {
    try {
      const raw = localStorage.getItem('ac.line.sma')
      return new Set(raw ? (JSON.parse(raw) as SmaKey[]) : [])
    } catch { return new Set() }
  })
  useEffect(() => {
    try { localStorage.setItem('ac.line.sma', JSON.stringify(Array.from(smaActive))) } catch {}
  }, [smaActive])
  const toggleSma = (k: SmaKey) => {
    setSmaActive(prev => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k); else next.add(k)
      return next
    })
  }
  const toggleHidden = (id: string) => {
    setHiddenAdIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  // Convert a YYYY-MM-DD into the bucket key for the active granularity.
  //   date  → YYYY-MM-DD (passthrough)
  //   week  → YYYY-Www  (Monday-anchored ISO-ish week label)
  //   month → YYYY-MM
  const bucketFor = (d: string): string => {
    if (xGran === 'date') return d
    const dt = new Date(d + 'T00:00:00')
    if (isNaN(dt.getTime())) return d
    if (xGran === 'month') {
      const m = String(dt.getMonth() + 1).padStart(2, '0')
      return `${dt.getFullYear()}-${m}`
    }
    // Week: shift to Monday of that ISO week, format as YYYY-MM-DD of Monday.
    const day = dt.getDay() || 7  // Sun=7
    const monday = new Date(dt)
    monday.setDate(dt.getDate() - (day - 1))
    const mm = String(monday.getMonth() + 1).padStart(2, '0')
    const dd = String(monday.getDate()).padStart(2, '0')
    return `${monday.getFullYear()}-${mm}-${dd}`
  }

  // Build a wide row per bucket: { date, "<ad_id>:<metric>": value, ... }
  // Driven by activeMetricDefs (Y + optional Right Y), not the global
  // metricDefs picker. When xGran ≠ date, daily counter metrics sum
  // across the bucket; ratio metrics average. The MetricDef.format
  // gives us the agg hint.
  const { data, lineDefs } = useMemo(() => {
    const isRatioFormat = (m: MetricDef) => m.format === 'percent' || m.format === 'decimal'
    const bucketSet = new Set<string>()
    // Two-pass: first sum, second divide for ratio metrics.
    const byBucket: Record<string, any> = {}
    const counts: Record<string, Record<string, number>> = {}
    for (const aid of Object.keys(timeseries)) {
      for (const r of timeseries[aid] || []) {
        const bk = bucketFor(r.date)
        bucketSet.add(bk)
        if (!byBucket[bk]) byBucket[bk] = { date: bk }
        if (!counts[bk]) counts[bk] = {}
      }
    }
    for (const ad of ads) {
      const series = timeseries[ad.ad_id] || []
      for (const r of series) {
        const bk = bucketFor(r.date)
        for (const m of activeMetricDefs) {
          const key = `${ad.ad_id}:${String(m.key)}`
          const cur = Number(byBucket[bk][key] ?? 0)
          byBucket[bk][key] = cur + Number(r[String(m.key)] ?? 0)
          counts[bk][key] = (counts[bk][key] || 0) + 1
        }
      }
    }
    // Prior-period overlay. shifted dates already align with `bk`.
    // Same accumulation pattern + counts so ratio metrics average too.
    if (prevTimeseries) {
      for (const ad of ads) {
        const series = prevTimeseries[ad.ad_id] || []
        for (const r of series) {
          const bk = bucketFor(r.date)
          if (!byBucket[bk]) byBucket[bk] = { date: bk }
          if (!counts[bk]) counts[bk] = {}
          for (const m of activeMetricDefs) {
            const key = `prev:${ad.ad_id}:${String(m.key)}`
            const cur = Number(byBucket[bk][key] ?? 0)
            byBucket[bk][key] = cur + Number(r[String(m.key)] ?? 0)
            counts[bk][key] = (counts[bk][key] || 0) + 1
          }
        }
      }
    }
    // For ratio metrics, divide by sample count to average. Same for
    // both current + prior series.
    if (xGran !== 'date') {
      for (const bk of bucketSet) {
        for (const ad of ads) {
          for (const m of activeMetricDefs) {
            if (!isRatioFormat(m)) continue
            const k1 = `${ad.ad_id}:${String(m.key)}`
            const k2 = `prev:${ad.ad_id}:${String(m.key)}`
            const n1 = counts[bk]?.[k1] || 0
            const n2 = counts[bk]?.[k2] || 0
            if (n1 > 0) byBucket[bk][k1] = Number(byBucket[bk][k1] ?? 0) / n1
            if (n2 > 0) byBucket[bk][k2] = Number(byBucket[bk][k2] ?? 0) / n2
          }
        }
      }
    }
    const dates = Array.from(bucketSet).sort()
    const rows = dates.map(d => byBucket[d])

    // Each (ad × metric) is its own line. capped upstream at MAX_CHART_LINES
    const lines: {
      key: string; name: string; ad_id: string; metric: MetricDef;
      color: string; thumb?: string | null; adName: string;
    }[] = []
    let colorIdx = 0
    for (const ad of ads) {
      for (const m of activeMetricDefs) {
        lines.push({
          key: `${ad.ad_id}:${String(m.key)}`,
          name: activeMetricDefs.length > 1 ? `${shortLabel(ad)} · ${m.label}` : shortLabel(ad),
          ad_id: ad.ad_id,
          metric: m,
          color: COLORS[colorIdx % COLORS.length],
          thumb: bestThumb(ad),
          adName: ad.ad_name || ad.ad_id,
        })
        colorIdx++
      }
    }
    return { data: rows, lineDefs: lines }
  }, [ads, activeMetricDefs, timeseries, prevTimeseries, xGran])

  // Axis defs are now trivially the explicit picks. no more "pick the
  // representative metric across a mixed set" guesswork.
  const leftAxisDef: MetricDef | undefined = yDef
  const rightAxisDef: MetricDef | undefined = ryDef || undefined
  const hasRightAxis = !!ryDef
  const rightKeys = new Set<string>(ryDef ? [String(ryDef.key)] : [])

  // SMA overlays. compute once per (data, lineDefs, active windows).
  // Pays nothing when no windows are active (returns data untouched).
  //
  // Previously we only wrote the SMA value once `win.length === W`,
  // which meant a 7d MA over a 3-day visible range showed nothing
  // (the line "chopped" until day W). Now we emit a partial average
  // for the early points using whatever data is available so far,
  // then settle into the full W-window mean. The line is continuous
  // from day 1, with the early-window values labeled "partial" in
  // the tooltip if needed.
  const dataWithTrend = useMemo(() => {
    if (smaActive.size === 0) return data
    const out = data.map(r => ({ ...r }))
    for (const tl of smaActive) {
      const W = parseInt(tl.slice(3), 10)
      for (const l of lineDefs) {
        const win: number[] = []
        const sk = `${l.key}:${tl}`
        for (let i = 0; i < out.length; i++) {
          const v = Number(out[i][l.key] ?? 0)
          win.push(v)
          if (win.length > W) win.shift()
          // Always emit. partial average when win.length < W, full
          // mean once we have W samples.
          out[i][sk] = win.reduce((a, b) => a + b, 0) / win.length
        }
      }
    }
    return out
  }, [data, lineDefs, Array.from(smaActive).sort().join(',')])

  if (!activeMetricDefs.length) {
    return (
      <div className="glass rounded-lg p-10 text-center text-text-muted text-sm">
        Pick a Y-axis metric to plot.
      </div>
    )
  }
  if (!ads.length) {
    return (
      <div className="glass rounded-lg p-10 text-center text-text-muted text-sm">
        Select at least one creative to plot.
      </div>
    )
  }

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const fmtDate = (v: any) => {
    // YYYY-MM-DD → "Jan 5" (Date or Week-anchor bucket)
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const d = new Date(v + 'T00:00:00')
      const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`
      return xGran === 'week' ? `wk ${base}` : base
    }
    // YYYY-MM → "Jan '25" (Month bucket)
    if (typeof v === 'string' && /^\d{4}-\d{2}$/.test(v)) {
      const [y, m] = v.split('-').map(Number)
      return `${MONTHS[(m || 1) - 1]} '${String(y).slice(2)}`
    }
    return String(v)
  }

  const warnings: string[] = []
  if (allSelected > MAX_CHART_LINES) {
    warnings.push(`Showing first ${MAX_CHART_LINES} of ${allSelected} selected ads (line charts get noisy above that).`)
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Inline axis pickers. same pill style as the scatter X/Y/Size
          row. X picks the bucket granularity (Date/Week/Month). The
          SMA pill is a small multi-select for moving-average overlays
          (7d / 14d / 30d / 90d). */}
      <div className="flex items-center gap-2 flex-wrap">
        <AxisPicker
          label="X"
          value={xGran}
          onChange={v => setXGran((v as XGran) || 'date')}
          options={xOptions}
        />
        <AxisPicker label="Y" value={yKey} onChange={setYKey} options={numericLineMetrics} />
        <AxisPicker
          label="Right Y"
          value={ryKey}
          onChange={setRyKey}
          options={numericLineMetrics}
          clearable
          placeholder="None"
        />
        <SmaPicker
          options={SMA_OPTIONS}
          active={smaActive}
          onToggle={toggleSma}
          colorFor={(k: SmaKey) => SMA_COLORS[k]}
        />
      </div>
      {!usingSelection && (
        <div className="text-[10px] text-text-muted px-1">
          Showing top {ads.length} ads. Check boxes on creatives to plot a specific set.
        </div>
      )}
      {warnings.map((w, i) => (
        <div key={i} className="glass rounded-lg p-2 text-[10px] text-amber-700 bg-amber-50/50">
          {w}
        </div>
      ))}
      {error && (
        <div className="glass rounded-lg p-3 text-xs text-red-600">{error}</div>
      )}
      {loading ? (
        <div className="glass rounded-lg p-20 flex items-center justify-center">
          <Loader2 size={20} className="animate-spin text-text-muted" />
        </div>
      ) : !data.length ? (
        <div className="glass rounded-lg p-10 text-center text-text-muted text-sm">
          No daily data returned for these creatives.
        </div>
      ) : (
        <div className="glass rounded-lg p-4" style={{ height: 480 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={dataWithTrend} margin={{ top: 10, right: hasRightAxis ? 40 : 20, left: 10, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
              <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fontSize: 10, fill: '#6b7280' }} />
              <YAxis yAxisId="left" tick={{ fontSize: 10, fill: '#6b7280' }}
                tickFormatter={(v) => fmtAxis(v, leftAxisDef, true)} />
              {hasRightAxis && (
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: '#6b7280' }}
                  tickFormatter={(v) => fmtAxis(v, rightAxisDef, true)} />
              )}
              <Tooltip
                labelFormatter={fmtDate}
                formatter={(value: any, name: any) => {
                  const line = lineDefs.find(l => l.name === name)
                  return [line ? fmtMetric(Number(value), line.metric) : value, name]
                }}
                contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid rgba(0,0,0,0.08)' }}
              />
              <Legend
                wrapperStyle={{ fontSize: 10 }}
                content={
                  <ThumbnailLineLegend
                    lineDefs={lineDefs}
                    onOpen={onOpen}
                    hiddenAdIds={hiddenAdIds}
                    onToggleHidden={toggleHidden}
                  />
                }
              />
              {lineDefs
                .filter(l => !hiddenAdIds.has(l.ad_id))
                .map(l => {
                  const yId = rightKeys.has(String(l.metric.key)) ? 'right' : 'left'
                  return (
                    <Line key={l.key} dataKey={l.key} name={l.name} yAxisId={yId}
                      stroke={l.color} strokeWidth={1.5} dot={false}
                      connectNulls />
                  )
                })}
              {/* Prior-period overlay. dotted (3 1) so it's visually
                  distinct from the SMA dash (4 3). Same color as the
                  current-period line but at 50% opacity. Hidden from
                  the legend; only renders when a compare window was
                  fetched (prevTimeseries non-empty). */}
              {prevTimeseries && Object.keys(prevTimeseries).length > 0 && lineDefs
                .filter(l => !hiddenAdIds.has(l.ad_id))
                .map(l => {
                  const yId = rightKeys.has(String(l.metric.key)) ? 'right' : 'left'
                  return (
                    <Line
                      key={`prev:${l.key}`}
                      dataKey={`prev:${l.key}`}
                      name={`${l.name} · prior`}
                      yAxisId={yId}
                      stroke={l.color}
                      strokeWidth={1.25}
                      strokeDasharray="2 3"
                      strokeOpacity={0.5}
                      dot={false}
                      connectNulls
                      legendType="none"
                    />
                  )
                })}
              {/* SMA overlay lines. one dashed line per (visible series ×
                  selected window). legendType="none" keeps them out of
                  the legend; the picker pill above is the legend. */}
              {Array.from(smaActive).flatMap(tl =>
                lineDefs
                  .filter(l => !hiddenAdIds.has(l.ad_id))
                  .map(l => {
                    const yId = rightKeys.has(String(l.metric.key)) ? 'right' : 'left'
                    const w = tl.slice(3)
                    return (
                      <Line
                        key={`${l.key}:${tl}`}
                        dataKey={`${l.key}:${tl}`}
                        name={`${l.name} · ${w}d MA`}
                        yAxisId={yId}
                        stroke={SMA_COLORS[tl]}
                        strokeWidth={1.5}
                        strokeDasharray="4 3"
                        strokeOpacity={0.85}
                        dot={false}
                        connectNulls
                        legendType="none"
                      />
                    )
                  })
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

// Custom recharts legend. shows a tiny thumbnail next to each ad's lines.
// Grouped by ad so (ad × metric) lines share one thumbnail entry. The
// thumbnail + ad-name are clickable to open the detail panel.
function ThumbnailLineLegend({
  lineDefs, onOpen, hiddenAdIds, onToggleHidden,
}: {
  lineDefs: {
    key: string; name: string; ad_id: string; metric: MetricDef;
    color: string; thumb?: string | null; adName: string;
  }[]
  onOpen?: (ad_id: string) => void
  // When provided, the legend renders a "show/hide" affordance. clicking
  // the thumbnail toggles the ad in/out of the chart. Click on the name
  // continues to open the detail panel.
  hiddenAdIds?: Set<string>
  onToggleHidden?: (ad_id: string) => void
}) {
  const groups = useMemo(() => {
    const map = new Map<string, {
      ad_id: string; adName: string; thumb?: string | null;
      items: { name: string; color: string }[]
    }>()
    for (const l of lineDefs) {
      let g = map.get(l.ad_id)
      if (!g) {
        g = { ad_id: l.ad_id, adName: l.adName, thumb: l.thumb, items: [] }
        map.set(l.ad_id, g)
      }
      g.items.push({ name: l.metric.label, color: l.color })
    }
    return Array.from(map.values())
  }, [lineDefs])

  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1.5 justify-center px-2 pt-2 text-[10px]">
      {groups.map(g => {
        const hidden = !!hiddenAdIds?.has(g.ad_id)
        const canToggle = !!onToggleHidden
        return (
          <div key={g.ad_id} className="flex items-center gap-1.5 min-w-0 max-w-[220px]"
            style={{ opacity: hidden ? 0.35 : 1 }}>
            <button
              type="button"
              onClick={() => canToggle ? onToggleHidden!(g.ad_id) : onOpen?.(g.ad_id)}
              title={canToggle ? (hidden ? `Show ${g.adName}` : `Hide ${g.adName}`) : `Open ${g.adName}`}
              className="w-5 h-5 rounded flex-shrink-0 overflow-hidden bg-black/[0.06] cursor-pointer hover:ring-2 hover:ring-[#B7410E]/40 transition"
              style={{ boxShadow: `inset 0 0 0 1px rgba(0,0,0,0.08)` }}
            >
              {g.thumb ? (
                <img src={g.thumb} alt="" className="w-full h-full object-cover" />
              ) : null}
            </button>
            <div className="min-w-0">
              <button
                type="button"
                onClick={() => onOpen?.(g.ad_id)}
                className="text-text-primary truncate leading-tight text-left hover:text-[#B7410E]"
                title={g.adName}
              >
                {g.adName.length > 22 ? g.adName.slice(0, 21) + '…' : g.adName}
              </button>
              <div className="flex flex-wrap gap-1 leading-tight">
                {g.items.map((it, i) => (
                  <span key={i} className="inline-flex items-center gap-1 text-text-muted">
                    <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: it.color }} />
                    {it.name}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sort control. shared across all 4 views. Pill opens a popover with the
// currently-picked metrics (plus ad_name / created_time) and an asc/desc
// toggle; selection persists to localStorage via the parent.
// ---------------------------------------------------------------------------

const SortPill = React.forwardRef<
  HTMLButtonElement,
  {
    sort: string
    sortDir: 'asc' | 'desc'
    active?: boolean
    onClick: () => void
  }
>(function SortPill({ sort, sortDir, active, onClick }, ref) {
  const def = METRICS_BY_KEY[sort]
  const fieldLabel =
    sort === 'ad_name' ? 'Ad name' :
    sort === 'created_time' ? 'Created' :
    def?.label || sort
  return (
    <button
      ref={ref}
      onClick={onClick}
      className={`h-7 px-2.5 rounded-full text-[11px] flex items-center gap-1.5 transition-colors ${
        active
          ? 'bg-[#B7410E]/10 border border-[#B7410E]/30 text-[#b55719]'
          : 'glass glass-hover text-text-secondary'
      }`}
      title={`Sorted by ${fieldLabel} (${sortDir})`}
    >
      <ArrowUpDown size={10} />
      Sort: {fieldLabel}
      {sortDir === 'desc' ? <ArrowDown size={9} /> : <ArrowUp size={9} />}
    </button>
  )
})

function SortPopover({
  anchorRef, metrics, sort, sortDir, search, onSearchChange, onChange, onClose,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>
  metrics: string[]
  sort: string
  sortDir: 'asc' | 'desc'
  search: string
  onSearchChange: (s: string) => void
  onChange: (field: string, dir: 'asc' | 'desc') => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  // Position below the pill using viewport-fixed coordinates. The previous
  // implementation used `position: absolute` + window.scrollY, which only
  // worked when no positioned ancestor existed; inside the dashboard's
  // nested relative containers it would land hundreds of pixels off. With
  // `position: fixed` the popover anchors directly to the viewport, so
  // rect.bottom (the pill's bottom edge in viewport space) is the correct y.
  useEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    const WIDTH = 260
    const top = rect.bottom + 6
    let left = rect.left
    const vw = window.innerWidth
    if (left + WIDTH > vw - 12) left = Math.max(12, vw - WIDTH - 12)
    setPos({ top, left })
  }, [anchorRef])

  // Close on outside click, anchored from the sort pill.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    window.addEventListener('mousedown', onDoc)
    return () => window.removeEventListener('mousedown', onDoc)
  }, [anchorRef, onClose])

  // The options list is every picked metric + ad_name + created_time.
  // Deduped in case the user somehow gets duplicates from a saved report.
  // NOTE: keep this hook above the `if (!pos) return null` early return -
  // React requires a stable hook count across renders.
  const options = useMemo(() => {
    const seen = new Set<string>()
    const out: { key: string; label: string }[] = []
    for (const k of metrics) {
      if (seen.has(k)) continue
      seen.add(k)
      const d = METRICS_BY_KEY[k]
      if (!d) continue
      if (d.format === 'text') continue
      out.push({ key: k, label: d.label })
    }
    out.push({ key: 'ad_name', label: 'Ad name' })
    out.push({ key: 'created_time', label: 'Created date' })
    const q = search.trim().toLowerCase()
    return q ? out.filter(o => o.label.toLowerCase().includes(q)) : out
  }, [metrics, search])

  if (!pos) return null

  return (
    <div
      ref={ref}
      className="bg-white rounded-lg shadow-xl border border-black/[0.06] max-h-[360px] overflow-y-auto py-1"
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: 260, zIndex: 10100 }}
    >
      {/* Search */}
      <div className="px-2 py-1.5 sticky top-0 bg-white z-10 border-b border-black/[0.04]">
        <div className="relative">
          <Search size={10} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            placeholder="Search metrics..."
            autoFocus
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            className="w-full bg-white/60 border border-black/[0.08] rounded-lg pl-6 pr-2 py-1 text-xs focus:outline-none"
          />
        </div>
      </div>

      {/* Asc/Desc toggle */}
      <div className="px-2 py-1.5 flex items-center gap-1 border-b border-black/[0.04]">
        <button
          onClick={() => onChange(sort, 'desc')}
          className={`flex-1 flex items-center justify-center gap-1 text-[11px] px-2 py-1 rounded ${
            sortDir === 'desc' ? 'bg-[#B7410E]/10 text-[#b55719]' : 'text-text-muted hover:bg-black/[0.03]'
          }`}
        >
          <ArrowDown size={10} /> Descending
        </button>
        <button
          onClick={() => onChange(sort, 'asc')}
          className={`flex-1 flex items-center justify-center gap-1 text-[11px] px-2 py-1 rounded ${
            sortDir === 'asc' ? 'bg-[#B7410E]/10 text-[#b55719]' : 'text-text-muted hover:bg-black/[0.03]'
          }`}
        >
          <ArrowUp size={10} /> Ascending
        </button>
      </div>

      {/* Options. radio-style rows */}
      {options.length === 0 ? (
        <div className="px-3 py-3 text-[11px] text-text-muted">No matches.</div>
      ) : (
        options.map(o => (
          <label
            key={o.key}
            className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-black/[0.03] cursor-pointer"
          >
            <input
              type="radio"
              name="atelier-ads-sort"
              checked={sort === o.key}
              onChange={() => onChange(o.key, sortDir)}
              className="accent-[#B7410E]"
            />
            <span className={sort === o.key ? 'text-text-primary font-medium' : 'text-text-secondary'}>
              {o.label}
            </span>
          </label>
        ))
      )}
    </div>
  )
}
