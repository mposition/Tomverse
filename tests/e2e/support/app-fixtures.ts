import { expect, type Page, type TestInfo } from "@playwright/test";

export type QaLanguage = "en" | "ko" | "zh";

/** How the mocked Cloudflare widget behaves when it is executed. */
export type QaTurnstileScript =
  /** Passes without any interaction -- the user must never see verification UI. */
  | "silent"
  /** Fires before-interactive-callback and then waits for the test to act. */
  | "interactive"
  | "error"
  | "timeout"
  | "expired"
  | "unsupported"
  /** Never calls back at all: the coordinator's own timeout has to end it. */
  | "hang";

export type QaTurnstileSnapshot = {
  script: QaTurnstileScript;
  renders: number;
  executes: number;
  issuedTokens: string[];
  widgets: { id: string; action: string; size: string; interactive: boolean }[];
};

type QaTurnstileControl = {
  script: QaTurnstileScript;
  renders: number;
  executes: number;
  issuedTokens: string[];
  usedTokens: string[];
  snapshot: () => QaTurnstileSnapshot;
  widgetCount: () => number;
  interactiveCount: () => number;
  completeInteractive: () => boolean;
  failInteractive: (
    kind?: "error" | "timeout" | "expired" | "unsupported"
  ) => boolean;
};

declare global {
  interface Window {
    __qaTurnstile?: QaTurnstileControl;
  }
}

/**
 * Picks the widget script for the next document load. Registered after
 * prepareGuestPage's own init script, so it runs once the mock exists.
 */
export async function installTurnstileScript(
  page: Page,
  script: QaTurnstileScript
) {
  await page.addInitScript((value) => {
    if (window.__qaTurnstile) window.__qaTurnstile.script = value;
  }, script);
}

/** Switches the script for the document that is already open. */
export async function setTurnstileScript(page: Page, script: QaTurnstileScript) {
  await page.evaluate((value) => {
    if (window.__qaTurnstile) window.__qaTurnstile.script = value;
  }, script);
}

/** Solves the challenge that is currently on screen. */
export async function completeTurnstileChallenge(page: Page) {
  return page.evaluate(
    () => window.__qaTurnstile?.completeInteractive() ?? false
  );
}

/** Ends the challenge that is currently on screen with a Cloudflare failure. */
export async function failTurnstileChallenge(
  page: Page,
  kind: "error" | "timeout" | "expired" | "unsupported" = "error"
) {
  return page.evaluate(
    (value) => window.__qaTurnstile?.failInteractive(value) ?? false,
    kind
  );
}

