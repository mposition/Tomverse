import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  mockChatStream,
  openModelPickerCatalogue,
  openRecentConversation,
  prepareGuestPage,
  sendChatMessage,
  type AuthenticatedQaState,
} from "./support/app-fixtures";

/**
 * Trace 2b8e03fc-4a58-44ff-8e96-346c331a67b8 (`MODEL_NOT_SELECTED`).
 *
 * Changing a panel's model from the chat header dropdown, on a conversation
 * that had already been sent a prompt in this session, produced
 * "The requested model is not selected for this conversation." before the
 * user sent anything at all: the still-set `promptPayload` was replayed onto
 * the newly selected model by ChatApp's auto-send effect, which was the one
 * send path that never awaited `onBeforeSend` (`ensureModelSettingsReady`).
 * The replayed `POST /api/chat` therefore raced -- and beat -- the
 * `PATCH /api/conversations/:id` that puts the new model into the server's
 * `Conversation.selectedModels`.
 *
 * These specs assert the ordering directly (which request ran before which,
 * with which conversation id and model id), not merely the absence of an
 * error banner.
 */

const MODEL_A = "gpt-5-4-mini";
const MODEL_B = "gemini-2-5-flash";
const MODEL_C = "claude-haiku-4-5";

type ChatCall = {
  conversationId: string | null;
  modelId: string;
  /** How many model PATCHes had been answered when this send started. */
  patchesConfirmedAtSend: number;
};

type PatchCall = {
  conversationId: string;
  selectedModels: string[];
};

type Recorder = {
  chatCalls: ChatCall[];
  patchRequests: PatchCall[];
  patchResponses: PatchCall[];
  /** Set while a PATCH is deliberately being held open. */
  holdPatch: boolean;
  releasePatch: () => void;
  chatCallsFor: (modelId: string) => ChatCall[];
};

/**
 * Records the two requests whose order is the whole contract, and lets a spec
 * hold the model PATCH open so the race is deterministic rather than timing
 * dependent.
 *
 * Registered *after* `mockAuthenticatedApi`, so these handlers win and then
 * `route.fallback()` into the fixture's own handlers -- the fixture keeps
 * storing the selection and answering with what it stored, which is what the
 * client treats as the confirmed state.
 */
async function recordModelSyncTraffic(page: Page): Promise<Recorder> {
  let patchGate: Promise<void> = Promise.resolve();
  let openGate: (() => void) | null = null;

  const recorder: Recorder = {
    chatCalls: [],
    patchRequests: [],
    patchResponses: [],
    holdPatch: false,
    releasePatch: () => {
      openGate?.();
      openGate = null;
      patchGate = Promise.resolve();
      recorder.holdPatch = false;
    },
    chatCallsFor: (modelId) =>
      recorder.chatCalls.filter((call) => call.modelId === modelId),
  };

  await page.route(
    /.*\/api\/conversations\/([A-Za-z0-9_-]+)(\?.*)?$/,
    async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.fallback();
        return;
      }
      const body = route.request().postDataJSON() as {
        selectedModels?: string[];
      };
      if (!Array.isArray(body?.selectedModels)) {
        await route.fallback();
        return;
      }
      const conversationId =
        new URL(route.request().url()).pathname.split("/").pop() || "";
      const call: PatchCall = {
        conversationId,
        selectedModels: body.selectedModels,
      };
      recorder.patchRequests.push(call);
      if (recorder.holdPatch) {
        await patchGate;
      }
      recorder.patchResponses.push(call);
      await route.fallback();
    }
  );

  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as {
      conversationId?: string;
      modelId?: string;
    };
    recorder.chatCalls.push({
      conversationId: body?.conversationId ?? null,
      modelId: body?.modelId ?? "",
      patchesConfirmedAtSend: recorder.patchResponses.length,
    });
    await route.fallback();
  });

  return Object.assign(recorder, {
    /** Arms the gate; the next PATCH is held until `releasePatch()`. */
    holdNextPatch() {
      patchGate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      recorder.holdPatch = true;
    },
  }) as Recorder & { holdNextPatch: () => void };
}

