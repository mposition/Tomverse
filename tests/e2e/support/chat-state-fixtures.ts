import type { Page } from "@playwright/test";
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

/** Freezes CSS animations/transitions so golden screenshots are pixel-stable. */
export async function freezeAnimations(page: Page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        scroll-behavior: auto !important;
      }
    `,
  });
}

export async function setAuthenticatedTheme(authState: AuthenticatedQaState, theme: Theme) {
  authState.theme = theme;
}

export async function setGuestTheme(page: Page, theme: Theme) {
  await page.addInitScript((value: Theme) => {
    window.localStorage.setItem("tomverse_theme_preference", value);
  }, theme);
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

export { mockAuthenticatedApi };
export type { AuthenticatedQaState };