export async function readTurnstileState(page: Page) {
  return page.evaluate(() => window.__qaTurnstile?.snapshot() ?? null);
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const json = (body: JsonValue, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const publicBillingPlans = [
  {
    id: "free",
    name: "Free",
    monthlyPriceCents: 0,
    annualPriceCents: 0,
    currency: "USD",
    monthlyMessageLimit: 300,
  },
  {
    id: "pro",
    name: "Pro",
    monthlyPriceCents: 1_500,
    annualPriceCents: 14_400,
    currency: "USD",
    monthlyMessageLimit: 3_000,
  },
  {
    id: "max",
    name: "Max",
    monthlyPriceCents: 2_500,
    annualPriceCents: 24_000,
    currency: "USD",
    monthlyMessageLimit: 10_000,
  },
];

const publicCreditPacks = [
  {
    id: "starter_500",
    name: "Starter Credit Pack",
    credits: 500,
    priceCents: 499,
    currency: "USD",
    validityDays: 365,
    allowedPlans: ["Free"],
  },
  {
    id: "project_1500",
    name: "Project Credit Pack",
    credits: 1_500,
    priceCents: 999,
    currency: "USD",
    validityDays: 365,
    allowedPlans: ["Pro", "Max"],
  },
  {
    id: "power_4000",
    name: "Power Credit Pack",
    credits: 4_000,
    priceCents: 1_999,
    currency: "USD",
    validityDays: 365,
    allowedPlans: ["Pro", "Max"],
  },
];

export async function mockPublicBillingConfig(page: Page) {
  await page.context().route("**/api/billing/config**", (route) =>
    route.fulfill(
      json({
        plans: publicBillingPlans,
        creditPacks: publicCreditPacks,
        featuredPromotion: null,
        promotionPolicy: {
          codesListed: false,
          validation: "server_only",
          annualDiscountStacking: "promotion_specific_default_denied",
        },
      })
    )
  );
}

export async function mockPublicProofMetrics(page: Page) {
  await page.context().route("**/api/public/proof-metrics**", (route) =>
    route.fulfill(
      json({
        periodDays: 30,
        generatedAt: "2099-01-01T00:00:00.000Z",
        comparisons: null,
        fileWorkflows: null,
        minimumPublicCount: 20,
      })
    )
  );
}

export async function prepareGuestPage(page: Page, language: QaLanguage = "ko") {
  await mockPublicBillingConfig(page);
  await mockPublicProofMetrics(page);
  await page.route("**/api/app-settings**", (route) =>
    route.fulfill(json({ guestDefaultModelId: "gemini-2-5-flash" }))
  );
  await page.route("**/api/models/status**", (route) =>
    route.fulfill(json({ generatedAt: "2099-01-01T00:00:00.000Z", models: [] }))
  );
  await page.route("**/api/auth/session**", (route) =>
    route.fulfill(json(null))
  );
  // Guests run the aggregate comparison preflight too -- it is what admits all
  // three panels of a comparison at once instead of letting them race for
  // concurrency slots. Mocked here so guest specs do not depend on it.
  await page.route("**/api/chat/preflight", async (route) => {
    const body = route.request().postDataJSON() as {
      comparisonId?: string;
      modelIds?: string[];
    };
    await route.fulfill(
      json({
        ok: true,
        comparisonId: body.comparisonId || "qa-guest-comparison",
        modelCount: body.modelIds?.length || 0,
        requiredCredits: body.modelIds?.length || 0,
      })
    );
  });

  await page.addInitScript((lang) => {
    // A scriptable stand-in for Cloudflare's widget. The default -- "silent" --
    // is what every pre-existing spec relies on: verification passes without
    // any interaction, so no verification UI is ever supposed to appear. The
    // other scripts drive the exact callbacks Turnstile can fire, so the
    // coordinator's state machine can be tested without the network.
    type Callbacks = Record<string, unknown>;
    const widgets = new Map<
      string,
      {
        id: string;
        action: string;
        size: string;
        callbacks: Callbacks;
        box: HTMLElement;
        interactive: boolean;
      }
    >();
    let widgetSeq = 0;
    let tokenSeq = 0;

    const control = {
      script: "silent" as
        | "silent"
        | "interactive"
        | "error"
        | "timeout"
        | "expired"
        | "unsupported"
        | "hang",
      renders: 0,
      executes: 0,
      issuedTokens: [] as string[],
      usedTokens: [] as string[],
      snapshot: () => ({
        script: control.script,
        renders: control.renders,
        executes: control.executes,
        issuedTokens: [...control.issuedTokens],
        widgets: Array.from(widgets.values()).map((widget) => ({
          id: widget.id,
          action: widget.action,
          size: widget.size,
          interactive: widget.interactive,
        })),
      }),
      /** Every widget currently rendered, however it was placed. */
      widgetCount: () => widgets.size,
      interactiveCount: () =>
        Array.from(widgets.values()).filter((widget) => widget.interactive)
          .length,
      /** The user solves the visible challenge. */
      completeInteractive: () => {
        for (const widget of widgets.values()) {
          if (!widget.interactive) continue;
          const callback = widget.callbacks.callback;
          const after = widget.callbacks["after-interactive-callback"];
          if (typeof after === "function") (after as () => void)();
          if (typeof callback === "function") {
            const token = `qa-turnstile-token-${++tokenSeq}`;
            control.issuedTokens.push(token);
            (callback as (value: string) => void)(token);
          }
          return true;
        }
        return false;
      },
      /** The visible challenge ends badly. */
      failInteractive: (
        kind: "error" | "timeout" | "expired" | "unsupported" = "error"
      ) => {
        for (const widget of widgets.values()) {
          if (!widget.interactive) continue;
          const callback = widget.callbacks[`${kind}-callback`];
          if (typeof callback === "function") (callback as () => void)();
          return true;
        }
        return false;
      },
    };
    window.__qaTurnstile = control;

    /**
     * Stands in for Cloudflare's iframe, including its `interaction-only`
     * behaviour: zero size until an interaction is actually required, then the
     * real widget's documented dimensions so geometry assertions mean
     * something.
     */
    const sizeWidget = (widget: { box: HTMLElement; size: string }) => {
      const box = widget.box;
      if (widget.size === "compact") {
        box.style.width = "150px";
        box.style.height = "140px";
      } else if (widget.size === "flexible") {
        box.style.width = "100%";
        box.style.maxWidth = "100%";
        box.style.height = "65px";
      } else {
        box.style.width = "300px";
        box.style.height = "65px";
      }
      box.style.maxWidth = "100%";
      box.style.background = "#e6edf7";
      box.style.border = "1px solid #b9c8de";
      box.style.borderRadius = "4px";
      box.style.boxSizing = "border-box";
    };

    window.turnstile = {
      render: (container, options) => {
        const widgetId = `qa-turnstile-widget-${++widgetSeq}`;
        const box = document.createElement("div");
        box.setAttribute("data-testid", "qa-turnstile-widget");
        box.setAttribute("data-widget-id", widgetId);
        box.setAttribute("data-action", String(options.action ?? ""));
        box.setAttribute("data-size", String(options.size ?? "normal"));
        box.style.width = "0px";
        box.style.height = "0px";
        box.style.overflow = "hidden";
        container.appendChild(box);
        widgets.set(widgetId, {
          id: widgetId,
          action: String(options.action ?? ""),
          size: String(options.size ?? "normal"),
          callbacks: options as Callbacks,
          box,
          interactive: false,
        });
        control.renders += 1;
        return widgetId;
      },
      execute: (widgetId) => {
        const widget = widgets.get(widgetId);
        if (!widget) return;
        control.executes += 1;
        queueMicrotask(() => {
          if (!widgets.has(widgetId)) return;
          const callbacks = widget.callbacks;
          const call = (name: string) => {
            const handler = callbacks[name];
            if (typeof handler === "function") (handler as () => void)();
          };

          if (control.script === "silent") {
            const callback = callbacks.callback;
            if (typeof callback === "function") {
              const token = `qa-turnstile-token-${++tokenSeq}`;
              control.issuedTokens.push(token);
              (callback as (value: string) => void)(token);
            }
            return;
          }
          if (control.script === "hang") return;
          if (control.script === "interactive") {
            widget.interactive = true;
            widget.box.setAttribute("data-interactive", "true");
            sizeWidget(widget);
            call("before-interactive-callback");
            return;
          }
          call(`${control.script}-callback`);
        });
      },
      reset: (widgetId) => {
        const widget = widgets.get(widgetId);
        if (!widget) return;
        widget.interactive = false;
        widget.box.removeAttribute("data-interactive");
        widget.box.style.width = "0px";
        widget.box.style.height = "0px";
      },
      remove: (widgetId) => {
        const widget = widgets.get(widgetId);
        widget?.box.remove();
        widgets.delete(widgetId);
      },
    };

    if (sessionStorage.getItem("__tomverse_qa_guest_ready") === "true") {
      return;
    }

    localStorage.clear();
    localStorage.setItem("tomverse_language", lang);
    localStorage.setItem("tomverse_onboarding_seen_v1", "1");
    localStorage.setItem("guest_count", "0");
    localStorage.setItem("guest_date", new Date().toDateString());
    sessionStorage.setItem("__tomverse_qa_guest_ready", "true");
  }, language);
}

export async function mockChatStream(page: Page, responseText: string) {
  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      headers: { "X-Request-ID": "qa-trace-id" },
      body: responseText,
    });
  });
}

