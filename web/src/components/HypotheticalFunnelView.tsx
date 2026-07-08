// =============================================================================
// HypotheticalFunnelView. The standalone "funnel viewer" — a smoother, more
// draggable rebuild of FunnelView that places each creative by its REAL
// spend mix from Meta's `user_segment_key` breakdown, not a frequency guess.
//
// Lanes (top → bottom, narrowing into a funnel silhouette):
//   TOF   — New (prospecting cohort)                          widest
//   MOF   — Engaged cohort, lower saturation (warming)
//   BOF   — Engaged cohort, higher saturation (hit harder — NOT customers)
//   REACT — Reactivation = the EXISTING-customer cohort (retention layer)
//
// Cohort → lane: prospecting→TOF, existing→Reactivation. The ENGAGED cohort
// splits MOF vs BOF by an ACCOUNT-RELATIVE percentile "saturation" score
// (freq + CPMr percentile ranks within this view). Ads with no measured cohort
// (unknown / no segment delivery) are ranged across TOF/MOF/BOF by that same
// saturation score, and render with a dashed "estimated" outline so it's
// honest about which placements are measured vs inferred.
//
// Absolute freq/CPMr numbers are never used (a freq of 3 means fatigue for
// cold but health for warm) and never shown; clicking a creative deep-links
// to that one ad in Meta Ads Manager.
//
// Draggable: cards auto-flow into their lane. Drag a card to another lane to
// RE-TAG it (override, remembered); drop anywhere to PIN it (remembered).
// Both persist per brand. Pan the empty canvas; corner zoom toggle or
// ⌘/Ctrl+scroll to zoom.
// =============================================================================

import { useMemo, useRef, useState, useEffect, useCallback } from 'react'
import { Plus, Minus, Maximize2 } from 'lucide-react'
import { Thumbnail, type AdCreative } from './AdAnalysisView'

interface Props {
  ads: AdCreative[]
  brand: string
  /** Container height. Number → px. Default fills its parent ('100%'). */
  height?: number | string
}

type Lane = 'TOF' | 'MOF' | 'BOF' | 'REACT'
const LANES: Lane[] = ['TOF', 'MOF', 'BOF', 'REACT']

const LANE_LABEL: Record<Lane, string> = {
  TOF: 'TOP OF FUNNEL',
  MOF: 'MIDDLE OF FUNNEL',
  BOF: 'BOTTOM OF FUNNEL',
  REACT: 'REACTIVATION',
}
const LANE_SUB: Record<Lane, string> = {
  TOF: 'New · prospecting',
  MOF: 'Engaged · warming',
  BOF: 'Engaged · saturated (high freq / CPMr)',
  REACT: 'Existing customers',
}
// Taper hard so the stack reads as a funnel silhouette (wide top → narrow).
const LANE_WIDTH_PCT: Record<Lane, number> = {
  TOF: 1.0, MOF: 0.58, BOF: 0.38, REACT: 0.38,
}

const MAX_CANVAS_W = 1400
// Floor: the narrowest lane (38% width) must still hold one 104px card, so
// keep ≥ ~280px. Below this the container is narrower than the canvas anyway,
// so the canvas never actually exceeds the viewport.
const MIN_CANVAS_W = 280
const CARD_W = 104
const CARD_H = 138
const CARD_GAP = 14
const LANE_GAP_Y = 26
const MIN_ZOOM = 0.25
const MAX_ZOOM = 2.5

type SegSpend = { prospecting: number; engaged: number; existing: number; unknown: number }

interface Card {
  key: string
  rep: AdCreative
  seg: SegSpend
  total: number
  dominant: keyof SegSpend
  freq: number
  cpmr: number
  members: number
  reactivation: boolean
  estimated: boolean   // true → lane came from freq/CPMr, not measured segments
  autoLane: Lane
}

