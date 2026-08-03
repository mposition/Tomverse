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
  } | null;
  deleteCount: number;
  historyReads: number;
};

async function mockImportApi(
  page: Page,
  options: {
    disabled?: boolean;
    history?: unknown[];
    /** Raw conversation IDs the batch endpoint reports as duplicates. */
    duplicateRawIds?: string[];
  } = {}
): Promise<ImportApiState> {
  const state: ImportApiState = {
    createCount: 0,
    batchBodies: [],
    finalizeBody: null,
    deleteCount: 0,
    historyReads: 0,
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
      state.finalizeBody = body;
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

  await page.route(
    // The [importId] segment — everything except the fixed "capacity" path,
    // which has its own route above and must not be shadowed by this one.
    (url) =>
      /^\/api\/imports\/external\/[^/]+$/.test(url.pathname) &&
      url.pathname !== "/api/imports/external/capacity",
    (route) => {
      if (route.request().method() === "DELETE") {
        state.deleteCount += 1;
        return route.fulfill(json({ outcome: "deleted" }));
      }
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
  test("imports a ChatGPT export end to end, skipping the duplicate the server reports", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    const api = await mockImportApi(page, {
      duplicateRawIds: ["qa-conv-1"],
    });

    await page.goto("/settings/imports");
    await expect(
      page.getByTestId("external-import-capacity")
    ).toBeVisible();

    await page
      .getByTestId("external-import-file-input")
      .setInputFiles(chatgptExportFile(2));

    // The preview is produced by the real Web Worker parsing the file in the
    // browser; both conversations arrive selectable and pre-selected.
    await expect(page.getByTestId("external-import-preview")).toBeVisible();
    const toggles = page.getByTestId("external-import-conversation-toggle");
    await expect(toggles).toHaveCount(2);
    await expect(toggles.nth(0)).toBeChecked();
    await expect(toggles.nth(1)).toBeChecked();
    await expect(
      page.getByText("QA imported conversation 0")
    ).toBeVisible();

    await page.getByTestId("external-import-start").click();

    // One batch carried both conversations; the server marked one duplicate.
    await expect(page.getByTestId("external-import-staged")).toBeVisible();
    expect(api.createCount).toBe(1);
    expect(api.batchBodies).toHaveLength(1);
    expect(api.batchBodies[0].sequence).toBe(0);
    expect(api.batchBodies[0].conversations).toHaveLength(2);
    expect(
      api.batchBodies[0].conversations[0].messages.map((m) => m.role)
    ).toEqual(["user", "assistant"]);

    await page.getByTestId("external-import-finalize").click();
    await expect(page.getByTestId("external-import-completed")).toBeVisible();
    expect(api.finalizeBody?.selectedConversationIds).toHaveLength(1);
    expect(api.finalizeBody?.idempotencyKey).toBeTruthy();
  });

  test("a file that is not a supported export reaches the failure state, not a hang", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await mockImportApi(page);

    await page.goto("/settings/imports");
    await page.getByTestId("external-import-file-input").setInputFiles({
      name: "conversations.json",
      mimeType: "application/json",
      buffer: Buffer.from("this is not an export", "utf8"),
    });
    await expect(
      page.getByTestId("external-import-parse-failed")
    ).toBeVisible();
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
    await expect(page.getByTestId("external-import-wizard")).toBeVisible();
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
});