export type AuthenticatedQaState = {
  conversationListReads: number;
  deleted: boolean;
  locked: boolean;
  shared: boolean;
  title: string;
  /**
   * The conversation's model selection as this mock has actually stored it --
   * seeded from `options.selectedModels` and then updated by every
   * PATCH /api/conversations/:id that carries one, exactly like the real
   * endpoint. Exposed so a spec can assert what the "server" ended up with.
   */
  selectedModels: string[];
  disabledPanels: string[];
  /** The conversation's stored memory mode, updated by PATCH like the rest. */
  memoryMode: "inherit" | "on" | "off";
  /**
   * The conversation's stored Auto state, updated by PATCH like the rest, and
   * whether the "server" offers Auto at all.
   *
   * Two fields because they are two decisions: `offered` is the server's own
   * conjunction of flag, product and cohort (UI contract §1), and
   * `selectionMode` is what this conversation stores. A spec that needs an
   * account which has *left* the cohort sets `offered: false` with
   * `selectionMode: "auto"` -- a state a PATCH in the same session can never
   * produce, and the one the contract's unconditional return to manual exists
   * for.
   */
  selectionMode: "manual" | "auto";
  autoSelectionOffered: boolean;
  assistantProfile: {
    profileId: string;
    name: string;
    icon: string | null;
    revision: number;
    latestRevision: number;
    status: "current" | "superseded";
  } | null;
  theme: "dark" | "light" | "system";
  timeZone: string;
  timeZoneInitializedAt: string | null;
  timeZoneChangedAt: string | null;
  userSettingsReads: number;
  /**
   * `UserSettings.imageHandoffAutoGenerate`. Off by default, which is what a
   * real account starts as: a test that wants the opt-in has to turn it on,
   * so nothing generates on a press by accident.
   */
  imageHandoffAutoGenerate: boolean;
};

/**
 * A message as GET /api/conversations/:id returns it. `modelId` is what each
 * panel filters on (components/chat/ChatApp.tsx): a user turn with no modelId
 * belongs to every panel, an assistant turn only to its own model's panel.
 */
export type QaConversationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  modelId?: string;
  /**
   * "normal" | "incomplete" | "error" | "cancelled", stored and replayed
   * verbatim like the real column -- an answer the provider cut short at its
   * output ceiling has to still read as cut short after a re-fetch.
   */
  status?: string;
  /**
   * The deep-research job this answer is waiting on, as the real endpoint
   * returns it. Paired with `status: "pending"` it is what lets ChatApp
   * re-attach to a job that outlived the page -- so a spec can seed the state
   * a reload lands in, rather than only the state a live send produces.
   */
  pendingJobId?: string | null;
  /**
   * The turn's WebSearchExecution, exactly as the real endpoint returns the
   * `searchMetadata` JSON column. Seeded so a spec can assert the source list
   * a *stored* conversation renders, not only the streamed one.
   */
  searchMetadata?: unknown;
  /**
   * §13.4's disclosure as a *stored* fact. The real endpoint sends this only
   * when the answer was given at least one memory, so a spec seeding it is
   * asking the same question a reload asks: does the count come back, or did
   * it only ever exist in the streaming response header?
   */
  memoryUsedCount?: number;
  /**
   * docs/policy/external-conversation-import-and-memory.md §14.3's half of the same
   * disclosure, also as a *stored* fact. Seeded
   * separately from `memoryUsedCount` because the point of the pair is that
   * an answer can carry either, both or neither.
   */
  knowledgeChunkCount?: number;
  /**
   * The files this answer produced, exactly as the real endpoint returns them
   * (docs/policy/generated-artifacts.md section 5). Seeded so a spec can ask
   * the question a reload asks: does the download card come back, or did it
   * only ever exist in the streaming trailer?
   */
  artifacts?: Array<{
    id: string;
    ordinal: number;
    /**
     * Any supported format, not just the two this fixture was first written
     * with. The format table has fifty-odd entries and the endpoint returns
     * whichever one the answer produced -- narrowing it here would only mean
     * a spec seeding an `html` or a `txt` card cannot say so.
     */
    format: string;
    filename: string;
    mediaType: string;
    byteSize: number;
    status: "ready" | "failed" | "blocked";
    failureCode?: string;
    modelId?: string;
  }>;
  /**
   * The files the *user* attached to this turn, exactly as the real endpoint
   * returns them (docs/policy/user-attachment-persistence.md section 4).
   * Public fields only -- there is no `objectKey` here because there is none
   * in the response either.
   */
  attachments?: Array<{
    id: string;
    attachmentId?: string;
    ordinal: number;
    name: string;
    mediaType: string;
    size: number;
    kind: "file" | "text";
    /**
     * docs/policy/user-attachment-persistence.md §11's availability verdict,
     * as a *stored* fact.
     *
     * Seeded rather than only produced by a failing send, because the point of
     * the column is that the state survives a reload: a card that only knew it
     * was broken during the failing turn would look ordinary again the next
     * time the conversation was opened.
     */
    unavailableAt?: string;
    unavailableReason?: string;
  }>;
};

