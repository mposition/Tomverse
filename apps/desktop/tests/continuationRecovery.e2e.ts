import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { Journal } from "../../tomverse-cli/src/session.js";
import { FakeGateway, fixtureInitialWorkPlan, fixtureWorkAnalysis, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";
import { codeHistoryScope } from "../src/host/history-scope";
import { apiCliDirectory, nativeHistoryHome, nativeSessionDirectory, readNativeCheckpoint, readNativeHistory } from "../src/host/native-history";
import { bindProjectRoot } from "../src/host/project-root";
import { codexFixtureCall, flattenCodexTools, type CodexRequest, writeCodexResponse } from "./codex-response-fixture";
import { launchNativeFixture } from "./launch-native-fixture";

const executable = process.env.TOMVERSE_DESKTOP_CODEX_TASK_BINARY;
const model = "gpt-5.5";
const linux = process.platform === "linux";
const transitionTimeout = linux ? 60_000 : 25_000;

async function setup(context: TestContext, gateway: FakeGateway, respond: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  const temp = await mkdtemp(join(tmpdir(), "tomverse-switch-crash-"));
  const root = join(temp, "project");
  const profile = join(temp, "profile");
  const descriptor = join(temp, "fixture.json");
  let application: ElectronApplication | undefined;
  let fixtureError: unknown;
  const native = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
    void respond(request, response).catch((error) => {
      fixtureError = error;
      if (!response.headersSent) response.writeHead(400);
      response.end();
    });
  });
  context.after(async () => {
    await application?.close();
    native.closeAllConnections();
    await new Promise<void>((resolve) => native.close(() => resolve()));
    await gateway.stop();
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    assert.ifError(fixtureError);
  });
  await Promise.all([mkdir(root), mkdir(profile), gateway.start()]);
  await writeFile(join(profile, "language.txt"), "en");
  native.listen(0, "127.0.0.1");
  await once(native, "listening");
  const address = native.address();
  assert.ok(address && typeof address !== "string");
  const fixture = { executable: executable!, version: "0.171.0-alpha.13", model, origin: "http://127.0.0.1:" + address.port,
    allowSavedHistory: true as const, allowFileEdits: true as const };
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY, codex: fixture }));
  const scope = codeHistoryScope(profile, null, bindProjectRoot(root), { key: TEST_KEY, endpoint: gateway.base });
  async function selectProject(app: ElectronApplication) {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Open local folder" }).click();
    await expect.poll(() => page.evaluate(async () => {
      const { root, codeCatalog } = await window.desktop.state();
      return Boolean(root) && codeCatalog === "ready";
    }), { timeout: transitionTimeout }).toBe(true);
    return page;
  }

  async function open() {
    await application?.close();
    application = await launchNativeFixture(descriptor, transitionTimeout);
    const page = await selectProject(application);
    return { app: application, page, state: () => page.evaluate(() => window.desktop.state()) };
  }
  async function openCompetingProfile() {
    const otherProfile = join(temp, "other-profile");
    const otherDescriptor = join(temp, "other.json");
    await mkdir(otherProfile);
    await writeFile(join(otherProfile, "language.txt"), "en");
    await writeFile(otherDescriptor, JSON.stringify({ root, profile: otherProfile, endpoint: gateway.base, key: TEST_KEY, codex: fixture }));
    const app = await launchNativeFixture(otherDescriptor, transitionTimeout);
    try { return { app, page: await selectProject(app) }; }
    catch (error) {
      await app.close();
      throw error;
    }
  }
  return { root, scope, fixture, open, openCompetingProfile };
}

async function configure(page: Page, executionMode: "tomverse_api" | "provider_cli") {
  await page.evaluate(async ({ engine, choice, executionMode }) => {
    const scope = (await window.desktop.state()).codeFallback!.scope;
    await window.desktop.setCodeExecutionPreference(executionMode);
    await window.desktop.updateCodeFallback({ scope, field: "destination", engine });
    await window.desktop.updateCodeFallback({ scope, field: "model", model: choice });
    await window.desktop.updateCodeFallback({ scope, field: "apiCreditCap", credits: 50 });
    await window.desktop.updateCodeFallback({ scope, field: "automatic", enabled: true });
  }, { engine: executionMode === "tomverse_api" ? "openai" as const : "tomverse_api" as const,
    choice: executionMode === "tomverse_api" ? model : "fake-coder", executionMode });
}

