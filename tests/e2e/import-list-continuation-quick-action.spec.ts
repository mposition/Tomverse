import { test, expect, type Page } from "@playwright/test";

import { prepareGuestPage } from "./support/app-fixtures";

/**
 * The trailing action on the imported-conversation list.
 *
 * Policy: docs/policy/external-conversation-continuation.md §6, §7, §8.
 * Resolver: lib/continuationQuickAction.ts (state table, unit-tested).
 *
 * Everything is mocked at the network edge, for the reason the continuation
 * spec beside this one gives: the feature's shape is *which endpoint answers
 * what*, and the assertions worth making are about the requests the list does
 * and does not send.
 */

const json = (body: unknown, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
});

const SOURCE_A = "qa-source-a";
const SOURCE_B = "qa-source-b";
const CREATED_ID = "qa-created-continuation";

type Row = {
    id: string;
    title: string;
    locked?: boolean;
    continuationCount?: number;
    latestContinuationId?: string | null;
    continuations?: {
        conversationId: string;
        title: string | null;
        createdAt: string;
    }[];
};

const listRow = (row: Row) => ({
    id: row.id,
    importId: "qa-import",
    provider: "chatgpt",
    title: row.title,
    externalStableId: `stable-${row.id}`,
    messageCount: 6,
    contentBytes: 1024,
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    importedAt: "2026-07-02T00:00:00.000Z",
    locked: row.locked ?? false,
    continuationCount: row.continuationCount ?? 0,
    latestContinuationId: row.latestContinuationId ?? null,
    continuations: row.continuations ?? [],
});

const mockImportsList = async (
    page: Page,
    options: {
        rows: Row[];
        continuationEnabled?: boolean;
        createStatus?: number;
        abortFirstCreate?: boolean;
    }
) => {
    const state = { createBodies: [] as { idempotencyKey: string }[] };

    await page.route("**/api/auth/session**", (route) =>
        route.fulfill(
            json({
                user: { id: "qa-user", email: "qa@tomverse.test", name: "QA" },
                expires: "2099-01-01T00:00:00.000Z",
            })
        )
    );
    // The shape the screen actually reads: limits/usage/remaining, not a flat
    // pair of byte counts. A capacity body it cannot parse leaves the whole
    // management view in its loading state and nothing below renders.
    await page.route("**/api/imports/external/capacity**", (route) =>
        route.fulfill(
            json({
                limits: {
                    maxNormalizedTextBytes: 50 * 1024 * 1024,
                    maxExternalConversations: 500,
                    maxExternalMessages: 50_000,
                },
                usage: {
                    normalizedTextBytes: 1024,
                    externalConversations: options.rows.length,
                    externalMessages: 6 * options.rows.length,
                },
                remaining: {
                    normalizedTextBytes: 50 * 1024 * 1024 - 1024,
                    maxExternalConversations: 500,
                    externalConversations: 500 - options.rows.length,
                    externalMessages: 50_000,
                },
            })
        )
    );
    await page.route("**/api/imports/external", (route) =>
        route.fulfill(json({ imports: [] }))
    );
    await page.route("**/api/external-conversations?*", (route) =>
        route.fulfill(
            json({
                total: options.rows.length,
                offset: 0,
                limit: 50,
                continuationEnabled: options.continuationEnabled ?? true,
                conversations: options.rows.map(listRow),
            })
        )
    );
    await page.route(
        "**/api/external-conversations/*/continuations",
        async (route) => {
            state.createBodies.push(
                route.request().postDataJSON() as { idempotencyKey: string }
            );
            if (options.abortFirstCreate && state.createBodies.length === 1) {
                await route.abort("connectionreset");
                return;
            }
            const status = options.createStatus ?? 201;
            if (status !== 201) {
                await route.fulfill(
                    json({ error: "refused", code: "REFUSED" }, status)
                );
                return;
            }
            await route.fulfill(
                json({ conversationId: CREATED_ID, idempotentReplay: false }, 201)
            );
        }
    );
    return state;
};

