import { test, expect, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

/**
 * Release A external conversation import — /settings/imports and its Data-tab
 * entry point (docs/policy/external-conversation-import-and-memory.md §21).
 *
 * The archive is parsed by a real Web Worker inside the browser under test;
 * only the four staging API endpoints are mocked. The database is off in E2E,
 * so the rollout flag reads as disabled server-side — which is exactly why
 * the UI gates on the capacity endpoint: fulfilling it 200 here stands in
 * for the flag being on, and fulfilling it 403 exercises the fail-closed
 * path a disabled flag produces in production.
 */

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/**
 * A minimal but structurally faithful ChatGPT export: a top-level array of
 * conversations, each a `mapping` node tree with `current_node` naming the
 * active branch's leaf (what lib/externalImportAdapters/chatgpt.ts walks).
 */
const chatgptConversation = (index: number) => ({
  conversation_id: `qa-conv-${index}`,
  title: `QA imported conversation ${index}`,
  create_time: 1750000000 + index,
  update_time: 1750000500 + index,
  current_node: "node-2",
  mapping: {
    "node-0": { id: "node-0", children: ["node-1"] },
    "node-1": {
      id: "node-1",
      parent: "node-0",
      children: ["node-2"],
      message: {
        id: `msg-user-${index}`,
        author: { role: "user" },
        create_time: 1750000100 + index,
        content: { content_type: "text", parts: [`Hello from QA ${index}`] },
      },
    },
    "node-2": {
      id: "node-2",
      parent: "node-1",
      children: [],
      message: {
        id: `msg-assistant-${index}`,
        author: { role: "assistant" },
        create_time: 1750000200 + index,
        content: {
          content_type: "text",
          parts: [`A stored answer for QA ${index}`],
        },
        metadata: { model_slug: "gpt-qa-model" },
      },
    },
  },
});

const chatgptExportFile = (conversationCount: number) => ({
  name: "conversations.json",
  mimeType: "application/json",
  buffer: Buffer.from(
    JSON.stringify(
      Array.from({ length: conversationCount }, (_, index) =>
        chatgptConversation(index)
      )
    ),
    "utf8"
  ),
});

/** What GET /api/imports/external/[importId] returns to the owner. */
type ImportDetail = {
  id: string;
  provider: string;
  status: string;
  counts: {
    conversations: number;
    messages: number;
    normalizedBytes: number;
    truncatedMessages: number;
    duplicatesSkipped: number;
  };
  createdAt: string;
  completedAt: string | null;
  effectiveExpiresAt?: string | null;
  expired?: boolean;
  conversations: Array<{
    id: string;
    title: string;
    conversationDigest: string;
    messageCount: number;
    contentBytes: number;
    truncatedMessageCount: number;
    finalized: boolean;
    sourceUpdatedAt: string | null;
  }>;
};

type ImportApiState = {
  createCount: number;
  batchBodies: Array<{
    sequence: number;
    conversations: Array<{
      rawExternalConversationId: string;
      title: string;
      messages: Array<{ role: string; ordinal: number; content: string }>;
    }>;
  }>;
  finalizeBody: {
    idempotencyKey: string;
    selectedConversationIds: string[];
    expectedImportDigest?: string;
  } | null;
  finalizeCount: number;
  sealBodies: Array<{
    finalSequence: number;
    expectedStagedConversationIds: string[];
    expectedDuplicateCount: number;
  }>;
  deleteCount: number;
  deleteUrls: string[];
  memoryImpactReads: number;
  historyReads: number;
  snapshotDeleteCount: number;
  exportCount: number;
};

type ViewerConversationRow = {
  id: string;
  importId: string;
  provider: string;
  title: string;
  externalStableId: string;
  messageCount: number;
  contentBytes: number;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  importedAt: string;
};

type ViewerDetail = {
  id: string;
  importId: string;
  provider: string;
  title: string;
  externalStableId: string;
  sourceModelLabels: string[];
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  importedAt: string;
  messageTotal: number;
  messages: Array<{
    id: string;
    role: string;
    ordinal: number;
    content: string;
    sourceModelLabel: string | null;
    sourceTimestamp: string | null;
    truncated: boolean;
    originalCharacterCount: number | null;
    retainedCharacterCount: number | null;
  }>;
};

async function mockImportApi(
  page: Page,
  options: {
    disabled?: boolean;
    history?: unknown[];
    /** Raw conversation IDs the batch endpoint reports as duplicates. */
    duplicateRawIds?: string[];
    /** Finalized rows served by the viewer list endpoint. */
    viewerConversations?: ViewerConversationRow[];
    /** The one conversation the viewer detail endpoint serves, paged. */
    viewerDetail?: ViewerDetail;
    /** Fails the batch at this sequence with the given code (null = network). */
    failBatchAt?: { sequence: number; code: string | null; status: number };
    /** Fails the first N finalize calls with this code, then succeeds. */
    failFinalize?: { code: string; status: number; times: number };
    /** Payload served by GET /api/imports/external/[importId]. */
    importDetail?: ImportDetail;
    /** §13.1 impact served to the delete confirmation. */
    memoryImpact?: {
      derivedCount: number;
      userTouchedCount: number;
      keptCount: number;
    };
  } = {}
): Promise<ImportApiState> {
  const state: ImportApiState = {
    createCount: 0,
    batchBodies: [],
    finalizeBody: null,
    finalizeCount: 0,
    sealBodies: [],
    deleteCount: 0,
    deleteUrls: [],
    memoryImpactReads: 0,
    historyReads: 0,
    snapshotDeleteCount: 0,
    exportCount: 0,
  };
  const disabledResponse = {
    status: 403,
    contentType: "application/json",
    body: JSON.stringify({
      error: "External conversation import is not enabled.",
      code: "EXTERNAL_IMPORT_DISABLED",
    }),
  };

  await page.route(
    (url) => url.pathname === "/api/imports/external/capacity",
    (route) => {
      if (options.disabled) return route.fulfill(disabledResponse);
      return route.fulfill(
        json({
          limits: {
            maxNormalizedTextBytes: 50 * 1024 * 1024,
            maxExternalConversations: 2000,
            maxExternalMessages: 100000,
            maxStoredMessageCodePoints: 100000,
            maxInboundMessageCodePoints: 1000000,
          },
          usage: {
            normalizedTextBytes: 1024,
            externalConversations: 3,
            externalMessages: 40,
          },
          remaining: {
            normalizedTextBytes: 50 * 1024 * 1024 - 1024,
            externalConversations: 1997,
            externalMessages: 99960,
          },
          generatedAt: "2026-08-03T00:00:00.000Z",
        })
      );
    }
  );

  await page.route(
    (url) => url.pathname === "/api/imports/external",
    (route) => {
      if (route.request().method() === "GET") {
        state.historyReads += 1;
        return route.fulfill(json({ imports: options.history ?? [] }));
      }
      if (options.disabled) return route.fulfill(disabledResponse);
      state.createCount += 1;
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          importId: "qa-import-1",
          status: "staging",
          digestVersion: 1,
        }),
      });
    }
  );

  await page.route(
    (url) => /^\/api\/imports\/external\/[^/]+\/batches$/.test(url.pathname),
    (route) => {
      if (options.disabled) return route.fulfill(disabledResponse);
      const body = route.request().postDataJSON() as
        ImportApiState["batchBodies"][number];
      const failure = options.failBatchAt;
      if (failure && failure.sequence === body.sequence) {
        if (failure.code === null) return route.abort("failed");
        return route.fulfill({
          status: failure.status,
          contentType: "application/json",
          body: JSON.stringify({ error: "refused", code: failure.code }),
        });
      }
      state.batchBodies.push(body);
      const duplicates = new Set(options.duplicateRawIds ?? []);
      return route.fulfill(
        json({
          idempotentReplay: false,
          results: body.conversations.map((conversation, index) =>
            duplicates.has(conversation.rawExternalConversationId)
              ? {
                  rawExternalConversationId:
                    conversation.rawExternalConversationId,
                  outcome: "duplicate",
                  conversationDigest: "c".repeat(64),
                  truncatedMessageCount: 0,
                }
              : {
                  rawExternalConversationId:
                    conversation.rawExternalConversationId,
                  outcome: "staged",
                  stagedConversationId: `qa-staged-${state.batchBodies.length}-${index}`,
                  conversationDigest: "d".repeat(64),
                  truncatedMessageCount: 0,
                }
          ),
        })
      );
    }
  );

  await page.route(
    (url) => /^\/api\/imports\/external\/[^/]+\/finalize$/.test(url.pathname),
    (route) => {
      if (options.disabled) return route.fulfill(disabledResponse);
      const body = route.request().postDataJSON() as NonNullable<
        ImportApiState["finalizeBody"]
      >;
      state.finalizeCount += 1;
      state.finalizeBody = body;
      if (options.failFinalize && state.finalizeCount <= options.failFinalize.times) {
        return route.fulfill({
          status: options.failFinalize.status,
          contentType: "application/json",
          body: JSON.stringify({
            error: "refused",
            code: options.failFinalize.code,
          }),
        });
      }
      return route.fulfill(
        json({
          idempotentReplay: false,
          importDigest: "e".repeat(64),
          finalizedConversations: body.selectedConversationIds.length,
          finalizedMessages: body.selectedConversationIds.length * 2,
        })
      );
    }
  );

  // Seal: the client declares its upload complete and the server echoes back
  // the staged set it verified. The real endpoint cross-checks the
  // declaration; the mock records it so the specs can assert what was sent.
  await page.route(
    (url) => /^\/api\/imports\/external\/[^/]+\/seal$/.test(url.pathname),
    (route) => {
      if (options.disabled) return route.fulfill(disabledResponse);
      const body = route.request().postDataJSON() as
        ImportApiState["sealBodies"][number];
      state.sealBodies.push(body);
      const titles = new Map<string, string>();
      for (const batch of state.batchBodies) {
        batch.conversations.forEach((conversation, index) => {
          titles.set(
            `qa-staged-${state.batchBodies.indexOf(batch) + 1}-${index}`,
            conversation.title
          );
        });
      }
      return route.fulfill(
        json({
          idempotentReplay: false,
          status: "preview_ready",
          updatedAt: "2026-08-03T00:00:00.000Z",
          idleExpiresAt: "2026-08-04T00:00:00.000Z",
          absoluteExpiresAt: "2026-08-06T00:00:00.000Z",
          effectiveExpiresAt: "2026-08-04T00:00:00.000Z",
          duplicateCount: body.expectedDuplicateCount,
          truncatedMessageCount: 0,
          sealedSelectionDigest: "f".repeat(64),
          conversations: body.expectedStagedConversationIds.map((id) => ({
            id,
            title: titles.get(id) ?? id,
            conversationDigest: "d".repeat(64),
            externalStableId: "lineage-qa",
            messageCount: 2,
            contentBytes: 64,
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
          })),
        })
      );
    }
  );

  await page.route(
    (url) => url.pathname === "/api/imports/external/export",
    (route) => {
      state.exportCount += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "Content-Disposition":
            'attachment; filename="tomverse-external-conversations.json"',
        },
        body: JSON.stringify({
          format: "tomverse.external-conversations.v1",
          conversations: [],
        }),
      });
    }
  );

  await page.route(
    (url) => url.pathname === "/api/external-conversations",
    (route) => {
      if (options.disabled) return route.fulfill(disabledResponse);
      const rows = options.viewerConversations ?? [];
      const requestUrl = new URL(route.request().url());
      const offset = Number(requestUrl.searchParams.get("offset") ?? 0);
      const limit = Number(requestUrl.searchParams.get("limit") ?? 50);
      return route.fulfill(
        json({
          total: rows.length,
          offset,
          limit,
          conversations: rows.slice(offset, offset + limit),
        })
      );
    }
  );

  await page.route(
    (url) => /^\/api\/external-conversations\/[^/]+$/.test(url.pathname),
    (route) => {
      if (route.request().method() === "DELETE") {
        state.snapshotDeleteCount += 1;
        return route.fulfill(json({ outcome: "deleted" }));
      }
      if (options.disabled) return route.fulfill(disabledResponse);
      const detail = options.viewerDetail;
      if (!detail) {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Conversation not found." }),
        });
      }
      const requestUrl = new URL(route.request().url());
      const offset = Number(requestUrl.searchParams.get("offset") ?? 0);
      const limit = Number(requestUrl.searchParams.get("limit") ?? 100);
      return route.fulfill(
        json({
          ...detail,
          offset,
          limit,
          messages: detail.messages.slice(offset, offset + limit),
        })
      );
    }
  );

  await page.route(
    // The [importId] segment — everything except the fixed "capacity" and
    // "export" paths, which must not be shadowed by this one.
    (url) =>
      /^\/api\/imports\/external\/[^/]+$/.test(url.pathname) &&
      url.pathname !== "/api/imports/external/capacity" &&
      url.pathname !== "/api/imports/external/export",
    (route) => {
      if (route.request().method() === "DELETE") {
        state.deleteCount += 1;
        state.deleteUrls.push(route.request().url());
        return route.fulfill(
          json({ outcome: "deleted", memory: { derivedCount: 0 } })
        );
      }
      // §13.1 preview: only answered when the confirmation asks for it.
      if (new URL(route.request().url()).searchParams.get("include") === "memoryImpact") {
        state.memoryImpactReads += 1;
        return route.fulfill(
          json({
            ...(options.importDetail ?? {}),
            memoryImpact: options.memoryImpact ?? {
              derivedCount: 0,
              userTouchedCount: 0,
              keptCount: 0,
            },
          })
        );
      }
      if (options.importDetail) return route.fulfill(json(options.importDetail));
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Import not found." }) });
    }
  );

  return state;
}

