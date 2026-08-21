import { expect, test, type Page } from "@playwright/test";
import {
    mockAuthenticatedApi,
    mockChatStream,
    sendChatMessage,
} from "./support/app-fixtures";

/**
 * Trace 627e9859-c57d-42e1-9928-c973278636c3 (`MODEL_NOT_SELECTED`), found in
 * the Release C staging round.
 *
 * `docs/policy/external-conversation-import-and-memory.md` §14.0 has a *new*
 * conversation adopt its assistant's models, so a create
 * that carries a profile id comes back with a model list the caller did not
 * send -- `app/api/conversations/route.ts` lets the profile's models win over
 * `body.selectedModels`. The client seeded its sync queue with what it had
 * sent instead of what came back, marking an already-replaced list as
 * "server-confirmed"; the send barrier then found nothing to reconcile and
 * the same turn's `POST /api/chat` named a model the conversation did not
 * have. Every conversation started with an assistant failed on its first
 * turn, and retrying could not clear it because the screen never learned the
 * real list.
 *
 * The assertions are on which model each chat request names -- the thing the
 * server actually checks -- rather than on the absence of an error banner.
 */

const PROFILES = [
    {
        id: "p-scheduler",
        name: "Scheduling helper",
        icon: "🧭",
        description: "Answers scheduling questions.",
        published: true,
        currentRevision: 3,
    },
];

/** What the composer starts on, and what the profile answers on instead. */
const COMPOSER_MODEL = "gpt-5-6-luna";
const PROFILE_MODEL = "gemini-2-5-flash";

/**
 * The comparison shape of the same disagreement: a composer holding two
 * models, and a profile that answers on two different ones.
 */
const COMPARISON_COMPOSER_MODELS = ["gpt-5-6-luna", "claude-haiku-4-5"];
const COMPARISON_PROFILE_MODELS = ["gemini-2-5-flash", "deepseek-v4-flash"];

const CREATED_ID = "c-created-with-assistant";

type Recorder = { chatModelIds: string[]; createRequests: unknown[] };

/**
 * Stands in for the create endpoint's §14.0 behaviour: the request's own
 * `selectedModels` is discarded and the profile's list is returned.
 *
 * Registered after `mockAuthenticatedApi` so this handler wins for POST and
 * falls through to the fixture for everything else.
 */
async function recordProfileCreate(page: Page): Promise<Recorder> {
    const recorder: Recorder = { chatModelIds: [], createRequests: [] };

    await page.route("**/api/conversations", async (route) => {
        if (route.request().method() !== "POST") {
            await route.fallback();
            return;
        }
        const body = route.request().postDataJSON() as {
            assistantProfileId?: string;
        };
        recorder.createRequests.push(body);
        if (!body?.assistantProfileId) {
            await route.fallback();
            return;
        }
        await route.fulfill({
            status: 201,
            contentType: "application/json",
            body: JSON.stringify({
                id: CREATED_ID,
                title: "QA",
                kind: "chat",
                projectId: null,
                selectedModels: [PROFILE_MODEL],
                disabledPanels: [],
                webSearchMode: "off",
                isLocked: false,
                shareEnabled: false,
                shareExpiresAt: null,
                messageCount: 0,
                assistantProfile: {
                    profileId: "p-scheduler",
                    name: "Scheduling helper",
                    icon: "🧭",
                    revision: 3,
                    latestRevision: 3,
                    status: "current",
                },
            }),
        });
    });

    await page.route("**/api/chat", async (route) => {
        if (route.request().method() !== "POST") {
            await route.fallback();
            return;
        }
        const body = route.request().postDataJSON() as { modelId?: string };
        if (typeof body?.modelId === "string") {
            recorder.chatModelIds.push(body.modelId);
        }
        await route.fallback();
    });

    return recorder;
}

