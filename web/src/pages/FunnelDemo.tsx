// =============================================================================
// FunnelDemo — the standalone Odylic Funnel Viewer app page.
//
//   Logged out:  Grüns sample funnel + "Connect your Meta" → /setup (the
//                written walk-through for creating your own local Meta app).
//   Logged in:   pick one of YOUR ad accounts → live funnel for that account.
//   ?brand=X     still forces a live account by name (power-user/deep-link).
//
// Minimal chrome; fills the viewport. No Lens shell, no Library.
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

type BrandRow = { name: string; meta_account_id?: string }

export default function FunnelDemo() {
  const params = new URLSearchParams(window.location.search)
  const brandParam = params.get('brand')?.trim() || ''

  // Who's connected? Drives the header CTA (connect vs. account picker).
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null)
  const [brands, setBrands] = useState<BrandRow[]>([])
  const [picked, setPicked] = useState('')

  const liveBrand = brandParam || picked
  const live = !!liveBrand
  const brand = live ? liveBrand : GRUNS_BRAND

  const [start, setStart] = useState(params.get('start') || isoDaysAgo(30))
  const [end, setEnd] = useState(params.get('end') || isoDaysAgo(0))
  const [pickerOpen, setPickerOpen] = useState(false)

  const [ads, setAds] = useState<AdCreative[]>(live ? [] : GRUNS_ADS)
  const [loading, setLoading] = useState(live)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/status')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled) return
        const ok = !!(d && d.logged_in)
        setLoggedIn(ok)
        if (ok) {
          fetch('/api/brands')
            .then(r => r.ok ? r.json() : [])
            .then((rows: BrandRow[]) => { if (!cancelled) setBrands(Array.isArray(rows) ? rows : []) })
            .catch(() => { /* picker just stays empty */ })
        }
      })
      .catch(() => { if (!cancelled) setLoggedIn(false) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!live) { setAds(GRUNS_ADS); setLoading(false); setError(null); return }
    let cancelled = false
    setLoading(true); setError(null)
    fetch(`/api/ads/creatives?brand=${encodeURIComponent(liveBrand)}&start=${start}&end=${end}&limit=60`)
      .then(async r => {
        if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => '')}`.slice(0, 160))
        return r.json()
      })
      .then(data => { if (!cancelled) { setAds(data.ads || []); setLoading(false) } })
      .catch(e => { if (!cancelled) { setError(String(e.message || e)); setLoading(false) } })
    return () => { cancelled = true }
  }, [live, liveBrand, start, end])

  return (
    <div className="h-screen w-full flex flex-col bg-bg-base overflow-hidden">
      <header className="flex-shrink-0 px-5 pt-4 pb-2 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <img src="/odylic-logo.png" alt="Odylic" style={{ height: 32, display: 'block' }}
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
          <h1 className="text-text-primary" style={{
            fontFamily: "'Helvetica Neue', Inter, system-ui, -apple-system, sans-serif",
            fontWeight: 200, fontSize: 24, letterSpacing: '0.015em', lineHeight: 1,
            // Optical baseline match to the wordmark PNG: the logo's ink
            // baseline sits ~24px below its box top at 32px render height
            // (the PNG has heavy internal padding), so the 24px text needs
            // a +4px push to share that baseline. Measured, not eyeballed.
            transform: 'translateY(4px)',
          }}>Funnel Viewer</h1>
          {!live && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-sans uppercase tracking-[0.12em] bg-black/[0.05] text-text-muted"
              style={{ transform: 'translateY(-3px)' }}>
              Sample · {GRUNS_BRAND}
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Your accounts (after connecting) */}
          {loggedIn && brands.length > 0 && (
            <select
              value={picked}
              onChange={e => setPicked(e.target.value)}
              className="px-3 py-1.5 rounded-full text-xs glass glass-hover font-sans"
              style={{ appearance: 'none', WebkitAppearance: 'none', cursor: 'pointer' }}
            >
              <option value="">{picked ? 'Back to sample' : 'View your account…'}</option>
              {brands.map(b => (
                <option key={b.name} value={b.name}>{b.name}</option>
              ))}
            </select>
          )}

          {/* Connect CTA (before connecting) */}
          {loggedIn === false && (
            <a href="/setup?return=/funnel-demo"
              className="px-3 py-1.5 rounded-full text-xs font-sans font-medium"
              style={{ background: 'rgba(183,65,14,0.10)', border: '1px solid rgba(183,65,14,0.30)', color: '#b55719' }}>
              Connect your Meta →
            </a>
          )}

          {live && (
            <div className="relative">
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
        </div>
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
