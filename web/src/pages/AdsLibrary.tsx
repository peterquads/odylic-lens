import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { endpoints, type AdsLibraryAd } from "../lib/api";

/**
 * Library mode — the public Ads Library API path. No Meta App OAuth.
 *
 * The Meta Ads Library API returns a *narrow* field set for commercial
 * (non-political) ads: creative payload, page name, delivery window,
 * countries, publisher platforms, languages. It does NOT return
 * spend / CTR / CPM / CPL / ROAS / conversions / per-ad impressions
 * exact counts. Those are private Insights API. So this page exposes
 * the filters the API actually supports, and visibly grays out the
 * Insights-only ones with a tooltip pointing the user back to Setup
 * if they want the full Creative Analysis experience.
 */

const COUNTRY_OPTIONS = [
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "CA", name: "Canada" },
  { code: "AU", name: "Australia" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "ES", name: "Spain" },
  { code: "IT", name: "Italy" },
  { code: "NL", name: "Netherlands" },
  { code: "BR", name: "Brazil" },
  { code: "MX", name: "Mexico" },
];

const PLATFORM_OPTIONS = ["FACEBOOK", "INSTAGRAM", "AUDIENCE_NETWORK", "MESSENGER", "THREADS"];

// Filters/columns that the public Library API can never populate for
// commercial ads. Shown grayed-out with a "requires Meta connection"
// tooltip so the user understands the tradeoff.
const INSIGHTS_ONLY_FIELDS = [
  { label: "Spend ($)", reason: "Exact spend is private — public Ads Library shows none for commercial ads." },
  { label: "CTR / CPM / CPC", reason: "Click metrics are private. Available with the BYO Meta App path." },
  { label: "ROAS / Cost per purchase", reason: "Conversion data lives in your pixel + the private Insights API." },
  { label: "Leads / Cost per lead", reason: "Conversion data lives in your pixel + the private Insights API." },
  { label: "Active-only toggle", reason: "Ads Library returns active + recent inactive together. Filter via the status dropdown instead." },
];