test.describe("continuation quick action in the imports list", () => {
    test("a source with no continuation creates one and opens it", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        const api = await mockImportsList(page, {
            rows: [{ id: SOURCE_A, title: "Migration plan review" }],
        });

        await page.goto("/settings/imports");
        const action = page.getByTestId("continuation-quick-action-create");
        await expect(action).toBeVisible();
        // Nothing is created by the action merely existing.
        expect(api.createBodies).toHaveLength(0);

        await action.click();
        await page.waitForURL(`**/continuations/${CREATED_ID}`);
        expect(api.createBodies).toHaveLength(1);
    });

    test("one existing continuation opens it without creating another", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        const api = await mockImportsList(page, {
            rows: [
                {
                    id: SOURCE_A,
                    title: "Migration plan review",
                    continuationCount: 1,
                    latestContinuationId: "qa-existing-1",
                    continuations: [
                        {
                            conversationId: "qa-existing-1",
                            title: "Continued once",
                            createdAt: "2026-08-01T00:00:00.000Z",
                        },
                    ],
                },
            ],
        });

        await page.goto("/settings/imports");
        await expect(
            page.getByTestId("continuation-quick-action-create")
        ).toHaveCount(0);
        await page.getByTestId("continuation-quick-action-open").click();
        await page.waitForURL("**/continuations/qa-existing-1");
        // The assertion this test exists for: opening is not creating.
        expect(api.createBodies).toHaveLength(0);
    });

    test("several continuations offer a choice and create nothing", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        const api = await mockImportsList(page, {
            rows: [
                {
                    id: SOURCE_A,
                    title: "Migration plan review",
                    continuationCount: 3,
                    latestContinuationId: "qa-existing-1",
                    continuations: [
                        {
                            conversationId: "qa-existing-1",
                            title: "First fork",
                            createdAt: "2026-08-03T00:00:00.000Z",
                        },
                        {
                            conversationId: "qa-existing-2",
                            title: "Second fork",
                            createdAt: "2026-08-02T00:00:00.000Z",
                        },
                        {
                            conversationId: "qa-existing-3",
                            title: null,
                            createdAt: "2026-08-01T00:00:00.000Z",
                        },
                    ],
                },
            ],
        });

        await page.goto("/settings/imports");
        const trigger = page.getByTestId(
            "continuation-quick-action-menu-trigger"
        );
        // The count is on the control itself, so the row says how many exist
        // before anything is opened.
        await expect(trigger).toContainText("3");
        await trigger.click();

        const menu = page.getByTestId("continuation-quick-action-menu");
        await expect(menu).toBeVisible();
        await expect(
            menu.getByTestId("continuation-quick-action-menu-item")
        ).toHaveCount(3);

        await menu
            .getByTestId("continuation-quick-action-menu-item")
            .nth(1)
            .click();
        await page.waitForURL("**/continuations/qa-existing-2");
        expect(api.createBodies).toHaveLength(0);
    });

    test("the menu closes on Escape and returns focus to its trigger", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        await mockImportsList(page, {
            rows: [
                {
                    id: SOURCE_A,
                    title: "Migration plan review",
                    continuationCount: 2,
                    latestContinuationId: "qa-existing-1",
                    continuations: [
                        {
                            conversationId: "qa-existing-1",
                            title: "First fork",
                            createdAt: "2026-08-02T00:00:00.000Z",
                        },
                        {
                            conversationId: "qa-existing-2",
                            title: "Second fork",
                            createdAt: "2026-08-01T00:00:00.000Z",
                        },
                    ],
                },
            ],
        });

        await page.goto("/settings/imports");
        const trigger = page.getByTestId(
            "continuation-quick-action-menu-trigger"
        );
        await trigger.click();
        await expect(
            page.getByTestId("continuation-quick-action-menu")
        ).toBeVisible();

        await page.keyboard.press("Escape");
        await expect(
            page.getByTestId("continuation-quick-action-menu")
        ).toHaveCount(0);
        // Focus back where it started: a menu that leaves focus on a removed
        // node is a keyboard dead end inside a list.
        await expect(trigger).toBeFocused();
    });

    test("the row body still opens the source, and the action does not", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        await mockImportsList(page, {
            rows: [{ id: SOURCE_A, title: "Migration plan review" }],
        });

        await page.goto("/settings/imports");
        await page.getByTestId("external-import-conversation-link").click();
        await page.waitForURL(
            `**/settings/imports/conversations/${SOURCE_A}`
        );
    });

    test("a locked source routes to its own page and posts nothing", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        const api = await mockImportsList(page, {
            rows: [{ id: SOURCE_B, title: "Locked source", locked: true }],
        });

        await page.goto("/settings/imports");
        await expect(
            page.getByTestId("continuation-quick-action-create")
        ).toHaveCount(0);
        await page.getByTestId("continuation-quick-action-locked").click();
        await page.waitForURL(
            `**/settings/imports/conversations/${SOURCE_B}`
        );
        // §6: the password belongs to the source's screen, and the create
        // endpoint is never reached from a locked row.
        expect(api.createBodies).toHaveLength(0);
    });

    test("the flag being off removes the action and leaves the list", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        await mockImportsList(page, {
            rows: [{ id: SOURCE_A, title: "Migration plan review" }],
            continuationEnabled: false,
        });

        await page.goto("/settings/imports");
        // The row is still there, still opens, still deletable from its page.
        await expect(
            page.getByTestId("external-import-conversation-link")
        ).toBeVisible();
        for (const testId of [
            "continuation-quick-action-create",
            "continuation-quick-action-open",
            "continuation-quick-action-menu-trigger",
            "continuation-quick-action-locked",
        ]) {
            await expect(page.getByTestId(testId)).toHaveCount(0);
        }
    });

    test("a double click creates one conversation, not two", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        const api = await mockImportsList(page, {
            rows: [{ id: SOURCE_A, title: "Migration plan review" }],
        });

        await page.goto("/settings/imports");
        const action = page.getByTestId("continuation-quick-action-create");
        await action.dblclick();
        await page.waitForURL(`**/continuations/${CREATED_ID}`);
        expect(api.createBodies).toHaveLength(1);
    });

    test("a retry after a lost response keeps the first attempt's key", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        const api = await mockImportsList(page, {
            rows: [{ id: SOURCE_A, title: "Migration plan review" }],
            abortFirstCreate: true,
        });

        await page.goto("/settings/imports");
        const action = page.getByTestId("continuation-quick-action-create");
        await action.click();
        await expect(
            page.getByTestId("continuation-quick-action-error")
        ).toBeVisible();
        expect(api.createBodies).toHaveLength(1);

        await action.click();
        await page.waitForURL(`**/continuations/${CREATED_ID}`);
        expect(api.createBodies).toHaveLength(2);
        // With two different keys the server is obliged to create a second
        // conversation, and it would be right to.
        expect(api.createBodies[1].idempotencyKey).toBe(
            api.createBodies[0].idempotencyKey
        );
    });

    test("one row's loading never disables another row's action", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        await mockImportsList(page, {
            rows: [
                { id: SOURCE_A, title: "First source" },
                { id: SOURCE_B, title: "Second source" },
            ],
            abortFirstCreate: true,
        });

        await page.goto("/settings/imports");
        const actions = page.getByTestId("continuation-quick-action-create");
        await expect(actions).toHaveCount(2);
        await actions.nth(0).click();
        await expect(
            page.getByTestId("continuation-quick-action-error")
        ).toBeVisible();
        // The other row is untouched: each launcher is its own.
        await expect(actions.nth(1)).toBeEnabled();
    });

    test("the action names its source and is reachable by keyboard", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        await mockImportsList(page, {
            rows: [{ id: SOURCE_A, title: "Migration plan review" }],
        });

        await page.goto("/settings/imports");
        const action = page.getByTestId("continuation-quick-action-create");
        // The accessible name carries the title, so a screen reader hearing
        // twenty of these can tell them apart.
        await expect(action).toHaveAttribute(
            "aria-label",
            /Migration plan review/
        );
        await action.focus();
        await expect(action).toBeFocused();
        await page.keyboard.press("Enter");
        await page.waitForURL(`**/continuations/${CREATED_ID}`);
    });

    test("at 320px the action keeps its size and nothing overflows", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 320, height: 720 });
        await prepareGuestPage(page, "ko");
        await mockImportsList(page, {
            rows: [
                {
                    id: SOURCE_A,
                    title: "A source with a deliberately very long imported title that must be truncated rather than pushing the action off screen",
                },
            ],
        });

        await page.goto("/settings/imports");
        const action = page.getByTestId("continuation-quick-action-create");
        await expect(action).toBeVisible();

        const box = await action.boundingBox();
        expect(box).not.toBeNull();
        // Text button, not an icon, and a real touch target.
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);

        const overflow = await page.evaluate(
            () =>
                document.documentElement.scrollWidth -
                document.documentElement.clientWidth
        );
        expect(overflow).toBeLessThanOrEqual(0);
    });
});