export async function mockAuthenticatedApi(
  page: Page,
  options: {
    /**
     * The seeded conversation's model selection. Note this only takes effect
     * once that conversation is actually opened (see openRecentConversation) --
     * /chat's welcome screen starts from DEFAULT_MODEL_ID instead.
     */
    selectedModels?: string[];
    showSidebarTour?: boolean;
    /**
     * Seeds the conversation with history. Panels report themselves empty
     * without it, and an empty conversation is exactly the state the mobile
     * shell hides its model tabs in -- so any test that needs the multi-model
     * tab strip has to seed this as well as `selectedModels`.
     */
    messages?: QaConversationMessage[];
    /**
     * Seeds the conversation's saved web-search mode, the same field
     * ChatPageClient restores from. "always" with a mix of search-capable and
     * search-incapable models is what puts the composer's tool-status chip
     * into its partial-support state.
     */
    webSearchMode?: "off" | "auto" | "always";
    /** The conversation's stored memory mode (§8.1 invariant 1). */
    memoryMode?: "inherit" | "on" | "off";
    /**
     * Auto model selection (UI contract auto-model-selection.md §1). Absent
     * leaves Auto unoffered and the conversation manual, which is what every
     * spec written before the wiring expects -- and what every real account
     * gets today.
     */
    selectionMode?: "manual" | "auto";
    autoSelectionOffered?: boolean;
    /**
     * §14. The account's published profiles, served at
     * `/api/assistant-profiles`. Absent leaves that route unmocked, which is
     * what every spec written before Release C expects: the request fails,
     * the picker is not rendered, and nothing else changes.
     */
    assistantProfiles?: Array<{
      id: string;
      name: string;
      icon?: string | null;
      description?: string | null;
      published?: boolean;
      currentRevision?: number | null;
    }>;
    /**
     * The conversation's binding as the server reports it. Seeded rather than
     * derived so a spec can start from a conversation the owner has already
     * published past -- the `superseded` state, which a PATCH in the same
     * session can never produce.
     */
    assistantProfile?: {
      profileId: string;
      name: string;
      icon: string | null;
      revision: number;
      latestRevision: number;
      status: "current" | "superseded";
    } | null;
    /** What `inherit` resolves to, served by /api/memories/settings. */
    accountMemoryDefault?: "on" | "off";
    /**
     * UX-024. Additional conversations in the sidebar, each with its own
     * transcript and its own detail/messages routes. Opt-in and additive: with
     * this absent the mock registers exactly the routes it always has and
     * behaves identically, so the 50 specs that do not ask for a second
     * conversation are untouched.
     *
     * A second conversation is what makes switching *between* conversations
     * reproducible at all. Without one, `handleSelectConversation` has no
     * other id to be called with, so nothing it does — or fails to do — can be
     * measured.
     */
    extraConversations?: Array<{
      id: string;
      title?: string;
      selectedModels?: string[];
      messages?: QaConversationMessage[];
    }>;
  } = {}
): Promise<AuthenticatedQaState> {
  await page.addInitScript((showSidebarTour) => {
    if (showSidebarTour) {
      localStorage.removeItem("tomverse_sidebar_tour_v1");
      return;
    }
    localStorage.setItem("tomverse_sidebar_tour_v1", "completed");
  }, options.showSidebarTour === true);

  await page.context().addCookies([
    {
      name: "__tomverse_e2e_auth",
      value: "1",
      url: "http://127.0.0.1:3100",
    },
  ]);

  const state: AuthenticatedQaState = {
    conversationListReads: 0,
    deleted: false,
    locked: false,
    shared: false,
    title: "QA conversation",
    // Stands in for the compiled-in default selection, so it tracks
    // DEFAULT_MODEL_ID rather than naming a model in its own right. Moved to
    // gpt-5-6-luna with the app default on 2026-08-01; a spec that needs a
    // specific model still passes `selectedModels` explicitly.
    selectedModels: options.selectedModels || ["gpt-5-6-luna"],
    disabledPanels: [],
    memoryMode: options.memoryMode || "inherit",
    selectionMode: options.selectionMode || "manual",
    autoSelectionOffered: options.autoSelectionOffered ?? false,
    assistantProfile: options.assistantProfile ?? null,
    theme: "dark",
    timeZone: "UTC",
    timeZoneInitializedAt: "2026-05-01T00:00:00.000Z",
    timeZoneChangedAt: "2026-05-01T00:00:00.000Z",
    userSettingsReads: 0,
    imageHandoffAutoGenerate: false,
  };

  const conversation = () => ({
    id: "qa-conversation",
    title: state.title,
    selectedModels: [...state.selectedModels],
    disabledPanels: [...state.disabledPanels],
    webSearchMode: options.webSearchMode || "off",
    // §8.1 invariant 1. Stored, not resolved: the fixture has to be able to
    // show the difference between "follows the account" and an override.
    memoryMode: state.memoryMode,
    // The stored mode, and one boolean for availability. The real response
    // carries no reason at all -- which bucket, what share, which gate stay on
    // the server -- so neither does this.
    selectionMode: state.selectionMode,
    autoSelection: { offered: state.autoSelectionOffered },
    // §14. Server-computed, including whether the profile has published past
    // this conversation -- the screen never works the revision out itself.
    assistantProfile: state.assistantProfile,
    isLocked: state.locked,
    shareEnabled: state.shared,
    shareExpiresAt: state.shared ? "2099-01-01T00:00:00.000Z" : null,
  });

  if (options.assistantProfiles) {
    await page.route("**/api/assistant-profiles", (route) =>
      route.request().method() === "GET"
        ? route.fulfill(
            json({
              profiles: options.assistantProfiles!.map((profile) => ({
                id: profile.id,
                name: profile.name,
                icon: profile.icon ?? null,
                description: profile.description ?? null,
                published: profile.published !== false,
                currentRevision: profile.currentRevision ?? 1,
                versionCount: profile.currentRevision ?? 1,
                knowledgeFileCount: 0,
              })),
            })
          )
        : route.fallback()
    );
  }

  // What `inherit` resolves to. The chat page reads this once to describe the
  // inherit option; without it the description would silently claim "in use".
  await page.route("**/api/memories/settings", (route) =>
    route.fulfill(
      json({
        masterEnabled: true,
        styleEnabled: true,
        defaultConversationMode: options.accountMemoryDefault || "on",
      })
    )
  );

  await page.unroute("**/api/auth/session**");
  await page.route("**/api/auth/session**", (route) =>
    route.fulfill(
      json({
        user: {
          id: "qa-user",
          name: "QA User",
          email: "qa@tomverse.app",
          image: null,
        },
        expires: "2099-01-01T00:00:00.000Z",
      })
    )
  );

  await page.route("**/api/user/settings", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as {
        theme?: unknown;
        language?: unknown;
        defaultModel?: unknown;
        timeZone?: unknown;
        timeZoneSource?: unknown;
        imageHandoffAutoGenerate?: unknown;
      };
      if (typeof body.imageHandoffAutoGenerate === "boolean") {
        state.imageHandoffAutoGenerate = body.imageHandoffAutoGenerate;
      }
      if (body.theme === "dark" || body.theme === "light" || body.theme === "system") {
        state.theme = body.theme;
      }
      if (typeof body.timeZone === "string") {
        state.timeZone = body.timeZone;
        state.timeZoneInitializedAt ||= "2026-05-01T00:00:00.000Z";
        if (body.timeZoneSource !== "browser") {
          state.timeZoneChangedAt ||= "2026-05-01T00:00:00.000Z";
        }
      }
      return route.fulfill(
        json({
          success: true,
          settings: {
            theme: state.theme,
            language: typeof body.language === "string" ? body.language : "ko",
            defaultModel:
              typeof body.defaultModel === "string"
                ? body.defaultModel
                : "gpt-5-4-mini",
            timeZone: state.timeZone,
            timeZoneInitializedAt: state.timeZoneInitializedAt,
            timeZoneChangedAt: state.timeZoneChangedAt,
            timeZoneChangeAllowedAt: "2026-05-31T00:00:00.000Z",
            imageHandoffAutoGenerate: state.imageHandoffAutoGenerate,
          },
        })
      );
    }

    state.userSettingsReads += 1;
    return route.fulfill(
      json({
        theme: state.theme,
        language: "ko",
        // Tracks DEFAULT_MODEL_ID, not a model chosen for its own sake: this
        // is "the account default a seeded QA user still has". Moved to
        // gpt-5-6-luna on 2026-08-01.
        defaultModel: "gpt-5-6-luna",
        timeZone: state.timeZone,
        timeZoneInitializedAt: state.timeZoneInitializedAt,
        timeZoneChangedAt: state.timeZoneChangedAt,
        timeZoneChangeAllowedAt: "2026-05-31T00:00:00.000Z",
        imageHandoffAutoGenerate: state.imageHandoffAutoGenerate,
      })
    );
  });

  await page.route("**/api/user/model-finder", (route) =>
    route.fulfill(
      json({
        settings: {
          preferredTasks: [],
          preferredPriority: null,
          defaultModelId: "gpt-5-6-luna",
          modelFinderCompletedAt: null,
        },
      })
    )
  );

  await page.route("**/api/models/status", (route) =>
    route.fulfill(json({ models: [] }))
  );

  await page.route("**/api/chat/preflight", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as {
      comparisonId?: string;
      modelIds?: string[];
    };
    await route.fulfill(
      json({
        ok: true,
        comparisonId: body.comparisonId || "qa-comparison",
        modelCount: body.modelIds?.length || 0,
        requiredCredits: body.modelIds?.length || 0,
      })
    );
  });

  await page.route("**/api/user/usage**", (route) =>
    route.fulfill(
      json({
        plan: "Free",
        subscription: {
          status: null,
          billingInterval: null,
          currentPeriodEnd: null,
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
        },
        balances: {
          dailyRemainingCredits: 30,
          dailyResetsAt: "2099-01-02T00:00:00.000Z",
          planRemainingCredits: 300,
          planResetsAt: "2099-02-01T00:00:00.000Z",
          purchasedRemainingCredits: 0,
          purchasedFundedCostMicroUsd: 0,
          purchasedEarliestExpiry: null,
        },
        entitlement: {
          dailyCreditLimit: 30,
          dailyCreditsUsed: 0,
          dailyCreditsRemaining: 30,
          hasDailyCreditLimit: true,
          dailyResetsAt: "2099-01-02T00:00:00.000Z",
          timeZone: "Australia/Brisbane",
          planCreditsRemaining: 300,
          planResetsAt: "2099-02-01T00:00:00.000Z",
          purchasedCreditsRemaining: 0,
          creditsAvailableNow: 300,
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
        },
      })
    )
  );

  await page.route("**/api/projects**", (route) =>
    route.fulfill(json({ projects: [] }))
  );

  await page.route("**/api/billing/refund-request**", (route) =>
    route.fulfill(json({ pendingRequest: null }))
  );

  // UX-024. Each extra conversation keeps its own transcript, exactly like the
  // primary one below, so a switch between them is a switch between two real
  // histories rather than between two views of the same array.
  const extras = (options.extraConversations || []).map((extra) => ({
    id: extra.id,
    title: extra.title || extra.id,
    selectedModels: extra.selectedModels ||
      options.selectedModels || ["gpt-5-6-luna"],
    savedMessages: [...(extra.messages || [])],
  }));
  const extraBody = (extra: (typeof extras)[number]) => ({
    id: extra.id,
    title: extra.title,
    selectedModels: [...extra.selectedModels],
    disabledPanels: [],
    webSearchMode: options.webSearchMode || "off",
    isLocked: false,
    shareEnabled: false,
    shareExpiresAt: null,
  });

  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() === "GET") {
      state.conversationListReads += 1;
      // `state.deleted` is about the primary conversation only, so deleting it
      // must not take the extras with it.
      await route.fulfill(
        json(
          state.deleted
            ? extras.map(extraBody)
            : [conversation(), ...extras.map(extraBody)]
        )
      );
      return;
    }

    state.deleted = false;
    state.locked = false;
    state.shared = false;
    const body = route.request().postDataJSON() as {
      title?: unknown;
      selectedModels?: unknown;
      disabledPanels?: unknown;
      assistantProfileId?: unknown;
    };
    state.title =
      typeof body.title === "string" && body.title.trim()
        ? body.title
        : "New QA conversation";
    // The create takes the caller's selection, as the real endpoint does. The
    // client reads its model list back out of this response rather than
    // keeping what it sent -- it has to, because a create carrying a profile
    // comes back with the profile's models instead (policy section 14.0) --
    // so a mock that answered with a canned default silently replaced every
    // selection a spec had made in the picker, turning a two-model comparison
    // into a one-model send that never reaches /api/chat/preflight.
    //
    // A spec exercising the profile case overrides this route and answers with
    // the profile's models, which is the one time the two legitimately differ.
    if (
      !body.assistantProfileId &&
      Array.isArray(body.selectedModels) &&
      body.selectedModels.length > 0
    ) {
      state.selectedModels = Array.from(
        new Set(body.selectedModels.filter((id): id is string => typeof id === "string"))
      );
    }
    if (Array.isArray(body.disabledPanels)) {
      state.disabledPanels = body.disabledPanels.filter(
        (id): id is string => typeof id === "string"
      );
    }
    await route.fulfill(json(conversation(), 201));
  });

  // The transcript this conversation reports, which grows as the app saves to
  // it -- exactly like the real endpoint pair.
  //
  // It used to be a static echo of `options.messages`: POST /messages returned
  // `{}` and threw the body away, and GET /:id always replayed the seed. The
  // app pre-saves the user turn before streaming and re-reads the conversation
  // afterwards, so whenever that read landed after the optimistic append it
  // replaced a real transcript with the empty seed and the shell fell back to
  // its welcome screen -- a send that had already created the conversation,
  // saved the message, streamed /api/chat and generated a title showed nothing
  // at all. That was the ~30% flake in the mobile keyboard suite, and it was
  // the mock disagreeing with itself rather than anything the product does.
  const savedMessages: QaConversationMessage[] = [...(options.messages || [])];

  // What the upload step recorded about each file, read back when the save
  // binds it. In the real system this lives on the upload row and the client is
  // never believed about it; here the two mocks share one page-scoped registry
  // for the same reason -- the name on a restored card must come from the save,
  // not from whatever the composer happened to be holding.
  const uploadRegistry = finalizedUploadRegistry(page);

  await page.route("**/api/conversations/qa-conversation/messages**", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as {
        messages?: Array<QaConversationMessage & { attachmentUploadIds?: string[] }>;
      };
      /*
        Binding, the way the real endpoint does it: the opaque upload ids
        become durable attachment rows in the same step that saves the message,
        and the response reports them back so the composer can swap its ids.

        Modelled here rather than stubbed, because the property the specs are
        about -- the card survives a reload -- is exactly the property a stub
        that discarded the ids would hide.
      */
      const bound: Array<
        { messageId: string } & NonNullable<QaConversationMessage["attachments"]>[number]
      > = [];
      for (const message of body?.messages ?? []) {
        if (!message?.id) continue;
        const attachments = (message.attachmentUploadIds ?? []).map(
          (uploadId, ordinal) => ({
            id: `ma-${message.id}-${ordinal}`,
            // The same field the real conversation read repeats, under the
            // name the next request uses.
            attachmentId: `ma-${message.id}-${ordinal}`,
            ordinal,
            name: uploadRegistry.get(uploadId)?.name || `file-${ordinal}`,
            mediaType:
              uploadRegistry.get(uploadId)?.mediaType ||
              "application/octet-stream",
            size: 1,
            kind: "file" as const,
          })
        );
        bound.push(
          ...attachments.map((attachment) => ({ messageId: message.id, ...attachment }))
        );
        if (savedMessages.some((saved) => saved.id === message.id)) continue;
        savedMessages.push({
          ...message,
          ...(attachments.length ? { attachments } : {}),
        });
      }
      await route.fulfill(
        json({ success: true, created: bound.length, attachments: bound }, 201)
      );
      return;
    }
    await route.fulfill(json({}));
  });

  await page.route("**/api/conversations/qa-conversation/verify", async (route) => {
    await route.fulfill(json({ success: true }));
  });

  await page.route("**/api/conversations/qa-conversation/share", async (route) => {
    if (route.request().method() === "POST") {
      state.shared = true;
      await route.fulfill(
        json({
          url: "https://tomverse.app/share/qa-share-token-1234567890",
          expiresAt: "2099-01-01T00:00:00.000Z",
        })
      );
      return;
    }

    if (route.request().method() === "DELETE") {
      state.shared = false;
      await route.fulfill({ status: 204, body: "" });
      return;
    }

    await route.fulfill(json({ ...conversation(), url: null }));
  });

  await page.route(/.*\/api\/conversations\/qa-conversation(\?.*)?$/, async (route) => {
    const method = route.request().method();

    if (method === "PATCH") {
      const body = route.request().postDataJSON() as {
        password?: string | null;
        title?: string;
        unlock?: boolean;
        selectedModels?: string[];
        disabledPanels?: string[];
        memoryMode?: "inherit" | "on" | "off";
        selectionMode?: "manual" | "auto";
        assistantProfileId?: string | null;
      };

      if (typeof body.password === "string") {
        state.locked = true;
      }
      if (body.unlock === true) {
        state.locked = false;
      }
      if (typeof body.title === "string") {
        state.title = body.title;
      }
      // The model selection has to be *stored*, not echoed from the seed.
      // ChatPageClient's send barrier (ensureModelSettingsReady) resolves only
      // once the server has confirmed the exact selection the send is being
      // made with, and it reads that confirmation out of this response. A mock
      // that accepted the PATCH and then replied with the seeded selection
      // told the app its change had never been saved: the send was abandoned,
      // the screen was recovered to the seed and "모델 선택을 서버에 저장하지
      // 못했습니다" was shown -- with the product behaving exactly as designed.
      // Deep Research is where that showed up first, because it is the one
      // flow that *changes* the selection and immediately sends against it.
      // app/api/conversations/[conversationId]/route.ts persists both fields
      // and returns the stored values; so does this.
      if (typeof body.memoryMode === "string") {
        state.memoryMode = body.memoryMode;
      }
      // The same rule the real endpoint applies (`mayStoreSelectionMode`):
      // `manual` is accepted unconditionally, including for an account that
      // has left the cohort -- that is how a conversation leaves a mode the
      // account can no longer act on -- and `auto` only when the server would
      // actually route it. A mock that stored `auto` anyway would let a spec
      // pass on the exact state the contract forbids: a conversation marked
      // Auto that every turn answers manually.
      if (body.selectionMode === "manual") {
        state.selectionMode = "manual";
      } else if (body.selectionMode === "auto") {
        if (!state.autoSelectionOffered) {
          return route.fulfill(
            json(
              {
                error: "Automatic model selection is not available for this account.",
                code: "AUTO_SELECTION_UNAVAILABLE",
              },
              403
            )
          );
        }
        state.selectionMode = "auto";
      }
      // §14. The request names a profile; the *fixture* decides which
      // revision that was, exactly as the server does -- a mock that echoed a
      // revision back from the request would let a spec pass while the client
      // was naming versions it must not name.
      if (body.assistantProfileId !== undefined) {
        const chosen = (options.assistantProfiles || []).find(
          (profile) => profile.id === body.assistantProfileId
        );
        state.assistantProfile = chosen
          ? {
              profileId: chosen.id,
              name: chosen.name,
              icon: chosen.icon ?? null,
              revision: chosen.currentRevision ?? 1,
              latestRevision: chosen.currentRevision ?? 1,
              status: "current",
            }
          : null;
      }
      if (Array.isArray(body.selectedModels)) {
        state.selectedModels = Array.from(new Set(body.selectedModels));
      }
      if (Array.isArray(body.disabledPanels)) {
        state.disabledPanels = Array.from(
          new Set(
            body.disabledPanels.filter((modelId) =>
              state.selectedModels.includes(modelId)
            )
          )
        );
      }

      await route.fulfill(json(conversation()));
      return;
    }

    if (method === "DELETE") {
      state.deleted = true;
      await route.fulfill({ status: 204, body: "" });
      return;
    }

    await route.fulfill(
      json({
        ...conversation(),
        messages: savedMessages as unknown as JsonValue,
        nextCursor: null,
      })
    );
  });

  // UX-024. One pair of routes per extra conversation, each id-scoped so it
  // cannot shadow the primary conversation's routes above.
  for (const extra of extras) {
    await page.route(
      `**/api/conversations/${extra.id}/messages**`,
      async (route) => {
        if (route.request().method() === "POST") {
          const body = route.request().postDataJSON() as {
            messages?: QaConversationMessage[];
          };
          for (const message of body?.messages ?? []) {
            if (
              !message?.id ||
              extra.savedMessages.some((saved) => saved.id === message.id)
            ) {
              continue;
            }
            extra.savedMessages.push(message);
          }
          await route.fulfill(json({}, 201));
          return;
        }
        await route.fulfill(json({}));
      }
    );

    await page.route(
      new RegExp(`.*/api/conversations/${extra.id}(\\?.*)?$`),
      async (route) => {
        const method = route.request().method();
        if (method === "PATCH") {
          const body = route.request().postDataJSON() as {
            title?: string;
            selectedModels?: string[];
          };
          if (typeof body.title === "string") extra.title = body.title;
          if (Array.isArray(body.selectedModels)) {
            extra.selectedModels = Array.from(new Set(body.selectedModels));
          }
          await route.fulfill(json(extraBody(extra)));
          return;
        }
        if (method === "DELETE") {
          await route.fulfill({ status: 204, body: "" });
          return;
        }
        await route.fulfill(
          json({
            ...extraBody(extra),
            messages: extra.savedMessages as unknown as JsonValue,
            nextCursor: null,
          })
        );
      }
    );
  }

  return state;
}

