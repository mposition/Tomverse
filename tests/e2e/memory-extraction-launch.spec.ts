import { test, expect, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

/**
 * Extraction launch and run progress — /settings/memory and
 * /settings/memory/runs/[runId] (policy §11 pre-run confirmation, §21).
 *
 * The three states worth an end-to-end check are the ones a unit test cannot
 * reach, because they are agreements between the screen and the server:
 *
 *   * no approved pair — the screen states it instead of offering a control
 *     whose only outcome is 403 (§12.4);
 *   * the confirmed credit figure is the displayed one, and changing the
 *     selection withdraws the offer rather than sending a stale number that
 *     the server answers 409 MEMORY_ESTIMATE_CHANGED;
 *   * a run already open replaces the whole launch flow with a link to it.
 *
 * The database is off in E2E, so every endpoint here is mocked, and the mocks
 * record what was sent — asserting the request body is the point for the
 * confirmation contract.
 */

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

type Conversation = {
  id: string;
  importId: string;
  provider: string;
  title: string;
  externalStableId: string | null;
  messageCount: number;
  contentBytes: number;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  importedAt: string;
};

const conversation = (id: string, contentBytes = 40_000): Conversation => ({
  id,
  importId: "imp-1",
  provider: "chatgpt",
  title: `QA conversation ${id}`,
  externalStableId: `ext-${id}`,
  messageCount: 12,
  contentBytes,
  sourceCreatedAt: "2026-07-01T00:00:00.000Z",
  sourceUpdatedAt: "2026-07-02T00:00:00.000Z",
  importedAt: "2026-08-01T00:00:00.000Z",
});

type RunRow = {
  id: string;
  status: string;
  extractionModelId: string;
  promptVersion: string;
  chunkTotal: number;
  chunkCompleted: number;
  createdAt: string;
  completedAt: string | null;
  /** Server-derived: running, but no worker currently holds the lease. */
  stalled?: boolean;
};

type ExtractionQaState = {
  estimateBodies: Array<Record<string, unknown>>;
  createBodies: Array<Record<string, unknown>>;
  cancelCalls: number;
  run: RunRow;
};

async function mockExtractionApi(
  page: Page,
  options: {
    /** Empty by default: no pair has an eval approval today. */
    pairs?: Array<{
      extractionModelId: string;
      promptVersion: string;
      modelName: string;
      creditsPerChunk: number;
    }>;
    conversations?: Conversation[];
    activeRunId?: string | null;
    recentRuns?: RunRow[];
    /** Credits per estimate, keyed by how many conversations were sent. */
    creditsPerConversation?: number;
    /** The create call answers 409 MEMORY_ESTIMATE_CHANGED. */
    estimateChangedOnCreate?: boolean;
    run?: Partial<RunRow>;
  } = {}
): Promise<ExtractionQaState> {
  const state: ExtractionQaState = {
    estimateBodies: [],
    createBodies: [],
    cancelCalls: 0,
    run: {
      id: "run-1",
      status: "running",
      extractionModelId: "gpt-5-6-luna",
      promptVersion: "mem-extract-v1",
      chunkTotal: 4,
      chunkCompleted: 1,
      createdAt: "2026-08-04T00:00:00.000Z",
      completedAt: null,
      ...options.run,
    },
  };
  const conversations = options.conversations ?? [];
  const credits = options.creditsPerConversation ?? 2;

  // The launcher is mounted inside the review page, which unmounts everything
  // when its settings probe answers 401. Without these two the launch controls
  // disappear mid-test and every assertion below becomes vacuous.
  await page.route(
    (url) => url.pathname === "/api/memories/settings",
    (route) =>
      route.fulfill(
        json({
          masterEnabled: true,
          styleEnabled: true,
          defaultConversationMode: "on",
        })
      )
  );

  await page.route(
    (url) => url.pathname === "/api/memories",
    (route) => route.fulfill(json({ total: 0, offset: 0, limit: 100, memories: [] }))
  );

  await page.route(
    (url) => url.pathname === "/api/memories/extraction-models",
    (route) => route.fulfill(json({ pairs: options.pairs ?? [] }))
  );

  await page.route(
    (url) => url.pathname === "/api/external-conversations",
    (route) =>
      route.fulfill(
        json({
          total: conversations.length,
          offset: 0,
          limit: 50,
          conversations,
        })
      )
  );

  await page.route(
    (url) => url.pathname === "/api/memories/extraction-runs",
    (route) => {
      if (route.request().method() !== "POST") {
        return route.fulfill(
          json({
            runs: options.recentRuns ?? [],
            activeRunId: options.activeRunId ?? null,
          })
        );
      }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const selected = (body.selectedConversationIds as string[]) ?? [];
      if (body.estimateOnly) {
        state.estimateBodies.push(body);
        return route.fulfill(
          json({
            chunkCount: selected.length,
            estimatedCredits: selected.length * credits,
            conversationCount: selected.length,
            basis: "conservative_default",
          })
        );
      }
      state.createBodies.push(body);
      if (options.estimateChangedOnCreate) {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: "The estimate no longer matches the selection.",
            code: "MEMORY_ESTIMATE_CHANGED",
          }),
        });
      }
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          runId: state.run.id,
          status: "pending",
          chunkTotal: selected.length,
        }),
      });
    }
  );

  await page.route(
    (url) => /^\/api\/memories\/extraction-runs\/[^/]+\/cancel$/.test(url.pathname),
    (route) => {
      state.cancelCalls += 1;
      state.run.status = "cancelled";
      return route.fulfill(json({ outcome: "cancelled" }));
    }
  );

  await page.route(
    (url) => /^\/api\/memories\/extraction-runs\/[^/]+$/.test(url.pathname),
    (route) => route.fulfill(json(state.run))
  );

  return state;
}

