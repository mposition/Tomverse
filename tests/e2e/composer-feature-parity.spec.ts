import { expect, test } from "@playwright/test";
import { mockAttachmentUpload, mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";
import { installChatModelStub, mockUserUsage, restoreActiveConversation, suppressTransientUi } from "./support/chat-state-fixtures";
import { expectTappableInVisibleViewport, openOnScreenKeyboard } from "./support/ui-audit";

test.describe("Shared Chat and Review composer", () => {
  test.use({ hasTouch: true });
  test.beforeEach(async ({}, info) => {
    test.skip(info.project.name !== "desktop-chromium", "Explicit desktop and mobile viewports.");
  });

  for (const product of ["chat", "review"] as const) {
    for (const appearance of ["studio", "classic"] as const) {
      for (const width of [1440, 390, 320]) {
        test(`${product} ${appearance} ${width}px shares tools and sends an attachment`, { tag: "@ui-risk" }, async ({ page }, info) => {
          await page.setViewportSize({ width, height: 900 });
          await prepareGuestPage(page, "en", appearance, appearance);
          const account = await mockAuthenticatedApi(page, { productKey: product, selectedModels: ["gpt-6-luna"], language: "en", assistantProfiles: [] });
          await mockUserUsage(page, { plan: "Max", limits: { maxModels: 3, creditsMonth: 10_000 } });
          const uploads = await mockAttachmentUpload(page);
          await installChatModelStub(page, { "gpt-6-luna": { kind: "success", chunks: ["Shared composer answer."] } });
          await page.route("**/api/chat/context", route => route.fulfill({ json: { ok: true, contextBundle: null, memoryUsedCount: 0 } }));
          await suppressTransientUi(page);
          await restoreActiveConversation(page);
          await page.context().addCookies(["chat_workspace", "voice_input", "image_generation"].map(flag => ({ name: `__tomverse_e2e_${flag}`, value: "1", url: "http://127.0.0.1:3100" })));
          await page.goto(`/${product}?lang=en`);
          await expect(page.locator('[data-testid="desktop-chat-shell"], [data-testid="mobile-chat-shell"]')).toHaveAttribute("data-content-state", "empty");
          await page.getByTestId("chat-textarea").fill("Keep this attachment draft.");
          await expect(page.getByTestId("composer-voice-button")).toBeVisible();
          if (appearance === "studio") {
            await expect(page.getByTestId("composer-web-search-shortcut")).toBeVisible();
            await page.getByTestId("composer-deep-research-shortcut").click();
            await expect(page.getByTestId("deep-research-confirm-start")).toBeVisible();
            await page.getByTestId("deep-research-cancel").click();
          }
          if (width === 390) await openOnScreenKeyboard(page);
          await page.getByTestId("composer-tools-button").click();
          for (const feature of ["attach", "web-search", "assistant", "memory", "deep-research", "image-generation"]) {
            const control = page.getByTestId(`tools-${feature}-row`);
            await control.scrollIntoViewIfNeeded();
            await expectTappableInVisibleViewport(page, control, `${product} ${feature}`);
          }
          await page.getByTestId("tools-web-search-row").click();
          await expect(page.getByTestId("tools-web-search-row")).toBeChecked();
          await page.getByTestId("tools-memory-row").click();
          await page.getByTestId("memory-mode-option-on").click();
          await expect.poll(() => account.memoryMode).toBe("on");
          await page.getByTestId("composer-tools-button").click();
          await page.getByTestId("tools-assistant-row").click();
          await page.getByTestId("assistant-option-none").click();
          await page.getByTestId("composer-tools-button").click();
          await page.getByTestId("tools-attach-row").click({ timeout: 10_000 });
          await expect(page.getByTestId("attach-google-drive-row")).toBeVisible();
          if (width === 390) {
            const dialog = page.locator("#chat-input-popover");
            await expect(dialog).toHaveAttribute("data-keyboard-inset", "300");
            expect(await dialog.evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(600);
          }
          const chooserPromise = page.waitForEvent("filechooser");
          await page.getByTestId("attach-local-file-row").click({ timeout: 10_000 });
          await (await chooserPromise).setFiles({ name: "composer-notes.txt", mimeType: "text/plain", buffer: Buffer.from("Shared composer attachment") });
          await expect(page.getByTestId("attachment-complete")).toBeVisible();
          await expect(page.getByTestId("chat-textarea")).toHaveValue("Keep this attachment draft.");
          expect(uploads.finalizeCount).toBe(1);
          await page.screenshot({ path: info.outputPath(`${product}-${appearance}-${width}-attachment.png`) });
          await page.getByTestId("chat-send-button").click();
          await expect(page.getByText("Shared composer answer.", { exact: true })).toBeVisible();
          await expect(page.locator('[data-message-role="user"]').filter({ hasText: "composer-notes.txt" })).toBeVisible();
          const requests = await page.evaluate(() => (window as unknown as { __chatModelStubRequests: { messages: { role: string; attachments?: { attachmentId?: string }[] }[] }[] }).__chatModelStubRequests);
          expect(requests).toHaveLength(1);
          const sent = requests[0].messages.findLast(message => message.role === "user");
          expect(sent?.attachments?.[0].attachmentId).toBeTruthy();
        });
      }
    }
  }
});

test.describe("Composer analytics footer", () => {
  test.use({ hasTouch: true });
  test.beforeEach(async ({}, info) => {
    test.skip(info.project.name !== "desktop-chromium", "Explicit desktop and mobile viewports.");
  });
  for (const product of ["chat", "review"] as const) for (const appearance of ["studio", "classic"] as const) for (const width of [1440, 390, 320]) {
    test(`${product} ${appearance} ${width}px keeps analytics below the composer`, { tag: "@ui-risk" }, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await prepareGuestPage(page, "en", appearance, appearance);
      await mockAuthenticatedApi(page, { productKey: product, selectedModels: ["gpt-6-luna"], language: "en" });
      await restoreActiveConversation(page);
      await page.context().addCookies(["chat_workspace", "analytics"].map(flag => ({ name: `__tomverse_e2e_${flag}`, value: "1", url: "http://127.0.0.1:3100" })));
      await page.route("**/api/analytics/consent-policy", route => route.fulfill({ json: { country: "AU", mode: "notice_opt_out" } }));
      await page.route("**/api/analytics/events", route => route.fulfill({ status: 202, body: "" }));
      await page.goto(`/${product}?lang=en`);
      const notice = page.getByTestId("composer-consent-slot").getByTestId("chat-consent-notice");
      await expect(notice).toBeVisible();
      const disclaimer = page.getByTestId(width <= 768 && !(product === "review" && appearance === "studio") ? "chat-ai-disclaimer-mobile" : "chat-ai-disclaimer");
      await expect(disclaimer).toBeVisible();
      expect((await notice.boundingBox())!.y).toBeGreaterThanOrEqual((await disclaimer.boundingBox())!.y + (await disclaimer.boundingBox())!.height);
      for (const kind of ["decline", "accept"]) {
        const action = notice.getByTestId(`analytics-consent-${kind}`);
        await action.scrollIntoViewIfNeeded();
        await expectTappableInVisibleViewport(page, action, `${product} analytics ${kind}`);
      }
      await page.screenshot({ path: info.outputPath(`${product}-${appearance}-${width}-analytics-footer.png`) });
      if (width > 768 && appearance === "studio") {
        const panel = page.locator(".review-studio-task");
        const bottomGap = (await panel.boundingBox())!.y + (await panel.boundingBox())!.height - ((await notice.boundingBox())!.y + (await notice.boundingBox())!.height);
        expect(bottomGap).toBeLessThan(60);
      }
      await notice.getByTestId("analytics-consent-accept").click();
      await expect(notice).toHaveCount(0);
    });
  }
});