function segOf(ad: AdCreative): SegSpend {
  const s = ad.segment_spend || {}
  return {
    prospecting: Number(s.prospecting) || 0,
    engaged: Number(s.engaged) || 0,
    existing: Number(s.existing) || 0,
    unknown: Number(s.unknown) || 0,
  }
}

function dominantOf(s: SegSpend): keyof SegSpend {
  const entries: [keyof SegSpend, number][] = [
    ['prospecting', s.prospecting], ['engaged', s.engaged],
    ['existing', s.existing], ['unknown', s.unknown],
  ]
  entries.sort((a, b) => b[1] - a[1])
  return entries[0][1] > 0 ? entries[0][0] : 'unknown'
}

function quantile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] * (1 - (idx - lo)) + sorted[hi] * (idx - lo)
}

function adsManagerUrl(ad: AdCreative): string | null {
  const numeric = String((ad as any).account_id || '').replace(/^act_/i, '')
  if (!numeric) return null
  const p = new URLSearchParams()
  p.set('act', numeric)
  if (ad.campaign_id) p.set('selected_campaign_ids', String(ad.campaign_id))
  if (ad.adset_id) p.set('selected_adset_ids', String(ad.adset_id))
  p.set('selected_ad_ids', String(ad.ad_id))
  p.set('nav_source', 'no_referrer')
  return `https://adsmanager.facebook.com/adsmanager/manage/ads?${p.toString()}`
}


// Inline SVG icons (this lucide build has flaky exports — see Download issue).
const ICON_EYE = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" />
  </svg>
)
const ICON_META = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </svg>
)
const ICON_CLOSE = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
)
const ICON_CHEVRON_L = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
)
const ICON_CHEVRON_R = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
)

