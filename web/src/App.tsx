// Odylic Lens — top-level shell.
// Derived from ad-connector/dashboard/src/App.tsx but stripped down to the
// three surfaces Lens cares about: Creative Analysis, Brand Settings,
// API Settings. Auth-gated by /api/auth/status: unauthenticated users see
// the Landing/Setup pages from pages/.

import { useEffect, useState, lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import { Loader2, Sparkles, Settings as SettingsIcon, KeyRound, LogOut, Layers3 } from 'lucide-react'
import { LiveFunnelView } from './components/LiveFunnelView'
import { AdAnalysisView, preloadAds } from './components/AdAnalysisView'
import { BrandSelector } from './components/BrandSelector'
import { DatePicker } from './components/DatePicker'
import Landing from './pages/Landing'
import Setup from './pages/Setup'
import ApiSettings from './pages/ApiSettings'
const AdsLibraryView = lazy(() => import('./pages/AdsLibrary'))
const FunnelDemoView = lazy(() => import('./pages/FunnelDemo'))
import { endpoints, type AuthStatus } from './lib/api'

const BrandSettingsView = lazy(() =>
  import('./components/BrandSettingsView').then(m => ({ default: m.BrandSettingsView }))
)

const LazyFallback = () => (
  <div className="flex items-center justify-center py-20">
    <Loader2 size={20} className="animate-spin text-text-muted" />
  </div>
)

type Brand = {
  name: string
  meta: boolean
  google: boolean
  meta_account_id?: string | null
  google_account_ids?: string[]
}

function fmt(d: Date) {
  return d.toISOString().split('T')[0]
}

function defaultDateRange(): { start: string; end: string } {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const start = new Date(today)
  start.setDate(today.getDate() - 14)
  return { start: fmt(start), end: fmt(yesterday) }
}

type Tab = 'funnel' | 'creatives' | 'brand' | 'settings'

function Shell({ auth, onLogout }: { auth: AuthStatus; onLogout: () => void }) {
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const q = new URLSearchParams(window.location.search).get('tab')
    if (q === 'creatives' || q === 'brand' || q === 'settings') return q
    return 'funnel'
  })
  const [brands, setBrands] = useState<Brand[]>([])
  const [profiles, setProfiles] = useState<Record<string, { favicon?: string | null; domain?: string; description?: string }>>({})
  const [selectedBrands, setSelectedBrands] = useState<string[]>([])
  const [brandSettingsTarget, setBrandSettingsTarget] = useState<string | null>(null)
  const [{ start: initStart, end: initEnd }] = useState(defaultDateRange)
  const [dateRange, setDateRange] = useState({ start: initStart, end: initEnd })
  const [compareStart, setCompareStart] = useState('')
  const [compareEnd, setCompareEnd] = useState('')
  const [datePickerOpen, setDatePickerOpen] = useState(false)

  // Load brands from /api/brands (per-user via auth on backend).
  useEffect(() => {
    fetch('/api/brands', { credentials: 'include' })
      .then(r => r.json())
      .then((data: Brand[]) => {
        setBrands(Array.isArray(data) ? data : [])
        if (Array.isArray(data) && data.length && !selectedBrands.length) {
          setSelectedBrands([data[0].name])
        }
      })
      .catch(() => setBrands([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Per-brand profile metadata (favicons/domains) for the BrandSelector
  // popover. Falls back to empty so render isn't blocked on this.
  useEffect(() => {
    if (!brands.length) return
    let cancelled = false
    Promise.all(brands.map(b =>
      fetch(`/api/profile?brand=${encodeURIComponent(b.name)}`, { credentials: 'include' })
        .then(r => r.json()).then(d => [b.name, d] as const).catch(() => [b.name, {}] as const)
    )).then(entries => {
      if (cancelled) return
      const map: Record<string, any> = {}
      for (const [name, p] of entries) map[name] = p
      setProfiles(map)
    })
    return () => { cancelled = true }
  }, [brands])

  const openBrandSettings = (b: string) => {
    setBrandSettingsTarget(b)
    setActiveTab('brand')
  }

  const primaryBrand = selectedBrands[0] || ''

  return (
    <div className="min-h-screen flex">
      {/* Left sidebar */}
      <nav className="w-14 bg-white/40 border-r border-black/[0.06] flex flex-col items-center flex-shrink-0 py-3 gap-2">
        <BrandSelector
          brands={brands}
          profiles={profiles}
          selected={selectedBrands}
          onSelectedChange={setSelectedBrands}
          onOpenSettings={openBrandSettings}
        />
        <div className="w-8 h-px bg-black/[0.08] my-1" />
        {([
          { k: 'funnel' as const, icon: Layers3, title: 'Funnel Viewer' },
          { k: 'creatives' as const, icon: Sparkles, title: 'Creative Analysis' },
          { k: 'brand' as const, icon: SettingsIcon, title: 'Brand Settings' },
          { k: 'settings' as const, icon: KeyRound, title: 'API Settings' },
        ]).map(({ k, icon: Icon, title }) => (
          <button
            key={k}
            title={title}
            onClick={() => {
              if (k === 'creatives' && primaryBrand) {
                preloadAds(primaryBrand, dateRange.start, dateRange.end)
              }
              if (k === 'brand' && !brandSettingsTarget && primaryBrand) {
                setBrandSettingsTarget(primaryBrand)
              }
              setActiveTab(k)
            }}
            className={`p-2 rounded-lg transition-colors ${
              activeTab === k
                ? 'bg-text-primary text-white'
                : 'text-text-muted hover:text-text-primary hover:bg-black/[0.04]'
            }`}
          >
            <Icon size={14} />
          </button>
        ))}
        <div className="mt-auto" />
        <button
          title="Sign out"
          onClick={onLogout}
          className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-black/[0.04]"
        >
          <LogOut size={14} />
        </button>
      </nav>

      <div className="flex-1 min-w-0">
        {/* Top header — Odylic wordmark + Roboto-thin "lens" lockup to
            match the Landing page. No app-id badge. */}
        <header className="glass rounded-none border-b border-white/20 px-6 py-3">
          <div className="flex items-baseline gap-1">
            <img
              src="/odylic-logo.png"
              alt="Odylic"
              style={{ height: 22, display: 'block' }}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
            />
            <span
              style={{
                fontFamily: "'Roboto', sans-serif",
                fontWeight: 100,
                fontSize: 13,
                letterSpacing: '0.01em',
                color: 'var(--color-text-muted)',
                lineHeight: 1,
                marginTop: 4,
                marginLeft: -2,
              }}
            >
              lens
            </span>
          </div>
        </header>

        {/* Date picker — only visible on Creative Analysis */}
        {activeTab === 'creatives' && (
          <div className="px-6 py-3 flex items-center gap-2">
            <div className="text-xs text-text-secondary flex-shrink-0">
              {selectedBrands[0] || 'No brand selected'}
            </div>
            <div className="relative">
              <button
                onClick={() => setDatePickerOpen(v => !v)}
                className="px-3 py-1.5 rounded-full text-xs glass glass-hover flex items-center gap-1"
              >
                {dateRange.start} → {dateRange.end}
                {compareStart && compareEnd ? (
                  <span className="text-text-muted ml-1">
                    vs {compareStart} → {compareEnd}
                  </span>
                ) : null}
              </button>
              {datePickerOpen && (
                <DatePicker
                  start={dateRange.start}
                  end={dateRange.end}
                  compareStart={compareStart}
                  compareEnd={compareEnd}
                  onApply={(s, e, cs, ce) => {
                    setDateRange({ start: s, end: e })
                    setCompareStart(cs || '')
                    setCompareEnd(ce || '')
                    setDatePickerOpen(false)
                  }}
                  onClose={() => setDatePickerOpen(false)}
                />
              )}
            </div>
          </div>
        )}

        <main className="px-6 pb-8">
          <Suspense fallback={<LazyFallback />}>
            {activeTab === 'funnel' && (
              <LiveFunnelView
                brand={primaryBrand}
                start={dateRange.start}
                end={dateRange.end}
              />
            )}
            {activeTab === 'creatives' && (
              <AdAnalysisView
                brand={primaryBrand}
                start={dateRange.start}
                end={dateRange.end}
                compareStart={compareStart}
                compareEnd={compareEnd}
              />
            )}
            {activeTab === 'brand' && (
              (brandSettingsTarget || primaryBrand) ? (
                <BrandSettingsView
                  brand={(brandSettingsTarget || primaryBrand) as string}
                  brandRow={brands.find(b => b.name === (brandSettingsTarget || primaryBrand))}
                />
              ) : (
                <div className="glass rounded-2xl p-16 text-center text-text-muted text-sm">
                  Pick a brand from the left to edit its profile
                </div>
              )
            )}
            {activeTab === 'settings' && (
              <div className="py-6">
                <ApiSettings />
              </div>
            )}
          </Suspense>
        </main>
      </div>
    </div>
  )
}

function RoutedApp() {
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const nav = useNavigate()
  const loc = useLocation()

  const refresh = async () => {
    try {
      const s = await endpoints.authStatus()
      setAuth(s)
    } catch {
      setAuth(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  useEffect(() => {
    if (loading) return
    if (!auth?.app_configured) {
      // /library and / are zero-config — let users land there without
      // forcing them through Setup. Everything else still gets bounced.
      const zeroConfigPaths = ['/setup', '/library', '/', '/funnel-demo']
      if (!zeroConfigPaths.includes(loc.pathname)) nav('/setup', { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, loading])

  const handleLogout = async () => {
    try { await endpoints.logout() } catch {}
    await refresh()
    nav('/', { replace: true })
  }

  if (loading) return <LazyFallback />

  return (
    <Routes>
      <Route path="/setup" element={<Setup auth={auth} />} />
      <Route path="/library" element={
        <Suspense fallback={<LazyFallback />}>
          <AdsLibraryView />
        </Suspense>
      } />
      <Route path="/funnel-demo" element={
        <Suspense fallback={<LazyFallback />}>
          <FunnelDemoView />
        </Suspense>
      } />
      <Route path="/" element={
        auth?.app_configured && auth?.logged_in
          ? <Shell auth={auth} onLogout={handleLogout} />
          : <Landing auth={auth} />
      } />
      <Route path="*" element={
        auth?.app_configured && auth?.logged_in
          ? <Shell auth={auth} onLogout={handleLogout} />
          : <Landing auth={auth} />
      } />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <RoutedApp />
    </BrowserRouter>
  )
}
