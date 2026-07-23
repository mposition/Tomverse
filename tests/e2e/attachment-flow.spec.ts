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
    await page.goto("/chat");
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

  test("image attachments disable text-only Llama models and keep Scout available", async ({ page }) => {
    await attachFromComputer(page, {
      name: "vision-model-check.png",
      mimeType: "image/png",
      buffer: createQaPngBuffer(),
    });

    await actionMenuTrigger(page).click();
    await page
      .getByRole("dialog", { name: /더 많은 작업|More actions|更多操作/ })
      .getByRole("button", { name: /AI 모델 선택|Choose AI models|选择 AI 模型/ })
      .click();

    const textOnlyLlama = page.locator(
      '[data-testid="model-option"][data-model-id="llama-3-1"]'
    );
    const scout = page.locator(
      '[data-testid="model-option"][data-model-id="llama-4-scout"]'
    );
    await expect(textOnlyLlama).toBeDisabled();
    await expect(textOnlyLlama).toHaveAttribute("data-model-image-input", "false");
    await expect(scout).toBeEnabled();
    await expect(scout).toHaveAttribute("data-model-image-input", "true");
  });

  test("warns when a selected text-only model becomes incompatible with an image", async ({ page }) => {
    await actionMenuTrigger(page).click();
    await page
      .getByRole("dialog", { name: /더 많은 작업|More actions|更多操作/ })
      .getByRole("button", { name: /AI 모델 선택|Choose AI models|选择 AI 模型/ })
      .click();
    await page
      .locator('[data-testid="model-option"][data-model-id="llama-3-1"]')
      .click();
    await page.keyboard.press("Escape");

    await attachFromComputer(page, {
      name: "selected-model-warning.png",
      mimeType: "image/png",
      buffer: createQaPngBuffer(),
    });

    const warning = page.getByTestId("image-model-compatibility-warning");
    await expect(warning).toContainText("Llama 3.1");
    await warning
      .getByRole("button", {
        name: /미지원 모델 선택 해제|Remove incompatible models|移除不兼容模型/,
      })
      .click();
    await expect(warning).toBeHidden();
  });
});
