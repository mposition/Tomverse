import { expect, test, type Page } from "@playwright/test";
import { mockReviewHandoffBackground } from "./support/review-handoff-background-fixtures";

import {
  createQaPdfBuffer,
  createQaXlsxBuffer,
  expectNoHorizontalOverflow,
  mockAttachmentUpload,
  mockAuthenticatedApi,
  openRecentConversation,
  prepareGuestPage,
  selectModelsViaPicker,
  type AttachmentUploadQaState,
  type QaConversationMessage,
} from "./support/app-fixtures";
import { GUEST_DAILY_CREDIT_LIMIT, mockGuestUsage, restoreActiveConversation } from "./support/chat-state-fixtures";

for (const width of [320, 1440]) {
  test(`Korean product captions explain brand names without clipping at ${width}px`, async ({ page, baseURL }, info) => {
    test.skip(info.project.name !== "desktop-chromium", "Explicit phone and desktop viewports.");
    await page.setViewportSize({ width, height: 1000 });
    await prepareGuestPage(page, "ko", "studio", "studio");
    await mockAuthenticatedApi(page, { productKey: "chat", language: "ko", selectedModels: ["gpt-6-luna"], selectionMode: "auto", autoSelectionOffered: true });
    await page.context().addCookies([{ name: "__tomverse_e2e_chat_workspace", value: "1", url: baseURL! }]);
    await page.route("**/api/products/chat/capabilities", route => route.fulfill({ json: { autoSelection: { offered: true } } }));
    await page.goto("/chat?lang=ko");
    const switcher = page.locator('[data-testid="chat-input"]:visible').getByTestId("chat-product-switcher");
    await expect(switcher).toBeVisible();
    await expect(switcher).toContainText("채팅");
    await expect(switcher).toContainText("모델 비교");
    expect(await switcher.locator("a").evaluateAll(links => links.every(link => {
      const box = link.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(link);
      return Array.from(range.getClientRects()).every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1);
    }))).toBe(true);
    if (width > 768) await expect(page.locator(".chat-command-bar .review-brand strong")).toContainText("채팅");
    await expect(switcher.getByTestId("chat-product-review")).toHaveAttribute("href", "/review?lang=ko");
    await switcher.getByTestId("chat-product-review").click();
    await expect(page).toHaveURL(/\/review\?lang=ko/, { timeout: 15_000 });
    const navigation = page.locator(".review-navigation:visible");
    await expect(navigation).toContainText("채팅");
    await expect(navigation).toContainText("모델 비교");
    expect(await navigation.locator(".review-product-caption").evaluateAll(captions => captions.every(caption => {
      const box = caption.getBoundingClientRect();
      const target = caption.closest("a,button")!.getBoundingClientRect();
      return box.left >= target.left - 1 && box.right <= target.right + 1 && box.bottom <= target.bottom + 1;
    }))).toBe(true);
    await expectNoHorizontalOverflow(page);
  });
}

async function openProductSwitcher(page: Page) {
  const mobileMenu = page.getByTestId("mobile-sidebar-open");
  if (await mobileMenu.isVisible()) {
    await mobileMenu.click();
    return page
      .getByTestId("mobile-sidebar-drawer")
      .getByTestId("chat-product-switcher");
  }
  return page.getByTestId("chat-product-switcher");
}

