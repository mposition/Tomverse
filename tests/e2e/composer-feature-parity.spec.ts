import { expect, test, type Page } from "@playwright/test";
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
          const composer = page.getByTestId("chat-input");
          await expect(composer.getByTestId("chat-product-switcher")).toBeVisible();
          await expect(composer.getByTestId("chat-product-switcher").getByRole("link").filter({ hasText: product === "chat" ? "Review" : "Chat" })).toBeVisible();
          if (product === "review") {
            await expect(page.getByTestId("composer-review-mode")).toBeVisible();
            const mode = (await page.getByTestId("composer-review-mode").boundingBox())!;
            expect(mode.y + mode.height).toBeLessThanOrEqual((await page.getByTestId("composer-textarea-row").boundingBox())!.y);
          }
          const mic = (await page.getByTestId("composer-voice-button").boundingBox())!;
          const send = (await page.getByTestId("chat-send-button").boundingBox())!;
          expect(Math.abs(mic.y + mic.height / 2 - send.y - send.height / 2)).toBeLessThan(2);
          expect(mic.x + mic.width).toBeLessThanOrEqual(send.x);
          expect(await composer.evaluate(element => getComputedStyle(element).outlineStyle)).toBe("none");
          if (appearance === "studio") {
            await expect(page.getByTestId("composer-web-search-shortcut")).toBeVisible();
            await expect(page.getByTestId("composer-deep-research-shortcut")).toHaveCount(0);
          }
          if (width === 390) await openOnScreenKeyboard(page);
          await page.getByTestId("composer-tools-button").click();
          for (const feature of ["attach", "web-search", "assistant", "memory", "deep-research", "image-generation"]) {
            const control = page.getByTestId(`tools-${feature}-row`);
            await control.scrollIntoViewIfNeeded();
            await expectTappableInVisibleViewport(page, control, `${product} ${feature}`);
          }
          await page.getByTestId("tools-deep-research-row").click();
          await expect(page.getByTestId("deep-research-confirm-start")).toBeVisible();
          await page.getByTestId("deep-research-cancel").click();
          await page.getByTestId("composer-tools-button").click();
          await page.getByTestId("tools-web-search-row").click();
          await expect(page.getByTestId("tools-web-search-row")).toBeChecked();
          const prompt = (await page.getByTestId("composer-textarea-row").boundingBox())!;
          const search = (await page.getByTestId("web-search-mode-chip").boundingBox())!;
          expect(search.y - prompt.y - prompt.height).toBeGreaterThanOrEqual(12);
          if (appearance === "studio" && width >= 390) {
            const tools = (await page.getByTestId("composer-tools-button").boundingBox())!;
            const voice = (await page.getByTestId("composer-voice-button").boundingBox())!;
            expect(Math.abs(tools.y + tools.height / 2 - search.y - search.height / 2)).toBeLessThan(2);
            expect(Math.abs(voice.y + voice.height / 2 - search.y - search.height / 2)).toBeLessThan(2);
          }
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

async function prepareReviewDefaults(page: Page, width = 1440, uncertainSave = false) {
  await page.setViewportSize({ width, height: 1000 });
  await prepareGuestPage(page, "en", "studio");
  await mockAuthenticatedApi(page, { productKey: "review", selectedModels: ["gpt-6-luna"], language: "en" });
  await mockUserUsage(page, { plan: "Max", limits: { maxModels: 3, creditsMonth: 10000 } });
  await suppressTransientUi(page);
  await restoreActiveConversation(page);
  await page.context().addCookies([{ name: "__tomverse_e2e_review_easy", value: "1", url: "http://127.0.0.1:3100" }]);
  const state = { personal: null as string[] | null, writes: 0 };
  await page.route("**/api/user/settings**", async route => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      if (Object.hasOwn(body, "reviewEasyDefaultProviders")) {
        state.personal = body.reviewEasyDefaultProviders; state.writes++;
        if (uncertainSave) return route.fulfill({ status: 500, json: { error: "Read back before retrying." } });
      }
      return route.fulfill({ json: { success: true, settings: { reviewEasyDefaultProviders: state.personal } } });
    }
    return route.fulfill({ json: {
      theme: "light", language: "en", defaultModel: "gpt-6-luna", newConversationModelIds: ["gpt-6-luna"],
      timeZone: "UTC", imageHandoffAutoGenerate: false,
      reviewEasyDefaultProviders: state.personal, reviewEasyPlatformProviders: ["anthropic"],
      reviewEasyEffectiveProviders: state.personal ?? ["anthropic"],
      reviewEasyProviderOptions: ["openai", "anthropic", "google"], reviewEasyMaxProviders: 3,
    } });
  });
  await page.goto("/review?lang=en");
  await expect(page.getByTestId("chat-input")).toBeVisible();
  if (await page.locator(".review-new-task").isVisible()) {
    await page.locator(".review-new-task").click();
  } else {
    await page.locator(".review-navigation-history").click();
    await page.getByTestId("sidebar-new-chat").click();
    const history = page.getByRole("dialog", { name: "History", exact: true });
    if (await history.isVisible()) await page.keyboard.press("Escape");
  }
  await page.getByTestId("composer-review-mode").getByRole("button", { name: "Easy", exact: true }).click();
  await expect(page.locator(".review-participant-list>button")).toContainText(["Anthropic"]);
  return state;
}

