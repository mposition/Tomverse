import { expect, test, type Page } from "@playwright/test";
import {
    mockAuthenticatedApi,
    openRecentConversation,
} from "./support/app-fixtures";

/**
 * Policy: docs/policy/external-conversation-import-and-memory.md.
 * §14's version pinning, from the composer (Release C, slice C4).
 *
 * The server side is covered by unit and DB suites. What only a browser can
 * show is the part that decides whether the pinning rule is legible:
 *
 *   1. a guest, and an account with the feature off, are never offered the
 *      control at all — absent rather than disabled, because a disabled
 *      control implies there is something there to enable;
 *   2. choosing an assistant reaches the server as a profile id, never as a
 *      version id, and the row then reports the revision the *server* pinned;
 *   3. a conversation the owner has published past says which revision it is
 *      on and offers the move, instead of quietly moving itself.
 *
 * Runs on the desktop and mobile projects alike: nothing here is decided by
 * shell, and the tools menu is the same surface in both.
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
    {
        id: "p-draft",
        name: "Unfinished",
        icon: null,
        description: null,
        published: false,
        currentRevision: null,
    },
];

const boundProfile = (
    overrides: Partial<{
        revision: number;
        latestRevision: number;
        status: "current" | "superseded";
    }> = {}
) => ({
    profileId: "p-scheduler",
    name: "Scheduling helper",
    icon: "🧭" as string | null,
    revision: 3,
    latestRevision: 3,
    status: "current" as "current" | "superseded",
    ...overrides,
});

const toolsMenuTrigger = (page: Page) =>
    page.locator('button[aria-controls="chat-input-popover"]').nth(0);

const openAssistantMenu = async (page: Page) => {
    await toolsMenuTrigger(page).click();
    await page.getByTestId("tools-assistant-row").click();
};

test("a guest is never offered an assistant", async ({ page }) => {
    // A guest has no profile of their own for the control to act on (§14).
    await page.goto("/chat?lang=en");

    await toolsMenuTrigger(page).click();
    await expect(page.getByTestId("tools-assistant-row")).toHaveCount(0);
});

test("an account with the feature off is not offered one either", async ({
    page,
}) => {
    // The flag is read by the list refusing, not by a second endpoint. A 403
    // and a failed request end in the same place, which is the point.
    await mockAuthenticatedApi(page);
    await page.route("**/api/assistant-profiles", async (route) => {
        await route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({ code: "ASSISTANT_PROFILES_DISABLED" }),
        });
    });
    await page.goto("/chat?lang=en");
    await openRecentConversation(page);

    await toolsMenuTrigger(page).click();
    await expect(page.getByTestId("tools-assistant-row")).toHaveCount(0);
});

test("a conversation with no assistant says so", async ({ page }) => {
    await mockAuthenticatedApi(page, { assistantProfiles: PROFILES });
    await page.goto("/chat?lang=en");
    await openRecentConversation(page);

    await toolsMenuTrigger(page).click();
    await expect(page.getByTestId("tools-assistant-row")).toContainText(
        "No assistant"
    );
});

test("only published profiles are selectable", async ({ page }) => {
    // A draft cannot start a conversation, so offering it would be offering a
    // choice the server refuses on click.
    await mockAuthenticatedApi(page, { assistantProfiles: PROFILES });
    await page.goto("/chat?lang=en");
    await openRecentConversation(page);

    await openAssistantMenu(page);
    await expect(page.getByTestId("assistant-option-p-scheduler")).toBeVisible();
    await expect(page.getByTestId("assistant-option-p-draft")).toHaveCount(0);
});

test("choosing one sends a profile id and shows the revision the server pinned", async ({
    page,
}) => {
    await mockAuthenticatedApi(page, { assistantProfiles: PROFILES });
    const patched: Array<Record<string, unknown>> = [];
    await page.route("**/api/conversations/*", async (route) => {
        if (route.request().method() === "PATCH") {
            patched.push(
                route.request().postDataJSON() as Record<string, unknown>
            );
        }
        await route.fallback();
    });
    await page.goto("/chat?lang=en");
    await openRecentConversation(page);

    await openAssistantMenu(page);
    await page.getByTestId("assistant-option-p-scheduler").click();

    await expect
        .poll(() => patched.length, { timeout: 5_000 })
        .toBeGreaterThan(0);
    // A profile, never a version: the server is the only party that knows
    // which revision is current.
    expect(patched[0]).toHaveProperty("assistantProfileId", "p-scheduler");
    expect(patched[0]).not.toHaveProperty("assistantProfileVersionId");

    // The row reports the revision the fixture pinned, which is also the
    // assertion that the PATCH round-tripped rather than the menu repainting
    // itself from what it just sent.
    await toolsMenuTrigger(page).click();
    await expect(page.getByTestId("tools-assistant-row")).toContainText(
        "Scheduling helper"
    );
    await expect(page.getByTestId("tools-assistant-row")).toContainText(
        "Revision 3"
    );
});

