import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { endpoints, type AuthStatus, type CredentialCheck } from "../lib/api";
import { IntegrationCard } from "./ApiSettings";

/**
 * Setup wizard. Meta App creation walkthrough, accurate to May 2026.
 *
 * Tested end-to-end against the live Meta developer console. Reflects:
 *   - The use-case-first flow (Other → Business is dead; pick the specific use case)
 *   - "Add products to your app" section being removed (use case bundles them)
 *   - "Standard Access" rebranded to "Ready for testing"
 *   - localhost being auto-allowed in Dev mode (cannot be added manually)
 *   - "Authorize callback URL" on Advanced being native/desktop-only
 *   - The red "Currently Ineligible for Submission" banner being benign
 *   - Dev mode being indefinitely sustainable for self-hosted
 */

// Where to land after finishing setup. The standalone Funnel Viewer passes
// ?return=/funnel-demo; stash it in sessionStorage so the OAuth round-trip
// to facebook.com and back doesn't lose it. Default stays the Lens flow.
export function setupReturnPath(): string {
  try {
    const q = new URLSearchParams(window.location.search).get("return");
    if (q && q.startsWith("/")) {
      sessionStorage.setItem("setup_return", q);
      return q;
    }
    return sessionStorage.getItem("setup_return") || "/brands";
  } catch {
    return "/brands";
  }
}
const IS_FUNNEL_FLOW = () => setupReturnPath().includes("funnel");

// Short labels keep every pill the same shape — the stepper is a
// progress indicator, not a place to fit a full sentence.
const STEPS = [
  { id: 1, title: "Prerequisites" },
  { id: 2, title: "Create app" },
  { id: 3, title: "Permissions" },
  { id: 4, title: "Credentials" },
  { id: 5, title: "Connect" },
  { id: 6, title: "Integrations" },
];

