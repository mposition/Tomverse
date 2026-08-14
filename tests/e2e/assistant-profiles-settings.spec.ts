import { test, expect, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

/**
 * /settings/assistants (Release C, slice C3b).
 *
 * Three claims, none of them shell-specific, so every assertion runs on the
 * desktop and mobile projects alike:
 *
 *   1. availability is the API's answer, not the page's guess — a 403 becomes
 *      the disabled notice and nothing else renders as if it worked;
 *   2. a profile with no published version reads as a draft rather than as
 *      revision 0, because it cannot start a conversation and a number does
 *      not say that;
 *   3. identity and behaviour save separately. Renaming must not spend a
 *      revision, and a publish that changed nothing must say so instead of
 *      filling the history with snapshots a conversation could pin to.
 *
 * The back link goes to settings by name, which the settings-navigation
 * contract requires of every detail page; that assertion lives here as well as
 * in the IA spec because this is a new page and the contract is per page.
 */

const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
});

const PROFILE_LIST = {
    profiles: [
        {
            id: "p-published",
            name: "Scheduling helper",
            icon: "🧭",
            description: "Answers scheduling questions.",
            published: true,
            currentRevision: 3,
            versionCount: 3,
            knowledgeFileCount: 2,
        },
        {
            id: "p-draft",
            name: "Unfinished",
            icon: null,
            description: null,
            published: false,
            currentRevision: null,
            versionCount: 0,
            knowledgeFileCount: 0,
        },
    ],
    limits: { maxProfilesPerAccount: 20 },
};

const PROFILE_DETAIL = {
    profile: {
        id: "p-published",
        name: "Scheduling helper",
        icon: "🧭",
        description: "Answers scheduling questions.",
        currentVersionId: "v-3",
        currentVersion: {
            revision: 3,
            instructions: "Answer in Korean.",
            models: ["gpt-5-6-luna"],
            toolPolicy: { webSearch: true, deepResearch: false },
            memoryPolicy: { useAccountMemory: true },
            starters: ["오늘 일정 정리해줘"],
            knowledgeManifest: [],
        },
        versions: [
            { id: "v-3", revision: 3, createdAt: "2026-08-14T00:00:00.000Z" },
            { id: "v-2", revision: 2, createdAt: "2026-08-13T00:00:00.000Z" },
            { id: "v-1", revision: 1, createdAt: "2026-08-12T00:00:00.000Z" },
        ],
        knowledgeFiles: [
            {
                id: "f-ready",
                name: "handbook.pdf",
                mime: "application/pdf",
                bytes: 1024,
                processingStatus: "ready",
                failureCode: null,
                chunkCount: 4,
                createdAt: "2026-08-12T00:00:00.000Z",
            },
            {
                id: "f-pending",
                name: "draft.pdf",
                mime: "application/pdf",
                bytes: 2048,
                processingStatus: "pending",
                failureCode: null,
                chunkCount: 0,
                createdAt: "2026-08-13T00:00:00.000Z",
            },
        ],
    },
};

async function mockProfileApis(
    page: Page,
    options: { list?: unknown; detail?: unknown; listStatus?: number } = {}
) {
    await mockAuthenticatedApi(page);
    await page.route(
        (url) => url.pathname === "/api/assistant-profiles",
        (route) => {
            if (options.listStatus === 403) {
                return route.fulfill({
                    status: 403,
                    contentType: "application/json",
                    body: JSON.stringify({ code: "ASSISTANT_PROFILES_DISABLED" }),
                });
            }
            return route.fulfill(json(options.list ?? PROFILE_LIST));
        }
    );
    await page.route(
        (url) => /^\/api\/assistant-profiles\/[^/]+$/.test(url.pathname),
        (route) => route.fulfill(json(options.detail ?? PROFILE_DETAIL))
    );
}

