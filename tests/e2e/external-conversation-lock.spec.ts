import { test, expect, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

/**
 * §7, §7.1 — what a locked snapshot looks like to its owner.
 *
 * The server side is proved by the DB suites. What only a browser can show is
 * the part that decides whether the lock is usable: that a locked snapshot
 * shows a password prompt *instead of* its content rather than beside it,
 * that a rate-limited attempt reads differently from a wrong password, and
 * that the number of memories a lock would suspend is on screen before the
 * lock is applied rather than after.
 */

const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
});

const CONVERSATION_ID = "qa-locked-conversation";

type LockState = {
    /** Whether the snapshot has a password set. */
    locked: boolean;
    /** Whether this browser is past it. */
    unlocked: boolean;
    /** What the verify endpoint answers next: 200, 403 or 429. */
    verifyStatus: number;
    putCalls: Array<{ password: string | null; currentPassword?: string }>;
};

const detail = () => ({
    id: CONVERSATION_ID,
    importId: "qa-import-1",
    provider: "chatgpt",
    title: "A locked import",
    sourceModelLabels: [],
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    importedAt: "2026-08-01T00:00:00.000Z",
    messageTotal: 1,
    messages: [
        {
            id: "m-1",
            role: "user",
            ordinal: 0,
            content: "Something private.",
            sourceModelLabel: null,
            sourceTimestamp: null,
            truncated: false,
            originalCharacterCount: null,
            retainedCharacterCount: null,
        },
    ],
});

async function mockLockApi(
    page: Page,
    initial: Partial<LockState> = {}
): Promise<LockState> {
    const state: LockState = {
        locked: false,
        unlocked: false,
        verifyStatus: 200,
        putCalls: [],
        ...initial,
    };

    // Enough of the management page to reach its conversation list: the
    // capacity endpoint is what stands in for the rollout flag being on.
    await page.route(
        (url) => url.pathname === "/api/imports/external/capacity",
        (route) =>
            route.fulfill(
                json({
                    limits: {
                        maxNormalizedTextBytes: 100_000_000,
                        maxExternalConversations: 1000,
                        maxExternalMessages: 100_000,
                        maxStoredMessageCodePoints: 40_000,
                        maxInboundMessageCodePoints: 200_000,
                    },
                    usage: {
                        normalizedTextBytes: 100,
                        externalConversations: 1,
                        externalMessages: 1,
                    },
                    remaining: {
                        normalizedTextBytes: 99_999_900,
                        externalConversations: 999,
                        externalMessages: 99_999,
                    },
                })
            )
    );

    await page.route(
        (url) => url.pathname === "/api/imports/external",
        (route) => route.fulfill(json({ imports: [] }))
    );

    await page.route(
        (url) => url.pathname === "/api/external-conversations",
        (route) =>
            route.fulfill(
                json({
                    total: 1,
                    offset: 0,
                    limit: 50,
                    conversations: [
                        {
                            id: CONVERSATION_ID,
                            provider: "chatgpt",
                            // Withheld from the list while locked (IMPORT-LOCK-TITLE-01).
                            title: state.locked ? null : "A locked import",
                            titleWithheld: state.locked,
                            externalStableId: "stable-1",
                            messageCount: 1,
                            contentBytes: 100,
                            importedAt: "2026-08-01T00:00:00.000Z",
                            locked: state.locked,
                        },
                    ],
                })
            )
    );

    await page.route(
        (url) =>
            url.pathname ===
            `/api/external-conversations/${CONVERSATION_ID}/lock`,
        async (route) => {
            if (route.request().method() === "PUT") {
                const body = JSON.parse(route.request().postData() || "{}");
                state.putCalls.push(body);
                state.locked = body.password !== null;
                // Every write clears the grant, in all three directions. The
                // route used to leave the setter holding a live one, which is
                // what let a just-locked snapshot stay searchable and stay
                // exportable
                // (docs/policy/external-conversation-import-and-memory.md §21).
                state.unlocked = false;
                return route.fulfill(
                    json({
                        conversationId: CONVERSATION_ID,
                        locked: state.locked,
                        memoriesSuspended: state.locked ? 2 : 0,
                        memoriesRestored: state.locked ? 0 : 2,
                        memoriesExpired: 0,
                    })
                );
            }
            return route.fulfill(
                json({
                    locked: state.locked,
                    memoryImpact: { blockedCount: 2, backedCount: 1 },
                })
            );
        }
    );

    await page.route(
        (url) =>
            url.pathname ===
            `/api/external-conversations/${CONVERSATION_ID}/lock/verify`,
        (route) => {
            if (state.verifyStatus === 200) {
                state.unlocked = true;
                return route.fulfill(json({ success: true }));
            }
            return route.fulfill({
                status: state.verifyStatus,
                contentType: "application/json",
                body: JSON.stringify({ success: false, error: "refused" }),
            });
        }
    );

    // The detail endpoint answers 423 while the snapshot is locked and this
    // browser has no grant — the same shape the real route produces.
    await page.route(
        (url) =>
            new RegExp(`^/api/external-conversations/[^/]+$`).test(url.pathname),
        (route) => {
            if (state.locked && !state.unlocked) {
                return route.fulfill({
                    status: 423,
                    contentType: "application/json",
                    body: JSON.stringify({
                        error: "Conversation is locked.",
                        code: "CONVERSATION_LOCKED",
                    }),
                });
            }
            return route.fulfill(
                json({ ...detail(), locked: state.locked, offset: 0, limit: 100 })
            );
        }
    );

    return state;
}

