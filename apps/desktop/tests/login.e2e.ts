import assert from "node:assert/strict";
import { openCodeProject } from "./code-project-fixture";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, chromium, expect } from "@playwright/test";
import { FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";

const require = createRequire(import.meta.url);
const executablePath: string = require("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));
const origin = process.env.DESKTOP_E2E_AUTH_ORIGIN;
const email = process.env.DESKTOP_E2E_AUTH_EMAIL;
const emailCode = process.env.DESKTOP_E2E_AUTH_CODE;
const intent = process.env.DESKTOP_E2E_AUTH_INTENT === "signup" ? "signup" : "signin";
const sessionEnd = process.env.DESKTOP_E2E_SESSION_END;
const secondEmail = process.env.DESKTOP_E2E_SECOND_EMAIL;
const secondCode = process.env.DESKTOP_E2E_SECOND_CODE;
const copiedCodeKey = process.env.DESKTOP_E2E_CODE_KEY;
const handoffMode = process.env.DESKTOP_E2E_HANDOFF === "true";

test("Desktop connects the selected web account through Chromium and the local callback", {
  timeout: 90_000, skip: !origin || !email || !emailCode ? "Requires an isolated local Next.js authentication fixture" : false,
}, async (testContext) => {
  assert.ok(origin && email && emailCode);
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d{4,5}$/);
  const temporary = await mkdtemp(resolve(tmpdir(), "tomverse-login-e2e-"));
  const profile = join(temporary, "profile");
  const project = join(temporary, "test-project");
  const descriptor = join(temporary, "fixture.json");
  let gateway: FakeGateway | undefined;
  const launch = () => electron.launch({ executablePath,
    args: [desktopDir, ...(gateway ? ["--desktop-fixture", descriptor] : [`--user-data-dir=${profile}`])] });
  let application: Awaited<ReturnType<typeof launch>> | undefined;
  let browser;
  try {
    if (sessionEnd === "native-revoke" || handoffMode) {
      await mkdir(project);
      await mkdir(profile);
      const answer = handoffMode ? (await import("./handoff-fixture")).codeAnswer : undefined;
      gateway = await new FakeGateway({ script: () => answer ? { text: answer } : { fault: "hang" } }).start();
      await writeFile(descriptor, JSON.stringify({ profile, root: project, endpoint: gateway.base, key: TEST_KEY }));
    }
    application = await launch();
    const textLocales = process.env.DESKTOP_E2E_TEXT_LOCALES === "true" ? await import("./text-locale-fixture") : null;
    if (textLocales) await textLocales.installTextLocalesFixture(application, origin);
    const reviewFixture = process.env.DESKTOP_E2E_REVIEW === "true" ? await import("./review-fixture") : null;
    if (reviewFixture) await reviewFixture.installReviewCapabilities(application, origin);
    browser = await chromium.launch();
    const context = await browser.newContext();
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      return url.protocol === "http:" && url.hostname === "127.0.0.1" ? route.continue() : route.abort();
    });
    const web = await context.newPage();
    const desktop = await application.firstWindow();
    await application.evaluate(({ shell }, localOrigin) => {
      const testHost = globalThis as typeof globalThis & { loginTarget?: string };
      shell.openExternal = async (url) => {
        const target = new URL(url);
        if (target.origin !== localOrigin || target.pathname !== "/auth/desktop") throw new Error("Unexpected Desktop destination.");
        testHost.loginTarget = target.href;
      };
    }, origin);
    await desktop.getByRole("button", { name: "Desktop settings" }).click();
    await desktop.getByRole("button", { name: "Sign in with your browser" }).click();
    await expect(desktop.getByText("Continue sign-in in your browser.")).toBeVisible();
    const login = await application.evaluate(() =>
      (globalThis as typeof globalThis & { loginTarget?: string }).loginTarget);
    assert.ok(login);
    await web.goto(login);
    await expect(web).toHaveURL(/\/auth\/signin\?callbackUrl=/);
    const signup = web.getByTestId("signin-to-signup-link");
    await expect(signup).toBeVisible();
    const signupUrl = new URL((await signup.getAttribute("href"))!, origin);
    assert.equal(signupUrl.pathname, "/auth/signup");
    assert.equal(signupUrl.searchParams.get("callbackUrl"), new URL(login).pathname + new URL(login).search);
    await signup.click();
    const signupConsent = web.getByTestId("signin-terms-notice");
    await expect(signupConsent.locator('a[href="/terms"]')).toBeVisible();
    await expect(signupConsent.locator('a[href="/privacy"]')).toBeVisible();
    await web.waitForLoadState("networkidle");

    const csrf = await context.request.get(new URL("/api/auth/csrf", origin).href);
    assert.equal(csrf.status(), 200);
    const { csrfToken } = await csrf.json();
    const returnUrl = new URL(login);
    if (intent === "signup") returnUrl.searchParams.set("signupConsent", randomUUID());
    const authenticated = await context.request.post(new URL("/api/auth/callback/email-code", origin).href, {
      form: { csrfToken, email, code: emailCode, intent, callbackUrl: returnUrl.href, json: "true" },
      headers: { origin },
    });
    assert.equal(authenticated.status(), 200);
    const destination = (await authenticated.json()).url;
    assert.equal(destination, returnUrl.href);
    await web.goto(destination);
    await expect(web.getByRole("heading", { name: "Connect Tomverse Desktop" })).toBeVisible();
    await expect(web.getByText(email, { exact: true })).toBeVisible();
    await web.getByRole("button", { name: "Continue in Desktop" }).click();
    await expect(web.getByText("Tomverse Desktop is connected. You can return to the app.")).toBeVisible();
    await expect(desktop.getByText(`Connected as ${email}`)).toBeVisible();
    await expect.poll(() => desktop.evaluate(async () =>
      typeof (await window.desktop.state()).capabilities?.autoSelection)).toBe("boolean");
    if (copiedCodeKey) {
      await application.evaluate(({ clipboard }, fixture) => {
        clipboard.readText = async () => fixture.key;
        const original = globalThis.fetch;
        let attempts = 0;
        globalThis.fetch = async (input, init) => {
          if (String(input) === fixture.origin + "/api/auth/desktop/code-key" && attempts++ === 0) {
            return new Response(null, { status: 401 });
          }
          return original(input, init);
        };
      }, { key: copiedCodeKey, origin });
      await desktop.getByTestId("desktop-settings-developer").click();
      await desktop.getByRole("button", { name: "Connect copied key" }).click();
      const prefix = copiedCodeKey.split("_").slice(0, 2).join("_");
      await expect(desktop.getByText(`Connected as ${prefix}`)).toBeVisible();
      await expect.poll(() => desktop.evaluate(async () => (await window.desktop.state()).models.length)).toBeGreaterThan(0);
      assert.equal(await desktop.evaluate(async (key) =>
        JSON.stringify(await window.desktop.state()).includes(key), copiedCodeKey), false);
    }
    const account = await desktop.evaluate(async () => (await window.desktop.state()).account);
    assert.equal(account.stage, "connected");
    assert.equal(account.label, email);
    assert.equal(await desktop.evaluate(() => Object.keys(localStorage).some((key) => /auth|token/i.test(key))), false);
    if (process.env.TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_NATIVE_E2E === "true" ||
        process.env.TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_PREVIEW === "true") {
      await desktop.getByTestId("desktop-settings-preferences").click();
      const preferences = desktop.getByTestId("native-account-preferences");
      const theme = preferences.getByLabel("Theme", { exact: true });
      const readTheme = async () => {
        const response = await context.request.get(origin + "/api/user/settings");
        assert.equal(response.ok(), true, await response.text());
        return (await response.json()).theme;
      };
      const savedTheme = await readTheme();
      const alternate = savedTheme === "dark" ? "light" : "dark";
      await expect(theme).toHaveValue(savedTheme, { timeout: 25_000 });
      assert.equal(await desktop.evaluate(() => document.cookie.includes("next-auth.session-token")), false);
      await theme.selectOption(alternate);
      await preferences.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(theme).toHaveValue(savedTheme);
      assert.equal(await readTheme(), savedTheme);
      try {
        await theme.selectOption(alternate);
        await preferences.getByRole("button", { name: "OK", exact: true }).click();
        await expect.poll(readTheme).toBe(alternate);
        await expect(theme).toHaveValue(alternate);
      } finally {
        const reset = await context.request.post(origin + "/api/user/settings", { headers: { origin }, data: { theme: savedTheme } });
        assert.equal(reset.ok(), true);
      }
      await desktop.getByRole("button", { name: "Close", exact: true }).click();
      if (process.env.DESKTOP_E2E_CHAT_IMPORT === "true") {
        await desktop.getByRole("button", { name: "Chat", exact: true }).click();
        await desktop.getByRole("button", { name: /Continue an AI conversation/ }).click();
        const imports = desktop.getByTestId("native-account-imports");
        await imports.getByRole("button", { name: /Continue an AI conversation/ }).first().click();
        await expect(desktop.getByText("A saved message from the imported chat", { exact: true })).toBeVisible({ timeout: 25_000 });
      }
    }
    if (textLocales) {
      const runningApplication = application;
      await testContext.test("Signed-in Chat and Review expose all eight languages and keep IME input local", () =>
        textLocales.verifyTextLocales(runningApplication, desktop));
      return;
    }
    if (handoffMode && gateway) {
      const { verifyHandoff } = await import("./handoff-fixture");
      const handoffApplication = application;
      const handoffGateway = gateway;
      await testContext.test("Selected Chat and Code excerpts are confirmed and sent only from their drafts", () =>
        verifyHandoff(handoffApplication, desktop, context, origin, project, handoffGateway));
      return;
    }
    if (reviewFixture) await reviewFixture.verifyReviewAndImages(application, desktop, { origin, profile, email });
    if (process.env.DESKTOP_E2E_ATTACHMENT_PORT) {
      const { verifyAttachments } = await import("./attachment-fixture");
      await verifyAttachments(application, desktop, origin, Number(process.env.DESKTOP_E2E_ATTACHMENT_PORT), profile);
    }
    if (process.env.DESKTOP_E2E_DRAFTS === "true") {
      const title = "Saved draft conversation " + randomUUID();
      const created = await context.request.post(origin + "/api/products/chat/conversations", { data: { title }, headers: { origin } });
      assert.equal(created.ok(), true, await created.text());
      const { id } = await created.json();
      try {
        await application.evaluate(({ dialog, shell }, localOrigin) => {
          const host = globalThis as typeof globalThis & {
            draftRequests: number; acceptSetting: boolean; settingsTargets: string[]; settingsDetails: string[];
          };
          host.draftRequests = 0;
          host.acceptSetting = false;
          host.settingsTargets = [];
          host.settingsDetails = [];
          const realFetch = globalThis.fetch;
          globalThis.fetch = (target, init) => {
            if (String(target) === localOrigin + "/api/chat" && init?.method === "POST") {
              host.draftRequests++;
              throw new Error("A draft must be explicitly sent.");
            }
            return realFetch(target, init);
          };
          shell.openExternal = async (url) => { host.settingsTargets.push(url); };
          dialog.showMessageBox = async (_window: unknown, options?: Electron.MessageBoxOptions) => {
            host.settingsDetails.push(options?.detail ?? "");
            return { response: host.acceptSetting ? 1 : 0, checkboxChecked: false };
          };
        }, origin);
        await desktop.getByRole("button", { name: "Chat", exact: true }).click();
        const input = desktop.getByRole("textbox", { name: "Chat message" });
        const sendDraft = desktop.getByRole("button", { name: "Send Chat message" });
        await desktop.getByRole("button", { name: title, exact: true }).click();
        await input.fill("A draft for an existing conversation");
        await desktop.getByRole("button", { name: "New chat", exact: true }).click();
        await expect(input).toHaveValue("");
        await desktop.evaluate(() => window.dispatchEvent(new Event("offline")));
        await input.fill("An unsent offline draft");
        await expect(desktop.getByText("You’re offline. You can keep editing this draft.")).toBeVisible();
        await expect(sendDraft).toBeDisabled();
        await input.press("Enter");
        await desktop.evaluate(() => window.dispatchEvent(new Event("online")));
        await expect(sendDraft).toBeEnabled();
        await desktop.getByRole("button", { name: title, exact: true }).click();
        await expect(input).toHaveValue("A draft for an existing conversation");
        await desktop.getByRole("button", { name: "New chat", exact: true }).click();
        await expect(input).toHaveValue("An unsent offline draft");
        assert.equal(await application.evaluate(() => (globalThis as typeof globalThis & { draftRequests: number }).draftRequests), 0);
        await desktop.getByRole("button", { name: "Desktop settings" }).click();
        await desktop.getByRole("button", { name: "Delete account", exact: true }).click();
        const settings = () => application!.evaluate(() => {
          const host = globalThis as typeof globalThis & { settingsTargets: string[]; settingsDetails: string[] };
          return { targets: host.settingsTargets, details: host.settingsDetails };
        });
        await expect.poll(async () => (await settings()).details.length).toBe(1);
        assert.deepEqual((await settings()).targets, []);
        await application.evaluate(() => { (globalThis as typeof globalThis & { acceptSetting: boolean }).acceptSetting = true; });
        for (const [tab, label] of [["plan", "Manage billing"], ["data", "Export account data"], ["account", "Delete account"]]) {
          await desktop.getByTestId(`desktop-settings-${tab}`).click();
          await desktop.getByRole("button", { name: label, exact: true }).click();
        }
        await expect.poll(async () => (await settings()).targets.length).toBe(3);
        const confirmed = await settings();
        assert.deepEqual(confirmed.targets, ["https://tomverse.app/chat?settings=plan", "https://tomverse.app/settings/data",
          "https://tomverse.app/chat?settings=account"]);
        assert.ok(confirmed.details.every((detail) => detail.includes(email) && detail.includes("sign in again")));
      } finally {
        const deleted = await context.request.delete(origin + `/api/conversations/${id}`, { headers: { origin } });
        assert.equal(deleted.ok(), true, await deleted.text());
      }
    }
    if (process.env.DESKTOP_E2E_CHAT_HISTORY === "true") {
      const title = "Web chat " + randomUUID();
      const phrase = "History query " + randomUUID();
      const created = await context.request.post(origin + "/api/products/chat/conversations", {
        data: { title }, headers: { origin },
      });
      assert.equal(created.ok(), true, await created.text());
      const { id } = await created.json();
      const saved = await context.request.post(origin + `/api/conversations/${id}/messages`, {
        data: { messages: [{ id: randomUUID(), role: "user", content: phrase }] }, headers: { origin },
      });
      assert.equal(saved.ok(), true, await saved.text());
      try {
        await desktop.getByRole("button", { name: "Chat", exact: true }).click();
        await desktop.getByRole("button", { name: title, exact: true }).click();
        await expect(desktop.getByRole("list", { name: "Chat conversation" }).getByText(phrase)).toBeVisible();
        await desktop.getByRole("button", { name: "New chat", exact: true }).click();
        await expect(desktop.getByRole("heading", { name: /Good to see you again\./ })).toBeVisible();
        await desktop.getByRole("button", { name: "Search conversations" }).click();
        await desktop.getByRole("textbox", { name: "Search conversation history" }).fill(phrase);
        await desktop.getByRole("region", { name: "Matching messages" }).getByRole("button").click();
        await expect(desktop.getByRole("list", { name: "Chat conversation" }).getByText(phrase)).toBeVisible();
        if (process.env.DESKTOP_E2E_CHAT_WRITE === "true") {
          const renamed = "Renamed on Windows " + randomUUID();
          await desktop.getByLabel("Conversation actions").click();
          await desktop.getByRole("button", { name: "Rename conversation" }).click();
          await desktop.getByRole("textbox", { name: "Conversation name" }).fill(renamed);
          await desktop.getByRole("button", { name: "Save name" }).click();
          await expect(desktop.locator("main > header").getByText(renamed)).toBeVisible();
          const browserRead = await context.request.get(origin + `/api/conversations/${id}`);
          assert.equal((await browserRead.json()).title, renamed);
        }
      } finally {
        const deleted = await context.request.delete(origin + `/api/conversations/${id}`, { headers: { origin } });
        assert.equal(deleted.ok(), true, await deleted.text());
      }
    }
    if (process.env.DESKTOP_E2E_CHAT_WRITE === "true") {
      const chatApplication = application;
      const { prisma } = await import("../../../lib/prisma.ts");
      const prompt = "Desktop streamed question " + randomUUID();
      const stoppedPrompt = "Desktop stopped question " + randomUUID();
      const uncertainPrompt = "Desktop unconfirmed question " + randomUUID();
      type Turn = { conversationId: string; assistantMessageId: string; sourceUserMessageId: string; reasoningEffort: string };
      await application.evaluate(({ dialog, shell }, probe) => {
        const host = globalThis as typeof globalThis & {
          turns: Turn[]; finish?: () => void; acceptDelete: boolean; deleteDecisions: number[]; reviewTarget?: string;
        };
        const fetchReal = globalThis.fetch;
        host.turns = [];
        host.acceptDelete = false;
        host.deleteDecisions = [];
        shell.openExternal = async (url) => { host.reviewTarget = url; };
        dialog.showMessageBox = async () => {
          const response = host.acceptDelete ? 1 : 0;
          host.deleteDecisions.push(response);
          return { response, checkboxChecked: false };
        };
        globalThis.fetch = async (target, init) => {
          if (String(target) !== probe.origin + "/api/chat" || init?.method !== "POST") return fetchReal(target, init);
          const body = JSON.parse(String(init.body));
          host.turns.push(body);
          if (body.messages.at(-1).content === probe.uncertainPrompt) throw new TypeError("Fixture response lost");
          const partial = body.messages.at(-1).content === probe.prompt ? "Opening fixture words." : "Answer before Stop.";
          const encoder = new TextEncoder();
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(partial));
              host.finish = () => {
                controller.enqueue(encoder.encode(" Saved with the conversation."));
                controller.close();
              };
              init.signal?.addEventListener("abort", () => controller.error(new DOMException("Stopped", "AbortError")), { once: true });
            },
          }), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
        };
      }, { origin, prompt, uncertainPrompt });
      let chatId: string | undefined;
      try {
        await desktop.getByRole("button", { name: "Chat", exact: true }).click();
        await desktop.getByRole("button", { name: "New chat", exact: true }).click();
        const draft = desktop.getByRole("textbox", { name: "Chat message" });
        await expect(draft).toBeFocused();
        await expect(desktop.getByLabel("New chat options")).toHaveCount(0);
        await expect(desktop.getByRole("menuitem", { name: "Open image workspace on the web" })).toHaveCount(0);
        if (process.env.DESKTOP_E2E_CHAT_STARTERS === "true") {
          const suggestions = desktop.getByRole("region", { name: "Starter suggestions" }).getByRole("button");
          await expect(suggestions).toHaveCount(6);
          const order = await suggestions.allTextContents();
          const count = await prisma.conversation.count();
          await suggestions.first().click();
          await expect(draft).not.toHaveValue("");
          assert.equal(await prisma.conversation.count(), count);
          assert.deepEqual(await suggestions.allTextContents(), order);
          await draft.fill("My own draft");
          await suggestions.last().click();
          await expect(draft).toHaveValue("My own draft");
        }
        await desktop.getByLabel("Chat model and reasoning effort").click();
        await desktop.getByRole("combobox", { name: "Reasoning effort" }).selectOption("high");
        await desktop.getByLabel("Chat model and reasoning effort").click();
        await draft.fill(prompt);
        await desktop.getByRole("button", { name: "Send Chat message" }).click();
        await expect(desktop.getByText("Opening fixture words.")).toBeVisible({ timeout: 18_000 });
        const [turn] = await application.evaluate(() =>
          (globalThis as typeof globalThis & { turns: Turn[] }).turns);
        assert.ok(turn);
        chatId = turn.conversationId;
        assert.equal(turn.reasoningEffort, "high");
        const persisted = await prisma.message.findUniqueOrThrow({ where: { id: turn.sourceUserMessageId } });
        assert.equal(persisted.content, prompt);
        await prisma.message.create({ data: { id: turn.assistantMessageId, conversationId: chatId, role: "assistant", status: "normal",
          content: "Opening fixture words. Saved with the conversation.", searchMetadata: { reasoningEffort: { requested: "high", applied: "default" } } } });
        await application.evaluate(() => (globalThis as typeof globalThis & { finish?: () => void }).finish?.());
        await expect(desktop.getByText("Opening fixture words. Saved with the conversation.")).toBeVisible();
        await expect(desktop.getByText("Reasoning effort · Default · Requested High")).toBeVisible();
        await desktop.getByRole("button", { name: "Compare in Review" }).click();
        const review = await application.evaluate(() =>
          (globalThis as typeof globalThis & { reviewTarget?: string }).reviewTarget);
        assert.ok(review);
        assert.equal(new URL(review).pathname, "/review");
        assert.equal(new URL(review).searchParams.get("prompt"), prompt);
        await expect(draft).toHaveValue("");
        await draft.fill(stoppedPrompt);
        await desktop.getByRole("button", { name: "Send Chat message" }).click();
        await expect(desktop.getByText("Answer before Stop.")).toBeVisible();
        await desktop.getByRole("button", { name: "Stop Chat response" }).click();
        await expect(desktop.getByText("Response stopped.")).toBeVisible();
        await expect(desktop.getByText("Answer before Stop.")).toBeVisible();
        await draft.fill(uncertainPrompt);
        await desktop.getByRole("button", { name: "Send Chat message" }).click();
        await expect(desktop.getByText("Tomverse could not confirm the response. Reload the conversation before trying again.")).toBeVisible();
        await expect(desktop.getByRole("list", { name: "Chat conversation" }).getByText(uncertainPrompt)).toBeVisible();
        await expect(draft).toHaveValue("");
        const requestCount = await application.evaluate(() =>
          (globalThis as typeof globalThis & { turns: Turn[] }).turns.length);
        assert.equal(requestCount, 3);
        await desktop.getByLabel("Conversation actions").click();
        await desktop.getByRole("button", { name: "Delete conversation" }).click();
        await expect.poll(() => chatApplication.evaluate(() =>
          (globalThis as typeof globalThis & { deleteDecisions: number[] }).deleteDecisions)).toEqual([0]);
        await expect.poll(async () => (await prisma.conversation.findUnique({ where: { id: chatId! } }))?.id).toBe(chatId);
        await application.evaluate(() => { (globalThis as typeof globalThis & { acceptDelete: boolean }).acceptDelete = true; });
        await desktop.getByLabel("Conversation actions").click();
        await desktop.getByRole("button", { name: "Delete conversation" }).click();
        await expect.poll(() => prisma.conversation.findUnique({ where: { id: chatId! } })).toBeNull();
        assert.deepEqual(await application.evaluate(() =>
          (globalThis as typeof globalThis & { deleteDecisions: number[] }).deleteDecisions), [0, 1]);
      } finally {
        if (chatId) await prisma.conversation.deleteMany({ where: { id: chatId } });
        await prisma.$disconnect();
      }
    }
    if (process.platform === "win32") {
      assert.equal(account.storage, "device");
      const encrypted = await readFile(join(profile, "desktop-session.dat"));
      assert.equal(encrypted.includes("accessToken"), false);
      const protectedByOs = await application.evaluate(async ({ app, safeStorage }, bytes) => {
        const { result } = await safeStorage.decryptStringAsync(Buffer.from(bytes, "base64"));
        const saved = JSON.parse(result);
        const fs = process.getBuiltinModule("node:fs")!;
        const path = process.getBuiltinModule("node:path")!;
        fs.writeFileSync(path.join(app.getPath("userData"), "desktop-session.dat"),
          await safeStorage.encryptStringAsync(JSON.stringify({ ...saved, expiresAt: 1 })));
        return typeof saved.accessToken === "string" && saved.accessToken.length > 100 && typeof saved.refreshToken === "string";
      }, encrypted.toString("base64"));
      assert.equal(protectedByOs, true);
      await application.close();
      application = undefined;
      application = await launch();
      const restored = await application.firstWindow();
      await restored.getByRole("button", { name: "Desktop settings" }).click();
      await expect(restored.getByText(`Connected as ${email}`)).toBeVisible();
      if (copiedCodeKey) {
        const prefix = copiedCodeKey.split("_").slice(0, 2).join("_");
        await restored.getByTestId("desktop-settings-developer").click();
        await expect(restored.getByText(`Connected as ${prefix}`)).toBeVisible();
      }
      const renewed = await readFile(join(profile, "desktop-session.dat"));
      assert.equal(renewed.includes("refreshToken"), false);
      if (process.env.DESKTOP_E2E_DRAFTS === "true") {
        await restored.getByRole("button", { name: "Chat", exact: true }).click();
        await expect(restored.getByRole("textbox", { name: "Chat message" })).toHaveValue("An unsent offline draft");
        await restored.getByRole("button", { name: "Desktop settings" }).click();
      }
      if (gateway) {
        await restored.getByRole("button", { name: "Code", exact: true }).click();
        await openCodeProject(restored);
        await restored.getByRole("textbox", { name: "Code request" }).fill("Keep this fixture task running");
        await restored.getByRole("button", { name: "Send Code request" }).click();
        await expect.poll(() => gateway!.completions.length).toBe(1);
        const firstNamespace = await restored.evaluate(async () => (await window.desktop.state()).draftNamespace);
        await restored.getByRole("textbox", { name: "Code request" }).fill("Unsent draft from the first account");
        const status = await application.evaluate(async ({ safeStorage }, probe) => {
          const { result } = await safeStorage.decryptStringAsync(Buffer.from(probe.bytes, "base64"));
          const { refreshToken } = JSON.parse(result);
          const response = await fetch(probe.origin + "/api/auth/desktop/logout", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken }),
          });
          return response.status;
        }, { bytes: renewed.toString("base64"), origin });
        assert.equal(status, 204);
        await expect.poll(async () => restored.evaluate(async () => {
          const state = await window.desktop.state();
          return { stage: state.account.stage, busy: state.busy, root: state.root, task: state.task,
            history: state.history.length, draftNamespace: state.draftNamespace };
        }), { timeout: 25_000 }).toEqual({ stage: "expired", busy: false, root: null, task: null, history: 0, draftNamespace: null });
        await assert.rejects(readFile(join(profile, "desktop-session.dat")), { code: "ENOENT" });
        if (secondEmail && secondCode) {
          await application.evaluate(({ shell }) => {
            const testHost = globalThis as typeof globalThis & { loginTarget?: string };
            shell.openExternal = async (url) => { testHost.loginTarget = url; };
          });
          await restored.getByRole("button", { name: "Desktop settings" }).click();
          await restored.getByRole("button", { name: "Sign in with your browser" }).click();
          await expect(restored.getByText("Continue sign-in in your browser.")).toBeVisible();
          const nextLogin = await application.evaluate(() =>
            (globalThis as typeof globalThis & { loginTarget?: string }).loginTarget);
          assert.ok(nextLogin);
          await web.goto(nextLogin);
          await expect(web.getByText(email, { exact: true })).toBeVisible();
          await web.getByRole("button", { name: "Use another account" }).click();
          await expect(web).toHaveURL(/\/auth\/signin\?callbackUrl=/);
          const { csrfToken } = await (await context.request.get(new URL("/api/auth/csrf", origin).href)).json();
          const switched = await context.request.post(new URL("/api/auth/callback/email-code", origin).href, {
            form: { csrfToken, email: secondEmail, code: secondCode, intent: "signin", callbackUrl: nextLogin, json: "true" },
            headers: { origin },
          });
          assert.equal((await switched.json()).url, nextLogin);
          await web.goto(nextLogin);
          await expect(web.getByText(secondEmail, { exact: true })).toBeVisible();
          await web.getByRole("button", { name: "Continue in Desktop" }).click();
          await expect(restored.getByText(`Connected as ${secondEmail}`)).toBeVisible();
          await restored.getByRole("button", { name: "Code", exact: true }).click();
          await openCodeProject(restored);
          await expect(restored.getByText("test-project", { exact: true }).first()).toBeVisible();
          await expect(restored.getByRole("textbox", { name: "Code request" })).toHaveValue("");
          const nextState = await restored.evaluate(() => window.desktop.state());
          assert.ok(nextState.draftNamespace && nextState.draftNamespace !== firstNamespace);
          assert.deepEqual(nextState.history, []);
        }
        return;
      }
      if (sessionEnd === "lost-refresh") {
        await application.evaluate(({ app, BrowserWindow }, localOrigin) => {
          const realNow = Date.now.bind(Date);
          Date.now = () => realNow() + 580_000;
          const realFetch = globalThis.fetch;
          const host = globalThis as typeof globalThis & { lostRefresh?: { status: number; vaultCleared: boolean; attempts: number } };
          let attempts = 0;
          globalThis.fetch = async (input, init) => {
            if (String(input) !== localOrigin + "/api/auth/desktop/refresh") return realFetch(input, init);
            attempts++;
            const fs = process.getBuiltinModule("node:fs")!;
            const path = process.getBuiltinModule("node:path")!;
            const vaultCleared = !fs.existsSync(path.join(app.getPath("userData"), "desktop-session.dat"));
            const response = await realFetch(input, init);
            host.lostRefresh = { status: response.status, vaultCleared, attempts };
            await response.body?.cancel();
            throw new TypeError("Fixture dropped the refresh response");
          };
          const window = BrowserWindow.getAllWindows()[0]!;
          window.emit("focus");
          window.emit("focus");
        }, origin);
        await expect(restored.getByText("Your Desktop session expired.")).toBeVisible({ timeout: 25_000 });
        assert.deepEqual(await application.evaluate(() =>
          (globalThis as typeof globalThis & { lostRefresh?: { status: number; vaultCleared: boolean; attempts: number } }).lostRefresh),
        { status: 200, vaultCleared: true, attempts: 1 });
        await assert.rejects(readFile(join(profile, "desktop-session.dat")), { code: "ENOENT" });
        return;
      }
      await application.evaluate((_electron, localOrigin) => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = (input, init) => {
          if (String(input) === localOrigin + "/api/auth/desktop/logout") throw new TypeError("Fixture disconnected");
          return realFetch(input, init);
        };
      }, origin);
      await restored.getByRole("button", { name: "Sign out of Desktop" }).click();
      await expect(restored.getByText("Signed out locally. Tomverse could not confirm this device was revoked.")).toBeVisible();
      if (process.env.DESKTOP_E2E_DRAFTS === "true") {
        assert.equal(await restored.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("tomverse.desktopDraft:"))), false);
      }
      await assert.rejects(readFile(join(profile, "desktop-session.dat")), { code: "ENOENT" });
      await application.close();
      application = undefined;
      application = await launch();
      const signedOut = await application.firstWindow();
      await signedOut.getByRole("button", { name: "Desktop settings" }).click();
      await expect(signedOut.getByRole("button", { name: "Sign in with your browser" })).toBeVisible();
    }
  } finally {
    await browser?.close();
    await application?.close();
    await gateway?.stop();
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
