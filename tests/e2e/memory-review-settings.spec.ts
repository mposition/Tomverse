import { test, expect, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

/**
 * Release B memory review — /settings/memory and its Data-tab entry point
 * (docs/policy/external-conversation-import-and-memory.md §8, §21, slice B3).
 *
 * The database is off in E2E, so every memory endpoint is mocked. The mock
 * keeps a mutable row list and applies PATCH/DELETE/POST to it, which is what
 * lets the specs assert the UI's reload-after-mutation behaviour (a row
 * moving from the review queue to the in-use list) rather than just the
 * request bodies. The §15 split of authority is exercised directly: the list
 * and settings mocks never answer MEMORY_FEATURE_DISABLED, while the
 * disabled-flag spec serves it from the gated mutation routes only.
 */

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

type MemoryRow = {
  id: string;
  kind: string;
  statement: string;
  status: string;
  sensitivity: string;
  confidence: number;
  importance: number;
  pinned: boolean;
  conflictKey: string | null;
  revision: number;
  userEdited: boolean;
  expiresAt: string | null;
  suspendedReason: string | null;
  extractionModelId: string | null;
  promptVersion: string | null;
  createdAt: string;
  approvedAt: string | null;
  evidence: Array<{
    id: string;
    sourceType: string;
    manualContent: string | null;
    externalConversationId: string | null;
  }>;
};

const memoryRow = (
  id: string,
  overrides: Partial<MemoryRow> = {}
): MemoryRow => ({
  id,
  kind: "preference",
  statement: `QA memory statement ${id}`,
  status: "candidate",
  sensitivity: "standard",
  confidence: 0.9,
  importance: 0,
  pinned: false,
  conflictKey: null,
  revision: 1,
  userEdited: false,
  expiresAt: null,
  suspendedReason: null,
  extractionModelId: "gpt-5-6-luna",
  promptVersion: "mem-extract-v1",
  createdAt: "2026-08-01T00:00:00.000Z",
  approvedAt: null,
  evidence: [],
  ...overrides,
});

type MemoryApiState = {
  rows: MemoryRow[];
  listReads: number;
  settingsPuts: Array<Record<string, unknown>>;
  patches: Array<{ memoryId: string; body: Record<string, unknown> }>;
  deletes: string[];
  bulkApproveCalls: number;
  createBodies: Array<Record<string, unknown>>;
};

async function mockMemoryApi(
  page: Page,
  options: {
    rows?: MemoryRow[];
    /** GET /api/memories/settings answers 401 (signed-out probe). */
    unauthenticated?: boolean;
    /** Gated mutation routes answer 403 MEMORY_FEATURE_DISABLED. */
    mutationsDisabled?: boolean;
    /** The first approve PATCH per memory answers 409 MEMORY_ITEM_CONFLICT. */
    conflictOnFirstApprove?: boolean;
    bulkResult?: { approved: number; skipped: number };
  } = {}
): Promise<MemoryApiState> {
  const state: MemoryApiState = {
    rows: options.rows ?? [],
    listReads: 0,
    settingsPuts: [],
    patches: [],
    deletes: [],
    bulkApproveCalls: 0,
    createBodies: [],
  };
  const settings = {
    masterEnabled: true,
    styleEnabled: true,
    defaultConversationMode: "on" as string,
  };
  const disabledResponse = {
    status: 403,
    contentType: "application/json",
    body: JSON.stringify({
      error: "Memory features are not enabled.",
      code: "MEMORY_FEATURE_DISABLED",
    }),
  };
  const conflicted = new Set<string>();

  await page.route(
    (url) => url.pathname === "/api/memories/settings",
    (route) => {
      if (options.unauthenticated) {
        return route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "권한 없음" }),
        });
      }
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        state.settingsPuts.push(body);
        Object.assign(settings, body);
      }
      return route.fulfill(json(settings));
    }
  );

  await page.route(
    (url) => url.pathname === "/api/memories",
    (route) => {
      if (route.request().method() === "POST") {
        if (options.mutationsDisabled) return route.fulfill(disabledResponse);
        const body = route.request().postDataJSON() as Record<string, unknown>;
        state.createBodies.push(body);
        const id = `qa-created-${state.createBodies.length}`;
        state.rows.unshift(
          memoryRow(id, {
            kind: String(body.kind),
            statement: String(body.statement),
            status: "active",
            userEdited: true,
            approvedAt: "2026-08-03T00:00:00.000Z",
            evidence: [
              {
                id: `${id}-evidence`,
                sourceType: "manual",
                manualContent: String(body.groundsText),
                externalConversationId: null,
              },
            ],
          })
        );
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ memoryId: id }),
        });
      }
      state.listReads += 1;
      return route.fulfill(
        json({
          total: state.rows.length,
          offset: 0,
          limit: 100,
          memories: state.rows,
        })
      );
    }
  );

  await page.route(
    (url) => url.pathname === "/api/memories/bulk-approve",
    (route) => {
      if (options.mutationsDisabled) return route.fulfill(disabledResponse);
      state.bulkApproveCalls += 1;
      for (const row of state.rows) {
        if (row.status === "candidate" && row.sensitivity === "standard") {
          row.status = "active";
        }
      }
      return route.fulfill(
        json(options.bulkResult ?? { approved: 0, skipped: 0 })
      );
    }
  );

  // Registered last, so it would win over the fixed-path routes above —
  // the negative lookahead keeps settings/bulk-approve out of its reach.
  await page.route(
    (url) =>
      /^\/api\/memories\/(?!settings$|bulk-approve$)[^/]+$/.test(url.pathname),
    (route) => {
      const memoryId = route.request().url().split("/").pop() ?? "";
      const row = state.rows.find((candidate) => candidate.id === memoryId);
      if (route.request().method() === "DELETE") {
        state.deletes.push(memoryId);
        state.rows = state.rows.filter(
          (candidate) => candidate.id !== memoryId
        );
        return route.fulfill(json({ outcome: "deleted" }));
      }
      if (options.mutationsDisabled) return route.fulfill(disabledResponse);
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.patches.push({ memoryId, body });
      if (
        body.action === "approve" &&
        options.conflictOnFirstApprove &&
        !conflicted.has(memoryId) &&
        body.resolveConflict !== "supersede_existing"
      ) {
        conflicted.add(memoryId);
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Another active memory holds the same key.",
            code: "MEMORY_ITEM_CONFLICT",
          }),
        });
      }
      if (row) {
        if (body.action === "approve") {
          row.status = "active";
          row.approvedAt = "2026-08-03T00:00:00.000Z";
        } else if (body.action === "reject") {
          row.status = "rejected";
        } else if (body.action === "edit") {
          row.statement = String(body.statement ?? row.statement);
          row.revision += 1;
          if (row.status === "active") row.status = "manual_review_required";
        } else if (body.action === "pin" || body.action === "unpin") {
          row.pinned = body.action === "pin";
        }
      }
      return route.fulfill(json({ ok: true }));
    }
  );

  return state;
}

