import { test, expect, type Locator, type Page } from "@playwright/test";

import {
    mockAuthenticatedApi,
    prepareGuestPage,
} from "./support/app-fixtures";

/**
 * "Tomverse에서 이어가기" — the CTA in the read-only viewer, and the screen it
 * leads to (docs/policy/external-conversation-continuation.md §8).
 *
 * Everything here is mocked at the network edge rather than through the shared
 * authenticated fixture, for one reason: this feature's whole shape is *which
 * endpoint answers what*, and a fixture that already decides the conversation's
 * shape would be answering half the questions the spec is asking. The four
 * routes the screen talks to are declared in one place below, so a spec that
 * needs the source deleted changes one field rather than a fixture's options.
 *
 * The database is off in E2E, so the rollout flag reads as disabled
 * server-side. That is precisely why the CTA's refusal path is exercised by
 * fulfilling the create endpoint 403 -- the shape a disabled flag produces in
 * production -- and the success path by fulfilling it 201.
 */

const json = (body: unknown, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
});

const CONVERSATION_ID = "qa-continued-conversation";
const EXTERNAL_ID = "qa-external-conversation";

type SourceState =
    | { status: "available" }
    | { status: "deleted" }
    | { status: "locked" };

type TimelineOptions = {
    source?: SourceState;
    seedMessageCount?: number;
    truncatedMessageCount?: number;
};

const importedMessages = () => [
    {
        id: "ext-0",
        role: "user",
        ordinal: 0,
        content: "What did we decide about the migration?",
        sourceModelLabel: null,
        sourceTimestamp: "2026-07-01T00:00:00.000Z",
        truncated: false,
    },
    {
        id: "ext-1",
        role: "assistant",
        ordinal: 1,
        content: "You decided to expand first and contract later.",
        sourceModelLabel: "gpt-4-turbo",
        sourceTimestamp: "2026-07-01T00:00:10.000Z",
        truncated: true,
    },
];

/** The four endpoints the continuation screen and the viewer's CTA use. */
const mockContinuationApi = async (
    page: Page,
    options: TimelineOptions & {
        /** What POST .../continuations answers. */
        createStatus?: number;
        tomverseMessages?: { id: string; role: string; content: string }[];
    } = {}
) => {
    const state = {
        createBodies: [] as { idempotencyKey: string }[],
        savedMessages: [] as { id: string; role: string; content: string }[],
        chatRequests: 0,
        tomverseMessages: options.tomverseMessages ?? [],
    };
    const source = options.source ?? { status: "available" };

    await page.route("**/api/auth/session**", (route) =>
        route.fulfill(
            json({
                user: { id: "qa-user", email: "qa@tomverse.test", name: "QA" },
                expires: "2099-01-01T00:00:00.000Z",
            })
        )
    );

    // The read-only viewer's own endpoint, so the CTA can be reached.
    await page.route(
        `**/api/external-conversations/${EXTERNAL_ID}?*`,
        (route) =>
            route.fulfill(
                json({
                    id: EXTERNAL_ID,
                    importId: "qa-import",
                    provider: "chatgpt",
                    title: "An imported conversation",
                    externalStableId: "stable",
                    sourceModelLabels: ["gpt-4-turbo"],
                    sourceCreatedAt: null,
                    sourceUpdatedAt: null,
                    importedAt: "2026-07-02T00:00:00.000Z",
                    locked: false,
                    messageTotal: 2,
                    offset: 0,
                    limit: 100,
                    messages: importedMessages(),
                })
            )
    );

    await page.route(
        `**/api/external-conversations/${EXTERNAL_ID}/continuations`,
        async (route) => {
            state.createBodies.push(
                route.request().postDataJSON() as { idempotencyKey: string }
            );
            if ((options.createStatus ?? 201) !== 201) {
                await route.fulfill(
                    json(
                        {
                            error: "Continuing an imported conversation is not enabled.",
                            code: "EXTERNAL_CONTINUATION_DISABLED",
                        },
                        options.createStatus ?? 403
                    )
                );
                return;
            }
            await route.fulfill(
                json(
                    {
                        conversationId: CONVERSATION_ID,
                        idempotentReplay: false,
                        provider: "chatgpt",
                        seedMessageCount: 2,
                        seedTruncatedMessageCount: 1,
                        seedOmittedMessageCount: 0,
                        sourceMessageCount: 2,
                    },
                    201
                )
            );
        }
    );

    await page.route(
        `**/api/conversations/${CONVERSATION_ID}/continuation*`,
        (route) =>
            route.fulfill(
                json({
                    conversationId: CONVERSATION_ID,
                    provider: "chatgpt",
                    importedAt: "2026-07-02T00:00:00.000Z",
                    contextSeedVersion: "ext-seed-v1",
                    seed: {
                        messageCount: options.seedMessageCount ?? 2,
                        truncatedMessageCount: options.truncatedMessageCount ?? 1,
                        omittedMessageCount: 0,
                        fromOrdinal: 0,
                        toOrdinal: 1,
                    },
                    source:
                        source.status === "available"
                            ? {
                                  status: "available",
                                  externalConversationId: EXTERNAL_ID,
                                  title: "An imported conversation",
                                  messageTotal: 2,
                                  offset: 0,
                                  limit: 100,
                                  messages: importedMessages(),
                              }
                            : source.status === "deleted"
                              ? {
                                    status: "deleted",
                                    deletedAt: "2026-08-01T00:00:00.000Z",
                                }
                              : { status: "locked" },
                })
            )
    );

    await page.route(
        `**/api/conversations/${CONVERSATION_ID}/messages`,
        async (route) => {
            const body = route.request().postDataJSON() as {
                messages: { id: string; role: string; content: string }[];
            };
            state.savedMessages.push(...body.messages);
            state.tomverseMessages = [...state.tomverseMessages, ...body.messages];
            await route.fulfill(json({ saved: body.messages.length }));
        }
    );

    // Matched before the bare conversation route below, because Playwright
    // hands a request to the most recently registered matching handler.
    await page.route(`**/api/conversations/${CONVERSATION_ID}`, (route) =>
        route.fulfill(
            json({
                id: CONVERSATION_ID,
                title: "Continued from an imported chat",
                kind: "chat",
                productKey: "chat",
                selectedModels: ["gpt-5-6-luna"],
                disabledPanels: [],
                webSearchMode: "off",
                memoryMode: "inherit",
                selectionMode: "manual",
                autoSelection: { offered: false },
                assistantProfile: null,
                isLocked: false,
                shareEnabled: false,
                shareExpiresAt: null,
                messages: state.tomverseMessages,
                messagePage: { hasMore: false, nextCursor: null },
            })
        )
    );

    await page.route("**/api/chat", async (route) => {
        state.chatRequests += 1;
        state.tomverseMessages = [
            ...state.tomverseMessages,
            {
                id: `assistant-${state.chatRequests}`,
                role: "assistant",
                content: "A Tomverse answer that continues the thread.",
            },
        ];
        await route.fulfill({
            status: 200,
            contentType: "text/plain; charset=utf-8",
            body: "A Tomverse answer that continues the thread.",
        });
    });

    return state;
};

