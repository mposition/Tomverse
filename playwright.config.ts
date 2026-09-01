import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const baseURL = "http://127.0.0.1:3100";
const e2eTurnstileSiteKey =
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ||
  "tomverse-playwright-turnstile-site-key";
// This key is scoped to the isolated E2E server. It never protects production
// sessions, and keeps NextAuth's production secret requirement enabled.
const e2eNextAuthSecret =
  process.env.NEXTAUTH_SECRET || "tomverse-e2e-nextauth-secret-only-2026";
const networkGuard = resolve(process.cwd(), "tests/e2e/block-external-network.cjs").replaceAll("\\", "/");
const nodeOptions = [process.env.NODE_OPTIONS, `--require "${networkGuard}"`]
  .filter(Boolean)
  .join(" ");
const allowedRequestHosts = [
  ...(process.env.ALLOWED_REQUEST_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean),
  "127.0.0.1:3100",
  "localhost:3100",
].filter((host, index, hosts) => hosts.indexOf(host) === index);

// EXT-REAUDIT-F001. Some runners cannot reach cdn.playwright.dev, so
// `npx playwright install` fails and the Chromium projects cannot launch at
// all. Those images ship a pre-provisioned Chromium instead; pointing
// PLAYWRIGHT_CHROMIUM_EXECUTABLE at it lets the canonical projects run there.
//
// This is a capability fallback, never the default: unset -- which is the
// case in CI and on developer machines -- Playwright uses its own pinned
// build and nothing about the canonical projects changes. A run that sets it
// is NOT canonical, so its screenshots must not be treated as golden
// evidence (see docs/qa/canonical-visual-baseline.md).
const chromiumExecutablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
const chromiumLaunchOptions = chromiumExecutablePath
  ? { launchOptions: { executablePath: chromiumExecutablePath } }
  : {};

// The canonical visual baseline, pinned so a golden compares like with like.
// Locale and time zone both change what gets rasterised -- a locale picks a
// different font stack for the same text (`:lang()` selects Noto Sans KR/SC
// per docs/ui-contracts/typography.md), and a time zone moves every rendered
// date -- so neither may be inherited from whatever machine happens to be
// running.
//
// Device pixel ratio is deliberately NOT set here: it belongs to the device
// preset each project already declares, and forcing Pixel 5's 2.625 down to 1
// would silently re-rasterise every mobile golden. Full policy, including the
// runner image and which platforms may judge a golden at all, is in
// docs/qa/canonical-visual-baseline.md.
const canonicalRendering = {
  locale: "en-US",
  timezoneId: "UTC",
} as const;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  // A missing golden is a failure, not a blank to fill in.
  //
  // Playwright's default is "missing": when a screenshot has no baseline for
  // the current platform it writes one and reports the test as passed. That
  // is the quiet version of `--update-snapshots`, which the workflows are
  // already forbidden from carrying -- no flag is needed to produce it, and
  // the run is green either way, so nothing distinguishes "compared and
  // matched" from "there was nothing to compare against".
  //
  // It is not hypothetical. Baselines are platform-suffixed, so a run on any
  // platform the canonical image is not -- a developer's Windows machine, a
  // substitute runner -- has no baseline for a single golden. One such run
  // wrote 68 `-win32` files and passed all of them, and those files are
  // indistinguishable in the tree from goldens that were reviewed.
  //
  // "none" makes that case fail. Recording stays possible exactly where the
  // policy puts it: the `Record Visual Baseline` workflow passes
  // `--update-snapshots` on the command line, and a CLI flag overrides this.
  // See docs/qa/canonical-visual-baseline.md.
  updateSnapshots: "none",
  retries: process.env.CI ? 2 : 0,
  // One worker in CI, and it stays one. Asked again on 2026-09-01, when the
  // daily audit's suite outgrew its budget and a four-vCPU runner sitting
  // three-quarters idle for two and a half hours looked like the obvious
  // saving.
  //
  // It is the wrong one to take here. Screenshot comparison is the part of
  // this suite most sensitive to render timing under CPU contention -- the
  // Nightly Visual Regression workflow already says so in as many words --
  // and the goldens are judged in CI, not skipped there: the substitute-
  // browser gate in tests/e2e/support/canonical-visual.ts keys on
  // PLAYWRIGHT_CHROMIUM_EXECUTABLE, which no workflow sets. So a second
  // worker buys minutes and pays for them in golden stability, and the way
  // it would be paid is the quiet one: `retries: 2` above absorbs a flaky
  // golden as "passed on retry", which is the exact failure the nightly
  // overrides retries to zero to catch.
  //
  // The parallelism the audit needed was bought by sharding it instead
  // (.github/workflows/daily-security-audit.yml). A shard is a whole runner
  // of its own, so it adds no contention inside the process comparing
  // pixels -- more shards is the lever, and it is safe in a way more workers
  // is not.
  workers: process.env.CI ? 1 : 4,
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "npm run start:e2e",
    url: baseURL,
    env: {
      ALLOWED_REQUEST_HOSTS: allowedRequestHosts.join(","),
      DATABASE_URL:
        "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1",
      DISABLE_CSP_UPGRADE_INSECURE_REQUESTS: "true",
      DIRECT_URL:
        "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1",
      E2E_AUTH_BYPASS: "true",
      E2E_DISABLE_DATABASE: "true",
      // The assistant knowledge flag lives in `AppSetting`, which the line
      // above removes -- so without this the panel never renders and the
      // specs that mock its endpoint assert against nothing. Safe only in
      // company: `isE2EAssistantKnowledgeEnabled()` additionally requires
      // loopback and both short-circuits above.
      E2E_ASSISTANT_KNOWLEDGE_ENABLED: "true",
      // The deterministic search backend. Without it this server holds no
      // credential, `resolveWebSearchBackendReadiness()` reports nothing
      // reachable, and every Google model renders as unable to search -- which
      // is correct behaviour and makes the search specs assert against a
      // deployment nobody ships. Refused outright in production
      // (`webSearchFakeBackendEnabled`), and `/api/ready` fails if it is even
      // set there, so this cannot leak past the harness.
      WEB_SEARCH_FAKE_BACKEND: "1",
      NEXTAUTH_URL: baseURL,
      NEXTAUTH_SECRET: e2eNextAuthSecret,
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: e2eTurnstileSiteKey,
      NODE_OPTIONS: nodeOptions,
      REQUIRE_CLOUDFLARE_ORIGIN_SECRET: "false",
    },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        ...canonicalRendering,
        ...chromiumLaunchOptions,
      },
    },
    {
      name: "desktop-compact",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1366, height: 768 },
        deviceScaleFactor: 1,
        ...canonicalRendering,
        ...chromiumLaunchOptions,
      },
    },
    {
      name: "mobile-safari",
      use: {
        ...devices["iPhone 13"],
        viewport: { width: 390, height: 844 },
        ...canonicalRendering,
      },
    },
    {
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 5"],
        viewport: { width: 412, height: 915 },
        ...canonicalRendering,
        ...chromiumLaunchOptions,
      },
    },
  ],
});