export default function Setup({ auth }: { auth: AuthStatus | null }) {
  const [step, setStep] = useState(() => (auth?.app_configured ? 5 : 1));
  const [redirectUri, setRedirectUri] = useState(
    // Production-mode default: same-origin API on :8765. The hardcoded
    // :3001 fallback was a leftover from the Atelier port and caused
    // users to register a callback that didn't exist.
    auth?.redirect_uri || `${window.location.protocol}//${window.location.hostname}:8765/api/auth/callback`
  );

  return (
    // Wrapper provides the page-frame: side gutters on small screens,
    // generous top padding so the header doesn't butt against the
    // browser chrome, and a max-width that keeps reading line-length
    // tight on big monitors. Previously this lived implicitly on #root
    // via gradient backgrounds — when those were removed for being
    // visually noisy, the page started reading as if it had been
    // shoved against the top-left corner with no breathing room.
    <div style={{
      maxWidth: 880,
      margin: "0 auto",
      padding: "48px 24px 64px",
    }}>
      <header style={{ marginBottom: 24 }}>
        {/* Odylic lockup. mirrors the Landing page wordmark so onboarding
            feels like a continuation of the brand, not a separate utility
            page. */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 18 }}>
          <img
            src="/odylic-logo.png"
            alt="Odylic"
            style={{ height: 36, display: "block" }}
          />
          <span style={{
            fontFamily: "'Roboto', sans-serif",
            fontWeight: 100,
            fontSize: 22,
            letterSpacing: "0.01em",
            color: "var(--color-text-muted)",
            lineHeight: 1,
            marginTop: 6,
          }}>
            {IS_FUNNEL_FLOW() ? "funnel viewer" : "lens"}
          </span>
        </div>
        <div className="label" style={{ marginBottom: 8 }}>Onboarding</div>
        <h1 style={{ marginBottom: 8 }}>
          Connect Meta to {IS_FUNNEL_FLOW() ? "the Funnel Viewer" : "Odylic Lens"}
        </h1>
        <p style={{ color: "var(--color-text-secondary)", fontSize: 13, margin: 0 }}>
          5 minutes. You'll create your own Meta App, verify the right permissions,
          and paste credentials. Nothing leaves your machine. You stay in Meta's
          Development mode forever. no App Review, no business verification, no
          publishing.
        </p>
      </header>

      <Stepper step={step} setStep={setStep} />

      <div style={{ marginTop: 32 }}>

        {step === 1 && <StepPrereqs next={() => setStep(2)} />}
        {step === 2 && <StepCreateApp next={() => setStep(3)} back={() => setStep(1)} />}
        {step === 3 && <StepVerifyPerms next={() => setStep(4)} back={() => setStep(2)} />}
        {step === 4 && (
          <StepCredentials
            redirectUri={redirectUri}
            onRedirectUriChange={setRedirectUri}
            next={() => setStep(5)}
            back={() => setStep(3)}
          />
        )}
        {step === 5 && <StepTestConnect back={() => setStep(4)} onNextOptional={() => setStep(6)} />}
        {step === 6 && <StepOptionalIntegrations back={() => setStep(5)} />}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Stepper
// ─────────────────────────────────────────────────────────────────────

function Stepper({ step, setStep }: { step: number; setStep: (n: number) => void }) {
  return (
    // Use grid instead of flex-wrap so every pill is the same width and
    // a lonely pill on the last row (e.g. "6. Optional integrations" when
    // 5+1 wraps) doesn't stretch into a "massive bar" filling the row.
    // auto-fit + minmax keeps the pills compact on narrow viewports
    // and lays them out 1-row on wide ones.
    <ol style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
      gap: 6,
      listStyle: "none",
      padding: 0,
      margin: 0,
      paddingBottom: 16,
    }}>
      {STEPS.map((s) => {
        const isActive = s.id === step;
        const isDone = s.id < step;
        const color = isActive ? "var(--color-text-primary)" : isDone ? "var(--color-text-secondary)" : "var(--color-text-muted)";
        return (
          <li key={s.id} style={{ minWidth: 0, display: "flex" }}>
            <button
              onClick={() => setStep(s.id)}
              style={{
                // Fixed pill height + single-line text so every step has
                // the same shape regardless of label length. min-width: 0
                // on the <li> + overflow: hidden + textOverflow ellipsis
                // means if the label is too long for the cell it
                // truncates with "…" rather than wrapping to a second row.
                width: "100%", height: 32, padding: "0 14px",
                background: isActive ? "rgba(255,255,255,0.75)" : isDone ? "rgba(255,255,255,0.45)" : "transparent",
                color, border: "1px solid rgba(255,255,255,0.45)", borderRadius: 9999,
                fontSize: 11, fontWeight: 500, textAlign: "left", fontFamily: "inherit",
                backdropFilter: "blur(40px) saturate(180%)", WebkitBackdropFilter: "blur(40px) saturate(180%)",
                transition: "background 0.15s ease, color 0.15s ease", cursor: "pointer",
                display: "flex", alignItems: "center",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              }}
            >
              <span style={{ opacity: 0.7, marginRight: 4, flexShrink: 0 }}>
                {isDone ? "✓" : `${s.id}.`}
              </span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{s.title}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Step 1 · Prerequisites
// ─────────────────────────────────────────────────────────────────────

function StepPrereqs({ next }: { next: () => void }) {
  return (
    <Card>
      <h2>Before you start</h2>
      <Checklist
        items={[
          {
            label: "A Facebook account",
            sub: "You'll log in with it during the OAuth step. The same account must be the Admin of the Meta App you create in Step 2.",
          },
          {
            label: "Access to at least one ad account",
            sub: (
              <>
                Either personal, or in a{" "}
                <a href="https://business.facebook.com" target="_blank" rel="noreferrer">
                  Meta Business Manager
                </a>{" "}
                where your role is Admin or Advertiser. Lens will read whatever your Meta user can read, nothing more.
              </>
            ),
          },
          {
            label: "A Meta Developer account",
            sub: (
              <>
                Free, auto-created on first visit to{" "}
                <a href="https://developers.facebook.com" target="_blank" rel="noreferrer">
                  developers.facebook.com
                </a>.
              </>
            ),
          },
        ]}
      />
      <Callout tone="ok">
        <strong>Account-safety note.</strong> Dev mode is the safe choice and Meta designed it for this exact case (developers using their own apps on their own data). It never expires. What gets accounts banned is scraping data you don't own, sharing tokens across many users, hitting rate limits in the thousands per hour, or selling Meta data. none of which Lens does. Publishing your app to Live actually <em>increases</em> Meta's scrutiny.
      </Callout>
      <Callout tone="info">
        <strong>You don't need any of these:</strong> App Review, business verification, privacy-policy URL, Terms of Service URL, App icon, Category, "Switch to Live mode," "Add to App Review" buttons, App Domains entry, Authorize callback URL on the Advanced page, Domain manager, Data Deletion callback. Any banner asking for these is for going Live, which you're not doing.
      </Callout>
      <Nav onlyNext onNext={next} nextLabel="Got it →" />
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Step 2 · Create the Meta App
// ─────────────────────────────────────────────────────────────────────

function StepCreateApp({ next, back }: { next: () => void; back: () => void }) {
  return (
    <Card>
      <h2>Create the Meta App</h2>
      <p style={{ color: "var(--color-text-secondary)" }}>
        Meta's console is <strong>use-case-first</strong> as of 2026. The old "Other use case + Business app type" flow most tutorials show is dead. There's no "Add products to your app" section any more. the use case you pick bundles Facebook Login for Business and Marketing API automatically.
      </p>
      <ol className="numbered">
        <li>
          Open{" "}
          <a href="https://developers.facebook.com/apps/" target="_blank" rel="noreferrer">developers.facebook.com/apps</a>{" "}
          → click <Pill>Create app</Pill> (top right).
        </li>
        <li>
          <strong>App details:</strong>
          <ul>
            <li><strong>App name</strong>. anything you'll recognize. Example: <Mono>Odylic Lens (your name)</Mono></li>
            <li><strong>App contact email</strong>. your email</li>
          </ul>
          Click <Pill>Next</Pill>.
        </li>
        <li>
          <strong>Use case picker:</strong> pick{" "}
          <Pill>Create and manage ads with Marketing API</Pill>. <em>Do NOT pick "Other"</em>. that path is for non-ads apps and won't expose the Marketing API surface. Click <Pill>Next</Pill>.
        </li>
        <li>
          <strong>Business portfolio:</strong> if you have a Meta Business Manager, select it. Otherwise pick "I don't want to connect a business portfolio yet." Click <Pill>Next</Pill>.
        </li>
        <li>
          <strong>Publishing requirements:</strong> Meta lists what you'd need to take the app Live (privacy policy, business verification, screencast demo, etc). Ignore all of it. Click <Pill>Next</Pill>.
        </li>
        <li>
          Click <Pill>Create app</Pill>. Meta will ask you to re-enter your Facebook password.
        </li>
      </ol>
      <Callout tone="info">
        You're now in the App Dashboard. Left sidebar shows: <Mono>Dashboard</Mono>, <Mono>Required actions</Mono>, <Mono>Use cases</Mono>, <Mono>Facebook Login for Business</Mono> (already set up), <Mono>Review</Mono>, <Mono>Publish</Mono>, <Mono>App settings → Basic/Advanced</Mono>, <Mono>App roles</Mono>, <Mono>Alert Inbox</Mono>. There is <em>no</em> "Add products" item.
      </Callout>
      <Nav back={back} next={next} nextLabel="App created →" />
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Step 3 · Verify permissions
// ─────────────────────────────────────────────────────────────────────

function StepVerifyPerms({ next, back }: { next: () => void; back: () => void }) {
  return (
    <Card>
      <h2>Verify the permissions</h2>
      <p style={{ color: "var(--color-text-secondary)" }}>
        Picking the use case automatically requested the permissions Lens needs. This step is a quick sanity check that they show the right status.
      </p>
      <ol className="numbered">
        <li>
          On the Dashboard, click{" "}
          <Pill>Customize the Create &amp; manage ads with Marketing API use case</Pill> (in the right panel under "App customization and requirements").
        </li>
        <li>
          You're now on the <strong>Permissions and features</strong> tab. Confirm these three rows show <strong>Ready for testing</strong> in the Status column:
          <ul>
            <li><Mono>ads_read</Mono></li>
            <li><Mono>ads_management</Mono></li>
            <li><Mono>business_management</Mono></li>
          </ul>
        </li>
      </ol>
      <Callout tone="info">
        <strong>"Ready for testing" = old "Standard Access".</strong> Meta renamed the tier in 2025. It lets the app's Admins, Developers, and Testers use these permissions on their own ad accounts indefinitely without App Review. Don't touch the <Pill>Get Advanced Access</Pill> buttons. Advanced Access requires App Review and you don't need it.
      </Callout>
      <Callout tone="info">
        <strong>"Marketing API Access Tier" = "Limited access" is fine.</strong> The Limited tier caps you at 25 ad accounts and standard rate limits. Single-user self-hosted never trips that.
      </Callout>
      <Callout tone="warn">
        <strong>Do NOT click "+ Add to App Review"</strong> on any of these: <Mono>catalog_management</Mono>, <Mono>email</Mono>, <Mono>pages_manage_ads</Mono>, <Mono>threads_business_basic</Mono>, <Mono>Business Asset User Profile Access</Mono>. Lens doesn't use them and App Review wastes weeks for permissions you'll never call.
      </Callout>
      <Nav back={back} next={next} nextLabel="Permissions look right →" />
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Step 4 · Paste credentials
// ─────────────────────────────────────────────────────────────────────

function StepCredentials({
  redirectUri,
  onRedirectUriChange,
  next,
  back,
}: {
  redirectUri: string;
  onRedirectUriChange: (s: string) => void;
  next: () => void;
  back: () => void;
}) {
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function save() {
    setSubmitting(true);
    setError(null);
    setOk(false);
    try {
      await endpoints.authConfigure({
        app_id: appId.trim(),
        app_secret: appSecret.trim(),
        redirect_uri: redirectUri.trim(),
      });
      setOk(true);
    } catch (e: any) {
      setError(e.message || "Failed to save");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <h2>Paste your App credentials</h2>
      <p style={{ color: "var(--color-text-secondary)" }}>
        Both values live on the same page: <Pill>App settings → Basic</Pill> in the Meta app's left sidebar.
      </p>

      <Callout tone="warn">
        <strong>The red "Currently Ineligible for Submission" banner at the top of the Basic page is benign.</strong> It lists fields you'd need to fill in to submit for App Review (App icon, Privacy policy URL, Category). You're not submitting. Ignore it.
      </Callout>

      <Field
        label="App ID"
        hint={
          <>
            At the top of <Pill>App settings → Basic</Pill>, in the left column. All digits, typically 15–16 chars.
          </>
        }
      >
        <input type="text" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="e.g. 1234567890123456" inputMode="numeric" />
      </Field>

      <Field
        label="App Secret"
        hint={
          <>
            Right column on the same page. Click <Pill>Show</Pill> next to App Secret (Meta will require your Facebook password). 32-char hex string. <strong>Treat it like a password. never commit it, share it, or paste it in chat.</strong>
          </>
        }
      >
        <input type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder="32-character hex string" />
      </Field>

      <Field
        label="OAuth Redirect URI"
        hint={
          <>
            Auto-detected from your Lens API port. Used only by Meta to bounce you back after OAuth. Localhost is auto-allowed by Meta in Dev mode, so you don't register it anywhere in the Meta console. it just works.
          </>
        }
      >
        <input type="text" value={redirectUri} onChange={(e) => onRedirectUriChange(e.target.value)} />
      </Field>

      {error && (
        <Callout tone="warn">
          <strong>Save failed.</strong> {error}
        </Callout>
      )}
      {ok && (
        <Callout tone="ok">
          ✓ Credentials saved (encrypted at rest with <Mono>LENS_SECRET_KEY</Mono>). Advance to Step 5 to verify with Meta.
        </Callout>
      )}

      <Nav
        back={back}
        next={next}
        nextLabel="Test connection →"
        nextDisabled={!ok}
        extraLeft={
          <button className="btn" onClick={save} disabled={!appId || !appSecret || submitting}>
            {submitting ? "Saving…" : "Save credentials"}
          </button>
        }
      />
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Step 5 · Connect
// ─────────────────────────────────────────────────────────────────────

function StepTestConnect({ back, onNextOptional }: { back: () => void; onNextOptional?: () => void }) {
  const _nav = useNavigate();
  const [check, setCheck] = useState<CredentialCheck | null>(null);
  const [testing, setTesting] = useState(false);
  const [connecting, setConnecting] = useState(false);

  async function runCheck() {
    setTesting(true);
    setCheck(null);
    try {
      const r = await endpoints.authCheck();
      setCheck(r);
    } catch (e: any) {
      setCheck({ ok: false, error: e.message });
    } finally {
      setTesting(false);
    }
  }

  async function connect() {
    setConnecting(true);
    try {
      const { authorize_url } = await endpoints.authStart();
      window.location.href = authorize_url;
    } catch (e: any) {
      setCheck({ ok: false, error: e.message });
      setConnecting(false);
    }
  }

  useEffect(() => {
    runCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card>
      <h2>Test &amp; connect</h2>
      <p style={{ color: "var(--color-text-secondary)" }}>
        Test validates your App ID + Secret with Meta. If green, click Connect Meta and authorize on facebook.com. you'll be redirected back to Lens with your real ad accounts populated.
      </p>

      <button className="btn secondary" onClick={runCheck} disabled={testing}>
        {testing ? "Testing…" : "Re-run test"}
      </button>

      {check && (
        <div style={{ marginTop: 16 }}>
          {check.ok ? (
            <Callout tone="ok">
              <strong>✓ Credentials accepted by Meta.</strong>
              {check.redirect_uri ? (
                <div style={{ marginTop: 8, fontSize: 12 }}>
                  Redirect URI: <Mono>{check.redirect_uri}</Mono>
                </div>
              ) : null}
            </Callout>
          ) : (
            <Callout tone="warn">
              <strong>✗ Meta rejected the credentials.</strong>
              <div style={{ marginTop: 8 }}>{check.error}</div>
              {check.code != null ? (
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  Error code: {check.code} {check.type ? `(${check.type})` : ""}
                </div>
              ) : null}
              {check.hint ? (
                <div style={{ marginTop: 8 }}>
                  <strong>Hint:</strong> {check.hint}
                </div>
              ) : null}
            </Callout>
          )}
        </div>
      )}

      <div style={{ marginTop: 32 }}>
        <h3>Common issues</h3>
        <Troubleshooting />
      </div>

      <Nav
        back={back}
        onNext={connect}
        nextLabel={connecting ? "Redirecting…" : "Connect Meta →"}
        nextDisabled={!check?.ok || connecting}
        extraLeft={
          onNextOptional ? (
            <button className="btn secondary" onClick={onNextOptional}>
              Optional integrations →
            </button>
          ) : null
        }
      />
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Step 6 · Optional integrations (Atria + OpenAI)
// ─────────────────────────────────────────────────────────────────────

function StepOptionalIntegrations({ back }: { back: () => void }) {
  const nav = useNavigate();
  return (
    <Card>
      <h2>Optional integrations</h2>
      <p style={{ color: "var(--color-text-secondary)" }}>
        Add API keys to unlock optional features. Both are stored encrypted on this machine and can be
        rotated anytime from the Settings page. Skip if you don't have them. you can return here later.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 20, marginTop: 16 }}>
        <IntegrationCard
          title="Anthropic. Deep profile & AI tagging"
          caption={
            <>
              Powers <em>Deep profile</em> generation in Brand Settings and the AI-tagged columns in
              Creative Analysis (sentiment, angle, persona, template, video scripts). Without a key,
              those columns show "-". Get one at{" "}
              <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
                console.anthropic.com/settings/keys
              </a>.
            </>
          }
          placeholder="sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx"
          load={() => endpoints.getAnthropic()}
          save={(api_key) => endpoints.saveAnthropic({ api_key }).then(() => undefined)}
          remove={() => endpoints.removeAnthropic().then(() => undefined)}
          embedded
        />

        <IntegrationCard
          title="Atria. Creative search"
          caption={
            <>
              Atria powers creative search by image, body, or theme. Get a key at{" "}
              <a href="https://app.tryatria.com/" target="_blank" rel="noreferrer">app.tryatria.com</a>.
            </>
          }
          placeholder="atria_xxxxxxxxxxxxxxxxxxxxxxxx"
          load={() => endpoints.getAtria()}
          save={(api_key) => endpoints.saveAtria({ api_key }).then(() => undefined)}
          remove={() => endpoints.removeAtria().then(() => undefined)}
          embedded
        />

        <div className="atelier-tile" style={{ padding: 16 }}>
          <div className="label" style={{ marginBottom: 4 }}>Audio transcription</div>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            No setup needed. Lens uses an embedded open-source Whisper model that runs entirely in your
            browser (WebGPU when available, WASM everywhere else). Nothing is sent to a third party.
            Manage the model from <strong>Settings → Audio transcription</strong> after finishing setup.
          </div>
        </div>
      </div>

      <Nav
        back={back}
        onNext={() => nav(setupReturnPath())}
        nextLabel="Save and finish →"
        extraLeft={
          <button className="btn secondary" onClick={() => nav(setupReturnPath())}>
            Skip
          </button>
        }
      />
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Troubleshooting (rebuilt from actual debug sessions)
// ─────────────────────────────────────────────────────────────────────

function Troubleshooting() {
  const items = useMemo(
    () => [
      {
        q: "\"Error validating client secret.\" / \"Token exchange failed.\"",
        a: (
          <>
            Most common cause: you rotated the App Secret in Meta and the OLD one is still saved here in Lens. Go to <Pill>App settings → Basic</Pill> in Meta, click <Pill>Show</Pill> next to App Secret, copy the current value, then come back to Step 4 and re-paste. The Step 5 test will catch this before you ever click Connect.
          </>
        ),
      },
      {
        q: "After clicking Connect Meta I get \"Not Found\" on a localhost URL",
        a: (
          <>
            Meta redirected you back to the wrong port. Lens's redirect URI was set to one port (e.g. <Mono>:3001</Mono>) but the API is running on another (e.g. <Mono>:3201</Mono>), so Meta bounced you to a port that doesn't host Lens. Fix: make sure the OAuth Redirect URI in Step 4 matches the actual port the Lens API listens on (check <Mono>/api/status</Mono>). If you're running both Lens and Atelier, they cannot share port 3001.
          </>
        ),
      },
      {
        q: "I see \"http://localhost redirects are automatically allowed…\" when I try to add the URI to Meta",
        a: (
          <>
            Good news. that's Meta confirming you don't need to add it. Localhost is auto-allowed in Dev mode. Click the red X to dismiss your entry and skip the step entirely. Lens uses the URI internally for OAuth start; Meta accepts any <Mono>http://localhost</Mono> redirect when the app is in Dev mode.
          </>
        ),
      },
      {
        q: "I can't find \"Add products to your app\"",
        a: (
          <>
            It doesn't exist any more. Meta's current console bundles products with the use case you pick at app creation. If you chose <Pill>Create and manage ads with Marketing API</Pill> in Step 2, Facebook Login for Business and Marketing API are already wired up. you'll see them in the left sidebar.
          </>
        ),
      },
      {
        q: "I see \"Authorize callback URL\" under App settings → Advanced. is that the redirect URI?",
        a: (
          <>
            No. That field is for <em>native and desktop apps only</em> (notice the "Native or desktop app?" toggle directly above it). Lens is a web app. Leave it empty. The OAuth redirect URI you care about is under <Pill>Facebook Login for Business → Settings → Client OAuth settings → Valid OAuth Redirect URIs</Pill>. and even there, you don't need to add anything because localhost is auto-allowed.
          </>
        ),
      },
      {
        q: "Where is \"App Domains\"? Some tutorials say to add localhost there.",
        a: (
          <>
            It exists at <Pill>App settings → Basic → App domains</Pill>, but you can leave it empty. Older tutorials are out of date. Meta now auto-allows localhost in Dev mode without any allowlist entry. Only fill App Domains if you deploy Lens to a public domain (add <Mono>lens.yourdomain.com</Mono> as a chip).
          </>
        ),
      },
      {
        q: "\"Currently Ineligible for Submission\" red banner on the Basic page",
        a: (
          <>
            Benign. Meta is telling you that if you ever submit the app for App Review (to go Live), you'd need to provide an App icon, Privacy policy URL, and Category. You're never submitting. Ignore the banner permanently.
          </>
        ),
      },
      {
        q: "\"App not active\" / \"This app is in development mode\"",
        a: (
          <>
            Dev mode is the safe, supported state. The constraint is that only people listed in <Pill>App roles → Roles</Pill> (Administrator, Developer, Tester, or Analytics user) can connect. Make sure the Facebook account you're using to connect is the same one that created the app (it should be Administrator by default). If different, add yourself: <Pill>App roles → Roles → Add people</Pill>, role <strong>Administrator</strong>.
          </>
        ),
      },
      {
        q: "\"Permissions error\" / \"missing scope ads_read\"",
        a: (
          <>
            Three checks. (1) In <Pill>App roles → Roles</Pill>, you must be <strong>Administrator</strong> (not Developer or Tester). (2) In <Pill>Use cases → Customize → Permissions and features</Pill>, <Mono>ads_read</Mono> must say "Ready for testing." (3) The Facebook account you connected with must have at least Advertiser role on the ad accounts you're trying to read (check business.facebook.com → Users → People).
          </>
        ),
      },
      {
        q: "OAuth loops, hangs, or \"This is taking longer than usual\"",
        a: (
          <>
            Clear cookies for <Mono>facebook.com</Mono> and your Lens domain, then retry. If you have multiple Facebook accounts open in other tabs, log out of all of them except the one that owns the Meta App. Some Chrome extensions (privacy / tracking blockers) also break the OAuth bounce. test in an incognito window.
          </>
        ),
      },
      {
        q: "Token expired after 60 days",
        a: (
          <>
            User access tokens last ~60 days. When yours expires, you'll see a yellow chip in Lens's topbar. Click Connect Meta again. Lens re-issues a fresh 60-day token without re-prompting permissions. For zero-touch production deploys, generate a <strong>System User token</strong> in Business Manager (no expiry) and paste it as <Mono>META_SYSTEM_USER_TOKEN</Mono> in <Mono>.env</Mono>. System User token UI in Lens is planned for v0.2.
          </>
        ),
      },
      {
        q: "\"Switch to Live mode?\" Should I?",
        a: (
          <>
            No. Live mode requires App Review (4–6 weeks), business verification, a privacy-policy URL, a Terms of Service URL, an App icon (1024×1024), and a screencast demo. It's only useful when you want users <em>other than the app's Admins/Developers/Testers</em> to connect. Self-hosted Lens runs forever in Dev mode under "Ready for testing." Going Live actually <em>increases</em> Meta's scrutiny of your app and your Facebook account.
          </>
        ),
      },
      {
        q: "Will Meta ban my account for using a dev-mode app?",
        a: (
          <>
            No. Meta designed Dev mode for exactly this case. developers using their own apps on their own data. What gets accounts banned is scraping accounts you don't own, sharing tokens across many users, hitting rate limits in the thousands per hour, or selling Meta data to third parties. Lens does none of those. Standard Access / "Ready for testing" is indefinite.
          </>
        ),
      },
      {
        q: "I accidentally shared my App Secret in a screenshot or commit",
        a: (
          <>
            Treat it as compromised. Go to <Pill>App settings → Basic</Pill> in Meta, click <Pill>Reset</Pill> next to App Secret, copy the new value, and paste it into Lens Step 4 (re-save credentials). The old secret is immediately invalidated.
          </>
        ),
      },
      {
        q: "I get 0 ad accounts on the Brands page after connecting",
        a: (
          <>
            The Facebook account you connected with doesn't have access to any ad accounts. Go to{" "}
            <a href="https://business.facebook.com" target="_blank" rel="noreferrer">business.facebook.com</a>{" "}
            → Users → People. your account needs at least <strong>Advertiser</strong> role on a real ad account. If you only have personal-account access, your personal ad account should still appear (if you've ever created one in Ads Manager).
          </>
        ),
      },
    ],
    []
  );

  return (
    <div className="stack">
      {items.map((it, i) => (
        <details key={i} className="atelier-tile" style={{ padding: 16 }}>
          <summary style={{ cursor: "pointer", fontWeight: 500, fontSize: 13 }}>{it.q}</summary>
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.55 }}>{it.a}</div>
        </details>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// UI primitives
// ─────────────────────────────────────────────────────────────────────

// Match the visual language of BrandSettingsView's Card: lighter tile
// (atelier-tile, no heavy aurora glow), compact 16-18px padding, serif
// title set inline with a muted hint subtitle.
function Card({ children }: { children: React.ReactNode }) {
  return <div className="atelier-tile" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 14 }}>{children}</div>;
}

function Nav({ back, next, onNext, nextLabel, nextDisabled, onlyNext, extraLeft }: {
  back?: () => void; next?: () => void; onNext?: () => void;
  nextLabel?: string; nextDisabled?: boolean; onlyNext?: boolean;
  extraLeft?: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: 24, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      <div className="row" style={{ gap: 12 }}>
        {!onlyNext && back ? <button className="btn secondary" onClick={back}>← Back</button> : <span />}
        {extraLeft}
      </div>
      <button className="btn" onClick={onNext || next} disabled={nextDisabled}>
        {nextLabel || "Next"}
      </button>
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      display: "inline-block", padding: "1px 8px", borderRadius: 6,
      background: "rgba(0,0,0,0.05)", border: "1px solid rgba(0,0,0,0.06)",
      fontSize: "0.9em", fontWeight: 500, whiteSpace: "nowrap",
      color: "var(--color-text-primary)",
    }}>
      {children}
    </span>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code style={{
      background: "rgba(0,0,0,0.05)", padding: "1px 6px", borderRadius: 4,
      fontSize: "0.92em", color: "var(--color-text-primary)",
    }}>{children}</code>
  );
}

// Field. uppercase 10px eyebrow label + inline hint + inset white input
// (matches BrandSettingsView's FieldLabel + TextInput pattern).
function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1">
        <div className="text-[10px] uppercase tracking-widest text-text-muted">{label}</div>
      </div>
      <FullWidth>{children}</FullWidth>
      {hint && <div className="text-[10px] text-text-muted/80 mt-1.5 leading-snug">{hint}</div>}
    </div>
  );
}

function FullWidth({ children }: { children: React.ReactNode }) {
  return (
    <div className="full-width-field">
      <style>{`
        .full-width-field input {
          width: 100%;
          border: 1px solid rgba(0, 0, 0, 0.08);
          border-radius: 8px;
          padding: 8px 12px;
          font-size: 13px;
          background: rgba(255, 255, 255, 0.6);
          transition: border-color 0.15s ease, background 0.15s ease;
        }
        .full-width-field input:focus {
          outline: none;
          border-color: rgba(0, 0, 0, 0.25);
          background: rgba(255, 255, 255, 0.9);
        }
      `}</style>
      {children}
    </div>
  );
}

function Checklist({ items }: { items: { label: string; sub?: React.ReactNode }[] }) {
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: "16px 0" }}>
      {items.map((it, i) => (
        <li key={i} style={{
          display: "flex", gap: 12, padding: "10px 0",
          borderBottom: i < items.length - 1 ? "1px solid rgba(0,0,0,0.06)" : "none",
        }}>
          <span style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 22, height: 22, borderRadius: 11,
            background: "rgba(45, 138, 78, 0.10)",
            color: "var(--color-success)", fontWeight: 700, flexShrink: 0, fontSize: 12,
          }}>✓</span>
          <div>
            <div style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>{it.label}</div>
            {it.sub && (
              <div style={{ fontSize: 12, marginTop: 2, color: "var(--color-text-secondary)" }}>
                {it.sub}
              </div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Callout({ tone, children }: { tone: "info" | "warn" | "ok"; children: React.ReactNode }) {
  const styles = {
    ok:   { bg: "rgba(45,138,78,0.08)",  border: "rgba(45,138,78,0.25)",  color: "#1f5d2e" },
    warn: { bg: "rgba(196,122,21,0.08)", border: "rgba(196,122,21,0.25)", color: "#7d5a00" },
    info: { bg: "rgba(38,100,168,0.06)", border: "rgba(38,100,168,0.20)", color: "#1e4a7a" },
  }[tone];
  return (
    <div style={{
      background: styles.bg, border: `1px solid ${styles.border}`, color: styles.color,
      padding: "12px 16px", borderRadius: 12, margin: "16px 0",
      fontSize: 12, lineHeight: 1.55,
    }}>
      {children}
    </div>
  );
}