/**
 * The conversation list, with each row's server-decided surface.
 *
 * Its own helper rather than a field on `mockContinuationApi`, because the
 * question it answers is different: that one is about the continuation screen,
 * this one is about how the sidebar gets there.
 */
const mockConversationList = async (
    page: Page,
    rows: { id: string; title: string; surface?: "workspace" | "continuation" }[]
) => {
    await page.route("**/api/conversations", (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        // A bare array, exactly as the route answers.
        return route.fulfill(
            json(
                rows.map((row) => ({
                    id: row.id,
                    title: row.title,
                    kind: "chat",
                    projectId: null,
                    selectedModels: ["gpt-5-6-luna"],
                    disabledPanels: [],
                    webSearchMode: "off",
                    isLocked: false,
                    shareEnabled: false,
                    shareExpiresAt: null,
                    messageCount: 2,
                    surface: row.surface ?? "workspace",
                }))
            )
        );
    });
};

/**
 * The sidebar is a drawer on the mobile shells and always visible on the
 * desktop ones, so a spec about *what a sidebar row does* has to open it first
 * on mobile. Identified by its test id, never by the brand string in its
 * accessible name -- that rename broke two specs on every commit to main once.
 */
const openConversationList = async (page: Page): Promise<Locator> => {
    const shell = page.getByTestId("mobile-chat-shell");
    // Wait for *a* shell before asking which one. `isVisible()` resolves
    // against the frame as it is right now, so probing before either has
    // mounted answers "not mobile" on a mobile project -- and the desktop
    // branch below then looks for a sidebar the mobile shell keeps in a
    // drawer. That is what made this flake in a full-file run and pass on its
    // own.
    await expect(shell.or(page.getByTestId("chat-sidebar"))).toBeVisible();
    if (!(await shell.isVisible())) return page.locator("body");
    // The conversation list is fetched after the first paint, so the entry
    // point appears late. Deciding which control to press before it arrives is
    // what made this flake: an `isVisible()` resolves against the frame as it
    // is right now, so the header fallback fired while the disclosure was
    // still on its way and the two raced for the drawer.
    //
    // `toBeVisible()` retries, so this waits for the control a mobile user
    // actually presses instead of guessing which one exists yet.
    // The disclosure, not the header button. On the mobile shell the drawer
    // withholds conversation *titles* until an explicit user action
    // (tests/e2e/mobile-recent-conversations.spec.ts fixes that as a privacy
    // property), so opening it any other way leaves rows this spec cannot
    // identify by name.
    const disclosure = page.getByTestId("recent-conversations-disclosure");
    await expect(disclosure).toBeVisible();
    await disclosure.click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    return drawer;
};

