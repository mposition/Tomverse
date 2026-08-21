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
        // The AI settings tab, not the data tab: profiles moved when
        // personalisation got a tab of its own, and this href is the half of
        // the pair a reader actually follows.
        await expect(back).toHaveAttribute("href", /settings=ai/);
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

    /* ------------------------------------------ the minimal create form */

    /**
     * Creating used to be: save a name, land in the editor, fill in
     * instructions and a comma-separated list of internal model ids, then
     * "publish a revision" — and only then did the profile work at all. These
     * pin what replaced it, and in particular that the advanced fields are
     * still *there*, closed rather than gone.
     */

    async function mockCreate(page: Page) {
        await mockAuthenticatedApi(page);
        await page.route(
            (url) => url.pathname === "/api/assistant-profiles",
            async (route) => {
                if (route.request().method() !== "POST") {
                    return route.fulfill(json(PROFILE_LIST));
                }
                const body = route.request().postDataJSON() as {
                    name?: string;
                    instructions?: string;
                    modelIds?: string[];
                };
                createRequests.push(body);
                return route.fulfill({
                    status: 201,
                    contentType: "application/json",
                    body: JSON.stringify({ profile: { id: "p-new" } }),
                });
            }
        );
        await page.route(
            (url) => /^\/api\/assistant-profiles\/[^/]+$/.test(url.pathname),
            (route) => route.fulfill(json(PROFILE_DETAIL))
        );
    }

    let createRequests: Array<Record<string, unknown>> = [];
    test.beforeEach(() => {
        createRequests = [];
    });

    test("the create form asks for a name and instructions, and nothing else @ui-risk", async ({
        page,
    }) => {
        await prepareGuestPage(page);
        await mockCreate(page);
        await page.goto("/settings/assistants/new");

        await expect(page.getByTestId("assistant-name")).toBeVisible();
        await expect(page.getByTestId("assistant-instructions")).toBeVisible();
        // Optional, and present -- it is not one of the things hidden.
        await expect(page.getByTestId("assistant-description")).toBeVisible();

        // Everything that used to be a required second step is closed.
        await expect(page.getByTestId("assistant-icon")).toBeHidden();
        await expect(page.getByTestId("assistant-models")).toBeHidden();
        await expect(page.getByTestId("assistant-starters")).toHaveCount(0);
        await expect(page.getByTestId("assistant-web-search")).toHaveCount(0);
        await expect(page.getByTestId("assistant-use-memory")).toHaveCount(0);
        await expect(page.getByTestId("assistant-version-history")).toHaveCount(0);
    });

    test("advanced settings open on request and report their state", async ({
        page,
    }) => {
        await prepareGuestPage(page);
        await mockCreate(page);
        await page.goto("/settings/assistants/new");

        const toggle = page.getByTestId("assistant-advanced-toggle");
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");

        // The model control is a selector over named models, not a text field
        // asking for internal ids.
        const models = page.getByTestId("assistant-models");
        await expect(models).toBeVisible();
        await expect(models.locator("input[type=checkbox]").first()).toBeVisible();
        await expect(page.getByTestId("assistant-icon")).toBeVisible();
    });

    test("a name and instructions are enough to create a usable profile", async ({
        page,
    }) => {
        await prepareGuestPage(page);
        await mockCreate(page);
        await page.goto("/settings/assistants/new");

        await page.getByTestId("assistant-name").fill("Tax helper");
        await page
            .getByTestId("assistant-instructions")
            .fill("Answer briefly, and say what you are unsure about.");
        await page.getByTestId("assistant-create").click();

        await expect(page).toHaveURL(/\/settings\/assistants\/p-new$/);
        expect(createRequests).toHaveLength(1);
        // One request, carrying both halves: the profile and its first
        // version are written together or not at all.
        expect(createRequests[0]).toMatchObject({
            name: "Tax helper",
            instructions: "Answer briefly, and say what you are unsure about.",
        });
        // No models named, so the server resolves the account default rather
        // than the client choosing one.
        expect(createRequests[0].modelIds).toBeUndefined();
    });

    test("an empty instruction is refused at the field, with focus", async ({
        page,
    }) => {
        await prepareGuestPage(page);
        await mockCreate(page);
        await page.goto("/settings/assistants/new");

        await page.getByTestId("assistant-name").fill("Nameless behaviour");
        await page.getByTestId("assistant-create").click();

        const error = page.getByTestId("assistant-instructions-error");
        await expect(error).toBeVisible();
        await expect(page.getByTestId("assistant-instructions")).toBeFocused();
        await expect(page.getByTestId("assistant-instructions")).toHaveAttribute(
            "aria-invalid",
            "true"
        );
        // Nothing was sent: a refused form is refused before the request.
        expect(createRequests).toHaveLength(0);
    });

    test("a chosen model reaches the request as a real id", async ({ page }) => {
        await prepareGuestPage(page);
        await mockCreate(page);
        await page.goto("/settings/assistants/new");

        await page.getByTestId("assistant-name").fill("Picky");
        await page.getByTestId("assistant-instructions").fill("Be brief.");
        await page.getByTestId("assistant-advanced-toggle").click();
        await page.getByTestId("assistant-model-gpt-5-6-luna").check();
        await page.getByTestId("assistant-create").click();

        await expect(page).toHaveURL(/\/settings\/assistants\/p-new$/);
        expect(createRequests[0].modelIds).toContain("gpt-5-6-luna");
    });

    test("arriving from the chat returns there instead of the edit page", async ({
        page,
    }) => {
        await prepareGuestPage(page);
        await mockCreate(page);
        await page.goto("/settings/assistants/new?from=chat");

        // The button says where it goes, which the settings entry point's
        // does not promise.
        const create = page.getByTestId("assistant-create");
        await expect(create).toContainText(/this chat|이 대화/i);

        await page.getByTestId("assistant-name").fill("From the composer");
        await page.getByTestId("assistant-instructions").fill("Be brief.");
        await create.click();

        await expect(page).toHaveURL(/\/chat$/);
    });

    test("the edit screen says save, not publish a revision", async ({
        page,
    }) => {
        await prepareGuestPage(page);
        await mockProfileApis(page);
        await page.goto("/settings/assistants/p-published");

        const save = page.getByTestId("assistant-publish");
        await expect(save).toBeVisible();
        await expect(save).not.toContainText(/revision|개정/i);
        // Revisions are still tracked, and still shown to whoever wants them.
        await expect(page.getByTestId("assistant-version-history")).toBeVisible();
    });

    /* -------------------------------------------- the profile hierarchy */

    /**
     * A profile sits inside a list, which sits inside a settings tab. The
     * editor used to offer "back to settings", skipping the list entirely,
     * while the trail underneath claimed a hierarchy the link did not follow.
     */

    test("a profile goes back to the list, not past it @ui-risk", async ({
        page,
    }) => {
        await prepareGuestPage(page);
        await mockProfileApis(page);
        // Cold: no history, so the link has to name its destination.
        await page.goto("/settings/assistants/p-published");

        const back = page.getByTestId("assistant-back-to-list");
        await expect(back).toBeVisible();
        await expect(back).toHaveAttribute("href", /\/settings\/assistants(\?|$)/);
        await expect(back).toContainText(/AI 프로필 목록으로|Back to AI profiles/);

        // The link that skipped the list is gone from this page.
        await expect(page.getByTestId("assistants-back-to-settings")).toHaveCount(0);

        await back.click();
        await expect(page).toHaveURL(/\/settings\/assistants(\?|$)/);
        await expect(page.getByTestId("assistants-list")).toBeVisible();
    });

    test("the trail names every step and marks the current page @ui-risk", async ({
        page,
    }) => {
        await prepareGuestPage(page);
        await mockProfileApis(page);
        await page.goto("/settings/assistants/p-published");

        const crumb = page.getByTestId("settings-breadcrumb");
        if ((page.viewportSize()?.width ?? 1920) < 768) {
            // Mobile keeps the back link, which is the control either layout
            // needs; the trail is the desktop extra.
            await expect(crumb).toBeHidden();
            await expect(page.getByTestId("assistant-back-to-list")).toBeVisible();
            return;
        }

        await expect(crumb).toContainText("설정");
        await expect(crumb).toContainText("AI 개인화");
        await expect(crumb).toContainText("나만의 AI 프로필");
        // The page's own crumb is the profile, and it is not a link.
        await expect(crumb.locator('[aria-current="page"]')).toContainText(
            "Scheduling helper"
        );

        // The list crumb is reachable, not just readable.
        await crumb
            .getByRole("link", { name: "나만의 AI 프로필" })
            .click();
        await expect(page).toHaveURL(/\/settings\/assistants(\?|$)/);
    });

    test("the disabled state still offers the list", async ({ page }) => {
        // A page that offers a different parent depending on what it managed
        // to fetch is a page whose hierarchy depends on the network.
        await prepareGuestPage(page);
        await mockAuthenticatedApi(page);
        await page.route(
            (url) => /^\/api\/assistant-profiles\/[^/]+$/.test(url.pathname),
            (route) =>
                route.fulfill({
                    status: 403,
                    contentType: "application/json",
                    body: JSON.stringify({ code: "ASSISTANT_PROFILES_DISABLED" }),
                })
        );
        await page.goto("/settings/assistants/p-published");

        await expect(page.getByTestId("assistants-disabled")).toBeVisible();
        await expect(page.getByTestId("assistant-back-to-list")).toHaveAttribute(
            "href",
            /\/settings\/assistants(\?|$)/
        );
    });

    test("creating from the list goes back to the list", async ({ page }) => {
        await prepareGuestPage(page);
        await mockCreate(page);
        await page.goto("/settings/assistants/new");

        const back = page.getByTestId("assistant-create-back");
        await expect(back).toHaveAttribute("href", /\/settings\/assistants(\?|$)/);
        await expect(back).toContainText(/AI 프로필 목록으로|Back to AI profiles/);
    });

    test("creating from a chat offers the chat, not the list", async ({
        page,
    }) => {
        // The chat is not a settings ancestor: it is a plain back link and
        // never a crumb, because a trail containing it would claim settings
        // sits underneath the chat.
        await prepareGuestPage(page);
        await mockCreate(page);
        await page.goto("/settings/assistants/new?from=chat");

        const back = page.getByTestId("assistant-create-back");
        await expect(back).toHaveAttribute("href", "/chat");
        await expect(back).toContainText(/채팅으로 돌아가기|Back to the chat/);
        await expect(page.getByTestId("settings-breadcrumb")).toHaveCount(0);
    });

    test("returning from a profile restores its row", async ({ page }) => {
        await prepareGuestPage(page);
        await mockProfileApis(page);
        await page.goto("/settings/assistants/p-published");

        await page.getByTestId("assistant-back-to-list").click();
        await expect(page.getByTestId("assistants-list")).toBeVisible();
        await expect(
            page.getByTestId("assistant-profile-p-published")
        ).toBeFocused();
    });

    test("a row that no longer exists focuses the heading instead", async ({
        page,
    }) => {
        // The profile was deleted from its own page: the hint names nothing,
        // and focus must not be left on `<body>` with nothing announced.
        await prepareGuestPage(page);
        await mockProfileApis(page);
        await page.goto("/settings/assistants?focus=p-deleted");

        await expect(page.getByTestId("assistants-list")).toBeVisible();
        await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    });

    test("the back link is reachable and activatable from the keyboard", async ({
        page,
    }) => {
        await prepareGuestPage(page);
        await mockProfileApis(page);
        await page.goto("/settings/assistants/p-published");

        const back = page.getByTestId("assistant-back-to-list");
        await back.focus();
        await expect(back).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/\/settings\/assistants(\?|$)/);
    });
});