export type AttachmentUploadQaState = {
  finalizeCount: number;
  prepareCount: number;
  uploadCount: number;
  /**
   * What finalize answers. Left null it succeeds, which is what every test
   * that is not about a refusal wants.
   *
   * Set to a code, the route answers the way the real one does -- a status
   * and a `code` -- so a test can assert that the composer says what actually
   * went wrong instead of "try again".
   */
  finalizeFailure: { status: number; code: string } | null;
  deleteCount: number;
  /** The opaque ids finalisation issued, in order. Never storage keys. */
  uploadIds: string[];
  /** What the composer asked to discard, so a spec can assert it named an id. */
  deletedUploadIds: Array<string | null>;
  /** The archive summary a successful finalize reports, if any. */
  archive: { totalEntries: number; includedFiles: number; excludedFiles: number } | null;
};

/**
 * What each finalised upload was, per page.
 *
 * `mockAttachmentUpload` writes it and `mockAuthenticatedApi`'s message save
 * reads it, so the two mocks agree the way the two real endpoints do -- the
 * upload row is what the binding step reads, not the request body. A WeakMap
 * on the page so one test's uploads cannot name another test's files.
 */
const FINALIZED_UPLOADS = new WeakMap<
  Page,
  Map<string, { name: string; mediaType: string }>
