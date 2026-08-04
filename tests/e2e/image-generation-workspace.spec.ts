import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi } from "./support/app-fixtures";
import { mockUserUsage } from "./support/chat-state-fixtures";

// Image generation workspace regression coverage (PR 5 UI + PR 3 API shape).
//
// The opt-in flag is resolved server-side into the chat page's RSC payload,
// and the e2e server runs with the database disabled, so the flag can never
// read true on its own. The __tomverse_e2e_image_generation cookie is the
// fixture-mode override (app/(site)/(application)/chat/page.tsx) -- the same
// pattern as __tomverse_e2e_auth. Tests that never set the cookie prove the
// flag-off posture: no entry point renders at all.

const BASE_URL = "http://127.0.0.1:3100";

// Smallest valid 1x1 PNG; served from a same-origin path so the browser can
// load it without touching the network-blocked outside world.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

type MockGeneration = {
  generationId: string;
  conversationId: string;
  status: "pending" | "processing" | "settling" | "succeeded" | "failed";
  prompt: string;
  preset: string;
  size: string;
  quality: string;
  reservedCredits: number | null;
  refunded: boolean;
  publicErrorCode: string | null;
  createdAt: string;
  completedAt: string | null;
  failedAt: string | null;
  assets: Array<{ role: string; mimeType: string; url: string }>;
  provider?: string;
  modelId?: string;
  groupId?: string;
  targetId?: string;
  attemptNumber?: number;
};

type ImageApiState = {
  generations: MockGeneration[];
  createBodies: Array<Record<string, unknown>>;
  /** What the next created generation resolves to once polled. */
  nextOutcome: "succeeded" | "moderation_failed";
  conversationId: string;
  sequence: number;
};

const succeededAssets = () => [
  {
    role: "original" as const,
    mimeType: "image/png",
    url: `${BASE_URL}/e2e-assets/original.png`,
  },
  {
    role: "thumbnail" as const,
    mimeType: "image/webp",
    url: `${BASE_URL}/e2e-assets/thumbnail.png`,
  },
];

const resolveGeneration = (state: ImageApiState, generation: MockGeneration) => {
  if (generation.status !== "pending" && generation.status !== "processing") {
    return generation;
  }
  if (state.nextOutcome === "moderation_failed") {
    generation.status = "failed";
    generation.publicErrorCode = "IMAGE_MODERATION_BLOCKED";
    generation.refunded = true;
    generation.failedAt = new Date().toISOString();
  } else {
    generation.status = "succeeded";
    generation.completedAt = new Date().toISOString();
    generation.assets = succeededAssets();
  }
  return generation;
};

const installImageGenerationApi = async (page: Page): Promise<ImageApiState> => {
  const state: ImageApiState = {
    generations: [],
    createBodies: [],
    nextOutcome: "succeeded",
    conversationId: "qa-image-conversation",
    sequence: 0,
  };

  await page.route("**/e2e-assets/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG_1X1 })
  );

  await page.route("**/api/images/generations", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.createBodies.push(body);
    state.sequence += 1;
    const generation: MockGeneration = {
      generationId: `qa-generation-${state.sequence}`,
      conversationId: state.conversationId,
      status: "pending",
      prompt: String(body.prompt ?? ""),
      preset: body.quality === "low" ? "draft" : body.quality === "high" ? "final" : "standard",
      size: String(body.size ?? "1024x1024"),
      quality: String(body.quality ?? "low"),
      reservedCredits: 15,
      refunded: false,
      publicErrorCode: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      failedAt: null,
      assets: [],
    };
    const modelIds = Array.isArray(body.modelIds)
      ? (body.modelIds as string[])
      : ["gpt-image-2"];
    const targets = modelIds.map((modelId, index) => {
      const row: MockGeneration =
        index === 0
          ? generation
          : { ...generation, generationId: `${generation.generationId}-${index}` };
      row.modelId = modelId;
      row.provider = "openai";
      row.groupId = `qa-group-${state.sequence}`;
      row.targetId = `qa-target-${state.sequence}-${index}`;
      row.attemptNumber = 1;
      if (index > 0) state.generations.push(row);
      return {
        targetId: row.targetId!,
        modelId,
        provider: "openai",
        generationId: row.generationId,
        status: "pending",
        reservedCredits: 15,
      };
    });
    state.generations.push(generation);
    await route.fulfill(
      json(
        {
          generationId: generation.generationId,
          groupId: `qa-group-${state.sequence}`,
          conversationId: generation.conversationId,
          status: "pending",
          reservedCredits: 15 * targets.length,
          targets,
        },
        202
      )
    );
  });

  // The 5s poll: the first read after creation resolves the row to the
  // configured outcome, exactly like the worker settling between two polls.
  await page.route("**/api/images/generations/*", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop();
    const generation = state.generations.find((row) => row.generationId === id);
    if (!generation) {
      return route.fulfill(
        json({ error: "Image generation not found.", code: "IMAGE_GENERATION_NOT_FOUND" }, 404)
      );
    }
    await route.fulfill(json(resolveGeneration(state, generation)));
  });

  await page.route("**/api/images/targets/*/retry", async (route) => {
    const targetId = new URL(route.request().url()).pathname.split("/").at(-2);
    const failed = state.generations.find((row) => row.targetId === targetId);
    if (!failed) return route.fulfill(json({ error: "not found" }, 404));
    state.sequence += 1;
    const retried: MockGeneration = {
      ...failed,
      generationId: `qa-generation-retry-${state.sequence}`,
      status: "pending",
      publicErrorCode: null,
      refunded: false,
      failedAt: null,
      attemptNumber: (failed.attemptNumber ?? 1) + 1,
    };
    state.generations = state.generations.filter(
      (row) => row.targetId !== targetId
    );
    state.generations.push(retried);
    state.nextOutcome = "succeeded";
    await route.fulfill(
      json(
        {
          generationId: retried.generationId,
          groupId: retried.groupId,
          conversationId: retried.conversationId,
          status: "pending",
          reservedCredits: 15,
          targets: [
            {
              targetId: targetId!,
              modelId: retried.modelId ?? "gpt-image-2",
              provider: "openai",
              generationId: retried.generationId,
              status: "pending",
              reservedCredits: 15,
            },
          ],
        },
        202
      )
    );
  });

  await page.route("**/api/conversations/*/generations", async (route) => {
    await route.fulfill(
      json({ conversationId: state.conversationId, generations: state.generations })
    );
  });

  return state;
};

