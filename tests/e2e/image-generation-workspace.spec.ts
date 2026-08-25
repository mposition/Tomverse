import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi } from "./support/app-fixtures";
import { mockUserUsage } from "./support/chat-state-fixtures";
import { listImageModels } from "../../lib/imageModelRegistry";
import { imageDownloadFilename } from "../../lib/imageAssetDownload";
import { IMAGE_ASSET_URL_TTL_MINUTES } from "../../lib/imageAssetPayload";

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
  assets: Array<{
    role: string;
    mimeType: string;
    url: string;
    urlExpiresAt: string;
  }>;
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
  /** How the timeline read state, split by endpoint (policy §11). */
  reads: { groups: number; generations: number };
  /** What the history read answers with, so restore can be driven per test. */
  composerRestore: Record<string, unknown> | null;
  /** Hand out already-expired signed asset URLs. */
  assetUrlsExpired: boolean;
};

// Signed URLs expire, and the payload says when. `expired` is how a test gets
// a card that arrives already dead: a settled row keeps the asset URLs it
// already holds (lib/imageTimelineMerge.ts rule 2), so a later poll cannot
// turn a live card into an expired one.
const succeededAssets = (expired = false) => {
  const urlExpiresAt = new Date(
    Date.now() + (expired ? -60_000 : 300_000)
  ).toISOString();
  return [
    {
      role: "original" as const,
      mimeType: "image/png",
      url: `${BASE_URL}/e2e-assets/original.png`,
      urlExpiresAt,
    },
    {
      role: "thumbnail" as const,
      mimeType: "image/webp",
      url: `${BASE_URL}/e2e-assets/thumbnail.png`,
      urlExpiresAt,
    },
  ];
};

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
    generation.assets = succeededAssets(state.assetUrlsExpired);
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
    reads: { groups: 0, generations: 0 },
    composerRestore: null,
    assetUrlsExpired: false,
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

  // The 5s poll: one request per comparison group, whatever the model count
  // (policy §11). The first read after creation resolves each row to the
  // configured outcome, exactly like the worker settling between two polls.
  await page.route("**/api/images/groups/*", async (route) => {
    state.reads.groups += 1;
    const groupId = new URL(route.request().url()).pathname.split("/").pop();
    const attempts = state.generations.filter((row) => row.groupId === groupId);
    if (attempts.length === 0) {
      return route.fulfill(
        json(
          {
            error: "Image generation group not found.",
            code: "IMAGE_GENERATION_GROUP_NOT_FOUND",
          },
          404
        )
      );
    }
    const generations = attempts.map((row) => resolveGeneration(state, row));
    const live = generations.some(
      (row) => row.status !== "succeeded" && row.status !== "failed"
    );
    const succeeded = generations.filter((row) => row.status === "succeeded");
    await route.fulfill(
      json({
        groupId,
        conversationId: state.conversationId,
        createdAt: generations[0].createdAt,
        status: live
          ? "in_progress"
          : succeeded.length === generations.length
            ? "succeeded"
            : succeeded.length === 0
              ? "failed"
              : "partial_success",
        targets: generations.map((row) => ({
          targetId: row.targetId,
          provider: row.provider ?? "openai",
          modelId: row.modelId ?? "gpt-image-2",
          currentGenerationId: row.generationId,
          attemptCount: row.attemptNumber ?? 1,
        })),
        generations,
      })
    );
  });

  // Single-card recovery: re-read one generation for fresh signed asset URLs.
  await page.route("**/api/images/generations/*", async (route) => {
    state.reads.generations += 1;
    const id = new URL(route.request().url()).pathname.split("/").pop();
    const generation = state.generations.find((row) => row.generationId === id);
    if (!generation) {
      return route.fulfill(
        json({ error: "Image generation not found.", code: "IMAGE_GENERATION_NOT_FOUND" }, 404)
      );
    }
    await route.fulfill(json(resolveGeneration(state, generation)));
  });

  // Saving the original. A separate endpoint from the read above because the
  // signed R2 URL cannot answer this question at all: `Content-Type` says what
  // the bytes are, and only a response from this origin can say what to do
  // with them (docs/policy/image-generation.md §9.1).
  await page.route("**/api/images/generations/*/download", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    const generation = state.generations.find((row) => row.generationId === id);
    if (!generation || generation.status !== "succeeded") {
      return route.fulfill(
        json(
          { error: "Image not found.", code: "IMAGE_GENERATION_NOT_FOUND" },
          404
        )
      );
    }
    const asset = generation.assets.find((entry) => entry.role === "original")!;
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": asset.mimeType,
        "content-disposition": `attachment; filename="${imageDownloadFilename({
          generationId: generation.generationId,
          modelId: generation.modelId,
          mimeType: asset.mimeType,
        })}"`,
        "x-content-type-options": "nosniff",
      },
      body: PNG_1X1,
    });
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
      json({
        conversationId: state.conversationId,
        generations: state.generations,
        composerRestore: state.composerRestore,
      })
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
  }
  // The unified launcher: the primary click stays "new chat", so the image
  // entry lives one caret away rather than in a second stacked button.
  await page.getByTestId("sidebar-new-launcher-more").click();
  await page.getByTestId("new-conversation-menu-image").click();
  if (isMobileShell()) {
    await expect(page.getByTestId("mobile-sidebar-drawer")).not.toBeVisible();
  }
};

