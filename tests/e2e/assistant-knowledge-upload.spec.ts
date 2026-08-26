import { test, expect, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

/**
 * Adding a knowledge file from the product (Release C).
 *
 * The server half shipped first and was verified against staging by calling
 * the API by hand, because nothing in the product called it. This suite
 * covers the half that was missing, and the claims it makes are the ones that
 * round could not:
 *
 *   1. availability is the endpoint's answer. A 403 removes the panel rather
 *      than disabling a control, because a control that cannot ever work is
 *      not a control;
 *   2. what is left is stated before a file is chosen, not after one is
 *      refused;
 *   3. a refusal names its own reason. "Too big" and "cannot be read" send
 *      the owner to different actions;
 *   4. a published revision keeps naming a file that has since been deleted,
 *      and says it is gone rather than dropping the row.
 *
 * Nothing here is shell-specific, so it runs on both projects.
 */

const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
});

const CAPACITY = {
    limits: {
        maxFileBytes: 33_554_432,
        maxFilesPerProfile: 20,
        maxFilesPerAccount: 100,
        maxObjectBytesPerAccount: 524_288_000,
        maxExtractedBytesPerAccount: 52_428_800,
    },
    usage: {
        filesInProfile: 1,
        filesInAccount: 1,
        objectBytes: 1024,
        extractedBytes: 512,
    },
    remaining: {
        filesInProfile: 19,
        filesInAccount: 99,
        objectBytes: 524_286_976,
        extractedBytes: 52_428_288,
    },
    acceptedMediaTypes: ["text/plain", "application/pdf"],
};

const detail = (
    files: unknown[],
    manifest: { fileId: string; name: string; digest: string }[] = []
) => ({
    profile: {
        id: "p-1",
        name: "Scheduling helper",
        icon: "🧭",
        description: null,
        currentVersionId: "v-1",
        currentVersion: {
            revision: 1,
            instructions: "Answer briefly.",
            models: ["gpt-5-6-luna"],
            toolPolicy: { webSearch: false, deepResearch: false },
            memoryPolicy: { useAccountMemory: false },
            starters: [],
            knowledgeManifest: manifest,
        },
        versions: [{ id: "v-1", revision: 1, createdAt: "2026-08-12T00:00:00.000Z" }],
        knowledgeFiles: files,
    },
});

const READY = {
    id: "f-ready",
    name: "handbook.pdf",
    mime: "application/pdf",
    bytes: 1024,
    processingStatus: "ready",
    failureCode: null,
    chunkCount: 4,
    createdAt: "2026-08-12T00:00:00.000Z",
};

type KnowledgeMock = {
    /** 403 turns the whole panel off, the way the flag does. */
    listStatus?: number;
    capacity?: unknown;
    prepare?: { status: number; body: unknown };
    finalize?: { status: number; body: unknown };
    putStatus?: number;
};