function start(page: Page, prompt: string, executionMode: "tomverse_api" | "provider_cli", mode: "ask" | "agent") {
  return page.evaluate((input) => window.desktop.start(input), {
    model: executionMode === "tomverse_api" ? "fake-coder" : model,
    prompt, mode, effort: "default" as const, executionMode, saveHistory: true,
  });
}

async function stopWorker(app: ElectronApplication) {
  await app.evaluate(({ app }) => {
    const runtime = app.getAppMetrics().find((item) => item.type === "Utility" &&
      (item.name === "Tomverse Code Runtime" || item.serviceName === "Tomverse Code Runtime"));
    if (!runtime) throw new Error("The fixture Code worker was not found");
    process.kill(runtime.pid);
  });
}

async function allowOnce(page: Page) {
  const button = page.getByRole("button", { name: "Allow once", exact: true });
  await expect(button).toBeEnabled();
  try { await button.click(); }
  catch (error) { if (!page.isClosed()) throw error; }
}

const support = { timeout: linux ? 240_000 : 100_000, skip: executable ? false : "Requires the pinned Codex executable" };
const history = (page: Page, title: string) =>
  page.getByRole("complementary", { name: "History" }).getByRole("button", { name: title, exact: true });

test("API to Codex recovery preserves an unconfirmed launch and reconciles only the interrupted CLI patch ledger", support, async (context) => {
  let preflight = true;
  let reads = 0;
  let replaceProject: (() => Promise<void>) | undefined;
  let release!: () => void;
  const holdReconciliation = new Promise<void>((resolve) => { release = resolve; });
  context.after(() => release());
  let patchRequests = 0;
  let streamClosed = false;
  let pendingStream = false;
  const gateway = new FakeGateway({
    cappedContinuation: { creditCap: 45, beforeUsage: async () => {
      if (++reads !== 2) return;
      if (preflight) await holdReconciliation;
      await replaceProject?.();
    } },
    script: () => ({ fault: "http", status: 429, code: "key_credit_cap_reached", releasedReceipt: true }),
  });
  const { root, scope, open } = await setup(context, gateway, async (request, response) => {
    assert.equal(request.headers.authorization, undefined);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body: CodexRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    patchRequests += 1;
    if (patchRequests === 1) {
      writeCodexResponse(response, model, 1, codexFixtureCall(flattenCodexTools(body.tools ?? []), 1, "update_plan", {
        explanation: JSON.stringify(fixtureWorkAnalysis), plan: [{ step: "Apply the fixture change", status: "in_progress" }],
      }));
    } else if (patchRequests === 2) {
      writeCodexResponse(response, model, 2, codexFixtureCall(flattenCodexTools(body.tools ?? []), 2, "desktop_apply_patch", {
        edits: [{ path: "applied.txt", action: "create", content: "The approved bytes.\n" }], explanation: "Apply the fixture change.",
      }));
    } else {
      assert.equal(patchRequests, 3);
      pendingStream = true;
      response.once("close", () => { streamClosed = true; });
      response.writeHead(200, { "content-type": "text/event-stream" }).flushHeaders();
    }
  });

  const earlyTitle = "Worker exits during API receipt reconciliation";
  const first = await open();
  await configure(first.page, "tomverse_api");
  await start(first.page, earlyTitle, "tomverse_api", "ask");
  await expect.poll(() => reads).toBe(2);
  const early = (await first.state()).task!;
  assert.ok(early.id);
  assert.equal(early.cliContinuation?.stage, "checking");
  const pending = readNativeCheckpoint(apiCliDirectory(scope.home, early.id), early.id, root, "openai");
  assert.ok(pending?.apiSource);
  assert.equal(pending.nativeSession, undefined);
  await stopWorker(first.app);
  release();
  await expect.poll(async () => (await first.state()).busy).toBe(false);
  assert.equal((await first.state()).task?.status, "unknown");
  assert.equal((await first.state()).task?.cliContinuation?.stage, "unavailable");
  assert.equal((await first.state()).task?.canCheckRecovery, false);

  const second = await open();
  await history(second.page, earlyTitle).click();
  const restored = (await second.state()).task;
  assert.equal(restored?.status, "unknown");
  assert.equal(restored?.cliContinuation?.segmentId, pending.apiSource.segmentId);
  assert.equal(await second.page.evaluate((id) => window.desktop.resume(id), early.id), false);
  assert.equal(gateway.completions.length, 1);
  assert.equal(patchRequests, 0);

  preflight = false;
  reads = 0;
  const originalRoot = root + "-original";
  replaceProject = async () => {
    await rename(root, originalRoot);
    await mkdir(root);
  };
  await start(second.page, "Pause when the project directory is replaced", "tomverse_api", "ask");
  await expect.poll(async () => (await second.state()).task?.cliContinuation?.stage).toBe("unavailable");
  assert.deepEqual(await readdir(root), []);
  assert.equal(patchRequests, 0);
  await rmdir(root);
  await rename(originalRoot, root);
  replaceProject = undefined;

  const lateTitle = "Worker exits after the approved Codex edit";
  const [approval] = await Promise.all([second.app.waitForEvent("window", { timeout: transitionTimeout }),
    start(second.page, lateTitle, "tomverse_api", "agent")]);
  await expect(approval.getByRole("heading", { name: "applied.txt · create" })).toBeVisible();
  await allowOnce(approval);
  await expect.poll(() => pendingStream).toBe(true);
  const late = (await second.state()).task!;
  assert.ok(late.id && late.nativeSession);
  const directory = apiCliDirectory(scope.home, late.id);
  await expect.poll(() => readNativeCheckpoint(directory, late.id!, root, "openai")?.changes?.[0]?.current).toBe("applied");
  await stopWorker(second.app);
  await expect.poll(async () => (await second.state()).busy).toBe(false);
  await expect.poll(() => streamClosed, { timeout: 20_000 }).toBe(true);
  assert.equal((await second.state()).task?.status, "unknown");

  // Model the durable record at the two write boundaries using the genuine approved patch.
  const editsHome = join(directory, "edits");
  const edits = Journal.open(editsHome, late.id);
  try {
    const applied = edits.state.changes[0];
    assert.ok(applied?.state === "applied");
    applied.state = "writing";
    edits.state.changes.push({ ...applied, changeId: "unwritten", path: "unwritten.txt", state: "writing" });
    assert.ok(edits.state.tools[0]);
    edits.state.tools[0].state = "started";
    edits.commit();
  } finally { edits.release(); }
  const apiDirectory = nativeSessionDirectory(scope.home, late.id);
  const apiBefore = Journal.read(apiDirectory);
  const third = await open();
  await history(third.page, lateTitle).click();
  await expect(third.page.getByRole("button", { name: "Check recovery" })).toBeVisible();
  const checked = await third.page.evaluate((id) => window.desktop.checkRecovery(id), late.id);
  assert.equal(checked.status, "checked");
  if (checked.status !== "checked") throw new Error(JSON.stringify(checked));
  assert.match(checked.notes.join("\n"), /A write of applied\.txt was under way: it is complete/);
  assert.match(checked.notes.join("\n"), /A write of unwritten\.txt was under way: it is not complete/);
  assert.match(checked.notes.join("\n"), /its outcome is unknown/);
  const recovered = (await third.state()).task!;
  assert.equal(recovered.status, "unknown");
  assert.equal(recovered.cliContinuation?.stage, "started");
  assert.deepEqual(recovered.changes.map(({ path, current }) => [path, current]), [["applied.txt", "applied"], ["unwritten.txt", "failed"]]);
  assert.equal(await readFile(join(root, "applied.txt"), "utf8"), "The approved bytes.\n");
  await assert.rejects(access(join(root, "unwritten.txt")), { code: "ENOENT" });
  assert.deepEqual(Journal.read(apiDirectory), apiBefore);
  assert.equal(await third.page.evaluate((id) => window.desktop.resume(id), late.id), false);
  assert.equal(gateway.completions.length, 3);
  assert.equal(patchRequests, 3);
});