/**
 * The settings modal lives inside AuthButton, which mounts with the sidebar.
 * On mobile the sidebar is a drawer, so the account-settings-open event has
 * no listener until the drawer has been opened once.
 */
const openAccountSettingsDataTab = async (page: Page) => {
  if ((page.viewportSize()?.width ?? 1920) < 768) {
    await page
      .getByRole("button", { name: /Open chat menu|대화 메뉴 열기/ })
      .click();
  }
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("tomverse:account-settings-open", { detail: "data" })
    );
  });
  await expect(
    page.getByRole("dialog", { name: /User Settings|사용자 설정/ })
  ).toBeVisible();
};

test.describe("external import settings", () => {
  test("walks the wizard end to end, skipping the duplicate the server reports", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    const api = await mockImportApi(page, {
      duplicateRawIds: ["qa-conv-1"],
    });

    // Step 1 — the export guide, not a bare file picker.
    await page.goto("/settings/imports/new");
    await expect(page.getByTestId("external-import-guide")).toBeVisible();
    await expect(
      page.getByTestId("external-import-step-indicator")
    ).toBeVisible();
    await page.getByTestId("external-import-guide-chatgpt").click();
    await page.getByTestId("external-import-guide-has-file").click();

    // Step 2 — the file is opened by the real Web Worker, in the browser.
    await expect(
      page.getByTestId("external-import-file-selection")
    ).toBeVisible();
    await page
      .getByTestId("external-import-file-input")
      .setInputFiles(chatgptExportFile(2));

    // Step 3 — both conversations arrive selectable and pre-selected.
    await expect(page.getByTestId("external-import-selection")).toBeVisible();
    const toggles = page.getByTestId("external-import-conversation-toggle");
    await expect(toggles).toHaveCount(2);
    await expect(toggles.nth(0)).toBeChecked();
    await expect(toggles.nth(1)).toBeChecked();
    await expect(page.getByText("QA imported conversation 0")).toBeVisible();
    // No transport vocabulary on the user-facing CTA.
    await expect(
      page.getByTestId("external-import-continue-to-review")
    ).not.toContainText(/upload|batch|staging|finalize/i);

    await page.getByTestId("external-import-continue-to-review").click();

    // Step 4 — one batch carried both; the server marked one duplicate, and
    // the client sealed its upload before the confirmation screen.
    await expect(page.getByTestId("external-import-review")).toBeVisible();
    expect(api.createCount).toBe(1);
    expect(api.batchBodies).toHaveLength(1);
    expect(api.batchBodies[0].sequence).toBe(0);
    expect(api.batchBodies[0].conversations).toHaveLength(2);
    expect(
      api.batchBodies[0].conversations[0].messages.map((m) => m.role)
    ).toEqual(["user", "assistant"]);
    expect(api.sealBodies).toHaveLength(1);
    expect(api.sealBodies[0].finalSequence).toBe(0);
    expect(api.sealBodies[0].expectedStagedConversationIds).toHaveLength(1);
    expect(api.sealBodies[0].expectedDuplicateCount).toBe(1);

    await page.getByTestId("external-import-finalize").click();
    await expect(page.getByTestId("external-import-completed")).toBeVisible();
    expect(api.finalizeBody?.selectedConversationIds).toHaveLength(1);
    expect(api.finalizeBody?.idempotencyKey).toBeTruthy();
    // A subset finalize sends a digest recomputed for the subset.
    expect(api.finalizeBody?.expectedImportDigest).toHaveLength(64);
    expect(api.finalizeBody?.expectedImportDigest).not.toBe("f".repeat(64));
  });

  test("the raw archive is never sent over the network", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await mockImportApi(page);

    const uploadedBodies: string[] = [];
    page.on("request", (request) => {
      const body = request.postData();
      if (body) uploadedBodies.push(body);
    });

    await page.goto("/settings/imports/new");
    await page.getByTestId("external-import-guide-has-file").click();
    await page
      .getByTestId("external-import-file-input")
      .setInputFiles(chatgptExportFile(2));
    await expect(page.getByTestId("external-import-selection")).toBeVisible();
    await page.getByTestId("external-import-continue-to-review").click();
    await expect(page.getByTestId("external-import-review")).toBeVisible();

    // Normalized text does go up; provider-internal structure never does.
    expect(uploadedBodies.some((body) => body.includes("Hello from QA 0"))).toBe(
      true
    );
    for (const body of uploadedBodies) {
      expect(body).not.toContain("current_node");
      expect(body).not.toContain("mapping");
    }
  });

  test("a guidance provider that disagrees with the file is a notice, not a failure", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await mockImportApi(page);

    await page.goto("/settings/imports/new");
    // The user says Claude; the file is a ChatGPT export.
    await page.getByTestId("external-import-guide-claude").click();
    await page.getByTestId("external-import-guide-has-file").click();
    await page
      .getByTestId("external-import-file-input")
      .setInputFiles(chatgptExportFile(1));

    await expect(page.getByTestId("external-import-selection")).toBeVisible();
    await expect(
      page.getByTestId("external-import-provider-mismatch")
    ).toContainText("ChatGPT");
    await expect(
      page.getByTestId("external-import-continue-to-review")
    ).toBeEnabled();
  });

  test("a network failure resends the same sequence; a quota refusal does not", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    const api = await mockImportApi(page, {
      failBatchAt: { sequence: 0, code: null, status: 0 },
    });

    await page.goto("/settings/imports/new");
    await page.getByTestId("external-import-guide-has-file").click();
    await page
      .getByTestId("external-import-file-input")
      .setInputFiles(chatgptExportFile(2));
    await expect(page.getByTestId("external-import-selection")).toBeVisible();
    await page.getByTestId("external-import-continue-to-review").click();

    // Transport failure: a retry of the same sequence is offered.
    await expect(
      page.getByTestId("external-import-upload-failed")
    ).toBeVisible();
    const retry = page.getByTestId("external-import-retry-upload");
    await expect(retry).toBeVisible();

    // Let the retry through and confirm it resent sequence 0 exactly once.
    await page.unrouteAll({ behavior: "ignoreErrors" });
    const retriedApi = await mockImportApi(page);
    await retry.click();
    await expect(page.getByTestId("external-import-review")).toBeVisible();
    expect(retriedApi.batchBodies.map((body) => body.sequence)).toEqual([0]);
    expect(api.batchBodies).toHaveLength(0);
  });

  test("an upload quota refusal offers a smaller selection, never the same retry", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await mockImportApi(page, {
      failBatchAt: {
        sequence: 0,
        code: "EXTERNAL_IMPORT_QUOTA_EXCEEDED",
        status: 409,
      },
    });

    await page.goto("/settings/imports/new");
    await page.getByTestId("external-import-guide-has-file").click();
    await page
      .getByTestId("external-import-file-input")
      .setInputFiles(chatgptExportFile(2));
    await expect(page.getByTestId("external-import-selection")).toBeVisible();
    await page.getByTestId("external-import-continue-to-review").click();

    await expect(
      page.getByTestId("external-import-quota-revision")
    ).toBeVisible();
    // No "retry the same payload" affordance exists on this path.
    await expect(
      page.getByTestId("external-import-retry-upload")
    ).toHaveCount(0);
    // Nothing was accepted, so this is not a restart: the same import can
    // carry a reduced selection.
    await expect(
      page.getByTestId("external-import-quota-restart-notice")
    ).toHaveCount(0);
    // The list is still there to narrow.
    await expect(
      page.getByTestId("external-import-conversation-toggle")
    ).toHaveCount(2);
  });

  test("a finalize quota refusal returns to the confirmation screen with the staged set intact", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    const api = await mockImportApi(page, {
      failFinalize: {
        code: "EXTERNAL_IMPORT_QUOTA_EXCEEDED",
        status: 409,
        times: 1,
      },
    });

    await page.goto("/settings/imports/new");
    await page.getByTestId("external-import-guide-has-file").click();
    await page
      .getByTestId("external-import-file-input")
      .setInputFiles(chatgptExportFile(2));
    await expect(page.getByTestId("external-import-selection")).toBeVisible();
    await page.getByTestId("external-import-continue-to-review").click();
    await expect(page.getByTestId("external-import-review")).toBeVisible();

    await page.getByTestId("external-import-finalize").click();
    await expect(
      page.getByTestId("external-import-quota-revision")
    ).toBeVisible();
    const reviewToggles = page.getByTestId("external-import-review-toggle");
    await expect(reviewToggles).toHaveCount(2);

    // Narrow the staged subset and finalize again — no re-upload happens.
    const batchesBefore = api.batchBodies.length;
    await reviewToggles.nth(1).uncheck();
    await page.getByTestId("external-import-finalize").click();
    await expect(page.getByTestId("external-import-completed")).toBeVisible();
    expect(api.batchBodies).toHaveLength(batchesBefore);
    expect(api.finalizeBody?.selectedConversationIds).toHaveLength(1);
  });

  test("a file that is not a supported export reaches the failure state, not a hang", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await mockImportApi(page);

    await page.goto("/settings/imports/new");
    await page.getByTestId("external-import-guide-has-file").click();
    await page.getByTestId("external-import-file-input").setInputFiles({
      name: "conversations.json",
      mimeType: "application/json",
      buffer: Buffer.from("this is not an export", "utf8"),
    });
    await expect(
      page.getByTestId("external-import-parse-failed")
    ).toBeVisible();
    // The worker's raw reason is a diagnostic, not the default message.
    await expect(
      page.getByTestId("external-import-diagnostics")
    ).toHaveCount(0);
    await page.getByTestId("external-import-diagnostics-toggle").click();
    await expect(
      page.getByTestId("external-import-diagnostics")
    ).toBeVisible();
  });

  test("an HTML export is told how to fix it, not that it is unreadable", { tag: "@ui-risk" }, async ({
    page,
  }) => {
    // A2 §6. Takeout offers My Activity as JSON or HTML, and only JSON is
    // supported. This is the one failure the user can fix in a minute, so it
    // must not arrive as the generic "could not read this file" -- and the
    // file has to be selectable in the first place, or the guidance is
    // unreachable.
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await mockImportApi(page);

    await page.goto("/settings/imports/new");
    await page.getByTestId("external-import-guide-has-file").click();

    const accept = await page
      .getByTestId("external-import-file-input")
      .getAttribute("accept");
    expect(accept).toContain(".html");

    await page.getByTestId("external-import-file-input").setInputFiles({
      name: "내활동.html",
      mimeType: "text/html",
      buffer: Buffer.from("<html><body><div>activity</div></body></html>", "utf8"),
    });

    const panel = page.getByTestId("external-import-parse-failed");
    await expect(panel).toBeVisible();
    // The Korean copy names the fix: re-export My Activity as JSON.
    await expect(panel).toContainText("JSON");
    await page.getByTestId("external-import-diagnostics-toggle").click();
    await expect(page.getByTestId("external-import-diagnostics")).toHaveText(
      "html_export_unsupported"
    );
  });

  test("a disabled rollout closes the wizard fail-closed but keeps history and delete reachable", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    const api = await mockImportApi(page, {
      disabled: true,
      history: [
        {
          id: "qa-import-old",
          provider: "chatgpt",
          status: "completed",
          failureCode: null,
          conversationCount: 4,
          messageCount: 40,
          normalizedBytes: 2048,
          truncationCount: 0,
          duplicateCount: 1,
          createdAt: "2026-07-30T00:00:00.000Z",
          completedAt: "2026-07-30T00:01:00.000Z",
        },
      ],
    });

    await page.goto("/settings/imports");
    await expect(page.getByTestId("external-import-disabled")).toBeVisible();
    await expect(
      page.getByTestId("external-import-file-input")
    ).toHaveCount(0);

    // Rollback contract (§15): already-imported data stays deletable.
    const row = page.getByTestId("external-import-history-row");
    await expect(row).toHaveCount(1);
    const deleteButton = page.getByTestId("external-import-history-delete");
    await deleteButton.click(); // arm
    await deleteButton.click(); // confirm
    await expect.poll(() => api.deleteCount).toBe(1);
  });

  test("the Data tab offers the entry point when the API allows it", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await mockImportApi(page);

    await page.goto("/chat");
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await openAccountSettingsDataTab(page);

    const entry = page.getByTestId("external-import-entry");
    await expect(entry).toBeVisible();
    const link = page.getByTestId("external-import-entry-link");
    await expect(link).toHaveAttribute("href", "/settings/imports");
    await link.click();
    await expect(page).toHaveURL(/\/settings\/imports$/);
    await expect(page.getByTestId("external-import-capacity")).toBeVisible();
    await expect(page.getByTestId("external-import-new")).toHaveAttribute(
      "href",
      "/settings/imports/new"
    );
  });

  test("the Data tab hides the entry point when the rollout is disabled", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await mockImportApi(page, { disabled: true });

    await page.goto("/chat");
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await openAccountSettingsDataTab(page);

    // The guest-import section (a different feature) may render; the external
    // entry must not. The dialog assertion above proves the tab painted.
    await expect(page.getByTestId("external-import-entry")).toHaveCount(0);
  });

  test("the conversation list groups lineage snapshots and offers the export download", async ({
    page,
  }) => {
    const row = (
      id: string,
      externalStableId: string,
      importedAt: string
    ): ViewerConversationRow => ({
      id,
      importId: "qa-import-1",
      provider: "chatgpt",
      title: `QA lineage ${id}`,
      externalStableId,
      messageCount: 2,
      contentBytes: 128,
      sourceCreatedAt: null,
      sourceUpdatedAt: null,
      importedAt,
    });
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    const api = await mockImportApi(page, {
      viewerConversations: [
        row("snap-new", "lineage-a", "2026-08-01T00:00:00.000Z"),
        row("snap-old", "lineage-a", "2026-07-01T00:00:00.000Z"),
        row("solo", "lineage-b", "2026-07-15T00:00:00.000Z"),
      ],
    });

    await page.goto("/settings/imports");
    const section = page.getByTestId("external-import-conversations");
    await expect(section).toBeVisible();

    // Two lineages render, not three rows: the older snapshot of lineage-a
    // sits behind the disclosure (§4.2).
    await expect(page.getByTestId("external-import-lineage")).toHaveCount(2);
    await expect(
      page.getByTestId("external-import-conversation-link")
    ).toHaveCount(2);
    const toggle = page.getByTestId("external-import-lineage-toggle");
    await expect(toggle).toHaveCount(1);
    await toggle.click();
    await expect(
      page.getByTestId("external-import-conversation-link")
    ).toHaveCount(3);

    const download = page.waitForEvent("download");
    await page.getByTestId("external-import-export").click();
    await download;
    expect(api.exportCount).toBe(1);
  });

  test("the viewer renders imported content inertly, pages messages, and deletes a snapshot", async ({
    page,
  }) => {
    const hostileContent =
      '<script>window.__qaXss = true;</script><img src="x" onerror="window.__qaXss = true"> stored as text';
    const messages: ViewerDetail["messages"] = Array.from(
      { length: 120 },
      (_, index) => ({
        id: `msg-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        ordinal: index,
        content: index === 0 ? hostileContent : `message body ${index}`,
        sourceModelLabel: index % 2 === 1 ? "gpt-qa-model" : null,
        sourceTimestamp: null,
        truncated: index === 1,
        originalCharacterCount: index === 1 ? 200_000 : null,
        retainedCharacterCount: index === 1 ? 100_000 : null,
      })
    );
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    const api = await mockImportApi(page, {
      viewerDetail: {
        id: "qa-conversation-1",
        importId: "qa-import-1",
        provider: "chatgpt",
        title: "QA viewer conversation",
        externalStableId: "lineage-a",
        sourceModelLabels: ["gpt-qa-model"],
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        importedAt: "2026-08-01T00:00:00.000Z",
        messageTotal: 120,
        messages,
      },
    });

    await page.goto("/settings/imports/conversations/qa-conversation-1");
    await expect(
      page.getByTestId("external-conversation-viewer")
    ).toBeVisible();

    // §19 viewer XSS contract: the stored markup appears as literal text and
    // never executes or becomes elements.
    const firstMessage = page.getByTestId("external-viewer-message").first();
    await expect(firstMessage).toContainText("<script>");
    await expect(firstMessage).toContainText("stored as text");
    await expect(firstMessage.locator("script")).toHaveCount(0);
    await expect(firstMessage.locator("img")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as { __qaXss?: boolean }).__qaXss
      )
    ).toBeUndefined();

    // The truncated message carries its notice.
    await expect(
      page.getByTestId("external-viewer-message").nth(1)
    ).toContainText(/줄여서|shortened/);

    // Paging: 100 messages first, the rest after "show more".
    await expect(page.getByTestId("external-viewer-message")).toHaveCount(100);
    await page.getByTestId("external-viewer-more").click();
    await expect(page.getByTestId("external-viewer-message")).toHaveCount(120);
    await expect(page.getByTestId("external-viewer-more")).toHaveCount(0);

    // Snapshot deletion is a two-step arm, then returns to the imports page.
    const deleteButton = page.getByTestId("external-viewer-delete");
    await deleteButton.click();
    await deleteButton.click();
    await expect.poll(() => api.snapshotDeleteCount).toBe(1);
    await expect(page).toHaveURL(/\/settings\/imports$/);
  });
  test("truncation is approved per conversation, and a hard-limit conversation is excluded whole", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await mockImportApi(page);

    // One normal conversation, one just over the 100k storage cap (shortened
    // with consent), one past the 1M inbound cap (excluded entirely, §5.3).
    const oversized = (index: number, length: number) => {
      const conversation = chatgptConversation(index);
      conversation.mapping["node-1"].message.content.parts = ["x".repeat(length)];
      return conversation;
    };
    await page.getByTestId; // keep the import of chatgptConversation honest
    await page.goto("/settings/imports/new");
    await page.getByTestId("external-import-guide-has-file").click();
    await page.getByTestId("external-import-file-input").setInputFiles({
      name: "conversations.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify([
          chatgptConversation(0),
          oversized(1, 100_500),
          oversized(2, 1_000_500),
        ]),
        "utf8"
      ),
    });

    await expect(page.getByTestId("external-import-selection")).toBeVisible();
    const toggles = page.getByTestId("external-import-conversation-toggle");
    await expect(toggles).toHaveCount(3);

    // Only the normal conversation starts selected.
    await expect(toggles.nth(0)).toBeChecked();
    await expect(toggles.nth(1)).not.toBeChecked();
    await expect(toggles.nth(2)).not.toBeChecked();
    await expect(toggles.nth(1)).toBeDisabled();
    await expect(toggles.nth(2)).toBeDisabled();

    // The excluded conversation says the whole conversation is dropped.
    await expect(
      page.getByTestId("external-import-row-blocked-reason")
    ).toHaveCount(1);

    // Consent on the shortened conversation selects exactly that one.
    const consent = page.getByTestId("external-import-row-truncation-consent");
    await expect(consent).toHaveCount(1);
    await consent.check();
    await expect(toggles.nth(1)).toBeChecked();
    await expect(toggles.nth(2)).not.toBeChecked();

    // Withdrawing consent removes it from the selection again.
    await consent.uncheck();
    await expect(toggles.nth(1)).not.toBeChecked();
    await expect(toggles.nth(1)).toBeDisabled();
  });

  test("select-all covers the filtered dataset and off-screen selections are announced", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await mockImportApi(page);

    await page.goto("/settings/imports/new");
    await page.getByTestId("external-import-guide-has-file").click();
    await page
      .getByTestId("external-import-file-input")
      .setInputFiles(chatgptExportFile(400));

    await expect(page.getByTestId("external-import-selection")).toBeVisible();
    // The list is windowed: far fewer rows are mounted than exist.
    const mounted = await page
      .getByTestId("external-import-conversation-row")
      .count();
    expect(mounted).toBeLessThan(400);
    await expect(
      page.getByTestId("external-import-selection-summary")
    ).toContainText("400");

    // Filtering to one conversation keeps the other 399 selected and says so.
    await page
      .getByTestId("external-import-search")
      .fill("QA imported conversation 7");
    await expect(
      page.getByTestId("external-import-hidden-selection")
    ).toBeVisible();

    // Clearing the filter restores the full view with the selection intact.
    await page.getByTestId("external-import-filter-clear").click();
    await expect(
      page.getByTestId("external-import-hidden-selection")
    ).toHaveCount(0);
    await expect(
      page.getByTestId("external-import-selection-summary")
    ).toContainText("400");
  });

  test("keyboard focus survives scrolling the virtualized list", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await mockImportApi(page);

    await page.goto("/settings/imports/new");
    await page.getByTestId("external-import-guide-has-file").click();
    await page
      .getByTestId("external-import-file-input")
      .setInputFiles(chatgptExportFile(400));
    await expect(page.getByTestId("external-import-selection")).toBeVisible();

    const firstToggle = page
      .getByTestId("external-import-conversation-toggle")
      .first();
    await firstToggle.focus();
    await expect(firstToggle).toBeFocused();

    await page
      .getByTestId("external-import-conversation-list")
      .evaluate((element) => {
        element.scrollTop = 6000;
      });
    // The focused row is pinned into the render window, so focus is still on
    // a real element rather than having fallen back to the document body.
    const focusedTag = await page.evaluate(
      () => document.activeElement?.tagName ?? ""
    );
    expect(focusedTag).toBe("INPUT");
  });

  test("the step indicator is progress, not navigation", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await mockImportApi(page);

    await page.goto("/settings/imports/new");
    const indicator = page.getByTestId("external-import-step-indicator");
    await expect(indicator).toBeVisible();
    // An ordered list of list items — no buttons, no links.
    expect(await indicator.evaluate((element) => element.tagName)).toBe("OL");
    await expect(indicator.locator("button")).toHaveCount(0);
    await expect(indicator.locator("a")).toHaveCount(0);
    await expect(indicator.locator('[aria-current="step"]')).toHaveCount(1);

    await page.getByTestId("external-import-guide-has-file").click();
    await page
      .getByTestId("external-import-file-input")
      .setInputFiles(chatgptExportFile(1));
    await expect(page.getByTestId("external-import-selection")).toBeVisible();
    // "Step 3 of 5, Choose conversations" is what a screen reader gets.
    await expect(
      indicator.locator('[data-step="select_conversations"]')
    ).toHaveAttribute("aria-label", /3.*5|5.*3/);

    // Stepping back is a real button in the body, not a step chip.
    await page.getByTestId("external-import-back-step").first().click();
    await expect(
      page.getByTestId("external-import-file-selection")
    ).toBeVisible();
  });

  test("the management screen resumes only sealed work", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await mockImportApi(page, {
      history: [
        {
          id: "qa-sealed",
          provider: "chatgpt",
          status: "preview_ready",
          failureCode: null,
          conversationCount: 3,
          messageCount: 12,
          normalizedBytes: 512,
          truncationCount: 0,
          duplicateCount: 0,
          createdAt: "2026-08-03T00:00:00.000Z",
          completedAt: null,
          expiresAt: "2026-08-04T00:00:00.000Z",
          expired: false,
          resumable: true,
        },
        {
          id: "qa-partial",
          provider: "claude",
          status: "staging",
          failureCode: null,
          conversationCount: 1,
          messageCount: 4,
          normalizedBytes: 128,
          truncationCount: 0,
          duplicateCount: 0,
          createdAt: "2026-08-03T00:00:00.000Z",
          completedAt: null,
          expiresAt: "2026-08-04T00:00:00.000Z",
          expired: false,
          resumable: false,
        },
        {
          id: "qa-expired",
          provider: "chatgpt",
          status: "preview_ready",
          failureCode: null,
          conversationCount: 2,
          messageCount: 8,
          normalizedBytes: 256,
          truncationCount: 0,
          duplicateCount: 0,
          createdAt: "2026-07-28T00:00:00.000Z",
          completedAt: null,
          expiresAt: "2026-07-31T00:00:00.000Z",
          expired: true,
          resumable: false,
        },
      ],
    });

    await page.goto("/settings/imports");
    const cards = page.getByTestId("external-import-in-progress-card");
    await expect(cards).toHaveCount(3);

    // Only the sealed, unexpired run offers to be finished.
    await expect(page.getByTestId("external-import-resume")).toHaveCount(1);
    await expect(
      cards.filter({ has: page.getByTestId("external-import-resume") })
    ).toHaveAttribute("data-resumable", "true");

    // The partial upload says so instead of pretending it can continue.
    await expect(
      page.getByTestId("external-import-not-resumable")
    ).toHaveCount(1);

    // Expired work is shown as expired, not hidden.
    await expect(page.getByTestId("external-import-expired-card")).toHaveCount(
      1
    );

    // Nothing was persisted to browser storage to fake a resume.
    const stored = await page.evaluate(() => {
      const keys = [
        ...Object.keys(window.localStorage),
        ...Object.keys(window.sessionStorage),
      ];
      return keys.filter((key) => /import/i.test(key));
    });
    expect(stored).toEqual([]);
  });

  test("leaving the wizard with browser Back lands on the management screen", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await mockImportApi(page);

    await page.goto("/settings/imports");
    await page.getByTestId("external-import-new").click();
    await expect(page).toHaveURL(/\/settings\/imports\/new$/);

    await page.getByTestId("external-import-guide-has-file").click();
    await page
      .getByTestId("external-import-file-input")
      .setInputFiles(chatgptExportFile(2));
    await expect(page.getByTestId("external-import-selection")).toBeVisible();

    // The wizard pushed no history entries of its own, so one Back leaves it.
    await page.goBack();
    await expect(page).toHaveURL(/\/settings\/imports$/);
    // Nothing reached the server, so the management screen can say so.
    await expect(
      page.getByTestId("external-import-no-server-data")
    ).toBeVisible();
  });

  test("the wizard is usable at 320px", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await mockImportApi(page);

    await page.goto("/settings/imports/new");
    await page.getByTestId("external-import-guide-has-file").click();
    await page
      .getByTestId("external-import-file-input")
      .setInputFiles(chatgptExportFile(3));
    await expect(page.getByTestId("external-import-selection")).toBeVisible();

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(
      page.getByTestId("external-import-continue-to-review")
    ).toBeVisible();
  });

  test("the wizard renders in English as well as Korean", async ({ page }) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page);
    await mockImportApi(page);

    await page.goto("/settings/imports/new");
    await expect(page.getByTestId("external-import-guide")).toContainText(
      "export file"
    );
    await expect(
      page.getByTestId("external-import-guide-chatgpt")
    ).toContainText("ChatGPT");
  });
  test("a sealed import is finished from its detail page, as a subset", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    const api = await mockImportApi(page, {
      importDetail: {
        id: "qa-sealed",
        provider: "chatgpt",
        status: "preview_ready",
        counts: {
          conversations: 2,
          messages: 8,
          normalizedBytes: 2048,
          truncatedMessages: 1,
          duplicatesSkipped: 1,
        },
        createdAt: "2026-08-03T00:00:00.000Z",
        completedAt: null,
        effectiveExpiresAt: "2026-08-04T00:00:00.000Z",
        expired: false,
        conversations: [
          {
            id: "staged-1",
            title: "Sealed conversation one",
            conversationDigest: "a".repeat(64),
            messageCount: 4,
            contentBytes: 1024,
            truncatedMessageCount: 0,
            finalized: false,
            sourceUpdatedAt: null,
          },
          {
            id: "staged-2",
            title: "Sealed conversation two",
            conversationDigest: "b".repeat(64),
            messageCount: 4,
            contentBytes: 1024,
            truncatedMessageCount: 1,
            finalized: false,
            sourceUpdatedAt: null,
          },
        ],
      },
    });

    await page.goto("/settings/imports/qa-sealed");
    await expect(
      page.getByTestId("external-import-detail-resume")
    ).toBeVisible();

    // Seal fixed completeness, not selection: both staged rows are offered
    // and either can be dropped before saving.
    const toggles = page.getByTestId("external-import-review-toggle");
    await expect(toggles).toHaveCount(2);
    await expect(toggles.nth(0)).toBeChecked();
    await expect(toggles.nth(1)).toBeChecked();
    await expect(
      page.getByTestId("external-import-review-expiry")
    ).toBeVisible();

    await toggles.nth(1).uncheck();
    await page.getByTestId("external-import-finalize").click();

    await expect(
      page.getByTestId("external-import-detail-completed")
    ).toBeVisible();
    expect(api.finalizeBody?.selectedConversationIds).toEqual(["staged-1"]);
    // No re-upload happened, and the digest was recomputed for the subset
    // rather than replayed from the sealed set.
    expect(api.batchBodies).toHaveLength(0);
    expect(api.sealBodies).toHaveLength(0);
    expect(api.finalizeBody?.expectedImportDigest).toHaveLength(64);
    expect(api.finalizeBody?.expectedImportDigest).not.toBe("a".repeat(64));
  });

  test("a quota refusal on a resumed import keeps the staged set for a smaller retry", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    const api = await mockImportApi(page, {
      failFinalize: {
        code: "EXTERNAL_IMPORT_QUOTA_EXCEEDED",
        status: 409,
        times: 1,
      },
      importDetail: {
        id: "qa-sealed",
        provider: "chatgpt",
        status: "preview_ready",
        counts: {
          conversations: 2,
          messages: 8,
          normalizedBytes: 2048,
          truncatedMessages: 0,
          duplicatesSkipped: 0,
        },
        createdAt: "2026-08-03T00:00:00.000Z",
        completedAt: null,
        effectiveExpiresAt: "2026-08-04T00:00:00.000Z",
        expired: false,
        conversations: [
          {
            id: "staged-1",
            title: "Sealed conversation one",
            conversationDigest: "a".repeat(64),
            messageCount: 4,
            contentBytes: 1024,
            truncatedMessageCount: 0,
            finalized: false,
            sourceUpdatedAt: null,
          },
          {
            id: "staged-2",
            title: "Sealed conversation two",
            conversationDigest: "b".repeat(64),
            messageCount: 4,
            contentBytes: 1024,
            truncatedMessageCount: 0,
            finalized: false,
            sourceUpdatedAt: null,
          },
        ],
      },
    });

    await page.goto("/settings/imports/qa-sealed");
    await page.getByTestId("external-import-finalize").click();
    await expect(page.getByTestId("external-import-detail-quota")).toBeVisible();

    // The staged rows survive the refusal, so a narrowed retry needs no
    // re-upload.
    const toggles = page.getByTestId("external-import-review-toggle");
    await expect(toggles).toHaveCount(2);
    await toggles.nth(1).uncheck();
    await page.getByTestId("external-import-finalize").click();
    await expect(
      page.getByTestId("external-import-detail-completed")
    ).toBeVisible();
    expect(api.finalizeBody?.selectedConversationIds).toEqual(["staged-1"]);
    expect(api.batchBodies).toHaveLength(0);
  });

  test("an unsealed or expired import offers no confirmation on its detail page", async ({
    page,
  }) => {
    const base = {
      id: "qa-unfinished",
      provider: "claude",
      counts: {
        conversations: 1,
        messages: 4,
        normalizedBytes: 512,
        truncatedMessages: 0,
        duplicatesSkipped: 0,
      },
      createdAt: "2026-08-03T00:00:00.000Z",
      completedAt: null,
      conversations: [
        {
          id: "staged-1",
          title: "Partly uploaded",
          conversationDigest: "c".repeat(64),
          messageCount: 4,
          contentBytes: 512,
          truncatedMessageCount: 0,
          finalized: false,
          sourceUpdatedAt: null,
        },
      ],
    };

    // A partial upload nobody sealed: restart or delete, never "finish".
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await mockImportApi(page, {
      importDetail: {
        ...base,
        status: "staging",
        effectiveExpiresAt: "2026-08-04T00:00:00.000Z",
        expired: false,
      },
    });
    await page.goto("/settings/imports/qa-unfinished");
    await expect(
      page.getByTestId("external-import-detail-not-resumable")
    ).toBeVisible();
    await expect(page.getByTestId("external-import-finalize")).toHaveCount(0);
    await expect(
      page.getByTestId("external-import-detail-restart")
    ).toHaveAttribute("href", "/settings/imports/new");

    // A sealed import past its TTL is shown as expired, not resumable.
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await mockAuthenticatedApi(page);
    await mockImportApi(page, {
      importDetail: {
        ...base,
        status: "preview_ready",
        effectiveExpiresAt: "2026-08-01T00:00:00.000Z",
        expired: true,
      },
    });
    await page.goto("/settings/imports/qa-unfinished");
    await expect(
      page.getByTestId("external-import-detail-expired")
    ).toBeVisible();
    await expect(page.getByTestId("external-import-finalize")).toHaveCount(0);
  });

  test("the management screen's resume link opens the detail page", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await mockImportApi(page, {
      history: [
        {
          id: "qa-sealed",
          provider: "chatgpt",
          status: "preview_ready",
          failureCode: null,
          conversationCount: 1,
          messageCount: 4,
          normalizedBytes: 512,
          truncationCount: 0,
          duplicateCount: 0,
          createdAt: "2026-08-03T00:00:00.000Z",
          completedAt: null,
          expiresAt: "2026-08-04T00:00:00.000Z",
          expired: false,
          resumable: true,
        },
      ],
      importDetail: {
        id: "qa-sealed",
        provider: "chatgpt",
        status: "preview_ready",
        counts: {
          conversations: 1,
          messages: 4,
          normalizedBytes: 512,
          truncatedMessages: 0,
          duplicatesSkipped: 0,
        },
        createdAt: "2026-08-03T00:00:00.000Z",
        completedAt: null,
        effectiveExpiresAt: "2026-08-04T00:00:00.000Z",
        expired: false,
        conversations: [
          {
            id: "staged-1",
            title: "Sealed conversation",
            conversationDigest: "a".repeat(64),
            messageCount: 4,
            contentBytes: 512,
            truncatedMessageCount: 0,
            finalized: false,
            sourceUpdatedAt: null,
          },
        ],
      },
    });

    await page.goto("/settings/imports");
    await page.getByTestId("external-import-resume").click();
    await expect(page).toHaveURL(/\/settings\/imports\/qa-sealed$/);
    await expect(
      page.getByTestId("external-import-detail-resume")
    ).toBeVisible();
  });
});

test.describe("source deletion and account memory (§13.1)", () => {
  test("the delete confirmation states the memory impact and offers to keep it", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page);
    const api = await mockImportApi(page, {
      history: [
        {
          id: "imp-1",
          provider: "chatgpt",
          status: "completed",
          conversationCount: 2,
          messageCount: 10,
          normalizedBytes: 2048,
          duplicateCount: 0,
          truncationCount: 0,
          createdAt: "2026-07-30T00:00:00.000Z",
          completedAt: "2026-07-30T00:01:00.000Z",
        },
      ],
      memoryImpact: { derivedCount: 3, userTouchedCount: 1, keptCount: 2 },
    });

    await page.goto("/settings/imports");
    const deleteButton = page.getByTestId("external-import-history-delete");

    // Nothing is read until the delete is armed: the listing must not pay for
    // a preview nobody asked for.
    expect(api.memoryImpactReads).toBe(0);

    await deleteButton.click(); // arm
    await expect(page.getByTestId("source-deletion-memory-notice")).toBeVisible();
    await expect(page.getByTestId("source-deletion-derived")).toContainText("3");
    await expect(page.getByTestId("source-deletion-edited")).toContainText("1");
    await expect(page.getByTestId("source-deletion-kept")).toContainText("2");
    expect(api.memoryImpactReads).toBe(1);

    await deleteButton.click(); // confirm
    await expect.poll(() => api.deleteCount).toBe(1);
    expect(api.deleteUrls[0]).toContain("derivedMemories=delete");
  });

  test("keeping the memories sends suspend instead of delete", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page);
    const api = await mockImportApi(page, {
      history: [
        {
          id: "imp-1",
          provider: "chatgpt",
          status: "completed",
          conversationCount: 1,
          messageCount: 4,
          normalizedBytes: 1024,
          duplicateCount: 0,
          truncationCount: 0,
          createdAt: "2026-07-30T00:00:00.000Z",
          completedAt: "2026-07-30T00:01:00.000Z",
        },
      ],
      memoryImpact: { derivedCount: 2, userTouchedCount: 0, keptCount: 0 },
    });

    await page.goto("/settings/imports");
    const deleteButton = page.getByTestId("external-import-history-delete");
    await deleteButton.click();
    await page.getByTestId("source-deletion-keep-memories").check();
    await deleteButton.click();

    await expect.poll(() => api.deleteCount).toBe(1);
    expect(api.deleteUrls[0]).toContain("derivedMemories=suspend");
  });

  test("a source with no memories behind it shows no notice at all", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page);
    await mockImportApi(page, {
      history: [
        {
          id: "imp-1",
          provider: "chatgpt",
          status: "completed",
          conversationCount: 1,
          messageCount: 4,
          normalizedBytes: 1024,
          duplicateCount: 0,
          truncationCount: 0,
          createdAt: "2026-07-30T00:00:00.000Z",
          completedAt: "2026-07-30T00:01:00.000Z",
        },
      ],
      memoryImpact: { derivedCount: 0, userTouchedCount: 0, keptCount: 0 },
    });

    await page.goto("/settings/imports");
    await page.getByTestId("external-import-history-delete").click();
    // A notice reading "0 memories" is noise on the common path.
    await expect(
      page.getByTestId("source-deletion-memory-notice")
    ).toHaveCount(0);
  });
});