const enableImageGenerationFlag = async (page: Page) => {
  await page.context().addCookies([
    { name: "__tomverse_e2e_image_generation", value: "1", url: BASE_URL },
  ]);
};

const isMobileShell = () =>
  test.info().project.name.startsWith("mobile");

const openNewImageEntry = async (page: Page) => {
  if (isMobileShell()) {
    await page.getByTestId("mobile-sidebar-open").click();
    await expect(page.getByTestId("mobile-sidebar-drawer")).toBeVisible();
    await page.getByTestId("sidebar-new-image").click();
    await expect(page.getByTestId("mobile-sidebar-drawer")).not.toBeVisible();
  } else {
    await page.getByTestId("sidebar-new-image").click();
  }
};

test("the entry point does not exist while the flag is off", async ({ page }) => {
  await mockAuthenticatedApi(page);
  await page.goto("/chat");
  if (isMobileShell()) {
    await page.getByTestId("mobile-sidebar-open").click();
    await expect(page.getByTestId("mobile-sidebar-drawer")).toBeVisible();
  }
  await expect(page.getByTestId("sidebar-new-image")).toHaveCount(0);
  await expect(page.getByTestId("sidebar-rail-new-image")).toHaveCount(0);
});

test("a Free plan meets the upgrade gate instead of the composer", async ({ page }) => {
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await installImageGenerationApi(page);
  await page.goto("/chat");

  await openNewImageEntry(page);
  const gate = page.getByTestId("image-generation-plan-gate");
  await expect(gate).toBeVisible();
  await expect(gate.getByRole("link")).toHaveAttribute("href", "/pricing");
  await expect(page.getByTestId("image-generation-prompt")).toHaveCount(0);
});

test("a Pro account generates an image end to end", async ({ page }) => {
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  const api = await installImageGenerationApi(page);
  await page.goto("/chat");

  await openNewImageEntry(page);
  await expect(page.getByTestId("image-generation-timeline")).toBeVisible();

  // Draft + square: the submit button carries the 15-credit price.
  await page.getByTestId("image-preset-draft").click();
  await page.getByTestId("image-size-1024x1024").click();
  const submit = page.getByTestId("image-generation-submit");
  await expect(submit).toBeDisabled();

  await page.getByTestId("image-generation-prompt").fill("a single red apple");
  await expect(page.getByTestId("image-token-estimate")).toBeVisible();
  await expect(submit).toBeEnabled();
  await submit.click();

  // The pending card appears immediately; the composer refuses a second
  // request while one is active (IMAGE_USER_CONCURRENT is 1).
  await expect(page.getByTestId("image-generation-progress")).toBeVisible();
  await expect(submit).toBeDisabled();

  expect(api.createBodies).toHaveLength(1);
  expect(api.createBodies[0]).toMatchObject({
    prompt: "a single red apple",
    size: "1024x1024",
    quality: "low",
  });
  expect(String(api.createBodies[0].idempotencyKey)).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  expect(api.createBodies[0]).not.toHaveProperty("conversationId");

  // The next 5s poll resolves it; the result renders the provenance label
  // and the image itself from the (mocked) signed URL.
  const result = page.getByTestId("image-generation-result");
  await expect(result).toBeVisible({ timeout: 15_000 });
  // The provenance label is baked into the accessible name in every locale:
  // "<AI-generated image label>: <prompt>".
  await expect(
    result.getByRole("img", { name: /a single red apple/ })
  ).toBeVisible();
  // The prompt was cleared by the successful request, so the composer is
  // idle-but-empty; typing again is what re-arms it.
  await page.getByTestId("image-generation-prompt").fill("another apple");
  await expect(submit).toBeEnabled();

  // The atomically created conversation was adopted into the sidebar.
  if (!isMobileShell()) {
    await expect(
      page
        .getByTestId("sidebar-conversation-item")
        .filter({ hasText: "a single red apple" })
    ).toBeVisible();
  }
});

