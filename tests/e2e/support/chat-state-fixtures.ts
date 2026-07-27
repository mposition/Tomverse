import { expect, type Page } from "@playwright/test";
import { mockAuthenticatedApi, type AuthenticatedQaState } from "./app-fixtures";

// ---------------------------------------------------------------------------
// UI-P1-03: deterministic chat-state fixtures for visual regression.
//
// None of these fixtures call a real AI provider, spend real credits, or
// touch the database -- they only ever talk to the Playwright-mocked E2E
// server (see playwright.config.ts: E2E_DISABLE_DATABASE=true,
// E2E_AUTH_BYPASS=true) and to an in-page `window.fetch` stub installed by
// `installChatModelStub`. That stub answers POST /api/chat entirely inside
// the browser tab (no network call is made for a stubbed model), so its
// timing is fully test-controlled: no fixed sleeps, no reliance on how fast
// a real provider would stream.
// ---------------------------------------------------------------------------

export const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
export const MOBILE_VIEWPORT = { width: 390, height: 844 };
export const MOBILE_MIN_VIEWPORT = { width: 320, height: 568 };

export type Theme = "light" | "dark";

export type StreamAttempt =
  | { kind: "success"; chunks: string[]; intervalMs?: number; traceId?: string }
  // Fetch never settles -- represents "still connecting, no token yet".
  // Bounded by the test/page lifetime, not an unbounded token generator.
  | { kind: "hold" }
  | {
      kind: "error";
      status: number;
      code?: string;
      message?: string;
      traceId?: string;
      details?: Record<string, unknown>;
    }
  // 200 response whose body stream closes with zero bytes -- the real
  // EMPTY_RESPONSE path (see ChatApp.tsx's `!assistantText.trim()` check).
  | { kind: "empty"; traceId?: string }
  | { kind: "async-job"; jobId?: string; traceId?: string };

export type ChatModelStubSpec = Record<string, StreamAttempt | StreamAttempt[]>;

/**
 * Stubs `window.fetch` for POST /api/chat, keyed by the request's `modelId`.
 * Every other request (auth, usage, conversations, attachments, ...) still
 * goes through the real fetch -> Playwright network layer, so it composes
 * normally with `page.route()` mocks registered via app-fixtures.ts.
 *
 * Each model's spec can be a single attempt (reused for every send/retry) or
 * an array consumed in order -- the last entry repeats once exhausted, which
 * is what lets a "retry succeeds" fixture answer the first send with an
 * error and the retry with a success.
 */
// Extracted to a standalone function so the exact same patch logic can be
// applied two ways: via page.addInitScript (covers this test's *future*
// navigations/reloads) and via page.evaluate (covers the document that's
// already loaded right now). Relying on addInitScript alone silently no-ops
// if installChatModelStub is called after page.goto() -- the real request
// would reach the real E2E server instead of this stub -- so both paths run
// unconditionally rather than leaving call order to the caller to get right.
function patchWindowFetchForChatStub(serializedSpec: string) {
    const modelSpec = JSON.parse(serializedSpec) as Record<string, unknown>;
    const callCounts = new Map<string, number>();
    const originalFetch = window.fetch.bind(window);

    const attemptFor = (modelId: string) => {
      const entry = modelSpec[modelId];
      if (!entry) return null;
      const attempts = Array.isArray(entry) ? entry : [entry];
      const callIndex = callCounts.get(modelId) ?? 0;
      callCounts.set(modelId, callIndex + 1);
      return attempts[Math.min(callIndex, attempts.length - 1)] as {
        kind: string;
        [key: string]: unknown;
      };
    };

    const respond = async (attempt: { kind: string; [key: string]: unknown }): Promise<Response> => {
      const traceId = (attempt.traceId as string) || "qa-trace-id";

      if (attempt.kind === "hold") {
        return new Promise<Response>(() => {});
      }

      if (attempt.kind === "async-job") {
        return new Response(
          JSON.stringify({ deepResearchJobId: attempt.jobId || "qa-deep-research-job", status: "submitted" }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Request-ID": traceId,
              "X-Chat-Response-Mode": "async-job",
            },
          }
        );
      }

      if (attempt.kind === "error") {
        return new Response(
          JSON.stringify({
            error: attempt.message || "QA fixture error",
            code: attempt.code,
            traceId,
            details: attempt.details,
          }),
          {
            status: (attempt.status as number) || 500,
            headers: { "Content-Type": "application/json", "X-Request-ID": traceId },
          }
        );
      }

      if (attempt.kind === "empty") {
        const emptyStream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
        return new Response(emptyStream, {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8", "X-Request-ID": traceId },
        });
      }

      // "success": stream chunks with a small, deterministic gap so React
      // gets a chance to paint between them -- this is what makes a
      // mid-stream (partial text, isSending still true) screenshot possible
      // at all, see ChatApp.tsx's `reader.read()` loop.
      const chunks = (attempt.chunks as string[]) || [""];
      const intervalMs = (attempt.intervalMs as number) ?? 20;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const chunk of chunks) {
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8", "X-Request-ID": traceId },
      });
    };

    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const method = init?.method || (typeof input === "object" && "method" in input ? (input as Request).method : "GET");

      if (method === "POST" && /\/api\/chat($|\?)/.test(url)) {
        let modelId: string | undefined;
        try {
          const rawBody = init?.body;
          const parsed = typeof rawBody === "string" ? JSON.parse(rawBody) : null;
          modelId = parsed?.modelId;
        } catch {
          modelId = undefined;
        }
        const attempt = modelId ? attemptFor(modelId) : null;
        if (attempt) {
          return respond(attempt);
        }
      }

      return originalFetch(input as RequestInfo, init);
    }) as typeof window.fetch;
}