const openMemoryPage = async (page: Page) => {
  await page.goto("/settings/memory");
  await expect(page.getByTestId("memory-extraction-launcher")).toBeVisible();
};

const approvedPair = {
  extractionModelId: "gpt-5-6-luna",
  promptVersion: "mem-extract-v1",
  modelName: "GPT-5.6 Luna",
  creditsPerChunk: 2,
};

test.beforeEach(async ({ page }) => {
  await prepareGuestPage(page, "en");
  await mockAuthenticatedApi(page);
});

test("with no approved pair the screen states it and offers no start", async ({
  page,
}) => {
  await mockExtractionApi(page, { conversations: [conversation("c-1")] });
  await openMemoryPage(page);

  await expect(page.getByTestId("memory-extraction-no-pair")).toBeVisible();
  await expect(page.getByTestId("memory-extraction-estimate")).toHaveCount(0);
  await expect(page.getByTestId("memory-extraction-start")).toHaveCount(0);
});

test("the confirmed credits are the credits shown", async ({ page }) => {
  const state = await mockExtractionApi(page, {
    pairs: [approvedPair],
    conversations: [conversation("c-1"), conversation("c-2")],
  });
  await openMemoryPage(page);

  await page.getByTestId("memory-extraction-select-visible").click();
  await expect(page.getByTestId("memory-extraction-selection-summary")).toContainText(
    "2 selected"
  );

  await page.getByTestId("memory-extraction-estimate").click();
  await expect(page.getByTestId("memory-extraction-estimate-result")).toContainText(
    "4 credits"
  );

  const start = page.getByTestId("memory-extraction-start");
  await expect(start).toContainText("4 credits");
  await start.click();

  await expect(page).toHaveURL(/\/settings\/memory\/runs\/run-1$/);
  expect(state.createBodies).toHaveLength(1);
  expect(state.createBodies[0].confirmedCredits).toBe(4);
  expect(state.createBodies[0].selectedConversationIds).toEqual([
    "c-1",
    "c-2",
  ]);
});

test("changing the selection withdraws the start offer until it is re-checked", async ({
  page,
}) => {
  const state = await mockExtractionApi(page, {
    pairs: [approvedPair],
    conversations: [conversation("c-1"), conversation("c-2")],
  });
  await openMemoryPage(page);

  await page.getByTestId("memory-extraction-select-visible").click();
  await page.getByTestId("memory-extraction-estimate").click();
  await expect(page.getByTestId("memory-extraction-start")).toBeEnabled();

  // Deselecting one row makes the shown figure describe a selection that is no
  // longer on screen. The number stays visible, flagged, and unusable.
  await page
    .getByTestId("memory-extraction-conversation-row")
    .first()
    .locator("input[type=checkbox]")
    .uncheck();
  await expect(page.getByTestId("memory-extraction-estimate-stale")).toBeVisible();
  await expect(page.getByTestId("memory-extraction-start")).toBeDisabled();
  expect(state.createBodies).toHaveLength(0);

  await page.getByTestId("memory-extraction-estimate").click();
  await expect(page.getByTestId("memory-extraction-estimate-stale")).toHaveCount(0);
  await expect(page.getByTestId("memory-extraction-start")).toContainText(
    "2 credits"
  );
});

test("a server-side estimate change is reported, not retried silently", async ({
  page,
}) => {
  await mockExtractionApi(page, {
    pairs: [approvedPair],
    conversations: [conversation("c-1")],
    estimateChangedOnCreate: true,
  });
  await openMemoryPage(page);

  await page.getByTestId("memory-extraction-select-visible").click();
  await page.getByTestId("memory-extraction-estimate").click();
  await page.getByTestId("memory-extraction-start").click();

  await expect(page.getByTestId("memory-extraction-error")).toContainText(
    "no longer matches"
  );
  await expect(page).toHaveURL(/\/settings\/memory$/);
  // The stale figure is gone, so there is nothing left to press a second time.
  await expect(page.getByTestId("memory-extraction-start")).toHaveCount(0);
});