export function HypotheticalFunnelView({ ads, brand, height = '100%' }: Props) {
  // -------------------------------------------------------------------------
  // De-dupe creatives; aggregate segment spend; assign a lane. Ads with real
  // segment delivery are placed by segment; the rest fall back to freq/CPMr.
  // -------------------------------------------------------------------------
  const cards: Card[] = useMemo(() => {
    // Collapse the same creative run as multiple ads. Content-hash is best but
    // is often null on fresh live pulls (backend hasn't hashed the thumb yet),
    // so fall back to post story-id and the image asset PATH (Meta signs the
    // query string differently per ad, but the path is the same asset) before
    // giving up per-ad — otherwise identical creatives stack.
    const imgPath = (ad: AdCreative): string => {
      const u = ad.image_url_hd || ad.image_url || ad.thumbnail_url || ''
      try { const p = new URL(u, 'https://x').pathname; return p.length > 6 ? p : '' } catch { return '' }
    }
    // Aggressive fallback: when we have NO reliable content hash, collapse by
    // normalized ad NAME. This catches re-uploaded / re-run identical creatives
    // (same name, but distinct video_ids or freshly-signed asset URLs) that
    // nothing else can. Only fires when image_content_sha is absent and the
    // name is specific enough (≥6 chars) — it can occasionally over-merge two
    // genuinely different creatives that happen to share a name.
    const nameKey = (ad: AdCreative): string => {
      const n = (ad.ad_name || '').trim().toLowerCase().replace(/\s+/g, ' ')
      return n.length >= 6 ? `n:${n}` : ''
    }
    const dedupeKey = (ad: AdCreative): string => {
      if (ad.image_content_sha) return `s:${ad.image_content_sha}`
      const nk = nameKey(ad)
      if (nk) return nk
      if (ad.video_id) return `v:${ad.video_id}`
      if (ad.image_hash) return `h:${ad.image_hash}`
      if (ad.effective_object_story_id) return `p:${ad.effective_object_story_id}`
      const path = imgPath(ad)
      if (path) return `u:${path}`
      return `a:${ad.ad_id}`
    }
    const hasImage = (ad: AdCreative) => !!(
      ad.image_hash || ad.image_url_hd || ad.image_url || ad.thumbnail_url
      || ad.video_id || ad.effective_object_story_id
    )
    type G = {
      rep: AdCreative; seg: SegSpend; repSpend: number
      spend: number; impr: number; reach: number
      freqSum: number; freqW: number; members: number; react: boolean
    }
    const groups = new Map<string, G>()
    for (const ad of ads) {
      if (!hasImage(ad)) continue
      const key = dedupeKey(ad)
      const seg = segOf(ad)
      const segTot = seg.prospecting + seg.engaged + seg.existing + seg.unknown
      const spend = Number(ad.spend) || segTot
      const impr = Number(ad.impressions) || 0
      const reach = Number(ad.reach) || 0
      const freq = Number(ad.frequency) || 0
      const g = groups.get(key)
      if (!g) {
        groups.set(key, {
          rep: ad, seg: { ...seg }, repSpend: spend,
          spend, impr, reach,
          freqSum: freq * spend, freqW: spend, members: 1, react: !!ad.reactivation,
        })
      } else {
        if (spend > g.repSpend) { g.rep = ad; g.repSpend = spend }
        g.seg.prospecting += seg.prospecting
        g.seg.engaged += seg.engaged
        g.seg.existing += seg.existing
        g.seg.unknown += seg.unknown
        g.spend += spend; g.impr += impr; g.reach += reach
        g.freqSum += freq * spend; g.freqW += spend; g.members += 1
        g.react = g.react || !!ad.reactivation
      }
    }

    // First pass: shape each group; compute freq + CPMr for the fallback.
    type Pre = Omit<Card, 'autoLane'>
    const pre: Pre[] = []
    for (const [key, g] of groups) {
      const total = g.seg.prospecting + g.seg.engaged + g.seg.existing + g.seg.unknown
      const dominant = dominantOf(g.seg)
      const freq = g.freqW > 0 ? g.freqSum / g.freqW
        : (g.reach > 0 ? g.impr / g.reach : 0)
      const directCpmr = Number((g.rep as any).cost_per_1k_ac_reached) || 0
      const cpmr = directCpmr > 0 ? directCpmr : (g.reach > 0 ? (g.spend / g.reach) * 1000 : 0)
      pre.push({
        key, rep: g.rep, seg: g.seg, total, dominant, freq, cpmr,
        members: g.members, reactivation: g.react,
        estimated: total <= 0,
      })
    }

    // Frequency + CPMr are meaningless as absolute numbers — a freq of 3 is
    // fatigue for cold prospecting but healthy for warm retargeting. So we
    // rank each ad by its PERCENTILE POSITION within THIS ACCOUNT/view (the
    // industry-standard normalization) and combine the two into a 0..1
    // "saturation" score. Higher saturation = hit harder relative to peers.
    const freqSorted = pre.map(p => p.freq).filter(f => f > 0).sort((a, b) => a - b)
    const cpmrSorted = pre.map(p => p.cpmr).filter(c => c > 0).sort((a, b) => a - b)
    const pctRank = (sorted: number[], v: number): number => {
      if (!sorted.length || !(v > 0)) return 0.5
      let c = 0
      for (const x of sorted) { if (x <= v) c++; else break }
      return c / sorted.length
    }
    const saturation = (p: Pre): number =>
      (pctRank(freqSorted, p.freq) + pctRank(cpmrSorted, p.cpmr)) / 2

    // Ads with no cohort signal (no segment delivery, or unknown-dominant):
    // range across TOF/MOF/BOF by account-relative saturation tertiles.
    const rangeBySaturation = (p: Pre): Lane => {
      const s = saturation(p)
      if (s < 1 / 3) return 'TOF'
      if (s < 2 / 3) return 'MOF'
      return 'BOF'
    }

    // SHARE-BASED placement (not winner-take-all). Meta blends every creative
    // across cohorts; a 37% prospecting / 42% engaged ad is NOT an "engaged
    // ad" — it's a near-even cold/warm creative. So we place by the actual
    // mix, on the cohort axis only (unknown is off-axis → freq/CPMr range).
    //
    //   • existing share is the largest cohort → REACTIVATION (existing = the
    //     reactivation layer; NOT the targeting flag, which false-positives)
    //   • otherwise "warmth" = engaged / (prospecting + engaged):
    //       warmth < 0.5  → TOF  (more cold than warm — an acquisition creative)
    //       warmth ≥ 0.5  → engaged zone → MOF (warming) vs BOF (saturated),
    //                        split by account-relative freq/CPMr percentile.
    const cohortShares = (p: Pre): { pr: number; en: number; ex: number } | null => {
      const t = p.seg.prospecting + p.seg.engaged + p.seg.existing
      if (t <= 0) return null
      return { pr: p.seg.prospecting / t, en: p.seg.engaged / t, ex: p.seg.existing / t }
    }
    const warmthOf = (sh: { pr: number; en: number }): number => {
      const pe = sh.pr + sh.en
      return pe > 0 ? sh.en / pe : 0
    }
    const isExistingTop = (sh: { pr: number; en: number; ex: number }) =>
      sh.ex >= sh.pr && sh.ex >= sh.en && sh.ex > 0
    const isEngagedTop = (sh: { pr: number; en: number; ex: number }) =>
      sh.en > sh.pr && sh.en >= sh.ex && sh.en > 0

    // Model (cohort by real spend SHARE, then split by metric PERCENTILES):
    //   • existing is the top cohort           → REACTIVATION
    //   • engaged is the top cohort            → MOF vs BOF, split at the MEDIAN
    //     saturation *among engaged-dominant creatives* (a RELATIVE split, so
    //     BOF always populates when engaged creatives exist — the more
    //     saturated half by freq/CPMr percentile goes to BOF)
    //   • prospecting (new) is the top cohort  → usually TOF, but MOF when the
    //     audience already skews warm (engaged is ≥ NEW_MOF_WARMTH of the
    //     cold+warm mix) — "new can be MOF depending on audience definitions"
    const engSats = pre
      .filter(p => {
        if (p.estimated || p.dominant === 'unknown') return false
        const sh = cohortShares(p)
        return !!sh && isEngagedTop(sh)
      })
      .map(saturation).sort((a, b) => a - b)
    const engMedian = engSats.length ? quantile(engSats, 0.5) : 0.5
    const NEW_MOF_WARMTH = 0.4

    const laneForMeasured = (p: Pre): Lane => {
      if (p.dominant === 'unknown') return rangeBySaturation(p)
      const sh = cohortShares(p)
      if (!sh) return rangeBySaturation(p)
      if (isExistingTop(sh)) return 'REACT'
      if (isEngagedTop(sh)) return saturation(p) >= engMedian ? 'BOF' : 'MOF'
      // prospecting-dominant
      return warmthOf(sh) >= NEW_MOF_WARMTH ? 'MOF' : 'TOF'
    }

    return pre.map(p => ({
      ...p,
      autoLane: p.estimated ? rangeBySaturation(p) : laneForMeasured(p),
    }))
  }, [ads])

  const fatigueCut = useMemo(
    () => quantile(cards.map(c => c.freq).filter(f => f > 0), 0.75),
    [cards],
  )

  const flowByLane = useMemo(() => {
    const out: Record<Lane, Card[]> = { TOF: [], MOF: [], BOF: [], REACT: [] }
    for (const c of cards) out[c.autoLane].push(c)
    for (const l of LANES) out[l].sort((a, b) => (b.total || b.rep.spend || 0) - (a.total || a.rep.spend || 0))
    return out
  }, [cards])

  // Flat funnel order (TOF→…→REACT, spend-sorted within) — drives prev/next
  // navigation in the preview lightbox.
  const orderedCards = useMemo(() => LANES.flatMap(l => flowByLane[l]), [flowByLane])

  // CSV export: ad title + Meta deep link, grouped by funnel section.
  const exportCsv = () => {
    const esc = (v: string) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const rows = [['Section', 'Ad Title', 'Meta URL']]
    for (const lane of LANES) {
      for (const c of flowByLane[lane]) {
        rows.push([LANE_LABEL[lane], c.rep.ad_name || c.rep.ad_id || '', adsManagerUrl(c.rep) || ''])
      }
    }
    const csv = rows.map(r => r.map(esc).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${brand.replace(/[^a-z0-9]+/gi, '-')}-funnel.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  // -------------------------------------------------------------------------
  // Pan + zoom.
  // -------------------------------------------------------------------------
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)
  // Responsive canvas width — tracks the container so the funnel reflows to
  // fit any window (half-screen, mobile) instead of overflowing sideways.
  const [containerW, setContainerW] = useState(MAX_CANVAS_W)
  const canvasW = Math.min(MAX_CANVAS_W, Math.max(MIN_CANVAS_W, containerW - 24))
  const view = useRef({ scale, tx, ty })
  view.current = { scale, tx, ty }
  const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z))

  const zoomAround = useCallback((cx: number, cy: number, factor: number) => {
    const { scale: s, tx: t, ty: t2 } = view.current
    const next = clampZoom(s * factor)
    if (next === s) return
    setScale(next)
    setTx(cx - (cx - t) * (next / s))
    setTy(cy - (cy - t2) * (next / s))
  }, [])

  const zoomButton = (factor: number) => {
    const wrap = wrapRef.current
    if (!wrap) return
    const r = wrap.getBoundingClientRect()
    zoomAround(r.width / 2, r.height / 2, factor)
  }

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = wrap.getBoundingClientRect()
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top
      if (e.ctrlKey || e.metaKey) {
        zoomAround(cx, cy, Math.exp(-e.deltaY * 0.01))
      } else {
        const { tx: t, ty: t2 } = view.current
        setTx(t - e.deltaX); setTy(t2 - e.deltaY)
      }
    }
    wrap.addEventListener('wheel', onWheel, { passive: false })
    return () => wrap.removeEventListener('wheel', onWheel)
  }, [zoomAround])

  // Empty-canvas click-drag pan.
  const panDrag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const onCanvasMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-funnel-card]')) return
    panDrag.current = { x: e.clientX, y: e.clientY, tx, ty }
  }
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = panDrag.current
      if (!d) return
      setTx(d.tx + (e.clientX - d.x))
      setTy(d.ty + (e.clientY - d.y))
    }
    const up = () => { panDrag.current = null }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [])

  // Center on first paint + track container width so the canvas reflows.
  const centerX = useCallback((w?: number) => {
    const wrap = wrapRef.current
    if (!wrap) return
    const cw = Math.min(MAX_CANVAS_W, Math.max(MIN_CANVAS_W, (w ?? wrap.clientWidth) - 24))
    setTx((wrap.clientWidth - cw * view.current.scale) / 2)
  }, [])

  // Fit the ENTIRE funnel (full height + width) into view, so the funnel
  // silhouette reads at a glance instead of the tall TOF block filling the
  // screen. offsetHeight is the natural (untransformed) content height.
  const fitAll = useCallback(() => {
    const wrap = wrapRef.current, canvas = canvasRef.current
    if (!wrap || !canvas) return
    const cw = wrap.clientWidth, ch = wrap.clientHeight
    const cvW = Math.min(MAX_CANVAS_W, Math.max(MIN_CANVAS_W, cw - 24))
    const natH = canvas.offsetHeight || 1
    const s = Math.max(MIN_ZOOM, Math.min(1, (cw - 24) / cvW, (ch - 24) / natH))
    setScale(s); setTx((cw - cvW * s) / 2); setTy(10)
  }, [])

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    setContainerW(wrap.clientWidth)
    // Wait a tick for cards/images to lay out, then frame the whole funnel.
    const t = setTimeout(fitAll, 60)
    const ro = new ResizeObserver(() => {
      const w = wrap.clientWidth
      setContainerW(w)
      if (view.current.scale <= 1) centerX(w)
    })
    ro.observe(wrap)
    return () => { clearTimeout(t); ro.disconnect() }
  }, [centerX, fitAll])

  const resetView = () => fitAll()

  // Touch pan (mobile / trackpad drag) — one-finger drag moves the canvas so
  // narrow screens can reach content that flows below the fold.
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    let last: { x: number; y: number } | null = null
    const start = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      last = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    }
    const move = (e: TouchEvent) => {
      if (!last || e.touches.length !== 1) return
      const t = e.touches[0]
      const { tx: cx, ty: cy } = view.current
      setTx(cx + (t.clientX - last.x))
      setTy(cy + (t.clientY - last.y))
      last = { x: t.clientX, y: t.clientY }
      e.preventDefault()
    }
    const end = () => { last = null }
    wrap.addEventListener('touchstart', start, { passive: true })
    wrap.addEventListener('touchmove', move, { passive: false })
    wrap.addEventListener('touchend', end)
    return () => {
      wrap.removeEventListener('touchstart', start)
      wrap.removeEventListener('touchmove', move)
      wrap.removeEventListener('touchend', end)
    }
  }, [])

  // Open that one ad in Meta (trusted onClick gesture so it isn't popup-blocked).
  const openInMeta = (c: Card) => {
    const url = adsManagerUrl(c.rep)
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }

  // In-app ad preview — same Meta preview-iframe mechanism Creative Analysis
  // uses. Opens a blurred modal; no performance metrics.
  const [previewAd, setPreviewAd] = useState<Card | null>(null)
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  useEffect(() => {
    if (!previewAd) { setPreviewSrc(null); return }
    // Demo/sample ads have no real Meta ad — preview the local image directly.
    if (previewAd.rep.is_demo) { setPreviewSrc(null); setPreviewLoading(false); return }
    let cancelled = false
    setPreviewSrc(null); setPreviewLoading(true)
    fetch(`/api/ads/preview-iframe-src?ad_id=${encodeURIComponent(previewAd.rep.ad_id)}&ad_format=MOBILE_FEED_STANDARD`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d && typeof d.src === 'string') setPreviewSrc(d.src) })
      .catch(() => { /* leave null → show fallback */ })
      .finally(() => { if (!cancelled) setPreviewLoading(false) })
    return () => { cancelled = true }
  }, [previewAd])

  // Step through the ads in funnel order (buttons + ← → arrow keys).
  const previewIndex = previewAd ? orderedCards.findIndex(c => c.key === previewAd.key) : -1
  const stepPreview = useCallback((delta: number) => {
    if (!orderedCards.length) return
    setPreviewAd(cur => {
      const i = cur ? orderedCards.findIndex(c => c.key === cur.key) : -1
      const next = ((i < 0 ? 0 : i) + delta + orderedCards.length) % orderedCards.length
      return orderedCards[next]
    })
  }, [orderedCards])
  useEffect(() => {
    if (!previewAd) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); stepPreview(1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stepPreview(-1) }
      else if (e.key === 'Escape') setPreviewAd(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewAd, stepPreview])

  if (!cards.length) {
    return (
      <div className="glass rounded-2xl p-10 text-center text-text-muted text-sm">
        No creatives to place in this range. Try a wider date range or an account with active spend.
      </div>
    )
  }

  return (
    <div
      className="glass rounded-2xl relative overflow-hidden w-full"
      style={{ height: typeof height === 'number' ? `${height}px` : height, minHeight: 480 }}
    >
      {/* Top-right toolbar */}
      <div className="absolute top-2 right-3 z-20 flex items-center gap-1.5">
        <button onClick={exportCsv}
          className="px-2 py-0.5 rounded text-[10px] text-neutral-600 hover:bg-black/[0.05] font-sans flex items-center gap-1 border border-black/10 bg-white/70"
          title="Export ad titles + Meta links by section (CSV)">↓ CSV</button>
        <button onClick={resetView}
          className="px-2 py-0.5 rounded text-[10px] text-neutral-500 hover:bg-black/[0.05] font-sans"
          title="Reset view">reset</button>
      </div>

      <div ref={wrapRef} className="absolute inset-0 cursor-grab active:cursor-grabbing" onMouseDown={onCanvasMouseDown}>
        {/* Dot grid */}
        <div className="absolute inset-0 pointer-events-none opacity-60"
          style={{ backgroundImage: 'radial-gradient(circle, rgba(0,0,0,0.06) 1px, transparent 1px)', backgroundSize: '24px 24px' }} />

        <div ref={canvasRef} style={{
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          transformOrigin: '0 0',
          transition: panDrag.current ? 'none' : 'transform 120ms ease-out',
          position: 'absolute', top: 28, left: 0, width: canvasW, paddingBottom: 40,
        }}>
          {LANES.map((lane) => {
            const items = flowByLane[lane]
            const laneWidth = canvasW * LANE_WIDTH_PCT[lane]
            const isReact = lane === 'REACT'
            return (
              <div key={lane} data-lane={lane}
                style={{ width: laneWidth, margin: '0 auto', marginTop: LANE_GAP_Y, position: 'relative' }}>
                <div className="text-center" style={{ marginBottom: 12, overflow: 'visible' }}>
                  <div className="font-sans font-bold uppercase tracking-[0.22em] whitespace-nowrap leading-tight"
                    style={{ fontSize: 30, color: isReact ? '#B45309' : '#A8A8A8' }}>
                    {LANE_LABEL[lane]}
                  </div>
                  <div className="font-sans text-neutral-400 whitespace-nowrap" style={{ fontSize: 13, letterSpacing: '0.08em', marginTop: 2 }}>{LANE_SUB[lane]}</div>
                </div>
                <div className="flex flex-wrap justify-center content-start"
                  style={{ gap: CARD_GAP, minHeight: CARD_H }}>
                  {items.length === 0 ? (
                    <div className="flex items-center justify-center text-[10px] text-neutral-300 italic"
                      style={{ width: laneWidth, height: CARD_H }}>
                      {isReact ? 'no existing-customer creatives' : 'none'}
                    </div>
                  ) : items.map(c => (
                    <FunnelCard key={c.key} card={c} brand={brand}
                      fatigued={c.freq > 0 && c.freq >= fatigueCut}
                      onPreview={() => setPreviewAd(c)}
                      onOpenMeta={() => openInMeta(c)} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Corner zoom toggle */}
      <div className="absolute bottom-3 right-3 z-20 flex flex-col items-stretch rounded-lg overflow-hidden border border-black/10 bg-white/80 backdrop-blur-sm shadow-sm">
        <button onClick={() => zoomButton(1.2)} title="Zoom in"
          className="w-8 h-8 flex items-center justify-center text-neutral-600 hover:bg-black/[0.05]"><Plus size={13} /></button>
        <button onClick={resetView} title="Fit"
          className="w-8 h-7 flex items-center justify-center text-neutral-500 hover:bg-black/[0.05] border-y border-black/[0.06]"><Maximize2 size={11} /></button>
        <button onClick={() => zoomButton(1 / 1.2)} title="Zoom out"
          className="w-8 h-8 flex items-center justify-center text-neutral-600 hover:bg-black/[0.05]"><Minus size={13} /></button>
      </div>

      {/* Ad preview lightbox — blurred backdrop, Meta preview iframe, no metrics.
          ← → (buttons or arrow keys) step through the ads in funnel order. */}
      {previewAd && (
        <div className="absolute inset-0 z-30 flex items-center justify-center gap-3"
          style={{ background: 'rgba(20,20,20,0.4)', backdropFilter: 'blur(6px)' }}
          onClick={() => setPreviewAd(null)}>
          <button onClick={e => { e.stopPropagation(); stepPreview(-1) }} title="Previous (←)"
            className="w-10 h-10 flex-shrink-0 flex items-center justify-center rounded-full bg-white/85 text-neutral-800 hover:bg-white shadow-lg">{ICON_CHEVRON_L}</button>

          <div className="relative rounded-2xl overflow-hidden bg-white shadow-2xl" style={{ width: 340, height: 620 }}
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-3 h-10 border-b border-black/[0.06]">
              <span className="font-sans text-xs text-text-secondary truncate pr-2">{previewAd.rep.ad_name || 'Ad preview'}</span>
              <div className="flex items-center gap-1 flex-shrink-0">
                <span className="font-sans text-[10px] text-text-muted tabular-nums pr-1">{previewIndex + 1}/{orderedCards.length}</span>
                <button onClick={() => openInMeta(previewAd)} title="Open in Meta Ads Manager"
                  className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/[0.05] text-neutral-600">{ICON_META}</button>
                <button onClick={() => setPreviewAd(null)} title="Close (Esc)"
                  className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/[0.05] text-neutral-500">{ICON_CLOSE}</button>
              </div>
            </div>
            <div className="relative bg-neutral-50" style={{ height: 580 }}>
              {previewAd.rep.is_demo ? (
                <img src={previewAd.rep.image_url_hd || previewAd.rep.image_url || ''} alt={previewAd.rep.ad_name || 'ad'}
                  className="w-full h-full object-contain" />
              ) : previewSrc ? (
                <iframe src={previewSrc} title="ad preview" className="w-full h-full border-0"
                  scrolling="no" sandbox="allow-scripts allow-same-origin" />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-text-muted">
                  {previewLoading ? 'Loading preview…' : 'Preview unavailable — open in Meta instead.'}
                </div>
              )}
            </div>
          </div>

          <button onClick={e => { e.stopPropagation(); stepPreview(1) }} title="Next (→)"
            className="w-10 h-10 flex-shrink-0 flex items-center justify-center rounded-full bg-white/85 text-neutral-800 hover:bg-white shadow-lg">{ICON_CHEVRON_R}</button>
        </div>
      )}
    </div>
  )
}

function FunnelCard({
  card, brand, fatigued, onPreview, onOpenMeta,
}: {
  card: Card; brand: string; fatigued: boolean
  onPreview: () => void
  onOpenMeta: () => void
}) {
  return (
    <div
      data-funnel-card
      title={card.rep.ad_name || 'Creative'}
      className="group relative shrink-0 rounded-md overflow-hidden bg-neutral-100 hover:ring-2 hover:ring-text-primary/25 transition-shadow select-none"
      style={{
        width: CARD_W, height: CARD_H,
        border: card.estimated ? '1px dashed rgba(0,0,0,0.28)' : '1px solid rgba(0,0,0,0.08)',
        outline: fatigued ? '2px solid rgba(217,119,6,0.55)' : undefined,
        outlineOffset: fatigued ? -2 : undefined,
      }}
    >
      <Thumbnail ad={card.rep} brand={brand} className="absolute inset-0" />

      {card.members > 1 && (
        <div className="absolute top-1 left-1 rounded-full bg-black/65 text-white font-sans font-medium tabular-nums"
          style={{ fontSize: 9, padding: '1px 6px', backdropFilter: 'blur(4px)' }}>×{card.members}</div>
      )}

      {/* Hover actions: preview (in-app) + open in Meta Ads Manager */}
      <div className="absolute inset-0 flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ background: 'rgba(20,20,20,0.32)' }}>
        <button onClick={onPreview} title="Preview ad"
          className="w-8 h-8 flex items-center justify-center rounded-full bg-white/90 text-neutral-800 hover:bg-white shadow">{ICON_EYE}</button>
        <button onClick={onOpenMeta} title="Open in Meta Ads Manager"
          className="w-8 h-8 flex items-center justify-center rounded-full bg-white/90 text-neutral-800 hover:bg-white shadow">{ICON_META}</button>
      </div>
    </div>
  )
}