export async function installChatModelStub(page: Page, spec: ChatModelStubSpec) {
  const serialized = JSON.stringify(spec);
  await page.addInitScript(patchWindowFetchForChatStub, serialized);
  // Best-effort: applies immediately if a document is already loaded (e.g.
  // this was called after page.goto()). Ignored if there's no execution
  // context yet -- the addInitScript registration above still covers the
  // upcoming navigation in that case.
  await page.evaluate(patchWindowFetchForChatStub, serialized).catch(() => {});
}

export type DeepResearchStatusResponse =
  | { status: "in_progress" }
  | { status: "completed"; content: string }
  | { status: "failed"; error: string }
  | "hold";

/** Mocks POST /api/chat/deep-research/status, the job-polling endpoint. */
export async function mockDeepResearchStatus(page: Page, response: DeepResearchStatusResponse) {
  await page.route("**/api/chat/deep-research/status", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    if (response === "hold") {
      // Never fulfilled: the client already painted its "requesting..."
      // phase text before this call started, so holding it keeps that
      // state on screen without any wall-clock wait.
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(response),
    });
  });
}

export async function mockGuestUsage(page: Page, used: number, limit: number) {
  await page.route("**/api/user/guest-usage**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ used, limit }),
    })
  );
}

export type UsagePatch = {
  plan?: "Free" | "Pro" | "Max";
  usage?: Partial<{ creditsDay: number; creditsMonth: number }>;
  balances?: Partial<{
    dailyRemainingCredits: number | null;
    planRemainingCredits: number;
    purchasedRemainingCredits: number;
  }>;
  limits?: Partial<{ creditsDay: number; creditsMonth: number; maxModels: number }>;
};

/** Overrides GET /api/user/usage on top of mockAuthenticatedApi's default. */
export async function mockUserUsage(page: Page, patch: UsagePatch = {}) {
  const plan = patch.plan || "Free";
  const body = {
    plan,
    subscription: {
      status: plan === "Free" ? null : "active",
      billingInterval: plan === "Free" ? null : "monthly",
      currentPeriodEnd: "2099-01-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
    },
    usage: {
      creditsDay: 0,
      creditsMonth: 0,
      proModelResponsesMonth: 0,
      tokensDay: 0,
      tokensMonth: 0,
      costDay: 0,
      costMonth: 0,
      ...patch.usage,
    },
    balances: {
      dailyRemainingCredits: 30,
      dailyResetsAt: "2099-01-02T00:00:00.000Z",
      planRemainingCredits: 300,
      planResetsAt: "2099-02-01T00:00:00.000Z",
      purchasedRemainingCredits: 0,
      purchasedFundedCostMicroUsd: 0,
      purchasedEarliestExpiry: null,
      ...patch.balances,
    },
    creditDebt: {
      credits: 0,
      fundedCostMicroUsd: 0,
      riskStatus: "clear",
      riskReason: null,
      riskAt: null,
    },
    recommendation: { primary: "upgrade_pro", secondary: null },
    limits: {
      creditsDay: 30,
      creditsMonth: 300,
      proModelResponsesMonth: 30,
      tokensDay: 0,
      tokensMonth: 0,
      costDay: 0,
      costMonth: 0,
      maxModels: 3,
      allowAttachments: true,
      allowSharing: true,
      allowDownloads: true,
      ...patch.limits,
    },
  };

  await page.unroute("**/api/user/usage**");
  await page.route("**/api/user/usage**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
  );
}