async function choosePersonalGoogle(page: Page) {
  await page.locator(".review-avatar").click();
  await page.getByTestId("settings-tab-ai").click();
  const card = page.getByTestId("review-defaults-personal");
  await expect(card.getByTestId("review-defaults-source")).toBeVisible();
  await card.getByTestId("review-defaults-source").selectOption("personal");
  await card.locator('[data-provider="anthropic"]').click();
  await card.locator('[data-provider="google"]').click();
  await card.getByTestId("review-defaults-save").click();
  return card;
}

test("Review mode controls preserve the draft and the product switch returns to Chat", { tag: "@ui-risk" }, async ({ page }) => {
  await prepareReviewDefaults(page, 390);
  await page.getByTestId("chat-textarea").fill("Keep this Review draft.");
  const mode = page.getByTestId("composer-review-mode");
  await mode.getByRole("button", { name: "Professional", exact: true }).click();
  await expect(page.getByTestId("chat-textarea")).toHaveValue("Keep this Review draft.");
  await mode.getByRole("button", { name: "Easy", exact: true }).click();
  await expect(page.getByTestId("chat-textarea")).toHaveValue("Keep this Review draft.");
  await page.getByTestId("chat-input").getByTestId("chat-product-switcher").getByRole("link").filter({ hasText: "Chat" }).click();
  await expect(page).toHaveURL(/\/chat\?lang=en/);
});

test("personal Easy defaults apply to the next Review and survive reload", { tag: "@ui-risk" }, async ({ page }, info) => {
  const state = await prepareReviewDefaults(page);
  const card = await choosePersonalGoogle(page);
  await expect(card.getByText("Easy defaults saved.", { exact: true })).toBeVisible();
  expect(state.personal).toEqual(["google"]);
  expect(state.writes).toBe(1);
  await page.screenshot({ path: info.outputPath("personal-easy-defaults.png") });
  await page.getByRole("dialog").filter({ has: card }).getByRole("button", { name: "Cancel", exact: true }).first().click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".review-participant-list>button")).toContainText(["Anthropic"]);
  await page.locator(".review-new-task").click();
  await expect(page.locator(".review-participant-list>button")).toContainText(["Google"]);
  await page.reload();
  await page.locator(".review-new-task").click();
  await expect(page.locator(".review-participant-list>button")).toContainText(["Google"]);
});

test("an uncertain default save requires read-back before another write", { tag: "@ui-risk" }, async ({ page }) => {
  const state = await prepareReviewDefaults(page, 1440, true);
  const card = await choosePersonalGoogle(page);
  await expect(card.getByRole("alert")).toContainText("Reload saved defaults before trying again.");
  await expect(card.getByTestId("review-defaults-save")).toBeDisabled();
  expect(state.writes).toBe(1);
  await card.getByRole("button", { name: "Reload saved defaults", exact: true }).click();
  await expect(card.locator('[data-provider="google"]')).toHaveAttribute("aria-pressed", "true");
  expect(state.writes).toBe(1);
});

for (const reauthentication of [false, true]) test(`platform Easy defaults ${reauthentication ? "keep administrator reauthentication" : "save and persist"}`, { tag: "@ui-risk" }, async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium", "The platform panel uses its existing guarded fixture.");
  await prepareGuestPage(page, "en");
  await mockAuthenticatedApi(page, { language: "en" });
  let providers = ["openai"];
  let writes = 0;
  await page.route("**/api/admin/app-settings", async route => {
    if (route.request().method() === "PATCH") {
      writes++;
      if (reauthentication) return route.fulfill({ status: 428, json: { code: "ADMIN_REAUTHENTICATION_REQUIRED", error: "Sign in again." } });
      const body = route.request().postDataJSON();
      expect(Object.keys(body)).toEqual(["reviewEasyDefaultProviders"]);
      providers = body.reviewEasyDefaultProviders;
    }
    return route.fulfill({ json: { reviewEasyDefaultProviders: providers, reviewEasyProviderOptions: ["openai", "anthropic", "google"] } });
  });
  await page.goto("/e2e/admin-console-fixture?view=settings&lang=en");
  const card = page.getByTestId("review-defaults-platform");
  await card.locator('[data-provider="openai"]').click();
  await card.locator('[data-provider="google"]').click();
  await card.getByTestId("review-defaults-save").click();
  if (reauthentication) {
    await expect(card.getByTestId("admin-api-reauthenticate-link")).toHaveAttribute("href", /callbackUrl=%2Fadmin%2Fplatform/);
    await expect(card.getByTestId("review-defaults-save")).toBeDisabled();
  } else {
    await expect(card.getByText("Easy defaults saved.", { exact: true })).toBeVisible();
    expect(providers).toEqual(["google"]);
    await card.screenshot({ path: info.outputPath("admin-easy-defaults.png") });
    await page.reload();
    await expect(card.locator('[data-provider="google"]')).toHaveAttribute("aria-pressed", "true");
  }
  expect(writes).toBe(1);
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