test.describe("a conversation started with an assistant", () => {
    test("sends its first turn on the assistant's model, not the composer's", async ({
        page,
    }, testInfo) => {
        await mockAuthenticatedApi(page, {
            assistantProfiles: PROFILES,
            selectedModels: [COMPOSER_MODEL],
        });
        await mockChatStream(page, "Assistant QA response");
        const recorder = await recordProfileCreate(page);

        // The new-conversation screen: no server row yet, which is the branch
        // where the choice is held and sent with the create.
        await page.goto("/chat");
        await expect(page.getByTestId("chat-input")).toBeVisible();

        await page.locator('button[aria-controls="chat-input-popover"]').first().click();
        await page.getByTestId("tools-assistant-row").click();
        await page.getByTestId("assistant-option-p-scheduler").click();
        await page.keyboard.press("Escape");
        await expect(page.locator("#chat-input-popover")).toBeHidden();

        await sendChatMessage(page, testInfo, "안녕");

        await expect
            .poll(() => recorder.createRequests.length, { timeout: 10_000 })
            .toBeGreaterThan(0);
        await expect
            .poll(() => recorder.chatModelIds.length, { timeout: 15_000 })
            .toBeGreaterThan(0);

        // The create carried the profile, so the server chose the models.
        expect(recorder.createRequests).toHaveLength(1);
        expect(recorder.createRequests[0]).toHaveProperty(
            "assistantProfileId",
            "p-scheduler"
        );
        // Every chat request this turn names the adopted model. Naming the
        // composer's own is what the server answered 403 to.
        expect(recorder.chatModelIds).toEqual([PROFILE_MODEL]);
        expect(recorder.chatModelIds).not.toContain(COMPOSER_MODEL);
    });

    test("keeps the adopted model for the next turn too", async ({
        page,
    }, testInfo) => {
        await mockAuthenticatedApi(page, {
            assistantProfiles: PROFILES,
            selectedModels: [COMPOSER_MODEL],
        });
        await mockChatStream(page, "Assistant QA response");
        const recorder = await recordProfileCreate(page);

        await page.goto("/chat");
        await expect(page.getByTestId("chat-input")).toBeVisible();

        await page.locator('button[aria-controls="chat-input-popover"]').first().click();
        await page.getByTestId("tools-assistant-row").click();
        await page.getByTestId("assistant-option-p-scheduler").click();
        await page.keyboard.press("Escape");
        await expect(page.locator("#chat-input-popover")).toBeHidden();

        await sendChatMessage(page, testInfo, "안녕");
        await expect
            .poll(() => recorder.chatModelIds.length, { timeout: 15_000 })
            .toBe(1);

        // The second turn is the one that shows whether the screen itself
        // learned the adopted list, or only this one send was corrected. A
        // screen still holding the replaced model fails here the same way the
        // first turn used to.
        await sendChatMessage(page, testInfo, "또 안녕");
        await expect
            .poll(() => recorder.chatModelIds.length, { timeout: 15_000 })
            .toBe(2);
        expect(recorder.chatModelIds).toEqual([PROFILE_MODEL, PROFILE_MODEL]);
    });
});

/**
 * The comparison path has its own door onto the same mistake.
 *
 * `/api/chat/preflight` prices the set and hands back the admission slots for
 * it, and it refuses models the conversation does not have -- "One or more
 * comparison models are not selected for this conversation."
 * (`app/api/chat/preflight/route.ts`). It runs before the chat requests, so
 * correcting only those left this call reading the screen's stale list: a
 * conversation created with an assistant refused its first turn here instead,
 * one error code further up. Trace 9219480c-6ad3-49ae-8120-8a31ee18513e.
 */
test.describe("a comparison started with an assistant", () => {
    test("prices the assistant's models, not the composer's", async ({
        page,
    }, testInfo) => {
        await mockAuthenticatedApi(page, {
            assistantProfiles: PROFILES,
            selectedModels: COMPARISON_COMPOSER_MODELS,
        });
        await mockChatStream(page, "Assistant QA response");

        // The new-conversation screen starts from the account's saved
        // combination, and it takes two models to reach the comparison path
        // at all.
        await page.route("**/api/user/settings", async (route) => {
            if (route.request().method() !== "GET") {
                await route.fallback();
                return;
            }
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    theme: "system",
                    language: "ko",
                    defaultModel: COMPARISON_COMPOSER_MODELS[0],
                    newConversationModelIds: COMPARISON_COMPOSER_MODELS,
                }),
            });
        });

        const preflightModelIds: string[][] = [];
        await page.route("**/api/chat/preflight", async (route) => {
            if (route.request().method() !== "POST") {
                await route.fallback();
                return;
            }
            const body = route.request().postDataJSON() as {
                modelIds?: string[];
            };
            if (Array.isArray(body?.modelIds)) {
                preflightModelIds.push(body.modelIds);
            }
            await route.fallback();
        });

        await page.route("**/api/conversations", async (route) => {
            if (route.request().method() !== "POST") {
                await route.fallback();
                return;
            }
            const body = route.request().postDataJSON() as {
                assistantProfileId?: string;
            };
            if (!body?.assistantProfileId) {
                await route.fallback();
                return;
            }
            await route.fulfill({
                status: 201,
                contentType: "application/json",
                body: JSON.stringify({
                    id: CREATED_ID,
                    title: "QA",
                    kind: "chat",
                    projectId: null,
                    selectedModels: COMPARISON_PROFILE_MODELS,
                    disabledPanels: [],
                    webSearchMode: "off",
                    isLocked: false,
                    shareEnabled: false,
                    shareExpiresAt: null,
                    messageCount: 0,
                    assistantProfile: {
                        profileId: "p-scheduler",
                        name: "Scheduling helper",
                        icon: "🧭",
                        revision: 3,
                        latestRevision: 3,
                        status: "current",
                    },
                }),
            });
        });

        await page.goto("/chat");
        await expect(page.getByTestId("chat-input")).toBeVisible();

        await page.locator('button[aria-controls="chat-input-popover"]').first().click();
        await page.getByTestId("tools-assistant-row").click();
        await page.getByTestId("assistant-option-p-scheduler").click();
        await page.keyboard.press("Escape");
        await expect(page.locator("#chat-input-popover")).toBeHidden();

        await sendChatMessage(page, testInfo, "안녕");

        await expect
            .poll(() => preflightModelIds.length, { timeout: 15_000 })
            .toBeGreaterThan(0);
        // Asking admission for models the conversation does not have is what
        // the server refuses; every call names the adopted set instead.
        for (const modelIds of preflightModelIds) {
            expect([...modelIds].sort()).toEqual(
                [...COMPARISON_PROFILE_MODELS].sort()
            );
        }
    });
});
