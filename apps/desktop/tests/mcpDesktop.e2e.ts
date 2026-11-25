import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { expect, type ElectronApplication } from "@playwright/test";
import { FakeGateway, fixtureWorkAnalysis, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";
import { antigravityModel, antigravityPatchFunction, antigravityReadFunction, antigravityTaskListFunction } from "../src/host/antigravity-fixture";
import { grokPatchFunction, grokReadFunction } from "../src/host/grok-fixture";
import { deepSeekPatchFunction, deepSeekReadFunction, vibePatchFunction, vibeReadFunction } from "../src/host/native-mcp-server";
import { sendDeepSeekResponse } from "./deepseek-response-fixture";
import { decideNativePatch, launchNativeFixture, removeNativeFixtureDirectory } from "./launch-native-fixture";

const vendors = [
  { key: "vibe", provider: "mistral", name: "Vibe", version: "3.1.4", archive: process.env.TOMVERSE_DESKTOP_VIBE_TASK_ARCHIVE },
  { key: "deepseek", provider: "deepseek", name: "DeepSeek Harness", version: "0.2.2-rc.2",
    archive: process.env.TOMVERSE_DESKTOP_DEEPSEEK_TASK_ARCHIVE },
  { key: "zcode", provider: "zhipu", name: "ZCode Agent", version: "0.17.1", archive: process.env.TOMVERSE_DESKTOP_ZCODE_TASK_DIR },
  { key: "minimax", provider: "minimax", name: "MiniMax Code", version: "0.7.9", archive: process.env.TOMVERSE_DESKTOP_MINIMAX_TASK_DIR },
  { key: "grok", provider: "xai", name: "Grok Build", version: "1.0.92", archive: process.env.TOMVERSE_DESKTOP_GROK_TASK_BINARY },
  { key: "antigravity", provider: "google", name: "Antigravity", version: process.platform === "darwin" ? "1.5.15" : "1.5.14",
    archive: process.env.TOMVERSE_DESKTOP_ANTIGRAVITY_TASK_BINARY },
] as const;
// Debian QA extracts the official archives for each run under full-system emulation.
const taskWait = process.platform === "linux" ? 110_000 : 40_000;
const approvalViewWait = process.platform === "linux" ? 25_000 : 5_000;
type Tool = { name: string; args: object };
const geminiApiModel = "gemini-3.1-pro-preview";
const geminiTitleModel = "gemini-3.1-flash-lite-preview";

function linuxDescendants(parent: number) {
  const children = new Map<number, number[]>();
  for (const line of execFileSync("/usr/bin/ps", ["-e", "-o", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/u).map(Number);
    if (pid && ppid) children.set(ppid, [...children.get(ppid) ?? [], pid]);
  }
  const tree = new Set([parent]);
  for (const pid of tree) for (const descendant of children.get(pid) ?? []) tree.add(descendant);
  tree.delete(parent);
  return [...tree];
}

async function activeLinuxProcesses(pids: number[]) {
  const running = await Promise.all(pids.map(async (pid) => {
    const info = await readFile(`/proc/${pid}/stat`, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    return info && !["Z", "X"].includes(info.slice(info.lastIndexOf(")") + 2, info.lastIndexOf(")") + 3)) ? pid : undefined;
  }));
  return running.filter((pid) => pid !== undefined);
}

async function crashCodeWorker(application: ElectronApplication) {
  const runtime = await application.evaluate(({ app }) => app.getAppMetrics().find((item) =>
    item.type === "Utility" && (item.name === "Tomverse Code Runtime" || item.serviceName === "Tomverse Code Runtime"))?.pid);
  assert.ok(runtime, "The fixture Code worker was not found.");
  const descendants = process.platform === "linux" ? linuxDescendants(runtime) : [];
  process.kill(runtime, "SIGKILL");
  return descendants;
}

function sendAntigravityResponse(response: ServerResponse, model: string, tool?: Tool) {
  const part = tool ? { functionCall: tool } : { text: "The workspace task finished." };
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end("data: " + JSON.stringify({
    candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 4, totalTokenCount: 25 }, modelVersion: model,
  }) + "\n\n");
}

function sendVibeResponse(response: ServerResponse, model: string, index: number, tool?: Tool,
  text = "The workspace task finished.", includeUsage = true) {
  const chunk = { id: "desktop-" + index, object: "chat.completion.chunk", created: 1, model };
  const send = (delta: object, finish_reason: string | null = null) =>
    response.write("data: " + JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason }] }) + "\n\n");
  response.writeHead(200, { "content-type": "text/event-stream" });
  send({ role: "assistant" });
  send(tool ? { tool_calls: [{ index: 0, id: "call_" + index, type: "function",
    function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { content: text });
  send({}, tool ? "tool_calls" : "stop");
  if (includeUsage) response.write("data: " + JSON.stringify({ ...chunk, choices: [],
    usage: { prompt_tokens: 21, completion_tokens: 4, total_tokens: 25 } }) + "\n\n");
  response.end("data: [DONE]\n\n");
}
for (const vendor of vendors) test(`${vendor.name} binds Code edits to Desktop approval and restores the verified task${vendor.key === "zcode" ? "" : " after a follow-up"}`, {
  timeout: 6 * taskWait + 20_000, skip: vendor.archive ? false : `Requires the pinned ${vendor.name} release`,
}, async () => {
  const deepSeek = vendor.key === "deepseek";
  const zcode = vendor.key === "zcode";
  const miniMax = vendor.key === "minimax";
  const grok = vendor.key === "grok";
  const antigravity = vendor.key === "antigravity";
  const directMcp = deepSeek || zcode || miniMax;
  const model = antigravity ? antigravityModel : zcode ? "gpt-4o" : vendor.key + "-desktop-fixture";
  const geminiCall = (name: string, args: object) => ({ name, args: { ...args, toolSummary: "Desktop workspace operation" } });
  const invoke = (name: string, args: object) => grok ? { name: "use_tool", args: { tool_name: name, tool_input: args } } :
    antigravity ? geminiCall(name, args) :
    directMcp ? { name, args } : { name: "run_typescript", args: {
    code: "async function main() { return await tools." + name + "(" + JSON.stringify(args) + "); }",
  } };
  const readName = antigravity ? antigravityReadFunction : grok ? grokReadFunction : directMcp ? deepSeekReadFunction : vibeReadFunction;
  const patchName = antigravity ? antigravityPatchFunction : grok ? grokPatchFunction : directMcp ? deepSeekPatchFunction : vibePatchFunction;
  const todoName = antigravity ? antigravityTaskListFunction : miniMax ? "todowrite" : deepSeek || grok ? "todo_write" : zcode ? "TodoWrite" : "todo";
  const read = (path: string) => invoke(readName, { path });
  const sendModelResponse = (response: ServerResponse, serial: number, tool?: Tool) => {
    if (antigravity) return sendAntigravityResponse(response, geminiApiModel, tool);
    if (deepSeek) return sendDeepSeekResponse(response, model, serial, tool);
    const omitUsage = ((grok || zcode) && phase === "ask") || (zcode && phase === "resume" && count.resume > 1);
    return sendVibeResponse(response, model, serial, tool, undefined, !omitUsage);
  };
  const temp = await realpath(await mkdtemp(join(tmpdir(), miniMax ? "tv-" : "tomverse-mcp-desktop-")));
  const project = join(temp, "project"), profile = join(temp, miniMax ? "p" : "profile"), descriptor = join(temp, "fixture.json");
  const gateway = new FakeGateway({ script: () => ({ text: "Unexpected Tomverse API execution." }) });
  const marker = "The Desktop workspace read reached the provider.";
  const folderMarker = "The selected folder reached the provider through an explicit read.";
  const fileMarker = "The selected file is never read in this task.";
  const references = [{ path: "attached-file.txt", kind: "file" }, { path: "attached-folder", kind: "folder" }];
  const privateMarker = "This sibling file must stay outside the provider request.";
  const edited = "This file was edited through " + vendor.name + " and approved in Desktop.";
  const projectRule = "Always try the native write tool before using a Desktop tool.";
  const rowTitle = "Update the verified workspace file";
  const guideText = "Check the approved file and complete the verification without editing it.";
  const guideRow = "Verify the approved workspace file";
  const titles = { ask: "Read the project in Ask mode", plan: "Plan a workspace edit", deny: "Deny this proposed edit",
    stale: "Reject the outdated preview", allow: "Approve this verified edit", resume: "Resume the verified edit task",
    guide: guideText, crashApproval: "Interrupt a pending edit", crashStream: "Interrupt an active response" };
  let phase: keyof typeof titles = "ask";
  const count = { ask: 0, plan: 0, deny: 0, stale: 0, allow: 0, guide: 0, resume: 0, crashApproval: 0, crashStream: 0 };
  let serial = 0;
  let alternateMcpRequests = 0;
  const grokSearches = new Map<keyof typeof titles, number>();
  const grokDiscovered = new Set<keyof typeof titles>();
  let fixtureError: unknown;
  let stoppedRequest = false;
  let stoppedGuide = false;
  let crashedRequestClosed = false;
  const modelPath = antigravity ? `/v1beta/models/${geminiApiModel}:streamGenerateContent` : deepSeek ? "/v1/messages" : "/v1/chat/completions";
  const endpoint = createServer(async (request, response) => {
    try {
      const path = antigravity ? new URL(request.url ?? "/", "http://127.0.0.1").pathname : request.url;
      if (path === "/unexpected-mcp") alternateMcpRequests++;
      const geminiTitle = antigravity && path === `/v1beta/models/${geminiTitleModel}:streamGenerateContent`;
      if ((miniMax || grok || antigravity) && path !== modelPath && !geminiTitle) {
        response.writeHead(403).end();
        return;
      }
      assert.equal(request.method, "POST");
      if (!geminiTitle) assert.equal(path, modelPath);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      assert.ok(!raw.includes(privateMarker));
      assert.ok(!raw.includes(fileMarker));
      if (geminiTitle) return sendAntigravityResponse(response, geminiTitleModel);
      const body = JSON.parse(raw);
      if (deepSeek) assert.equal(Object.hasOwn(body, "dsh_session_log"), false, "The DeepSeek request included a native session log");
      if (antigravity) {
        const readOnly = phase === "ask" || phase === "crashStream";
        const available = body.tools.flatMap((group: { functionDeclarations?: Tool[]; function_declarations?: Tool[] }) =>
          (group.functionDeclarations ?? group.function_declarations ?? []).map(({ name }) => name)).sort();
        assert.deepEqual(available, ["list_resources", "manage_task", readName, "read_resource", "send_message",
          ...(readOnly ? [] : [todoName]), ...(readOnly || phase === "plan" ? [] : [patchName])].sort());
        assert.ok(raw.includes("Use only Desktop MCP tools for workspace operations."));
      } else assert.equal(body.model, model);
      serial++;
      if (directMcp) {
        assert.deepEqual(body.tools.map((tool: { name?: string; function?: { name: string } }) => tool.name ?? tool.function?.name).sort(),
          [readName, todoName, ...(phase === "ask" || phase === "plan" ? [] : [patchName]),
            ...(miniMax ? ["task_query", "task_output", "task_stop", "tool_search", "mcp_invoke"] : [])].sort());
        assert.ok(raw.includes(projectRule), "Project instructions must reach the model.");
      }
      const lastResult = antigravity ? JSON.stringify(body.contents.at(-1)?.parts) :
        deepSeek ? JSON.stringify(body.messages.flatMap(({ content }: { content: unknown }) =>
        Array.isArray(content) ? content : []).filter(({ type }: { type: string }) => type === "tool_result").at(-1)?.content) :
        body.messages.filter(({ role }: { role: string }) => role === "tool").at(-1)?.content;
      if (grok) {
        const tools = body.tools?.map((tool: { function: { name: string } }) => tool.function.name) ?? [];
        if (tools.length === 0 || tools.length === 1 && tools[0] === "session_title") {
          const title = "Verified workspace task";
          const tool = tools.length ? { name: "session_title", args: { title } } : undefined;
          if (body.stream) return sendModelResponse(response, serial, tool);
          const message = tool ? { role: "assistant", tool_calls: [{ id: "title_" + serial, type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { role: "assistant", content: title };
          response.writeHead(200, { "content-type": "application/json" });
          return response.end(JSON.stringify({ id: "summary", object: "chat.completion", model,
            choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }] }));
        }
        assert.deepEqual(tools.sort(), ["search_tool", "todo_write", "use_tool"]);
        assert.ok(raw.includes("Use only Desktop tools when working with project files."), "The scoped Grok agent profile must reach the model.");
        const canEdit = phase !== "ask" && phase !== "plan";
        if (!grokDiscovered.has(phase)) {
          if (typeof lastResult === "string" && lastResult.includes(readName) && (!canEdit || lastResult.includes(patchName))) {
            assert.equal(lastResult.includes(patchName), canEdit);
            grokDiscovered.add(phase);
          } else {
            const searches = (grokSearches.get(phase) ?? 0) + 1;
            assert.ok(searches <= 10, "Grok did not discover the Desktop MCP tools.");
            grokSearches.set(phase, searches);
            if (searches > 1) await delay(300);
            return sendModelResponse(response, serial, { name: "search_tool", args: { query: "desktop" } });
          }
        }
      }
      const index = ++count[phase];
      if (phase === "crashStream") {
        assert.equal(index, 1, "An interrupted model request must not be replayed.");
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
        response.on("close", () => { crashedRequestClosed = true; });
        return;
      }
      const messages = antigravity ? body.contents.map(({ role, parts }: { role: string; parts: unknown[] }) =>
        ({ role, content: parts })) : body.messages;
      const currentTurn = messages.filter(({ role }: { role: string }) => role === "user").reverse()
        .map(({ content }: { content: string | Array<{ text?: string }> }) => {
          const text = Array.isArray(content) ? content.map(({ text }) => text).join("\n") : content;
          return /"turnId":"([a-f\d-]+)"/.exec(text)?.[1];
        }).find(Boolean);
      const todoItem = (id: string, content: string, status: string) =>
        deepSeek ? { content, status } : grok || antigravity ? { id, content, status } :
          directMcp ? { content, status, priority: "medium" } : { id, content, status, priority: "medium" };
      const todo = (status: "pending" | "in_progress" | "completed") => {
        const guided = phase === "guide";
        const analysis = guided ? { ...fixtureWorkAnalysis, objective: guideText } : fixtureWorkAnalysis;
        const todos = [todoItem(guided ? "verify-approved" : "verified-work", JSON.stringify({
          title: guided ? guideRow : rowTitle, turnId: currentTurn, analysis,
        }), status), ...(guided ? [] : [todoItem("next", "Review the next change", "pending")])];
        return antigravity ? geminiCall(todoName, { items: todos }) : { name: todoName, args: {
          ...(grok ? { merge: false } : directMcp ? {} : { action: "write" }), todos,
        } };
      };
      if (phase === "ask") {
        if (antigravity && index === 1) return sendModelResponse(response, serial,
          { name: "write_file", args: { Path: join(project, "ask-denied.txt"), Content: edited } });
        if (index === 1) return sendModelResponse(response, serial, { name: zcode ? "Write" : grok || directMcp ? "write" : "write_file",
          args: { [zcode || grok ? "file_path" : "path"]: join(project, "ask-denied.txt"), content: edited } });
        if (grok && index === 2) {
          assert.match(lastResult, /Tool not found: write/);
          return sendModelResponse(response, serial, { name: "read_file", args: { target_file: join(temp, "private.txt") } });
        }
        if (antigravity && index === 2) {
          assert.match(lastResult, /unknown tool:.*write_file/);
          return sendModelResponse(response, serial, { name: "read_file", args: { Path: join(temp, "private.txt") } });
        }
        const askStep = grok || antigravity ? index - 1 : index;
        if (askStep === 2) {
          if (grok) assert.match(lastResult, /Tool not found: read_file/);
          if (antigravity) assert.match(lastResult, /unknown tool:.*read_file/);
          return sendModelResponse(response, serial, read("../private.txt"));
        }
        if (askStep === 3) {
          assert.match(lastResult, miniMax ? /Desktop workspace file is unavailable|filesystem path is outside the workspace/ :
            /Desktop workspace file is unavailable/);
          return sendModelResponse(response, serial, read("sample.txt"));
        }
        assert.equal(askStep, 4);
        assert.match(lastResult, new RegExp(marker));
        return sendModelResponse(response, serial);
      }
      assert.ok(currentTurn);
      if (phase === "resume") {
        assert.ok(raw.includes(titles.allow));
        assert.ok(raw.includes("attached-file.txt") && raw.includes("attached-folder"));
        if (!zcode) assert.ok(raw.includes(guideText));
        if (index === 1) return sendModelResponse(response, serial, read("allow.txt"));
        assert.equal(index, 2);
        assert.match(lastResult, new RegExp(edited));
        return sendModelResponse(response, serial);
      }
      if (phase === "guide") {
        assert.ok(raw.includes(guideText));
        assert.ok(raw.includes(titles.allow));
        if (index === 1) return sendModelResponse(response, serial, todo("in_progress"));
        if (index === 2) return sendModelResponse(response, serial, read("allow.txt"));
        assert.equal(index, 3);
        assert.match(lastResult, new RegExp(edited));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
        response.on("close", () => { stoppedGuide = true; });
        return;
      }
      if (phase === "plan") {
        if (index === 1) return sendModelResponse(response, serial, todo("in_progress"));
        if (index === 2) return sendModelResponse(response, serial, read("sample.txt"));
        if (index === 3) {
          assert.match(lastResult, new RegExp(marker));
          return sendModelResponse(response, serial, todo("completed"));
        }
        if (antigravity && index === 4) return sendModelResponse(response, serial, invoke(patchName, {
          edits: [{ path: "plan.txt", action: "create", content: edited }],
        }));
        assert.equal(index, antigravity ? 5 : 4);
        if (antigravity) assert.match(lastResult, /unknown tool:.*desktop_apply_patch/);
        return sendModelResponse(response, serial);
      }
      if (index === 1) {
        if (phase === "allow") {
          assert.ok(raw.includes("User-selected project references"));
          assert.ok(raw.includes("attached-file.txt") && raw.includes("attached-folder"));
          assert.ok(!raw.includes("nested.txt") && !raw.includes(folderMarker));
        }
        return sendModelResponse(response, serial, read(phase === "allow" ? "attached-folder/nested.txt" : "sample.txt"));
      }
      if (index === 2) {
        assert.match(lastResult, new RegExp(phase === "allow" ? folderMarker : marker));
        return sendModelResponse(response, serial, todo("in_progress"));
      }
      if (index === 3) return sendModelResponse(response, serial, invoke(patchName, {
        edits: [{ path: phase + ".txt", action: "create", content: edited }],
      }));
      if (index === 4) {
        assert.match(lastResult, phase === "allow" ? /approved Desktop patch was verified/ :
          phase === "stale" ? /changed after the preview/ : /No approved Desktop file edit was applied/);
        return sendModelResponse(response, serial, todo("completed"));
      }
      assert.equal(index, 5);
      if (phase === "allow") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
        response.on("close", () => { stoppedRequest = true; });
      } else sendModelResponse(response, serial);
    } catch (error) {
      fixtureError = error;
      response.writeHead(400).end();
    }
  });
  endpoint.on("connect", (_request, socket) => {
    if (miniMax || grok || antigravity) socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    else socket.destroy();
  });
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(project), mkdir(profile), gateway.start()]);
    await mkdir(join(project, "attached-folder"));
    await Promise.all([writeFile(join(profile, "language.txt"), "en"), writeFile(join(project, "sample.txt"), marker),
      writeFile(join(project, "attached-folder", "nested.txt"), folderMarker), writeFile(join(project, "attached-file.txt"), fileMarker),
      writeFile(join(temp, "private.txt"), privateMarker)]);
    if (directMcp || grok || antigravity) await writeFile(join(project, "AGENTS.md"), projectRule);
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    await writeFile(descriptor, JSON.stringify({ root: project, profile, endpoint: gateway.base, key: TEST_KEY, [vendor.key]: {
      executable: vendor.archive, version: vendor.version, model, origin: "http://127.0.0.1:" + address.port,
      allowSavedHistory: true, allowFileEdits: true,
    } }));
    app = await launchNativeFixture(descriptor);
    const page = await app.firstWindow();
    const task = () => page.evaluate(() => window.desktop.state().then(({ task }) => task));
    const awaitTask = (status: string) => expect.poll(async () => {
      assert.ifError(fixtureError);
      const state = await task();
      // Include the model request count to identify where the native flow stopped.
      if (state?.status === "unknown" || state?.status === "failed") {
        throw new Error(vendor.name + " task reached " + state.status + " after " + count[phase] + " model requests in " + phase);
      }
      return [state?.title, state?.status];
    }, { timeout: taskWait }).toEqual([phase === "guide" ? titles.allow : titles[phase], status]);
    await page.getByRole("button", { name: "Open local folder" }).click();
    await page.evaluate(() => window.desktop.setCodeExecutionPreference("provider_cli"));
    const mode = page.getByLabel("Code mode");
    const composer = page.getByRole("textbox", { name: "Code request" });
    const send = page.getByRole("button", { name: "Send Code request", exact: true });
    await mode.selectOption("ask");
    await composer.fill(titles.ask);
    await send.click();
    await awaitTask("completed");
    assert.equal((await task())?.nativeSession?.provider, vendor.provider);
    assert.equal((await task())?.root, project);
    await assert.rejects(readFile(join(project, "ask-denied.txt")), { code: "ENOENT" });
    if (grok || zcode || deepSeek) {
      assert.equal((await task())?.nativeRuns?.at(-1)?.usage, undefined);
      const usage = page.getByText(`Provider usage · ${vendor.name}`, { exact: true });
      await usage.click();
      await expect(usage.locator("..")).toContainText("Token usage unconfirmed");
    }
    phase = "plan";
    await mode.selectOption("plan");
    await composer.fill(titles.plan);
    await send.click();
    await awaitTask("completed");
    const planned = await task();
    assert.equal(planned?.plan?.analysis?.objective, fixtureWorkAnalysis.objective);
    assert.equal(planned?.plan?.activeId, null);
    assert.equal(planned?.plan?.items[0]?.nativeStatus, "completed");
    assert.deepEqual(planned?.plan?.items[0]?.evidence.map(({ state }) => state), ["succeeded"]);
    assert.deepEqual(planned?.changes, []);
    await expect(page.locator('.code-task-list-item[data-status="pending"]')).toHaveCount(2);
    await expect(page.locator(".code-task-list")).toContainText("0/2 complete");
    await assert.rejects(readFile(join(project, "plan.txt")), { code: "ENOENT" });
    await mode.selectOption("agent");
    await page.getByRole("checkbox", { name: "Save to local history" }).check();
    const row = page.locator(".code-task-list-item").filter({ hasText: rowTitle });
    for (const action of ["deny", "stale", "allow"] as const) {
      phase = action;
      if (action === "allow") {
        await app.evaluate(({ dialog }, { root, file, folder }) => {
          dialog.showOpenDialog = async (_window: unknown, options?: Electron.OpenDialogOptions) => {
            if (options?.defaultPath !== root) throw new Error("Unexpected project picker root.");
            return { canceled: false, filePaths: [options.properties?.includes("openDirectory") ? folder : file] };
          };
        }, { root: project, file: join(project, "attached-file.txt"), folder: join(project, "attached-folder") });
        const attach = page.getByLabel("Attach project files or folders");
        await attach.click();
        await page.getByRole("button", { name: "Attach files", exact: true }).click();
        await attach.click();
        await page.getByRole("button", { name: "Attach folders", exact: true }).click();
        await expect(page.getByRole("list", { name: "Project references", exact: true }).getByRole("listitem")).toHaveCount(2);
        assert.equal(count.allow, 0);
      }
      await composer.fill(titles[action]);
      const approval = app.waitForEvent("window", { timeout: taskWait }).catch(async (error) => {
        assert.ifError(fixtureError);
        throw new Error(vendor.name + " did not request approval in " + action + " after " + count[action] +
          " model requests (status: " + (await task())?.status + ").", { cause: error });
      });
      const [dialog] = await Promise.all([approval, send.click()]);
      await expect(dialog.getByRole("heading", { name: action + ".txt · create" })).toBeVisible({ timeout: approvalViewWait });
      await expect(dialog.getByRole("button", { name: "Allow for this run" })).toHaveCount(0);
      await expect(row).toHaveAttribute("data-status", "approval");
      await expect(row).toContainText(model);
      await expect(page.getByRole("region", { name: "Request analysis" })).toContainText(fixtureWorkAnalysis.objective);
      const file = join(project, action + ".txt");
      await assert.rejects(readFile(file), { code: "ENOENT" });
      const userEdit = "The user created this file while the preview was open.";
      if (action === "stale") await writeFile(file, userEdit, { flag: "wx" });
      await decideNativePatch(dialog, action === "deny" ? "Deny" : "Allow once");
      if (action === "allow") {
        await expect.poll(() => count.allow, { timeout: 25_000 }).toBe(5);
        if (!zcode) {
          const initial = await task();
          assert.ok(initial?.id && initial.nativeSession);
          phase = "guide";
          await composer.fill(guideText);
          await page.getByRole("button", { name: "Send follow-up instruction", exact: true }).click();
          await expect.poll(async () => {
            assert.ifError(fixtureError);
            const state = await task();
            if (state?.status === "unknown" || state?.status === "failed") {
              throw new Error(`${vendor.name} reached ${state.status} after ${count.guide} follow-up requests.`);
            }
            return count.guide;
          }, { timeout: taskWait }).toBe(3);
          await expect.poll(() => stoppedRequest).toBe(true);
          await expect(composer).toBeEmpty();
          await expect(page.getByRole("region", { name: "Request analysis" })).toContainText(guideText);
          await expect(page.locator(".code-task-list-item").filter({ hasText: guideRow })).toContainText(model);
          const guided = await task();
          assert.equal(guided?.id, initial.id);
          assert.equal(guided?.nativeSession?.threadId, initial.nativeSession.threadId);
          assert.notEqual(guided?.nativeSession?.turnId, initial.nativeSession.turnId);
          assert.deepEqual(guided?.changes, initial.changes);
          assert.equal(guided?.entries.filter((entry) => entry.role === "user" && entry.text === guideText).length, 1);
        }
        await page.getByRole("button", { name: "Stop Code task" }).click();
        await awaitTask("stopped");
        await expect.poll(() => zcode ? stoppedRequest : stoppedGuide).toBe(true);
        assert.equal(await readFile(file, "utf8"), edited);
        assert.equal((await task())?.plan?.items.find(({ title }) => title === rowTitle)?.complete, true);
      } else {
        await awaitTask("completed");
        assert.deepEqual((await task())?.changes, []);
        assert.equal((await task())?.plan?.items[0]?.complete, false);
        if (action === "deny") await assert.rejects(readFile(file), { code: "ENOENT" });
        else assert.equal(await readFile(file, "utf8"), userEdit);
      }
    }
    const stopped = await task();
    assert.ok(stopped?.id && stopped.nativeSession && stopped.changes.length === 1);
    assert.deepEqual(stopped.references, references);
    await app.close();
    app = await launchNativeFixture(descriptor);
    let restored = await app.firstWindow();
    const current = () => restored.evaluate(() => window.desktop.state().then(({ task }) => task));
    await restored.getByRole("button", { name: "Open local folder" }).click();
    await restored.getByRole("complementary", { name: "History" }).getByRole("button", { name: titles.allow, exact: true }).click();
    await expect(restored.locator(".code-task-list-item").filter({ hasText: rowTitle })).toContainText(model);
    if (!zcode) await expect(restored.locator(".entry--user").filter({ hasText: guideText })).toHaveCount(1);
    const savedReferences = restored.getByRole("list", { name: "Attached project references" });
    await expect(savedReferences.getByRole("listitem")).toHaveCount(2);
    phase = "resume";
    await restored.getByRole("button", { name: "Resume task", exact: true }).click();
    await expect.poll(async () => {
      assert.ifError(fixtureError);
      const status = (await current())?.status;
      if (status === "failed" || status === "unknown") {
        throw new Error(vendor.name + " resume reached " + status + " after " + count.resume + " model requests.");
      }
      return status;
    }, { timeout: taskWait }).toBe("completed");
    const resumed = await current();
    assert.equal(resumed?.id, stopped.id);
    assert.equal(resumed?.nativeSession?.threadId, stopped.nativeSession.threadId);
    assert.notEqual(resumed?.nativeSession?.turnId, stopped.nativeSession.turnId);
    assert.deepEqual(resumed?.changes, stopped.changes);
    assert.deepEqual(resumed?.references, references);
    assert.equal(gateway.completions.length, 0);
    if (zcode) {
      const run = resumed?.nativeRuns?.at(-1);
      const usage = run?.usage;
      assert.ok(run && usage?.source === "zcode_turn", "The completed ZCode turn must keep its provider usage.");
      assert.equal(run.session.turnId, resumed?.nativeSession?.turnId);
      const { nativeTurnId, eventId, ...counts } = usage;
      assert.match(nativeTurnId, /^turn_/);
      assert.match(eventId, /^[a-f0-9-]{36}$/i);
      assert.deepEqual(counts, { source: "zcode_turn", reportedRequests: 1, inputTokens: 21, outputTokens: 4 });
      assert.equal(resumed?.apiUsage, undefined);
      assert.deepEqual(resumed?.transmission, []);
      await app.close();
      app = await launchNativeFixture(descriptor);
      restored = await app.firstWindow();
      await restored.getByRole("button", { name: "Open local folder" }).click();
      await restored.getByRole("complementary", { name: "History" }).getByRole("button", { name: titles.allow, exact: true }).click();
      const summary = restored.getByText("Provider usage · ZCode Agent", { exact: true });
      await summary.click();
      await expect(summary.locator("..")).toContainText("Reported model requests 1 · Input tokens 21 · Output tokens 4");
      await expect(summary.locator("..")).toContainText("Billing source unconfirmed");
      assert.deepEqual((await current())?.nativeRuns?.at(-1)?.usage, usage);
    }
    if (antigravity || vendor.key === "vibe" || miniMax || grok) {
      const vibe = vendor.key === "vibe";
      const grokRequests = count.resume + (grokSearches.get("resume") ?? 0);
      const reported = vibe ? { source: "vibe_session", inputTokens: 168, outputTokens: 32 }
        : grok ? { source: "grok_turn", inputTokens: 21 * grokRequests, outputTokens: 4 * grokRequests }
          : { source: antigravity ? "antigravity_turn" : "minimax_turn", inputTokens: 42, outputTokens: 8 };
      const interruptedUsage = resumed?.nativeRuns?.find(({ session }) => session.turnId === stopped.nativeSession?.turnId)?.usage;
      assert.deepEqual(interruptedUsage, vibe ? { source: "vibe_session", inputTokens: 126, outputTokens: 24 } : undefined);
      assert.deepEqual(resumed?.nativeRuns?.at(-1)?.usage, reported);
      assert.equal(resumed?.nativeRuns?.at(-1)?.session.turnId, resumed?.nativeSession?.turnId);
      assert.equal(resumed?.apiUsage, undefined);
      assert.deepEqual(resumed?.transmission, []);
      await app.close();
      app = await launchNativeFixture(descriptor);
      restored = await app.firstWindow();
      await restored.getByRole("button", { name: "Open local folder" }).click();
      await restored.getByRole("complementary", { name: "History" }).getByRole("button", { name: titles.allow, exact: true }).click();
      const usage = restored.getByText("Provider usage · " + (vendor.key === "vibe" ? "Mistral Vibe" : vendor.name), { exact: true });
      await usage.click();
      const panel = usage.locator("..");
      const range = vibe ? "session total" : "turn usage";
      const displayedUsage = `Reported ${range} · ${reported.inputTokens} input · ${reported.outputTokens} output tokens`;
      await expect(panel).toContainText(displayedUsage);
      await expect(panel).toContainText(vibe ? "Reported session total · 126 input · 24 output tokens" : "Token usage unconfirmed");
      await expect(panel).toContainText("Billing source unconfirmed");
      const persistedUsage = (runs: NonNullable<typeof resumed>["nativeRuns"]) => runs?.map(({ session, usage }) => ({ session, usage }));
      assert.deepEqual(persistedUsage((await current())?.nativeRuns), persistedUsage(resumed?.nativeRuns));
    }

    if (antigravity) {
      const restoredMode = restored.getByLabel("Code mode");
      const restoredComposer = restored.getByRole("textbox", { name: "Code request" });
      const restoredSend = restored.getByRole("button", { name: "Send Code request", exact: true });
      await restored.getByRole("checkbox", { name: "Save to local history" }).check();
      phase = "crashApproval";
      await restoredMode.selectOption("agent");
      await restoredComposer.fill(titles.crashApproval);
      const [interruptedApproval] = await Promise.all([app.waitForEvent("window", { timeout: taskWait }), restoredSend.click()]);
      await expect(interruptedApproval.getByRole("heading", { name: "crashApproval.txt · create" })).toBeVisible({ timeout: approvalViewWait });
      const approvalTree = await crashCodeWorker(app);
      await expect.poll(() => interruptedApproval.isClosed(), { timeout: taskWait }).toBe(true);
      await expect.poll(async () => (await current())?.status, { timeout: taskWait }).toBe("unknown");
      await assert.rejects(readFile(join(project, "crashApproval.txt")), { code: "ENOENT" });
      assert.equal(count.crashApproval, 3);
      if (process.platform === "linux") await expect.poll(() => activeLinuxProcesses(approvalTree), { timeout: 10_000 }).toEqual([]);

      await mkdir(join(project, ".agents"));
      await writeFile(join(project, ".agents", "mcp_config.json"), JSON.stringify({ mcpServers: {
        alternate: { url: "http://127.0.0.1:" + address.port + "/unexpected-mcp" },
      } }));
      const modelRequests = serial;
      await restored.getByLabel("Code mode").selectOption("ask");
      await restored.getByRole("textbox", { name: "Code request" }).fill("Try the workspace with a configured MCP server");
      await restored.getByRole("button", { name: "Send Code request", exact: true }).click();
      await expect.poll(async () => {
        const state = await current();
        return [state?.title, state?.status];
      }, { timeout: taskWait }).toEqual(["Try the workspace with a configured MCP server", "failed"]);
      assert.equal(serial, modelRequests);
      assert.equal(alternateMcpRequests, 0);
      await rm(join(project, ".agents", "mcp_config.json"));
      await rmdir(join(project, ".agents"));

      phase = "crashStream";
      await restoredMode.selectOption("ask");
      await restoredComposer.fill(titles.crashStream);
      await restoredSend.click();
      await expect.poll(() => count.crashStream, { timeout: taskWait }).toBe(1);
      const streamTree = await crashCodeWorker(app);
      await expect.poll(async () => (await current())?.status, { timeout: taskWait }).toBe("unknown");
      await expect.poll(() => crashedRequestClosed, { timeout: 15_000 }).toBe(true);
      assert.ifError(fixtureError);
      assert.equal(count.crashStream, 1);
      if (process.platform === "linux") {
        assert.ok(streamTree.length >= 2, "Antigravity must have an active per-session process.");
        await expect.poll(() => activeLinuxProcesses(streamTree), { timeout: 10_000 }).toEqual([]);
      }
    }
  } finally {
    await app?.close();
    endpoint.closeAllConnections();
    if (endpoint.listening) await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await gateway.stop();
    await removeNativeFixtureDirectory(temp);
  }
});