test("the entry point does not exist while the flag is off", async ({ page }) => {
  await mockAuthenticatedApi(page);
  await page.goto("/chat");
  if (isMobileShell()) {
    await page.getByTestId("mobile-sidebar-open").click();
    await expect(page.getByTestId("mobile-sidebar-drawer")).toBeVisible();
  }
  // Flag off: the launcher stays a plain new-chat button with no caret and
  // no image entry anywhere.
  await expect(page.getByTestId("sidebar-new-launcher-more")).toHaveCount(0);
  await expect(page.getByTestId("new-conversation-menu-image")).toHaveCount(0);
});

test("a Free plan is routed to the upgrade, never into a composer it cannot submit", async ({
  page,
}) => {
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await installImageGenerationApi(page);
  await page.goto("/chat");

  if (isMobileShell()) {
    await page.getByTestId("mobile-sidebar-open").click();
    await expect(page.getByTestId("mobile-sidebar-drawer")).toBeVisible();
  }
  await page.getByTestId("sidebar-new-launcher-more").click();
  await page.getByTestId("new-conversation-menu-image").click();

  // The requirement is stated before entry and the click goes to the plan
  // page: a Free viewer never lands in a prompt box that would refuse them.
  await page.waitForURL(/\/pricing/);
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

test("saving a generated image downloads a file rather than opening it in a tab", async ({
  page,
}) => {
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  await installImageGenerationApi(page);
  await page.goto("/chat");

  await openNewImageEntry(page);
  await page.getByTestId("image-generation-prompt").fill("a single red apple");
  await page.getByTestId("image-generation-submit").click();
  await expect(page.getByTestId("image-generation-result")).toBeVisible({
    timeout: 15_000,
  });

  // The reported defect: the control was `<a href={signedR2Url} download>`,
  // and `download` is same-origin only. Browsers ignored it, followed the
  // link, and rendered a correct image/png in a new tab. Nothing about the
  // stored object was wrong, so nothing about the stored object could fix it.
  const control = page.getByTestId("image-generation-download");
  await expect(control).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    control.click(),
  ]);
  // Named from the recorded mime type and carrying the model, so a comparison
  // does not land as `original.png`, `original (1).png`, `original (2).png`.
  expect(download.suggestedFilename()).toMatch(
    /^tomverse-.+-qa-generation-1\.png$/
  );

  // And the workspace the download was started from is still on screen.
  await expect(page.getByTestId("image-generation-timeline")).toBeVisible();
});

