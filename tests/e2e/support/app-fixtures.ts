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
  theme: "dark" | "light" | "system";
  timeZone: string;
  timeZoneInitializedAt: string | null;
  timeZoneChangedAt: string | null;
  userSettingsReads: number;
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
  status?: string;
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
    theme: "dark",
    timeZone: "UTC",
    timeZoneInitializedAt: "2026-05-01T00:00:00.000Z",
    timeZoneChangedAt: "2026-05-01T00:00:00.000Z",
    userSettingsReads: 0,
  };

  const conversation = () => ({
    id: "qa-conversation",
    title: state.title,
    // Stands in for the compiled-in default selection, so it tracks
    // DEFAULT_MODEL_ID rather than naming a model in its own right. Moved to
    // gpt-5-6-luna with the app default on 2026-08-01; a spec that needs a
    // specific model still passes `selectedModels` explicitly.
    selectedModels: options.selectedModels || ["gpt-5-6-luna"],
    disabledPanels: [],
    webSearchMode: options.webSearchMode || "off",
    isLocked: state.locked,
    shareEnabled: state.shared,
    shareExpiresAt: state.shared ? "2099-01-01T00:00:00.000Z" : null,
  });

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
      };
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

  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() === "GET") {
      state.conversationListReads += 1;
      await route.fulfill(json(state.deleted ? [] : [conversation()]));
      return;
    }

    state.deleted = false;
    state.locked = false;
    state.shared = false;
    const body = route.request().postDataJSON() as { title?: unknown };
    state.title =
      typeof body.title === "string" && body.title.trim()
        ? body.title
        : "New QA conversation";
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

  await page.route("**/api/conversations/qa-conversation/messages**", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as {
        messages?: QaConversationMessage[];
      };
      for (const message of body?.messages ?? []) {
        if (!message?.id || savedMessages.some((saved) => saved.id === message.id)) {
          continue;
        }
        savedMessages.push(message);
      }
      await route.fulfill(json({}, 201));
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

  return state;
}

export type AttachmentUploadQaState = {
  finalizeCount: number;
  prepareCount: number;
  uploadCount: number;
};

export async function mockAttachmentUpload(page: Page): Promise<AttachmentUploadQaState> {
  const state: AttachmentUploadQaState = {
    finalizeCount: 0,
    prepareCount: 0,
    uploadCount: 0,
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
      const body = route.request().postDataJSON() as { size?: number };
      await route.fulfill(json({ size: body.size || 1 }));
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