test("Codex to API recovery preserves the quota checkpoint and does not replay an interrupted command", support, async (context) => {
  let preflight = true;
  let reachedCapCheck = false;
  let release!: () => void;
  const holdCapCheck = new Promise<void>((resolve) => { release = resolve; });
  context.after(() => release());
  let nativeRequests = 0;
  const gateway = new FakeGateway({
    cappedContinuation: { creditCap: 45, beforeUsage: async () => {
      if (preflight) { reachedCapCheck = true; await holdCapCheck; }
    } },
    script: (_, index) => {
      if (index === 0) return fixtureInitialWorkPlan;
      assert.equal(index, 1, "A recovery must not repeat a completion");
      return { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "invoke.mjs"] } }] };
    },
  });
  const { root, scope, fixture, open, openCompetingProfile } = await setup(context, gateway, async (request, response) => {
    for await (const chunk of request) assert.ok(chunk);
    nativeRequests += 1;
    response.writeHead(429, { "content-type": "application/json", "x-request-id": "req_fixture_limit" });
    response.end(JSON.stringify({ error: { type: "usage_limit_reached", code: "usage_limit_reached", message: "Synthetic limit" } }));
  });
  await writeFile(join(root, "invoke.mjs"), "import { appendFileSync } from 'node:fs';\nappendFileSync('invocations.txt', 'once\\n');\nsetTimeout(() => {}, 4500);\n");
  const earlyTitle = "Worker exits after the Codex quota checkpoint";
  const first = await open();
  await configure(first.page, "provider_cli");
  await start(first.page, earlyTitle, "provider_cli", "ask");
  await expect.poll(() => reachedCapCheck, { timeout: transitionTimeout }).toBe(true);
  const source = (await first.state()).task!;
  assert.ok(source.id && source.continuation?.stage === "checking");
  const nativeHome = nativeHistoryHome(scope.home, fixture, "openai");
  assert.equal(readNativeHistory(nativeHome, source.id, root, "openai")?.continuation?.segmentId, source.continuation.segmentId);
  await assert.rejects(access(nativeSessionDirectory(scope.home, source.id)), { code: "ENOENT" });
  const { app: competingApp, page: competitor } = await openCompetingProfile();
  try {
    await start(competitor, "Another profile cannot start on the reserved project", "tomverse_api", "ask");
    await expect.poll(() => competitor.evaluate(async () => {
      const { task } = await window.desktop.state();
      return task?.entries.some((entry) => entry.role === "event" && entry.notice === "workspaceBusy");
    })).toBe(true);
    await expect(competitor.getByRole("list", { name: "Task conversation" }).locator("summary")
      .filter({ hasText: "Another Code operation is using this project. Try again when it finishes." })).toBeVisible();
    assert.equal(gateway.completions.length, 0);
    assert.equal(nativeRequests, 1);
  } finally { await competingApp.close(); }
  await stopWorker(first.app);
  release();
  await expect.poll(async () => (await first.state()).busy).toBe(false);
  assert.equal((await first.state()).task?.status, "blocked");
  assert.equal((await first.state()).task?.continuation?.stage, "unavailable");

  const second = await open();
  await history(second.page, earlyTitle).click();
  assert.equal((await second.state()).task?.continuation?.segmentId, source.continuation.segmentId);
  assert.equal(gateway.completions.length, 0);
  assert.equal(nativeRequests, 1);

  preflight = false;
  const lateTitle = "Worker exits during the continued API command";
  const [approval] = await Promise.all([second.app.waitForEvent("window", { timeout: transitionTimeout }),
    start(second.page, lateTitle, "provider_cli", "agent")]);
  await expect(approval.getByRole("heading", { name: "Exact command" })).toBeVisible();
  await allowOnce(approval);
  const invocationFile = join(root, "invocations.txt");
  await expect.poll(() => readFile(invocationFile, "utf8").catch(() => "")).toBe("once\n");
  const late = (await second.state()).task!;
  assert.ok(late.id && late.continuation?.stage === "started");
  await stopWorker(second.app);
  await expect.poll(async () => (await second.state()).busy).toBe(false);
  assert.equal((await second.state()).task?.status, "unknown");

  const third = await open();
  await history(third.page, lateTitle).click();
  assert.equal((await third.state()).task?.continuation?.segmentId, late.continuation.segmentId);
  assert.equal((await third.state()).task?.status, "unknown");
  const competing = Journal.open(scope.home, late.id);
  try {
    const requestCount = gateway.requests.length;
    assert.equal((await third.page.evaluate((id) => window.desktop.checkRecovery(id), late.id)).status, "locked");
    assert.equal(gateway.requests.length, requestCount);
  } finally { competing.release(); }
  const recovery = await third.page.evaluate((id) => window.desktop.checkRecovery(id), late.id);
  if (recovery.status !== "checked") throw new Error(JSON.stringify(recovery));
  assert.match(recovery.notes.join("\n"), /run_command .*outcome is unknown/);
  assert.equal((await third.state()).task?.status, "unknown");
  assert.equal(await third.page.evaluate((id) => window.desktop.resume(id), late.id), false);
  assert.equal(await readFile(invocationFile, "utf8"), "once\n");
  assert.equal(gateway.completions.length, 2);
  assert.equal(nativeRequests, 2);
});
