import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { inspectCodexFixtureHistory, runCodexFixture } from "../src/host/codex-fixture-run";
import { codexFixtureProvider, observeCodexFixtureTurn, type CodexTurnObservation } from "../src/host/codex-turn";
import { bindProjectRoot } from "../src/host/project-root";
import { codexFixtureAnswer, codexFixtureCall, flattenCodexTools, writeCodexResponse, type CodexRequest } from "./codex-response-fixture";

const model = "gpt-5.4";
const marker = "Tomverse offline marker\n";
const readTitle = "Read the fixture marker";
const safeguardTitle = "Check the read-only boundary";
const reportTitle = "Describe keyboard behavior";
const answer = "Read-only fixture complete.";
const sleepDuration = "79";
const savedPrompt = "Inspect the saved fixture marker.";
const resumePrompt = "Continue the saved fixture with a summary.";
assert.equal(process.platform, "linux");
assert.equal(process.getuid?.(), 65534);
const interfaces = (await readFile("/proc/net/dev", "utf8")).trim().split("\n").slice(2).map((line) => line.split(":")[0]?.trim());
assert.deepEqual(interfaces, ["lo"]);
const profileRoot = await mkdtemp(join(tmpdir(), "tomverse-codex-turn-"));
const root = join(profileRoot, "workspace");
const home = join(profileRoot, "codex-home");
const toolTemp = join(profileRoot, "tool-temp");
await Promise.all([mkdir(root), mkdir(home), mkdir(toolTemp)]);
await writeFile(join(root, "marker.txt"), marker);

const latestToolOutput = ({ input }: CodexRequest) => String(input?.findLast(({ type }) => type === "function_call_output")?.output ?? "");
async function runningFixtureCommand() {
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const argv = await readFile(join("/proc", entry, "cmdline"), "utf8").catch(() => "");
    if (/^(?:\/[^\0]+\/)?sleep\0/.test(argv) && argv.endsWith(`\0${sleepDuration}\0`)) return Number(entry);
  }
}

const requests: Array<{ model?: string; tools: string[] }> = [];
let fixtureError: unknown;
let savedRequest: (() => void) | undefined;
const savedRequestStarted = new Promise<void>((resolve) => { savedRequest = resolve; });
const endpoint = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/responses");
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      assert.ok(length <= 512_000);
      chunks.push(chunk);
    }
    const body: CodexRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const tools = flattenCodexTools(body.tools ?? []);
    const index = requests.push({ model: body.model, tools: tools.map(({ name }) => name) });
    assert.equal(body.model, model);
    const call = (name: string, args: object) => codexFixtureCall(tools, index, name, args);
    const reply = (item: ReturnType<typeof call>) => writeCodexResponse(response, model, index, item);
    const plan = (readStatus: string, safeguardStatus: string, reportStatus: string) => call("update_plan", { plan: [
      { step: readTitle, status: readStatus }, { step: safeguardTitle, status: safeguardStatus }, { step: reportTitle, status: reportStatus },
    ] });
    if (index === 1) reply(plan("in_progress", "pending", "pending"));
    else if (index === 2) reply(call("exec_command", { cmd: "cat marker.txt", workdir: root }));
    else if (index === 3) {
      const observed = latestToolOutput(body);
      assert.ok(observed.includes(marker.trim()), `The native read did not return the marker: ${observed.slice(-700)}`);
      reply(plan("completed", "in_progress", "pending"));
    } else if (index === 4) reply(call("exec_command", { cmd: "touch blocked.txt", workdir: root }));
    else if (index === 5) {
      const observed = latestToolOutput(body);
      assert.ok(/blocked\.txt.*(?:Read-only file system|Permission denied)/.test(observed),
        `The file operation did not report a read-only failure: ${observed.slice(-700)}`);
      reply(plan("completed", "completed", "completed"));
    }
    else if (index === 6) reply(codexFixtureAnswer(index, answer));
    else if (index === 7) reply(call("update_plan", { plan: [{ step: "Observe the active fixture command", status: "in_progress" }] }));
    else if (index === 8) reply(call("exec_command", { cmd: `sleep ${sleepDuration}`, workdir: root, yield_time_ms: 60_000 }));
    else if (index === 9) {
      assert.ok(JSON.stringify(body.input).includes(savedPrompt));
      reply(call("update_plan", { plan: [{ step: "Inspect saved fixture marker", status: "in_progress" }] }));
    } else if (index === 10) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": waiting for the saved turn to stop\n\n");
      savedRequest?.();
    } else if (index === 11) {
      const prompts = JSON.stringify(body.input);
      assert.equal(prompts.split(savedPrompt).length - 1, 1);
      assert.equal(prompts.split(resumePrompt).length - 1, 1);
      reply(codexFixtureAnswer(index, "The restored fixture turn completed."));
    }
    else assert.fail("The stopped turn must not request another response");
  } catch (error) {
    fixtureError = error;
    response.writeHead(400).end("Unexpected local fixture protocol");
  }
});

