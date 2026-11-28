import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { initializeAcp, isolatedCliEnvironment, readCliFrames, unpackCliArchive, vibeProbeSettings, type Frame } from "../src/host/cli-protocol";
import { nativePatchName, nativePatches, verifiedContinuationEdits } from "../src/host/native-patches";
import { bindProjectRoot } from "../src/host/project-root";
import { spawnNativeFixture } from "../src/host/spawn-native-fixture";
import { startNativeMcpServer, vibePatchFunction } from "../src/host/native-mcp-server";

const archive = process.env.TOMVERSE_DESKTOP_VIBE_TASK_ARCHIVE;

test("Official Vibe hands file proposals to Desktop for fresh approval", {
  skip: archive ? false : "Requires the pinned official Mistral Vibe archive",
  timeout: 240_000,
}, async ({ signal }) => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "tomverse-vibe-edit-")));
  const project = join(scratch, "project");
  const profile = join(scratch, "profile");
  const records = join(scratch, "records");
  const model = "vibe-desktop-fixture";
  const version = "3.1.4";
  const source = join(project, "sample.txt");
  const marker = "This is the scoped project input.";
  const userContent = "The user created this file after preview.";
  const modelContent = "The approved edit came through Desktop.";
  const approvedFile = "approved.txt";
  const staleFile = "changed-during-preview.txt";
  const deniedFile = "denied.txt";
  const approvals: string[] = [];
  const proposals = [deniedFile, staleFile, approvedFile].map((path) => ({
    edits: [{ path, action: "create", content: modelContent }],
  }));
  let modelCalls = 0;
  let endpointError: unknown;
  const endpoint = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      const parts = [];
      for await (const part of request) parts.push(part);
      const raw = Buffer.concat(parts).toString("utf8");
      const body = JSON.parse(raw);
      assert.equal(body.model, model);
      const turn = ++modelCalls;
      const previousResult = body.messages.filter(({ role }: { role: string }) => role === "tool").at(-1)?.content;
      if (turn === 2) assert.ok(raw.includes(marker));
      if (turn === 3) assert.match(previousResult, /No approved Desktop file edit was applied/);
      if (turn === 4) assert.match(previousResult, /changed after the preview/);
      if (turn === 5) assert.match(previousResult, /approved Desktop patch was verified/);
      assert.ok(turn <= 5);
      const proposal = proposals[turn - 2];
      const tool = turn === 1 ? { name: "read_file", input: { path: source } } : proposal && {
        name: "run_typescript",
        input: { code: "async function main() { return await tools." + vibePatchFunction + "(" + JSON.stringify(proposal) + "); }" },
      };
      const chunk = { id: "patch-fixture-" + turn, object: "chat.completion.chunk", created: 1, model };
      const send = (delta: object, reason: string | null = null) =>
        response.write("data: " + JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: reason }] }) + "\n\n");
      response.writeHead(200, { "content-type": "text/event-stream" });
      send({ role: "assistant" });
      send(tool ? { tool_calls: [{ index: 0, id: "call_" + turn, type: "function",
        function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] } : { content: "The approved edit is recorded." });
      send({}, tool ? "tool_calls" : "stop");
      response.write("data: " + JSON.stringify({ ...chunk, choices: [], usage: { prompt_tokens: 21, completion_tokens: 4, total_tokens: 25 } }) + "\n\n");
      response.end("data: [DONE]\n\n");
    } catch (error) {
      endpointError = error;
      response.writeHead(400).end();
    }
  });
  endpoint.on("connect", (_request, socket) => socket.destroy());

  let child: ReturnType<typeof spawnNativeFixture> | undefined;
  let closed: Promise<[number | null, NodeJS.Signals | null]> | undefined;
  let server: Awaited<ReturnType<typeof startNativeMcpServer>> | undefined;
  let patches: ReturnType<typeof nativePatches> | undefined;
  const abort = () => { child?.kill(); };
  try {
    await Promise.all([mkdir(project), mkdir(profile), mkdir(records)]);
    await writeFile(source, marker + "\n");
    patches = nativePatches({
      directory: records, id: "s-20261124-013500-a0b0c0", project: bindProjectRoot(project), model, protectedRoots: [],
      connectionKey: "only-local-vibe-fixture", signal,
      approve: async (view) => {
        assert.ok(view.patch);
        assert.equal(view.patch.length, 1);
        const [file] = view.patch;
        assert.equal(file!.afterText, modelContent);
        approvals.push(file!.path);
        if (file!.path === deniedFile) return false;
        if (file!.path === staleFile) {
          await writeFile(join(project, staleFile), userContent, { flag: "wx" });
          return true;
        }
        assert.equal(file!.path, approvedFile);
        return true;
      },
    });
    let sessionId: string | undefined;
    let readId: string | undefined;
    let readComplete = false;
    let pending: { id: string; input: unknown } | undefined;
    const proposalEvents = new EventTarget();
    server = await startNativeMcpServer({ patch: patches.tool }, signal, async (_args, requestSignal) => {
      if (!pending) await once(proposalEvents, "proposal", { signal: AbortSignal.any([requestSignal, AbortSignal.timeout(5_000)]) });
      const proposal = pending;
      return proposal && { ...proposal, canApply: () => readComplete && pending === proposal };
    });
    assert.equal((await fetch(server.descriptor.url, { method: "POST" })).status, 404);
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    const origin = "http://127.0.0.1:" + address.port;
    const config = vibeProbeSettings + [
      'enabled_tools = ["read_file", "desktop_' + nativePatchName + '"]',
      'active_model = "' + model + '"', 'allowed_models = ["' + model + '"]',
      "[[providers]]", 'name = "local"', 'api_base = "' + origin + '/v1"', 'api_key_env_var = ""', 'backend = "generic"',
      "[[models]]", 'name = "' + model + '"', 'alias = "' + model + '"', 'provider = "local"',
      "input_price = 0", "output_price = 0", "[tools.desktop_" + nativePatchName + "]", 'permission = "always"',
      "[session_logging]", "generate_titles = false", "",
    ].join("\n");
    await writeFile(join(profile, "config.toml"), config);
    const distribution = await unpackCliArchive("mistral", archive!, profile, version, signal);
    const agent = spawnNativeFixture(join(distribution, process.platform === "win32" ? "vibe-acp.exe" : "vibe-acp"), [], {
      cwd: project,
      env: {
        ...isolatedCliEnvironment(process.env, profile), VIBE_HOME: profile, PYTHONNOUSERSITE: "1",
        HTTP_PROXY: origin, HTTPS_PROXY: origin, ALL_PROXY: origin, NO_PROXY: "127.0.0.1",
      },
    });
    child = agent;
    closed = new Promise((resolve, reject) => {
      agent.once("close", (code, closeSignal) => resolve([code, closeSignal]));
      agent.once("error", reject);
    });
    agent.stdin.on("error", () => {});
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const incoming = readCliFrames(agent.stdout, 1024 * 1024);
    const send = (frame: Frame) => agent.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
    const effect = z.object({ toolCallId: z.string(), status: z.string().optional(), rawInput: z.unknown().optional(),
      _meta: z.object({ tool_name: z.string() }) });
    const read = async (match: (frame: Frame) => boolean) => {
      for (;;) {
        const next = await incoming.next();
        if (next.done) throw new Error("Vibe closed before the expected ACP response.");
        const frame = next.value;
        assert.equal(frame.jsonrpc, "2.0");
        if (match(frame)) return frame;
        if (frame.method === "session/request_permission") {
          send({ id: frame.id, result: { outcome: { outcome: "cancelled" } } });
          throw new Error("Vibe requested a native permission during the Desktop patch test.");
        }
        assert.equal(frame.method, "session/update");
        const update = z.object({ sessionId: z.guid(), update: z.record(z.string(), z.unknown()) }).parse(frame.params);
        sessionId ??= update.sessionId;
        assert.equal(update.sessionId, sessionId);
        if (update.update.sessionUpdate !== "tool_call" && update.update.sessionUpdate !== "tool_call_update") continue;
        const tool = effect.safeParse(update.update);
        if (!tool.success) continue;
        const { toolCallId, status, rawInput, _meta: { tool_name } } = tool.data;
        if (tool_name === "read_file") {
          if (status === "in_progress" && z.object({ filePath: z.literal(source) }).safeParse(rawInput).success) readId = toolCallId;
          if (toolCallId === readId && status === "completed") readComplete = true;
        } else if (tool_name === vibePatchFunction) {
          if (status === "in_progress" && update.update.sessionUpdate === "tool_call") {
            assert.equal(pending, undefined);
            pending = { id: toolCallId, input: rawInput };
            proposalEvents.dispatchEvent(new Event("proposal"));
          } else if ((status === "completed" || status === "failed") && pending?.id === toolCallId) {
            pending = undefined;
          }
        }
      }
    };
    await initializeAcp({ send, read }, "mistral", { client: "0.1.57", executable: version });
    send({ id: 2, method: "session/new", params: { cwd: project, mcpServers: [server.descriptor] } });
    const session = z.object({ sessionId: z.guid(), modes: z.object({ currentModeId: z.literal("ask") }),
      configOptions: z.array(z.object({ id: z.string(), currentValue: z.unknown() })),
    }).parse((await read((frame) => frame.id === 2)).result);
    sessionId ??= session.sessionId;
    assert.equal(sessionId, session.sessionId);
    assert.equal(session.configOptions.find(({ id }) => id === "model")?.currentValue, model);
    send({ id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "Inspect the project file and submit each edit through Desktop." }] } });
    const outcome = await read(({ id }) => id === 3);
    assert.ifError(endpointError);
    assert.equal(z.object({ stopReason: z.string() }).parse(outcome.result).stopReason, "end_turn");
    assert.equal(modelCalls, 5);
    assert.deepEqual(approvals, [deniedFile, staleFile, approvedFile]);
    await assert.rejects(readFile(join(project, deniedFile)), { code: "ENOENT" });
    assert.equal(await readFile(join(project, staleFile), "utf8"), userContent);
    assert.equal(await readFile(join(project, approvedFile), "utf8"), modelContent);
    assert.equal(patches.journal.state.approvals.length, 1);
    assert.deepEqual(verifiedContinuationEdits(patches.journal), [{ path: approvedFile, action: "create" }]);
    send({ id: 4, method: "session/close", params: { sessionId } });
    assert.equal((await read(({ id }) => id === 4)).error, undefined);
    agent.stdout.resume();
    agent.stdin.end();
    assert.deepEqual(await closed, [0, null]);
  } finally {
    signal.removeEventListener("abort", abort);
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill();
      await closed?.catch(() => undefined);
    }
    await server?.close();
    patches?.journal.release();
    endpoint.closeAllConnections();
    if (endpoint.listening) await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    if (process.platform !== "win32") {
      const logs = join(profile, "logs");
      await mkdir(logs, { recursive: true });
      const entries = await readdir(logs, { recursive: true, withFileTypes: true });
      await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => chmod(join(entry.parentPath, entry.name), 0o700)));
    }
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