const openMemoryPage = async (page: Page) => {
  await page.goto("/settings/memory");
  await expect(page.getByTestId("memory-settings-card")).toBeVisible();
};

test.describe("memory review settings", () => {
  test("groups stored memories by review state and reflects the account toggles", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    const api = await mockMemoryApi(page, {
      rows: [
        memoryRow("cand-1", {
          evidence: [
            {
              id: "ev-1",
              sourceType: "external_message",
              manualContent: null,
              externalConversationId: "ext-conv-1",
            },
          ],
        }),
        memoryRow("review-1", {
          status: "manual_review_required",
          sensitivity: "sensitive",
          statement: "QA sensitive candidate",
        }),
        memoryRow("active-1", {
          status: "active",
          pinned: true,
          statement: "QA active pinned memory",
          approvedAt: "2026-08-02T00:00:00.000Z",
        }),
        memoryRow("old-1", {
          status: "rejected",
          statement: "QA rejected memory",
        }),
      ],
    });
    await openMemoryPage(page);

    await expect(page.getByTestId("memory-review-row")).toHaveCount(2);
    await expect(page.getByTestId("memory-individual-review-badge")).toBeVisible();
    await expect(page.getByTestId("memory-sensitive-badge")).toBeVisible();
    await expect(
      page.getByTestId("memory-evidence-source-link")
    ).toHaveAttribute("href", "/settings/imports/conversations/ext-conv-1");

    await expect(page.getByTestId("memory-active-row")).toHaveCount(1);
    await expect(page.getByTestId("memory-pinned-badge")).toBeVisible();
    await expect(page.getByTestId("memory-archived-row")).toHaveCount(1);
    await expect(page.getByTestId("memory-archived-row")).toContainText(
      "거절됨"
    );

    const master = page.getByTestId("memory-master-toggle");
    await expect(master).toBeChecked();
    await master.click();
    await expect
      .poll(() => api.settingsPuts.length, { timeout: 5_000 })
      .toBe(1);
    expect(api.settingsPuts[0]).toEqual({
      masterEnabled: false,
      styleEnabled: true,
      defaultConversationMode: "on",
    });
    await expect(master).not.toBeChecked();
  });

  test("approving a candidate re-fetches the list and moves it to the in-use group", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    const api = await mockMemoryApi(page, {
      rows: [memoryRow("cand-1", { statement: "QA approvable statement" })],
    });
    await openMemoryPage(page);

    await page.getByTestId("memory-approve").click();
    await expect(page.getByTestId("memory-review-empty")).toBeVisible();
    await expect(page.getByTestId("memory-active-row")).toContainText(
      "QA approvable statement"
    );
    expect(api.patches).toEqual([
      { memoryId: "cand-1", body: { action: "approve" } },
    ]);
  });

  test("a conflicting approval asks the user and only supersedes on explicit confirmation", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    const api = await mockMemoryApi(page, {
      rows: [memoryRow("cand-1")],
      conflictOnFirstApprove: true,
    });
    await openMemoryPage(page);

    await page.getByTestId("memory-approve").click();
    await expect(page.getByTestId("memory-conflict")).toBeVisible();
    expect(api.patches).toHaveLength(1);

    await page.getByTestId("memory-conflict-replace").click();
    await expect(page.getByTestId("memory-review-empty")).toBeVisible();
    expect(api.patches[1]).toEqual({
      memoryId: "cand-1",
      body: { action: "approve", resolveConflict: "supersede_existing" },
    });
  });

  test("rejecting a candidate archives it", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    const api = await mockMemoryApi(page, {
      rows: [memoryRow("cand-1")],
    });
    await openMemoryPage(page);

    await page.getByTestId("memory-reject").click();
    await expect(page.getByTestId("memory-review-empty")).toBeVisible();
    await expect(page.getByTestId("memory-archived-row")).toHaveCount(1);
    expect(api.patches).toEqual([
      { memoryId: "cand-1", body: { action: "reject" } },
    ]);
  });

  test("bulk approval reports the approved and skipped counts", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    const api = await mockMemoryApi(page, {
      rows: [
        memoryRow("cand-1"),
        memoryRow("cand-2", { statement: "QA second candidate" }),
        memoryRow("review-1", {
          status: "manual_review_required",
          sensitivity: "sensitive",
        }),
      ],
      bulkResult: { approved: 2, skipped: 1 },
    });
    await openMemoryPage(page);

    await page.getByTestId("memory-bulk-approve").click();
    await expect(page.getByTestId("memory-bulk-result")).toHaveText(
      "2개 승인됨 · 1개는 개별 검토가 필요합니다"
    );
    expect(api.bulkApproveCalls).toBe(1);
    // The sensitive candidate stays individually reviewable.
    await expect(page.getByTestId("memory-review-row")).toHaveCount(1);
    await expect(page.getByTestId("memory-active-row")).toHaveCount(2);
  });

  test("editing an active memory parks it back into review with a notice", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    const api = await mockMemoryApi(page, {
      rows: [
        memoryRow("active-1", {
          status: "active",
          statement: "QA active statement",
        }),
      ],
    });
    await openMemoryPage(page);

    await page.getByTestId("memory-edit").click();
    await page
      .getByTestId("memory-edit-statement")
      .fill("QA edited statement");
    await page.getByTestId("memory-edit-save").click();

    await expect(page.getByTestId("memory-edit-parked-notice")).toBeVisible();
    await expect(page.getByTestId("memory-review-row")).toContainText(
      "QA edited statement"
    );
    expect(api.patches).toEqual([
      {
        memoryId: "active-1",
        body: { action: "edit", statement: "QA edited statement" },
      },
    ]);
  });

  test("adding a memory manually posts the statement with its grounds", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    const api = await mockMemoryApi(page);
    await openMemoryPage(page);

    await page
      .getByTestId("memory-create-statement")
      .fill("사용자는 간결한 답변을 선호한다");
    await page
      .getByTestId("memory-create-grounds")
      .fill("설정 페이지에서 직접 입력함");
    await page.getByTestId("memory-create-submit").click();

    await expect(page.getByTestId("memory-create-success")).toBeVisible();
    expect(api.createBodies).toEqual([
      {
        kind: "preference",
        statement: "사용자는 간결한 답변을 선호한다",
        groundsText: "설정 페이지에서 직접 입력함",
      },
    ]);
    await expect(page.getByTestId("memory-active-row")).toContainText(
      "사용자는 간결한 답변을 선호한다"
    );
  });

  test("deleting a memory requires a second press and removes the row", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    const api = await mockMemoryApi(page, {
      rows: [memoryRow("active-1", { status: "active" })],
    });
    await openMemoryPage(page);

    const deleteButton = page.getByTestId("memory-delete");
    await deleteButton.click();
    expect(api.deletes).toHaveLength(0);
    await expect(deleteButton).toContainText("한 번 더 누르면 삭제됩니다");
    await deleteButton.click();
    await expect(page.getByTestId("memory-active-row")).toHaveCount(0);
    expect(api.deletes).toEqual(["active-1"]);
  });

  test("a disabled rollout keeps stored memories visible while closing review actions", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await mockMemoryApi(page, {
      rows: [memoryRow("cand-1"), memoryRow("active-1", { status: "active" })],
      mutationsDisabled: true,
    });
    await openMemoryPage(page);

    // The list is never flag-gated (§15): stored rows stay on screen.
    await expect(page.getByTestId("memory-review-row")).toHaveCount(1);
    await expect(page.getByTestId("memory-active-row")).toHaveCount(1);

    // The flag is discovered on the first gated call…
    await page.getByTestId("memory-approve").click();
    await expect(page.getByTestId("memory-disabled-banner")).toBeVisible();
    // …after which every gated control is closed, while delete stays live.
    await expect(page.getByTestId("memory-approve")).toBeDisabled();
    await expect(page.getByTestId("memory-bulk-approve")).toBeDisabled();
    await expect(page.getByTestId("memory-create-submit")).toBeDisabled();
    await expect(page.getByTestId("memory-delete").first()).toBeEnabled();
  });

  test("signed-out visitors are asked to sign in", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await mockMemoryApi(page, { unauthenticated: true });
    await page.goto("/settings/memory");
    await expect(page.getByTestId("memory-signin")).toBeVisible();
    await expect(page.getByTestId("memory-settings-card")).toHaveCount(0);
  });

  test("the Data tab offers the memory entry point", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await mockMemoryApi(page);

    await page.goto("/chat");
    await expect(page.getByTestId("chat-input")).toBeVisible();
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

    const link = page.getByTestId("memory-entry-link");
    await expect(link).toHaveAttribute("href", "/settings/memory");
    await link.click();
    await expect(page).toHaveURL(/\/settings\/memory$/);
    await expect(page.getByTestId("memory-settings-card")).toBeVisible();
  });
});