/**
 * Restores the given conversation id as "active" on load, the same
 * sessionStorage key the app itself uses for an F5/crash-recovery restore
 * (see ChatPageClient.tsx's ACTIVE_CHAT_STORAGE_KEY). Combined with
 * mockAuthenticatedApi(page, { selectedModels }), this is how a test lands
 * directly on an existing multi-model conversation instead of a fresh chat.
 */
export async function restoreActiveConversation(page: Page, conversationId = "qa-conversation") {
  await page.addInitScript((id: string) => {
    window.sessionStorage.setItem("tomverse_active_chat_id", id);
  }, conversationId);
}

/**
 * Freezes CSS animations/transitions so golden screenshots and boundingBox()
 * reads are pixel-/geometry-stable for the rest of the test.
 *
 * Deliberately NOT `page.addStyleTag({ content })`: an inline <style> tag is
 * blocked by production CSP's `style-src 'self' 'nonce-...'` (no
 * 'unsafe-inline', and page.addStyleTag has no way to attach the page's
 * per-request nonce). Loading the *same* rules from a same-origin file via
 * `addStyleTag({ url })` instead inserts a <link rel="stylesheet">, which
 * `style-src 'self'` already permits -- zero CSP policy change, and the
 * production directive is left exactly as strict as it already was. The
 * stylesheet itself lives at public/qa/freeze-animations.css: never linked
 * to by the app, inert for every real user.
 */
export async function freezeAnimations(page: Page) {
  await page.addStyleTag({ url: "/qa/freeze-animations.css" });
}

/**
 * Sets the theme preference deterministically, before the page's first
 * script runs, so ThemeController's mount-time
 * `readStoredThemePreference() ?? "system"` read (components/
 * ThemeController.tsx) resolves to the exact requested theme on its very
 * first pass -- not "system" (which, absent an explicit dark
 * prefers-color-scheme emulation, resolves to light in a fresh browser
 * context) followed by a later correction once GET /api/user/settings
 * happens to resolve and ChatPageClient.tsx calls
 * storeAndApplyThemePreference(data.theme). That correction is real product
 * behavior, but racing a screenshot against its arrival time (rather than
 * the deterministic localStorage read this uses instead) is exactly what
 * produced golden "dark" screenshots that were pixel-identical to their
 * "light" counterparts: captured before the correction landed.
 */
export async function setDeterministicTheme(page: Page, theme: Theme) {
  await page.addInitScript((value: Theme) => {
    window.localStorage.setItem("tomverse_theme_preference", value);
  }, theme);
}

/** @deprecated use {@link setDeterministicTheme} -- kept as an alias for existing callers. */
export const setGuestTheme = setDeterministicTheme;

export async function setAuthenticatedTheme(authState: AuthenticatedQaState, theme: Theme) {
  authState.theme = theme;
}

/**
 * Asserts the theme actually rendered matches what the test asked for --
 * the dark/light class, the data-theme attribute, and color-scheme all
 * independently reflect `lib/theme.ts`'s applyThemePreference, so a test
 * can never silently pass (or produce a mislabeled golden) if the
 * requested theme never actually got applied.
 */
export async function expectThemeApplied(page: Page, theme: Theme) {
  await expect(async () => {
    const state = await page.evaluate(() => ({
      hasDarkClass: document.documentElement.classList.contains("dark"),
      dataTheme: document.documentElement.dataset.theme,
      colorScheme: document.documentElement.style.colorScheme,
    }));
    expect(state.hasDarkClass).toBe(theme === "dark");
    expect(state.dataTheme).toBe(theme);
    expect(state.colorScheme).toBe(theme === "dark" ? "dark" : "light");
  }).toPass({ timeout: 10_000 });
}