test("a superseded conversation states its revision and offers the move", async ({
    page,
}) => {
    // §14: the conversation keeps answering under the revision it started
    // with. The screen offers a move; nothing performs one.
    await mockAuthenticatedApi(page, {
        assistantProfiles: PROFILES,
        assistantProfile: boundProfile({ revision: 1, status: "superseded" }),
    });
    await page.goto("/chat?lang=en");
    await openRecentConversation(page);

    await toolsMenuTrigger(page).click();
    await expect(page.getByTestId("tools-assistant-row")).toContainText(
        "Revision 1"
    );
    await expect(
        page.getByTestId("tools-assistant-superseded-dot")
    ).toBeVisible();

    await page.getByTestId("tools-assistant-row").click();
    await expect(page.getByTestId("assistant-move-to-latest")).toContainText(
        "newest revision"
    );
});

test("detaching is always available, including with nothing published", async ({
    page,
}) => {
    // A rollout control must not leave an account holding a conversation it
    // cannot take the assistant off.
    await mockAuthenticatedApi(page, {
        assistantProfiles: [],
        assistantProfile: boundProfile(),
    });
    await page.goto("/chat?lang=en");
    await openRecentConversation(page);

    await openAssistantMenu(page);
    await expect(page.getByTestId("assistant-options-empty")).toBeVisible();
    await expect(page.getByTestId("assistant-option-none")).toBeVisible();
});

/* ------------------------------------------- discovery from the composer */

/**
 * The picker used to be a dead end when it was empty: a sentence saying a
 * profile could be made "in settings", and no way to get there. These cover
 * the two links that replaced it and, more importantly, the boundaries they
 * must not cross — a guest never sees them, and neither does an account with
 * the feature off, because both are refused before the picker exists at all.
 */

test("the empty picker offers creating one instead of describing it", async ({
    page,
}) => {
    await mockAuthenticatedApi(page, { assistantProfiles: [] });
    await page.goto("/chat?lang=en");
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await openAssistantMenu(page);

    const create = page.getByTestId("assistant-create-cta");
    await expect(create).toBeVisible();
    await expect(create).toHaveAttribute(
        "href",
        "/settings/assistants/new?from=chat"
    );
    // Managing is offered too, but creating is the one carrying the emphasis
    // when there is nothing to manage.
    await expect(page.getByTestId("assistant-manage-cta")).toBeVisible();
});

test("the CTAs stay available once profiles exist", async ({ page }) => {
    await mockAuthenticatedApi(page, { assistantProfiles: PROFILES });
    await page.goto("/chat?lang=en");
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await openAssistantMenu(page);

    await expect(page.getByTestId("assistant-option-p-scheduler")).toBeVisible();
    await expect(page.getByTestId("assistant-create-cta")).toBeVisible();
    // Straight to the settings tab that manages them, which keeps the visitor
    // inside the surface they were already in.
    await expect(page.getByTestId("assistant-manage-cta")).toHaveAttribute(
        "href",
        "/chat?settings=assistants&settingsSection=assistants"
    );
});

test("a guest is offered neither CTA, because the picker never opens", async ({
    page,
}) => {
    await page.goto("/chat?lang=en");
    await toolsMenuTrigger(page).click();
    await expect(page.getByTestId("tools-assistant-row")).toHaveCount(0);
    await expect(page.getByTestId("assistant-create-cta")).toHaveCount(0);
    await expect(page.getByTestId("assistant-manage-cta")).toHaveCount(0);
});

test("the feature being off hides the CTAs with the picker", async ({
    page,
}) => {
    await mockAuthenticatedApi(page);
    await page.route("**/api/assistant-profiles", async (route) => {
        await route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({
                error: "Assistant profiles are not enabled.",
                code: "ASSISTANT_PROFILES_DISABLED",
            }),
        });
    });
    await page.goto("/chat?lang=en");
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await toolsMenuTrigger(page).click();
    await expect(page.getByTestId("assistant-create-cta")).toHaveCount(0);
    await expect(page.getByTestId("assistant-manage-cta")).toHaveCount(0);
});

test("the create CTA is reachable and activatable from the keyboard", async ({
    page,
}) => {
    await mockAuthenticatedApi(page, { assistantProfiles: [] });
    await page.goto("/chat?lang=en");
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await openAssistantMenu(page);

    const create = page.getByTestId("assistant-create-cta");
    await expect(create).toBeVisible();
    // Opening a view schedules one animation frame that moves focus into the
    // sheet -- the sheet itself where the pointer is coarse, its first
    // control where it is not. Until that frame runs the active element is
    // still the body, so a focus() issued before it is handed straight back
    // and never returns. Which side of the frame the test lands on is the
    // runner's decision, not the product's: it has never lost on a developer
    // machine and lost three times in a row on a frame-starved CI runner.
    // Wait for the sheet to take focus, then take it from the sheet.
    await expect
        .poll(() =>
            page.evaluate(() => {
                const popover = document.getElementById("chat-input-popover");
                const active = document.activeElement;
                return Boolean(popover && active && popover.contains(active));
            })
        )
        .toBe(true);
    await create.focus();
    await expect(create).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/settings\/assistants\/new\?from=chat$/);
});

test("following a CTA closes the tools menu behind it", async ({ page }) => {
    await mockAuthenticatedApi(page, { assistantProfiles: PROFILES });
    await page.goto("/chat?lang=en");
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await openAssistantMenu(page);

    await page.getByTestId("assistant-manage-cta").click();
    await expect(page).toHaveURL(/settings=assistants/);
    // The menu is a portal over the chat; leaving it open would sit above the
    // page that was navigated to.
    await expect(page.getByTestId("tools-assistant-row")).toHaveCount(0);
});
