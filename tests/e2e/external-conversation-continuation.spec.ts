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

/**
 * Two catalogue ids, used as the conversation's selected models.
 *
 * Real ids rather than invented ones: the composer resolves each to a name and
 * a credit weight through the model catalogue, and an id the catalogue does
 * not know would be rendered as a bare string and priced at nothing.
 */
/** The imported conversation's own name, as the fixtures report it. */
const SOURCE_CONVERSATION_TITLE = "An imported conversation";

const PRIMARY_MODEL = "gpt-5-6-luna";
const SECOND_MODEL = "gpt-5-4-mini";

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
        /**
         * Drops the connection on the first create only.
         *
         * Reproduces the one case the server's own idempotency cannot see: the
         * row was written and the *response* was lost, so the browser reports
         * a failure for a request that succeeded. Whether the retry sends the
         * same key is then the only thing standing between the user and two
         * conversations.
         */
        abortFirstCreate?: boolean;
        tomverseMessages?: {
            id: string;
            role: string;
            content: string;
            modelId?: string;
        }[];
        /**
         * What the conversation answers as its `selectedModels`.
         *
         * A continuation is a Review conversation
         * (docs/policy/external-conversation-continuation.md §3.1), so this is
         * one to three models and each of them answers every turn.
         */
        selectedModels?: string[];
    } = {}
) => {
    const selectedModels = options.selectedModels ?? [PRIMARY_MODEL];
    const state = {
        createBodies: [] as { idempotencyKey: string }[],
        savedMessages: [] as { id: string; role: string; content: string }[],
        chatRequests: 0,
        /** Every `/api/chat` body, so a spec can assert what each one carried. */
        chatBodies: [] as { modelId?: string; messages?: unknown }[],
        preflightBodies: [] as { modelIds?: string[] }[],
        selectedModels,
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
            // Recorded first, so the aborted attempt still shows the key it
            // sent -- which is the whole point of the comparison.
            if (options.abortFirstCreate && state.createBodies.length === 1) {
                await route.abort("connectionreset");
                return;
            }
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
                // §3.1: a continuation is a Review conversation.
                productKey: "review",
                selectedModels: state.selectedModels,
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

    // Registered before `**/api/chat` so it wins for the preflight path:
    // Playwright hands a request to the most recently registered handler.
    await page.route("**/api/chat/preflight", async (route) => {
        state.preflightBodies.push(
            route.request().postDataJSON() as { modelIds?: string[] }
        );
        await route.fulfill(
            json({ admissionToken: "qa-admission", contextBundle: null })
        );
    });

    await page.route("**/api/chat", async (route) => {
        const body = route.request().postDataJSON() as { modelId?: string };
        state.chatRequests += 1;
        state.chatBodies.push(body);
        state.tomverseMessages = [
            ...state.tomverseMessages,
            {
                id: `assistant-${state.chatRequests}`,
                role: "assistant",
                modelId: body.modelId,
                content: `A ${body.modelId} answer that continues the thread.`,
            },
        ];
        await route.fulfill({
            status: 200,
            contentType: "text/plain; charset=utf-8",
            body: `A ${body.modelId} answer that continues the thread.`,
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
    rows: {
        id: string;
        title: string;
        surface?: "workspace" | "continuation";
        /** What the list route sends for a row whose source it could read. */
        sourceTitle?: string;
    }[]
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
                    ...(row.sourceTitle === undefined
                        ? {}
                        : { sourceTitle: row.sourceTitle }),
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
    //
    // The disclosure only exists on the welcome screen, which is the state a
    // mobile shell with *no* conversation open renders. With one open --
    // `/continuations/[id]` always, and `/chat` after a selection -- the
    // header's own button is the control a user has, so this waits for either
    // and prefers the disclosure when both could be there.
    const disclosure = page.getByTestId("recent-conversations-disclosure");
    const headerButton = page.getByTestId("mobile-sidebar-open");
    await expect(disclosure.or(headerButton).first()).toBeVisible();
    if ((await disclosure.count()) > 0) {
        await disclosure.click();
    } else {
        await headerButton.click();
    }
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
        // Six sentences, and still no request. The sixth is the one this
        // feature's Review shape added: every selected model answers, and each
        // costs credits (docs/policy/external-conversation-continuation.md
        // §8.1).
        await expect(disclosure.locator("li")).toHaveCount(6);
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

    test("a retry after a lost response keeps the first attempt's key", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        const api = await mockContinuationApi(page, { abortFirstCreate: true });

        await page.goto(`/settings/imports/conversations/${EXTERNAL_ID}`);
        await page.getByTestId("continuation-cta").click();
        await page.getByTestId("continuation-confirm").click();

        // The connection died, so the browser knows nothing about the row the
        // server may already have written.
        await expect(page.getByTestId("continuation-cta-error")).toBeVisible();
        expect(api.createBodies).toHaveLength(1);
        // "Try again" comes back through the same CTA the idle card shows.
        await page.getByTestId("continuation-cta").click();
        await page.getByTestId("continuation-confirm").click();
        await page.waitForURL(`**/continuations/${CONVERSATION_ID}`);

        expect(api.createBodies).toHaveLength(2);
        // The assertion this test exists for. With two different keys the
        // server is obliged to create a second conversation, and it would be
        // right to -- so the duplicate has to be prevented here.
        expect(api.createBodies[1].idempotencyKey).toBe(
            api.createBodies[0].idempotencyKey
        );
    });

    test("cancelling and starting again is a new fork, with a new key", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        const api = await mockContinuationApi(page, { abortFirstCreate: true });

        await page.goto(`/settings/imports/conversations/${EXTERNAL_ID}`);
        await page.getByTestId("continuation-cta").click();
        await page.getByTestId("continuation-confirm").click();
        await expect(page.getByTestId("continuation-cta-error")).toBeVisible();

        // Arming again and backing out is the deliberate "no, start over" that
        // §3 allows -- and it is the only thing that may drop the key.
        await page.getByTestId("continuation-cta").click();
        await page.getByTestId("continuation-cancel").click();
        await expect(page.getByTestId("continuation-disclosure")).toBeHidden();

        await page.getByTestId("continuation-cta").click();
        await page.getByTestId("continuation-confirm").click();
        await page.waitForURL(`**/continuations/${CONVERSATION_ID}`);

        expect(api.createBodies).toHaveLength(2);
        expect(api.createBodies[1].idempotencyKey).not.toBe(
            api.createBodies[0].idempotencyKey
        );
    });

    /**
     * Everything a continuation screen needs, in the order the routes have to
     * be registered.
     *
     * Playwright hands a request to the most recently registered handler, so
     * the baseline chat fixture goes first, the continuation's own routes
     * override the two it shares, and the list -- which is what carries each
     * row's server-decided surface -- goes last.
     *
     * The list matters more than it looks: the workspace opens the URL's
     * conversation only if that id is in the account's loaded list, which is
     * the same check the tab-restore path has always made.
     */
    const openContinuation = async (
        page: Page,
        options: Parameters<typeof mockContinuationApi>[1] & {
            extraRows?: { id: string; title: string }[];
            /**
             * The row's stored title. The writer's placeholder by default,
             * which is what a continuation nobody has renamed actually holds.
             */
            listTitle?: string;
            /**
             * The imported conversation's own name, as the list route sends
             * it. Absent stands for a source that is deleted, locked or
             * unnamed -- three facts with one answer on screen.
             */
            sourceTitleForList?: string;
        } = {}
    ) => {
        const {
            extraRows = [],
            listTitle,
            sourceTitleForList,
            ...continuationOptions
        } = options;
        await mockAuthenticatedApi(page);
        const api = await mockContinuationApi(page, continuationOptions);
        await mockConversationList(page, [
            {
                id: CONVERSATION_ID,
                title: listTitle ?? "Continued from an imported chat",
                surface: "continuation",
                // The imported conversation's own name, which is what the
                // sidebar shows for a row still carrying the writer's
                // placeholder. Defaulted so every list assertion below reads
                // the name a real account would see.
                sourceTitle: sourceTitleForList ?? SOURCE_CONVERSATION_TITLE,
            },
            ...extraRows,
        ]);
        return api;
    };

    test("a continuation with no answers yet is not a blank new chat", async ({
        page,
    }) => {
        /*
          The defect: every panel reports `empty` -- truthfully, there is no
          native Message -- and the shell greeted the owner with "welcome
          back", offered them other recent conversations, and floated the
          composer in the middle of a screen that already had the imported
          conversation on it.
        */
        await prepareGuestPage(page, "ko");
        await openContinuation(page);

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        await expect(
            page.getByTestId("continuation-source-section")
        ).toBeVisible();

        // No welcome surface, and none of what it carries.
        await expect(page.getByTestId("chat-welcome-greeting")).toHaveCount(0);
        await expect(
            page.getByTestId("recent-conversations-disclosure")
        ).toHaveCount(0);

        // The composer sits below the conversation, not floating in the
        // middle of it: its top edge is under the divider.
        const dividerBox = await page
            .getByTestId("continuation-divider")
            .boundingBox();
        const inputBox = await page.getByTestId("chat-input").boundingBox();
        expect(dividerBox).not.toBeNull();
        expect(inputBox).not.toBeNull();
        if (!dividerBox || !inputBox) return;
        expect(inputBox.y).toBeGreaterThanOrEqual(dividerBox.y);
    });

    test("an ordinary empty conversation still gets its welcome screen", async ({
        page,
    }) => {
        // The other half of the same decision: nothing about the welcome
        // surface changed for a conversation that genuinely has nothing in it.
        await prepareGuestPage(page, "ko");
        await mockAuthenticatedApi(page);

        await page.goto("/chat");
        await expect(page.getByTestId("chat-welcome-greeting")).toBeVisible();
    });

    test("the imported transcript is open on arrival", async ({ page }) => {
        await prepareGuestPage(page, "ko");
        await openContinuation(page);

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        // Both fixture messages, with no press: a short imported conversation
        // is shown whole.
        await expect(
            page.getByTestId("continuation-source-message")
        ).toHaveCount(2);
        await expect(
            page.getByTestId("continuation-source-toggle")
        ).toHaveAttribute("aria-expanded", "true");
        // The provenance line and the message count are beside it.
        await expect(page.getByTestId("continuation-provenance")).toBeVisible();
        await expect(page.getByTestId("continuation-source-count")).toBeVisible();
    });

    test("the disclosure collapses and reopens from the keyboard", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        await openContinuation(page);

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        const toggle = page.getByTestId("continuation-source-toggle");
        await toggle.focus();
        await page.keyboard.press("Enter");
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        // Hidden, not removed: the panel keeps its identity so `aria-controls`
        // still points at something and reopening restores what was scrolled.
        await expect(
            page.getByTestId("continuation-source-message").first()
        ).toBeHidden();
        // Collapsed still says whose conversation this is and how big it is.
        await expect(page.getByTestId("continuation-provenance")).toBeVisible();
        await expect(page.getByTestId("continuation-source-count")).toBeVisible();
        // Focus is still on the control that was pressed.
        await expect(toggle).toBeFocused();

        await page.keyboard.press("Enter");
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await expect(
            page.getByTestId("continuation-source-message").first()
        ).toBeVisible();
    });

    test("the divider is a named separator, and survives a deleted source", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        await openContinuation(page, { source: { status: "deleted" } });

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        await expect(
            page.getByTestId("continuation-source-tombstone")
        ).toBeVisible();
        const divider = page.getByTestId("continuation-divider");
        await expect(divider).toBeVisible();
        await expect(divider).toHaveAttribute("role", "separator");
        // Nothing to press when there is nothing to show.
        await expect(
            page.getByTestId("continuation-source-toggle")
        ).toHaveCount(0);
        await expect(page.getByTestId("chat-input")).toBeVisible();
    });

    test("the sidebar shows the imported conversation's own name", async ({
        page,
    }) => {
        // Not `Continued from an imported chat`: that placeholder is the
        // writer's, and the name is resolved from the snapshot when displayed.
        await prepareGuestPage(page, "ko");
        await openContinuation(page, { sourceTitleForList: "Migration plan review" });

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        const list = await openConversationList(page);
        await expect(
            list
                .getByTestId("sidebar-conversation-item")
                .filter({ hasText: "Migration plan review" })
                .last()
        ).toBeVisible();
        await expect(
            list.getByTestId("sidebar-conversation-item").filter({
                hasText: "Continued from an imported chat",
            })
        ).toHaveCount(0);
    });

    test("a name the owner typed is left alone", async ({ page }) => {
        await prepareGuestPage(page, "ko");
        await openContinuation(page, {
            listTitle: "내가 붙인 이름",
            sourceTitleForList: "Migration plan review",
        });

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        const list = await openConversationList(page);
        await expect(
            list
                .getByTestId("sidebar-conversation-item")
                .filter({ hasText: "내가 붙인 이름" })
                .last()
        ).toBeVisible();
    });

    test("the continued conversation runs in the ordinary chat shell", async ({
        page,
    }) => {
        /*
          The defect this covers is the screen this route used to be: its own
          textarea, its own grid of model buttons, its own message list, and no
          sidebar. Everything below the divider was a second implementation of
          the chat surface, and the ways it differed were not decisions.
        */
        await prepareGuestPage(page, "ko");
        await openContinuation(page);

        await page.goto(`/continuations/${CONVERSATION_ID}`);

        // The shell, whichever one this viewport gets.
        const shell = page
            .getByTestId("desktop-chat-shell")
            .or(page.getByTestId("mobile-chat-shell"));
        await expect(shell).toBeVisible();

        // The composer is the one every other conversation uses.
        await expect(page.getByTestId("chat-input")).toBeVisible();
        await expect(page.getByTestId("chat-send-button")).toHaveCount(1);
        await expect(page.getByTestId("composer-model-select")).toHaveCount(1);

        // And the screen it replaced is gone -- not hidden, absent.
        for (const legacy of [
            "continued-conversation-workspace",
            "continuation-composer-textarea",
            "continuation-send",
            "continuation-model-selector",
            "continuation-model-option",
            "continuation-model-panel",
        ]) {
            await expect(page.getByTestId(legacy)).toHaveCount(0);
        }
    });

    test("the models are chosen with the ordinary picker, not a button grid", async ({
        page,
    }) => {
        /*
          The screen this replaced listed every model in the catalogue as a
          button and saved the selection itself. The composer already owns that
          question -- the cap, the availability clamp, the swap at the cap and
          the credit estimate are all its -- so a continuation gets the picker
          every other conversation gets, and the count it reports is the
          conversation's own.
        */
        await prepareGuestPage(page, "ko");
        await openContinuation(page, {
            selectedModels: [PRIMARY_MODEL, SECOND_MODEL],
        });

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        await expect(page.getByTestId("composer-model-select")).toBeVisible();
        await expect(
            page.getByTestId("composer-active-model-count")
        ).toContainText("2");
        // No grid of every model in the catalogue.
        await expect(
            page.getByTestId("continuation-model-option")
        ).toHaveCount(0);
    });

    test("the sidebar is there, with this conversation in it", async ({
        page,
    }) => {
        // "다시 찾아 이어가기" is the whole point of the feature, and the old
        // screen had no list at all: the only way back was the browser's
        // history.
        await prepareGuestPage(page, "ko");
        await openContinuation(page);

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        const list = await openConversationList(page);
        await expect(
            list
                .getByTestId("sidebar-conversation-item")
                .filter({ hasText: SOURCE_CONVERSATION_TITLE })
                .last()
        ).toBeVisible();
    });

    test("the imported half is a read-only prelude above the timeline", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        await openContinuation(page);

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        const prelude = page.getByTestId("continuation-source-section");
        await expect(prelude).toBeVisible();
        await expect(page.getByTestId("continuation-provenance")).toBeVisible();
        await expect(page.getByTestId("continuation-divider")).toBeVisible();

        // Exactly once for the conversation, never once per model panel
        // (docs/policy/external-conversation-continuation.md §5.1).
        await expect(prelude).toHaveCount(1);

        // Open on arrival: the imported conversation is what this screen is
        // about, and a short one is shown whole.
        await expect(
            page.getByTestId("continuation-source-message")
        ).toHaveCount(2);
        await expect(
            page.getByTestId("continuation-source-message").first()
        ).toBeVisible();

        // And the owner can put it away.
        await page.getByTestId("continuation-source-toggle").click();
        await expect(
            page.getByTestId("continuation-source-message").first()
        ).toBeHidden();
        // The imported assistant answer is badged as somebody else's, and the
        // shortened one says so.
        await expect(
            page.getByTestId("continuation-external-badge")
        ).toHaveCount(1);
        await expect(prelude).toContainText(/줄여|shorten|truncat/i);
    });

    test("the prelude sits above the composer and never over it", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        await openContinuation(page);

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        await page.getByTestId("continuation-source-toggle").click();

        const preludeBox = await page
            .getByTestId("continuation-source-section")
            .boundingBox();
        const inputBox = await page.getByTestId("chat-input").boundingBox();
        expect(preludeBox).not.toBeNull();
        expect(inputBox).not.toBeNull();
        if (!preludeBox || !inputBox) return;
        // Even expanded, the transcript ends above the composer's text row.
        expect(preludeBox.y + preludeBox.height).toBeLessThanOrEqual(
            inputBox.y + 1
        );
    });

    test("the structure survives a reload", async ({ page }) => {
        await prepareGuestPage(page, "ko");
        await openContinuation(page);

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        await expect(
            page.getByTestId("continuation-source-section")
        ).toBeVisible();

        await page.reload();
        await expect(
            page.getByTestId("continuation-source-section")
        ).toBeVisible();
        await expect(page.getByTestId("continuation-divider")).toBeVisible();
        await expect(page.getByTestId("chat-input")).toBeVisible();
    });

    test("a deleted source leaves a tombstone and the conversation intact", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        await openContinuation(page, { source: { status: "deleted" } });

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        await expect(
            page.getByTestId("continuation-source-tombstone")
        ).toBeVisible();
        // No imported transcript is rendered any more, and no disclosure
        // offers to show one.
        await expect(
            page.getByTestId("continuation-source-message")
        ).toHaveCount(0);
        await expect(
            page.getByTestId("continuation-source-toggle")
        ).toHaveCount(0);
        // The owner's own conversation is untouched, composer included.
        await expect(page.getByTestId("chat-input")).toBeVisible();
    });

    test("a locked source says so without hiding the conversation", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        await openContinuation(page, { source: { status: "locked" } });

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        await expect(
            page.getByTestId("continuation-source-locked")
        ).toBeVisible();
        await expect(
            page.getByTestId("continuation-source-message")
        ).toHaveCount(0);
        await expect(page.getByTestId("chat-input")).toBeVisible();
    });

    test("an ordinary conversation with no bridge renders no prelude", async ({
        page,
    }) => {
        // The regression this guards: a prelude that rendered a shell of
        // itself for every conversation would put an empty imported section on
        // top of `/chat`.
        await prepareGuestPage(page, "ko");
        await mockAuthenticatedApi(page);

        await page.goto("/chat");
        await expect(page.getByTestId("chat-input")).toBeVisible();
        await expect(
            page.getByTestId("continuation-source-section")
        ).toHaveCount(0);
    });

    test("the sidebar reopens a continuation at its own surface", async ({
        page,
    }) => {
        // The defect this covers: a continuation opened correctly at creation
        // and, once the user left the screen, opened in the ordinary workspace
        // from the conversation list -- without the imported half it
        // continues.
        await prepareGuestPage(page, "ko");
        await openContinuation(page, {
            extraRows: [{ id: "qa-ordinary", title: "An ordinary conversation" }],
        });

        await page.goto("/chat");
        const list = await openConversationList(page);
        await list
            .getByTestId("sidebar-conversation-item")
            .filter({ hasText: SOURCE_CONVERSATION_TITLE })
            .last()
            .click();

        await page.waitForURL(`**/continuations/${CONVERSATION_ID}`);
        await expect(
            page.getByTestId("continuation-source-section")
        ).toBeVisible();
        await expect(page.getByTestId("chat-input")).toBeVisible();
    });

    test("leaving for an ordinary conversation leaves the continuation URL too", async ({
        page,
    }) => {
        /*
          The mirror of the defect above, and the one this change introduced
          the possibility of: now that both screens are the same component,
          selecting an ordinary conversation in place would leave
          `/continuations/[id]` in the address bar with that conversation's
          imported prelude above a conversation it does not describe.
        */
        await prepareGuestPage(page, "ko");
        await openContinuation(page, {
            extraRows: [{ id: "qa-ordinary", title: "An ordinary conversation" }],
        });

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        await expect(
            page.getByTestId("continuation-source-section")
        ).toBeVisible();

        const list = await openConversationList(page);
        await list
            .getByTestId("sidebar-conversation-item")
            .filter({ hasText: "An ordinary conversation" })
            .last()
            .click();

        await expect(page).not.toHaveURL(/\/continuations\//);
        await expect(
            page.getByTestId("continuation-source-section")
        ).toHaveCount(0);
    });

    test("starting a new chat leaves the continuation URL as well", async ({
        page,
    }) => {
        // Same reasoning as leaving for another conversation: this URL names
        // one conversation and carries its imported prelude, so a blank one
        // started in place would leave both describing something that is no
        // longer on screen.
        await prepareGuestPage(page, "ko");
        await openContinuation(page);

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        await expect(
            page.getByTestId("continuation-source-section")
        ).toBeVisible();

        // On mobile the sidebar lives in the drawer, so this reaches the
        // control the same way the list tests do.
        const list = await openConversationList(page);
        await list.getByTestId("sidebar-new-chat").first().click();

        await expect(page).not.toHaveURL(/\/continuations\//);
        await expect(
            page.getByTestId("continuation-source-section")
        ).toHaveCount(0);
    });

    test("an ordinary conversation still opens in place from /chat", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        await mockAuthenticatedApi(page);
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

        await expect(page).not.toHaveURL(/\/continuations\//);
        await expect(
            page.getByTestId("continuation-source-section")
        ).toHaveCount(0);
    });

    test("at 320px the shell, prelude and composer do not overlap or overflow", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 320, height: 720 });
        await prepareGuestPage(page, "ko");
        await openContinuation(page);

        await page.goto(`/continuations/${CONVERSATION_ID}`);
        const input = page.getByTestId("chat-input");
        await expect(input).toBeVisible();
        await expect(
            page.getByTestId("continuation-source-section")
        ).toBeVisible();

        const inputBox = await input.boundingBox();
        const preludeBox = await page
            .getByTestId("continuation-source-section")
            .boundingBox();
        expect(inputBox).not.toBeNull();
        expect(preludeBox).not.toBeNull();
        if (!inputBox || !preludeBox) return;
        // The composer keeps a full visible line, and the imported half is
        // above it rather than over it.
        expect(inputBox.height).toBeGreaterThanOrEqual(24);
        expect(preludeBox.y + preludeBox.height).toBeLessThanOrEqual(
            inputBox.y + 1
        );

        const overflow = await page.evaluate(
            () =>
                document.documentElement.scrollWidth -
                document.documentElement.clientWidth
        );
        expect(overflow).toBeLessThanOrEqual(1);
    });
});
