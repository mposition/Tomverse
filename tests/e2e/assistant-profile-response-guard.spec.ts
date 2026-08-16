import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  mockChatStream,
  prepareGuestPage,
  sendChatMessage,
} from "./support/app-fixtures";

/**
 * The assistant-profile PATCH answers long after the click that sent it, and
 * its response handler used to apply unconditionally.
 *
 * The damage that made this worth its own spec: a profile change made in one
 * conversation, answered after the user had moved to another, wrote the first
 * conversation's `selectedModels` onto the screen of the second. The send
 * barrier then treats the screen as the state to confirm, so the *second*
 * conversation's stored selection was overwritten with the first one's -- with
 * no error shown, and surviving a reload. Reproduced against 5528317.
 *
 * The response now updates the profile only, and only when it still describes
 * the state the user is looking at. These specs pin both halves: the guard,
 * and the fact that a profile change still costs no model-settings PATCH.
 */

const MODEL_X = "gpt-5-4-mini";
const MODEL_Y = "claude-haiku-4-5";
const MODEL_Z = "gemini-2-5-flash";

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
    id: "p-editor",
    name: "Copy editor",
    icon: "✏️",
    description: "Tightens prose.",
    published: true,
    currentRevision: 2,
  },
];

const toolsMenuTrigger = (page: Page) =>
  page.locator('button[aria-controls="chat-input-popover"]').nth(0);

type Traffic = {
  /** Every PATCH that carried a model selection, by conversation id. */
  modelPatches: Array<{ conversationId: string; selectedModels: string[] }>;
  profilePatches: Array<{ conversationId: string; profileId: string | null }>;
};

async function recordTraffic(page: Page): Promise<Traffic> {
  const traffic: Traffic = { modelPatches: [], profilePatches: [] };
  await page.route(
    /.*\/api\/conversations\/([A-Za-z0-9_-]+)(\?.*)?$/,
    async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.fallback();
        return;
      }
      const body = route.request().postDataJSON() as {
        selectedModels?: string[];
        assistantProfileId?: string | null;
      };
      const conversationId =
        new URL(route.request().url()).pathname.split("/").pop() || "";
      if (Array.isArray(body?.selectedModels)) {
        traffic.modelPatches.push({
          conversationId,
          selectedModels: body.selectedModels,
        });
      }
      if (body?.assistantProfileId !== undefined) {
        traffic.profilePatches.push({
          conversationId,
          profileId: body.assistantProfileId,
        });
      }
      await route.fallback();
    }
  );
  return traffic;
}

/**
 * Holds every profile PATCH for `conversationId` open until release().
 *
 * `staleSelectedModels` makes the held response carry the selection as it was
 * when the request was made, which is what a genuinely slow response carries:
 * the server answered from the state at the time it processed the request, not
 * from whatever the user has done since. Falling back to the fixture instead
 * would compose the body at release time and quietly hide every staleness bug.
 */
async function holdProfilePatches(
  page: Page,
  conversationId: string,
  options: { staleSelectedModels?: string[]; staleProfileName?: string } = {}
) {
  let open: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  await page.route(
    new RegExp(`.*/api/conversations/${conversationId}(\\?.*)?$`),
    async (route) => {
      const body = route.request().postDataJSON() as {
        assistantProfileId?: string | null;
      };
      if (
        route.request().method() !== "PATCH" ||
        body?.assistantProfileId === undefined
      ) {
        await route.fallback();
        return;
      }
      await gate;
      if (!options.staleSelectedModels) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: conversationId,
          selectedModels: options.staleSelectedModels,
          disabledPanels: [],
          assistantProfile: {
            profileId: "p-scheduler",
            name: options.staleProfileName ?? "Scheduling helper",
            icon: "🧭",
            revision: 3,
            latestRevision: 3,
            status: "current",
          },
        }),
      });
    }
  );
  return () => open?.();
}

async function chooseProfile(page: Page, profileId: string) {
  await toolsMenuTrigger(page).click();
  await page.getByTestId("tools-assistant-row").click();
  await page.getByTestId(`assistant-option-${profileId}`).click();
  // Step out of the assistant list, then close the popover.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator("#chat-input-popover")).toBeHidden();
}

const panelModelIds = (page: Page) =>
  page
    .getByTestId("desktop-model-panel")
    .evaluateAll((panels) =>
      panels.map((panel) => panel.getAttribute("data-model-id"))
    );

async function openTwoConversations(page: Page) {
  await prepareGuestPage(page, "en");
  const state = await mockAuthenticatedApi(page, {
    selectedModels: [MODEL_X],
    assistantProfiles: PROFILES,
    messages: [
      { id: "u1", role: "user", content: "first question" },
      {
        id: "a1",
        role: "assistant",
        content: "first answer",
        modelId: MODEL_X,
      },
    ],
    extraConversations: [
      {
        id: "qa-conversation-2",
        title: "Second chat",
        selectedModels: [MODEL_Y],
        messages: [
          { id: "u2", role: "user", content: "second question" },
          {
            id: "a2",
            role: "assistant",
            content: "second answer",
            modelId: MODEL_Y,
          },
        ],
      },
    ],
  });
  await mockChatStream(page, "QA answer");
  await page.goto("/chat?lang=en");
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await page
    .getByTestId("recent-conversation-card")
    .getByText("QA conversation", { exact: true })
    .click();
  await expect(page.getByText("first answer").first()).toBeVisible();
  return state;
}