>();

const finalizedUploadRegistry = (page: Page) => {
  const existing = FINALIZED_UPLOADS.get(page);
  if (existing) return existing;
  const created = new Map<string, { name: string; mediaType: string }>();
  FINALIZED_UPLOADS.set(page, created);
  return created;
};

/** The media types the server reads as text rather than as bytes. */
const TEXT_UPLOAD_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

export async function mockAttachmentUpload(page: Page): Promise<AttachmentUploadQaState> {
  const state: AttachmentUploadQaState = {
    finalizeCount: 0,
    prepareCount: 0,
    uploadCount: 0,
    finalizeFailure: null,
    archive: null,
    deleteCount: 0,
    uploadIds: [],
    deletedUploadIds: [],
  };

  await page.route("**/api/chat", async (route) => {
    const method = route.request().method();

    if (method === "PUT") {
      state.prepareCount += 1;
      await route.fulfill(
        json({
          key: `attachments/qa-file-${state.prepareCount}`,
          uploadUrl: "http://127.0.0.1:3100/__qa_upload__",
          uploadHeaders: { "Content-Type": "application/octet-stream" },
        })
      );
      return;
    }

    if (method === "PATCH") {
      state.finalizeCount += 1;
      if (state.finalizeFailure) {
        await route.fulfill({
          status: state.finalizeFailure.status,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Uploaded attachment failed validation.",
            code: state.finalizeFailure.code,
          }),
        });
        return;
      }
      // The real contract: finalisation hands back an opaque id and never the
      // storage key (docs/policy/user-attachment-persistence.md section 4). A
      // mock that still returned `key` would let a regression that
      // reintroduced key-passing keep passing its own tests.
      const body = route.request().postDataJSON() as {
        size?: number;
        name?: string;
        mediaType?: string;
      };
      const uploadId = `upl-qa-${state.finalizeCount}`;
      state.uploadIds.push(uploadId);
      finalizedUploadRegistry(page).set(uploadId, {
        name: body.name || "file",
        mediaType: body.mediaType || "application/octet-stream",
      });
      await route.fulfill(
        json({
          uploadId,
          name: body.name || "file",
          mediaType: body.mediaType || "application/octet-stream",
          size: body.size || 1,
          kind: TEXT_UPLOAD_TYPES.has(body.mediaType || "") ? "text" : "file",
          ...(state.archive ? { archive: state.archive } : {}),
        })
      );
      return;
    }

    if (method === "DELETE") {
      state.deleteCount += 1;
      const body = route.request().postDataJSON() as { uploadId?: string };
      state.deletedUploadIds.push(body?.uploadId ?? null);
      await route.fulfill({ status: 204, body: "" });
      return;
    }

    await route.fallback();
  });

  await page.route("**/__qa_upload__", (route) => {
    state.uploadCount += 1;
    return route.fulfill({ status: 200, body: "" });
  });

  return state;
}