test("the card says how long the original link lasts, before it matters", async ({
  page,
}) => {
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  await installImageGenerationApi(page);
  await page.goto("/chat");

  await openNewImageEntry(page);
  await page.getByTestId("image-generation-prompt").fill("a single red apple");
  await page.getByTestId("image-generation-submit").click();
  await expect(page.getByTestId("image-generation-result")).toBeVisible({
    timeout: 15_000,
  });

  // The number comes from IMAGE_ASSET_URL_TTL_MINUTES, the same constant the
  // server signs with, so this cannot pass while the copy quotes a TTL nothing
  // backs.
  const expiry = page.getByTestId("image-original-link-expiry");
  await expect(expiry).toBeVisible();
  await expect(expiry).toContainText(String(IMAGE_ASSET_URL_TTL_MINUTES));
});

test("an expired original link answers with a message, not with an error page", async ({
  page,
}) => {
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  const api = await installImageGenerationApi(page);
  // The card arrives with a signature that has already lapsed -- what a user
  // sees six minutes after generating, without waiting six minutes.
  api.assetUrlsExpired = true;
  await page.goto("/chat");

  await openNewImageEntry(page);
  await page.getByTestId("image-generation-prompt").fill("a single red apple");
  await page.getByTestId("image-generation-submit").click();
  await expect(page.getByTestId("image-generation-result")).toBeVisible({
    timeout: 15_000,
  });

  const openOriginal = page.getByTestId("image-generation-open-original");
  // Still a real link to the signed URL: the href is untouched, and only a
  // click that is known to be dead is refused.
  await expect(openOriginal).toHaveAttribute("href", /e2e-assets\/original\.png/);

  await openOriginal.click();

  // The reason, in the product's own words, on the page that asked.
  await expect(page.getByTestId("app-toast")).toBeVisible();

  // And nothing was navigated to: no second tab, and the workspace is still
  // the workspace. This is the whole point -- the alternative was an S3 error
  // document where the comparison used to be.
  expect(page.context().pages()).toHaveLength(1);
  await expect(page.getByTestId("image-generation-timeline")).toBeVisible();

  // The refused click also re-read the generation, so the card is holding a
  // freshly minted URL rather than the dead one it was clicked with.
  expect(api.reads.generations).toBeGreaterThan(0);
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
  // Two models are enabled and the disclosure threshold is three, so every one
  // of them is an inline choice and the compact affordance must not appear at
  // all. The compact branch itself is unreachable here until a fourth model is
  // activated, and is pinned in tests/imageModelRegistry.test.mjs instead --
  // the rule is what can be tested today, the rendering is not.
  await expect(page.getByTestId("image-model-picker-toggle")).toHaveCount(0);
  await expect(page.getByTestId("image-model-picker-panel")).toHaveCount(0);
  await expect(page.getByTestId("image-model-grok-imagine-image-quality-20260403")).toBeVisible();
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

test("two providers can be compared in one request, priced per model and in total", async ({ page }) => {
  // The first cross-provider comparison the feature was built for: OpenAI and
  // xAI in one group. Both prices are quoted before submission and the total is
  // their sum -- a comparison whose cost only appears afterwards is the thing
  // the pricing rules exist to prevent.
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  const api = await installImageGenerationApi(page);
  await page.goto("/chat");

  await openNewImageEntry(page);
  const openai = page.getByTestId("image-model-gpt-image-2");
  const grok = page.getByTestId("image-model-grok-imagine-image-quality-20260403");
  await expect(openai).toHaveAttribute("aria-pressed", "true");
  await expect(grok).toBeVisible();
  await grok.click();
  await expect(grok).toHaveAttribute("aria-pressed", "true");

  // Standard square: 70 + 75. The total only renders once more than one model
  // is selected, since a single model already states its own price.
  await expect(page.getByTestId("image-total-credits")).toContainText("145");

  await page.getByTestId("image-generation-prompt").fill("a red apple");
  await page.getByTestId("image-generation-submit").click();

  expect(api.createBodies).toHaveLength(1);
  expect(api.createBodies[0].modelIds).toEqual([
    "gpt-image-2",
    "grok-imagine-image-quality-20260403",
  ]);
  await expect(page.getByTestId("image-comparison-card")).toHaveCount(2);
  await expect(page.getByTestId("image-generation-entry")).toHaveCount(1);
});

test("an option one selected model cannot be priced blocks submission", async ({ page }) => {
  // Grok ships 1K square Standard only. Rather than quoting a guess for Final,
  // or silently dropping the model from a group the user asked for, the
  // composer refuses -- the price has to be true before anything is spent.
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  const api = await installImageGenerationApi(page);
  await page.goto("/chat");

  await openNewImageEntry(page);
  await page.getByTestId("image-model-grok-imagine-image-quality-20260403").click();
  await page.getByTestId("image-generation-prompt").fill("a red apple");
  await expect(page.getByTestId("image-generation-submit")).toBeEnabled();

  await page.getByTestId("image-preset-final").click();
  await expect(page.getByTestId("image-generation-submit")).toBeDisabled();
  expect(api.createBodies).toHaveLength(0);

  // Back to an option every selected model can price, and it is submittable
  // again -- the block is about the combination, not about the model.
  await page.getByTestId("image-preset-standard").click();
  await expect(page.getByTestId("image-generation-submit")).toBeEnabled();
});

test("promoting a draft keeps the composer settings and clears the prompt", async ({ page }) => {
  // The draft becoming the conversation it just created is not a conversation
  // switch. Remounting there discarded the model selection, quality and size
  // the user had chosen -- so a two-model comparison silently became a
  // one-model request on the very next submit.
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  const api = await installImageGenerationApi(page);
  await page.goto("/chat");

  await openNewImageEntry(page);
  await page.getByTestId("image-model-grok-imagine-image-quality-20260403").click();
  await page.getByTestId("image-preset-draft").click();
  await page.getByTestId("image-size-1536x1024").click();
  // Draft + landscape has no Grok price, so put it back where both models can
  // be priced; the point here is that the *choice* survives, not the price.
  await page.getByTestId("image-preset-standard").click();
  await page.getByTestId("image-size-1024x1024").click();

  await page.getByTestId("image-generation-prompt").fill("a red apple");
  await page.getByTestId("image-generation-submit").click();
  await expect(page.getByTestId("image-generation-result").first()).toBeVisible({
    timeout: 15_000,
  });

  // Still two models selected, and the prompt did not come back.
  await expect(
    page.getByTestId("image-model-grok-imagine-image-quality-20260403")
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("image-model-gpt-image-2")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByTestId("image-generation-prompt")).toHaveValue("");

  // ...and the next request really does carry both.
  await page.getByTestId("image-generation-prompt").fill("a green pear");
  await page.getByTestId("image-generation-submit").click();
  await expect.poll(() => api.createBodies.length).toBe(2);
  expect(api.createBodies[1].modelIds).toEqual([
    "gpt-image-2",
    "grok-imagine-image-quality-20260403",
  ]);
});

test("Enter submits on desktop and breaks the line on mobile", async ({ page }) => {
  // The shared chat contract, through the shared helper. Ctrl/Cmd+Enter kept
  // working either way -- desktop Enter is the only behaviour this adds.
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  const api = await installImageGenerationApi(page);
  await page.goto("/chat");

  await openNewImageEntry(page);
  const textarea = page.getByTestId("image-generation-prompt");
  await textarea.fill("a red apple");
  await textarea.press("Enter");

  if (isMobileShell()) {
    await expect(textarea).toHaveValue("a red apple\n");
    expect(api.createBodies).toHaveLength(0);
    await textarea.press("Control+Enter");
    await expect.poll(() => api.createBodies.length).toBe(1);
  } else {
    await expect.poll(() => api.createBodies.length).toBe(1);
  }
});

test("Shift+Enter never submits, on either shell", async ({ page }) => {
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  const api = await installImageGenerationApi(page);
  await page.goto("/chat");

  await openNewImageEntry(page);
  const textarea = page.getByTestId("image-generation-prompt");
  await textarea.fill("a red apple");
  await textarea.press("Shift+Enter");
  await expect(textarea).toHaveValue("a red apple\n");
  expect(api.createBodies).toHaveLength(0);
});

/**
 * Enter an existing image conversation the way a user does: from the sidebar.
 * There is no deep link for a conversation, so the list route is served the
 * way the real one does and the row is clicked.
 */
const openExistingImageConversation = async (
  page: Page,
  state: ImageApiState,
  title: string
) => {
  await page.unroute("**/api/conversations");
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill(
      json([
        {
          id: state.conversationId,
          title,
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
  if (isMobileShell()) {
    await page.getByTestId("mobile-sidebar-open").click();
    await expect(page.getByTestId("mobile-sidebar-drawer")).toBeVisible();
  }
  const row = page
    .getByTestId("sidebar-conversation-item")
    .filter({ hasText: title });
  await expect(row).toBeVisible();
  await row.click();
};

test("re-entering a conversation restores the last comparison's models", async ({ page }) => {
  // Fixing draft promotion alone left the same complaint reachable by another
  // route: refresh, or open the conversation again, and the composer was back
  // to one default model.
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  const api = await installImageGenerationApi(page);
  api.composerRestore = {
    sourceGroupId: "qa-group-1",
    modelIds: ["gpt-image-2", "grok-imagine-image-quality-20260403"],
    preset: "standard",
    quality: "medium",
    size: "1024x1024",
    excludedModelIds: [],
    optionsConsistent: true,
  };
  await openExistingImageConversation(page, api, "restored comparison");

  await expect(page.getByTestId("image-model-gpt-image-2")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(
    page.getByTestId("image-model-grok-imagine-image-quality-20260403")
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("image-total-credits")).toContainText("145");
  // The previous prompt is timeline history, not the next draft.
  await expect(page.getByTestId("image-generation-prompt")).toHaveValue("");
});

test("a restore that drops a model says so instead of quietly changing the selection", async ({
  page,
}) => {
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  const api = await installImageGenerationApi(page);
  api.composerRestore = {
    sourceGroupId: "qa-group-1",
    modelIds: ["gpt-image-2"],
    preset: null,
    quality: null,
    size: null,
    excludedModelIds: ["gemini-3.1-flash-image"],
    optionsConsistent: false,
  };
  await openExistingImageConversation(page, api, "partly restorable");

  const notice = page.getByTestId("image-generation-restore-notice");
  await expect(notice).toBeVisible();
  // Both facts are stated: the model that was dropped, and that the options
  // could not be restored. A selection that silently differs from the user's
  // last one is what this whole path exists to end.
  await expect(notice).toContainText("Gemini 3.1 Flash Image");
  await expect(page.getByTestId("image-model-gpt-image-2")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
});

test("the timeline polls the group, never one request per model", async ({ page }) => {
  // Policy §11: one poll per comparison group. Per-generation polling makes the
  // read cost of a comparison scale with the number of models compared -- and
  // because the client reads a refused poll as "no update", spending the status
  // rate limit shows up as a workspace that silently stops refreshing.
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  const api = await installImageGenerationApi(page);
  await page.goto("/chat");

  await openNewImageEntry(page);
  await page.getByTestId("image-generation-prompt").fill("a red apple");
  await page.getByTestId("image-generation-submit").click();

  await expect(page.getByTestId("image-generation-result")).toBeVisible({
    timeout: 15_000,
  });
  expect(api.reads.groups).toBeGreaterThan(0);
  // The by-id route is single-card recovery for expired asset URLs, not a
  // polling path: a settled run must not have used it at all.
  expect(api.reads.generations).toBe(0);
});

test("while a comparison runs the button is the progress, and it is disabled", async ({
  page,
}) => {
  // A separate "already generating" sentence beside a button still reading
  // "Generate" at full contrast said the same thing twice and left it
  // ambiguous whether the button could be clicked.
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  // The mock state is not read here: this test asserts what the composer
  // shows, and the request it makes is already covered elsewhere.
  await installImageGenerationApi(page);
  await page.goto("/chat");

  await openNewImageEntry(page);
  const submit = page.getByTestId("image-generation-submit");
  await expect(submit).toHaveAttribute("data-generating", "false");

  await page.getByTestId("image-generation-prompt").fill("a red apple");
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(submit).toHaveAttribute("data-generating", "true");
  await expect(submit).toBeDisabled();
  // The sentence stays for assistive technology -- a spinner is no signal at
  // all to a screen reader -- but must not occupy the row.
  // Visually hidden means it paints no row -- sr-only clips rather than
  // display:none, so it is still "visible" to Playwright and to the
  // accessibility tree, which is exactly the point.
  const busy = page.getByTestId("image-generation-busy-status");
  await expect(busy).toHaveCount(1);
  await expect(busy).toHaveAttribute("role", "status");
  const box = await busy.boundingBox();
  expect(box!.height, "the busy sentence still paints a row").toBeLessThanOrEqual(1);

  // ...and it hands the row back once the comparison settles.
  await expect(page.getByTestId("image-generation-result")).toBeVisible({
    timeout: 15_000,
  });
  await expect(submit).toHaveAttribute("data-generating", "false");
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

test("a Free plan sees the image entry locked, not hidden", async ({ page }) => {
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await installImageGenerationApi(page);
  await page.goto("/chat");

  if (isMobileShell()) {
    await page.getByTestId("mobile-sidebar-open").click();
    await expect(page.getByTestId("mobile-sidebar-drawer")).toBeVisible();
  }
  await page.getByTestId("sidebar-new-launcher-more").click();
  const entry = page.getByTestId("new-conversation-menu-image");
  // Visible and stating the requirement up front -- never hidden, never a
  // dead end at the last step.
  await expect(entry).toBeVisible();
  await expect(entry).toHaveAttribute("data-locked", "true");
});

test("the catalogue's image tab is its own list and seeds the picked model", async ({
  page,
}) => {
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  await installImageGenerationApi(page);
  await page.goto("/chat");

  await page.getByTestId("composer-model-select").click();
  await page.getByTestId("model-picker-tab-image").click();

  const panel = page.getByTestId("image-model-tab-panel");
  await expect(panel).toBeVisible();
  // A separate catalogue, not a filter over the chat list: no chat model row
  // and no chat-selection count survive the switch.
  await expect(page.getByTestId("recommended-model-option")).toHaveCount(0);
  await expect(page.getByTestId("model-picker-selection-count")).toHaveCount(0);

  // Every registered model is listed, including the ones held by the price
  // verification rule -- stated as a hold, never silently absent. The count is
  // asserted against the registry rather than hard-coded, so registering
  // another candidate does not fail this test for the wrong reason.
  const heldInRegistry = listImageModels().filter(
    (model) => model.disabledReason !== null
  ).length;
  expect(heldInRegistry).toBeGreaterThan(0);
  const held = panel.getByTestId("image-model-option").filter({
    has: page.getByTestId("image-model-hold-note"),
  });
  await expect(held).toHaveCount(heldInRegistry);
  for (let index = 0; index < heldInRegistry; index += 1) {
    await expect(held.nth(index)).toBeDisabled();
  }
  await expect(panel.getByTestId("image-model-option")).toHaveCount(
    listImageModels().length
  );

  // The subtitle credits the model's owner and names the supplier when they
  // differ. Staging showed why this needs asserting: the row read `provider`,
  // which is indistinguishable from `owner` for every direct integration, and
  // the first model where they part company rendered no brand at all.
  const gatewayRow = panel.getByTestId("image-model-option").filter({
    hasText: "Nano Banana 2",
  });
  await expect(gatewayRow).toContainText("Google");
  await expect(gatewayRow.getByTestId("image-model-gateway")).toBeVisible();
  // And a direct integration says one thing, not the same thing twice.
  await expect(
    panel
      .getByTestId("image-model-option")
      .filter({ hasText: "GPT Image 2" })
      .getByTestId("image-model-gateway")
  ).toHaveCount(0);

  await panel
    .getByTestId("image-model-option")
    .filter({ hasNot: page.getByTestId("image-model-hold-note") })
    .first()
    .click();

  // The workspace opens on the model that was picked.
  await expect(page.getByTestId("image-generation-prompt")).toBeVisible();
  await expect(page.getByTestId("image-model-gpt-image-2")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
});

test("a Free plan sees the image tab locked, not hidden", async ({ page }) => {
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await installImageGenerationApi(page);
  await page.goto("/chat");

  await page.getByTestId("composer-model-select").click();
  await page.getByTestId("model-picker-tab-image").click();

  const selectable = page
    .getByTestId("image-model-tab-panel")
    .getByTestId("image-model-option")
    .filter({ hasNot: page.getByTestId("image-model-hold-note") })
    .first();
  await expect(selectable).toBeVisible();
  await expect(selectable).toHaveAttribute("data-locked", "true");

  await selectable.click();
  await page.waitForURL(/\/pricing/);
  await expect(page.getByTestId("image-generation-prompt")).toHaveCount(0);
});

test("the composer entry carries the chat draft and restores it on cancel", async ({
  page,
}) => {
  await enableImageGenerationFlag(page);
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  await installImageGenerationApi(page);
  await page.goto("/chat");

  await page.getByTestId("chat-textarea").fill("a lighthouse at dusk");
  await page.getByTestId("composer-tools-button").click();
  await page.getByTestId("tools-image-generation-row").click();

  // The typed text becomes the image prompt rather than being lost.
  await expect(page.getByTestId("image-generation-prompt")).toHaveValue(
    "a lighthouse at dusk"
  );

  // Going back restores the chat draft exactly.
  await page.getByTestId("image-generation-cancel-draft").click();
  await expect(page.getByTestId("chat-textarea")).toHaveValue(
    "a lighthouse at dusk"
  );
});

/* -------------------------------------------------------------------------- */
/* The comparison limit: what the composer offers is what admission accepts.  */
/* -------------------------------------------------------------------------- */

/**
 * Override the limit for one browser context.
 *
 * The value is an environment variable read at boot and the suite runs one
 * server for every test, so a spec cannot restart it to exercise both sides of
 * the limit. Honoured only in fixture mode, through the same parser a
 * deployment goes through (app/(site)/(application)/chat/page.tsx).
 */
const setImageGroupMaxModels = async (page: Page, value: string) => {
  await page.context().addCookies([
    {
      name: "__tomverse_e2e_image_group_max_models",
      value,
      url: BASE_URL,
    },
  ]);
};

test("at a limit of two, the third model is refused and the reason is specific", async ({
  page,
}) => {
  // The defect this covers: all three chips selected cleanly, the total read
  // 265, Generate was enabled, and the request came back as a generic "try
  // again" that retrying could not fix.
  await enableImageGenerationFlag(page);
  await setImageGroupMaxModels(page, "2");
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  const api = await installImageGenerationApi(page);
  await page.goto("/chat");

  await openNewImageEntry(page);
  const openai = page.getByTestId("image-model-gpt-image-2");
  const grok = page.getByTestId("image-model-grok-imagine-image-quality-20260403");
  const nano = page.getByTestId("image-model-fal-ai/nano-banana-2");

  await expect(openai).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("image-model-selection-count")).toContainText("1");
  await grok.click();
  await expect(grok).toHaveAttribute("aria-pressed", "true");

  // Still listed and still focusable: discovery is not the price of the limit.
  await expect(nano).toBeVisible();
  await expect(nano).toHaveAttribute("aria-disabled", "true");
  // aria-disabled blocks activation rather than only dimming the control:
  // Playwright already refuses a normal click on an aria-disabled control, so
  // force one through and confirm nothing changes. Without `force` the two
  // lines above and this one contradict each other -- the assertion pins the
  // attribute that makes the click unperformable -- and the click spends the
  // whole 30s actionability budget reporting "element is not enabled".
  // Same reasoning and same fix as comparison-action-rail.spec.ts.
  await nano.click({ force: true });
  await expect(nano).toHaveAttribute("aria-pressed", "false");
  // Neither of the first two was swapped out to make room.
  await expect(openai).toHaveAttribute("aria-pressed", "true");
  await expect(grok).toHaveAttribute("aria-pressed", "true");

  const notice = page.getByTestId("image-model-limit-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("2");
  // The reason reaches the control itself, not only the page.
  await expect(nano).toHaveAttribute(
    "aria-describedby",
    await notice.getAttribute("id") as string
  );

  // A keyboard activation is refused the same way, and changes nothing.
  await nano.focus();
  await page.keyboard.press("Enter");
  await expect(nano).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Space");
  await expect(nano).toHaveAttribute("aria-pressed", "false");

  // The valid selection still submits: a limit is not a dead end.
  await expect(page.getByTestId("image-total-credits")).toContainText("145");
  await page.getByTestId("image-generation-prompt").fill("a red apple");
  await page.getByTestId("image-generation-submit").click();
  expect(api.createBodies).toHaveLength(1);
  expect(api.createBodies[0].modelIds).toEqual([
    "gpt-image-2",
    "grok-imagine-image-quality-20260403",
  ]);

  // Deselecting at the limit is how the user gets out of it.
  await openai.click();
  await expect(openai).toHaveAttribute("aria-pressed", "false");
  await expect(nano).not.toHaveAttribute("aria-disabled", "true");
});

test("at a limit of three, all three providers compare in one request", async ({
  page,
}) => {
  await enableImageGenerationFlag(page);
  await setImageGroupMaxModels(page, "3");
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  const api = await installImageGenerationApi(page);
  await page.goto("/chat");

  await openNewImageEntry(page);
  await page.getByTestId("image-model-grok-imagine-image-quality-20260403").click();
  await page.getByTestId("image-model-fal-ai/nano-banana-2").click();

  for (const modelId of [
    "gpt-image-2",
    "grok-imagine-image-quality-20260403",
    "fal-ai/nano-banana-2",
  ]) {
    await expect(page.getByTestId(`image-model-${modelId}`)).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  }
  // 70 + 75 + 120 at Standard square.
  await expect(page.getByTestId("image-total-credits")).toContainText("265");
  await expect(page.getByTestId("image-model-selection-count")).toContainText("3");

  await page.getByTestId("image-generation-prompt").fill("a red apple");
  await page.getByTestId("image-generation-submit").click();

  expect(api.createBodies).toHaveLength(1);
  expect(api.createBodies[0].modelIds).toEqual([
    "gpt-image-2",
    "grok-imagine-image-quality-20260403",
    "fal-ai/nano-banana-2",
  ]);
  await expect(page.getByTestId("image-comparison-card")).toHaveCount(3);
});

test("a server refusal a stale composer could not predict names the limit", async ({
  page,
}) => {
  // The composer believes 3 and admission applied 2 -- a tab left open across
  // a deployment that lowered the limit. The client's own check passed, so the
  // only thing standing between the user and "try again" forever is this
  // mapping.
  await enableImageGenerationFlag(page);
  await setImageGroupMaxModels(page, "3");
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro" });
  await installImageGenerationApi(page);
  await page.route("**/api/images/generations", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill(
      json(
        {
          error: "Select at most 2 models to compare.",
          code: "IMAGE_MODEL_SELECTION_INVALID",
          details: { maxModels: 2, requestedModels: 3 },
        },
        400
      )
    );
  });
  await page.goto("/chat");

  await openNewImageEntry(page);
  await page.getByTestId("image-model-grok-imagine-image-quality-20260403").click();
  await page.getByTestId("image-model-fal-ai/nano-banana-2").click();
  await page.getByTestId("image-generation-prompt").fill("a red apple");
  await page.getByTestId("image-generation-submit").click();

  const error = page.getByTestId("image-generation-error");
  await expect(error).toBeVisible();
  // The server's number, not the composer's: 2 is what admission applied.
  await expect(error).toContainText("2");
  await expect(error).not.toContainText("3");
});
