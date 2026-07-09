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
  const [brandsLoaded, setBrandsLoaded] = useState(false)
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
            .then((rows: BrandRow[]) => { if (!cancelled) { setBrands(Array.isArray(rows) ? rows : []); setBrandsLoaded(true) } })
            .catch(() => { if (!cancelled) setBrandsLoaded(true) })
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
          {/* Both words are TEXT (not the padded PNG) so they share a real
              baseline — no more pixel-nudging the logo into alignment. */}
          <h1 className="flex items-baseline gap-2 text-text-primary" style={{ lineHeight: 1 }}>
            <span style={{ fontFamily: "'Source Serif 4', Georgia, 'Times New Roman', serif", fontWeight: 700, fontSize: 27, letterSpacing: '-0.01em' }}>Odylic</span>
            <span style={{ fontFamily: "'Helvetica Neue', Inter, system-ui, -apple-system, sans-serif", fontWeight: 200, fontSize: 23, letterSpacing: '0.02em' }}>Funnel Viewer</span>
          </h1>
          {!live && (
            <span className="self-center px-2 py-0.5 rounded-full text-[10px] font-sans uppercase tracking-[0.12em] bg-black/[0.05] text-text-muted">
              Sample · {GRUNS_BRAND}
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Connected → account picker (looks like a real dropdown). */}
          {loggedIn && brandsLoaded && brands.length > 0 && (
            <div className="relative">
              <select
                value={picked}
                onChange={e => setPicked(e.target.value)}
                className="pl-3 pr-8 py-1.5 rounded-full text-xs font-sans font-medium cursor-pointer"
                style={{
                  appearance: 'none', WebkitAppearance: 'none',
                  background: picked ? 'rgba(183,65,14,0.10)' : '#ffffff',
                  border: `1px solid ${picked ? 'rgba(183,65,14,0.30)' : 'rgba(0,0,0,0.14)'}`,
                  color: picked ? '#b55719' : 'var(--color-text-primary)',
                }}
              >
                <option value="">Choose an account ({brands.length})</option>
                {picked && <option value="">← Back to sample</option>}
                {brands.map(b => (
                  <option key={b.name} value={b.name}>{b.name}</option>
                ))}
              </select>
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-neutral-500">▾</span>
            </div>
          )}

          {/* Connected but accounts still loading. */}
          {loggedIn && !brandsLoaded && (
            <span className="px-3 py-1.5 rounded-full text-xs glass text-text-muted">Loading your accounts…</span>
          )}

          {/* Connected but no ad accounts on this Meta user. */}
          {loggedIn && brandsLoaded && brands.length === 0 && (
            <span className="px-3 py-1.5 rounded-full text-xs glass text-text-muted" title="This Meta user has no ad accounts your app can read.">
              No ad accounts found
            </span>
          )}

          {/* Not connected → the tutorial. */}
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