test.describe("assistant profile settings", () => {
    test("a disabled account sees the notice and no list", async ({ page }) => {
        // The page never decides availability for itself; a second copy of the
        // flag rule is a second place for it to be wrong.
        await prepareGuestPage(page);
        await mockProfileApis(page, { listStatus: 403 });
        await page.goto("/settings/assistants");

        await expect(page.getByTestId("assistants-disabled")).toBeVisible();
        await expect(page.getByTestId("assistants-list")).toHaveCount(0);
        await expect(page.getByTestId("assistants-create")).toHaveCount(0);
    });

    test("an unpublished profile reads as a draft, not as revision 0", async ({
        page,
    }) => {
        await prepareGuestPage(page);
        await mockProfileApis(page);
        await page.goto("/settings/assistants");

        const draft = page.getByTestId("assistant-profile-p-draft");
        await expect(draft).toBeVisible();
        await expect(draft).toContainText(/Draft|초안/);
        await expect(draft).not.toContainText(/revision 0|개정 0/);

        await expect(page.getByTestId("assistant-profile-p-published")).toContainText(
            /Published|게시됨/
        );
    });

    test("the back link goes to settings, from a cold URL", async ({ page }) => {
        // No history at all: a direct visit is exactly the case `router.back()`
        // cannot serve, which is why the link is addressed explicitly.
        await prepareGuestPage(page);
        await mockProfileApis(page);
        await page.goto("/settings/assistants");

        const back = page.getByTestId("assistants-back-to-settings");
        await expect(back).toBeVisible();
        await expect(back).toHaveAttribute("href", /settings=data/);
        await expect(back).toHaveAttribute("href", /settingsSection=assistants/);
    });

    test("renaming saves on its own and does not publish a revision", async ({
        page,
    }) => {
        // Policy: docs/policy/external-conversation-import-and-memory.md.
        // §14: a rename is not a behaviour change. If it spent a revision,
        // every typo in a description would become a snapshot a conversation
        // could pin to.
        await prepareGuestPage(page);
        await mockProfileApis(page);
        const publishCalls: unknown[] = [];
        await page.route(
            (url) => url.pathname.endsWith("/versions"),
            (route) => {
                publishCalls.push(route.request().postDataJSON());
                return route.fulfill(json({ outcome: "unchanged", revision: 3 }));
            }
        );
        await page.goto("/settings/assistants/p-published");

        await page.getByTestId("assistant-name").fill("Renamed helper");
        await page.getByTestId("assistant-save-identity").click();

        await expect(page.getByTestId("assistants-notice-saved")).toBeVisible();
        expect(publishCalls).toHaveLength(0);
    });

    test("publishing sends the revision it loaded, and reports an unchanged save", async ({
        page,
    }) => {
        await prepareGuestPage(page);
        await mockProfileApis(page);
        let published: Record<string, unknown> | null = null;
        await page.route(
            (url) => url.pathname.endsWith("/versions"),
            (route) => {
                published = route.request().postDataJSON();
                return route.fulfill(json({ outcome: "unchanged", revision: 3 }));
            }
        );
        await page.goto("/settings/assistants/p-published");
        await page.getByTestId("assistant-publish").click();

        await expect(page.getByTestId("assistants-notice-unchanged")).toBeVisible();
        expect(published).not.toBeNull();
        // The revision the editor loaded, which is what makes a stale save
        // detectable rather than a silent overwrite.
        expect(published!.expectedRevision).toBe(3);
        // Ids only: a client-supplied digest would be a client deciding what a
        // past version is recorded as having contained.
        expect(published).not.toHaveProperty("knowledgeManifest");
        expect(published!.knowledgeFileIds).toEqual([]);
    });

    test("a stale publish is reported, never retried", async ({ page }) => {
        // The other tab's edit is somebody's work; picking a winner here would
        // discard it without anyone seeing what was lost.
        await prepareGuestPage(page);
        await mockProfileApis(page);
        let attempts = 0;
        await page.route(
            (url) => url.pathname.endsWith("/versions"),
            (route) => {
                attempts += 1;
                return route.fulfill({
                    status: 409,
                    contentType: "application/json",
                    body: JSON.stringify({
                        code: "ASSISTANT_PROFILE_VERSION_STALE",
                    }),
                });
            }
        );
        await page.goto("/settings/assistants/p-published");
        await page.getByTestId("assistant-publish").click();

        await expect(page.getByTestId("assistants-notice-stale")).toBeVisible();
        expect(attempts).toBe(1);
    });

    test("a knowledge file that is not ready cannot be added to a revision", async ({
        page,
    }) => {
        // Only a processed file has chunks to retrieve from, so offering it
        // would promise retrieval the version cannot deliver.
        await prepareGuestPage(page);
        await mockProfileApis(page);
        await page.goto("/settings/assistants/p-published");

        await expect(page.getByTestId("assistant-knowledge-f-ready")).toBeEnabled();
        await expect(page.getByTestId("assistant-knowledge-f-pending")).toBeDisabled();
    });

    test("the version history names every revision and marks the current one", async ({
        page,
    }) => {
        await prepareGuestPage(page);
        await mockProfileApis(page);
        await page.goto("/settings/assistants/p-published");

        const history = page.getByTestId("assistant-version-history");
        await expect(history).toContainText(/3/);
        await expect(history).toContainText(/2/);
        await expect(history).toContainText(/1/);
        await expect(history).toContainText(/current|현재/);
    });
});