async function openSeededConversation(
  page: Page,
  selectedModels: string[],
  options: { expectPanel?: boolean } = {}
): Promise<AuthenticatedQaState> {
  await prepareGuestPage(page, "ko");
  const state = await mockAuthenticatedApi(page, {
    selectedModels,
    messages: [
      { id: "seed-user", role: "user", content: "seeded question" },
      {
        id: "seed-assistant",
        role: "assistant",
        content: "seeded answer",
        modelId: selectedModels[0],
      },
    ],
  });
  await mockChatStream(page, "QA answer");
  await page.goto("/chat?lang=ko");
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await openRecentConversation(page);
  // The seeded answer is positive evidence that the conversation has loaded.
  // Which element carries it is shell-dependent, so the desktop panel is
  // asserted only where it exists.
  await expect(
    options.expectPanel === false
      ? page.getByText("seeded answer").first()
      : page.getByTestId("desktop-model-panel").first().getByText("seeded answer")
  ).toBeVisible();
  return state;
}

test.describe("model change send barrier (desktop)", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("desktop"),
      "The per-panel model dropdown only renders in the desktop chat shell."
    );
  });

  test("a single-model conversation never sends against a model the server has not confirmed", async ({
    page,
  }, testInfo) => {
    const state = await openSeededConversation(page, [MODEL_A]);
    const recorder = (await recordModelSyncTraffic(page)) as Recorder & {
      holdNextPatch: () => void;
    };

    // 1-2. A completed turn on model A. This is what leaves a prompt payload
    // behind for a later model change to replay.
    await sendChatMessage(page, testInfo, "첫 질문입니다");
    await expect.poll(() => recorder.chatCallsFor(MODEL_A).length).toBe(1);
    await expect(
      page.getByTestId("desktop-model-panel").first().getByText("QA answer")
    ).toBeVisible();

    const chatCallsBeforeChange = recorder.chatCalls.length;

    // 3-4. The A -> B PATCH is held open, then B is picked from the dropdown.
    recorder.holdNextPatch();
    const panel = page.getByTestId("desktop-model-panel").first();
    await panel.locator("select").selectOption(MODEL_B);
    await expect(panel).toHaveAttribute("data-model-id", MODEL_B);
    await expect.poll(() => recorder.patchRequests.length).toBe(1);

    // 6. While the save is in flight nothing may be sent against B -- neither
    // a replayed payload nor anything else.
    await page.waitForTimeout(700);
    expect(recorder.chatCallsFor(MODEL_B)).toHaveLength(0);
    expect(recorder.chatCalls).toHaveLength(chatCallsBeforeChange);

    // 5. The user sends immediately after the change, still mid-PATCH.
    await sendChatMessage(page, testInfo, "모델 변경 후 질문");
    await page.waitForTimeout(400);
    expect(recorder.chatCallsFor(MODEL_B)).toHaveLength(0);

    recorder.releasePatch();

    // 7. Exactly one send against B, and only after the save was confirmed.
    await expect.poll(() => recorder.chatCallsFor(MODEL_B).length).toBe(1);
    await page.waitForTimeout(700);
    const sends = recorder.chatCallsFor(MODEL_B);
    expect(sends).toHaveLength(1);
    expect(sends[0].patchesConfirmedAtSend).toBeGreaterThanOrEqual(1);

    // 8-9. Same conversation, and the model that was actually asked for.
    expect(sends[0].conversationId).toBe("qa-conversation");
    expect(recorder.patchRequests[0].conversationId).toBe("qa-conversation");
    expect(recorder.patchRequests[0].selectedModels).toEqual([MODEL_B]);

    // The server-side state the barrier claims to have established.
    expect(state.selectedModels).toEqual([MODEL_B]);

    // 10. And no refusal was surfaced.
    await expect(page.getByText(/not selected for this conversation/i)).toHaveCount(
      0
    );
    await expect(
      page.getByText(/이 대화에 선택되지 않은 모델/i)
    ).toHaveCount(0);
  });

  test("a comparison panel's model swap holds its own composer to the same barrier", async ({
    page,
  }, testInfo) => {
    const state = await openSeededConversation(page, [MODEL_A, MODEL_C]);
    const recorder = (await recordModelSyncTraffic(page)) as Recorder & {
      holdNextPatch: () => void;
    };

    await sendChatMessage(page, testInfo, "비교 질문입니다");
    await expect.poll(() => recorder.chatCallsFor(MODEL_A).length).toBe(1);
    await expect.poll(() => recorder.chatCallsFor(MODEL_C).length).toBe(1);

    recorder.holdNextPatch();
    const panel = page.getByTestId("desktop-model-panel").first();
    await panel.locator("select").selectOption(MODEL_B);
    await expect(panel).toHaveAttribute("data-model-id", MODEL_B);
    await expect.poll(() => recorder.patchRequests.length).toBe(1);
    // Only the swapped panel moves; the untouched panel keeps its model.
    expect(recorder.patchRequests[0].selectedModels).toEqual([MODEL_B, MODEL_C]);

    await page.waitForTimeout(700);
    expect(recorder.chatCallsFor(MODEL_B)).toHaveLength(0);

    // The panel's own composer, not the global one.
    const panelInput = panel.getByTestId("model-only-input");
    await panelInput.fill("바뀐 모델에만 보냅니다");
    await panelInput.press("Enter");
    await page.waitForTimeout(400);
    expect(recorder.chatCallsFor(MODEL_B)).toHaveLength(0);

    recorder.releasePatch();

    await expect.poll(() => recorder.chatCallsFor(MODEL_B).length).toBe(1);
    await page.waitForTimeout(700);
    const sends = recorder.chatCallsFor(MODEL_B);
    expect(sends).toHaveLength(1);
    expect(sends[0].patchesConfirmedAtSend).toBeGreaterThanOrEqual(1);
    expect(sends[0].conversationId).toBe("qa-conversation");
    // The panel that was not touched must not have been re-sent to.
    expect(recorder.chatCallsFor(MODEL_C)).toHaveLength(1);
    expect(state.selectedModels).toEqual([MODEL_B, MODEL_C]);
  });

  test("A -> B -> C in one burst converges on C and never sends against an unconfirmed model", async ({
    page,
  }, testInfo) => {
    const state = await openSeededConversation(page, [MODEL_A]);
    const recorder = (await recordModelSyncTraffic(page)) as Recorder & {
      holdNextPatch: () => void;
    };

    await sendChatMessage(page, testInfo, "첫 질문입니다");
    await expect.poll(() => recorder.chatCallsFor(MODEL_A).length).toBe(1);

    const panel = page.getByTestId("desktop-model-panel").first();
    await panel.locator("select").selectOption(MODEL_B);
    await panel.locator("select").selectOption(MODEL_C);
    await expect(panel).toHaveAttribute("data-model-id", MODEL_C);

    await expect.poll(() => state.selectedModels).toEqual([MODEL_C]);
    await page.waitForTimeout(700);
    // The last change wins, and no intermediate state is left behind.
    expect(state.selectedModels).toEqual([MODEL_C]);
    // Neither B nor C may have been sent to: the user asked for no send.
    expect(recorder.chatCallsFor(MODEL_B)).toHaveLength(0);
    expect(recorder.chatCallsFor(MODEL_C)).toHaveLength(0);

    // Every send that did happen was made against a confirmed selection.
    for (const call of recorder.chatCalls) {
      expect(call.conversationId).toBe("qa-conversation");
    }
  });

  test("a model the server drops from the selection aborts the send and restores the screen", async ({
    page,
  }, testInfo) => {
    await openSeededConversation(page, [MODEL_A]);
    const recorder = await recordModelSyncTraffic(page);

    await sendChatMessage(page, testInfo, "첫 질문입니다");
    await expect.poll(() => recorder.chatCallsFor(MODEL_A).length).toBe(1);

    // The server answers the PATCH with a selection that does not contain B.
    await page.route(
      /.*\/api\/conversations\/qa-conversation(\?.*)?$/,
      async (route) => {
        if (route.request().method() !== "PATCH") {
          await route.fallback();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: "qa-conversation",
            selectedModels: [MODEL_A],
            disabledPanels: [],
          }),
        });
      }
    );

    const panel = page.getByTestId("desktop-model-panel").first();
    await panel.locator("select").selectOption(MODEL_B);
    await sendChatMessage(page, testInfo, "저장되지 않은 모델로 전송");

    // No chat request is made against a model the server did not keep, and
    // the screen recovers to the confirmed selection.
    await expect
      .poll(() => panel.getAttribute("data-model-id"), { timeout: 10_000 })
      .toBe(MODEL_A);
    expect(recorder.chatCallsFor(MODEL_B)).toHaveLength(0);
  });

  test("a pending model change never follows the user into another conversation", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "ko");
    const state = await mockAuthenticatedApi(page, {
      selectedModels: [MODEL_A],
      messages: [
        { id: "seed-user", role: "user", content: "seeded question" },
        {
          id: "seed-assistant",
          role: "assistant",
          content: "seeded answer",
          modelId: MODEL_A,
        },
      ],
      extraConversations: [
        {
          id: "qa-conversation-2",
          title: "Second QA conversation",
          selectedModels: [MODEL_C],
          messages: [
            { id: "seed-user-2", role: "user", content: "second question" },
            {
              id: "seed-assistant-2",
              role: "assistant",
              content: "second answer",
              modelId: MODEL_C,
            },
          ],
        },
      ],
    });
    await mockChatStream(page, "QA answer");
    await page.goto("/chat?lang=ko");
    await expect(page.getByTestId("chat-input")).toBeVisible();
    // Not openRecentConversation: both seeded titles contain "QA
    // conversation", so a substring filter is ambiguous here.
    await page
      .getByTestId("recent-conversation-card")
      .getByText("QA conversation", { exact: true })
      .click();
    await expect(
      page.getByTestId("desktop-model-panel").first().getByText("seeded answer")
    ).toBeVisible();

    const recorder = (await recordModelSyncTraffic(page)) as Recorder & {
      holdNextPatch: () => void;
    };
    await sendChatMessage(page, testInfo, "첫 질문입니다");
    await expect.poll(() => recorder.chatCallsFor(MODEL_A).length).toBe(1);

    recorder.holdNextPatch();
    const panel = page.getByTestId("desktop-model-panel").first();
    await panel.locator("select").selectOption(MODEL_B);
    await expect.poll(() => recorder.patchRequests.length).toBe(1);

    // Leave for the other conversation while the save is still open.
    await page
      .getByTestId("sidebar-conversation-item")
      .filter({ hasText: "Second QA conversation" })
      .first()
      .click();
    await expect(
      page.getByTestId("desktop-model-panel").first().getByText("second answer")
    ).toBeVisible();

    recorder.releasePatch();
    await page.waitForTimeout(700);

    // The held PATCH still belongs to the conversation it was made in, and
    // nothing was written to the conversation the user moved to.
    for (const call of recorder.patchRequests) {
      expect(call.conversationId).toBe("qa-conversation");
    }
    expect(state.selectedModels).toEqual([MODEL_B]);
    // And no send leaked across conversations.
    for (const call of recorder.chatCalls) {
      expect(call.conversationId).toBe("qa-conversation");
    }
  });
});

