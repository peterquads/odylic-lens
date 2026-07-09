import { Link, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import type { AuthStatus } from "../lib/api";
import { endpoints } from "../lib/api";

export default function Landing({ auth }: { auth: AuthStatus | null }) {
  const nav = useNavigate();

  useEffect(() => {
    if (auth?.logged_in) nav("/brands", { replace: true });
  }, [auth, nav]);

  async function connectMeta() {
    const { authorize_url } = await endpoints.authStart();
    window.location.href = authorize_url;
  }

  const params = new URLSearchParams(window.location.search);
  const authError = params.get("auth_error");

  return (
    <div>
      <div className="hero">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginBottom: 18 }}>
          <img
            src="/odylic-logo.png"
            alt="Odylic"
            style={{ height: 56, display: "block" }}
          />
          <span style={{
            fontFamily: "'Roboto', sans-serif",
            fontWeight: 100,
            fontSize: 32,
            letterSpacing: "0.01em",
            color: "var(--color-text-muted)",
            lineHeight: 1,
            marginTop: 10,    /* drop down so lens baseline meets Odylic baseline (caps bottom) */
          }}>
            lens
          </span>
        </div>
        <h1>Creative Analysis for Meta Ads</h1>
        <p className="tagline">
          Bring your own Meta App. Connect once, see every creative across every ad
          account you can read. Live spend, CTR, CPL and ROAS in one table.
        </p>

        {authError ? (
          <div className="flag warn" style={{ display: "inline-block", marginBottom: 16 }}>
            Auth error: {authError}
          </div>
        ) : null}

        {auth?.app_configured ? (
          <div className="stack" style={{ maxWidth: 360, margin: "0 auto", alignItems: "center" }}>
            <button className="btn" style={{ fontSize: 13, padding: "12px 24px" }} onClick={connectMeta}>
              Connect Meta →
            </button>
            <span className="muted">You'll be redirected to facebook.com to authorize.</span>
          </div>
        ) : (
          <div className="atelier-tile" style={{ maxWidth: 540, margin: "0 auto", textAlign: "left" }}>
            <div className="label" style={{ marginBottom: 6 }}>Setup required</div>
            <p style={{ color: "var(--color-text-secondary)", margin: "0 0 16px" }}>
              No Meta App configured yet. Create one (about 5 minutes) and paste the
              credentials in the wizard. No <code>.env</code> editing required.
            </p>
            <Link to="/setup" className="btn">Start setup →</Link>
          </div>
        )}

        {/* Alt path: the bundled Ads Library token works without OAuth, so
            a fresh install can jump straight into competitor / industry
            research. Spend/ROAS/CTR aren't available on this path (Meta
            doesn't expose them in the public Ads Library), but creative
            payload + delivery window + countries / platforms all are. */}
        {auth?.library_available ? (
          <div style={{ marginTop: 20 }}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 8, letterSpacing: "0.04em", textTransform: "uppercase" }}>
              or — no setup, no login
            </div>
            <Link
              to="/library"
              className="btn"
              style={{
                fontSize: 12,
                padding: "10px 20px",
                background: "transparent",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-secondary)",
              }}
            >
              Browse the public Ads Library →
            </Link>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              Creative + delivery only. No spend / CTR / ROAS — those require connecting your Meta account.
            </div>
          </div>
        ) : null}
      </div>

      <div style={{ marginTop: 64, marginBottom: 24, maxWidth: 960, marginLeft: "auto", marginRight: "auto" }}>
        <div className="lens-grid">
          <FeatureCard
            title="Every creative, one table"
            body="Spend, CTR, CPM, leads, ROAS, plus the actual image, video, headline, body and CTA. Sort, filter, drill in."
          />
          <FeatureCard
            title="Active only by default"
            body="Paused ads no longer pollute your historical CPL. Toggle to see everything when you want the full picture."
          />
          <FeatureCard
            title="QC built in"
            body="Pixel staleness, day-over-day variance, paused-but-delivered gaps. Surfaced before you start analyzing."
          />
        </div>
      </div>
    </div>
  );
}

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="atelier-tile glass-hover" style={{ textAlign: "left" }}>
      <h3 style={{ marginBottom: 6 }}>{title}</h3>
      <p className="muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.55 }}>{body}</p>
    </div>
  );
}
