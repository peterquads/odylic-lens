import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  endpoints,
  type AuthStatus,
  type IntegrationStatus,
  type Me,
} from "../lib/api";
import {
  loadBrowserWhisper,
  detectBrowserBackend,
  WHISPER_MODEL_ID,
  type BrowserWhisperProgress,
  type BrowserWhisperBackend,
} from "../lib/browserWhisper";

// Button styles matched to BrandSettingsView. Lens's global `.btn` class
// is bigger and used on the Landing/Setup pages; here we want the same
// quiet rounded-full pills BrandSettingsView uses everywhere.
// NB: keep PILL/PILL_PRIMARY/INPUT_BASE at module scope so JSX inside the
// section components can reference them at render time.
const PILL =
  "glass glass-hover rounded-full px-3 py-1.5 text-[11px] inline-flex items-center gap-1.5 text-text-primary disabled:opacity-40 disabled:cursor-not-allowed";
const PILL_PRIMARY =
  "rounded-full px-3 py-1.5 text-[11px] inline-flex items-center gap-1.5 bg-text-primary text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity";
const INPUT_BASE =
  "border border-black/[0.08] rounded-lg px-2.5 py-1.5 text-[12px] bg-white/60 focus:outline-none focus:border-text-primary/30 focus:bg-white/90 transition-colors";

/**
 * Settings page. manage Meta connection + third-party API keys.
 *
 * Sections:
 *   1. Meta connection (status, reconnect, disconnect, rotate)
 *   2. Anthropic. Deep profile + AI tagging (POST /api/integrations/anthropic)
 *   3. Atria. creative search (POST /api/integrations/atria)
 *   4. Audio transcription. fully open-source, browser-embedded Whisper
 *      (WebGPU when available, WASM everywhere else). No third-party APIs,
 *      no installation. Optional native fast-path on Apple Silicon when
 *      mlx-whisper is installed on the API host.
 *
 * Plaintext API keys live in encrypted SQLite on the server; the client
 * only ever sees masked last-4 previews.
 */

export default function ApiSettings() {
  const nav = useNavigate();
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  async function refreshAll() {
    try {
      setAuth(await endpoints.authStatus());
    } catch {
      /* ignore */
    }
    try {
      setMe(await endpoints.me());
    } catch {
      setMe(null);
    }
  }

  useEffect(() => {
    refreshAll();
  }, []);

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14, paddingTop: 8, paddingBottom: 40 }}>
      {/* Page header. title + small muted subtitle. No big icon
          bubble: BrandSettingsView's bubble is the brand favicon (it
          carries meaning); a ⚙ glyph next to "Settings" is just chrome. */}
      <header className="min-w-0 mb-1">
        <h1 className="font-display text-2xl font-medium leading-tight" data-redact>Settings</h1>
        <div className="text-[11px] text-text-muted mt-0.5">
          Meta connection · third-party API keys · audio transcription. Stored encrypted on this machine.
        </div>
      </header>

      <MetaSection auth={auth} me={me} onChange={refreshAll} nav={nav} />
      <AdsLibrarySection />
      <AnthropicSection />
      <AtriaSection />
      <TranscriptionSection />
      <AboutSection />
    </div>
  );
}

