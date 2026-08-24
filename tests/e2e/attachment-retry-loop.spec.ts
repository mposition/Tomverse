import { expect, test, type Page } from "@playwright/test";
import {
  createQaXlsxBuffer,
  mockAttachmentUpload,
  mockAuthenticatedApi,
  prepareGuestPage,
} from "./support/app-fixtures";

/**
 * The retry that could never succeed.
 *
 * A turn carrying a file failed. The panel keeps that turn on screen -- the
 * draft and the attachment cards live in it -- and puts the error underneath.
 * Pressing "다시 시도" then appended a *second* user turn naming the same
 * upload, and `/api/chat` deduplicated attachment references across the whole
 * transcript, so the retry was refused with `DUPLICATE_ATTACHMENT_OBJECT`
 * before it reached a model. Every press produced the same refusal, and the
 * refusal itself was classified `generic`, so the one affordance that would
 * have worked -- send it again without the file -- was never rendered.
 *
 * Three assertions, one per half of the fix: the transcript a retry sends,
 * the sentence the user reads, and the buttons the card offers.
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

type SentTranscript = {
  messages: Array<{
    role: string;
    content?: string;
    attachments?: Array<Record<string, unknown>>;
  }>;
};

/** Every attachment reference the request named, across every message. */
const referencedAttachmentIds = (body: SentTranscript) =>
  body.messages.flatMap((message) =>
    (message.attachments ?? []).map(
      (attachment) =>
        (attachment.attachmentId as string) ?? (attachment.uploadId as string)
    )
  );

test.describe("retrying a turn that carried a file", () => {
  let sentBodies: SentTranscript[];

  test.beforeEach(async ({ page }) => {
    sentBodies = [];
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await mockAttachmentUpload(page);

    /*
      Registered last so it wins the POST: Playwright runs the most recently
      added handler first, and `mockAttachmentUpload` owns the same URL for
      the upload verbs.

      The first send is refused the way the server refuses a turn whose files
      it will not read. Which code hardly matters -- what matters is that the
      panel is now in the state the retry button exists for.
    */
    await page.route("**/api/chat", async (route) => {
      const request = route.request();
      if (request.method() !== "POST") {
        await route.fallback();
        return;
      }
      sentBodies.push(request.postDataJSON() as SentTranscript);
      if (sentBodies.length === 1) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          headers: { "X-Request-ID": "qa-trace-id" },
          body: JSON.stringify({
            error: "The attached PDF is invalid or unsupported.",
            code: "INVALID_PDF_ATTACHMENT",
            traceId: "qa-trace-id",
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: { "X-Request-ID": "qa-trace-id" },
        body: "다시 보내 주신 파일 확인했습니다.",
      });
    });

    await page.goto("/chat");
    await expect(page.getByTestId("chat-input")).toBeVisible();

    await attachFromComputer(page, {
      name: "명단.xlsx",
      mimeType: XLSX_TYPE,
      buffer: createQaXlsxBuffer(),
    });
    // The card appears while the bytes are still going up. Sending before
    // finalisation would send a turn with no reference at all, which is a
    // different path from the one under test.
    await expect(page.getByText("명단.xlsx", { exact: true })).toBeVisible();
    await expect(page.getByTestId("attachment-complete")).toBeVisible();
    await page.getByTestId("chat-textarea").fill("이 명단 확인해 주세요");
    await sendButton(page).click();
    await expect(
      page.getByRole("button", { name: "다시 시도", exact: true })
    ).toBeVisible({ timeout: 15_000 });
  });

  test("the retry names the file once and replaces the failed turn", async ({
    page,
  }) => {
    const firstAttempt = referencedAttachmentIds(sentBodies[0]);
    expect(firstAttempt).toHaveLength(1);

    await page.getByRole("button", { name: "다시 시도", exact: true }).click();
    await expect(page.getByText("다시 보내 주신 파일 확인했습니다.")).toBeVisible();

    // The transcript the server would have refused: the same id twice.
    await expect.poll(() => sentBodies.length).toBe(2);
    expect(referencedAttachmentIds(sentBodies[1])).toEqual(firstAttempt);

    // ...and the previous attempt's error is not handed to the model as an
    // assistant turn to answer around.
    const assistantTurns = sentBodies[1].messages.filter(
      (message) => message.role === "assistant"
    );
    expect(assistantTurns).toHaveLength(0);

    // One question was asked, so one question is on screen.
    await expect(userTurn(page).filter({ hasText: "명단.xlsx" })).toHaveCount(1);
  });

  test("the refusal is read in the user's language, not the server's", async ({
    page,
  }) => {
    await expect(
      page.getByText("PDF가 손상되었거나 읽을 수 없습니다.")
    ).toBeVisible();
    await expect(
      page.getByText("The attached PDF is invalid or unsupported.")
    ).toHaveCount(0);
  });

  test("a file refusal offers the recovery that drops the file", async ({
    page,
  }) => {
    // Classified from the code. While the category was read off the sentence,
    // a refusal whose wording missed four keywords offered only the button
    // that repeated the same request.
    await expect(
      page.getByRole("button", { name: "첨부파일 없이 다시 시도", exact: true })
    ).toBeVisible();

    await page.getByRole("button", { name: "첨부파일 없이 다시 시도", exact: true }).click();
    await expect(page.getByText("다시 보내 주신 파일 확인했습니다.")).toBeVisible();

    await expect.poll(() => sentBodies.length).toBe(2);
    expect(referencedAttachmentIds(sentBodies[1])).toEqual([]);
    await expect(userTurn(page)).toHaveCount(1);
  });
});
