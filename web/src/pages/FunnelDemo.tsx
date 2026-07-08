// =============================================================================
// FunnelDemo. Public, full-screen, no-auth Hypothetical Funnel Viewer.
//   • /funnel-demo                       → sample brand (offline)
//   • /funnel-demo?brand=Kinn%20Studios  → LIVE via /api/ads/creatives
//     (date range is picker-controlled; defaults to last 30 days)
// Minimal chrome; fills the viewport.
// =============================================================================

import { useEffect, useState } from 'react'
import { HypotheticalFunnelView } from '../components/HypotheticalFunnelView'
import { DatePicker } from '../components/DatePicker'
import type { AdCreative } from '../components/AdAnalysisView'
import { GRUNS_ADS, GRUNS_BRAND } from '../lib/sampleGrunsAds'

function isoDaysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

export default function FunnelDemo() {
  const params = new URLSearchParams(window.location.search)
  const brandParam = params.get('brand')?.trim() || ''
  const live = !!brandParam
  const brand = live ? brandParam : GRUNS_BRAND

  const [start, setStart] = useState(params.get('start') || isoDaysAgo(30))
  const [end, setEnd] = useState(params.get('end') || isoDaysAgo(0))
  const [pickerOpen, setPickerOpen] = useState(false)

  const [ads, setAds] = useState<AdCreative[]>(live ? [] : GRUNS_ADS)
  const [loading, setLoading] = useState(live)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!live) return
    let cancelled = false
    setLoading(true); setError(null)
    fetch(`/api/ads/creatives?brand=${encodeURIComponent(brandParam)}&start=${start}&end=${end}&limit=60`)
      .then(async r => {
        if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => '')}`.slice(0, 160))
        return r.json()
      })
      .then(data => { if (!cancelled) { setAds(data.ads || []); setLoading(false) } })
      .catch(e => { if (!cancelled) { setError(String(e.message || e)); setLoading(false) } })
    return () => { cancelled = true }
  }, [live, brandParam, start, end])

  return (
    <div className="h-screen w-full flex flex-col bg-bg-base overflow-hidden">
      <header className="flex-shrink-0 px-5 pt-4 pb-2 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <img src="/odylic-logo.png" alt="Odylic" style={{ height: 32, display: 'block' }}
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
          <h1 className="text-text-primary" style={{
            fontFamily: "'Helvetica Neue', Inter, system-ui, -apple-system, sans-serif",
            fontWeight: 200, fontSize: 24, letterSpacing: '0.015em', lineHeight: 1,
            transform: 'translateY(-4px)',
          }}>Funnel Viewer</h1>
        </div>
        {live && (
          <div className="relative ml-auto">
            <button
              onClick={() => setPickerOpen(v => !v)}
              className="px-3 py-1.5 rounded-full text-xs glass glass-hover"
            >
              {start} → {end}
            </button>
            {pickerOpen && (
              <DatePicker
                start={start}
                end={end}
                hideCompare
                onApply={(s, e) => { setStart(s); setEnd(e); setPickerOpen(false) }}
                onClose={() => setPickerOpen(false)}
              />
            )}
          </div>
        )}
      </header>

      <main className="flex-1 min-h-0 px-3 pb-3">
        {loading ? (
          <div className="glass rounded-2xl h-full flex items-center justify-center text-text-muted text-sm">
            Loading {brand}…
          </div>
        ) : error ? (
          <div className="glass rounded-2xl h-full flex items-center justify-center text-center text-sm text-text-muted px-8">
            Couldn’t load {brand}: {error}
          </div>
        ) : (
          <HypotheticalFunnelView ads={ads} brand={brand} height="100%" />
        )}
      </main>
    </div>
  )
}
