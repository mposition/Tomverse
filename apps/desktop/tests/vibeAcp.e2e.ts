import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { initializeAcp, isolatedCliEnvironment, readCliFrames, unpackCliArchive, vibeProbeSettings, type Frame } from "../src/host/cli-protocol";
import { spawnNativeFixture } from "../src/host/spawn-native-fixture";

const archive = process.env.TOMVERSE_DESKTOP_VIBE_TASK_ARCHIVE;

test("Mistral Vibe keeps Ask permissions across cancellation and session reload", {
  skip: archive ? false : "Requires the pinned official Mistral Vibe archive",
  timeout: 240_000,
}, async ({ signal }) => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "tomverse-vibe-ask-")));
  const project = join(scratch, "project");
  const profile = join(scratch, "profile");
  const source = join(project, "sample.txt");
  const outside = join(scratch, "outside.txt");
  const destination = join(project, "not-approved.txt");
  const marker = "Mistral Vibe read this fixture.";
  const outsideMarker = "The sibling file is outside the selected project.";
  const proposedContent = "An unapproved fixture edit.";
  const answer = "The local fixture check finished.";
  const updatedMarker = "The local fixture file was updated after stopping.";
  const resumedAnswer = "The resumed session read the updated file.";
  let markModelWaiting!: () => void;
  let markCancelledConnection!: () => void;
  const modelWaiting = new Promise<void>((resolve) => { markModelWaiting = resolve; });
  const cancelledConnection = new Promise<void>((resolve) => { markCancelledConnection = resolve; });
  const model = "vibe-desktop-fixture";
  const version = "3.1.4";
  const operations = [
    { name: "read_file", input: { path: source } },
    { name: "read_file", input: { path: outside } },
    { name: "write_file", input: { path: destination, content: proposedContent } },
  ];
  let modelCalls = 0;
  let rejectedConnections = 0;
  let endpointError: unknown;
  const endpoint = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        rejectedConnections++;
        response.writeHead(404).end();
        return;
      }
      const parts = [];
      for await (const part of request) parts.push(part);
      const bodyText = Buffer.concat(parts).toString("utf8");
      assert.ok(!bodyText.includes(outsideMarker));
      const body = JSON.parse(bodyText);
      assert.equal(body.model, model);
      assert.equal(body.stream_options?.include_usage, true);
      const tools = body.tools.map((tool: { function: { name: string } }) => tool.function.name);
      assert.ok(tools.includes("read_file"));
      const additionalTools = ["wait", "cron", "get_goal", "create_goal", "update_goal", "unified_harness_scratchpad"];
      assert.ok(!tools.some((name: string) => additionalTools.includes(name)), `Unexpected Vibe tools: ${tools.join(", ")}`);
      const recentTool = body.messages.filter(({ role }: { role: string }) => role === "tool").at(-1);
      const turn = ++modelCalls;
      if (turn === 2) assert.match(recentTool?.content, /Mistral Vibe read this fixture/);
      if (turn === 3) assert.match(recentTool?.content, /denied|outside/i);
      if (turn === 4 || turn === 8) assert.match(recentTool?.content, /Tool execution denied by approval callback/i);
      if (turn === 5) {
        response.once("close", markCancelledConnection);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": wait for the ACP cancellation\n\n");
        markModelWaiting();
        return;
      }
      if (turn === 6) assert.ok(bodyText.includes(answer), "The loaded session should include the completed reply.");
      if (turn === 7) assert.match(recentTool?.content, /The local fixture file was updated after stopping/);
      assert.ok(turn <= 8);
      const tool = turn === 6 ? operations[0] : turn === 7 ? operations[2] : operations[turn - 1];
      const chunk = { id: "fixture-" + turn, object: "chat.completion.chunk", created: 1, model };
      const send = (delta: object, reason: string | null = null) =>
        response.write("data: " + JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: reason }] }) + "\n\n");
      response.writeHead(200, { "content-type": "text/event-stream" });
      send({ role: "assistant" });
      send(tool ? { tool_calls: [{ index: 0, id: "call_" + turn, type: "function",
        function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] } : { content: turn === 8 ? resumedAnswer : answer });
      send({}, tool ? "tool_calls" : "stop");
      response.write("data: " + JSON.stringify({ ...chunk, choices: [], usage: { prompt_tokens: 21, completion_tokens: 4, total_tokens: 25 } }) + "\n\n");
      response.end("data: [DONE]\n\n");
    } catch (error) {
      endpointError = error;
      response.writeHead(400).end();
    }
  });
  endpoint.on("connect", (_request, socket) => { rejectedConnections++; socket.destroy(); });
  let child: ReturnType<typeof spawnNativeFixture> | undefined;
  let closed: Promise<[number | null, NodeJS.Signals | null]> | undefined;
  const abort = () => { child?.kill(); };
  try {
    await Promise.all([mkdir(project), mkdir(profile)]);
    await Promise.all([writeFile(source, marker + "\n"), writeFile(outside, outsideMarker + "\n")]);
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    const origin = "http://127.0.0.1:" + address.port;
    const config = vibeProbeSettings + [
      'enabled_tools = ["read_file", "write_file"]',
      'active_model = "' + model + '"', 'allowed_models = ["' + model + '"]',
      "[[providers]]", 'name = "local"', 'api_base = "' + origin + '/v1"', 'api_key_env_var = ""', 'backend = "generic"',
      "[[models]]", 'name = "' + model + '"', 'alias = "' + model + '"', 'provider = "local"',
      "input_price = 0", "output_price = 0", "[tools.write_file]", 'permission = "ask"',
      "[session_logging]", "generate_titles = false", "",
    ].join("\n");
    await writeFile(join(profile, "config.toml"), config);
    const distribution = await unpackCliArchive("mistral", archive!, profile, version, signal);
    signal.addEventListener("abort", abort, { once: true });
    const send = (frame: Frame) => child!.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
    let sessionId: string | undefined;
    let responseText = "";
    let proposedEditId: string | undefined;
    const rejectedEdits = new Set<string>();
    let incoming: ReturnType<typeof readCliFrames>;
    const read = async (match: (frame: Frame) => boolean) => {
      for (;;) {
        const next = await incoming.next();
        if (next.done) throw new Error("Vibe closed before the expected ACP response.");
        const frame = next.value;
        assert.equal(frame.jsonrpc, "2.0");
        if (match(frame)) return frame;
        if (frame.method === "session/request_permission") {
          const permission = z.object({ sessionId: z.guid(), toolCall: z.object({ toolCallId: z.string() }),
            options: z.array(z.object({ kind: z.string(), optionId: z.string() })) }).parse(frame.params);
          assert.equal(permission.sessionId, sessionId);
          assert.ok(proposedEditId);
          assert.equal(permission.toolCall.toolCallId, proposedEditId);
          assert.ok(!rejectedEdits.has(proposedEditId));
          const denial = permission.options.filter(({ kind }) => kind === "reject_once");
          assert.equal(denial.length, 1);
          rejectedEdits.add(proposedEditId);
          proposedEditId = undefined;
          send({ id: frame.id, result: { outcome: { outcome: "selected", optionId: denial[0]!.optionId } } });
          continue;
        }
        assert.equal(frame.method, "session/update");
        assert.ok(!Object.hasOwn(frame, "id"));
        const update = z.object({ sessionId: z.guid(), update: z.record(z.string(), z.unknown()) }).parse(frame.params);
        sessionId ??= update.sessionId;
        assert.equal(update.sessionId, sessionId);
        if (update.update.sessionUpdate === "agent_message_chunk") {
          responseText += z.object({ type: z.literal("text"), text: z.string() }).parse(update.update.content).text;
        }
        if (update.update.sessionUpdate === "tool_call" && update.update.kind === "edit" && update.update.status === "in_progress") {
          const proposal = z.object({ toolCallId: z.string(), rawInput: z.object({ filePath: z.literal(destination), content: z.literal(proposedContent) }),
            content: z.tuple([z.object({ type: z.literal("diff"), path: z.literal(destination), newText: z.literal(proposedContent) })]),
          }).parse(update.update);
          assert.equal(proposedEditId, undefined);
          proposedEditId = proposal.toolCallId;
        }
      }
    };
    const launch = async () => {
      signal.throwIfAborted();
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
      if (signal.aborted) abort();
      incoming = readCliFrames(agent.stdout, 1024 * 1024);
      await initializeAcp({ send, read }, "mistral", { client: "0.1.57", executable: version });
    };
    const close = async (id: number) => {
      send({ id, method: "session/close", params: { sessionId } });
      assert.equal((await read((frame) => frame.id === id)).error, undefined);
      child!.stdout.resume();
      child!.stdin.end();
      assert.deepEqual(await closed, [0, null]);
    };
    const askSession = z.object({
      modes: z.object({ currentModeId: z.literal("ask"), availableModes: z.tuple([z.object({ id: z.literal("ask") })]) }),
      configOptions: z.array(z.object({ id: z.string(), currentValue: z.unknown() })),
    });
    await launch();
    send({ id: 2, method: "session/new", params: { cwd: project, mcpServers: [] } });
    const session = askSession.extend({ sessionId: z.guid() }).parse((await read(({ id }) => id === 2)).result);
    sessionId ??= session.sessionId;
    assert.equal(sessionId, session.sessionId);
    assert.equal(session.configOptions.find(({ id }) => id === "model")?.currentValue, model);
    send({ id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "Read the local sample without editing." }] } });
    const turn = await read(({ id }) => id === 3);
    assert.ifError(endpointError);
    assert.deepEqual(z.object({ stopReason: z.literal("end_turn") }).parse(turn.result), { stopReason: "end_turn" });
    assert.equal(responseText, answer);
    assert.equal(modelCalls, 4);
    assert.equal(rejectedEdits.size, 1);
    assert.equal(await readFile(source, "utf8"), marker + "\n");
    await assert.rejects(readFile(destination), { code: "ENOENT" });

    send({ id: 4, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "Wait for a response." }] } });
    const interrupted = read(({ id }) => id === 4);
    await Promise.race([
      modelWaiting,
      interrupted.then(() => { throw endpointError ?? new Error("Vibe completed before a model request could be cancelled."); }),
    ]);
    send({ method: "session/cancel", params: { sessionId } });
    assert.equal(z.object({ stopReason: z.string() }).parse((await interrupted).result).stopReason, "cancelled");
    await Promise.race([
      cancelledConnection,
      delay(10_000, undefined, { signal, ref: false }).then(() => { throw new Error("Vibe left the cancelled model connection open."); }),
    ]);
    await close(5);

    await writeFile(source, updatedMarker + "\n");
    responseText = "";
    await launch();
    send({ id: 2, method: "session/load", params: { sessionId, cwd: project, mcpServers: [] } });
    const restored = askSession.parse((await read(({ id }) => id === 2)).result);
    assert.equal(restored.configOptions.find(({ id }) => id === "model")?.currentValue, model);
    assert.ok(responseText.includes(answer), "The saved session should replay its completed answer.");
    responseText = "";
    send({ id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "Read the updated sample file." }] } });
    const resumed = await read(({ id }) => id === 3);
    assert.ifError(endpointError);
    assert.equal(z.object({ stopReason: z.string() }).parse(resumed.result).stopReason, "end_turn");
    assert.equal(responseText, resumedAnswer);
    assert.equal(modelCalls, 8);
    assert.equal(rejectedEdits.size, 2);
    assert.equal(rejectedConnections, 0);
    assert.equal(await readFile(source, "utf8"), updatedMarker + "\n");
    await assert.rejects(readFile(destination), { code: "ENOENT" });
    await close(4);
  } finally {
    signal.removeEventListener("abort", abort);
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill();
      await closed?.catch(() => undefined);
    }
    endpoint.closeAllConnections();
    if (endpoint.listening) await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    if (process.platform !== "win32") {
      // Vibe stores immutable plugin snapshots inside the disposable session logs.
      const logs = join(profile, "logs");
      await mkdir(logs, { recursive: true });
      const entries = await readdir(logs, { recursive: true, withFileTypes: true });
      await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => chmod(join(entry.parentPath, entry.name), 0o700)));
    }
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