/**
 * Suppresses one-time, dismissible UI (upsell prompts, tour overlays) that
 * this suite's fixtures don't set out to test but that the real app would
 * otherwise show non-deterministically on top of the state under test --
 * e.g. maybeShowValueUpgradePrompt in ChatPageClient.tsx auto-opens a Pro
 * upsell after the *first* successful comparison on a Free-plan account,
 * which would otherwise paint over every "success" golden. Scoped to this
 * suite's own enterConversation() only (not app-fixtures.ts's
 * mockAuthenticatedApi, which upgrade-discovery.spec.ts also uses and
 * whose tests specifically exercise this same prompt) so nothing here
 * changes behavior for any other spec file.
 */
export async function suppressTransientUi(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("tomverse_value_upgrade_prompt_seen_v1", "1");
    window.localStorage.setItem("tomverse_guest_save_compare_seen_v1", "1");
    window.localStorage.setItem("tomverse_guest_save_review_seen_v1", "1");
  });
}

/**
 * Sends the composer's current text using whichever affordance the shell
 * actually rendered for this viewport (MobileChatShell only submits via the
 * send button; DesktopChatShell also accepts Enter) -- keyed off the real
 * viewport width rather than the Playwright project name, since these
 * visual-regression tests resize one project's page to several viewports
 * rather than relying on per-project mobile/desktop device presets.
 */
export async function submitComposer(page: Page, text: string, viewportWidth: number) {
  const textarea = page.getByTestId("chat-textarea");
  await textarea.fill(text);
  if (viewportWidth < 768) {
    await page.getByTestId("chat-send-button").click();
  } else {
    await textarea.press("Enter");
  }
}

// Testids for dismissible/one-time overlays that suppressTransientUi()
// pre-suppresses via localStorage but that could still legitimately be the
// subject of a given test (e.g. the insufficient-credits modal). Every
// golden capture verifies none of these are present unless the test
// explicitly allows them, so a fixture regression that lets one of these
// slip through can never silently bake itself into a golden image instead
// of failing loudly.
const TRANSIENT_UI_TESTIDS = ["value-upgrade-prompt", "usage-limit-modal"] as const;

export async function expectNoUnexpectedTransientUi(
  page: Page,
  allow: Array<(typeof TRANSIENT_UI_TESTIDS)[number]> = []
) {
  for (const testid of TRANSIENT_UI_TESTIDS) {
    if (allow.includes(testid)) continue;
    await expect(page.getByTestId(testid)).toHaveCount(0);
  }
}

// Measured against this suite's own committed goldens across repeated runs
// on the same Chromium build: real anti-aliasing/sub-pixel font-hinting
// noise between otherwise-identical renders tops out at ~0.001 (0.1%) of
// total pixels. Set just above that floor -- tight enough that a genuinely
// missing state badge, wrong color, or shifted CTA (which moves far more
// than 0.1% of pixels) still fails, loose enough to absorb that noise
// without a manual per-test override. See tests/e2e/README or the UI-P1-03
// completion report for the measurement methodology.
export const GOLDEN_MAX_DIFF_PIXEL_RATIO = 0.0015;

export type StableScreenshotOptions = {
  theme: Theme;
  maxDiffPixelRatio?: number;
  allowTransientUi?: Array<(typeof TRANSIENT_UI_TESTIDS)[number]>;
};

/**
 * Single choke point for every golden capture in this suite: re-verifies
 * the theme actually applied (expectThemeApplied), confirms no
 * unsuppressed transient overlay snuck in (expectNoUnexpectedTransientUi),
 * then captures with animations explicitly disabled (belt-and-suspenders
 * with freezeAnimations -- Playwright's own default for toHaveScreenshot,
 * made explicit here since it's the mechanism this suite actually depends
 * on for CSP-safe animation freezing at capture time) and the shared,
 * measured diff tolerance.
 */
export async function expectStableScreenshot(
  page: Page,
  name: string,
  { theme, maxDiffPixelRatio, allowTransientUi }: StableScreenshotOptions
) {
  await expectThemeApplied(page, theme);
  await expectNoUnexpectedTransientUi(page, allowTransientUi);
  await expect(page).toHaveScreenshot(name, {
    animations: "disabled",
    maxDiffPixelRatio: maxDiffPixelRatio ?? GOLDEN_MAX_DIFF_PIXEL_RATIO,
  });
}

export { mockAuthenticatedApi };
export type { AuthenticatedQaState };