const openSecondChat = async (page: Page) => {
  await page
    .getByTestId("sidebar-conversation-item")
    .filter({ hasText: "Second chat" })
    .first()
    .click();
  await expect(page.getByText("second answer").first()).toBeVisible();
};

const openFirstChat = async (page: Page) => {
  await page
    .getByTestId("sidebar-conversation-item")
    .filter({ hasText: "QA conversation" })
    .first()
    .click();
  await expect(page.getByText("first answer").first()).toBeVisible();
};

test.describe("assistant profile response guard", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("desktop"),
      "Asserts on the desktop model panels."
    );
  });

  test("a profile response that arrives after a conversation switch changes nothing in the conversation the user moved to", async ({
    page,
  }, testInfo) => {
    const state = await openTwoConversations(page);
    const traffic = await recordTraffic(page);
    const release = await holdProfilePatches(page, "qa-conversation", {
      staleSelectedModels: [MODEL_X],
    });

    await chooseProfile(page, "p-scheduler");
    await openSecondChat(page);
    expect(await panelModelIds(page)).toEqual([MODEL_Y]);

    release();
    await page.waitForTimeout(800);

    // The first conversation's models never reach the second one's screen...
    expect(await panelModelIds(page)).toEqual([MODEL_Y]);
    // ...nor its stored settings, before or after a send.
    expect(traffic.modelPatches).toHaveLength(0);

    await sendChatMessage(page, testInfo, "in the second chat");
    await page.waitForTimeout(1200);
    expect(
      traffic.modelPatches.filter(
        (patch) => patch.conversationId === "qa-conversation-2"
      )
    ).toHaveLength(0);
    // The conversation the profile was actually for is untouched too.
    expect(state.selectedModels).toEqual([MODEL_X]);
  });

  test("a profile response for a conversation the user left and returned to does not overwrite the newer state", async ({
    page,
  }) => {
    const state = await openTwoConversations(page);
    const traffic = await recordTraffic(page);
    const release = await holdProfilePatches(page, "qa-conversation", {
      staleSelectedModels: [MODEL_X],
    });

    await chooseProfile(page, "p-scheduler");
    await openSecondChat(page);
    await openFirstChat(page);
    // Back in the first conversation, re-seeded from the server.
    expect(await panelModelIds(page)).toEqual([MODEL_X]);

    // A change made after the return, which the held response predates.
    const panel = page.getByTestId("desktop-model-panel").first();
    await panel.locator("select").selectOption(MODEL_Z);
    await expect.poll(() => state.selectedModels).toEqual([MODEL_Z]);

    release();
    await page.waitForTimeout(800);

    // The response is older than the return *and* older than the change, so
    // it may not put the pre-change selection back.
    expect(await panelModelIds(page)).toEqual([MODEL_Z]);
    expect(state.selectedModels).toEqual([MODEL_Z]);
    expect(traffic.modelPatches).toEqual([
      { conversationId: "qa-conversation", selectedModels: [MODEL_Z] },
    ]);
  });

  test("two profile changes in a row leave the last one in effect", async ({
    page,
  }) => {
    await openTwoConversations(page);
    const traffic = await recordTraffic(page);

    await chooseProfile(page, "p-scheduler");
    await chooseProfile(page, "p-editor");
    await page.waitForTimeout(900);

    // Both requests are sent, in order, and the row settles on the last one.
    expect(traffic.profilePatches.map((patch) => patch.profileId)).toEqual([
      "p-scheduler",
      "p-editor",
    ]);
    // The row only exists inside the tools popover, so it has to be reopened
    // to be read.
    await toolsMenuTrigger(page).click();
    await expect(page.getByTestId("tools-assistant-row")).toContainText(
      "Copy editor"
    );
    await page.keyboard.press("Escape");
    expect(traffic.modelPatches).toHaveLength(0);
  });

  test("a model change made while a profile change is pending is not reverted", async ({
    page,
  }) => {
    const state = await openTwoConversations(page);
    const traffic = await recordTraffic(page);
    const release = await holdProfilePatches(page, "qa-conversation", {
      staleSelectedModels: [MODEL_X],
    });

    await chooseProfile(page, "p-scheduler");

    const panel = page.getByTestId("desktop-model-panel").first();
    await panel.locator("select").selectOption(MODEL_Z);
    await expect(panel).toHaveAttribute("data-model-id", MODEL_Z);
    await expect.poll(() => state.selectedModels).toEqual([MODEL_Z]);

    release();
    await page.waitForTimeout(800);

    // The profile response must not put the pre-change selection back.
    expect(await panelModelIds(page)).toEqual([MODEL_Z]);
    expect(state.selectedModels).toEqual([MODEL_Z]);
    expect(state.disabledPanels).toEqual([]);
    // Exactly the one PATCH the model change itself needed.
    expect(traffic.modelPatches).toEqual([
      { conversationId: "qa-conversation", selectedModels: [MODEL_Z] },
    ]);
  });

  test("applying a profile costs no model-settings PATCH, before or after the next send", async ({
    page,
  }, testInfo) => {
    const state = await openTwoConversations(page);
    const traffic = await recordTraffic(page);

    await chooseProfile(page, "p-scheduler");
    await page.waitForTimeout(800);
    expect(traffic.modelPatches).toHaveLength(0);

    await sendChatMessage(page, testInfo, "after the profile");
    await page.waitForTimeout(1200);
    // The queue's confirmed state still matches the screen, so the send
    // barrier has nothing to write.
    expect(traffic.modelPatches).toHaveLength(0);
    expect(state.selectedModels).toEqual([MODEL_X]);
    expect(traffic.profilePatches).toHaveLength(1);
  });
});