const zCodeArchive = process.env.TOMVERSE_DESKTOP_ZCODE_TASK_DIR;
test("ZCode Agent applies a guide in the active task and restores the draft when stopped before delivery", {
  timeout: 4 * taskWait, skip: !zCodeArchive && "Requires the pinned ZCode Agent release",
}, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tomverse-zcode-guide-")));
  const root = join(directory, "project"), profile = join(directory, "profile"), descriptor = join(directory, "fixture.json");
  const gateway = new FakeGateway({ script: () => ({ text: "Unexpected Tomverse API execution." }) });
  const planPrompt = "Plan the workspace inspection";
  const guide = "Use the folder evidence for the revised plan.";
  const stopPrompt = "Inspect the workspace and wait";
  const cancelledGuide = "Include the input that will be stopped.";
  const revisedAnswer = "The revised workspace plan is ready.";
  const model = "gpt-4o";
  let held: ServerResponse | undefined;
  let heldClosed = false;
  let phase: "plan" | "stop" | "resume" = "plan";
  let calls = 0;
  let revisedTurn: string | undefined;
  let fixtureError: unknown;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(body.model, model);
      assert.ok(!JSON.stringify(body.messages).includes(cancelledGuide));
      assert.ok(!body.tools.some((tool: { function: { name: string } }) => tool.function.name === deepSeekPatchFunction));
      const userInputs: string[] = body.messages.filter(({ role }: { role: string }) => role === "user")
        .map(({ content }: { content: unknown }) => typeof content === "string" ? content : JSON.stringify(content));
      calls++;
      if (calls === 1 && phase !== "resume") {
        assert.ok(userInputs.some((input) => input.includes(phase === "plan" ? planPrompt : stopPrompt)));
        held = response;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
        response.once("close", () => { heldClosed = true; });
        return;
      }
      if (phase === "resume") {
        assert.equal(calls, 1);
        assert.ok(JSON.stringify(body.messages).includes(stopPrompt));
        return sendVibeResponse(response, model, calls, undefined, "The stopped workspace inspection resumed.");
      }
      assert.equal(phase, "plan");
      const text = userInputs.findLast((input) => input.includes(guide));
      assert.ok(text, `ZCode request ${calls} did not include the follow-up.`);
      assert.ok(JSON.stringify(body.messages).includes(planPrompt));
      revisedTurn = /"turnId":"([a-f\d-]+)"/.exec(text)?.[1];
      assert.ok(revisedTurn);
      if (calls === 2) return sendVibeResponse(response, model, calls, { name: "TodoWrite", args: { todos: [{
        content: JSON.stringify({ title: "Inspect the selected folder", turnId: revisedTurn,
          analysis: { ...fixtureWorkAnalysis, objective: guide } }), status: "pending", priority: "medium",
      }] } });
      assert.equal(calls, 3);
      return sendVibeResponse(response, model, calls, undefined, revisedAnswer);
    } catch (error) {
      fixtureError = error;
      response.writeHead(400).end();
    }
  });
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile), gateway.start()]);
    await writeFile(join(profile, "language.txt"), "en");
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY, zcode: {
      executable: zCodeArchive, version: "0.17.1", model, origin: "http://127.0.0.1:" + address.port, allowSavedHistory: true,
    } }));
    app = await launchNativeFixture(descriptor);
    const page = await app.firstWindow();
    const task = () => page.evaluate(() => window.desktop.state().then(({ task }) => task));
    const awaitStatus = (status: string) => expect.poll(async () => {
      assert.ifError(fixtureError);
      const current = await task();
      if (current?.status === "unknown" || current?.status === "failed") throw new Error(`ZCode returned ${current.status} during ${phase}.`);
      return current?.status;
    }, { timeout: taskWait }).toBe(status);
    await page.getByRole("button", { name: "Open local folder" }).click();
    await page.evaluate(() => window.desktop.setCodeExecutionPreference("provider_cli"));
    const mode = page.getByLabel("Code mode");
    const composer = page.getByRole("textbox", { name: "Code request" });
    const send = page.getByRole("button", { name: "Send Code request", exact: true });
    const steer = page.getByRole("button", { name: "Send follow-up instruction", exact: true });
    await page.getByRole("checkbox", { name: "Save to local history" }).check();
    await mode.selectOption("plan");
    await composer.fill(planPrompt);
    await send.click();
    await expect.poll(() => Boolean(held), { timeout: taskWait }).toBe(true);
    const initial = await task();
    assert.ok(initial?.id && initial.nativeSession);
    await composer.fill(guide);
    await steer.click();
    await expect.poll(async () => (await task())?.pendingFollowUp, { timeout: taskWait }).toBe(guide);
    assert.equal((await task())?.entries.filter((entry) => entry.role === "user" && entry.text === guide).length, 0);
    assert.equal(calls, 1);
    const chunk = { id: "guide-held", object: "chat.completion.chunk", created: 1, model };
    held!.write("data: " + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "Initial inspection." }, finish_reason: null }] }) + "\n\n");
    held!.write("data: " + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\n\n");
    held!.write("data: " + JSON.stringify({ ...chunk, choices: [],
      usage: { prompt_tokens: 17, completion_tokens: 6, total_tokens: 23 } }) + "\n\n");
    held!.end("data: [DONE]\n\n");
    await awaitStatus("completed");
    await expect(composer).toBeEmpty();
    const finished = await task();
    assert.equal(finished?.id, initial.id);
    assert.equal(finished?.nativeSession?.threadId, initial.nativeSession.threadId);
    assert.equal(finished?.nativeSession?.turnId, revisedTurn);
    assert.notEqual(revisedTurn, initial.nativeSession.turnId);
    const usageRecords = finished?.nativeRuns?.flatMap(({ usage }) => usage?.source === "zcode_turn" ? [usage] : []) ?? [];
    assert.equal(new Set(usageRecords.map(({ nativeTurnId }) => nativeTurnId)).size, usageRecords.length);
    assert.deepEqual(usageRecords.reduce(({ requests, input, output }, usage) => ({
      requests: requests + usage.reportedRequests, input: input + usage.inputTokens, output: output + usage.outputTokens,
    }), { requests: 0, input: 0, output: 0 }), { requests: 3, input: 59, output: 14 });
    assert.deepEqual(finished?.entries.flatMap((entry) => entry.role === "user" ? [entry.text] : []), [planPrompt, guide]);
    assert.ok(finished?.entries.some((entry) => entry.role === "assistant" && entry.text === revisedAnswer));
    await expect(page.getByRole("region", { name: "Request analysis" })).toContainText(guide);
    await expect(page.locator('.code-task-list-item[data-status="pending"]')).toContainText("Inspect the selected folder");

    phase = "stop";
    calls = 0;
    held = undefined;
    heldClosed = false;
    await mode.selectOption("ask");
    await composer.fill(stopPrompt);
    await send.click();
    await expect.poll(() => Boolean(held), { timeout: taskWait }).toBe(true);
    const stoppedThread = (await task())?.nativeSession?.threadId;
    assert.ok(stoppedThread);
    await composer.fill(cancelledGuide);
    await steer.click();
    await expect.poll(async () => (await task())?.pendingFollowUp, { timeout: taskWait }).toBe(cancelledGuide);
    await page.getByRole("button", { name: "Stop Code task" }).click();
    await awaitStatus("stopped");
    await expect(composer).toHaveValue(cancelledGuide);
    assert.ok(heldClosed);
    assert.equal(calls, 1);
    assert.equal((await task())?.entries.some((entry) => entry.role === "user" && entry.text === cancelledGuide), false);
    await app.close();
    app = undefined;

    phase = "resume";
    calls = 0;
    app = await launchNativeFixture(descriptor);
    const restored = await app.firstWindow();
    await restored.getByRole("button", { name: "Open local folder" }).click();
    const history = restored.getByRole("complementary", { name: "History" });
    await history.getByRole("button", { name: planPrompt, exact: true }).click();
    await expect(restored.locator(".entry--user").filter({ hasText: guide })).toHaveCount(1);
    await history.getByRole("button", { name: stopPrompt, exact: true }).click();
    await restored.getByRole("button", { name: "Resume task", exact: true }).click();
    const restoredTask = () => restored.evaluate(() => window.desktop.state().then(({ task }) => task));
    await expect.poll(async () => {
      assert.ifError(fixtureError);
      return (await restoredTask())?.status;
    }, { timeout: taskWait }).toBe("completed");
    assert.equal((await restoredTask())?.nativeSession?.threadId, stoppedThread);
    assert.equal(calls, 1);
    assert.equal(gateway.completions.length, 0);
  } finally {
    await app?.close();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await gateway.stop();
    await removeNativeFixtureDirectory(directory);
  }
});
