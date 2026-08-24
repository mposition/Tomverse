import {
  expect,
  test,
  type JSHandle,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import {
  createQaPdfBuffer,
  createQaPngBuffer,
  mockAttachmentUpload,
  mockAuthenticatedApi,
  mockChatStream,
  openModelCatalogue,
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
  // Two steps now: the root menu asks *whether* to attach, and the source view
  // asks where from. The chooser opens on the second click, so the wait is set
  // up around that one -- arming it before the first would time out on a click
  // that only changes view.
  await page.getByTestId("tools-attach-row").click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByTestId("attach-local-file-row").click();
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

async function fileTransfer(
  page: Page,
  fileName: string,
  mimeType: string,
  buffer: Buffer
) {
  const bytes = Array.from(buffer);
  return page.evaluateHandle(
    ({ bytes: fileBytes, fileName: name, mimeType: type }) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(
        new File([new Uint8Array(fileBytes)], name, { type })
      );
      return dataTransfer;
    },
    { bytes, fileName, mimeType }
  );
}

// A link or a text selection dragged across the canvas is somebody else's
// gesture: `types` never contains "Files", and nothing may react to it.
async function textTransfer(page: Page) {
  return page.evaluateHandle(() => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", "https://example.com/not-a-file");
    return dataTransfer;
  });
}

async function dragOver(target: Locator, transfer: JSHandle<DataTransfer>) {
  await target.dispatchEvent("dragenter", { dataTransfer: transfer });
  await target.dispatchEvent("dragover", { dataTransfer: transfer });
}

async function dropOn(target: Locator, transfer: JSHandle<DataTransfer>) {
  await dragOver(target, transfer);
  await target.dispatchEvent("drop", { dataTransfer: transfer });
}

async function dropFile(page: Page, fileName: string, mimeType: string, buffer: Buffer) {
  const transfer = await fileTransfer(page, fileName, mimeType, buffer);
  await dropOn(page.getByTestId("chat-input"), transfer);
  await transfer.dispose();
}

/**
 * The answer canvas of whichever shell is on screen. Both shells hand the
 * same element to the composer, so the drop contract below is one contract
 * asserted twice rather than two implementations.
 */
const conversationSurface = (page: Page, testInfo: TestInfo) =>
  page.getByTestId(
    testInfo.project.name.startsWith("mobile")
      ? "mobile-conversation-surface"
      : "desktop-conversation-surface"
  );

/** A region of the same screen that is deliberately not a chat drop target. */
const outsideConversationSurface = (page: Page, testInfo: TestInfo) =>
  page.getByTestId(
    testInfo.project.name.startsWith("mobile")
      ? "mobile-chat-header"
      : "chat-sidebar"
  );

/**
 * A control that is actually painted where its box says it is.
 *
 * Playwright's `toBeVisible()` passes for an element an ancestor's
 * `overflow-hidden` has clipped out of sight -- the element still has a
 * non-empty box and no `visibility: hidden` -- which is exactly how the
 * composer's remove button went missing on image attachments while every
 * assertion around it stayed green. The centre point is what tells the two
 * apart, the same measure the mobile drawer contract uses
 * (docs/ui-contracts/mobile-sidebar-drawer.md).
 */
async function expectHitTestable(control: Locator, label: string) {
  const box = await control.boundingBox();
  expect(box, `${label}: expected a box`).not.toBeNull();
  const hit = await control.evaluate(
    (element, [x, y]) => {
      const target = document.elementFromPoint(x as number, y as number);
      return {
        hitsSelf:
          Boolean(target) && (target === element || element.contains(target)),
        description: target
          ? `${target.tagName.toLowerCase()}${
              target.getAttribute("data-testid")
                ? `[data-testid=${target.getAttribute("data-testid")}]`
                : ""
            }`
          : "null",
      };
    },
    [box!.x + box!.width / 2, box!.y + box!.height / 2]
  );
  expect(
    hit.hitsSelf,
    `${label}: centre point hit ${hit.description} instead of the control`
  ).toBe(true);
}

/**
 * The remove button belongs to its own card. When it fell back into normal
 * flow it left the card entirely -- below a thumbnail that fills its
 * container -- so containment names the failure directly rather than through
 * whatever happened to be painted underneath.
 */