try {
  endpoint.listen(0, "127.0.0.1");
  await once(endpoint, "listening");
  const address = endpoint.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(join(home, "config.toml"), [
    `model = "${model}"`, `model_provider = "${codexFixtureProvider}"`,
    `[model_providers.${codexFixtureProvider}]`, 'name = "Tomverse loopback fixture"',
    `base_url = "http://127.0.0.1:${address.port}/v1"`, 'wire_api = "responses"',
    "requires_openai_auth = false", "request_max_retries = 0", "stream_max_retries = 0", "supports_websockets = false",
    "[tools.update_plan]", "enabled = true",
  ].join("\n"));
  const binary = process.argv[2];
  assert.ok(binary);
  const timeout = AbortSignal.timeout(70_000);
  const child = spawn(binary, ["app-server", "--listen", "stdio://", "--disable", "remote_control"], {
    cwd: root, env: { HOME: home, CODEX_HOME: home, PATH: "/usr/bin:/bin", TMPDIR: toolTemp },
    stdio: ["pipe", "pipe", "inherit"], signal: timeout, killSignal: "SIGKILL",
  });
  child.on("error", () => undefined);
  child.stdin.on("error", () => undefined);
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  const events: CodexTurnObservation[] = [];
  try {
    const result = await observeCodexFixtureTurn(child, { profile: home, root, version: "0.1.0", model,
      prompt: "Inspect the fixture and publish a short plan.", signal: timeout }, (observation) => events.push(observation));
    if (fixtureError) throw fixtureError;
    assert.equal(result.status, "completed");
    assert.deepEqual(result.rows.map(({ title, state }) => [title, state]), [
      [readTitle, "completed"], [safeguardTitle, "unverified"], [reportTitle, "unverified"],
    ]);
    assert.deepEqual(result.rows[0]?.assignment, result.session);
    assert.equal(result.rows[1]?.evidence.at(-1)?.result, "failed");
    assert.deepEqual(result.messages, [{ role: "assistant", text: answer }]);
    assert.equal(requests.length, 6);
    assert.equal(await readFile(join(root, "marker.txt"), "utf8"), marker);
    await assert.rejects(readFile(join(root, "blocked.txt")), { code: "ENOENT" });
    child.stdin.end();
    assert.equal(await closed, 0);
    process.stdout.write(`TOMVERSE_CODEX_TURN_PASS ${JSON.stringify({ observations: events.length, requests: requests.length, readOnlyWriteBlocked: true, result })}\n`);
  } catch (error) {
    process.stderr.write(`TOMVERSE_CODEX_TURN_FAILURE ${JSON.stringify({ requests, last: events.at(-1), fixtureError: String(fixtureError ?? "") })}\n`);
    child.kill("SIGKILL");
    await closed;
    throw error;
  }

  const stop = new AbortController();
  const stopEvents: CodexTurnObservation[] = [];
  const fixture = { executable: binary, version: "0.171.0-alpha.13", model, origin: `http://127.0.0.1:${address.port}` };
  const stopHome = join(profileRoot, "stopped-codex-home");
  const project = bindProjectRoot(root);
  const stopped = runCodexFixture(fixture,
    { project, prompt: "Observe and stop the temporary fixture command.", mode: "ask",
      clientVersion: "0.1.0", signal: stop.signal, history: { home: stopHome } }, (observation) => stopEvents.push(observation), () => undefined);
  try {
    let activePid: number | undefined;
    const deadline = Date.now() + 45_000;
    while (!fixtureError && Date.now() < deadline) {
      activePid = await runningFixtureCommand();
      if (activePid && stopEvents.some(({ rows }) => rows.some(({ evidence }) => evidence.some(({ result }) => result === "running")))) break;
      await delay(50);
    }
    if (fixtureError) throw fixtureError;
    assert.ok(activePid && Date.now() < deadline, "The native Codex fixture command never started");
    stop.abort();
    const status = await stopped;
    assert.equal(await runningFixtureCommand(), undefined, `The fixture command ${activePid} survived Stop`);
    assert.equal(requests.length, 8);
    assert.equal(fixtureError, undefined);
    const terminal = stopEvents.at(-1);
    assert.equal(terminal?.status, "interrupted");
    assert.equal(terminal.rows[0]?.state, "cancelled");
    assert.equal(status, terminal.hasUnconfirmedCommand ? "unknown" : "stopped");
    process.stdout.write(`TOMVERSE_CODEX_STOP_PASS ${JSON.stringify({ activePid, status, terminal, requests: requests.length })}\n`);
    const recovery = await inspectCodexFixtureHistory(fixture, {
      project, clientVersion: "0.1.0", home: stopHome, session: terminal.session, signal: AbortSignal.timeout(60_000),
    });
    assert.ok(recovery, "The recorded Codex turn could not be inspected");
    assert.equal(recovery.status, "interrupted");
    const command = terminal.rows[0]?.evidence[0];
    assert.ok(command);
    assert.equal(recovery.commands.get(command.id), "failed");
    assert.equal(requests.length, 8);
    process.stdout.write(`TOMVERSE_CODEX_RECOVERY_PASS ${JSON.stringify({ status: recovery.status, commands: [...recovery.commands], requests: requests.length })}\n`);
  } catch (error) {
    process.stderr.write(`TOMVERSE_CODEX_STOP_FAILURE ${JSON.stringify({ last: stopEvents.at(-1), observations: stopEvents.length, requests, fixtureError: String(fixtureError ?? "") })}\n`);
    throw error;
  } finally {
    stop.abort();
    await stopped;
  }

  const historyHome = join(profileRoot, "saved-codex-home");
  const saveStop = new AbortController();
  const base = { project, mode: "ask" as const, clientVersion: "0.1.0" };
  let savedTurn: CodexTurnObservation | undefined;
  const saving = runCodexFixture(fixture, { ...base, prompt: savedPrompt, signal: saveStop.signal, history: { home: historyHome } },
    (observation) => { savedTurn = observation; }, () => undefined);
  assert.equal(await Promise.race([savedRequestStarted.then(() => "active"), saving]), "active");
  saveStop.abort();
  assert.equal(await saving, "stopped");
  assert.equal(savedTurn?.status, "interrupted");
  assert.equal(requests.length, 10);
  const previous = { ...savedTurn.session, status: "interrupted" as const };
  let resumedTurn: CodexTurnObservation | undefined;
  const resumed = await runCodexFixture(fixture, { ...base, prompt: resumePrompt, signal: AbortSignal.timeout(50_000),
    history: { home: historyHome, previous } }, (observation) => { resumedTurn = observation; }, () => undefined);
  if (fixtureError) throw fixtureError;
  assert.equal(resumed, "completed");
  assert.equal(resumedTurn?.session.threadId, previous.threadId);
  assert.notEqual(resumedTurn.session.turnId, previous.turnId);
  assert.deepEqual(resumedTurn.messages, [{ role: "assistant", text: "The restored fixture turn completed." }]);
  assert.equal(requests.length, 11);
  process.stdout.write(`TOMVERSE_CODEX_RESUME_PASS ${JSON.stringify({ requests: requests.length, previous, resumed: resumedTurn.session })}\n`);
} finally {
  endpoint.closeAllConnections();
  await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  await rm(profileRoot, { recursive: true, force: true });
}
