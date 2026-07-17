import { expect, type Page } from "@playwright/test";

export type QaLanguage = "en" | "ko" | "zh";

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

  await page.addInitScript((lang) => {
    const callbacks = new Map<string, (token: string) => void>();
    window.turnstile = {
      render: (_container, options) => {
        const widgetId = "qa-turnstile-widget";
        const callback = options.callback;
        if (typeof callback === "function") {
          callbacks.set(widgetId, callback as (token: string) => void);
        }
        return widgetId;
      },
      execute: (widgetId) => {
        queueMicrotask(() => {
          callbacks.get(widgetId)?.("qa-turnstile-token");
        });
      },
      reset: () => {},
      remove: (widgetId) => {
        callbacks.delete(widgetId);
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
  userSettingsReads: number;
};

export async function mockAuthenticatedApi(
  page: Page,
  options: { selectedModels?: string[]; showSidebarTour?: boolean } = {}
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
    userSettingsReads: 0,
  };

  const conversation = () => ({
    id: "qa-conversation",
    title: state.title,
    selectedModels: options.selectedModels || ["gpt-5-4-mini"],
    disabledPanels: [],
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
      };
      if (body.theme === "dark" || body.theme === "light" || body.theme === "system") {
        state.theme = body.theme;
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
          },
        })
      );
    }

    state.userSettingsReads += 1;
    return route.fulfill(
      json({ theme: state.theme, language: "ko", defaultModel: "gpt-5-4-mini" })
    );
  });

  await page.route("**/api/user/model-finder", (route) =>
    route.fulfill(
      json({
        variant: "control",
        shouldShow: false,
        settings: {
          preferredTasks: [],
          preferredPriority: null,
          usesFilesFrequently: null,
          defaultModelId: "gpt-5-4-mini",
          modelFinderCompletedAt: null,
          modelFinderDismissedAt: null,
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
    state.title = "New QA conversation";
    await route.fulfill(json(conversation(), 201));
  });

  await page.route("**/api/conversations/qa-conversation/messages**", async (route) => {
    await route.fulfill(json({}, route.request().method() === "POST" ? 201 : 200));
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

    await route.fulfill(json({ ...conversation(), messages: [], nextCursor: null }));
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

export async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));

  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
}