test("an open run replaces the launch flow with a link to it", async ({
  page,
}) => {
  await mockExtractionApi(page, {
    pairs: [approvedPair],
    conversations: [conversation("c-1")],
    activeRunId: "run-1",
  });
  await openMemoryPage(page);

  await expect(page.getByTestId("memory-extraction-active-run")).toBeVisible();
  await expect(page.getByTestId("memory-extraction-estimate")).toHaveCount(0);

  await page.getByTestId("memory-extraction-active-run-link").click();
  await expect(page).toHaveURL(/\/settings\/memory\/runs\/run-1$/);
  await expect(page.getByTestId("memory-extraction-run-progress")).toContainText(
    "1 of 4"
  );
});

test("a finished run stays reachable from the launcher", async ({ page }) => {
  await mockExtractionApi(page, {
    pairs: [approvedPair],
    conversations: [conversation("c-1")],
    recentRuns: [
      {
        id: "run-old",
        status: "completed",
        extractionModelId: "gpt-5-6-luna",
        promptVersion: "mem-extract-v1",
        chunkTotal: 3,
        chunkCompleted: 3,
        createdAt: "2026-08-02T00:00:00.000Z",
        completedAt: "2026-08-02T00:10:00.000Z",
      },
    ],
  });
  await openMemoryPage(page);

  const recent = page.getByTestId("memory-extraction-recent-run");
  await expect(recent).toHaveCount(1);
  await expect(recent).toContainText("Finished");
  await recent.getByRole("link").click();
  await expect(page).toHaveURL(/\/settings\/memory\/runs\/run-old$/);
});

test("a finished run stops offering cancel and points at the review queue", async ({
  page,
}) => {
  await mockExtractionApi(page, {
    pairs: [approvedPair],
    run: {
      status: "completed",
      chunkCompleted: 4,
      completedAt: "2026-08-04T01:00:00.000Z",
    },
  });
  await page.goto("/settings/memory/runs/run-1");

  await expect(page.getByTestId("memory-extraction-run-status")).toHaveText(
    "Finished"
  );
  await expect(page.getByTestId("memory-extraction-run-cancel")).toHaveCount(0);
  await expect(page.getByTestId("memory-extraction-run-review")).toBeVisible();
});

test("a stalled run explains the pause and still offers cancel", async ({
  page,
}) => {
  // The bar has not moved and will not for up to fifteen minutes. Saying
  // "extraction is running" there would be the screen contradicting what the
  // user can see, so the note has to name the pause -- without implying the
  // run failed or that the finished chunks were lost.
  await mockExtractionApi(page, {
    pairs: [approvedPair],
    run: { status: "running", chunkCompleted: 1, stalled: true },
  });
  await page.goto("/settings/memory/runs/run-1");

  // Still `running`: a stall is not a status of its own, and the screen must
  // not promote it to one.
  await expect(page.getByTestId("memory-extraction-run-status")).toHaveText(
    "Running"
  );
  const note = page.getByTestId("memory-extraction-run-note");
  await expect(note).toHaveAttribute("data-stalled", "true");
  await expect(note).toContainText("paused");
  await expect(note).toContainText("resumes automatically");
  // Waiting is not the only option a paused run may offer.
  await expect(page.getByTestId("memory-extraction-run-cancel")).toBeVisible();
});

test("cancelling takes two presses and keeps completed work", async ({
  page,
}) => {
  const state = await mockExtractionApi(page, { pairs: [approvedPair] });
  await page.goto("/settings/memory/runs/run-1");

  const cancel = page.getByTestId("memory-extraction-run-cancel");
  await cancel.click();
  expect(state.cancelCalls).toBe(0);
  await expect(cancel).toContainText("again");

  await cancel.click();
  await expect(page.getByTestId("memory-extraction-run-status")).toHaveText(
    "Cancelled"
  );
  await expect(page.getByTestId("memory-extraction-run-note")).toContainText(
    "kept"
  );
  expect(state.cancelCalls).toBe(1);
});

test("a run that does not exist says so instead of spinning", async ({
  page,
}) => {
  await page.route(
    (url) => /^\/api\/memories\/extraction-runs\/[^/]+$/.test(url.pathname),
    (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "Run not found.", code: "NOT_FOUND" }),
      })
  );
  await page.goto("/settings/memory/runs/missing-run");

  await expect(page.getByTestId("memory-extraction-run-missing")).toBeVisible();
});