test.describe("continuing an imported conversation", () => {
    test("the viewer explains what happens before it creates anything", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        const api = await mockContinuationApi(page);

        await page.goto(`/settings/imports/conversations/${EXTERNAL_ID}`);
        await expect(page.getByTestId("external-conversation-viewer")).toBeVisible();

        const cta = page.getByTestId("continuation-cta");
        await expect(cta).toBeVisible();
        // Nothing has been created just by the CTA existing.
        expect(api.createBodies).toHaveLength(0);

        await cta.click();
        const disclosure = page.getByTestId("continuation-disclosure");
        await expect(disclosure).toBeVisible();
        // Five sentences, and still no request.
        await expect(disclosure.locator("li")).toHaveCount(5);
        expect(api.createBodies).toHaveLength(0);

        await page.getByTestId("continuation-confirm").click();
        await page.waitForURL(`**/continuations/${CONVERSATION_ID}`);
        expect(api.createBodies).toHaveLength(1);
        expect(api.createBodies[0].idempotencyKey).toMatch(
            /^[0-9a-f-]{36}$/i
        );
    });

    test("the flag being off is a refusal, not a retry", async ({ page }) => {
        await prepareGuestPage(page, "ko");
        const api = await mockContinuationApi(page, { createStatus: 403 });

        await page.goto(`/settings/imports/conversations/${EXTERNAL_ID}`);
        await page.getByTestId("continuation-cta").click();
        await page.getByTestId("continuation-confirm").click();

        await expect(page.getByTestId("continuation-cta-error")).toBeVisible();
        expect(api.createBodies).toHaveLength(1);
        // Still on the viewer: nothing was created, so nothing to navigate to.
        expect(page.url()).toContain("/settings/imports/conversations/");
    });

    test("imported turns and Tomverse turns are told apart on screen", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        await mockContinuationApi(page, {
            tomverseMessages: [
                { id: "m1", role: "user", content: "So what changed since?" },
                {
                    id: "m2",
                    role: "assistant",
                    content: "A Tomverse answer.",
                },
            ],
        });

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        await expect(
            page.getByTestId("continued-conversation-workspace")
        ).toBeVisible();

        // Two sections, and a divider that says where one ends.
        await expect(
            page.getByTestId("continuation-source-section")
        ).toBeVisible();
        await expect(page.getByTestId("continuation-divider")).toBeVisible();

        const imported = page.getByTestId("continuation-source-message");
        await expect(imported).toHaveCount(2);
        const own = page.getByTestId("continuation-message");
        await expect(own).toHaveCount(2);

        // The imported assistant answer is badged as somebody else's.
        await expect(
            page.getByTestId("continuation-external-badge")
        ).toHaveCount(1);
        // And a Tomverse answer carries no such badge.
        await expect(
            own.nth(1).getByTestId("continuation-external-badge")
        ).toHaveCount(0);

        // The provenance and the context disclosure are both stated.
        await expect(
            page.getByTestId("continuation-provenance")
        ).toBeVisible();
        await expect(
            page.getByTestId("continuation-seed-summary")
        ).toBeVisible();
    });

    test("the structure survives a reload", async ({ page }) => {
        await prepareGuestPage(page, "ko");
        await mockContinuationApi(page, {
            tomverseMessages: [
                { id: "m1", role: "user", content: "So what changed since?" },
            ],
        });

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        await expect(
            page.getByTestId("continuation-source-message")
        ).toHaveCount(2);

        await page.reload();
        await expect(
            page.getByTestId("continued-conversation-workspace")
        ).toBeVisible();
        await expect(
            page.getByTestId("continuation-source-message")
        ).toHaveCount(2);
        await expect(page.getByTestId("continuation-divider")).toBeVisible();
        await expect(page.getByTestId("continuation-message")).toHaveCount(1);
    });

    test("a message is saved before it is answered, and the answer is stored", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        const api = await mockContinuationApi(page);

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        await expect(
            page.getByTestId("continued-conversation-workspace")
        ).toBeVisible();

        await page
            .getByTestId("continuation-composer-textarea")
            .fill("Where did we leave off?");
        await page.getByTestId("continuation-send").click();

        await expect
            .poll(() => api.chatRequests, { timeout: 15_000 })
            .toBe(1);
        // The user's own message is a row before the provider is asked.
        expect(api.savedMessages).toHaveLength(1);
        expect(api.savedMessages[0].role).toBe("user");
        expect(api.savedMessages[0].content).toBe("Where did we leave off?");

        await expect(page.getByTestId("continuation-message")).toHaveCount(2);
    });

    test("a deleted source leaves a tombstone and the owner's messages", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        await mockContinuationApi(page, {
            source: { status: "deleted" },
            tomverseMessages: [
                { id: "m1", role: "user", content: "My own question." },
                { id: "m2", role: "assistant", content: "A Tomverse answer." },
            ],
        });

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        await expect(
            page.getByTestId("continuation-source-tombstone")
        ).toBeVisible();
        // No imported transcript is rendered any more.
        await expect(
            page.getByTestId("continuation-source-message")
        ).toHaveCount(0);
        // The owner's own messages are untouched.
        await expect(page.getByTestId("continuation-message")).toHaveCount(2);
        // And the composer is still there.
        await expect(
            page.getByTestId("continuation-composer-textarea")
        ).toBeVisible();
    });

    test("a locked source says so without hiding the conversation", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        await mockContinuationApi(page, {
            source: { status: "locked" },
            tomverseMessages: [
                { id: "m1", role: "user", content: "My own question." },
            ],
        });

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        await expect(
            page.getByTestId("continuation-source-locked")
        ).toBeVisible();
        await expect(
            page.getByTestId("continuation-source-message")
        ).toHaveCount(0);
        await expect(page.getByTestId("continuation-message")).toHaveCount(1);
    });

    test("the share limitation is stated on the screen itself", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        await mockContinuationApi(page);

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        await expect(
            page.getByTestId("continued-conversation-workspace")
        ).toBeVisible();
        // The sentence is rendered from the locale, so this asserts the copy
        // exists on screen rather than matching a specific translation.
        const banner = page.getByTestId("continued-conversation-workspace");
        await expect(banner).toContainText(/공유|share/i);
    });

    test("the sidebar reopens a continuation at its own surface", async ({
        page,
    }) => {
        // The defect this covers: a continuation opened correctly at creation
        // and, once the user left the screen, opened in the Review workspace
        // from the conversation list -- without the imported half it
        // continues.
        await prepareGuestPage(page, "ko");
        // The shared fixture first, for the signed-in identity and the
        // baseline routes; the list below then overrides the one route this
        // spec is actually about.
        await mockAuthenticatedApi(page);
        await mockContinuationApi(page);
        await mockConversationList(page, [
            {
                id: CONVERSATION_ID,
                title: "Continued from an imported chat",
                surface: "continuation",
            },
            { id: "qa-ordinary", title: "An ordinary conversation" },
        ]);

        await page.goto("/chat");
        const list = await openConversationList(page);
        await list
            .getByTestId("sidebar-conversation-item")
            .filter({ hasText: "Continued from an imported chat" })
            .last()
            .click();

        await page.waitForURL(`**/continuations/${CONVERSATION_ID}`);
        await expect(
            page.getByTestId("continuation-source-section")
        ).toBeVisible();
        await expect(page.getByTestId("continuation-divider")).toBeVisible();
    });

    test("an ordinary conversation still opens in the workspace", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        await mockAuthenticatedApi(page);
        await mockContinuationApi(page);
        await mockConversationList(page, [
            { id: "qa-ordinary", title: "An ordinary conversation" },
        ]);

        await page.goto("/chat");
        const list = await openConversationList(page);
        const row = list
            .getByTestId("sidebar-conversation-item")
            .filter({ hasText: "An ordinary conversation" })
            .last();
        await expect(row).toBeVisible();
        await row.click();

        // No navigation: the workspace selects the conversation in place,
        // exactly as it always has. Asserted on the URL rather than on the
        // row, because the mobile drawer closes on selection and the row it
        // was clicked on is gone by the time the workspace has it open.
        await expect(
            page.getByTestId("continued-conversation-workspace")
        ).toHaveCount(0);
        await expect(page).not.toHaveURL(/\/continuations\//);
    });

    test("at 320px the composer keeps its own row and nothing overflows", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 320, height: 720 });
        await prepareGuestPage(page, "ko");
        await mockContinuationApi(page);

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        const textarea = page.getByTestId("continuation-composer-textarea");
        await expect(textarea).toBeVisible();

        const textareaBox = await textarea.boundingBox();
        const sendBox = await page.getByTestId("continuation-send").boundingBox();
        expect(textareaBox).not.toBeNull();
        expect(sendBox).not.toBeNull();
        if (!textareaBox || !sendBox) return;

        // The send control is below the text row, never beside or over it.
        expect(sendBox.y).toBeGreaterThanOrEqual(
            textareaBox.y + textareaBox.height - 1
        );
        // And the text row has at least one full visible line.
        expect(textareaBox.height).toBeGreaterThanOrEqual(32);

        const overflow = await page.evaluate(
            () =>
                document.documentElement.scrollWidth -
                document.documentElement.clientWidth
        );
        expect(overflow).toBeLessThanOrEqual(1);
    });
});