export function createQaPngBuffer() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
}

/**
 * The smallest thing the composer will accept as an .xlsx.
 *
 * A real zip local-file header, because the composer checks the signature
 * before it uploads. Written from bytes rather than as a string literal so no
 * control character reaches this file -- the source-control-character check
 * fails the build on one, and a zip signature is two of them.
 */
export function createQaXlsxBuffer() {
  return Buffer.from([
    0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
}

export function createQaPdfBuffer() {
  const stream = "BT /F1 12 Tf 20 100 Td (QA PDF) Tj ET";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(
      stream,
      "ascii"
    )} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];

  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += object;
  }

  const xref = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${
    objects.length + 1
  } /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return Buffer.from(pdf, "ascii");
}

// Chat message submission is shell-dependent: PC shells send on plain
// Enter, but mobile shells only send via the on-screen send button (or an
// external-keyboard Ctrl/Cmd+Enter). Tests that merely need a message sent
// -- not ones specifically covering keyboard policy -- should use this
// helper so they behave correctly under every Playwright project.
export async function sendChatMessage(
  page: Page,
  testInfo: TestInfo,
  text: string,
  textareaTestId = "chat-textarea"
) {
  const textarea = page.getByTestId(textareaTestId);
  await textarea.fill(text);
  if (testInfo.project.name.startsWith("mobile")) {
    await page.getByTestId("chat-send-button").click();
  } else {
    await textarea.press("Enter");
  }
}