test.describe("Tomverse Chat and Review product switcher", () => {
  test.beforeEach(async ({ page }) => {
    await mockReviewHandoffBackground(page);
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page, { autoSelectionOffered: true });
    await page.route("**/api/products/chat/capabilities", async (route) => {
      await route.fulfill({
        headers: { "Cache-Control": "private, no-store" },
        json: { autoSelection: { offered: true } },
      });
    });
    await page.context().addCookies([
      {
        name: "__tomverse_e2e_chat_workspace",
        value: "1",
        url: "http://127.0.0.1:3100",
      },
    ]);
  });

  test("Chat is current while Review is a navigation link", async ({ page }) => {
    await page.goto("/chat?lang=en");

    const composer = page.locator('[data-testid="chat-input"]:visible');
    await expect(composer).toHaveCount(1);
    await expect(page.getByTestId("composer-auto-routing-toggle")).toBeVisible();
    await expect(
      composer
        .getByTestId("composer-primary-tools")
        .getByTestId("composer-model-select")
    ).toBeVisible();
    await expect(composer.getByTestId("chat-send-button")).toHaveClass(
      /bg-zinc-900/
    );
    const switcher = await openProductSwitcher(page);
    await expect(switcher).toHaveCount(1);
    await expect(switcher).toBeVisible();
    await expect(switcher.getByTestId("chat-product-chat")).toHaveAttribute(
      "aria-current",
      "page"
    );
    await expect(switcher.getByTestId("chat-product-chat")).toHaveAttribute(
      "href",
      "/chat?lang=en"
    );
    await expect(switcher.getByTestId("chat-product-review")).toHaveAttribute(
      "href",
      "/review?lang=en"
    );
  });

  test("ordinary Chat answer Compare keeps its existing Review draft flow", async ({ page }) => {
    const question = "Compare two weekend itineraries.";
    await mockAuthenticatedApi(page, { productKey: "chat", messages: [
      { id: "normal-question", role: "user", content: question },
      { id: "normal-answer", role: "assistant", content: "Two weekend options.", modelId: "gpt-5-6-luna" },
    ] });
    const execution: string[] = [];
    const transferredPrompts: string[] = [];
    page.on("request", request => {
      const url = new URL(request.url());
      const pathname = url.pathname;
      if (pathname === "/review" && url.searchParams.has("prompt")) transferredPrompts.push(url.searchParams.get("prompt")!);
      if (request.method() === "POST" && (pathname.includes("review-handoff") || pathname === "/api/chat" || pathname.endsWith("/messages"))) execution.push(pathname);
    });
    await page.goto("/chat?lang=en&conversation=qa-conversation");
    await page.getByTestId("chat-compare-in-review").click();
    await expect(page).toHaveURL(/\/review(?:\?|$)/);
    await expect(page.getByTestId("chat-textarea")).toHaveValue(question);
    expect(transferredPrompts).toContain(question);
    expect(execution).toEqual([]);
    // A text-only question keeps the plain handoff: no file prompt.
    await expect(page.getByTestId("review-file-reattach")).toHaveCount(0);
  });

  test("Review is current and does not present Smart Adaptive as a product", async ({
    page,
  }) => {
    // Open the fixture's saved selection instead of relying on the new-chat catalogue default.
    await restoreActiveConversation(page);
    await page.goto("/review?lang=en");

    const composer = page.locator('[data-testid="chat-input"]:visible');
    await expect(composer).toHaveCount(1);
    const switcher = await openProductSwitcher(page);
    await expect(switcher).toHaveCount(1);
    await expect(switcher.getByTestId("chat-product-review")).toHaveAttribute(
      "aria-current",
      "page"
    );
    await expect(switcher.getByTestId("chat-product-chat")).not.toHaveAttribute(
      "aria-current",
      "page"
    );
    const drawer = page.getByTestId("mobile-sidebar-drawer");
    if (await drawer.isVisible()) {
      await page.keyboard.press("Escape");
      await expect(drawer).not.toBeVisible();
    }
    await expect(page.getByTestId("composer-auto-routing-toggle")).toHaveCount(0);
    await expect(composer.getByTestId("chat-send-button")).toHaveClass(
      /bg-blue-600/
    );

    const selectedModel = composer.getByTestId("composer-review-selected-model");
    await expect(selectedModel).toHaveCount(1);
    await expect(selectedModel).toHaveAttribute("data-model-id", "gpt-5-6-luna");
    await expect(selectedModel).toContainText(/GPT-5\.6 Luna/i);

    const conversationWrites: string[] = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (
        request.method() !== "GET" &&
        pathname.startsWith("/api/conversations")
      ) {
        conversationWrites.push(`${request.method()} ${pathname}`);
      }
    });
    await composer.getByTestId("composer-model-select").click();
    await expect(page.locator("#chat-input-popover")).toBeVisible();
    expect(conversationWrites).toEqual([]);
    // The existing full-screen picker closes through Escape/Done, then returns focus.
    await page.keyboard.press("Escape");
    await expect(page.locator("#chat-input-popover")).toHaveCount(0);
    await composer.getByTestId("composer-model-select").click();
    await expect(page.locator("#chat-input-popover")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#chat-input-popover")).toHaveCount(0);
    await expect(composer.getByTestId("composer-model-select")).toBeFocused();
    expect(conversationWrites).toEqual([]);
  });

  test("desktop full-support search sits in the footer beside a dedicated input row", async ({ page }) => {
    await mockAuthenticatedApi(page, { webSearchMode: "always" });
    await restoreActiveConversation(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/review?lang=en");
    const composer = page.getByTestId("chat-input");
    await expect(composer.getByTestId("chat-product-review")).toHaveAttribute("aria-current", "page");
    await expect(composer.getByTestId("composer-model-select")).toHaveAccessibleName(/1/);
    const chip = composer.getByTestId("composer-primary-tools").getByTestId("web-search-mode-chip");
    await expect(chip).toBeVisible();
    await expect(composer.getByTestId("tool-status-chip-row")).toHaveCount(0);
    const textarea = composer.getByTestId("chat-textarea");
    const inputBox = (await textarea.boundingBox())!;
    const chipBox = (await chip.boundingBox())!;
    const minimumTwoLines = await textarea.evaluate((node) => {
      const style = getComputedStyle(node);
      return 2 * Number.parseFloat(style.lineHeight)
        + Number.parseFloat(style.paddingTop)
        + Number.parseFloat(style.paddingBottom);
    });
    expect(inputBox.height).toBeGreaterThanOrEqual(minimumTwoLines - 1);
    expect(inputBox.height).toBeLessThanOrEqual(72);
    expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(chipBox.y + 0.5);
    expect(await textarea.evaluate((node) => getComputedStyle(node).fontSize)).toBe("16px");
    await expectNoHorizontalOverflow(page);
  });

  test(
    "mobile keeps the canonical switch in the composer and drawer without narrowing input",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 568 });
      await page.addInitScript(() => {
        document.documentElement.style.fontSize = "32px";
      });
      await page.goto("/chat?lang=en");

      const composer = page.locator('[data-testid="chat-input"]:visible');
      await expect(composer).toHaveCount(1);
      const composerSwitcher = composer.getByTestId("chat-product-switcher");
      await expect(composerSwitcher).toHaveCount(1);
      await expect(composerSwitcher.getByTestId("chat-product-chat")).toHaveAttribute(
        "href",
        "/chat?lang=en"
      );
      await expect(composerSwitcher.getByTestId("chat-product-review")).toHaveAttribute(
        "href",
        "/review?lang=en"
      );
      for (const target of [
        composerSwitcher.getByTestId("chat-product-chat"),
        composerSwitcher.getByTestId("chat-product-review"),
      ]) {
        const box = await target.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      const textareaRow = composer.getByTestId("composer-textarea-row");
      const textareaBox = await textareaRow.boundingBox();
      expect(textareaBox).not.toBeNull();
      expect(textareaBox!.width).toBeGreaterThan(250);
      const switcher = await openProductSwitcher(page);
      await expect(switcher).toHaveCount(1);
      const chatTarget = switcher.getByTestId("chat-product-chat");
      const reviewTarget = switcher.getByTestId("chat-product-review");

      for (const target of [chatTarget, reviewTarget]) {
        const box = await target.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      const switcherBox = await switcher.boundingBox();
      expect(switcherBox).not.toBeNull();
      await expect(page.getByTestId("mobile-sidebar-drawer").getByTestId("chat-product-switcher")).toHaveCount(1);
      await expectNoHorizontalOverflow(page);
    }
  );
});