test("a moderation failure explains itself and shows the refund", async ({ page }) => {
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  const api = await installImageGenerationApi(page);
  api.nextOutcome = "moderation_failed";
  await page.goto("/chat");

  await openNewImageEntry(page);
  await page.getByTestId("image-generation-prompt").fill("something the provider declines");
  await page.getByTestId("image-generation-submit").click();

  const failed = page.getByTestId("image-generation-failed");
  await expect(failed).toBeVisible({ timeout: 15_000 });
  await expect(failed).toHaveAttribute("data-error-kind", "moderation");
  await expect(failed).toHaveAttribute("data-refunded", "true");
  await page.getByTestId("image-generation-prompt").fill("a friendlier prompt");
  await expect(page.getByTestId("image-generation-submit")).toBeEnabled();
});

test("a reloaded image conversation rebuilds its timeline from the server", async ({ page }) => {
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  const api = await installImageGenerationApi(page);
  api.generations.push({
    generationId: "qa-generation-history",
    conversationId: api.conversationId,
    status: "succeeded",
    prompt: "sunset over mountains",
    preset: "draft",
    size: "1024x1024",
    quality: "low",
    reservedCredits: 15,
    refunded: false,
    publicErrorCode: null,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    failedAt: null,
    assets: succeededAssets(),
  });

  // The sidebar list serves the image conversation the way the real list
  // route does: with its kind, and "[]" semantics hidden behind it.
  await page.unroute("**/api/conversations");
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill(
      json([
        {
          id: api.conversationId,
          title: "sunset over mountains",
          kind: "image",
          projectId: null,
          selectedModels: [],
          disabledPanels: [],
          webSearchMode: "auto",
          isLocked: false,
          shareEnabled: false,
          shareExpiresAt: null,
          messageCount: 0,
        },
      ])
    );
  });

  await page.goto("/chat");
  const row = page
    .getByTestId("sidebar-conversation-item")
    .filter({ hasText: "sunset over mountains" });
  if (isMobileShell()) {
    await page.getByTestId("mobile-sidebar-open").click();
    await expect(page.getByTestId("mobile-sidebar-drawer")).toBeVisible();
  }
  await expect(row).toBeVisible();
  await row.click();

  await expect(page.getByTestId("image-generation-entry")).toBeVisible();
  await expect(page.getByTestId("image-generation-result")).toBeVisible();
  await expect(page.getByText("sunset over mountains").first()).toBeVisible();
});

test("an over-limit prompt disables generation before any request", async ({ page }) => {
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  const api = await installImageGenerationApi(page);
  await page.goto("/chat");

  await openNewImageEntry(page);
  // Far past the 1,000-token cap under the shared estimator.
  await page.getByTestId("image-generation-prompt").fill("apple orchard ".repeat(700));
  await expect(page.getByTestId("image-generation-submit")).toBeDisabled();
  await expect(page.getByTestId("image-token-estimate")).toHaveAttribute(
    "data-over-limit",
    "true"
  );
  expect(api.createBodies).toHaveLength(0);
});

test("the model picker drives the request and the quoted total", async ({ page }) => {
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  const api = await installImageGenerationApi(page);
  await page.goto("/chat");

  await openNewImageEntry(page);
  const picker = page.getByTestId("image-model-picker");
  await expect(picker).toBeVisible();
  // The default model is pre-selected, and the last one cannot be removed:
  // a composer that looks ready must not refuse on submit.
  const defaultModel = page.getByTestId("image-model-gpt-image-2");
  await expect(defaultModel).toHaveAttribute("aria-pressed", "true");
  await defaultModel.click();
  await expect(defaultModel).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("image-generation-prompt").fill("a red apple");
  await page.getByTestId("image-generation-submit").click();

  await expect(page.getByTestId("image-generation-progress").first()).toBeVisible();
  expect(api.createBodies).toHaveLength(1);
  expect(api.createBodies[0].modelIds).toEqual(["gpt-image-2"]);
});

test("a failed model retries in place while the group keeps its shape", async ({ page }) => {
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  const api = await installImageGenerationApi(page);
  api.nextOutcome = "moderation_failed";
  await page.goto("/chat");

  await openNewImageEntry(page);
  await page.getByTestId("image-generation-prompt").fill("something declined");
  await page.getByTestId("image-generation-submit").click();

  const failed = page.getByTestId("image-generation-failed");
  await expect(failed).toBeVisible({ timeout: 15_000 });

  // Retrying replaces that target's attempt in place -- one entry, one card.
  await page.getByTestId("image-generation-retry").click();
  await expect(page.getByTestId("image-generation-result")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("image-generation-entry")).toHaveCount(1);
  await expect(page.getByTestId("image-comparison-card")).toHaveCount(1);
});
