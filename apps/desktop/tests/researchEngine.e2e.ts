import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("Desktop starts, steers and reads Deep Research and Research Preview inside the app", { timeout: 150_000, skip: !authOrigin }, async () => {
  assert.ok(authOrigin);
  const profile = await mkdtemp(join(tmpdir(), "tomverse-research-"));
  let application: ElectronApplication | undefined;
  try {
    await writeFile(join(profile, "language.txt"), "en");
    const exportPath = join(profile, "research.md");
    application = await electron.launch({ executablePath, args: [desktopDir, `--user-data-dir=${profile}`], timeout: 20_000 });
    await application.evaluate(async ({ shell, dialog }, { origin, exportPath }) => {
      type Call = { method: string; path: string; body?: Record<string, unknown> };
      const host = globalThis as typeof globalThis & { calls: Call[]; opened: string[] };
      host.calls = [];
      host.opened = [];
      const realFetch = globalThis.fetch;
      const now = new Date().toISOString();
      const fns = {} as Record<"terminal" | "view" | "chatBody" | "previewDto", (...args: any[]) => any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      const state = { status: "awaiting_input", approved: false, reads: 0, ids: { user: "", assistant: "" } };
      const chats: Record<string, { question: string; assistantId: string }> = {};
      let preview = { status: "queued", id: "prev-1", assistantMessageId: "" };
      fns.terminal = () => ["completed", "failed", "cancelled", "attention"].includes(state.status);
      fns.view = () => ({
        id: "run-1", engineVersion: 2, conversationId: "research-chat", assistantMessageId: state.ids.assistant, status: state.status, eventSequence: 1 + state.reads,
        inputRevision: 1, planRevision: 1, approvedPlanRevision: state.approved ? 1 : null, qualityStatus: state.status === "completed" ? "complete" : null,
        currentReportRevision: state.status === "completed" ? 1 : 0, pauseRequested: false, cancelRequested: false,
        plan: { revision: 1, author: "model", plan: { objective: "Compare the options", assumptions: ["Public sources only"], clarifications: [],
          subquestions: [{ key: "q1", question: "What changed in 2026?", rationale: "r", queries: ["q"], searchLanguages: ["en"], sourceStrategy: "s" }],
          completionCriteria: ["Two sources agree"], outline: [{ key: "s1", heading: "Findings", purpose: "p", subquestionKeys: ["q1"], table: false }] } },
        progress: { items: { queued: 0, running: state.status === "running" ? 1 : 0, completed: state.status === "completed" ? 3 : 1, failed: 0, attention: 0, blocked: 0, cancelled: 0 },
          questions: [{ key: "q1", question: "What changed in 2026?", state: state.status === "completed" ? "done" : "active", findings: 2 }],
          sourcesSeen: 2, sourcesRead: 1, privateSources: 0, openQuestions: [] },
        money: { approvedCredits: 400, settledCredits: state.status === "completed" ? 120 : 10, reservedCredits: 0, unknownCredits: 0, finalizationReserveCredits: 80, settlement: "settled" },
        actions: { canPause: state.status === "running", canResume: state.status === "paused", canCancel: !fns.terminal(), canExtendBudget: !fns.terminal(), canApprovePlan: state.status === "awaiting_input" && !state.approved,
          canEditPlan: false, canRevise: state.status === "completed", canDelete: fns.terminal(), canFinish: state.status === "running" },
        budgetReached: false, createdAt: now, updatedAt: now,
      });
      fns.previewDto = () => ({ id: preview.id, engineVersion: 1, conversationId: "preview-chat", assistantMessageId: preview.assistantMessageId, modelId: "gpt-6-luna",
        status: preview.status, stepCount: 1, searchCount: 2, readCount: 0, canResume: false, createdAt: now, updatedAt: now });
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: exportPath })) as typeof dialog.showSaveDialog;
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
      fns.chatBody = (id: string) => ({ id, title: chats[id]?.question ?? "Research", kind: "chat", surface: "chat", productKey: "chat", updatedAt: now,
        selectedModels: ["gpt-6-luna"], selectionMode: "manual", autoSelection: { offered: false }, messagePage: { nextCursor: null },
        messages: [{ id: "saved-question-" + id, role: "user", content: chats[id]?.question ?? "", status: "normal" },
          ...(chats[id] ? [{ id: chats[id].assistantId, role: "assistant", content: state.status === "completed" && id === "research-chat" ? "The final report text." : "", status: "normal", modelId: "gpt-6-luna" }] : [])] });
      globalThis.fetch = async (url, options) => {
        const target = new URL(String(url));
        const method = options?.method ?? "GET";
        const body = options?.body && typeof options.body === "string" ? JSON.parse(options.body) : undefined;
        if (target.origin !== origin) throw new Error("Unexpected Desktop request " + target.href);
        host.calls.push({ method, path: target.pathname + target.search, body });
        const path = target.pathname;
        const headers = new Headers(options?.headers);
        if (path === "/api/auth/desktop/exchange") return Response.json({ ok: true, accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 600 });
        if (path === "/api/auth/desktop/session") return Response.json({ ok: true, account: { id: "fixture-account", name: "Research Fixture", email: null } });
        if (path === "/api/auth/desktop/logout") return Response.json({ ok: true });
        if (path === "/api/auth/desktop/settings-session") return Response.json({ token: "fixture..settings.web.session", expiresAt: Date.now() + 300_000 });
        if (path === "/api/products/chat/capabilities") return Response.json({ autoSelection: { offered: false }, desktopWrite: true, desktopImport: true, desktopPlugins: true, desktopChatPlugin: true,
          desktopReview: { easy: true, plan: "Pro", modelLimit: 3 } });
        if (path === "/api/models/catalog") return Response.json({ models: [{ id: "gpt-6-luna", name: "GPT 6 Luna", provider: "openai", minimumPlan: "Guest", enabled: true, status: "enabled" }] });
        if (path === "/api/user/usage") return Response.json({ plan: "Pro", usage: { creditsMonth: 1 }, limits: { creditsMonth: 100 }, balances: { dailyRemainingCredits: 3, planRemainingCredits: 63, purchasedRemainingCredits: 0 } });
        if (path === "/api/projects") return Response.json({ projects: [] });
        if (path === "/api/products/chat/conversations" && method === "POST") return Response.json({ id: "preview-chat" });
        if (path === "/api/conversations/preview-chat/messages") {
          chats["preview-chat"] = { question: body.messages[0].content, assistantId: "" };
          return Response.json({ messageMappings: [{ requestId: body.messages[0].clientRequestId, messageId: "saved-question-preview-chat" }] });
        }
        if (path === "/api/conversations") return Response.json(Object.keys(chats).map((id) => ({ id, title: chats[id].question, kind: "chat", surface: "chat", productKey: "chat", updatedAt: now, selectedModels: ["gpt-6-luna"] })));
        if (path.startsWith("/api/conversations/") && !path.includes("/messages")) {
          const id = path.split("/")[3];
          if (chats[id]) return Response.json(fns.chatBody(id));
          return Response.json({}, { status: 404 });
        }
        if (path.startsWith("/api/chat/research")) {
          if (headers.get("cookie") !== "next-auth.session-token=fixture..settings.web.session" || headers.has("authorization")) throw new Error("Invalid research credential transport");
          if (path === "/api/chat/research/offer") return Response.json({ offered: true, reason: "ready",
            features: { defaultEntry: false, privateSources: true, projectSources: false, maxApprovedCredits: 2000 }, estimate: { lowCredits: 60, highCredits: 300, perCallCredits: 6 } });
          if (path === "/api/chat/research/runs" && method === "POST") {
            state.ids = { user: body.userMessageId, assistant: body.assistantMessageId };
            chats["research-chat"] = { question: body.brief.question, assistantId: body.assistantMessageId };
            return Response.json({ run: fns.view() }, { status: 201 });
          }
          if (path === "/api/chat/research/runs/run-1" && method === "GET") {
            state.reads++;
            if (state.status === "running" && state.reads > 3) state.status = "completed";
            return Response.json({ run: fns.view() });
          }
          const action = /^\/api\/chat\/research\/runs\/run-1\/([a-z-]+)$/.exec(path)?.[1];
          if (action && method === "POST") {
            if (action === "approve") { state.approved = true; state.status = "running"; }
            if (action === "pause") state.status = "paused";
            if (action === "resume") state.status = "running";
            return Response.json({ run: fns.view() });
          }
          if (action === "sources") return Response.json({ sources: [{ id: "s1", sourceKey: "W1", title: "Example report", url: "https://example.com/report", visibility: "public", versions: [{ readStatus: "read" }] }] });
          if (action === "report") return Response.json({ markdown: "# Findings\nThe result is [the report](https://example.com/report).", revision: 1, revisions: [{ revision: 1, author: "model" }], containsPrivate: false,
            claims: [{ claimKey: "C1", text: "Prices fell in 2026.", verification: "supported", evidence: [{ sourceKey: "W1", chunkId: "chunk1", level: "read", start: 0, end: 5 }] }] });
          if (action === "evidence") return Response.json({ text: "Hello world", sourceKey: "W1", highlight: { start: 0, end: 5 }, url: "https://example.com/report" });
          if (action === "export") return new Response("# Findings\n", { headers: { "Content-Type": "text/markdown", "Content-Disposition": 'attachment; filename="research.md"' } });
          if (path === "/api/chat/research-preview/runs" && method === "GET") {
            const conversation = target.searchParams.get("conversationId");
            if (conversation === "research-chat" && chats["research-chat"]) return Response.json({ runs: [fns.view()] });
            if (conversation === "preview-chat" && preview.assistantMessageId) return Response.json({ runs: [fns.previewDto()] });
            return Response.json({ runs: [] });
          }
          if (path === "/api/chat/research-preview/offer") return Response.json({ offered: true, reason: "ready", estimatedCredits: 12, features: { pageReading: false, durableRuns: true } });
          if (path === "/api/chat/research-preview/runs" && method === "POST") {
            preview = { ...preview, assistantMessageId: body.assistantMessageId };
            chats["preview-chat"] = { question: chats["preview-chat"].question, assistantId: body.assistantMessageId };
            return Response.json({ run: fns.previewDto() }, { status: 201 });
          }
          if (path === "/api/chat/research-preview/runs/prev-1" && method === "GET") return Response.json({ run: fns.previewDto() });
          if (path === "/api/chat/research-preview/runs/prev-1/cancel") { preview.status = "cancelled"; return Response.json({ run: fns.previewDto() }); }
        }
        return Response.json({ code: "NOT_FOUND" }, { status: 404 });
      };
    }, { origin: authOrigin, exportPath });
    const page = await application.firstWindow();
    const rail = page.getByRole("navigation", { name: "Workspaces" });
    await rail.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Sign in with your browser", exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.desktop.state()).account)).toMatchObject({ stage: "connected" });
    await rail.getByRole("button", { name: "Chat", exact: true }).click();

    // Deep Research: the brief shows the estimate and the credit maximum before anything is paid for.
    const draft = page.getByRole("textbox", { name: "Chat message", exact: true });
    await draft.fill("Compare electric vehicle tax credits in 2026");
    await page.getByLabel("Add and tools").click();
    await page.getByTestId("tools-deep-research-engine-row").click();
    const sheet = page.getByTestId("deep-research-engine-sheet");
    await expect(sheet.getByTestId("dre-estimate")).toContainText("60–300 credits");
    await expect(sheet.getByTestId("dre-credits")).toHaveValue("300");
    await sheet.getByTestId("dre-credits").fill("250");
    await sheet.getByTestId("dre-urls").fill("https://example.gov/report");
    await sheet.getByTestId("dre-submit").click();
    const workspace = page.getByTestId("research-workspace");
    await expect(workspace).toHaveAttribute("data-run-status", "awaiting_input");
    await expect(page.getByTestId("research-workspace-status")).toHaveText("Waiting for you");
    await expect(draft).toHaveValue("");

    // The plan is reviewed and approved; nothing runs before that.
    await page.getByTestId("research-tab-plan").click();
    await expect(page.getByTestId("research-plan")).toContainText("What changed in 2026?");
    const qa = process.env.TOMVERSE_DESKTOP_RESEARCH_QA;
    if (qa) await page.screenshot({ path: join(qa, "research-plan.png"), animations: "disabled" });
    await page.getByTestId("research-plan-approve").click();
    await expect(workspace).toHaveAttribute("data-run-status", "running");
    await page.getByTestId("research-pause").click();
    await expect(workspace).toHaveAttribute("data-run-status", "paused");
    await page.getByTestId("research-resume").click();
    await expect(workspace).toHaveAttribute("data-run-status", "running");
    await page.getByTestId("research-extend").click();
    await expect(page.getByTestId("research-extend-confirm")).toContainText("600");
    await page.getByTestId("research-extend-confirm").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(workspace).toHaveAttribute("data-run-status", "completed", { timeout: 30_000 });
    await expect(page.getByText("The final report text.")).toBeVisible();

    // Report, evidence, export and source links stay inside the app.
    await page.getByTestId("research-tab-sources").click();
    await expect(page.getByTestId("research-sources")).toContainText("Example report");
    await page.getByTestId("research-tab-report").click();
    await expect(page.getByTestId("research-report-body")).toContainText("Findings");
    await page.getByTestId("research-evidence-open").click();
    await expect(page.getByTestId("research-evidence-text")).toContainText("Hello world");
    if (qa) await page.screenshot({ path: join(qa, "research-report.png"), animations: "disabled" });
    await page.getByTestId("research-export-md").click();
    await expect.poll(() => readFile(exportPath, "utf8").catch(() => "")).toBe("# Findings\n");
    await page.getByTestId("research-report-body").getByRole("link", { name: "the report" }).click();
    await expect(page.getByTestId("desktop-web-view")).toBeVisible();
    await page.getByTestId("desktop-web-view-close").click();

    // A new chat: Research Preview shows its scope and estimate, then saves the question and runs it.
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await draft.fill("Who won the 2026 election?");
    await page.getByLabel("Add and tools").click();
    await page.getByTestId("tools-research-preview-row").click();
    await expect(page.getByTestId("research-preview-estimate")).toContainText("12 credits");
    await page.getByTestId("research-preview-start").click();
    const card = page.getByTestId("research-run-card");
    await expect(card).toHaveAttribute("data-run-status", "queued");
    await expect(card.getByTestId("research-run-counts")).toContainText("Searches: 2");
    await card.getByTestId("research-run-cancel").click();
    await expect(card).toHaveAttribute("data-run-status", "cancelled");

    // Opening the earlier Deep Research chat again shows the saved run (the server owns its state).
    await page.getByRole("button", { name: "Compare electric vehicle tax credits in 2026", exact: true }).click();
    await expect(page.getByTestId("research-workspace")).toHaveAttribute("data-run-status", "completed");

    const result = await application.evaluate(() => {
      const host = globalThis as typeof globalThis & { calls: Array<{ method: string; path: string; body?: Record<string, unknown> }>; opened: string[] };
      return { calls: host.calls, opened: host.opened };
    });
    assert.deepEqual(result.opened, []);
    const create = result.calls.find((call) => call.method === "POST" && call.path === "/api/chat/research/runs");
    assert.equal(create?.body?.approvedCredits, 250);
    assert.equal(create?.body?.autoStart, false);
    assert.deepEqual(create?.body?.sources, [{ type: "url", url: "https://example.gov/report" }]);
    assert.equal(result.calls.filter((call) => call.method === "POST" && call.path === "/api/chat/research/runs").length, 1);
    assert.equal(result.calls.filter((call) => call.path === "/api/chat/research/runs/run-1/approve").length, 1);
    const budget = result.calls.find((call) => call.path === "/api/chat/research/runs/run-1/budget");
    assert.equal(budget, undefined);
    const previewRun = result.calls.find((call) => call.method === "POST" && call.path === "/api/chat/research-preview/runs");
    assert.equal(previewRun?.body?.conversationId, "preview-chat");
    assert.equal(previewRun?.body?.sourceUserMessageId, "saved-question-preview-chat");
    assert.equal(result.calls.filter((call) => call.method === "POST" && call.path === "/api/chat/research-preview/runs").length, 1);
  } finally {
    await application?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  }
});