async function expectInsideCard(control: Locator, card: Locator, label: string) {
  const [controlBox, cardBox] = await Promise.all([
    control.boundingBox(),
    card.boundingBox(),
  ]);
  expect(controlBox, `${label}: expected a control box`).not.toBeNull();
  expect(cardBox, `${label}: expected a card box`).not.toBeNull();
  expect(
    controlBox!.y >= cardBox!.y - 1 &&
      controlBox!.y + controlBox!.height <= cardBox!.y + cardBox!.height + 1 &&
      controlBox!.x >= cardBox!.x - 1 &&
      controlBox!.x + controlBox!.width <= cardBox!.x + cardBox!.width + 1,
    `${label}: control at ${JSON.stringify(controlBox)} is outside its card at ${JSON.stringify(cardBox)}`
  ).toBe(true);
}

async function sendMessage(page: Page, prompt: string, answer: string) {
  await page.getByTestId("chat-textarea").fill(prompt);
  await page.getByRole("button", { name: /전송|Send|发送/ }).click();
  await expect(page.getByText(answer, { exact: true }).first()).toBeVisible();
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

  test("selected image previews before and after send", { tag: ["@smoke", "@review-parity"] }, async ({ page }) => {
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

  test("PDF remains a friendly file card and sends successfully", { tag: ["@smoke", "@review-parity"] }, async ({ page }) => {
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

  test("a ZIP is attachable, and the files it left out are said out loud", async ({
    page,
  }) => {
    // The bug this change started from: attaching a ZIP answered
    // "지원하지 않는 파일 형식입니다." An archive is now a supported format,
    // and what could not be read inside it is reported rather than silently
    // missing from the answer.
    uploadState.archive = { totalEntries: 9, includedFiles: 6, excludedFiles: 3 };
    await attachFromComputer(page, {
      name: "project.zip",
      mimeType: "application/zip",
      buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]),
    });

    await expect(page.getByTestId("attachment-complete")).toBeVisible();
    await expect(page.getByTestId("attachment-failed")).toHaveCount(0);
    expect(uploadState.finalizeCount).toBe(1);
    await expect(page.getByTestId("app-toast")).toHaveText(
      "일부 파일은 지원되지 않아 제외되었습니다: 3개"
    );

    // The toast clears itself after four seconds. What it said has to survive
    // that, or a person who looked away learns nothing until the answer comes
    // back without the files they attached.
    await expect(page.getByTestId("attachment-archive-summary")).toHaveText(
      "6개 읽음 · 3개 제외"
    );
    await expect(page.getByTestId("app-toast")).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(page.getByTestId("attachment-archive-summary")).toHaveText(
      "6개 읽음 · 3개 제외"
    );
  });

  test("an archive with nothing skipped says so without a skipped count", async ({
    page,
  }) => {
    // Zero is not a number worth putting on screen next to "skipped": it
    // invites the reader to look for something that did not happen.
    uploadState.archive = { totalEntries: 4, includedFiles: 4, excludedFiles: 0 };
    await attachFromComputer(page, {
      name: "clean.zip",
      mimeType: "application/zip",
      buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]),
    });

    await expect(page.getByTestId("attachment-archive-summary")).toHaveText(
      "4개 읽음"
    );
    await expect(page.getByTestId("app-toast")).toHaveCount(0);
  });

  test("a file that is not an archive carries no summary", async ({ page }) => {
    await attachFromComputer(page, {
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hello\n", "utf8"),
    });

    await expect(page.getByTestId("attachment-complete")).toBeVisible();
    await expect(page.getByTestId("attachment-archive-summary")).toHaveCount(0);
  });

  test("a text file whose browser type is empty is still attachable", async ({
    page,
  }) => {
    // Windows and several Android pickers report no media type at all for a
    // .md, and the composer used to refuse it before the server saw a byte.
    await attachFromComputer(page, {
      name: "notes.md",
      mimeType: "",
      buffer: Buffer.from("# hello\n", "utf8"),
    });

    await expect(page.getByTestId("attachment-complete")).toBeVisible();
    await expect(page.getByTestId("attachment-failed")).toHaveCount(0);
    expect(uploadState.uploadCount).toBe(1);
  });

  test("an unsupported format is refused before anything is uploaded", async ({
    page,
  }) => {
    await attachFromComputer(page, {
      name: "clip.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from([0, 1, 2, 3]),
    });

    await expect(page.getByTestId("attachment-failed")).toBeVisible();
    await expect(page.getByTestId("attachment-failed-reason")).toHaveText(
      "지원하지 않는 파일 형식입니다."
    );
    expect(uploadState.prepareCount).toBe(0);
    expect(uploadState.uploadCount).toBe(0);
  });

  test("the server's reason reaches the user instead of a generic retry", async ({
    page,
  }) => {
    // The signed-in path used to throw the server's answer away: a corrupt
    // PDF, an encrypted archive and a rate limit all produced
    // "파일을 업로드하지 못했습니다. 다시 시도해 주세요."
    uploadState.finalizeFailure = { status: 400, code: "ARCHIVE_ENCRYPTED" };
    await attachFromComputer(page, {
      name: "locked.zip",
      mimeType: "application/zip",
      buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    });

    await expect(page.getByTestId("attachment-failed-reason")).toHaveText(
      "암호화된 ZIP 파일은 지원하지 않습니다."
    );

    uploadState.finalizeFailure = { status: 400, code: "ATTACHMENT_ANIMATED_IMAGE" };
    await page.getByTestId("attachment-failed-dismiss").click();
    await attachFromComputer(page, {
      name: "loop.gif",
      mimeType: "image/gif",
      buffer: Buffer.from("GIF89a", "ascii"),
    });

    await expect(page.getByTestId("attachment-failed-reason")).toHaveText(
      "애니메이션 GIF는 지원하지 않습니다. 정지 이미지로 변환해 주세요."
    );
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

  test("a file dropped on the empty conversation's welcome canvas is attached", async ({
    page,
  }, testInfo) => {
    // The canvas used to swallow this: the handlers lived on the composer
    // alone, so a file dropped on the screen a new chat actually shows -- the
    // welcome surface -- did nothing at all.
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();
    await expect(conversationSurface(page, testInfo)).toBeVisible();

    const beforeUrl = page.url();
    const transfer = await fileTransfer(
      page,
      "welcome-drop.png",
      "image/png",
      createQaPngBuffer()
    );
    await dropOn(page.getByTestId("chat-empty-state"), transfer);
    await transfer.dispose();

    await expect(page.getByAltText("welcome-drop.png")).toBeVisible();
    await expect(page).toHaveURL(beforeUrl);
    await expect.poll(() => uploadState.prepareCount).toBe(1);
    expect(uploadState.uploadCount).toBe(1);
    expect(uploadState.finalizeCount).toBe(1);
  });

  test("a file dropped on the message list of a conversation with answers is attached", async ({
    page,
  }, testInfo) => {
    await sendMessage(page, "Canvas drop QA", "Attachment QA response");
    await expect(conversationSurface(page, testInfo)).toBeVisible();

    const messageList = page.getByTestId("chat-message-list").first();
    await expect(messageList).toBeVisible();

    const transfer = await fileTransfer(
      page,
      "transcript-drop.png",
      "image/png",
      createQaPngBuffer()
    );
    await dropOn(messageList, transfer);
    await transfer.dispose();

    await expect(
      page.locator('[data-testid="chat-input"] img[alt="transcript-drop.png"]')
    ).toBeVisible();
    await expect.poll(() => uploadState.prepareCount).toBe(1);
    expect(uploadState.uploadCount).toBe(1);
    expect(uploadState.finalizeCount).toBe(1);
  });

  test("the canvas raises one drop overlay, holds it across children, and clears it on drop", async ({
    page,
  }, testInfo) => {
    const surface = conversationSurface(page, testInfo);
    const overlay = page.getByTestId("chat-conversation-drop-overlay");
    const composerOverlay = page.getByTestId("chat-composer-drop-overlay");
    await expect(overlay).toHaveCount(0);

    const transfer = await fileTransfer(
      page,
      "overlay-drop.png",
      "image/png",
      createQaPngBuffer()
    );

    await dragOver(surface, transfer);
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText("파일을 놓으면 첨부됩니다");
    // The composer portals into this same canvas while the chat is empty. One
    // drag must raise one overlay, or the same drop is handled twice.
    await expect(composerOverlay).toHaveCount(0);

    // Crossing into a child and back out of it is enter/leave traffic the
    // overlay must sit still through.
    const child = page.getByTestId("chat-empty-state");
    await child.dispatchEvent("dragenter", { dataTransfer: transfer });
    await surface.dispatchEvent("dragleave", { dataTransfer: transfer });
    await expect(overlay).toBeVisible();

    await surface.dispatchEvent("drop", { dataTransfer: transfer });
    await transfer.dispose();

    await expect(overlay).toHaveCount(0);
    await expect(page.getByAltText("overlay-drop.png")).toBeVisible();
    await expect.poll(() => uploadState.finalizeCount).toBe(1);
  });

  test("a drag that carries no file leaves the canvas alone", async ({
    page,
  }, testInfo) => {
    const surface = conversationSurface(page, testInfo);
    const transfer = await textTransfer(page);

    await dragOver(surface, transfer);
    await expect(page.getByTestId("chat-conversation-drop-overlay")).toHaveCount(0);

    await surface.dispatchEvent("drop", { dataTransfer: transfer });
    await transfer.dispose();

    await expect(page.getByTestId("attachment-complete")).toHaveCount(0);
    expect(uploadState.prepareCount).toBe(0);
    expect(uploadState.uploadCount).toBe(0);
  });

  test("a file dropped outside the conversation canvas uploads nothing", async ({
    page,
  }, testInfo) => {
    const outside = outsideConversationSurface(page, testInfo);
    await expect(outside).toBeVisible();

    const beforeUrl = page.url();
    const transfer = await fileTransfer(
      page,
      "stray-drop.png",
      "image/png",
      createQaPngBuffer()
    );
    await dropOn(outside, transfer);
    await transfer.dispose();

    // The window-level guard still stops the browser opening the file; what
    // it must not do is turn every drop on the page into an attachment.
    await expect(page).toHaveURL(beforeUrl);
    await expect(page.getByTestId("chat-conversation-drop-overlay")).toHaveCount(0);
    await expect(page.getByTestId("attachment-complete")).toHaveCount(0);
    expect(uploadState.prepareCount).toBe(0);
    expect(uploadState.uploadCount).toBe(0);
  });

  test("image attachments disable text-only models and keep a vision model available", { tag: ["@smoke", "@review-parity"] }, async ({ page }) => {
    await attachFromComputer(page, {
      name: "vision-model-check.png",
      mimeType: "image/png",
      buffer: createQaPngBuffer(),
    });

    // The menu's duplicate "choose models" row is gone; the composer's own
    // model button is the single way in, and openModelCatalogue() uses it.
    await openModelCatalogue(page);

    // Was llama-3-1 / llama-4-scout until Llama left the public catalogue
    // with Groq's hosting. Any enabled Guest-tier pair -- one text-only, one
    // vision -- exercises the same assertion.
    const textOnlyModel = page.locator(
      '[data-testid="model-option"][data-model-id="deepseek-v4-flash"]'
    );
    const visionModel = page.locator(
      '[data-testid="model-option"][data-model-id="gemini-2-5-flash"]'
    );
    await expect(textOnlyModel).toBeDisabled();
    await expect(textOnlyModel).toHaveAttribute("data-model-image-input", "false");
    await expect(visionModel).toBeEnabled();
    await expect(visionModel).toHaveAttribute("data-model-image-input", "true");
  });

  test("warns when a selected text-only model becomes incompatible with an image", async ({ page }) => {
    // The menu's duplicate "choose models" row is gone; the composer's own
    // model button is the single way in, and openModelCatalogue() uses it.
    await openModelCatalogue(page);
    await page
      .locator('[data-testid="model-option"][data-model-id="deepseek-v4-flash"]')
      .click();
    // Escape steps back to the recommendations first, then closes the picker.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.locator("#chat-input-popover")).toBeHidden();

    await attachFromComputer(page, {
      name: "selected-model-warning.png",
      mimeType: "image/png",
      buffer: createQaPngBuffer(),
    });

    const warning = page.getByTestId("image-model-compatibility-warning");
    await expect(warning).toContainText("DeepSeek-V4 Flash");
    await warning
      .getByRole("button", {
        name: /미지원 모델 선택 해제|Remove incompatible models|移除不兼容模型/,
      })
      .click();
    await expect(warning).toBeHidden();
  });

  // The bug these cover: the remove button carried `relative` and `absolute`
  // at once. Tailwind emits `.relative` after `.absolute`, so `relative` won,
  // the button left its card, and on an image -- whose card is a fixed-size
  // `overflow-hidden` box filled edge to edge by the thumbnail -- it was
  // clipped away entirely. Paste is simply the usual way an image arrives, so
  // it read as "a pasted image cannot be deleted"; every upload path was hit.
  test("a pasted image keeps a remove control inside its own card", async ({
    page,
  }) => {
    await pasteFile(page, "clipboard-remove.png", "image/png", createQaPngBuffer());
    await expect(page.getByAltText("clipboard-remove.png")).toBeVisible();
    await expect.poll(() => uploadState.finalizeCount).toBe(1);

    const card = page.getByTestId("attachment-complete");
    const remove = card.getByTestId("attachment-remove");
    await expect(remove).toHaveAttribute(
      "aria-label",
      "첨부파일 제거: clipboard-remove.png"
    );
    await expectInsideCard(remove, card, "pasted image remove button");
    await expectHitTestable(remove, "pasted image remove button");
  });

  test("removing a pasted image clears the card and releases the upload", async ({
    page,
  }) => {
    await pasteFile(page, "clipboard-remove.png", "image/png", createQaPngBuffer());
    await expect(page.getByAltText("clipboard-remove.png")).toBeVisible();
    await expect.poll(() => uploadState.finalizeCount).toBe(1);
    const uploadId = uploadState.uploadIds[0];

    // Reached the way a user reaches it. Playwright's own `.click()` scrolls
    // to and dispatches on a clipped element all the same, so the click below
    // stayed green all through the defect -- the point check is what makes
    // this test fail when the control is not really there.
    const remove = page.getByTestId("attachment-remove");
    await expectHitTestable(remove, "pasted image remove button");
    await remove.click();

    await expect(page.getByTestId("attachment-complete")).toHaveCount(0);
    await expect(page.getByAltText("clipboard-remove.png")).toHaveCount(0);
    // Dropping the card is also giving the object back: the composer names the
    // opaque upload id and never a storage key
    // (docs/policy/user-attachment-persistence.md).
    await expect.poll(() => uploadState.deleteCount).toBe(1);
    expect(uploadState.deletedUploadIds).toEqual([uploadId]);
  });

  test("a pasted file card keeps its remove control too", async ({ page }) => {
    // The file branch survived the same defect by accident -- its card is a
    // flex row, so the button stayed in the row instead of being clipped. It
    // is asserted here so the two branches cannot drift apart again.
    await pasteFile(page, "clipboard-remove.pdf", "application/pdf", createQaPdfBuffer());
    await expect(page.getByText("clipboard-remove.pdf", { exact: true })).toBeVisible();
    await expect.poll(() => uploadState.finalizeCount).toBe(1);

    const card = page.getByTestId("attachment-complete");
    const remove = card.getByTestId("attachment-remove");
    await expectInsideCard(remove, card, "pasted file remove button");
    await expectHitTestable(remove, "pasted file remove button");

    await remove.click();
    await expect(page.getByTestId("attachment-complete")).toHaveCount(0);
    await expect.poll(() => uploadState.deleteCount).toBe(1);
  });

  test("an image attached from the picker is removable on the same terms", async ({
    page,
  }) => {
    // Paste is not a path of its own: the card is the same card wherever the
    // file came from, so a fix that only reached the paste handler would be
    // the wrong fix.
    await attachFromComputer(page, {
      name: "picker-remove.png",
      mimeType: "image/png",
      buffer: createQaPngBuffer(),
    });
    await expect(page.getByAltText("picker-remove.png")).toBeVisible();
    await expect.poll(() => uploadState.finalizeCount).toBe(1);

    const card = page.getByTestId("attachment-complete");
    const remove = card.getByTestId("attachment-remove");
    await expectInsideCard(remove, card, "picker image remove button");
    await expectHitTestable(remove, "picker image remove button");

    await remove.click();
    await expect(page.getByTestId("attachment-complete")).toHaveCount(0);
  });
});