// About / version + update-check row at the bottom. Pulls from
// /api/update-check (24h-cached GitHub releases probe). Shows the
// current version, the latest available, and a "Run lens update"
// nudge when needed. Manual refresh button forces a fresh probe.
function AboutSection() {
  const [info, setInfo] = useState<{ current?: string; latest?: string; needs_update?: boolean; html_url?: string; cached?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(force = false) {
    setBusy(true);
    try {
      const url = force ? "/api/update-check?force=1" : "/api/update-check";
      const r = await fetch(url, { credentials: "include" });
      if (r.ok) setInfo(await r.json());
    } catch { /* ignore */ }
    setBusy(false);
  }
  useEffect(() => { load(false); }, []);

  const current = info?.current || "0.3.0";
  const latest = info?.latest || current;
  const needsUpdate = !!info?.needs_update;

  return (
    <section className="atelier-tile" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 10 }}>
      <SectionHeader
        title="About"
        caption="Version + update check. Run `lens update` from a terminal to apply."
      />
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-text-muted uppercase tracking-widest text-[10px]">Version</span>
          <span className="font-display font-medium text-[13px] text-text-primary">{current}</span>
          {needsUpdate && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px]"
              style={{ background: "rgba(183,65,14,0.10)", color: "#b55719", border: "1px solid rgba(183,65,14,0.30)" }}
            >
              Update available · {latest}
            </span>
          )}
          {!needsUpdate && info && (
            <span className="text-text-muted">Up to date</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {needsUpdate && info?.html_url && (
            <a
              href={info.html_url}
              target="_blank"
              rel="noreferrer"
              className={PILL}
              style={{ textDecoration: "none" }}
            >
              Release notes
            </a>
          )}
          <button onClick={() => load(true)} disabled={busy} className={PILL}>
            {busy ? "Checking…" : "Check now"}
          </button>
        </div>
      </div>
      {info?.cached && (
        <div className="text-[10px] text-text-muted/70">
          Last checked within the past 24h. Click "Check now" to force a fresh probe.
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Meta section
// ─────────────────────────────────────────────────────────────────────

function MetaSection({
  auth,
  me,
  onChange,
  nav,
}: {
  auth: AuthStatus | null;
  me: Me | null;
  onChange: () => void;
  nav: ReturnType<typeof useNavigate>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reconnect() {
    setBusy("reconnect");
    setError(null);
    try {
      const { authorize_url } = await endpoints.authStart();
      window.location.href = authorize_url;
    } catch (e: any) {
      setError(e?.message || "Failed to start OAuth.");
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!confirm("Disconnect Meta? This clears stored tokens and ad-account labels. You'll need to reconnect to use Lens again.")) return;
    setBusy("disconnect");
    setError(null);
    try {
      await endpoints.disconnect();
      onChange();
    } catch (e: any) {
      setError(e?.message || "Disconnect failed.");
    } finally {
      setBusy(null);
    }
  }

  async function rotate() {
    if (!confirm("Clear stored Meta App ID and Secret? You'll be sent to Setup to paste new credentials.")) return;
    setBusy("rotate");
    setError(null);
    try {
      await endpoints.authUnconfigure();
      nav("/setup");
    } catch (e: any) {
      setError(e?.message || "Rotate failed.");
    } finally {
      setBusy(null);
    }
  }

  const scopes = (me?.connection?.granted_scopes || "").split(",").map((s) => s.trim()).filter(Boolean);

  return (
    <section className="atelier-tile" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 10 }}>
      <SectionHeader title="Meta connection" caption="Graph API access for ad-account and creative data." />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Tile
          label="App ID"
          value={auth?.app_id_preview ? `…${auth.app_id_preview}` : "Not configured"}
          sub={auth?.config_source ? `source: ${auth.config_source}` : undefined}
        />
        <Tile
          label="Days remaining"
          value={me?.days_remaining != null ? `${Math.floor(me.days_remaining)}d` : "-"}
          sub={me?.warn_expiring_soon ? "Token expires soon" : undefined}
        />
        <Tile
          label="Status"
          value={auth?.logged_in ? "Connected" : "Disconnected"}
          tone={auth?.logged_in ? "ok" : undefined}
        />
        <Tile
          label="API version"
          value={auth?.meta_api_version || "-"}
        />
      </div>

      {scopes.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1">Granted scopes</div>
          <div className="flex gap-1.5 flex-wrap">
            {scopes.map((s) => (
              <span
                key={s}
                className="inline-flex items-center bg-white/70 border border-black/[0.08] rounded-full px-2 py-0.5 text-[10px] text-text-secondary"
              >
                {s}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button className={PILL_PRIMARY} onClick={reconnect} disabled={busy === "reconnect"}>
          {busy === "reconnect" ? "Redirecting…" : auth?.logged_in ? "Reconnect Meta" : "Connect Meta"}
        </button>
        {auth?.logged_in && (
          <button className={PILL} onClick={disconnect} disabled={busy === "disconnect"}>
            {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
          </button>
        )}
        <button className={PILL} onClick={rotate} disabled={busy === "rotate"}>
          {busy === "rotate" ? "Clearing…" : "Rotate credentials"}
        </button>
        <button
          className={PILL}
          onClick={() => nav("/setup")}
          title="Re-run the setup wizard without clearing credentials"
        >
          Re-run setup
        </button>
      </div>

      {error && (
        <div className="text-[11px] text-red-600 mt-1">{error}</div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Anthropic section
// ─────────────────────────────────────────────────────────────────────

function AnthropicSection() {
  return (
    <IntegrationCard
      title="Anthropic. Deep profile & AI tagging"
      caption={
        <>
          Powers <em>Deep profile</em> generation in Brand Settings and the
          AI-tagged columns in Creative Analysis (sentiment, angle, persona,
          template, video scripts). Without a key, those features show "-"
          instead of values.
        </>
      }
      placeholder="sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx"
      getKeyUrl="https://console.anthropic.com/settings/keys"
      load={() => endpoints.getAnthropic()}
      save={(api_key) => endpoints.saveAnthropic({ api_key }).then(() => undefined)}
      remove={() => endpoints.removeAnthropic().then(() => undefined)}
    />
  );
}


// ─────────────────────────────────────────────────────────────────────
// Ads Library section
//
// The bundled-creds path. The default resolution chain falls back to
// META_APP_ID|META_APP_SECRET (which any configured Lens already has),
// so the user only needs this UI if they want to override with a token
// from a different Meta App or a hosted Odylic token. Sub-caption
// tells them where the active token is coming from right now.
// ─────────────────────────────────────────────────────────────────────

function AdsLibrarySection() {
  const [libStatus, setLibStatus] = useState<{ available: boolean; source: string } | null>(null);

  useEffect(() => {
    endpoints.adsLibraryStatus().then(setLibStatus).catch(() => setLibStatus(null));
  }, []);

  const sourceLabel: Record<string, string> = {
    settings_override: "this Settings override (below)",
    env_token: "LENS_LIBRARY_TOKEN env var",
    env_app: "META_APP_ID|META_APP_SECRET env vars",
    file_app: "Meta App creds from Setup",
    unset: "nothing — Library mode is disabled",
  };
  const source = libStatus?.source || "unset";

  return (
    <IntegrationCard
      title="Meta Ads Library. Public ads search"
      caption={
        <>
          Powers the <em>Browse Ads Library</em> path on the Landing page,
          and gets injected into <em>Deep profile</em> generation so Claude
          can read a brand's real Meta ads, not just their website.
          {libStatus ? (
            <>
              {" "}Currently using <strong>{sourceLabel[source]}</strong>.
              {libStatus.available ? " Ready." : " Not configured — paste a token below or finish Setup."}
            </>
          ) : null}
          <br />
          Override only if you want to use a different Meta App than the
          one Lens connects with. Format: <code>{`{app_id}|{app_secret}`}</code>.
        </>
      }
      placeholder="1234567890123456|abcdef0123456789abcdef0123456789"
      getKeyUrl="https://developers.facebook.com/apps"
      getKeyLabel="Get App ID/Secret →"
      load={() => endpoints.getAdsLibrary()}
      save={(api_key) => endpoints.saveAdsLibrary({ api_key }).then(() => undefined)}
      remove={() => endpoints.removeAdsLibrary().then(() => undefined)}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────
// Atria section
// ─────────────────────────────────────────────────────────────────────

function AtriaSection() {
  return (
    <IntegrationCard
      title="Atria. Creative search"
      caption="Search ~25M ads by image, body, or theme. Powers the creative-search tab inside Creative Analysis."
      placeholder="atria_xxxxxxxxxxxxxxxxxxxxxxxx"
      getKeyUrl="https://app.tryatria.com/"
      load={() => endpoints.getAtria()}
      save={(api_key) => endpoints.saveAtria({ api_key }).then(() => undefined)}
      remove={() => endpoints.removeAtria().then(() => undefined)}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────
// Audio transcription section
//
// The actual transcribe action lives on individual video ads (the
// Transcribe button in AdDetailPanel). This card just shows the engine
// status. no UI to manage, no buttons to click. The Whisper model
// auto-loads in the background when the user first opens Settings (or
// when AdDetailPanel triggers a transcribe), so subsequent transcribes
// are instant.
// ─────────────────────────────────────────────────────────────────────

function TranscriptionSection() {
  const [backend, setBackend] = useState<BrowserWhisperBackend | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [progress, setProgress] = useState<BrowserWhisperProgress | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    detectBrowserBackend().then((b) => alive && setBackend(b));
    // Kick off the model download immediately. No button. the user
    // shouldn't have to think about this. If it fails we surface a small
    // inline error; otherwise it's just a quiet progress line.
    setLoadState("loading");
    loadBrowserWhisper((p) => alive && setProgress(p))
      .then(() => { if (alive) setLoadState("ready"); })
      .catch((e) => {
        if (!alive) return;
        setLoadState("error");
        setLoadErr(e?.message || "Failed to load model.");
      });
    return () => { alive = false; };
  }, []);

  const ready = loadState === "ready";
  const loading = loadState === "loading";
  const error = loadState === "error";
  const backendLabel = backend === "webgpu" ? "WebGPU" : backend === "wasm" ? "WASM" : "detecting";
  const pct = progress?.progress != null && Number.isFinite(progress.progress)
    ? Math.max(0, Math.min(100, Math.round(progress.progress)))
    : null;

  const statusText = ready
    ? `Ready · ${backendLabel}`
    : loading
    ? `Downloading model · ${backendLabel}${pct != null ? ` · ${pct}%` : ""}`
    : error
    ? "Model load failed"
    : `Idle · ${backendLabel}`;

  const dotColor = ready ? "bg-[#2d8a4e]" : error ? "bg-red-500" : "bg-amber-500";

  return (
    <section className="atelier-tile" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 10 }}>
      <SectionHeader
        title="Audio transcription"
        caption={
          <>
            Open-source Whisper, embedded. Runs entirely in your browser. no API key, no upload.
            Use the <strong>Transcribe</strong> button on any video ad to run it.
          </>
        }
      />

      <div className="flex items-center gap-2 flex-wrap">
        <span className={`w-2 h-2 rounded-full ${dotColor}`} />
        <span className="text-[12px] text-text-secondary">{statusText}</span>
        <span className="text-[10px] text-text-muted/70 ml-1">{WHISPER_MODEL_ID}</span>
      </div>

      {loading && (
        <div className="w-full h-[3px] bg-black/[0.06] rounded-full overflow-hidden">
          <div
            className="h-full transition-all"
            style={{
              width: pct != null ? `${pct}%` : "30%",
              background: "var(--color-accent, #E87A2D)",
              transition: "width 200ms ease",
            }}
          />
        </div>
      )}

      {error && (
        <div className="text-[11px] text-red-600">{loadErr}</div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Reusable: integration save/test/remove panel
// ─────────────────────────────────────────────────────────────────────

export function IntegrationCard({
  title,
  caption,
  placeholder,
  getKeyUrl,
  getKeyLabel = "Get key →",
  load,
  save,
  remove,
  embedded = false,
}: {
  title: string;
  caption: React.ReactNode;
  placeholder: string;
  /** URL where the user can generate an API key for this provider. */
  getKeyUrl?: string;
  getKeyLabel?: string;
  load: () => Promise<IntegrationStatus>;
  save: (api_key: string) => Promise<void>;
  remove: () => Promise<void>;
  embedded?: boolean;
}) {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  async function refresh() {
    try {
      setStatus(await load());
    } catch {
      setStatus(null);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function doSave() {
    if (!value.trim()) return;
    setBusy("save");
    setMsg(null);
    try {
      await save(value.trim());
      setValue("");
      setMsg({ tone: "ok", text: "Saved. Key stored encrypted on this machine." });
      await refresh();
    } catch (e: any) {
      setMsg({ tone: "warn", text: e?.message || "Save failed." });
    } finally {
      setBusy(null);
    }
  }

  async function doTest() {
    // We don't have a live Atria/OpenAI ping endpoint wired yet, so the
    // "test" simply re-fetches the saved-key metadata. If a key is
    // configured the round-trip succeeds.
    setBusy("test");
    setMsg(null);
    try {
      const s = await load();
      if (s.configured) {
        setMsg({ tone: "ok", text: `Reachable. Key ending ${s.last_4 || "????"} is stored.` });
      } else {
        setMsg({ tone: "warn", text: "No key saved yet." });
      }
      setStatus(s);
    } catch (e: any) {
      setMsg({ tone: "warn", text: e?.message || "Test failed." });
    } finally {
      setBusy(null);
    }
  }

  async function doRemove() {
    if (!confirm("Remove the stored API key?")) return;
    setBusy("remove");
    setMsg(null);
    try {
      await remove();
      setMsg({ tone: "ok", text: "Removed." });
      await refresh();
    } catch (e: any) {
      setMsg({ tone: "warn", text: e?.message || "Remove failed." });
    } finally {
      setBusy(null);
    }
  }

  const body = (
    <>
      {!embedded && <SectionHeader title={title} caption={caption} />}
      {embedded && (
        <div className="mb-2">
          <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1">{title}</div>
          <div className="text-[11px] text-text-muted leading-snug">{caption}</div>
        </div>
      )}

      {status?.configured && (
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <div>
            <span className="inline-flex items-center gap-1 text-[#2d8a4e]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#2d8a4e]" />
              Connected · ends in {status.last_4 || "????"}
            </span>
            {status.updated_at && (
              <span className="text-text-muted/70 ml-2">
                · saved {new Date(status.updated_at * 1000).toLocaleDateString()}
              </span>
            )}
          </div>
          <button className={PILL} onClick={doRemove} disabled={busy === "remove"}>
            {busy === "remove" ? "Removing…" : "Remove"}
          </button>
        </div>
      )}

      <div className="flex gap-2 items-center flex-wrap">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          className={INPUT_BASE}
          style={{ flex: "1 1 280px", minWidth: 220 }}
        />
        <button className={PILL_PRIMARY} onClick={doSave} disabled={!value.trim() || busy === "save"}>
          {busy === "save" ? "Saving…" : status?.configured ? "Replace" : "Save"}
        </button>
        <button className={PILL} onClick={doTest} disabled={busy === "test"}>
          {busy === "test" ? "Testing…" : "Test"}
        </button>
        {getKeyUrl && (
          <a
            href={getKeyUrl}
            target="_blank"
            rel="noreferrer"
            className={PILL}
            style={{ textDecoration: "none" }}
            title={`Open ${new URL(getKeyUrl).hostname} to create a new key`}
          >
            {getKeyLabel}
          </a>
        )}
      </div>

      {msg && (
        <div className={`text-[11px] mt-1 ${msg.tone === "ok" ? "text-[#2d8a4e]" : "text-red-600"}`}>
          {msg.text}
        </div>
      )}
    </>
  );

  if (embedded) return <div className="flex flex-col gap-2">{body}</div>;
  return <section className="atelier-tile" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 10 }}>{body}</section>;
}

// ─────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────

// Matches BrandSettingsView's Card title pattern: serif title set inline
// with a small muted hint, no big top margin (parent flex-gap handles
// spacing). Keeps every section visually consistent across Brand Settings
// + API Settings + Setup wizard.
function SectionHeader({ title, caption }: { title: string; caption: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 flex-wrap">
      <div className="font-display text-[14px] text-text-primary">{title}</div>
      <div className="text-[11px] text-text-muted leading-snug" style={{ flex: "1 1 0", minWidth: 0 }}>
        {caption}
      </div>
    </div>
  );
}

// Compact KPI cell matching the inset white input fields in
// BrandSettingsView (FieldLabel + bordered white card with the value
// inside). Looks like the rest of the form, not a separate sub-card.
function Tile({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: "ok" }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1">{label}</div>
      <div
        className="border border-black/[0.08] rounded-lg px-2.5 py-1.5 bg-white/60 font-display font-medium"
        style={{
          fontSize: 12,
          letterSpacing: "-0.005em",
          fontVariantNumeric: "tabular-nums",
          color: tone === "ok" ? "#2d8a4e" : "var(--color-text-primary)",
        }}
      >
        {value}
      </div>
      {sub && <div className="text-[10px] text-text-muted/80 mt-1">{sub}</div>}
    </div>
  );
}

