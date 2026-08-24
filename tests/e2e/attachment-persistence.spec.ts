import { expect, test, type Page } from "@playwright/test";
import {
  createQaPdfBuffer,
  createQaPngBuffer,
  createQaXlsxBuffer,
  mockAttachmentUpload,
  mockAuthenticatedApi,
  mockChatStream,
  openRecentConversation,
  prepareGuestPage,
  type AttachmentUploadQaState,
} from "./support/app-fixtures";

/**
 * docs/policy/user-attachment-persistence.md.
 *
 * The defect these cover had three faces and one cause: the attachment lived
 * only in browser memory. The card vanished on reload, a file-only turn was
 * stored as the file names joined with commas, and no later turn could read
 * the file again. The fixture models the real contract -- finalisation issues
 * an opaque id, the message save binds it, the conversation read returns
 * public metadata -- so a regression that went back to key-passing or to
 * dropping the ids fails here rather than in production.
 */

const XLSX_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const actionMenuTrigger = (page: Page) =>
  page.locator('button[aria-controls="chat-input-popover"]').first();

async function attachFromComputer(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer }
) {
  await actionMenuTrigger(page).click();
  await page.getByTestId("tools-attach-row").click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByTestId("attach-local-file-row").click();
  const chooser = await chooserPromise;
  await chooser.setFiles(file);
}

const sendButton = (page: Page) =>
  page.getByRole("button", { name: /전송|Send|发送/ });

const userTurn = (page: Page) => page.locator('[data-message-role="user"]');

/** How many of a request's messages name one attachment handle. */
const attachmentHandleCount = (body: string, handle: string) => {
  const parsed = JSON.parse(body) as {
    messages: Array<{ attachments?: Array<Record<string, unknown>> }>;
  };
  return parsed.messages.flatMap((message) => message.attachments ?? []).filter(
    (attachment) =>
      attachment.attachmentId === handle || attachment.uploadId === handle
  ).length;
};

/** The turn a request is actually asking about: its last user message. */
const newestUserTurn = (body: string) => {
  const parsed = JSON.parse(body) as {
    messages: Array<{
      role: string;
      attachments?: Array<Record<string, unknown>>;
    }>;
  };
  return [...parsed.messages].reverse().find((message) => message.role === "user")!;
};

test.describe("user attachment persistence", () => {
  let uploadState: AttachmentUploadQaState;
  let saveRequests: Array<Record<string, unknown>>;

  test.beforeEach(async ({ page }) => {
    saveRequests = [];
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    uploadState = await mockAttachmentUpload(page);
    await mockChatStream(page, "첨부 확인했습니다.");
    // Recorded rather than asserted from the outside: what the save carries is
    // the contract this whole change is about.
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().includes("/messages")
      ) {
        const body = request.postDataJSON() as {
          messages?: Array<Record<string, unknown>>;
        };
        saveRequests.push(...(body?.messages ?? []));
      }
    });
    await page.goto("/chat");
    await expect(page.getByTestId("chat-input")).toBeVisible();
  });

  test("the card is there immediately after sending", async ({ page }) => {
    await attachFromComputer(page, {
      name: "명단.xlsx",
      mimeType: XLSX_TYPE,
      buffer: createQaXlsxBuffer(),
    });
    await expect(page.getByText("명단.xlsx", { exact: true })).toBeVisible();

    await page.getByTestId("chat-textarea").fill("이 명단 확인해 주세요");
    await sendButton(page).click();

    await expect(
      userTurn(page).filter({ hasText: "명단.xlsx" })
    ).toBeVisible();
    await expect(page.getByText("첨부 확인했습니다.")).toBeVisible();
  });

  // The save is where the persistence happens, and what it carries is the
  // whole security posture: an opaque id, never a storage key.
  test("the save names an opaque upload id and no storage key", async ({ page }) => {
    await attachFromComputer(page, {
      name: "보고서.pdf",
      mimeType: "application/pdf",
      buffer: createQaPdfBuffer(),
    });
    await expect(page.getByText("보고서.pdf", { exact: true })).toBeVisible();
    await page.getByTestId("chat-textarea").fill("요약해 주세요");
    await sendButton(page).click();
    await expect(page.getByText("첨부 확인했습니다.")).toBeVisible();

    await expect.poll(() => saveRequests.length).toBeGreaterThan(0);
    const saved = saveRequests[0];
    expect(saved.attachmentUploadIds).toEqual(uploadState.uploadIds);
    const serialised = JSON.stringify(saveRequests);
    expect(serialised).not.toContain("attachments/");
    expect(serialised).not.toContain("objectKey");
    expect(serialised).not.toContain("data:application/pdf");
  });

  // The defect in its purest form: a message that *was* the file names.
  test("a file-only turn is saved with empty text, not with its file names", async ({
    page,
  }) => {
    await attachFromComputer(page, {
      name: "계약서.pdf",
      mimeType: "application/pdf",
      buffer: createQaPdfBuffer(),
    });
    await expect(page.getByText("계약서.pdf", { exact: true })).toBeVisible();
    await sendButton(page).click();
    await expect(page.getByText("첨부 확인했습니다.")).toBeVisible();

    await expect.poll(() => saveRequests.length).toBeGreaterThan(0);
    expect(saveRequests[0].content).toBe("");
    expect(String(saveRequests[0].content)).not.toContain("계약서.pdf");
  });

  test("removing a draft file names the upload id, never a key", async ({ page }) => {
    await attachFromComputer(page, {
      name: "지울파일.png",
      mimeType: "image/png",
      buffer: createQaPngBuffer(),
    });
    await expect(page.getByAltText("지울파일.png")).toBeVisible();

    await page
      .getByRole("button", { name: /제거|Remove|移除/ })
      .first()
      .click();

    await expect(page.getByAltText("지울파일.png")).toBeHidden();
    await expect.poll(() => uploadState.deleteCount).toBe(1);
    expect(uploadState.deletedUploadIds[0]).toBe(uploadState.uploadIds[0]);
  });
});

