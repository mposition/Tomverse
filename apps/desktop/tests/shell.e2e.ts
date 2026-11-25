import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron, expect, type ElectronApplication } from "@playwright/test";
import { expectWindowsAccessibleNames } from "./windows-accessibility";

const require = createRequire(import.meta.url);
const executablePath: string = process.env.TOMVERSE_DESKTOP_TEST_ELECTRON ?? require("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));
const shellUrl = "tomverse://desktop/";
const authOrigin = process.env.DESKTOP_E2E_AUTH_ORIGIN;
const accountDevicesFixture = process.env.TOMVERSE_DESKTOP_DEVICE_FIXTURE === "true";

test("Desktop settings follow the account tab order and return to the workspace that opened them", { timeout: 60_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), "tomverse-settings-"));
  let application: ElectronApplication | undefined;
  try {
    await writeFile(join(profile, "language.txt"), "en");
    application = await electron.launch({ executablePath, args: [desktopDir, `--user-data-dir=${profile}`], timeout: 20_000 });
    const page = await application.firstWindow();
    await application.evaluate(({ shell }) => {
      const host = globalThis as typeof globalThis & { settingsTargets: string[] };
      host.settingsTargets = [];
      shell.openExternal = async (href) => { host.settingsTargets.push(href); };
    });
    const rail = page.getByRole("navigation", { name: "Workspaces" });
    const entry = rail.getByRole("button", { name: "Settings", exact: true });
    const account = page.getByRole("navigation", { name: "Tomverse", exact: true });
    const code = page.getByRole("navigation", { name: "Tomverse Code", exact: true });
    const codeTitle = page.getByRole("heading", { name: "Tomverse Code", exact: true });
    await expect(codeTitle).toHaveCSS("font-family", '"Tomverse Wordmark", sans-serif');
    assert.equal(await page.evaluate(async () => (await document.fonts.load('650 16px "Tomverse Wordmark"')).length), 1);
    await rail.getByRole("button", { name: "Help", exact: true }).click();
    const docs = page.getByTestId("desktop-web-view");
    await expect(docs).toBeVisible();
    await expect(docs.getByRole("navigation", { name: "Contents", exact: true })).toBeVisible();
    await docs.getByTestId("desktop-docs-privacy").click();
    await expect(docs.getByTestId("desktop-docs-privacy")).toHaveAttribute("aria-current", "page");
    const documentViews = await application.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const views = window.contentView.children.flatMap((child) => "webContents" in child ? [child as Electron.WebContentsView] : []);
      return Promise.all(views.map(async (view) => ({
        globals: await view.webContents.executeJavaScript("[typeof window.desktop, typeof require, typeof process].join()"),
        persistent: view.webContents.session.isPersistent(), shared: view.webContents.session === window.webContents.session,
      })));
    });
    assert.deepEqual(documentViews, [{ globals: "undefined,undefined,undefined", persistent: false, shared: false }]);
    await assert.rejects(page.evaluate(() => window.desktop.webView({ type: "open-link", url: "http://127.0.0.1:1/" })));
    await assert.rejects(page.evaluate(() => window.desktop.webView({ type: "open-docs", section: "chat" as "help" })));
    await docs.getByTestId("desktop-web-view-close").click();
    await expect(docs).toHaveCount(0);
    await rail.getByRole("button", { name: "Review", exact: true }).click();
    await entry.click();
    await expect(account.getByRole("button")).toHaveText([
      "Account", "Preferences", "AI assistants", "AI personalization", "Data", "Developer", "Plan",
    ]);
    await expect(code.getByRole("button")).toHaveText(["Execution and limits", "Development CLIs", "Task permissions", "Local task history"]);
    const clis = code.getByRole("button", { name: "Development CLIs", exact: true });
    await expect(clis).toBeDisabled();
    await page.getByRole("button", { name: "Use light theme" }).click();
    await expect(entry).toHaveCSS("background-color", "rgb(41, 57, 100)");
    await page.getByRole("button", { name: "Use dark theme" }).click();
    await code.getByRole("button", { name: "Execution and limits", exact: true }).click();
    await page.getByLabel("Preferred execution mode").selectOption("provider_cli");
    await expect(clis).toBeEnabled();
    await page.getByLabel("Preferred execution mode").selectOption("tomverse_api");
    await expect(clis).toBeDisabled();
    await account.getByRole("button", { name: "Account", exact: true }).click();
    await expect(account.getByRole("button", { name: "Account", exact: true })).toHaveAttribute("aria-current", "page");
    const artifacts = process.env.TOMVERSE_DESKTOP_SETTINGS_QA;
    if (artifacts) {
      await page.screenshot({ path: join(artifacts, "desktop-settings-dark.png"), animations: "disabled" });
      await page.getByRole("button", { name: "Use light theme" }).click();
      await page.screenshot({ path: join(artifacts, "desktop-settings-light.png"), animations: "disabled" });
    }

    for (const tab of ["account", "preferences", "assistants", "ai", "data", "developer", "plan"]) {
      const button = page.getByTestId(`desktop-settings-${tab}`);
      await button.click();
      await expect(button).toHaveAttribute("aria-current", "page");
    }
    const targets = await application.evaluate(() =>
      (globalThis as typeof globalThis & { settingsTargets: string[] }).settingsTargets);
    assert.deepEqual(targets, []);
    await assert.rejects(page.evaluate(() => window.desktop.accountSettings({ action: "other" as "preferences" })));
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("main").getByRole("heading", { name: "Review", exact: true })).toBeVisible();
    await expect(entry).toBeFocused();
    await entry.click();
    await page.getByTestId("desktop-settings-preferences").press("Escape");
    await expect(account).toHaveCount(0);
    await expect(entry).toHaveAttribute("aria-pressed", "false");
    await expect(entry).toBeFocused();

    await rail.getByRole("button", { name: "Code", exact: true }).click();
    await entry.click();
    await code.getByRole("button", { name: "Task permissions", exact: true }).click();
    await expect(page.getByRole("main").getByText("Manual", { exact: true })).toBeVisible();
    await code.getByRole("button", { name: "Local task history", exact: true }).click();
    const retention = page.getByRole("checkbox", { name: "Save to local history", exact: true });
    await retention.uncheck();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(retention).not.toBeChecked();
  } finally {
    await application?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("Account settings preserve the signed-in Chat conversation and draft", { timeout: 60_000, skip: !authOrigin }, async () => {
  assert.ok(authOrigin);
  assert.match(authOrigin, /^http:\/\/127\.0\.0\.1:\d{4,5}$/);
  const profile = await mkdtemp(join(tmpdir(), "tomverse-account-settings-"));
  const conversation = { id: "account-settings-chat", title: "Chat before opening settings", kind: "chat",
    surface: "chat", productKey: "chat", updatedAt: new Date().toISOString(), selectedModels: ["gpt-6-luna"] };
  let application: ElectronApplication | undefined;
  try {
    await writeFile(join(profile, "language.txt"), "en");
    application = await electron.launch({
      executablePath, args: [desktopDir, `--user-data-dir=${profile}`, "--use-fake-device-for-media-stream"], timeout: 20_000,
    });
    const exportPath = join(profile, "chat-export.txt");
    await application.evaluate(async ({ shell, clipboard, dialog }, { origin, chat, exportPath }) => {
      const host = globalThis as typeof globalThis & {
        clips?: number; sent?: number; copied?: string; readOnly?: boolean; importRequests: string[]; pinWrites: boolean[];
        pauseTranscript?: boolean; finishTranscript?: () => void; lockFromAnotherDevice?: () => void;
      };
      host.importRequests = [];
      host.pinWrites = [];
      clipboard.writeText = async (value) => { host.copied = value; };
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath });
      const newChatId = "sent-chat-fixture";
      let question = "";
      let assistantId: string | undefined;
      const conversationDigest = "a".repeat(64);
      let importCompleted = false;
      let emailEnabled = true;
      const assistants: Array<{ id: string; name: string; description: string | null; published: boolean }> = [];
      let assistantName = "";
      let assistantInstructions = "";
      let assistantRevision = 1;
      const assistantDate = new Date().toISOString();
      const memory = { id: "memory-1", kind: "preference", statement: "The user prefers short answers.", pinned: false,
        status: "active", expiresAt: null, sensitivity: "standard" };
      let pinState = { pinned: false, pinSeq: 0 };
      let projectName = "";
      let projectId: string | null = null;
      let shareEnabled = false;
      let isLocked = false;
      host.lockFromAnotherDevice = () => { isLocked = true; shareEnabled = true; };
      const keySummary = { id: "test-key", name: "Fixture key", keyPrefix: "tv_test", state: "active",
        creditCap: 400, committedCredits: 0, expiresAt: null };
      const preferences = { theme: "dark", language: "en", timeZone: "Australia/Brisbane",
        timeZoneChangeAllowedAt: null, newConversationModelIds: ["gpt-6-luna"] };
      const realFetch = globalThis.fetch;
      shell.openExternal = async (href) => {
        const target = new URL(href);
        if (target.origin !== origin || target.pathname !== "/auth/desktop") throw new Error("Unexpected browser destination.");
        const callback = new URL(target.searchParams.get("redirect_uri")!);
        if (callback.hostname !== "127.0.0.1" || callback.pathname !== "/desktop-login/callback") {
          throw new Error("Unexpected test callback.");
        }
        callback.search = new URLSearchParams({ state: target.searchParams.get("state")!, grant: "a".repeat(43) }).toString();
        if (!(await realFetch(callback)).ok) throw new Error("Unable to connect the test account.");
      };
      globalThis.fetch = async (url, options) => {
        const target = new URL(String(url));
        if (target.origin !== origin) throw new Error("Unexpected Desktop request.");
        if (target.pathname === "/api/auth/desktop/exchange") {
          return Response.json({ ok: true, accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 600 });
        }
        if (target.pathname === "/api/auth/desktop/session") {
          return Response.json({ ok: true, account: { id: "fixture-account", name: "Settings Fixture", email: null } });
        }
        if (target.pathname === "/api/auth/desktop/logout") return Response.json({ ok: true });
        if (target.pathname === "/api/auth/desktop/settings-session") {
          if (options?.method !== "POST" || new Headers(options.headers).get("authorization") !== "Bearer fixture-access") {
            return Response.json({}, { status: 401 });
          }
          return Response.json({ token: "fixture..settings.web.session", expiresAt: Date.now() + 300_000 });
        }
        if (["/api/user/settings", "/api/user/login-methods", "/api/memories/settings", "/api/user/usage",
          "/api/user/email-preferences", "/api/assistant-profiles", "/api/external-conversations", "/api/user/api-keys",
          "/api/memories", "/api/memories/memory-1", `/api/conversations/${chat.id}/pin`].includes(target.pathname)
          || target.pathname.startsWith("/api/assistant-profiles/")
          || target.pathname === "/api/external-conversations/fixture-import"
          || target.pathname === `/api/conversations/${chat.id}/export`
          || target.pathname === `/api/conversations/${chat.id}/share`
          || target.pathname.startsWith("/api/projects")
          || (target.pathname === `/api/conversations/${chat.id}` && options?.method === "PATCH")
          || target.pathname.startsWith("/api/imports/external")) {
          const headers = new Headers(options?.headers);
          if (headers.get("cookie") !== "next-auth.session-token=fixture..settings.web.session" ||
              headers.get("origin") !== origin || headers.has("authorization")) throw new Error("Invalid settings credential transport");
          if (target.pathname === `/api/conversations/${chat.id}/export`) {
            return new Response("Exported Desktop conversation.\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
          }
          if (target.pathname === `/api/conversations/${chat.id}/share`) {
            if (options?.method === "POST") {
              shareEnabled = true;
              return Response.json({ url: "https://example.invalid/share/fixture", expiresAt: new Date().toISOString() });
            }
            if (options?.method === "DELETE") {
              shareEnabled = false;
              return Response.json({ success: true });
            }
          }
          if (target.pathname === "/api/projects") {
            if (options?.method === "POST") {
              projectName = JSON.parse(String(options.body)).name;
              return Response.json({ id: "test-project", name: projectName, conversationCount: 0 }, { status: 201 });
            }
            return Response.json({ projects: projectName ? [
              { id: "test-project", name: projectName, conversationCount: projectId === "test-project" ? 1 : 0 },
            ] : [] });
          }
          if (target.pathname === "/api/projects/test-project") {
            if (options?.method === "PATCH") {
              projectName = JSON.parse(String(options.body)).name;
              return Response.json({ id: "test-project", name: projectName, conversationCount: projectId === "test-project" ? 1 : 0 });
            }
            if (options?.method === "DELETE") {
              projectName = ""; projectId = null;
              return Response.json({ success: true });
            }
          }
          if (target.pathname === `/api/conversations/${chat.id}`) {
            const body = JSON.parse(String(options?.body));
            if (Object.hasOwn(body, "password")) {
              if (body.password !== "FixturePass!" && (body.password !== null || body.currentPassword !== "FixturePass!")) {
                return Response.json({ success: false }, { status: 403 });
              }
              isLocked = body.password !== null;
              return Response.json({ isLocked, shareEnabled });
            }
            projectId = body.projectId;
            return Response.json({ projectId });
          }
          if (target.pathname === `/api/conversations/${chat.id}/pin`) {
            const input = JSON.parse(String(options?.body));
            if (options?.method !== "PUT" || !Number.isSafeInteger(input.seq) || input.seq <= pinState.pinSeq) {
              throw new Error("Invalid conversation pin");
            }
            pinState = { pinned: input.pinned, pinSeq: input.seq };
            host.pinWrites.push(input.pinned);
            return Response.json(pinState);
          }
          if (target.pathname.startsWith("/api/imports/external")) {
            if (options?.method === "POST" || target.pathname.endsWith("/capacity")) host.importRequests.push(target.pathname);
            const body = options?.body ? JSON.parse(String(options.body)) : undefined;
            switch (target.pathname) {
              case "/api/imports/external/capacity":
                return Response.json({ remaining: { normalizedTextBytes: 1_000_000, externalConversations: 20, externalMessages: 500 },
                  usage: { normalizedTextBytes: 24, externalConversations: 1 },
                  limits: { maxNormalizedTextBytes: 52_428_800, maxExternalConversations: 2000 } });
              case "/api/imports/external":
                if (!body) return Response.json({ imports: [{ id: "fixture-run", provider: "ChatGPT", status: "completed",
                  conversationCount: 1, createdAt: new Date().toISOString() }] });
                if (body.provider !== "claude" || typeof body.parserVersion !== "string") throw new Error("Invalid native import");
                return Response.json({ importId: "fixture-import-id" }, { status: 201 });
              case "/api/imports/external/fixture-import-id/batches":
                if (body.sequence !== 0 || body.conversations.length !== 1 ||
                    body.conversations[0].messages[0].content !== "Keep this private text") throw new Error("Unexpected imported text");
                return Response.json({ results: [{ outcome: "staged", stagedConversationId: "staged-1", conversationDigest }] });
              case "/api/imports/external/fixture-import-id/seal":
                if (body.finalSequence !== 0 || body.expectedStagedConversationIds.join(",") !== "staged-1" ||
                    body.expectedDuplicateCount !== 0) throw new Error("Incorrect seal receipt");
                return Response.json({ status: "preview_ready", truncatedMessageCount: 0 });
              case "/api/imports/external/fixture-import-id/finalize":
                if (body.selectedConversationIds.join(",") !== "staged-1" || !/^[0-9a-f]{64}$/.test(body.expectedImportDigest) ||
                    typeof body.idempotencyKey !== "string" || importCompleted) throw new Error("Incorrect or repeated finalize");
                importCompleted = true;
                return Response.json({}, { status: 503 });
              case "/api/imports/external/fixture-import-id":
                return Response.json({ status: importCompleted ? "completed" : "preview_ready", expired: false, counts: { conversations: 1 } });
            }
          }
          if (target.pathname === "/api/user/email-preferences") {
            if (options?.method === "PATCH") {
              const body = JSON.parse(String(options.body));
              if (body.purpose !== "service_status" || typeof body.enabled !== "boolean") throw new Error("Unexpected email preference action");
              emailEnabled = body.enabled;
            }
            return Response.json({ country: { selfDeclared: "AU" }, preferences: [
              { purpose: "security", enabled: true, locked: true },
              { purpose: "service_status", enabled: emailEnabled, locked: false },
            ] });
          }
          if (target.pathname === "/api/assistant-profiles") {
            if (options?.method === "POST") {
              const body = JSON.parse(String(options.body));
              if (body.instructions !== "Use concise answers.") throw new Error("Instructions were not sent");
              const profile = { id: "fixture-assistant", name: body.name, description: null, published: true };
              assistantName = body.name;
              assistantInstructions = body.instructions;
              assistants.push(profile);
              return Response.json({ profile }, { status: 201 });
            }
            return Response.json({ profiles: assistants });
          }
          if (target.pathname === "/api/assistant-profiles/fixture-assistant") {
            if (options?.method === "PATCH") {
              const values = JSON.parse(String(options.body));
              assistantName = values.name;
              assistants[0]!.name = assistantName;
              return Response.json({ profile: { id: "fixture-assistant" } });
            }
            const versions = Array.from({ length: assistantRevision }, (_, index) => ({
              id: "version-" + (assistantRevision - index), revision: assistantRevision - index, createdAt: assistantDate,
            }));
            return Response.json({ profile: { id: "fixture-assistant", name: assistantName, icon: null, description: null, versions,
              knowledgeFiles: [{ id: "saved-file", name: "Reference.txt", processingStatus: "ready" }],
              currentVersion: { ...versions[0], instructions: assistantInstructions, models: [], starters: [], knowledgeManifest: [],
                toolPolicy: { webSearch: false, deepResearch: false }, memoryPolicy: { useAccountMemory: false } },
            } });
          }
          if (target.pathname === "/api/assistant-profiles/fixture-assistant/versions") {
            const body = JSON.parse(String(options?.body));
            if (options?.method !== "POST" || body.expectedRevision !== assistantRevision ||
                body.knowledgeFileIds.join(",") !== "saved-file") throw new Error("Missing assistant revision or knowledge selection");
            assistantInstructions = body.instructions;
            assistantRevision++;
            return Response.json({ outcome: "published" }, { status: 201 });
          }
          if (target.pathname === "/api/external-conversations") return Response.json({ total: 1, offset: 0, limit: 50,
            continuationEnabled: true, conversations: [{ id: "fixture-import", title: "Saved external conversation",
              provider: "ChatGPT", titleWithheld: false, messageCount: 3 }] });
          if (target.pathname === "/api/external-conversations/fixture-import") return Response.json({
            title: "Saved external conversation", offset: 0, limit: 100, messageTotal: 1,
            messages: [{ id: "imported-fixture-message", role: "user", sourceModelLabel: null, truncated: false,
              content: "<script>Private imported text</script>" }],
          });
          if (target.pathname === "/api/user/api-keys") {
            if (options?.method === "POST") return Response.json({ key: "synthetic-test-key", summary: keySummary }, { status: 201 });
            return Response.json({ enabled: true, keys: [keySummary], limits: { maxKeys: 10, maxCreditCap: 10000, expiryDays: [7, 30, 90, 365] } });
          }
          if (target.pathname === "/api/user/settings") {
            if (options?.method === "POST") {
              const changes = JSON.parse(String(options.body));
              if (Object.keys(changes).some(key => key !== "theme")) throw new Error("Unexpected preference change");
              Object.assign(preferences, changes);
              return Response.json({ success: true });
            }
            return Response.json(preferences);
          }
          if (target.pathname === "/api/user/login-methods") {
            return Response.json({ methods: [{ type: "oauth", provider: "google", linked: true }] });
          }
          if (target.pathname === "/api/memories/settings") {
            return Response.json({ masterEnabled: true, styleEnabled: true, defaultConversationMode: "on" });
          }
          if (target.pathname === "/api/memories") return Response.json({ memories: [memory], total: 1 });
          if (target.pathname === "/api/memories/memory-1") {
            if (options?.method === "PATCH") {
              const values = JSON.parse(String(options.body));
              if (values.action === "edit") memory.statement = values.statement;
              else if (values.action === "pin") memory.pinned = true;
              else throw new Error("Unexpected memory action");
              return Response.json({ ok: true });
            }
            return Response.json({ memory: { ...memory, evidence: [
              { id: "evidence-1", manualContent: "Manual preference fixture", externalConversationId: null, sourceTitle: null },
            ] }, conflicts: [] });
          }
          return Response.json({ plan: "Free", usage: { creditsMonth: 13 }, limits: { creditsMonth: 100 },
            balances: { dailyRemainingCredits: 3, planRemainingCredits: 63, purchasedRemainingCredits: 0 } });
        }
        if (target.pathname === "/api/products/chat/capabilities") return Response.json({
          autoSelection: { offered: false }, desktopWrite: !host.readOnly, desktopImport: true, desktopPlugins: true,
          desktopReview: { easy: true, plan: "Pro", modelLimit: 3 },
          desktopStarters: [
            { id: "debug-stack-trace", label: "Debug a stack trace", seed: "Help me debug this stack trace.", outcome: "Understand the error." },
            { id: "plan-a-week", label: "Plan my week", seed: "Help me plan my week.", outcome: "Make a weekly plan." },
            { id: "summarize-text", label: "Summarize long text", seed: "Summarize the text I paste.", outcome: "Get the key points." },
            { id: "draft-reply", label: "Draft a reply", seed: "Help me write a reply.", outcome: "Draft a response." },
            { id: "explain-code", label: "Explain how code works", seed: "Explain this code.", outcome: "Understand the code." },
            { id: "learn-a-concept", label: "Learn a concept", seed: "Explain a concept.", outcome: "Learn with examples." },
          ],
        });
        if (target.pathname === "/api/models/catalog") return Response.json({ models: [
          { id: "gpt-6-luna", name: "GPT 6 Luna", provider: "openai", minimumPlan: "Guest", enabled: true, status: "enabled" },
        ] });
        if (target.pathname === "/api/chat/voice-transcription") {
          const headers = new Headers(options?.headers);
          if (options?.method !== "POST" || headers.get("origin") !== "tomverse://desktop" ||
              headers.get("authorization") !== "Bearer fixture-access" ||
              !headers.get("content-type")?.startsWith("audio/") ||
              !(options.body instanceof Uint8Array) || options.body.length < 2_048) {
            return Response.json({ code: "VOICE_TRANSCRIPTION_FAILED" }, { status: 400 });
          }
          host.clips = (host.clips ?? 0) + 1;
          return Response.json({ transcript: "fixture transcript" });
        }
        if (target.pathname === "/api/products/chat/conversations" && options?.method === "POST") return Response.json({ id: newChatId });
        if (target.pathname === `/api/conversations/${newChatId}/messages` && options?.method === "POST") {
          const { messages: [message] } = JSON.parse(String(options.body));
          question = message.content;
          return Response.json({ messageMappings: [{ requestId: message.clientRequestId, messageId: "saved-question" }] });
        }
        if (target.pathname === "/api/chat/context") return Response.json({ ok: true, contextBundle: null });
        if (target.pathname === "/api/chat" && options?.method === "POST") {
          host.sent = (host.sent ?? 0) + 1;
          assistantId = JSON.parse(String(options.body)).assistantMessageId;
          return new Response("Sent by the desktop test.", { headers: { "X-Chat-Routed-Model": "gpt-5-4-mini" } });
        }
        if (target.pathname === `/api/conversations/${newChatId}`) return Response.json({
          ...chat, id: newChatId, title: question, selectionMode: "manual", autoSelection: { offered: false },
          messages: [
            { id: "saved-question", role: "user", content: question, status: "normal" },
            ...(assistantId ? [{ id: assistantId, role: "assistant", status: "normal", modelId: "gpt-5-4-mini", content: "Sent by the desktop test." }] : []),
          ],
          messagePage: { nextCursor: null },
        });
        if (target.pathname === "/api/mcp/connections") return Response.json({ enabled: true,
          servers: [{ id: "github", name: "GitHub", custom: false }, { id: "custom-1", name: "Custom GitHub", custom: true }],
          connections: [{ id: "test-connection", serverId: "github", name: "GitHub", status: "connected", tools: 3, granted: 1 }],
        });
        if (target.pathname === "/api/conversations") return Response.json([{ ...chat, ...pinState, projectId, shareEnabled, isLocked }, {
          ...chat, id: "older-shared-chat", title: "An older shared chat", updatedAt: "2025-01-01T09:00:00Z",
          shareEnabled: true, selectedModels: ["gpt-5-4-mini"],
        }, {
          ...chat, id: "continued-test-chat", title: "Chat with a locked original", surface: "continuation", sourceState: "locked",
        }]);
        if (target.pathname === `/api/conversations/${chat.id}`) {
          const response = Response.json({ ...chat, messages: Array.from({ length: 48 }, (_, index) => ({
          id: `message-${index + 1}`, role: index % 2 === 0 ? "user" : "assistant", status: "normal",
          content: `Saved transcript message ${index + 1}.` + (index === 47 ? "\n\n```python\nfor i in range(3):\n    print(i)\n```"
            : index === 46 ? "\n\nfor i in range(5):\n    print(i)" : ""),
          modelId: index === 47 ? "gpt-6-luna" : undefined, artifacts: [],
        })),
          responseAttempts: [{ assistantMessageId: "message-48", actualModelId: "gpt-5-4-mini", provider: "openai" }],
            messagePage: { nextCursor: null }, selectionMode: "auto", selectedModels: [], autoSelection: { offered: true },
          });
          if (host.pauseTranscript) {
            host.pauseTranscript = false;
            await new Promise<void>(resolve => { host.finishTranscript = resolve; });
          }
          return response;
        }
        return Response.json({}, { status: 404 });
      };
    }, { origin: authOrigin, chat: conversation, exportPath });
    const page = await application.firstWindow();
    const rail = page.getByRole("navigation", { name: "Workspaces" });
    const settings = rail.getByRole("button", { name: "Settings", exact: true });
    await rail.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Sign in with your browser", exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.desktop.state()).account))
      .toMatchObject({ stage: "connected", label: "Settings Fixture" });
    await expect(rail.locator(".rail-footer button")).toHaveText(["Help", "Settings", "S"]);
    await rail.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.getByTestId("tomverse-wordmark")).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Search conversation history" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Imported chats", exact: true })).toBeVisible();
    await expect(page.locator("[data-starter-id]")).toHaveCount(6);
    await expect(page.getByRole("button", { name: "Current usage 13%" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open Chat", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Debug a stack trace" }).click();
    await expect(page.getByRole("textbox", { name: "Chat message", exact: true })).toHaveValue("Help me debug this stack trace.");
    assert.equal(await application.evaluate(() => (globalThis as typeof globalThis & { sent?: number }).sent ?? 0), 0);
    await page.getByRole("textbox", { name: "Chat message", exact: true }).fill("");
    const chatQa = process.env.TOMVERSE_DESKTOP_CHAT_QA;
    if (chatQa) await page.screenshot({ path: join(chatQa, "home.png"), animations: "disabled" });
    const chat = page.getByRole("button", { name: conversation.title, exact: true });
    const older = page.getByRole("button", { name: "An older shared chat", exact: true });
    await expect(page.getByRole("region", { name: "Today", exact: true }).getByRole("button", { name: conversation.title })).toBeVisible();
    await expect(page.getByRole("region", { name: "Older", exact: true }).getByRole("button", { name: "An older shared chat" })).toBeVisible();
    await page.getByRole("button", { name: /Organizer tools/ }).click();
    const shared = page.getByRole("group", { name: "Conversation states" }).getByRole("button", { name: "Share link active" });
    await shared.click();
    await expect(older).toBeVisible();
    await expect(chat).toHaveCount(0);
    const modelFilter = page.getByRole("group", { name: "Models", exact: true }).getByRole("button", { name: "GPT 6 Luna", exact: true });
    await modelFilter.click();
    await expect(chat).toBeVisible();
    await expect(older).toHaveCount(0);
    await modelFilter.click();
    await expect(older).toBeVisible();
    await page.getByRole("button", { name: /Organizer tools/ }).click();
    const continuationMenu = page.getByLabel("Conversation actions · Chat with a locked original", { exact: true });
    await continuationMenu.click();
    await expect(page.getByRole("button", { name: "Share", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Download with the original (.txt)", exact: true })).toBeDisabled();
    await continuationMenu.click();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Chat message", exact: true })).toBeFocused();
    await chat.click();
    const olderActions = page.getByLabel("Conversation actions · An older shared chat", { exact: true });
    await olderActions.click();
    await expect(page.getByRole("button", { name: "Pin chat", exact: true })).toBeVisible();
    await expect(chat).toHaveAttribute("aria-current", "page");
    await olderActions.click();
    const actions = page.getByLabel("Conversation actions", { exact: true });
    await actions.click();
    await page.getByRole("button", { name: "Download (.txt)", exact: true }).click();
    await expect.poll(() => readFile(exportPath, "utf8").catch(() => null)).toBe("Exported Desktop conversation.\n");
    const chatMenu = page.locator(".header .chat-action-menu");
    await chatMenu.getByRole("button", { name: "Share", exact: true }).click();
    await expect(chatMenu.getByText("Create a read-only share page?")).toBeVisible();
    await chatMenu.getByRole("button", { name: "Create share link", exact: true }).click();
    await expect(chatMenu.getByRole("textbox", { name: "Share", exact: true })).toHaveValue("https://example.invalid/share/fixture");
    await chatMenu.getByRole("button", { name: "Stop sharing", exact: true }).click();
    await chatMenu.getByRole("button", { name: "Stop sharing", exact: true }).click();
    await expect(chatMenu.getByRole("button", { name: "Share", exact: true })).toBeVisible();
    const lockLabel = "Enter a password to set the lock:";
    await chatMenu.getByRole("button", { name: "Lock Chat", exact: true }).click();
    await chatMenu.getByLabel(lockLabel).fill("FixturePass!");
    await chatMenu.getByRole("button", { name: "Lock Chat", exact: true }).click();
    await expect(page.locator(".long-thread")).toHaveCount(0);
    await chatMenu.getByRole("button", { name: "Unlock", exact: true }).click();
    const unlockInput = chatMenu.getByLabel(/This chat is locked/);
    await unlockInput.fill("WrongPass!");
    await chatMenu.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(chatMenu.getByRole("alert")).toBeVisible();
    await expect(page.locator(".long-thread")).toHaveCount(0);
    await unlockInput.fill("FixturePass!");
    await chatMenu.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(page.locator(".long-thread").getByRole("listitem")).toHaveCount(48);
    await page.getByRole("button", { name: "Pin chat", exact: true }).click();
    const pinWrites = () => application!.evaluate(() => (globalThis as typeof globalThis & { pinWrites: boolean[] }).pinWrites);
    await expect.poll(pinWrites).toEqual([true]);
    await expect(page.getByRole("region", { name: "Pinned", exact: true }).getByRole("button", { name: conversation.title })).toBeVisible();
    await page.getByRole("button", { name: "Unpin chat", exact: true }).click();
    await expect.poll(pinWrites).toEqual([true, false]);
    await expect(page.getByRole("region", { name: "Today", exact: true }).getByRole("button", { name: conversation.title })).toBeVisible();
    await actions.click();
    await page.getByRole("button", { name: /Organizer tools/ }).click();
    const projects = page.locator(".chat-history-projects");
    await projects.locator("summary").click();
    await projects.getByRole("button", { name: "Create first project", exact: true }).click();
    await projects.getByRole("textbox", { name: "Project name" }).fill("Fixture project");
    await projects.getByRole("button", { name: "Create first project", exact: true }).click();
    const project = projects.getByRole("button", { name: "Fixture project", exact: true });
    await expect(project).toBeVisible();
    await actions.click();
    const projectPicker = page.locator(".header").getByLabel("Move to project", { exact: true });
    await projectPicker.selectOption("test-project");
    await expect(projectPicker).toHaveValue("test-project");
    await actions.click();
    await project.click();
    await expect(older).toHaveCount(0);
    await expect(chat).toBeVisible();
    await projects.getByRole("button", { name: "Rename project · Fixture project", exact: true }).click();
    await projects.getByRole("textbox", { name: "Project name" }).fill("Renamed project");
    await projects.getByRole("button", { name: "Rename project", exact: true }).click();
    await expect(projects.getByRole("button", { name: "Renamed project", exact: true })).toBeVisible();
    await projects.getByRole("button", { name: "Delete project · Renamed project", exact: true }).click();
    await projects.getByRole("button", { name: "Confirm deletion of Renamed project" }).click();
    await expect(projects.getByRole("button", { name: "Renamed project", exact: true })).toHaveCount(0);
    await expect(chat).toBeVisible();
    await expect(older).toBeVisible();
    const transcript = page.locator(".long-thread");
    await expect(page.locator(".chat-auto-banner")).toContainText("Smart Adaptive");
    await expect(transcript.getByRole("listitem")).toHaveCount(48);
    await expect(transcript.getByRole("listitem").last()).toHaveCSS("content-visibility", "auto");
    await expect(transcript.getByText("Saved transcript message 48.", { exact: true })).toBeVisible();
    const lastAnswer = transcript.getByRole("listitem").last();
    await expect(lastAnswer.getByTestId("desktop-chat-answer-model")).toHaveText("GPT-5.4 mini");
    await expect(lastAnswer.locator(".hljs-keyword").first()).toHaveText("for");
    const lastQuestion = transcript.getByRole("listitem").nth(46);
    await expect(lastQuestion.locator(".hljs-keyword").first()).toHaveText("for");
    await lastQuestion.getByRole("button", { name: "Copy code", exact: true }).click();
    assert.equal(await application.evaluate(() => (globalThis as typeof globalThis & { copied?: string }).copied),
      "for i in range(5):\n    print(i)");
    await lastAnswer.getByRole("button", { name: "Copy code", exact: true }).click();
    assert.equal(await application.evaluate(() => (globalThis as typeof globalThis & { copied?: string }).copied),
      "for i in range(3):\n    print(i)");
    if (chatQa) await page.screenshot({ path: join(chatQa, "thread.png"), animations: "disabled" });
    const message = page.getByRole("textbox", { name: "Chat message", exact: true });
    await message.fill("A draft for the selected conversation");
    if (accountDevicesFixture) {
      const startDictation = page.getByRole("button", { name: "Record voice input", exact: true });
      await expect(startDictation).toBeVisible();
      await assert.rejects(page.evaluate(async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
      }), /NotAllowedError|Permission denied/);
      const longDraft = "x".repeat(24_005);
      await message.fill(longDraft);
      await startDictation.click();
      await expect(page.getByRole("status").filter({ hasText: /^Recording [1-9][0-9]*s$/ })).toBeVisible();
      await page.getByRole("button", { name: "Use recording as text", exact: true }).click();
      await expect(message).toHaveValue(longDraft + " fixture transcript");
      await startDictation.click();
      await expect(page.getByRole("button", { name: "Use recording as text", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(startDictation).toBeEnabled();
      assert.deepEqual(await application.evaluate(() => {
        const host = globalThis as typeof globalThis & { clips?: number; sent?: number };
        return [host.clips ?? 0, host.sent ?? 0];
      }), [1, 0]);
      await message.fill("A draft for the selected conversation");
      const location = page.getByRole("button", { name: "Use current location", exact: true });
      await page.locator(".composer-tools summary").click();
      await page.evaluate(`Object.defineProperty(navigator.geolocation, "getCurrentPosition", {
        configurable: true, value: (_success, failure) => failure({ code: 1 }),
      })`);
      await location.click();
      const locationDialog = page.getByRole("dialog", { name: "Use current location", exact: true });
      await locationDialog.getByRole("button", { name: "Attach current location" }).click();
      await expect(locationDialog.getByRole("alert")).toHaveText("Location permission was denied.");
      await locationDialog.getByRole("button", { name: "Enter a place manually" }).click();
      await locationDialog.getByRole("textbox", { name: "City or area" }).fill("Brisbane");
      await locationDialog.getByRole("button", { name: "Add place to draft" }).click();
      await expect(message).toHaveValue("A draft for the selected conversation\n\nMy location: Brisbane");
      await page.evaluate(`Object.defineProperty(navigator.geolocation, "getCurrentPosition", {
        configurable: true, value: (success) => success({
          coords: { latitude: -27.46551, longitude: 153.025879, accuracy: 23 }, timestamp: Date.now(),
        }),
      })`);
      await location.click();
      await locationDialog.getByRole("button", { name: "Attach current location" }).click();
      const removeLocation = page.getByRole("button", { name: "Remove location" });
      await expect(removeLocation).toBeVisible();
      await removeLocation.click();
      await expect(removeLocation).toHaveCount(0);
    } else {
      await expect(page.getByRole("button", { name: "Record voice input" })).toHaveCount(0);
      await page.locator(".composer-tools summary").click();
      await page.getByRole("button", { name: "Add a place", exact: true }).click();
      const placeDialog = page.getByRole("dialog", { name: "Add a place", exact: true });
      await expect(placeDialog.getByRole("button", { name: "Attach current location" })).toHaveCount(0);
      await placeDialog.getByRole("textbox", { name: "City or area" }).fill("Brisbane");
      await placeDialog.getByRole("button", { name: "Add place to draft" }).click();
      await expect(message).toHaveValue("A draft for the selected conversation\n\nMy location: Brisbane");
    }
    await message.fill("A draft for the selected conversation");
    await settings.click();
    await expect(page.getByTestId("native-account-login-methods")).toContainText("Google");
    await page.getByRole("button", { name: "Open email notifications" }).click();
    const email = page.getByTestId("native-account-email");
    await expect(email.getByText("Always on")).toBeVisible();
    const serviceNotices = email.getByRole("checkbox", { name: "Service status" });
    await expect(serviceNotices).toBeChecked();
    await serviceNotices.click();
    await expect(serviceNotices).not.toBeChecked();
    await page.getByTestId("desktop-settings-preferences").click();
    const preferencesPanel = page.getByTestId("native-account-preferences");
    await expect(preferencesPanel.getByLabel("Daily reset time zone")).toHaveValue("Australia/Brisbane");
    const theme = preferencesPanel.getByLabel("Theme", { exact: true });
    await theme.selectOption("light");
    await preferencesPanel.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(theme).toHaveValue("dark");
    await theme.selectOption("light");
    await preferencesPanel.getByRole("button", { name: "OK", exact: true }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await page.getByTestId("desktop-settings-plan").click();
    await expect(page.getByTestId("native-account-plan")).toContainText("63");
    await page.getByTestId("desktop-settings-ai").click();
    await expect(page.getByTestId("native-account-memory").getByLabel("Use memory across all chats")).toBeChecked();
    await page.getByRole("button", { name: "Manage memory", exact: true }).click();
    await page.getByRole("button", { name: "Edit · The user prefers short answers.", exact: true }).click();
    const memoryDetail = page.getByTestId("native-memory-detail");
    await expect(memoryDetail).toContainText("Manual preference fixture");
    await memoryDetail.getByRole("button", { name: "Pin", exact: true }).click();
    await expect(memoryDetail.getByRole("button", { name: "Unpin", exact: true })).toBeVisible();
    await memoryDetail.getByLabel("Memory statement").fill("The user prefers short summaries.");
    await memoryDetail.getByRole("button", { name: "Save", exact: true }).click();
    await expect(memoryDetail.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await memoryDetail.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByTestId("native-account-memories")).toContainText("The user prefers short summaries.");
    await page.getByTestId("desktop-settings-assistants").click();
    const assistants = page.getByTestId("native-account-assistants");
    await assistants.getByLabel("Name", { exact: true }).fill("Native QA assistant");
    await assistants.getByLabel("Custom instructions", { exact: true }).fill("Use concise answers.");
    await assistants.getByRole("button", { name: "Create assistant", exact: true }).click();
    await expect(assistants).toContainText("Native QA assistant");
    await assistants.getByRole("button", { name: "Edit AI assistant · Native QA assistant" }).click();
    const editor = page.getByTestId("native-assistant-editor");
    await expect(editor.getByLabel("Custom instructions")).toHaveValue("Use concise answers.");
    await editor.getByLabel("Name", { exact: true }).fill("Renamed fixture assistant");
    await editor.getByRole("button", { name: "Save name and description" }).click();
    await expect(editor.getByRole("status")).toHaveText("Saved.");
    await editor.getByLabel("Custom instructions").fill("Cite the most relevant source.");
    await editor.getByLabel("Reference.txt").check();
    await editor.getByRole("button", { name: "Save instructions and models" }).click();
    await expect(editor.getByText("Revision 2 · current", { exact: true })).toBeVisible();
    await expect(editor.getByText("Revision 1", { exact: true })).toBeVisible();
    await expect(editor.getByLabel("Custom instructions")).toHaveValue("Cite the most relevant source.");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(assistants).toContainText("Renamed fixture assistant");
    await page.getByTestId("desktop-settings-data").click();
    await page.getByRole("button", { name: "Manage imports", exact: true }).click();
    await expect(page.getByTestId("native-account-imports")).toContainText("Saved external conversation");
    await expect(page.getByRole("region", { name: "Import storage" })).toContainText("1 of 2,000 imported conversations");
    await expect(page.getByRole("region", { name: "Imported exports" })).toContainText("Completed");
    if (chatQa) await page.screenshot({ path: join(chatQa, "native-imports.png"), animations: "disabled" });
    await page.getByRole("button", { name: "View · Saved external conversation" }).click();
    const nativeSource = page.getByTestId("native-import-conversation");
    await expect(nativeSource).toContainText("<script>Private imported text</script>");
    await expect(nativeSource.locator("script")).toHaveCount(0);
    await nativeSource.getByRole("button", { name: "Back to imports", exact: true }).click();
    const priorCapacityReads = await application.evaluate(() =>
      (globalThis as typeof globalThis & { importRequests: string[] }).importRequests.length);
    await page.getByRole("button", { name: "Start a new import" }).click();
    const importDialog = page.getByRole("region", { name: "Import conversations from another AI service" });
    const rawExport = [
      { uuid: "claude-selected", name: "Selected conversation", chat_messages: [{ uuid: "m1", sender: "human", text: "Keep this private text" }] },
      { uuid: "claude-excluded", name: "Excluded conversation", chat_messages: [{ uuid: "m2", sender: "human", text: "Never upload this" }] },
    ];
    await importDialog.locator('input[type="file"]').setInputFiles({
      name: "conversations.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(rawExport)),
    });
    await expect(importDialog.getByRole("heading", { name: "Choose conversations to import" })).toBeVisible();
    const requestsBeforeSelection = await application.evaluate((_electron, from) =>
      (globalThis as typeof globalThis & { importRequests: string[] }).importRequests.slice(from), priorCapacityReads);
    assert.ok(requestsBeforeSelection.length > 0 && requestsBeforeSelection.every(path => path === "/api/imports/external/capacity"));
    await importDialog.getByRole("checkbox", { name: /Selected conversation/ }).check();
    await importDialog.getByRole("button", { name: "Review the selection" }).click();
    await expect(importDialog.getByRole("heading", { name: "Check what will be imported" })).toBeVisible();
    assert.deepEqual(await application.evaluate(() =>
      (globalThis as typeof globalThis & { importRequests: string[] }).importRequests.slice(-2)),
    ["/api/imports/external/fixture-import-id/batches", "/api/imports/external/fixture-import-id/seal"]);
    const finalize = importDialog.getByRole("button", { name: "Import 1 conversations" });
    await finalize.click();
    await expect(importDialog.getByRole("alert")).toBeVisible();
    await finalize.click();
    await expect(importDialog.getByRole("status")).toHaveText("Import completed: 1 conversations are now stored in your account.");
    await importDialog.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("native-account-imports")).toContainText("Saved external conversation");
    await page.getByTestId("desktop-settings-developer").click();
    const apiKeys = page.getByTestId("native-account-api-keys");
    await expect(apiKeys).toContainText("Fixture key");
    await apiKeys.getByRole("button", { name: "New key", exact: true }).click();
    await apiKeys.getByLabel("Name", { exact: true }).fill("Electron test");
    await apiKeys.getByRole("button", { name: "Create key", exact: true }).click();
    await expect(apiKeys.getByLabel("Copy your key now")).toHaveValue("synthetic-test-key");
    await apiKeys.getByRole("button", { name: "I've saved it", exact: true }).click();
    await expect(apiKeys.getByLabel("Copy your key now")).toHaveCount(0);
    assert.equal(await application.evaluate(({ BrowserWindow, WebContentsView }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.some(view => view instanceof WebContentsView)), false);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(chat).toHaveAttribute("aria-current", "page");
    await expect(message).toHaveValue("A draft for the selected conversation");
    await transcript.getByRole("button", { name: "Compare in Review", exact: true }).last().click();
    await expect(page.getByRole("textbox", { name: "Review question" })).toHaveValue(/Saved transcript message 47./);
    assert.equal(await application.evaluate(() => (globalThis as typeof globalThis & { sent?: number }).sent ?? 0), 0);
    await rail.getByRole("button", { name: "Plugins", exact: true }).click();
    const plugins = page.getByRole("region", { name: "Plugins", exact: true });
    const connected = plugins.getByRole("listitem").filter({ hasText: /1\/3/ });
    await expect(connected).toContainText("GitHub");
    await expect.poll(() => connected.locator("img").evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    const custom = plugins.getByRole("listitem").filter({ hasText: "Custom GitHub" });
    await expect(custom).toBeVisible();
    await expect(custom.locator("img")).toHaveCount(0);
    await plugins.getByRole("searchbox", { name: "Search plugins" }).fill("custom");
    await expect(connected).toHaveCount(0);
    await expect(custom).toBeVisible();
    await rail.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await message.fill("Send from the Desktop composer.");
    await page.getByRole("button", { name: "Send Chat message", exact: true }).click();
    await expect(page.getByText("Sent by the desktop test.", { exact: true })).toBeVisible();
    await expect(page.getByTestId("desktop-chat-answer-model")).toHaveText("GPT-5.4 mini");
    assert.equal(await application.evaluate(() => (globalThis as typeof globalThis & { sent?: number }).sent ?? 0), 1);
    await application.evaluate(() => { (globalThis as typeof globalThis & { pauseTranscript?: boolean }).pauseTranscript = true; });
    await chat.click();
    await expect.poll(() => application!.evaluate(() =>
      typeof (globalThis as typeof globalThis & { finishTranscript?: () => void }).finishTranscript)).toBe("function");
    await application.evaluate(() => (globalThis as typeof globalThis & { lockFromAnotherDevice?: () => void }).lockFromAnotherDevice?.());
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText("Choose Unlock in the conversation menu and enter its password.")).toBeVisible();
    await application.evaluate(() => (globalThis as typeof globalThis & { finishTranscript?: () => void }).finishTranscript?.());
    await actions.click();
    await expect(chatMenu.getByRole("button", { name: "Stop sharing", exact: true })).toBeDisabled();
    await expect(page.locator(".long-thread")).toHaveCount(0);
    await application.evaluate(() => { (globalThis as typeof globalThis & { readOnly?: boolean }).readOnly = true; });
    await page.evaluate(() => window.desktop.signOut());
    await page.evaluate(() => window.desktop.signIn());
    await expect.poll(() => page.evaluate(async () => (await window.desktop.state()).capabilities?.chatWrite)).toBe(false);
    await rail.getByRole("button", { name: "Chat", exact: true }).click();
    await message.fill("Draft in a read-only environment.");
    const send = page.getByRole("button", { name: "Send Chat message", exact: true });
    await expect(send).toBeDisabled();
    await message.press("Enter");
    await expect(message).toHaveValue("Draft in a read-only environment.");
    assert.equal(await application.evaluate(() => (globalThis as typeof globalThis & { sent?: number }).sent ?? 0), 1);
  } finally {
    await application?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("Desktop keeps the compact history drawer reachable at 200 percent zoom", { timeout: 90_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), "tomverse-compact-history-"));
  let application: ElectronApplication | undefined;
  try {
    await writeFile(join(profile, "language.txt"), "en");
    application = await electron.launch({ executablePath, args: [desktopDir, `--user-data-dir=${profile}`], timeout: 20_000 });
    const page = await application.firstWindow();
    await expect(page.getByRole("heading", { name: "What shall we build?" })).toBeVisible({ timeout: 20_000 });
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setSize(690, 560);
      window.webContents.setZoomFactor(2);
    });
    const history = page.getByRole("complementary", { name: "History", exact: true });
    const toggle = page.getByRole("button", { name: /^(Show|Hide) history$/ });
    const captures = process.env.TOMVERSE_DESKTOP_COMPACT_HISTORY_QA;
    async function capture(name: string) {
      if (!captures || !application) return;
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
      const png = await application.evaluate(async ({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0]!.webContents;
        return (await contents.capturePage()).toPNG().toString("base64");
      });
      await writeFile(join(captures, name), Buffer.from(png, "base64"));
    }
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.press("Enter");
    const heading = history.getByRole("heading", { name: "Tomverse Code" });
    await expect(heading).toBeFocused();
    await expectWindowsAccessibleNames(application, page, {
      "Hide history": "ControlType.Button", "Search history": "ControlType.Button", "Open local folder": "ControlType.Button",
    });
    await capture("history-zoom-dark.png");
    await page.keyboard.press("Tab");
    const search = history.getByRole("button", { name: "Search history" });
    await expect(search).toBeFocused();
    await page.keyboard.press("Enter");
    const field = history.getByRole("textbox", { name: "Filter task history" });
    await expect(field).toBeFocused();
    await field.dispatchEvent("keydown", { key: "Escape", isComposing: true, bubbles: true });
    await expect(field).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(search).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(toggle).toBeFocused();
    await expect(history).toHaveCount(0);

    await page.getByRole("button", { name: "Use light theme" }).click();
    await toggle.click();
    await expect(heading).toBeFocused();
    await capture("history-zoom-light.png");
    await toggle.click();
    await expect(history).toHaveCount(0);
    await toggle.press("Enter");
    await expect(heading).toBeFocused();
    await history.getByRole("button", { name: "Open local folder" }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Use dark theme" })).toBeFocused();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("button", { name: "Send Code request" })).toBeInViewport({ ratio: 1 });
    assert.ok(await page.getByRole("navigation", { name: "Workspaces" })
      .evaluate((rail) => rail.scrollWidth <= rail.clientWidth + 1), "The workspace rail fits beside the composer");
  } finally {
    if (application) await application.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("Desktop isolates its shell and restores its preferences after a renderer crash and restart", { timeout: 60_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), "tomverse-shell-"));
  const launch = () => electron.launch({ executablePath, args: [desktopDir, `--user-data-dir=${profile}`], timeout: 20_000 });
  let application: ElectronApplication | undefined;
  try {
    application = await launch();
    let page = await application.firstWindow();
    await expect(page.getByRole("heading", { name: "What shall we build?" })).toBeVisible();
    assert.equal(await page.title(), "Tomverse Desktop");
    assert.equal((await page.evaluate(() => window.desktop.state())).localFixture, false);
    if (process.platform === "win32") {
      const windowHandle = await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getNativeWindowHandle().reverse().toString("hex"));
      const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive",
        "-File", join(desktopDir, "scripts", "read-windows-taskbar.ps1"), "-WindowHandle", windowHandle],
      { timeout: 12_000 });
      const taskbar = JSON.parse(stdout);
      const icon = join(desktopDir, "dist", "host", "tomverse-icon.ico");
      assert.equal(taskbar.appId, "app.tomverse.desktop.dev");
      assert.equal(taskbar.icon.replace(/,0$/, ""), icon);
      assert.equal(taskbar.name, "Tomverse Desktop");
      assert.equal(taskbar.command, `"${executablePath}" "${desktopDir}"`);
      assert.deepEqual(await readFile(icon), await readFile(join(desktopDir, "..", "..", "app", "favicon.ico")));
    }
    await page.getByRole("button", { name: "Desktop settings" }).click();
    await page.getByTestId("desktop-settings-preferences").click();
    await expect(page.getByRole("button", { name: "Check for updates" })).toBeDisabled();

    await application.evaluate(({ shell, dialog }) => {
      const state = globalThis as typeof globalThis & { desktopDestinations: string[]; desktopLoadFailure: string };
      state.desktopDestinations = [];
      shell.openExternal = async (url) => { state.desktopDestinations.push(url); };
      dialog.showMessageBox = async (windowOrOptions: Electron.BaseWindow | Electron.MessageBoxOptions, options?: Electron.MessageBoxOptions) => {
        state.desktopLoadFailure = options?.message ?? ("message" in windowOrOptions ? windowOrOptions.message : "");
        return { response: 0, checkboxChecked: false };
      };
    });
    assert.deepEqual(await page.evaluate(() => [typeof window.require, typeof window.approvalHost]), ["undefined", "undefined"]);
    await assert.rejects(page.evaluate(() => window.desktop.openWeb("https://example.invalid" as "review")));
    assert.equal(await page.evaluate(() => typeof window.open("https://example.invalid")?.document), "undefined");

    const frame = "desktop-frame-probe";
    await page.evaluate((id) => {
      const iframe = document.createElement("iframe");
      iframe.id = id;
      iframe.src = "/approval";
      document.body.appendChild(iframe);
    }, frame);
    await expect.poll(() => page.frames().map((item) => item.url())).toContain("chrome-error://chromewebdata/");
    await page.locator(`#${frame}`).evaluate((element) => element.remove());
    const foreignWindow = application.waitForEvent("window");
    await application.evaluate(async ({ BrowserWindow }, { url, preload }) => {
      const foreign = new BrowserWindow({
        show: false,
        webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      await foreign.loadURL(url);
    }, { url: shellUrl, preload: join(desktopDir, "dist", "host", "preload.cjs") });
    const foreign = await foreignWindow;
    await assert.rejects(foreign.evaluate(() => window.desktop.state()), /Untrusted desktop request/);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => !window.isVisible())?.destroy());

    const tools = page.getByRole("navigation", { name: "Workspaces" });
    await tools.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open Chat", exact: true })).toHaveCount(0);
    await tools.getByRole("button", { name: "Review", exact: true }).click();
    await page.getByRole("button", { name: "Open Review", exact: true }).click();
    await tools.getByRole("button", { name: "Plugins", exact: true }).click();
    await page.getByRole("button", { name: "Open Plugins", exact: true }).click();
    await page.getByRole("button", { name: "Desktop settings" }).click();
    await page.getByTestId("desktop-settings-ai").click();
    await expect(page.getByRole("heading", { name: "Memory and privacy" })).toBeVisible();
    await expect(page.getByText("Selected context only", { exact: true })).toBeVisible();
    const privacyArtifacts = process.env.TOMVERSE_DESKTOP_PRIVACY_QA;
    if (privacyArtifacts) await page.screenshot({ path: join(privacyArtifacts, "memory-privacy-dark.png"), animations: "disabled" });
    await page.getByRole("button", { name: "Use light theme" }).click();
    if (privacyArtifacts) await page.screenshot({ path: join(privacyArtifacts, "memory-privacy-light.png"), animations: "disabled" });
    await page.getByRole("button", { name: "Use dark theme" }).click();
    await page.getByRole("button", { name: "Manage history", exact: true }).click();
    await expect(page.getByRole("heading", { name: "What shall we build?" })).toBeVisible();
    assert.deepEqual(await application.evaluate(() =>
      (globalThis as typeof globalThis & { desktopDestinations: string[] }).desktopDestinations), [
      "https://tomverse.app/review", "https://tomverse.app/plugins",
    ]);
    assert.equal(await tools.getByRole("button", { name: "Image", exact: true }).count(), 0);
    await application.evaluate(({ BrowserWindow }) => {
      const state = globalThis as typeof globalThis & { desktopBlockedNavigation?: boolean };
      BrowserWindow.getAllWindows()[0]!.webContents.once("will-frame-navigate", (event) => {
        state.desktopBlockedNavigation = event.defaultPrevented;
      });
    });
    await page.evaluate(() => { location.href = "https://example.invalid"; });
    await expect.poll(() => application!.evaluate(() =>
      (globalThis as typeof globalThis & { desktopBlockedNavigation?: boolean }).desktopBlockedNavigation)).toBe(true);
    assert.equal(await page.evaluate(() => location.href), shellUrl);
    [page] = await Promise.all([
      application.waitForEvent("window", { timeout: 10_000 }),
      application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer()),
    ]);
    assert.equal(await application.evaluate(() =>
      (globalThis as typeof globalThis & { desktopLoadFailure: string }).desktopLoadFailure), "The Desktop workspace could not open.");
    await expect(page.getByRole("heading", { name: "What shall we build?" })).toBeVisible();
    await page.getByRole("button", { name: "Use light theme" }).click();
    const previousBounds = await application.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const area = screen.getPrimaryDisplay().workArea;
      window.setBounds({ x: area.x, y: area.y, width: Math.min(850, area.width), height: Math.min(620, area.height) });
      return window.getNormalBounds();
    });
    await application.close();
    application = undefined;
    const boundsPath = join(profile, "window-bounds.json");
    assert.deepEqual(JSON.parse(await readFile(boundsPath, "utf8")), previousBounds);
    await writeFile(boundsPath, JSON.stringify({ ...previousBounds, x: 100_000, y: 100_000 }));
    application = await launch();
    page = await application.firstWindow();
    await expect(page.getByRole("heading", { name: "What shall we build?" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Use dark theme" })).toBeVisible();
    await expect.poll(() => application!.evaluate(({ BrowserWindow, screen }) => {
      const bounds = BrowserWindow.getAllWindows()[0]!.getNormalBounds();
      return screen.getAllDisplays().some(({ workArea }) => bounds.x >= workArea.x && bounds.y >= workArea.y &&
        bounds.x + bounds.width <= workArea.x + workArea.width && bounds.y + bounds.height <= workArea.y + workArea.height);
    })).toBe(true);
    await page.emulateMedia({ forcedColors: "active" });
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--focus").trim()), "Highlight");
    await page.emulateMedia({ forcedColors: "none" });
    await application.evaluate(({ BrowserWindow, Menu }) => {
      const zoomRoles = Menu.getApplicationMenu()?.items.flatMap((entry) => entry.submenu?.items.map((item) => item.role?.toLowerCase()) ?? []);
      if (!zoomRoles?.includes("zoomin") || !zoomRoles.includes("zoomout") || !zoomRoles.includes("resetzoom")) {
        throw new Error("The native scale controls are unavailable.");
      }
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setSize(690, 560);
      window.webContents.setZoomFactor(2);
    });
    await expect(page.getByRole("complementary", { name: "History", exact: true })).toHaveCount(0);
    const historyToggle = page.getByRole("button", { name: "Show history", exact: true });
    await expect(historyToggle).toHaveAttribute("aria-expanded", "false");
    await historyToggle.focus();
    await page.keyboard.press("Enter");
    const openHistory = page.getByRole("complementary", { name: "History", exact: true });
    await expect(openHistory).toBeVisible();
    await openHistory.getByRole("button", { name: "Open local folder" }).focus();
    await page.keyboard.press("Escape");
    await expect(historyToggle).toBeFocused();
    const composer = page.getByRole("form", { name: "Code composer" });
    await expect(composer.getByRole("textbox", { name: "Code request" })).toBeVisible();
    await expect(composer.getByRole("button", { name: "Send Code request" })).toBeInViewport({ ratio: 1 });
    assert.ok(await page.evaluate(() => {
      const work = document.querySelector("main.work")!;
      return work.scrollWidth <= work.clientWidth + 1;
    }));
  } finally {
    if (application) await application.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("Desktop loads all supported workspace languages and restores the selection after restart", { timeout: 60_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), "tomverse-shell-language-"));
  const launch = () => electron.launch({ executablePath, args: [desktopDir, `--user-data-dir=${profile}`], timeout: 20_000 });
  let application: ElectronApplication | undefined;
  try {
    application = await launch();
    let page = await application.firstWindow();
    const options = [
      { id: "en", settings: "Settings", language: "Language", heading: "What shall we build?", request: "Code request" },
      { id: "de", settings: "Einstellungen", language: "Sprache", heading: "Was wollen wir erstellen?", request: "Code-Anfrage" },
      { id: "es", settings: "Ajustes", language: "Idioma", heading: "¿Qué vamos a crear?", request: "Solicitud de Code" },
      { id: "fr", settings: "Paramètres", language: "Langue", heading: "Que souhaitons-nous créer ?", request: "Demande Code" },
      { id: "pt", settings: "Definições", language: "Idioma", heading: "O que vamos criar?", request: "Pedido de Code" },
      { id: "zh", settings: "设置", language: "语言", heading: "我们要构建什么？", request: "Code 请求", font: "Noto Sans SC" },
      { id: "ko", settings: "설정", language: "언어", heading: "무엇을 만들어 볼까요?", request: "Code 요청", font: "Noto Sans KR" },
      { id: "zh-Hant", settings: "設定", language: "語言", heading: "我們要打造什麼？", request: "Code 請求", font: "Noto Sans TC" },
    ] as const;
    await expect(page.getByRole("textbox", { name: "Code request", exact: true })).toBeVisible();
    await page.evaluate(() => localStorage.setItem("tomverse.language", "ko"));
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Code 요청", exact: true })).toBeVisible();
    await expect.poll(() => readFile(join(profile, "language.txt"), "utf8").catch(() => "")).toBe("ko");
    await assert.rejects(page.evaluate(() => window.desktop.setLanguage("ja" as "en")));
    assert.equal(await page.evaluate(async () => (await window.desktop.state()).language), "ko");
    let current: typeof options[number] = options[6];
    for (const next of options) {
      await page.getByRole("button", { name: current.settings, exact: true }).click();
      await page.getByTestId("desktop-settings-preferences").click();
      const languages = page.getByRole("combobox", { name: current.language, exact: true });
      await expect(languages.getByRole("option")).toHaveCount(8);
      await languages.selectOption(next.id);
      await page.getByRole("button", { name: "Code", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("lang", next.id);
      await expect(page.getByRole("heading", { name: next.heading, exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: next.request, exact: true })).toBeVisible();
      if ("font" in next) await expect(page.locator("body")).toHaveCSS("font-family", new RegExp(next.font));
      current = next;
    }
    await application.close();
    application = undefined;
    application = await launch();
    page = await application.firstWindow();
    assert.equal(await readFile(join(profile, "language.txt"), "utf8"), current.id);
    assert.equal(await page.evaluate(async () => (await window.desktop.state()).language), current.id);
    await expect(page.locator("html")).toHaveAttribute("lang", current.id);
    await expect(page.getByRole("heading", { name: current.heading, exact: true })).toBeVisible();
  } finally {
    if (application) await application.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