async function mockEditor(
    page: Page,
    options: {
        files?: unknown[];
        manifest?: { fileId: string; name: string; digest: string }[];
        knowledge?: KnowledgeMock;
    } = {}
) {
    await mockAuthenticatedApi(page);
    const knowledge = options.knowledge ?? {};
    let files = options.files ?? [READY];

    await page.route(
        (url) => /^\/api\/assistant-profiles\/[^/]+$/.test(url.pathname),
        (route) => route.fulfill(json(detail(files, options.manifest)))
    );

    await page.route("**/r2-upload/**", (route) =>
        route.fulfill({ status: knowledge.putStatus ?? 200, body: "" })
    );

    await page.route(
        (url) => /^\/api\/assistant-profiles\/[^/]+\/knowledge$/.test(url.pathname),
        async (route) => {
            if (knowledge.listStatus === 403) {
                return route.fulfill({
                    status: 403,
                    contentType: "application/json",
                    body: JSON.stringify({ code: "ASSISTANT_KNOWLEDGE_DISABLED" }),
                });
            }
            if (route.request().method() === "GET") {
                return route.fulfill(
                    json({ files, capacity: knowledge.capacity ?? CAPACITY })
                );
            }
            const body = route.request().postDataJSON() as { action: string };
            if (body.action === "prepare") {
                const prepared = knowledge.prepare ?? {
                    status: 200,
                    body: {
                        uploadKey: "assistant-knowledge/new",
                        uploadUrl: "https://storage.example/r2-upload/new",
                        uploadHeaders: { "Content-Type": "text/plain" },
                    },
                };
                return route.fulfill({
                    status: prepared.status,
                    contentType: "application/json",
                    body: JSON.stringify(prepared.body),
                });
            }
            const finalized = knowledge.finalize ?? {
                status: 201,
                body: { file: { id: "f-new", name: "notes.txt" } },
            };
            if (finalized.status < 300) {
                // The list the editor reloads after a successful add is the
                // one the server would now return, so the assertion is about
                // the refresh happening rather than about optimistic state.
                files = [
                    ...files,
                    {
                        ...READY,
                        id: "f-new",
                        name: "notes.txt",
                        mime: "text/plain",
                        bytes: 12,
                    },
                ];
            }
            return route.fulfill({
                status: finalized.status,
                contentType: "application/json",
                body: JSON.stringify(finalized.body),
            });
        }
    );
}

const chooseFile = (page: Page) =>
    page.getByTestId("knowledge-add-input").setInputFiles({
        name: "notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("a knowledge file"),
    });

