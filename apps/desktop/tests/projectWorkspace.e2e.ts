import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication } from "@playwright/test";

const require = createRequire(import.meta.url);
const executablePath: string = process.env.TOMVERSE_DESKTOP_TEST_ELECTRON ?? require("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));
const authOrigin = process.env.DESKTOP_E2E_AUTH_ORIGIN;

test("the project workspace runs inside Desktop: overview, chats, materials, memories, search, settings and delete", { timeout: 120_000, skip: !authOrigin }, async () => {
  assert.ok(authOrigin);
  const profile = await mkdtemp(join(tmpdir(), "tomverse-project-"));
  let application: ElectronApplication | undefined;
  try {
    await writeFile(join(profile, "language.txt"), "en");
    const upload = join(profile, "brief.md");
    await writeFile(upload, "# Launch brief\nShip on Friday.\n");
    application = await electron.launch({ executablePath, args: [desktopDir, `--user-data-dir=${profile}`], timeout: 20_000 });
    await application.evaluate(async ({ shell, dialog }, { origin, upload }) => {
      const host = globalThis as typeof globalThis & { calls: Array<{ method: string; path: string; body?: unknown }>; opened: string[]; puts: number; saved: number };
      host.calls = [];
      host.opened = [];
      host.puts = 0;
      host.saved = 0;
      const realFetch = globalThis.fetch;
      const now = new Date().toISOString();
      const project = { id: "launch", name: "Launch", description: "Launch plan", instructions: "Be brief.", contextEnabled: true, memoryScope: "project_only",
        autoMemoryEnabled: false, revision: 1, archivedAt: null as string | null, conversationCount: 1, materialCount: 0, memoryCount: 0, readyMaterialCount: 0,
        failedMaterialCount: 0, updatedAt: now, createdAt: now };
      const files: Array<Record<string, unknown>> = [];
      const memories: Array<Record<string, unknown>> = [];
      const chat = { id: "chat-in-project", title: "Kickoff notes", kind: "chat", surface: "chat", productKey: "chat", updatedAt: now,
        selectedModels: ["gpt-6-luna"], projectId: "launch" };
      let removed = false;
      let question = "";
      const signedStorage = "https://fixture.r2.cloudflarestorage.com/upload?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc";
      shell.openExternal = async (href) => {
        const target = new URL(href);
        if (target.origin === origin && target.pathname === "/auth/desktop") {
          const callback = new URL(target.searchParams.get("redirect_uri")!);
          callback.search = new URLSearchParams({ state: target.searchParams.get("state")!, grant: "a".repeat(43) }).toString();
          if (!(await realFetch(callback)).ok) throw new Error("Unable to connect the test account.");
          return;
        }
        host.opened.push(href);
      };
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [upload] })) as typeof dialog.showOpenDialog;
      dialog.showSaveDialog = (async () => { host.saved++; return { canceled: true, filePath: "" }; }) as typeof dialog.showSaveDialog;
      globalThis.fetch = async (url, options) => {
        const target = new URL(String(url));
        const method = options?.method ?? "GET";
        const body = options?.body && typeof options.body === "string" ? JSON.parse(options.body) : undefined;
        if (target.href === signedStorage) {
          if (method === "PUT") host.puts++;
          return new Response(method === "PUT" ? null : "# Launch brief", { status: 200 });
        }
        if (target.origin !== origin) throw new Error("Unexpected Desktop request " + target.href);
        host.calls.push({ method, path: target.pathname + target.search, body });
        const headers = new Headers(options?.headers);
        if (target.pathname === "/api/auth/desktop/exchange") return Response.json({ ok: true, accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 600 });
        if (target.pathname === "/api/auth/desktop/session") return Response.json({ ok: true, account: { id: "fixture-account", name: "Project Fixture", email: null } });
        if (target.pathname === "/api/auth/desktop/logout") return Response.json({ ok: true });
        if (target.pathname === "/api/auth/desktop/settings-session") return Response.json({ token: "fixture..settings.web.session", expiresAt: Date.now() + 300_000 });
        if (target.pathname === "/api/products/chat/capabilities") return Response.json({
          autoSelection: { offered: false }, desktopWrite: true, desktopImport: true, desktopPlugins: true, desktopReview: { easy: true, plan: "Pro", modelLimit: 3 } });
        if (target.pathname === "/api/models/catalog") return Response.json({ models: [
          { id: "gpt-6-luna", name: "GPT 6 Luna", provider: "openai", minimumPlan: "Guest", enabled: true, status: "enabled" }] });
        if (target.pathname === "/api/products/chat/conversations" && method === "POST") return Response.json({ id: "new-project-chat" });
        if (target.pathname === "/api/conversations/new-project-chat/messages") {
          question = body.messages[0].content;
          return Response.json({ messageMappings: [{ requestId: body.messages[0].clientRequestId, messageId: "saved-question" }] });
        }
        if (target.pathname === "/api/chat/context") return Response.json({ ok: true, contextBundle: null });
        if (target.pathname === "/api/chat" && method === "POST") return new Response("Answered inside the project.", { headers: { "X-Chat-Routed-Model": "gpt-6-luna" } });
        if (target.pathname === "/api/conversations/new-project-chat") return Response.json({ ...chat, id: "new-project-chat", title: question, selectionMode: "manual",
          autoSelection: { offered: false }, messages: [{ id: "saved-question", role: "user", content: question, status: "normal" }],
          messagePage: { nextCursor: null } });
        if (target.pathname === `/api/conversations/${chat.id}`) return Response.json({ ...chat, selectionMode: "manual", autoSelection: { offered: false },
          messages: [{ id: "m1", role: "user", content: "Kickoff question", status: "normal" }, { id: "m2", role: "assistant", content: "Kickoff answer", status: "normal", modelId: "gpt-6-luna" }],
          messagePage: { nextCursor: null } });
        if (target.pathname === "/api/conversations") return Response.json([chat]);
        if (target.pathname === "/api/user/usage") return Response.json({ plan: "Pro", usage: { creditsMonth: 1 }, limits: { creditsMonth: 100 },
          balances: { dailyRemainingCredits: 3, planRemainingCredits: 63, purchasedRemainingCredits: 0 } });
        if (target.pathname.startsWith("/api/projects") || target.pathname.startsWith("/api/memories/")) {
          if (headers.get("cookie") !== "next-auth.session-token=fixture..settings.web.session" || headers.has("authorization")) throw new Error("Invalid workspace credential transport");
          const path = target.pathname;
          if (path === "/api/projects") return Response.json({ projects: removed ? [] : [project] });
          if (path === "/api/projects/launch" && target.searchParams.get("view") === "deletion") {
            return Response.json({ deletion: { conversations: 1, materials: files.length, memories: memories.length, revision: project.revision } });
          }
          if (path === "/api/projects/launch") {
            if (method === "PATCH") {
              if (body.name) project.name = body.name;
              if (body.expectedRevision !== undefined) project.revision = body.expectedRevision + 1;
              return Response.json(project);
            }
            if (method === "DELETE") {
              if (files.length + memories.length > 0 && body?.confirmation?.materials !== files.length) return Response.json({ code: "PROJECT_DELETE_CONFIRMATION_REQUIRED" }, { status: 409 });
              removed = true;
              return Response.json({ success: true, detachedConversations: 1, deletedMaterials: files.length, deletedMemories: memories.length });
            }
            return Response.json(project);
          }
          if (path === "/api/projects/launch/conversations") return Response.json({ conversations: [
            { id: chat.id, title: chat.title, productKey: "chat", kind: "chat", locked: false, continuation: null, messageCount: 2, updatedAt: now }] });
          if (path === "/api/projects/launch/materials/file-1") return Response.json({ url: signedStorage, name: "brief.md", mime: "text/markdown" });
          if (path === "/api/projects/launch/materials") {
            if (method === "POST") {
              if (body.action === "prepare") return Response.json({ uploadKey: "key-1", uploadUrl: signedStorage, uploadHeaders: { "Content-Type": body.mime } });
              if (body.action === "finalize") {
                files.push({ id: "file-1", name: body.filename, mime: body.mime, bytes: 31, processingStatus: "ready", failureCode: null, chunkCount: 1, createdAt: now, processedAt: now, sourceKind: "upload", sourceRef: null });
                project.materialCount = files.length;
                return Response.json({ file: { id: "file-1", name: body.filename, processingStatus: "pending" } }, { status: 201 });
              }
              files.push({ id: "note-1", name: body.title, mime: "text/plain", bytes: body.text.length, processingStatus: "ready", failureCode: null, chunkCount: 1, createdAt: now, processedAt: now, sourceKind: "note", sourceRef: null });
              project.materialCount = files.length;
              return Response.json({ created: true, file: files.at(-1) }, { status: 201 });
            }
            return Response.json({ files, capacity: { limits: { maxFileBytes: 33_554_432, maxFilesPerProfile: 20, maxFilesPerAccount: 100 },
              remaining: { filesInProfile: 19 - files.length }, acceptedMediaTypes: ["text/markdown"] } });
          }
          if (path === "/api/projects/launch/memories") {
            if (method === "POST") {
              memories.push({ id: "memory-1", kind: body.kind, statement: body.statement, status: "active", pinned: false, revision: 1, userEdited: false, projectId: "launch",
                suspendedReason: null, expiresAt: null, evidence: [{ id: "e1", sourceType: "manual", manualContent: body.groundsText, sourceTitle: null }] });
              project.memoryCount = memories.length;
              return Response.json({ memoryId: "memory-1" }, { status: 201 });
            }
            return Response.json({ memories, total: memories.length });
          }
          if (path === "/api/projects/launch/search") return Response.json({ status: "partial", incomplete: ["materials"], hits: [
            { ref: "msg:chat-in-project:m2", location: { kind: "message", conversationId: chat.id, messageId: "m2" }, title: "Kickoff notes", role: "assistant", snippet: "Friday launch" }] });
          if (path === "/api/projects/launch/sources") return Response.json({ status: "ok", location: { kind: "message" }, title: "Kickoff notes", role: "assistant", content: "Friday launch details", createdAt: now });
        }
        return Response.json({ code: "NOT_FOUND" }, { status: 404 });
      };
    }, { origin: authOrigin, upload });
    const page = await application.firstWindow();
    const rail = page.getByRole("navigation", { name: "Workspaces" });
    await rail.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Sign in with your browser", exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.desktop.state()).account)).toMatchObject({ stage: "connected" });
    await rail.getByRole("button", { name: "Chat", exact: true }).click();

    // The sidebar opens the workspace of a project.
    await page.getByRole("button", { name: /Organizer tools/ }).click();
    await page.locator("summary", { hasText: "Projects" }).click();
    await page.getByTestId("project-open-workspace").click();
    const workspace = page.getByTestId("project-workspace");
    await expect(workspace.getByTestId("project-workspace-title")).toHaveText("Launch");
    await expect(workspace.getByTestId("project-workspace-status")).toHaveText("Context on");
    await expect(workspace.getByTestId("project-overview-description")).toHaveText("Launch plan");
    await expect(page.getByTestId("project-stat-conversations")).toContainText("1");
    const qa = process.env.TOMVERSE_DESKTOP_PROJECT_QA;
    if (qa) await page.screenshot({ path: join(qa, "project-overview.png"), animations: "disabled" });

    // Chats: list, open one in Desktop Chat, and start a new chat inside the project.
    await page.getByTestId("project-tab-conversations").click();
    await expect(page.getByTestId("project-conversation-row")).toHaveCount(1);
    await page.getByTestId("project-conversation-open").click();
    await expect(page.getByTestId("project-workspace")).toHaveCount(0);
    await expect(page.getByText("Kickoff answer")).toBeVisible();
    await expect(page.getByTestId("project-composer-bar")).toContainText("Launch");
    await page.getByTestId("project-composer-open").click();
    await page.getByTestId("project-tab-conversations").click();
    await page.getByTestId("project-conversations-new").click();
    await expect(page.getByTestId("project-composer-bar")).toContainText("Context on");
    await page.getByRole("textbox", { name: "Chat message", exact: true }).fill("Plan the launch week");
    await page.getByRole("button", { name: "Send Chat message", exact: true }).click();
    await expect(page.getByText("Plan the launch week").first()).toBeVisible();
    const calls = await application.evaluate(() => (globalThis as typeof globalThis & { calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> }).calls);
    const create = calls.find((call) => call.path === "/api/products/chat/conversations" && call.method === "POST");
    assert.deepEqual(create?.body, { selectedModels: ["gpt-6-luna"], projectId: "launch" });

    // Materials: upload from the native picker, then a note.
    await page.getByTestId("project-composer-open").click();
    await page.getByTestId("project-tab-materials").click();
    await expect(page.getByTestId("project-materials-capacity")).toContainText("32 MB");
    await page.getByTestId("project-material-upload").click();
    await expect(page.getByTestId("project-material-row")).toHaveCount(1);
    await expect(page.getByTestId("project-material-row").first()).toContainText("brief.md");
    await page.locator("#project-note-title").fill("Decision");
    await page.locator("#project-note-text").fill("Launch on Friday.");
    await page.getByTestId("project-note-save").click();
    await expect(page.getByTestId("project-material-row")).toHaveCount(2);
    await page.getByTestId("project-material-download").first().click();
    if (qa) await page.screenshot({ path: join(qa, "project-materials.png"), animations: "disabled" });

    // Memories and search.
    await page.getByTestId("project-tab-memories").click();
    await page.locator("#project-memory-statement").fill("Launch is on Friday.");
    await page.locator("#project-memory-grounds").fill("Said in the kickoff.");
    await page.getByTestId("project-memory-create").click();
    await expect(page.getByTestId("project-memory-row")).toHaveCount(1);
    await page.getByTestId("project-workspace-search-toggle").click();
    await page.getByTestId("project-search-input").fill("friday");
    await page.getByTestId("project-search-submit").click();
    await expect(page.getByTestId("project-search-partial")).toBeVisible();
    await page.getByTestId("project-search-preview").click();
    await expect(page.getByTestId("project-source-preview")).toHaveText("Friday launch details");

    // Settings: a rename alone is a rename request; delete asks with the counts the person saw.
    await page.getByTestId("project-tab-settings").click();
    await page.locator("#project-settings-name").fill("Launch 2");
    await page.getByTestId("project-settings-save").click();
    await expect(page.getByTestId("project-workspace-title")).toHaveText("Launch 2");
    await page.getByTestId("project-delete-open").click();
    const dialog = page.getByTestId("project-delete-dialog");
    await expect(dialog).toContainText("Materials (2) will be deleted.");
    await dialog.getByRole("button", { name: "Delete project", exact: true }).click();
    await expect(page.getByTestId("project-workspace")).toHaveCount(0);

    const result = await application.evaluate(() => {
      const host = globalThis as typeof globalThis & { calls: Array<{ method: string; path: string; body?: unknown }>; opened: string[]; puts: number; saved: number };
      return { calls: host.calls.map(({ method, path, body }) => ({ method, path, body })), opened: host.opened, puts: host.puts, saved: host.saved };
    });
    assert.deepEqual(result.opened, []);
    assert.equal(result.puts, 1);
    assert.equal(result.saved, 1);
    const renamed = result.calls.find((call) => call.method === "PATCH" && call.path === "/api/projects/launch");
    assert.deepEqual(renamed?.body, { name: "Launch 2" });
    const removal = result.calls.find((call) => call.method === "DELETE" && call.path === "/api/projects/launch");
    assert.deepEqual(removal?.body, { confirmation: { revision: 1, materials: 2, memories: 1 } });
  } finally {
    await application?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  }
});