const openViewer = async (page: Page) => {
    await page.goto(`/settings/imports/conversations/${CONVERSATION_ID}`);
};

test.describe("imported snapshot lock", () => {
    test("a locked snapshot shows a password prompt instead of its content", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        await mockAuthenticatedApi(page);
        await mockLockApi(page, { locked: true, unlocked: false });
        await openViewer(page);

        await expect(page.getByTestId("snapshot-unlock-gate")).toBeVisible();
        // The content is absent, not merely covered: a lock that only hides
        // things visually is not a lock.
        await expect(
            page.getByTestId("external-conversation-viewer")
        ).toHaveCount(0);
        await expect(page.getByTestId("external-viewer-message")).toHaveCount(0);
        await expect(page.getByText("Something private.")).toHaveCount(0);
    });

    test("the right password reveals the conversation", async ({ page }) => {
        await prepareGuestPage(page, "ko");
        await mockAuthenticatedApi(page);
        await mockLockApi(page, { locked: true, unlocked: false });
        await openViewer(page);

        await page.getByTestId("snapshot-unlock-password").fill("a-password-1");
        await page.getByTestId("snapshot-unlock-submit").click();

        await expect(
            page.getByTestId("external-conversation-viewer")
        ).toBeVisible();
        await expect(page.getByText("Something private.")).toBeVisible();
    });

    test("a wrong password and a rate limit do not read the same", async ({
        page,
    }) => {
        // Being told to try again when the answer is "wait" sends the owner
        // straight into the limit they have already hit.
        await prepareGuestPage(page, "ko");
        await mockAuthenticatedApi(page);
        const state = await mockLockApi(page, {
            locked: true,
            unlocked: false,
            verifyStatus: 403,
        });
        await openViewer(page);

        await page.getByTestId("snapshot-unlock-password").fill("wrong");
        await page.getByTestId("snapshot-unlock-submit").click();
        const wrongText = await page
            .getByTestId("snapshot-lock-error")
            .textContent();
        expect(wrongText?.trim().length).toBeGreaterThan(0);

        state.verifyStatus = 429;
        await page.getByTestId("snapshot-unlock-password").fill("wrong-again");
        await page.getByTestId("snapshot-unlock-submit").click();
        await expect(page.getByTestId("snapshot-lock-error")).not.toHaveText(
            wrongText ?? ""
        );

        // And the content stayed away throughout.
        await expect(page.getByText("Something private.")).toHaveCount(0);
    });

    test("locking states the memory cost and the lost-password warning first", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        await mockAuthenticatedApi(page);
        const state = await mockLockApi(page);
        await openViewer(page);

        await expect(page.getByTestId("snapshot-lock-panel")).toBeVisible();
        await page.getByTestId("snapshot-lock-set").click();

        // Both facts are on screen *before* the lock is applied, which is the
        // whole point of asking for them here (§7.1).
        await expect(page.getByTestId("source-lock-blocked")).toBeVisible();
        await expect(page.getByTestId("source-lock-backed")).toBeVisible();
        expect(state.putCalls).toHaveLength(0);

        await page.getByTestId("snapshot-lock-new").fill("a-password-1");
        await page.getByTestId("snapshot-lock-submit").click();

        expect(state.putCalls).toEqual([{ password: "a-password-1" }]);

        // Locking closes the snapshot to the person who just locked it: the
        // page re-reads, is refused, and asks for the password. It used to
        // stay open on a grant the write handed back, and the transcript the
        // owner had just hidden stayed on screen in front of them.
        await expect(page.getByTestId("snapshot-unlock-gate")).toBeVisible();
        await expect(page.getByText("Something private.")).toHaveCount(0);
        await expect(page.getByTestId("external-viewer-message")).toHaveCount(0);
    });

    test("a password shorter than the minimum cannot be submitted", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        await mockAuthenticatedApi(page);
        const state = await mockLockApi(page);
        await openViewer(page);

        await page.getByTestId("snapshot-lock-set").click();
        await page.getByTestId("snapshot-lock-new").fill("short");
        await expect(page.getByTestId("snapshot-lock-submit")).toBeDisabled();
        expect(state.putCalls).toHaveLength(0);
    });

    test("removing a lock sends the current password and says what comes back", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        await mockAuthenticatedApi(page);
        const state = await mockLockApi(page, { locked: true, unlocked: true });
        await openViewer(page);

        await page.getByTestId("snapshot-lock-remove").click();
        await expect(
            page.getByTestId("snapshot-lock-remove-note")
        ).toBeVisible();
        // Nothing can be sent without proving the current password.
        await expect(page.getByTestId("snapshot-lock-submit")).toBeDisabled();

        await page.getByTestId("snapshot-lock-current").fill("a-password-1");
        await page.getByTestId("snapshot-lock-submit").click();

        expect(state.putCalls).toEqual([
            { password: null, currentPassword: "a-password-1" },
        ]);
        await expect(page.getByTestId("snapshot-lock-set")).toBeVisible();
    });

    test("a page still in flight cannot put the transcript back after a lock", async ({
        page,
    }) => {
        // The failure this pins is not a missing check -- it is a held copy.
        // `loadMore` closes over the transcript as it was before the lock, so
        // a page that lands afterwards writes those messages back over the
        // password gate. Both of its branches did: the refusal branch restored
        // the captured state too, so even a 423 undid the lock on screen.
        await prepareGuestPage(page, "ko");
        await mockAuthenticatedApi(page);
        const state = await mockLockApi(page);

        let releaseSecondPage: () => void = () => {};
        const secondPageHeld = new Promise<void>((resolve) => {
            releaseSecondPage = resolve;
        });
        let secondPageRequested: () => void = () => {};
        const secondPageStarted = new Promise<void>((resolve) => {
            secondPageRequested = resolve;
        });

        // Registered after mockLockApi, so Playwright matches it first.
        await page.route(
            (url) =>
                new RegExp("^/api/external-conversations/[^/]+$").test(
                    url.pathname
                ),
            async (route, request) => {
                const offset = new URL(request.url()).searchParams.get("offset");
                if (offset === "0") {
                    if (state.locked && !state.unlocked) {
                        return route.fulfill({
                            status: 423,
                            contentType: "application/json",
                            body: JSON.stringify({
                                error: "Conversation is locked.",
                                code: "CONVERSATION_LOCKED",
                            }),
                        });
                    }
                    return route.fulfill(
                        json({
                            ...detail(),
                            messageTotal: 2,
                            locked: state.locked,
                            offset: 0,
                            limit: 100,
                        })
                    );
                }
                // The second page is held open across the lock, then answered
                // exactly as it would have been had the lock not happened.
                secondPageRequested();
                await secondPageHeld;
                return route.fulfill(
                    json({
                        ...detail(),
                        messageTotal: 2,
                        messages: [
                            {
                                id: "m-2",
                                role: "assistant",
                                ordinal: 1,
                                content: "Also private.",
                                sourceModelLabel: null,
                                sourceTimestamp: null,
                                truncated: false,
                                originalCharacterCount: null,
                                retainedCharacterCount: null,
                            },
                        ],
                        locked: state.locked,
                        offset: 1,
                        limit: 100,
                    })
                );
            }
        );

        await openViewer(page);
        await expect(page.getByText("Something private.")).toBeVisible();

        await page.getByTestId("external-viewer-more").click();
        await secondPageStarted;

        await page.getByTestId("snapshot-lock-set").click();
        await page.getByTestId("snapshot-lock-new").fill("a-password-1");
        await page.getByTestId("snapshot-lock-submit").click();
        await expect(page.getByTestId("snapshot-unlock-gate")).toBeVisible();

        releaseSecondPage();

        // The gate stays, and neither the transcript that was on screen nor
        // the page that arrived late is shown.
        await expect(page.getByTestId("snapshot-unlock-gate")).toBeVisible();
        await expect(page.getByText("Something private.")).toHaveCount(0);
        await expect(page.getByText("Also private.")).toHaveCount(0);
        await expect(page.getByTestId("external-viewer-message")).toHaveCount(0);
    });

    test("the list says which snapshots are locked before they are opened", async ({
        page,
    }) => {
        await prepareGuestPage(page, "ko");
        await mockAuthenticatedApi(page);
        await mockLockApi(page, { locked: true, unlocked: false });
        await page.goto("/settings/imports");

        await expect(
            page.getByTestId("external-import-conversation-locked")
        ).toBeVisible();
    });
});