test.describe("Guest Chat and Review product entry", () => {
  test("a guest switches directly between products and retains each idle draft", async ({ page }) => {
    await mockReviewHandoffBackground(page);
    await prepareGuestPage(page, "en");
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/")) {
        writes.push(new URL(request.url()).pathname);
      }
    });
    await page.goto("/review?lang=en&entry=guest-preview");
    const textarea = page.getByTestId("chat-textarea");
    const reviewDraft = "This draft belongs to the guest Review trial.";
    const chatDraft = "This draft belongs to the guest Chat trial.";
    await textarea.fill(reviewDraft);

    let switcher = await openProductSwitcher(page);
    await expect(switcher.getByTestId("chat-product-chat")).toHaveAttribute("href", "/chat?lang=en");
    await switcher.getByTestId("chat-product-chat").click();
    await expect(page).toHaveURL(/\/chat\?lang=en$/);
    await expect(textarea).toHaveValue("");
    await expect(page.getByTestId("composer-auto-routing-toggle")).toHaveCount(0);
    await expect(page.getByTestId("prompt-refiner-request")).toHaveCount(0);
    await textarea.fill(chatDraft);

    switcher = await openProductSwitcher(page);
    await switcher.getByTestId("chat-product-review").click();
    await expect(page).toHaveURL(/\/review\?lang=en$/);
    await expect(textarea).toHaveValue(reviewDraft);

    switcher = await openProductSwitcher(page);
    await switcher.getByTestId("chat-product-chat").click();
    await expect(page).toHaveURL(/\/chat\?lang=en$/);
    await expect(textarea).toHaveValue(chatDraft);
    expect(writes).toEqual([]);
  });

  test("the guest Chat limit offers sign-in without a Review import intent", async ({ page }) => {
    await prepareGuestPage(page, "en");
    await mockGuestUsage(page, GUEST_DAILY_CREDIT_LIMIT, GUEST_DAILY_CREDIT_LIMIT);
    await page.goto("/chat?lang=en");
    await expect(page.getByTestId("chat-textarea")).toBeDisabled();
    // The exhausted server snapshot opens the Guest limit dialog on entry.
    const modal = page.getByTestId("usage-limit-modal");
    await expect(modal).toBeVisible();
    const signIn = modal.getByTestId("usage-limit-guest-signin");
    await expect(signIn).toHaveText("Login / Sign Up");
    await expect(signIn).toHaveAttribute("href", "/auth/signin?callbackUrl=%2Fchat%3Flang%3Den");
    await expect(modal).toContainText("Your guest Chat stays in this browser.");
    // Keep the document open while exercising the real click handler so the
    // assertion can inspect its local import-intent side effect.
    await signIn.evaluate((element) => {
      element.addEventListener("click", (event) => event.preventDefault());
    });
    await signIn.click();
    expect(await page.evaluate(() => localStorage.getItem("tomverse_pending_guest_import"))).toBeNull();
  });
});