/** The model-selector trigger, second of the two chat-input popover buttons. */
export function modelMenuTrigger(page: Page) {
  return page.locator('button[aria-controls="chat-input-popover"]').nth(1);
}

/**
 * STG-F008: opening the picker lands on the recommended screen, so the 30+
 * model catalogue and its filters only exist after stepping into "All models".
 * Specs that assert on `model-option` rows go through here.
 */
export async function openModelCatalogue(page: Page) {
  const dialog = page.locator("#chat-input-popover");
  if (!(await dialog.isVisible())) {
    await modelMenuTrigger(page).click();
    await expect(dialog).toBeVisible();
  }
  await dialog.getByTestId("model-picker-open-all").click();
  await expect(dialog.getByTestId("model-picker-scroll-region")).toBeVisible();
  await expect.poll(() => dialog.getByTestId("model-option").count()).toBeGreaterThan(0);
  return dialog;
}

/** Opens the picker and steps straight into the full catalogue. */
export async function openModelPickerCatalogue(page: Page) {
  await modelMenuTrigger(page).click();
  await expect(page.locator("#chat-input-popover")).toBeVisible();
  return openModelCatalogue(page);
}

/**
 * Opens a seeded conversation from the new-chat screen, whichever shell is
 * rendering.
 *
 * The desktop welcome screen still lists recent conversations as title cards.
 * The mobile welcome screen deliberately does not -- printing chat titles on
 * the first screen of a phone leaks them to anyone holding it -- so there the
 * path is the compact "View N recent chats" row, which opens the same drawer
 * the hamburger does. Specs go through here instead of clicking
 * `recent-conversation-card` directly so they stay shell-agnostic.
 */
export async function openRecentConversation(
  page: Page,
  options: { title?: string } = {}
) {
  const disclosure = page.getByTestId("recent-conversations-disclosure");
  const cards = page.getByTestId("recent-conversation-card");
  // Which affordance exists depends on the shell, so wait for whichever one
  // this viewport renders before branching -- a bare count() would race the
  // welcome screen's first paint.
  await expect(disclosure.or(cards.first())).toBeVisible();

  if (await disclosure.count()) {
    await disclosure.click();
    const drawer = page.getByRole("dialog");
    const items = drawer.getByTestId("sidebar-conversation-item");
    const item = options.title
      ? items.filter({ hasText: options.title })
      : items.first();
    await item.click();
    return;
  }

  const card = options.title
    ? cards.filter({ hasText: options.title })
    : cards.first();
  await card.click();
}

export async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));

  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
}