test.describe("assistant knowledge files", () => {
    test(
        "the feature being off removes the panel rather than disabling it",
        { tag: "@ui-risk" },
        async ({ page }) => {
            // Ordered so it cannot pass for the wrong reason.
            //
            // The previous version asked only whether the panel was absent
            // after a 403. Absence is also what a Playwright run produces when
            // the feature flag is off -- which it silently was, because the
            // flag lives in `AppSetting` and the fixture server has no
            // database. So this test went on passing while the seven around it
            // failed, and it would have kept passing with the 403 branch
            // deleted outright.
            //
            // The answer is held open instead. The panel has to mount, ask the
            // endpoint, and be on screen *before* the refusal arrives, so
            // every step that a flag-off run cannot reach is asserted first
            // and absence is only accepted at the end.
            let refuse: (() => void) | null = null;
            const held = new Promise<void>((resolve) => {
                refuse = resolve;
            });
            let capacityReads = 0;

            await prepareGuestPage(page);
            await mockEditor(page);
            await page.route(
                (url) =>
                    /^\/api\/assistant-profiles\/[^/]+\/knowledge$/.test(
                        url.pathname
                    ),
                async (route) => {
                    if (route.request().method() !== "GET") return route.fallback();
                    capacityReads += 1;
                    await held;
                    return route.fulfill({
                        status: 403,
                        contentType: "application/json",
                        body: JSON.stringify({
                            code: "ASSISTANT_KNOWLEDGE_DISABLED",
                        }),
                    });
                }
            );
            await page.goto("/settings/assistants/p-1");

            await expect(page.getByTestId("assistant-instructions")).toBeVisible();
            // 1. the endpoint was actually reached. Without this the rest of
            //    the test is satisfied by a page that never rendered a panel.
            await expect
                .poll(() => capacityReads, {
                    message:
                        "the knowledge panel never asked the endpoint, so its absence below proves nothing",
                })
                .toBeGreaterThan(0);
            // 2. and the panel is up while the answer is outstanding.
            await expect(page.getByTestId("knowledge-panel")).toBeVisible();

            // 3. now refuse.
            refuse!();

            // 4. and it goes, rather than staying and disabling its controls.
            await expect(page.getByTestId("knowledge-panel")).toHaveCount(0);
            await expect(page.getByTestId("knowledge-add-input")).toHaveCount(0);
        }
    );

    test("what is left is stated before a file is chosen", async ({ page }) => {
        await prepareGuestPage(page);
        await mockEditor(page);
        await page.goto("/settings/assistants/p-1");

        // 19 files and 500MB of the account's 500MB budget, and the per-file
        // ceiling, which is the one a chooser needs before opening a dialog.
        await expect(page.getByTestId("knowledge-capacity")).toContainText("19");
        await expect(page.getByTestId("knowledge-capacity")).toContainText("32");
    });

    test("adding a file uploads it and the list comes back with it", async ({
        page,
    }) => {
        await prepareGuestPage(page);
        await mockEditor(page);
        await page.goto("/settings/assistants/p-1");
        await expect(page.getByTestId("assistant-knowledge-f-ready")).toBeVisible();

        await chooseFile(page);

        await expect(page.getByTestId("assistant-knowledge-f-new")).toBeVisible();
        await expect(page.getByTestId("knowledge-upload-error")).toHaveCount(0);
    });

    test("a quota refusal says so, and is not the generic failure", async ({
        page,
    }) => {
        await prepareGuestPage(page);
        await mockEditor(page, {
            knowledge: {
                prepare: {
                    status: 409,
                    body: {
                        code: "ASSISTANT_KNOWLEDGE_QUOTA_EXCEEDED",
                        error: "the account is full",
                    },
                },
            },
        });
        await page.goto("/settings/assistants/p-1");
        await chooseFile(page);

        const error = page.getByTestId("knowledge-upload-error");
        await expect(error).toBeVisible();
        await expect(error).toContainText(/fit|들어가지|cabe|passt|tient|cabe|放不下/);
    });

    test("an unreadable type says that instead of blaming the size", async ({
        page,
    }) => {
        await prepareGuestPage(page);
        await mockEditor(page, {
            knowledge: {
                prepare: {
                    status: 415,
                    body: { code: "ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE" },
                },
            },
        });
        await page.goto("/settings/assistants/p-1");
        await chooseFile(page);

        const error = page.getByTestId("knowledge-upload-error");
        await expect(error).toBeVisible();
        await expect(error).not.toContainText(/fit|들어가지/);
    });

    test("a storage failure saves nothing and says so", async ({ page }) => {
        await prepareGuestPage(page);
        await mockEditor(page, { knowledge: { putStatus: 500 } });
        await page.goto("/settings/assistants/p-1");
        await chooseFile(page);

        await expect(page.getByTestId("knowledge-upload-error")).toBeVisible();
        // Nothing was finalized, so no row appeared.
        await expect(page.getByTestId("assistant-knowledge-f-new")).toHaveCount(0);
    });

    test("a published revision says a deleted file is gone, not nothing", async ({
        page,
    }) => {
        await prepareGuestPage(page);
        await mockEditor(page, {
            files: [READY],
            manifest: [
                { fileId: "f-ready", name: "handbook.pdf", digest: "a" },
                { fileId: "f-removed", name: "old-notes.txt", digest: "b" },
            ],
        });
        await page.goto("/settings/assistants/p-1");

        const gone = page.getByTestId("knowledge-unavailable-f-removed");
        await expect(gone).toBeVisible();
        await expect(gone).toContainText("old-notes.txt");
    });

    test("every control has a name, and the file input is reachable", async ({
        page,
    }) => {
        await prepareGuestPage(page);
        await mockEditor(page);
        await page.goto("/settings/assistants/p-1");

        // The input is visually hidden behind its label, which is how a file
        // control gets a styled trigger; it must still be in the accessibility
        // tree with a name, not replaced by a click handler on a div.
        const input = page.getByTestId("knowledge-add-input");
        await expect(input).toHaveAttribute("type", "file");
        await expect(page.getByTestId("knowledge-add-label")).toBeVisible();

        // A delete button whose name is only an icon tells a screen reader
        // nothing about which file it removes.
        const remove = page.getByTestId("knowledge-remove-f-ready");
        await expect(remove).toHaveAttribute("aria-label", /handbook\.pdf/);
        await remove.focus();
        await expect(remove).toBeFocused();
    });
});