/**
 * The other half: a conversation that already has a stored attachment.
 *
 * Seeded the way the real `GET /api/conversations/{id}` returns it -- public
 * metadata and an `attachmentId`, with no storage key anywhere -- because
 * these are the assertions about what a *reload* produces, and a reload has no
 * stream to have learned anything from.
 */
test.describe("a conversation with a stored attachment", () => {
  const STORED_ATTACHMENT = {
    id: "ma-stored-1",
    attachmentId: "ma-stored-1",
    ordinal: 0,
    name: "명단.xlsx",
    mediaType: XLSX_TYPE,
    size: 4096,
    kind: "file" as const,
  };

  test.beforeEach(async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page, {
      selectedModels: ["gpt-5-6-luna"],
      messages: [
        {
          id: "m-user",
          role: "user",
          // Empty on purpose: a file-only turn. If this ever comes back as
          // "명단.xlsx" the old behaviour is back.
          content: "",
          attachments: [STORED_ATTACHMENT],
        },
        {
          id: "m-assistant",
          role: "assistant",
          content: "명단을 확인했습니다.",
          modelId: "gpt-5-6-luna",
        },
      ],
    });
    await mockChatStream(page, "다시 확인했습니다.");
  });

  test("the card is restored, and the turn is not its file name", async ({ page }) => {
    await page.goto("/chat?lang=ko");
    await openRecentConversation(page);

    const turn = userTurn(page).filter({ hasText: "명단.xlsx" });
    await expect(turn).toBeVisible();

    // Nothing streamed this time, so the card can only have come from the
    // conversation endpoint. The app restores the active conversation from
    // sessionStorage, so there is no welcome screen to step back through.
    await page.reload();
    await expect(userTurn(page).filter({ hasText: "명단.xlsx" })).toBeVisible();
  });

  test("the conversation read carries no storage key and no file content", async ({
    page,
  }) => {
    const bodies: string[] = [];
    page.on("response", async (response) => {
      if (
        response.request().method() !== "GET" ||
        !/\/api\/conversations\/[^/]+(\?|$)/.test(response.url())
      ) {
        return;
      }
      bodies.push(await response.text().catch(() => ""));
    });

    await page.goto("/chat?lang=ko");
    await openRecentConversation(page);
    await expect(userTurn(page).filter({ hasText: "명단.xlsx" })).toBeVisible();

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toContain("objectKey");
      expect(body).not.toContain("attachments/");
      expect(body).not.toContain("X-Amz-Signature");
      expect(body).not.toContain("data:application");
    }
  });

  /*
    A retry rebuilds its own failed turn and nothing else.

    The trim that stops a retry duplicating its own attachment reference must
    not reach past that turn: an earlier question that was actually answered
    carried its file, and dropping it would rewrite what the model was shown.
    Seeded from the conversation endpoint, so the earlier turn is a stored one
    rather than something this session happens to remember.
  */
  test("a retry leaves an already-answered turn's file in the transcript", async ({
    page,
  }) => {
    const chatRequests: string[] = [];
    // Registered after the beforeEach's `mockChatStream`, so this handler
    // wins the POST: the first attempt fails, the retry succeeds.
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      chatRequests.push(route.request().postData() || "");
      if (chatRequests.length === 1) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          headers: { "X-Request-ID": "qa-trace-id" },
          body: JSON.stringify({
            error: "Something went wrong.",
            code: "AI_PROVIDER_ERROR",
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: { "X-Request-ID": "qa-trace-id" },
        body: "3행은 다음과 같습니다.",
      });
    });

    await page.goto("/chat?lang=ko");
    await openRecentConversation(page);
    await expect(userTurn(page).filter({ hasText: "명단.xlsx" })).toBeVisible();

    await page.getByTestId("chat-textarea").fill("아까 그 파일에서 3행만");
    await sendButton(page).click();
    await expect.poll(() => chatRequests.length).toBe(1);

    await page
      .getByRole("button", { name: /^다시 시도$/ })
      .first()
      .click();
    await expect.poll(() => chatRequests.length).toBe(2);
    await expect(page.getByText("3행은 다음과 같습니다.")).toBeVisible();

    // The stored turn still names its file, exactly once, and the question
    // that failed is asked once rather than twice.
    const retried = JSON.parse(chatRequests[1]) as {
      messages: Array<{ role: string; content?: string }>;
    };
    expect(attachmentHandleCount(chatRequests[1], "ma-stored-1")).toBe(1);
    expect(
      retried.messages.filter(
        (message) =>
          message.role === "user" && message.content === "아까 그 파일에서 3행만"
      )
    ).toHaveLength(1);
  });

  // Without this the model that answered the first question cannot see the
  // file when the second one is asked -- the quietest of the three faces of
  // the original defect.
  test("the next turn names the stored attachment by its durable id", async ({
    page,
  }) => {
    const chatRequests: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/chat")) {
        chatRequests.push(request.postData() || "");
      }
    });

    await page.goto("/chat?lang=ko");
    await openRecentConversation(page);
    await expect(userTurn(page).filter({ hasText: "명단.xlsx" })).toBeVisible();

    await page.getByTestId("chat-textarea").fill("아까 그 파일에서 3행만");
    await sendButton(page).click();
    await expect.poll(() => chatRequests.length).toBeGreaterThan(0);

    const followUp = chatRequests[0];
    expect(followUp).toContain('"attachmentId":"ma-stored-1"');
    expect(followUp).not.toContain("objectKey");
    expect(followUp).not.toContain("attachments/");
  });
});

