import { expect, test, type Page } from "@playwright/test";
import {
  createQaPdfBuffer,
  createQaPngBuffer,
  mockAttachmentUpload,
  mockAuthenticatedApi,
  mockChatStream,
  prepareGuestPage,
  type AttachmentUploadQaState,
} from "./support/app-fixtures";

const actionMenuTrigger = (page: Page) =>
  page.locator('button[aria-controls="chat-input-popover"]').first();

async function attachFromComputer(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer }
) {
  await actionMenuTrigger(page).click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page
    .getByRole("dialog", { name: /더 많은 작업|More actions|更多操作/ })
    .getByRole("button", { name: /파일 첨부|Add photos & files|Add files|上传/ })
    .click();
  const chooser = await chooserPromise;
  await chooser.setFiles(file);
}

async function pasteFile(page: Page, fileName: string, mimeType: string, buffer: Buffer) {
  const bytes = Array.from(buffer);
  await page.getByTestId("chat-textarea").focus();
  await page.getByTestId("chat-textarea").evaluate(
    (textarea, { bytes: fileBytes, fileName: name, mimeType: type }) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(
        new File([new Uint8Array(fileBytes)], name, { type })
      );
      textarea.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dataTransfer,
        })
      );
    },
    { bytes, fileName, mimeType }
  );
}

async function dropFile(page: Page, fileName: string, mimeType: string, buffer: Buffer) {
  const bytes = Array.from(buffer);
  const transfer = await page.evaluateHandle(
    ({ bytes: fileBytes, fileName: name, mimeType: type }) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(
        new File([new Uint8Array(fileBytes)], name, { type })
      );
      return dataTransfer;
    },
    { bytes, fileName, mimeType }
  );

  const input = page.getByTestId("chat-input");
  await input.dispatchEvent("dragover", { dataTransfer: transfer });
  await input.dispatchEvent("drop", { dataTransfer: transfer });
  await transfer.dispose();
}

test.describe("attachment UX", () => {
  let uploadState: AttachmentUploadQaState;

  test.beforeEach(async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    uploadState = await mockAttachmentUpload(page);
    await mockChatStream(page, "Attachment QA response");
    await page.goto("/");
    await expect(page.getByTestId("chat-input")).toBeVisible();
  });

  test("selected image previews before and after send", async ({ page }) => {
    await attachFromComputer(page, {
      name: "test-image.png",
      mimeType: "image/png",
      buffer: createQaPngBuffer(),
    });

    await expect(page.getByAltText("test-image.png")).toBeVisible();
    await page.getByTestId("chat-textarea").fill("Image QA");
    await page.getByRole("button", { name: /전송|Send|发送/ }).click();

    await expect(
      page.locator('[data-message-role="user"] img[alt="test-image.png"]')
    ).toBeVisible();
    await expect(page.getByText("Attachment QA response", { exact: true })).toBeVisible();
    expect(uploadState.prepareCount).toBe(1);
    expect(uploadState.uploadCount).toBe(1);
    expect(uploadState.finalizeCount).toBe(1);
  });

  test("PDF remains a friendly file card and sends successfully", async ({ page }) => {
    await attachFromComputer(page, {
      name: "test-file.pdf",
      mimeType: "application/pdf",
      buffer: createQaPdfBuffer(),
    });

    await expect(page.getByText("test-file.pdf", { exact: true })).toBeVisible();
    await expect(page.getByText("PDF", { exact: true }).first()).toBeVisible();
    await page.getByTestId("chat-textarea").fill("PDF QA");
    await page.getByRole("button", { name: /전송|Send|发送/ }).click();

    await expect(
      page.locator('[data-message-role="user"]').filter({ hasText: "test-file.pdf" })
    ).toBeVisible();
    await expect(page.getByText("Attachment QA response", { exact: true })).toBeVisible();
  });

  test("clipboard image paste creates one preview and upload pair", async ({ page }) => {
    await pasteFile(page, "clipboard.png", "image/png", createQaPngBuffer());

    await expect(page.getByAltText("clipboard.png")).toBeVisible();
    await expect.poll(() => uploadState.prepareCount).toBe(1);
    expect(uploadState.uploadCount).toBe(1);
    expect(uploadState.finalizeCount).toBe(1);
  });

  test("drag and drop attaches a file without navigating", async ({ page }) => {
    const beforeUrl = page.url();

    await dropFile(page, "drop-image.png", "image/png", createQaPngBuffer());

    await expect(page.getByAltText("drop-image.png")).toBeVisible();
    await expect(page).toHaveURL(beforeUrl);
    await expect.poll(() => uploadState.prepareCount).toBe(1);
    expect(uploadState.uploadCount).toBe(1);
    expect(uploadState.finalizeCount).toBe(1);
  });
});