/*
  "Compare in Review" from a Chat question sent with one readable document
  (lib/chatReviewHandoff.ts). The file never travels: Review opens the question
  and asks for it again through its own composer. Two fictional quotes
  share a name and differ in content -- A: 10%, B: 30% -- so a spec can tell
  which bytes the send actually carried.
*/
test.describe("Compare in Review with the question's file", () => {
  const QUESTION = "중도 해지하면 얼마를 내나요?";
  const NOTICE = "Chat의 질문을 가져왔습니다. 같은 파일로 비교하려면 다시 첨부하세요.";
  const QUOTE_A = { name: "quote.pdf", mimeType: "application/pdf", buffer: createQaPdfBuffer("Quote A cancellation fee 10 percent") };
  const QUOTE_B = { name: "quote.pdf", mimeType: "application/pdf", buffer: createQaPdfBuffer("Quote B cancellation fee 30 percent and more") };
  const storedQuote = (id: string) => ({ id, attachmentId: id, ordinal: 0, name: "quote.pdf", mediaType: "application/pdf", size: 1200, kind: "file" as const });
  const pdfConversation: QaConversationMessage[] = [
    { id: "pdf-question", role: "user", content: QUESTION, attachments: [storedQuote("att-chat-a")] },
    { id: "pdf-answer", role: "assistant", content: "남은 기간 요금의 10%입니다.", modelId: "gpt-5-6-luna" },
    { id: "later-question", role: "user", content: "보증 기간은요?" },
    { id: "later-answer", role: "assistant", content: "2년입니다.", modelId: "gpt-5-6-luna" },
  ];

  /** Every request that would run, reserve, save or upload something. */
  const SIDE_EFFECT = /^\/api\/chat(?:\/|$)|\/messages(?:$|\?)|__qa_upload__|review-handoff|credit|reserv|router/;

  let uploads: AttachmentUploadQaState;
  let sideEffects: string[];
  let uploadedBodies: string[];
  let chatBodies: string[];
  let savedUploadIds: string[][];

  test.beforeEach(async ({ page, baseURL }) => {
    sideEffects = [];
    uploadedBodies = [];
    chatBodies = [];
    savedUploadIds = [];
    await mockReviewHandoffBackground(page);
    await prepareGuestPage(page, "ko");
    await page.context().addCookies([{ name: "__tomverse_e2e_chat_workspace", value: "1", url: baseURL! }]);
    page.on("request", (request) => {
      const url = new URL(request.url());
      // The composer's read-only availability estimate runs on every Review
      // open and model change; it reserves and increments nothing
      // (app/api/chat/availability/route.ts), so it is not a side effect.
      if (url.pathname === "/api/chat/availability") return;
      if (request.method() !== "GET" && SIDE_EFFECT.test(url.pathname)) sideEffects.push(`${request.method()} ${url.pathname}`);
      if (url.pathname.includes("__qa_upload__")) uploadedBodies.push(request.postDataBuffer()?.toString("latin1") ?? "");
      if (request.method() === "POST" && /\/messages(?:$|\?)/.test(url.pathname)) {
        const body = request.postDataJSON() as { messages?: Array<{ attachmentUploadIds?: string[] }> } | null;
        for (const message of body?.messages ?? []) savedUploadIds.push(message.attachmentUploadIds ?? []);
      }
    });
  });

  // The Chat conversation is an extra one: the fixture creates every new
  // conversation as its primary `qa-conversation`, so the Review the send
  // creates starts empty instead of inheriting the Chat transcript.
  const CHAT_TITLE = "견적서 질문";
  const seed = async (page: Page, messages: QaConversationMessage[] = pdfConversation) => {
    await mockAuthenticatedApi(page, { productKey: "review", language: "ko", messages: [],
      extraConversations: [{ id: "chat-quote", title: CHAT_TITLE, productKey: "chat", messages }] });
    uploads = await mockAttachmentUpload(page);
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") { await route.fallback(); return; }
      chatBodies.push(route.request().postData() || "");
      await route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", headers: { "X-Request-ID": "qa-trace-id" }, body: "비교 답변입니다." });
    });
  };
  const composer = (page: Page) => page.locator('[data-testid="chat-input"]:visible');
  const chooseFile = async (page: Page, file: { name: string; mimeType: string; buffer: Buffer } | null) => {
    const chooser = page.waitForEvent("filechooser");
    await composer(page).getByTestId("review-file-reattach-choose").click();
    await (await chooser).setFiles(file ? [file] : []);
  };
  const newestUserTurn = (body: string) =>
    [...(JSON.parse(body) as { messages: Array<{ role: string; attachments?: Array<Record<string, unknown>> }> }).messages]
      .reverse().find((message) => message.role === "user")!;
  /** Opens the seeded Chat and presses Compare on the answer `index`. */
  const compareFromChat = async (page: Page, index = 0) => {
    await page.goto("/chat?lang=ko&conversation=chat-quote");
    const compare = page.getByTestId("chat-compare-in-review").nth(index);
    await expect(compare).toBeVisible();
    // A double press is still one handoff.
    await compare.evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await expect(page).toHaveURL(/\/review(?:\?|$)/);
  };

  test("an earlier answer's PDF question opens Review asking for that PDF, and only the send runs the models", async ({ page }) => {
    await seed(page);
    await compareFromChat(page, 0);
    // The one-shot token is spent and stripped with the rest of the preset.
    await expect(page).not.toHaveURL(/fileHandoff|prompt=/);
    await expect(composer(page).getByTestId("chat-textarea")).toHaveValue(QUESTION);
    const notice = composer(page).getByTestId("review-file-reattach");
    await expect(notice).toHaveText(new RegExp(NOTICE));
    await expect(notice.getByRole("button", { name: "파일 선택" })).toBeVisible();
    await expect(composer(page).getByTestId("attachment-complete")).toHaveCount(0);
    await expect(composer(page).getByTestId("review-file-reattach")).toHaveCount(1);
    // Opening it ran nothing: no model or router call, no pre-save, no
    // reservation and no upload.
    await page.waitForTimeout(500);
    expect(sideEffects).toEqual([]);

    await selectModelsViaPicker(page, ["gpt-5-6-luna", "gemini-2-5-flash"]);
    // Cancelling the picker changes nothing.
    await chooseFile(page, null);
    await expect(notice).toBeVisible();
    expect(uploads.prepareCount).toBe(0);

    await chooseFile(page, QUOTE_A);
    await expect(composer(page).getByTestId("attachment-complete")).toHaveCount(1);
    await expect(composer(page).getByTestId("attachment-complete")).toContainText("quote.pdf");
    await expect(composer(page).getByTestId("review-file-reattach-attached")).toHaveText("파일 첨부됨");
    await expect(composer(page).getByTestId("review-file-reattach")).toHaveCount(0);
    // The person picked the file; nothing claims it is the original.
    await expect(composer(page)).not.toContainText("원본");
    expect(chatBodies).toEqual([]);
    expect(sideEffects.every((entry) => /^(PUT|PATCH) \/api\/chat$|__qa_upload__/.test(entry))).toBe(true);

    await composer(page).getByRole("button", { name: /전송|Send/ }).click();
    await expect.poll(() => chatBodies.length).toBe(2);
    expect(savedUploadIds.flat()).toEqual([uploads.uploadIds.at(-1)]);
    for (const body of chatBodies) {
      const attachments = newestUserTurn(body).attachments ?? [];
      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toMatchObject({ name: "quote.pdf" });
      // The Review's own new upload, never the Chat message's stored file.
      expect(body).not.toContain("att-chat-a");
      expect(body).not.toContain("objectKey");
    }
    expect(uploadedBodies).toHaveLength(1);
    expect(uploadedBodies[0]).toContain("10 percent");
    await expect(page.getByTestId("review-file-reattach-attached")).toHaveCount(0);
  });

  test("failure, retry, removal and a wrong pick never stand in for the question's PDF", async ({ page }) => {
    await seed(page);
    await compareFromChat(page, 0);
    const notice = composer(page).getByTestId("review-file-reattach");
    await expect(notice).toBeVisible();

    uploads.finalizeFailure = { status: 422, code: "INVALID_PDF_ATTACHMENT" };
    await chooseFile(page, QUOTE_A);
    await expect(composer(page).getByTestId("attachment-failed")).toBeVisible();
    await expect(notice).toBeVisible();
    uploads.finalizeFailure = null;
    await composer(page).getByTestId("attachment-retry").click();
    await expect(composer(page).getByTestId("attachment-complete")).toHaveCount(1);
    await expect(composer(page).getByTestId("review-file-reattach-attached")).toBeVisible();

    // Removing the PDF asks for it again.
    await composer(page).getByTestId("attachment-remove").click();
    await expect(composer(page).getByTestId("attachment-complete")).toHaveCount(0);
    await expect(notice).toBeVisible();

    // B shares A's name and question; picking it is the person's choice and
    // the composer says only "File attached". Swapping back to A sends A.
    await chooseFile(page, QUOTE_B);
    await expect(composer(page).getByTestId("review-file-reattach-attached")).toBeVisible();
    await composer(page).getByTestId("attachment-remove").click();
    await chooseFile(page, QUOTE_A);
    await expect(composer(page).getByTestId("attachment-complete")).toHaveCount(1);

    await composer(page).getByRole("button", { name: /전송|Send/ }).click();
    await expect.poll(() => chatBodies.length).toBeGreaterThan(0);
    const sentUploadId = savedUploadIds.flat();
    expect(sentUploadId).toHaveLength(1);
    // upl-qa-N is the Nth finalize, and every finalize follows its own upload.
    const sentBytes = uploadedBodies[Number(sentUploadId[0].replace("upl-qa-", "")) - 1];
    expect(sentBytes).toContain("Quote A");
    expect(sentBytes).not.toContain("Quote B");
    for (const body of chatBodies) {
      expect(newestUserTurn(body).attachments).toHaveLength(1);
      expect(body).not.toContain("att-chat-a");
    }
  });

  test("the question can be sent without the PDF, and the prompt is visible until then", async ({ page }) => {
    await seed(page);
    await compareFromChat(page, 0);
    await expect(composer(page).getByTestId("review-file-reattach")).toBeVisible();
    await composer(page).getByRole("button", { name: /전송|Send/ }).click();
    await expect.poll(() => chatBodies.length).toBeGreaterThan(0);
    expect(newestUserTurn(chatBodies[0]).attachments ?? []).toEqual([]);
    expect(uploads.prepareCount).toBe(0);
    await expect(page.getByTestId("review-file-reattach")).toHaveCount(0);
  });

  test("a text-only later question and a file-only turn never borrow the PDF or another question", async ({ page }) => {
    await seed(page, [
      ...pdfConversation,
      { id: "file-only", role: "user", content: "", attachments: [storedQuote("att-chat-b")] },
      { id: "file-only-answer", role: "assistant", content: "견적서입니다.", modelId: "gpt-5-6-luna" },
    ]);
    await page.goto("/chat?lang=ko&conversation=chat-quote");
    const compares = page.getByTestId("chat-compare-in-review");
    await expect(compares).toHaveCount(3);
    // The file-only turn explains instead of comparing an older question.
    await compares.nth(2).click();
    await expect(page.getByText("이 답변의 질문에는 파일만 있어 비교할 질문이 없습니다.", { exact: false })).toBeVisible();
    await expect(page).toHaveURL(/\/chat/);
    // The later text-only question keeps the plain handoff.
    await compares.nth(1).click();
    await expect(page).toHaveURL(/\/review(?:\?|$)/);
    await expect(composer(page).getByTestId("chat-textarea")).toHaveValue(/보증 기간은요\?$/);
    await expect(page.getByTestId("review-file-reattach")).toHaveCount(0);
  });

  test("Studio Review asks for the PDF too, and the picker opens from the keyboard", async ({ page }) => {
    await prepareGuestPage(page, "ko", "studio");
    await seed(page);
    await compareFromChat(page, 0);
    const choose = composer(page).getByTestId("review-file-reattach-choose");
    await expect(composer(page).getByTestId("review-file-reattach")).toHaveText(new RegExp(NOTICE));
    // The prompt sits above the input; the input keeps its own full row.
    await expect(composer(page).getByTestId("chat-textarea")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await choose.focus();
    const chooser = page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    await (await chooser).setFiles([QUOTE_A]);
    await expect(composer(page).getByTestId("review-file-reattach-attached")).toHaveText("파일 첨부됨");
    expect(chatBodies).toEqual([]);
  });

  test("a question sent with one spreadsheet asks for it again the same way", async ({ page }) => {
    const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    await seed(page, [
      { id: "xlsx-question", role: "user", content: "가장 싼 항목은?", attachments: [{ ...storedQuote("att-chat-x"), name: "prices.xlsx", mediaType: XLSX_TYPE }] },
      { id: "xlsx-answer", role: "assistant", content: "B 항목입니다.", modelId: "gpt-5-6-luna" },
    ]);
    await compareFromChat(page, 0);
    await expect(composer(page).getByTestId("chat-textarea")).toHaveValue("가장 싼 항목은?");
    await expect(composer(page).getByTestId("review-file-reattach")).toHaveText(new RegExp(NOTICE));
    await page.waitForTimeout(300);
    expect(sideEffects).toEqual([]);
    await chooseFile(page, { name: "prices.xlsx", mimeType: XLSX_TYPE, buffer: createQaXlsxBuffer() });
    await expect(composer(page).getByTestId("attachment-complete")).toContainText("prices.xlsx");
    await expect(composer(page).getByTestId("review-file-reattach-attached")).toHaveText("파일 첨부됨");
    await composer(page).getByRole("button", { name: /전송|Send/ }).click();
    await expect.poll(() => chatBodies.length).toBeGreaterThan(0);
    for (const body of chatBodies) {
      expect(newestUserTurn(body).attachments).toHaveLength(1);
      expect(newestUserTurn(body).attachments?.[0]).toMatchObject({ name: "prices.xlsx" });
      expect(body).not.toContain("att-chat-x");
    }
  });

  test("a copied handoff URL opens the question without the file prompt", async ({ page }) => {
    await seed(page);
    // Another tab, or a URL pasted later: this tab never issued the token.
    await page.goto(`/review?lang=ko&prompt=${encodeURIComponent(QUESTION)}&fileHandoff=copied-token`);
    await expect(composer(page).getByTestId("chat-textarea")).toHaveValue(QUESTION);
    await expect(page.getByTestId("review-file-reattach")).toHaveCount(0);
  });

  for (const existing of ["text", "file"] as const) {
    test(`a Review draft already holding ${existing === "text" ? "text" : "only a file"} is kept as it is`, async ({ page }) => {
      await seed(page);
      await page.goto("/review?lang=ko");
      if (existing === "text") {
        await composer(page).getByTestId("chat-textarea").fill("내가 쓰던 Review 질문");
      } else {
        await composer(page).getByTestId("composer-tools-button").click();
        await page.getByTestId("tools-attach-row").click();
        const chooser = page.waitForEvent("filechooser");
        await page.getByTestId("attach-local-file-row").click();
        await (await chooser).setFiles([QUOTE_B]);
        await expect(composer(page).getByTestId("attachment-complete")).toHaveCount(1);
      }
      const uploadsBefore = uploadedBodies.length;
      const switcher = await openProductSwitcher(page);
      await switcher.getByTestId("chat-product-chat").click();
      await expect(page).toHaveURL(/\/chat/);
      await openRecentConversation(page, { title: CHAT_TITLE });
      const compare = page.getByTestId("chat-compare-in-review").first();
      await expect(compare).toBeVisible();
      await compare.click();
      await expect(page).toHaveURL(/\/review(?:\?|$)/);
      await expect(page.getByText("작성 중인 Review 초안을 유지했습니다.")).toBeVisible();
      await expect(composer(page).getByTestId("chat-textarea")).toHaveValue(existing === "text" ? "내가 쓰던 Review 질문" : "");
      await expect(composer(page).getByTestId("attachment-complete")).toHaveCount(existing === "text" ? 0 : 1);
      await expect(page.getByTestId("review-file-reattach")).toHaveCount(0);
      await expect(page.getByTestId("review-file-reattach-attached")).toHaveCount(0);
      expect(uploadedBodies.length).toBe(uploadsBefore);
      expect(chatBodies).toEqual([]);
    });
  }
});