export default function AdsLibraryView() {
  const [searchTerms, setSearchTerms] = useState("");
  const [country, setCountry] = useState("US");
  const [activeStatus, setActiveStatus] = useState<"ALL" | "ACTIVE" | "INACTIVE">("ACTIVE");
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [results, setResults] = useState<AdsLibraryAd[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    endpoints.adsLibraryStatus()
      .then(s => setAvailable(s.available))
      .catch(() => setAvailable(false));
  }, []);

  const canSearch = searchTerms.trim().length >= 2;

  async function runSearch() {
    if (!canSearch) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await endpoints.adsLibrarySearch({
        search_terms: searchTerms.trim(),
        ad_reached_countries: country,
        ad_active_status: activeStatus,
        ad_type: "ALL",
        publisher_platforms: platforms.length ? platforms.join(",") : undefined,
        limit: 50,
      });
      setResults(resp.data || []);
    } catch (e: any) {
      // Backend forwards Meta errors verbatim; surface the message if
      // present so the user knows whether it's a quota / config issue.
      const msg = e?.message || String(e);
      setError(msg);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  function togglePlatform(p: string) {
    setPlatforms(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]);
  }

  return (
    <div style={{ maxWidth: 1120, margin: "0 auto", padding: "32px 24px 64px" }}>
      <header style={{ marginBottom: 24 }}>
        <Link to="/" style={{ fontSize: 11, color: "var(--color-text-muted)", textDecoration: "none" }}>← Back</Link>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 8 }}>
          <h1 style={{ margin: 0 }}>Ads Library</h1>
          <span className="muted" style={{ fontSize: 12 }}>public · no login</span>
        </div>
        <p style={{ color: "var(--color-text-secondary)", fontSize: 13, margin: "8px 0 0", maxWidth: 720 }}>
          Search every ad currently or recently delivered on Meta. Creative payload,
          page, delivery window, countries, platforms — everything Meta exposes
          publicly. For spend, ROAS, CTR and your own account data, you'll need to
          finish <Link to="/setup">Setup</Link>.
        </p>
      </header>

      {available === false ? (
        <div className="atelier-tile" style={{ marginBottom: 24, borderColor: "var(--color-warn, #d97706)" }}>
          <div className="label" style={{ marginBottom: 6 }}>Library token unavailable</div>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            No <code>LENS_LIBRARY_TOKEN</code> set and no Meta App configured.
            Either bake a token into your install <code>.env</code> or finish the
            Setup wizard — that will also enable Library mode for free.
          </p>
        </div>
      ) : null}

      {/* Active filters supported by the Library API. */}
      <div className="atelier-tile" style={{ marginBottom: 16 }}>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "2fr 1fr 1fr" }}>
          <label>
            <div className="label" style={{ marginBottom: 4 }}>Search</div>
            <input
              type="text"
              value={searchTerms}
              placeholder="brand name, hook, phrase…"
              onChange={e => setSearchTerms(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") runSearch(); }}
              style={{ width: "100%", padding: "8px 10px", fontSize: 13 }}
            />
          </label>
          <label>
            <div className="label" style={{ marginBottom: 4 }}>Country</div>
            <select value={country} onChange={e => setCountry(e.target.value)} style={{ width: "100%", padding: "8px 10px", fontSize: 13 }}>
              {COUNTRY_OPTIONS.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
          </label>
          <label>
            <div className="label" style={{ marginBottom: 4 }}>Status</div>
            <select value={activeStatus} onChange={e => setActiveStatus(e.target.value as any)} style={{ width: "100%", padding: "8px 10px", fontSize: 13 }}>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
              <option value="ALL">All</option>
            </select>
          </label>
        </div>

        <div style={{ marginTop: 12 }}>
          <div className="label" style={{ marginBottom: 6 }}>Platforms</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {PLATFORM_OPTIONS.map(p => (
              <button
                key={p}
                onClick={() => togglePlatform(p)}
                className="btn"
                style={{
                  fontSize: 11,
                  padding: "4px 10px",
                  background: platforms.includes(p) ? "var(--color-accent, #E87A2D)" : "transparent",
                  color: platforms.includes(p) ? "white" : "var(--color-text-secondary)",
                  border: "1px solid var(--color-border)",
                }}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 12 }}>
          <button className="btn" onClick={runSearch} disabled={!canSearch || loading}>
            {loading ? "Searching…" : "Search Ads Library →"}
          </button>
          {!canSearch ? <span className="muted" style={{ fontSize: 11 }}>Type at least 2 characters.</span> : null}
          {error ? <span className="muted" style={{ fontSize: 11, color: "var(--color-warn, #d97706)" }}>{error}</span> : null}
        </div>
      </div>

      {/* Grayed-out: filters the public Library can't power. We list them
          inline so the user understands what's missing rather than just
          seeing a stripped-down UI and wondering why. */}
      <div className="atelier-tile" style={{ marginBottom: 24, opacity: 0.55, pointerEvents: "none" }}>
        <div className="label" style={{ marginBottom: 8 }}>
          Not available in Library mode <span className="muted" style={{ textTransform: "none", letterSpacing: 0 }}>· requires connecting your Meta account</span>
        </div>
        <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
          {INSIGHTS_ONLY_FIELDS.map(f => (
            <div key={f.label} title={f.reason} style={{ fontSize: 12, padding: "6px 10px", border: "1px dashed var(--color-border)", borderRadius: 4 }}>
              <div style={{ fontWeight: 500 }}>{f.label}</div>
              <div className="muted" style={{ fontSize: 11 }}>{f.reason}</div>
            </div>
          ))}
        </div>
      </div>

      <Results ads={results} loading={loading} />
    </div>
  );
}

function Results({ ads, loading }: { ads: AdsLibraryAd[]; loading: boolean }) {
  const grouped = useMemo(() => {
    // Group by page so the UI reads like "competitor research" rather
    // than a flat ad feed — most useful framing for the DTC research
    // use case Lens was built for.
    const m = new Map<string, AdsLibraryAd[]>();
    for (const ad of ads) {
      const key = ad.page_name || ad.page_id || "Unknown";
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(ad);
    }
    return Array.from(m.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [ads]);

  if (loading) return <div className="muted" style={{ padding: 24, textAlign: "center" }}>Loading…</div>;
  if (!ads.length) return <div className="muted" style={{ padding: 24, textAlign: "center" }}>No results yet. Run a search above.</div>;

  return (
    <div className="stack" style={{ gap: 24 }}>
      {grouped.map(([page, pageAds]) => (
        <section key={page}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>{page}</h3>
            <span className="muted" style={{ fontSize: 11 }}>{pageAds.length} ad{pageAds.length === 1 ? "" : "s"}</span>
          </div>
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {pageAds.map(ad => <AdCard key={ad.id} ad={ad} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function AdCard({ ad }: { ad: AdsLibraryAd }) {
  const body = ad.ad_creative_bodies?.[0];
  const title = ad.ad_creative_link_titles?.[0];
  const start = ad.ad_delivery_start_time?.split("T")[0];
  const stop = ad.ad_delivery_stop_time?.split("T")[0];
  return (
    <div className="atelier-tile" style={{ padding: 12 }}>
      <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 6 }}>
        {start}{stop ? ` → ${stop}` : " → present"}
        {ad.publisher_platforms?.length ? ` · ${ad.publisher_platforms.join(", ")}` : ""}
      </div>
      {title ? <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>{title}</div> : null}
      {body ? (
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.5, maxHeight: 120, overflow: "hidden" }}>
          {body}
        </div>
      ) : null}
      {ad.ad_snapshot_url ? (
        <a href={ad.ad_snapshot_url} target="_blank" rel="noreferrer" style={{ fontSize: 11, marginTop: 8, display: "inline-block" }}>
          Open in Ads Library ↗
        </a>
      ) : null}
    </div>
  );
}