/**
 * The comparison and retry halves.
 *
 * An attachment belongs to the *question*, and a comparison turn is one
 * question three models answer -- so it is stored once and every panel shows
 * the same card. A retry re-sends the same stored reference; "retry without
 * files" leaves it out of that one attempt and must not touch the row.
 */
test.describe("a stored attachment across panels and retries", () => {
  const STORED = {
    id: "ma-shared-1",
    attachmentId: "ma-shared-1",
    ordinal: 0,
    name: "명단.xlsx",
    mediaType: XLSX_TYPE,
    size: 4096,
    kind: "file" as const,
  };

  const seedComparison = (page: Page) =>
    mockAuthenticatedApi(page, {
      selectedModels: ["gpt-5-6-luna", "gemini-2-5-flash"],
      messages: [
        {
          id: "m-user",
          role: "user",
          content: "이 명단을 비교해 주세요",
          attachments: [STORED],
        },
        {
          id: "m-luna",
          role: "assistant",
          content: "Luna의 답변입니다.",
          modelId: "gpt-5-6-luna",
        },
        {
          id: "m-gemini",
          role: "assistant",
          content: "Gemini의 답변입니다.",
          modelId: "gemini-2-5-flash",
        },
      ],
    });

  // Stored once, shown in every panel: the user message carries no modelId, so
  // it belongs to all of them.
  test("every comparison panel shows the same single attachment card", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await seedComparison(page);
    await mockChatStream(page, "비교했습니다.");
    await page.goto("/chat?lang=ko");
    await openRecentConversation(page);

    // Desktop shows both panels side by side; the mobile shell shows one at a
    // time behind model tabs. Either way the claim is the same: every panel
    // that is rendered shows the shared question, and the card with it.
    const answers = page.getByText(/의 답변입니다\./);
    await expect(answers.first()).toBeVisible();
    const rendered = await answers.count();
    await expect(userTurn(page).filter({ hasText: "명단.xlsx" })).toHaveCount(
      rendered
    );
  });

  // "Retry without files" is offered only on a turn that actually carried
  // files, so the send has to be a live one. What is being pinned is that the
  // exclusion is scoped to that one attempt: nothing deletes an upload, and
  // nothing deletes a stored attachment.
  test("a retry re-sends the file; retrying without it omits it for that attempt only", async ({
    page,
  }) => {
    const chatRequests: string[] = [];
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    const uploads = await mockAttachmentUpload(page);
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      chatRequests.push(route.request().postData() || "");
      // A file-parsing failure, which is the one error that offers both retry
      // buttons (components/chat/ChatMessageList.tsx).
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        headers: { "X-Request-ID": "qa-trace-id" },
        body: JSON.stringify({
          error: "The attached PDF is invalid or unsupported.",
          code: "INVALID_PDF_ATTACHMENT",
        }),
      });
    });

    await page.goto("/chat?lang=ko");
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await attachFromComputer(page, {
      name: "계약서.pdf",
      mimeType: "application/pdf",
      buffer: createQaPdfBuffer(),
    });
    await expect(page.getByText("계약서.pdf", { exact: true })).toBeVisible();
    await page.getByTestId("chat-textarea").fill("이 파일을 읽어 주세요");
    await sendButton(page).click();

    await expect.poll(() => chatRequests.length).toBe(1);
    // Whichever handle the send ended up carrying: the durable attachment id
    // once the save has bound it, the upload id if it has not yet. Read from
    // the request rather than assumed, because which one it is is the client's
    // decision and this test is about the retries, not about that decision.
    const reference = /"(attachmentId|uploadId)":"([^"]+)"/.exec(chatRequests[0]);
    expect(reference, chatRequests[0]).not.toBeNull();
    const handle = reference![2];
    expect(chatRequests[0]).not.toContain("objectKey");

    // The plain retry sends the same reference again -- once.
    //
    // It used to send it twice. A retry minted a new message id, so the failed
    // attempt stayed in the transcript beside the new one and both named this
    // handle; `/api/chat` deduplicates references within a turn and refused
    // the request outright, which this mocked route could never show. A retry
    // now rebuilds its own turn (`lib/chatRetryTranscript.ts`).
    await page.getByRole("button", { name: /^다시 시도$/ }).first().click();
    await expect.poll(() => chatRequests.length).toBe(2);
    expect(newestUserTurn(chatRequests[1]).attachments?.[0]).toMatchObject({
      attachmentId: handle,
    });
    expect(attachmentHandleCount(chatRequests[1], handle)).toBe(1);

    // Without files: **that attempt only**. Nothing is deleted, and nothing
    // that was actually answered is rewritten.
    //
    // This assertion used to read `expect(withoutFiles).toContain(handle)`,
    // on the reasoning that the history keeps what it carried. Every turn in
    // *this* conversation is the same failed attempt, though -- it was never
    // answered and is not history -- so what that pinned was the duplicate
    // turn itself. The property it was reaching for is a real one and is
    // pinned where it can actually be exercised: "a retry leaves an
    // already-answered turn's file in the transcript", below.
    await page
      .getByRole("button", { name: /첨부파일 없이 다시 시도/ })
      .first()
      .click();
    await expect.poll(() => chatRequests.length).toBe(3);
    const withoutFiles = chatRequests[2];
    expect(newestUserTurn(withoutFiles).attachments).toEqual([]);
    expect(attachmentHandleCount(withoutFiles, handle)).toBe(0);
    expect(uploads.deleteCount).toBe(0);
  });
});
