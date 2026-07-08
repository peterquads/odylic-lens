// Funnel Viewer for a connected brand — fetches the user's live creatives
// (which carry real user_segment_key delivery) and renders the funnel. This is
// the primary post-onboarding view: no performance metrics, just the funnel.

import { useEffect, useState } from 'react'
import { HypotheticalFunnelView } from './HypotheticalFunnelView'
import type { AdCreative } from './AdAnalysisView'

export function LiveFunnelView({ brand, start, end }: { brand: string; start: string; end: string }) {
  const [ads, setAds] = useState<AdCreative[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!brand) { setLoading(false); return }
    let cancelled = false
    setLoading(true); setError(null)
    fetch(`/api/ads/creatives?brand=${encodeURIComponent(brand)}&start=${start}&end=${end}&limit=150`)
      .then(async r => {
        if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => '')}`.slice(0, 160))
        return r.json()
      })
      .then(d => { if (!cancelled) { setAds(d.ads || []); setLoading(false) } })
      .catch(e => { if (!cancelled) { setError(String(e.message || e)); setLoading(false) } })
    return () => { cancelled = true }
  }, [brand, start, end])

  const H = 'calc(100vh - 150px)'
  if (!brand) {
    return (
      <div className="glass rounded-2xl p-16 text-center text-text-muted text-sm">
        Connect a Meta account and pick a brand from the left to see its creative funnel.
      </div>
    )
  }
  if (loading) {
    return (
      <div className="glass rounded-2xl flex items-center justify-center text-text-muted text-sm" style={{ height: H }}>
        Building {brand}’s funnel…
      </div>
    )
  }
  if (error) {
    return (
      <div className="glass rounded-2xl p-16 text-center text-text-muted text-sm">
        Couldn’t load {brand}: {error}
      </div>
    )
  }
  return <HypotheticalFunnelView ads={ads} brand={brand} height={H} />
}
