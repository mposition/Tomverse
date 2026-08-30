import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  openRecentConversation,
  prepareGuestPage,
} from "./support/app-fixtures";

/**
 * docs/policy/user-attachment-persistence.md §11.
 *
 * A signed-in user's attachment was removed from object storage by a bucket
 * lifecycle rule while the row naming it stayed. In production the symptom was
 * that the conversation simply stopped working: every turn failed with an AI
 * provider error, switching model changed nothing, and the attachment card
 * looked entirely ordinary.
 *
 * What this spec holds is the recovery, which has three parts and no fourth:
 *
 *   1. the card says so, and goes on saying so after a reload;
 *   2. the refusal is actionable -- attach it again, or continue without it;
 *   3. nothing reaches a model until the person explicitly chooses.
 *
 * The card, the filename and the message are never removed. What the user sent
 * is part of the conversation whether or not the bytes survived.
 */

const UNAVAILABLE_ATTACHMENT_ID = "att-lifecycle-deleted";

const seedConversation = (page: Page) =>
  mockAuthenticatedApi(page, {
    selectedModels: ["gpt-5-4-mini"],
    messages: [
      {
        id: "msg-with-lost-file",
        role: "user",
        content: "이 계약서 확인해 주세요",
        attachments: [
          {
            id: UNAVAILABLE_ATTACHMENT_ID,
            attachmentId: UNAVAILABLE_ATTACHMENT_ID,
            ordinal: 0,
            name: "계약서.pdf",
            mediaType: "application/pdf",
            size: 204_800,
            kind: "file",
            // The stored verdict. The server writes this only from a confirmed
            // 404; the client only ever renders it.
            unavailableAt: "2026-08-27T09:00:00.000Z",
            unavailableReason: "storage_object_missing",
          },
        ],
      },
      {
        id: "msg-answer",
        role: "assistant",
        content: "확인했습니다.",
        modelId: "gpt-5-4-mini",
      },
    ],
  });

/** The refusal the server sends for a past turn's missing file. */
const mockUnavailableRefusal = async (
  page: Page,
  record: { requests: Array<Record<string, unknown>> }
) => {
  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    record.requests.push(body);
    const acknowledged = Array.isArray(body.acknowledgedUnavailableAttachmentIds)
      ? (body.acknowledgedUnavailableAttachmentIds as string[])
      : [];
    if (acknowledged.includes(UNAVAILABLE_ATTACHMENT_ID)) {
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: { "X-Request-ID": "qa-trace-acknowledged" },
        body: "파일 없이 이어서 답변드립니다.",
      });
      return;
    }
    await route.fulfill({
      status: 410,
      contentType: "application/json",
      headers: { "X-Request-ID": "qa-trace-unavailable" },
      body: JSON.stringify({
        error:
          "A file from earlier in this conversation is no longer available. Attach it again, or continue without it.",
        code: "ATTACHMENT_UNAVAILABLE",
        traceId: "qa-trace-unavailable",
        details: {
          unavailableAttachmentIds: [UNAVAILABLE_ATTACHMENT_ID],
          unavailableAttachmentNames: ["계약서.pdf"],
          attachmentScope: "past_turn",
          canContinueWithout: "true",
        },
      }),
    });
  });
};

const send = async (page: Page, text: string) => {
  await page.getByTestId("chat-textarea").fill(text);
  await page.getByRole("button", { name: /전송|Send|发送/ }).click();
};

test.describe("an attachment whose bytes storage no longer holds", () => {
  test("the card says the file is unavailable, and still names it", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await seedConversation(page);
    await page.goto("/chat");
    await openRecentConversation(page);

    const card = page.getByTestId("chat-attachment-card-unavailable");
    await expect(card).toBeVisible();
    // §11: the row is never deleted and the card is never hidden. A person who
    // cannot see which file was lost cannot attach it again.
    await expect(card).toContainText("계약서.pdf");
    await expect(card).toContainText("파일 없음");
    // The message itself is untouched.
    await expect(page.getByText("이 계약서 확인해 주세요")).toBeVisible();
  });

  test("the state survives a reload rather than only the failing turn", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await seedConversation(page);
    await page.goto("/chat");
    await openRecentConversation(page);
    await expect(page.getByTestId("chat-attachment-card-unavailable")).toBeVisible();

    await page.reload();
    await expect(
      page.getByTestId("chat-attachment-card-unavailable")
    ).toBeVisible();
  });

  test("no storage location reaches the browser with the verdict", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await seedConversation(page);
    await page.goto("/chat");
    await openRecentConversation(page);
    await expect(page.getByTestId("chat-attachment-card-unavailable")).toBeVisible();

    const html = await page.content();
    expect(html).not.toContain("attachments/");
    expect(html).not.toContain("r2.cloudflarestorage");
    expect(html).not.toContain("X-Amz-Signature");
  });

  test("the refusal offers a way forward, and takes it only when asked", async ({
    page,
  }) => {
    const record = { requests: [] as Array<Record<string, unknown>> };
    await prepareGuestPage(page, "ko");
    await seedConversation(page);
    await mockUnavailableRefusal(page, record);
    await page.goto("/chat");
    await openRecentConversation(page);

    await send(page, "해지 조항이 뭐라고 돼 있었죠?");

    const continueButton = page.getByTestId(
      "continue-without-unavailable-attachments"
    );
    await expect(continueButton).toBeVisible();
    await expect(continueButton).toContainText("파일 없이 계속하기");

    // Fail-closed: the first request carried no acknowledgement and got none
    // of an answer. A model must never answer about a document nobody told the
    // user it did not read.
    expect(record.requests).toHaveLength(1);
    expect(
      record.requests[0].acknowledgedUnavailableAttachmentIds
    ).toBeUndefined();

    await continueButton.click();
    await expect(page.getByText("파일 없이 이어서 답변드립니다.")).toBeVisible();

    expect(record.requests).toHaveLength(2);
    expect(record.requests[1].acknowledgedUnavailableAttachmentIds).toEqual([
      UNAVAILABLE_ATTACHMENT_ID,
    ]);
  });

  test("continuing without the file leaves the card and the message alone", async ({
    page,
  }) => {
    const record = { requests: [] as Array<Record<string, unknown>> };
    await prepareGuestPage(page, "ko");
    await seedConversation(page);
    await mockUnavailableRefusal(page, record);
    await page.goto("/chat");
    await openRecentConversation(page);

    await send(page, "해지 조항이 뭐라고 돼 있었죠?");
    await page
      .getByTestId("continue-without-unavailable-attachments")
      .click();
    await expect(page.getByText("파일 없이 이어서 답변드립니다.")).toBeVisible();

    // §8: "continue without it" scopes one request. The stored turn is still
    // the turn that was sent, files and all.
    await expect(
      page.getByTestId("chat-attachment-card-unavailable")
    ).toBeVisible();
    await expect(page.getByText("이 계약서 확인해 주세요")).toBeVisible();
    // ...and the acknowledgement did not follow the conversation forward.
    const acknowledged = record.requests[1]
      .acknowledgedUnavailableAttachmentIds as string[];
    expect(acknowledged).toEqual([UNAVAILABLE_ATTACHMENT_ID]);
  });
});