/**
 * The mobile shell has no per-panel dropdown, but it drives the same shared
 * logic the desktop dropdown does: `mutateModelSettings` -> the per
 * conversation sync queue -> `ensureModelSettingsReady` -> ChatApp's send
 * paths. The auto-send effect the desktop specs above pin lives in ChatApp,
 * which both shells mount, so this covers it from the other shell.
 */
test.describe("model change send barrier (mobile)", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("mobile"),
      "The mobile chat shell only renders in mobile projects."
    );
  });

  test("a model swapped in from the picker never replays the previous prompt", async ({
    page,
  }, testInfo) => {
    const state = await openSeededConversation(page, [MODEL_A], {
      expectPanel: false,
    });
    const recorder = (await recordModelSyncTraffic(page)) as Recorder & {
      holdNextPatch: () => void;
    };

    await sendChatMessage(page, testInfo, "첫 질문입니다");
    await expect.poll(() => recorder.chatCallsFor(MODEL_A).length).toBe(1);

    // Swap A for B through the catalogue, holding the save open.
    recorder.holdNextPatch();
    const catalogue = await openModelPickerCatalogue(page);
    await catalogue.locator(`[data-testid="model-option"][data-model-id="${MODEL_A}"]`).click();
    await catalogue.locator(`[data-testid="model-option"][data-model-id="${MODEL_B}"]`).click();
    // Escape steps back out of the catalogue first, then closes the picker.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.locator("#chat-input-popover")).toBeHidden();
    await expect.poll(() => recorder.patchRequests.length).toBeGreaterThan(0);

    // Nothing may be sent against B while its save is still open, and in
    // particular the previous prompt must not be replayed onto it.
    await page.waitForTimeout(700);
    expect(recorder.chatCallsFor(MODEL_B)).toHaveLength(0);

    recorder.releasePatch();
    await expect.poll(() => state.selectedModels).toContain(MODEL_B);
    await page.waitForTimeout(500);
    // Still nothing: the user never asked for another send.
    expect(recorder.chatCallsFor(MODEL_B)).toHaveLength(0);

    // An explicit send now goes exactly once, against the confirmed model.
    await sendChatMessage(page, testInfo, "모델 변경 후 질문");
    await expect.poll(() => recorder.chatCallsFor(MODEL_B).length).toBe(1);
    await page.waitForTimeout(700);
    const sends = recorder.chatCallsFor(MODEL_B);
    expect(sends).toHaveLength(1);
    expect(sends[0].conversationId).toBe("qa-conversation");
    expect(sends[0].patchesConfirmedAtSend).toBeGreaterThanOrEqual(1);
  });
});
