import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type { CliProtocolProvider } from "../src/code-execution";
import { inspectCliProcess, inspectIsolatedCodexAccount, readCliFrames, verifyCodexLoopbackDestination, type Frame } from "../src/host/cli-protocol";

const profile = resolve("test-cli-profile");

test("CLI frames preserve a multibyte reply split across stdout chunks", async () => {
  const reply = { id: 1, result: { text: "계획 확인" } };
  const bytes = Buffer.from(JSON.stringify(reply) + "\r\n");
  const partialCharacter = bytes.indexOf(Buffer.from("계")) + 1;
  const frames = readCliFrames(Readable.from([
    bytes.subarray(0, partialCharacter), bytes.subarray(partialCharacter, bytes.length - 1),
    Buffer.concat([bytes.subarray(bytes.length - 1), Buffer.from('{"id":2}\n')]),
  ]));
  const observed: Frame[] = [];
  for await (const frame of frames) observed.push(frame);
  assert.deepEqual(observed, [reply, { id: 2 }]);
});

test("CLI frames reject truncated, invalid and over-budget streams after valid replies", async () => {
  const response = '{"id":1}\n';
  const truncated = readCliFrames(Readable.from([Buffer.from(response + '{"id":2')]));
  assert.deepEqual((await truncated.next()).value, { id: 1 });
  await assert.rejects(truncated.next(), /incomplete message/);

  const malformed = readCliFrames(Readable.from([Buffer.from(response + "{invalid}\n")]));
  assert.deepEqual((await malformed.next()).value, { id: 1 });
  await assert.rejects(malformed.next(), SyntaxError);

  const tooLarge = readCliFrames(Readable.from([Buffer.from(response), Buffer.from('{"text":"가"}\n')]),
    Buffer.byteLength(response) + '{"text":"가"}\n'.length);
  assert.deepEqual((await tooLarge.next()).value, { id: 1 });
  await assert.rejects(tooLarge.next(), /output limit/);
});

test("An isolated Codex account check requires an empty profile and asks for no token refresh", async () => {
  const check = (account: unknown, codexHome = profile) => {
    const sent: Frame[] = [];
    const result = inspectIsolatedCodexAccount({
      send: (frame) => { sent.push(frame); },
      read: async (matches) => {
        const request = sent.at(-1)!;
        const platformOs = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform;
        const frame = { id: request.id, result: request.method === "initialize" ? { codexHome, platformOs } : account };
        assert.ok(matches(frame));
        return frame;
      },
    }, profile, "0.1.57");
    return { sent, result };
  };
  const empty = { account: null, requiresOpenaiAuth: true };
  const isolated = check(empty);
  assert.deepEqual(await isolated.result, { status: "signInRequired", billingSource: "unknown" });
  assert.deepEqual(isolated.sent.map(({ method }) => method), ["initialize", "initialized", "account/read"]);
  assert.deepEqual(isolated.sent.at(-1)?.params, { refreshToken: false });
  await assert.rejects(check({ ...empty, account: { type: "apiKey", key: "fixture-secret" } }).result);
  await assert.rejects(check({ ...empty, requiresOpenaiAuth: false }).result);
  await assert.rejects(check(empty, profile + "-other").result, /isolated profile/);
});

test("Codex fallback checks the isolated account and the live model before starting a turn", async () => {
  const check = (account: unknown, ...catalogs: unknown[]) => {
    const sent: Frame[] = [];
    let page = 0;
    const ready = verifyCodexLoopbackDestination({
      send: (frame) => { sent.push(frame); },
      read: async (matches) => {
        const request = sent.at(-1)!;
        const frame = { id: request.id, result: request.method === "account/read" ? account : catalogs[page++] };
        assert.ok(matches(frame));
        return frame;
      },
    }, "codex-test");
    return { sent, ready };
  };
  const local = { requiresOpenaiAuth: false, account: null };
  const entry = { id: "codex-test", displayName: "Codex Test" };
  const ready = check(local, { data: [entry], nextCursor: null });
  await ready.ready;
  assert.deepEqual(ready.sent.map(({ method }) => method), ["account/read", "model/list"]);
  assert.deepEqual(ready.sent[0]?.params, { refreshToken: false });
  const signedOut = check({ ...local, requiresOpenaiAuth: true }, {});
  await assert.rejects(signedOut.ready);
  assert.deepEqual(signedOut.sent.map(({ method }) => method), ["account/read"]);
  await assert.rejects(check({ ...local, account: { type: "apiKey" } }, {}).ready);
  await assert.rejects(check(local, { data: [{ ...entry, hidden: true }], nextCursor: null }).ready, /model is unavailable/);
  const paged = check(local, { data: [], nextCursor: "page-two" }, { data: [entry], nextCursor: null });
  await paged.ready;
  assert.deepEqual(paged.sent.at(-1)?.params, { limit: 20, includeHidden: false, cursor: "page-two" });
  const duplicateCursor = { data: [], nextCursor: "repeat" };
  await assert.rejects(check(local, duplicateCursor, duplicateCursor).ready, /model is unavailable/);
});

const fixture = String.raw`
  import assert from "node:assert/strict";
  import { createInterface } from "node:readline";
  const [provider, scenario, profile] = process.argv.slice(1);
  const reply = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
  const codexModel = { id: "demo-codex", displayName: "Demo Codex", supportedReasoningEfforts: [{ reasoningEffort: "high" }] };
  const received = [];
  for await (const line of createInterface({ input: process.stdin })) {
    const frame = JSON.parse(line);
    if (scenario === "hold") continue;
    if (scenario === "oversize") { process.stdout.write("x".repeat(256 * 1024 + 1)); continue; }
    if (scenario === "truncated") { process.stdout.write('{"id":1', () => process.exit(0)); continue; }
    if (provider === "openai") {
      received.push(frame.method);
      if (frame.method === "initialize") {
        assert.equal(frame.params.clientInfo.name, "tomverse_desktop");
        if (scenario === "early") { reply({ id: 2, result: { data: [codexModel], nextCursor: null } }); continue; }
        const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform;
        reply({ id: 1, result: { codexHome: scenario === "wrongProfile" ? profile + "-other" : profile,
          platformOs: scenario === "wrongPlatform" ? "unexpected-platform" : platform },
          ...(scenario === "contradictory" ? { error: { code: -32603 } } : {}) });
        reply({ method: "remoteControl/status/changed", params: {} });
      } else if (frame.method === "model/list") {
        reply({ id: 2, result: { data: scenario === "duplicate" ? [codexModel, codexModel] : [codexModel], nextCursor: null } });
      }
    } else if (provider === "anthropic") {
      assert.equal(frame.type, "control_request");
      assert.equal(frame.request.subtype, "initialize");
      received.push(frame.request.subtype);
      if (scenario === "tool") { reply({ type: "control_request", request_id: "unexpected", request: { subtype: "can_use_tool" } }); continue; }
      reply({ type: "control_response", response: { subtype: "success", request_id: frame.request_id,
        response: { current_permission_mode: "plan", models: [{ value: "opus[1m]", displayName: "Opus (1M)", supportedEffortLevels: ["max"] }],
          account: { token: "fixture-token-not-for-renderer" } } } });
    } else {
      assert.deepEqual(frame, {
        jsonrpc: "2.0", id: 1, method: "initialize", params: {
          protocolVersion: 1, clientCapabilities: {},
          clientInfo: { name: "tomverse-desktop", title: "Tomverse Desktop", version: "0.1.15" },
        },
      });
      received.push(frame.method);
      if (scenario === "permission") { reply({ jsonrpc: "2.0", id: 42, method: "session/request_permission" }); continue; }
      if (scenario === "notification") { reply({ jsonrpc: "2.0", method: "session/update", params: {} }); continue; }
      const grok = provider === "xai";
      const providers = {
        google: { agent: { name: "Antigravity ACP Server", version: "1.5.14" }, auth: "oauth-personal" },
        xai: { auth: scenario === "unknownAuth" ? "oauth-personal" : "grok.com" },
        qwen: { agent: { name: "qwen-code", version: "0.28.4" }, auth: "openai" },
        moonshot: { agent: { name: "Kimi Code CLI", version: "2.7.2" }, auth: "login" },
        mistral: { agent: { name: "@mistralai/mistral-vibe", version: "3.1.4" }, auth: "browser-auth" },
        minimax: { agent: { name: "minimax-code", version: "0.7.9" } },
      };
      const { agent, auth } = providers[provider];
      reply({ jsonrpc: scenario === "wrongEnvelope" ? undefined : "2.0", id: 1, result: {
        protocolVersion: scenario === "wrongVersion" ? 3 : 1,
        agentInfo: agent && { ...agent, name: scenario === "wrongAgent" ? "Other ACP Agent" : agent.name },
        authMethods: auth ? [{ id: auth, name: "Sign in" }] : [],
        models: [{ id: "never-return-a-catalog-from-initialize" }],
      } });
      if (grok) {
        const update = { jsonrpc: "2.0", method: "_x.ai/mcp/servers_updated",
          params: { mcpServers: scenario === "hasMcpServer" ? [{ name: "unexpected" }] : [] } };
        reply(update);
        if (scenario === "duplicateUpdate") reply(update);
      }
    }
  }
  if (scenario === "success") assert.deepEqual(received, provider === "openai" ? ["initialize", "initialized", "model/list"]
    : ["initialize"]);
`;

function start(provider: CliProtocolProvider, scenario: string, abort?: AbortSignal) {
  const signal = abort ? AbortSignal.any([abort, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
  const child = spawn(process.execPath, ["--input-type=module", "--eval", fixture, provider, scenario, profile], {
    signal, killSignal: "SIGKILL", shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
  });
  const versions = { openai: "0.171.0-alpha.13", anthropic: "2.1.278", google: "1.5.14", xai: "1.0.92", qwen: "0.28.4",
    moonshot: "2.7.2", mistral: "3.1.4", minimax: "0.7.9" };
  return { child, result: inspectCliProcess(child, provider, profile,
    { client: "0.1.15", executable: scenario === "wrongBinaryVersion" ? "0.0.0" : versions[provider] }, signal) };
}

test("CLI transport performs each official initialization and returns model metadata only", async () => {
  const [codex, claude, antigravity, grok, qwen, kimi, vibe, minimax] = await Promise.all([
    start("openai", "success").result, start("anthropic", "success").result,
    start("google", "success").result, start("xai", "success").result, start("qwen", "success").result, start("moonshot", "success").result,
    start("mistral", "success").result, start("minimax", "success").result,
  ]);
  assert.deepEqual(codex, { status: "verified", protocol: "codex_app_server", catalogComplete: true,
    models: [{ id: "demo-codex", name: "Demo Codex", efforts: ["high"] }] });
  assert.deepEqual(claude, { status: "verified", protocol: "claude_control", catalogComplete: true,
    models: [{ id: "opus[1m]", name: "Opus (1M)", efforts: ["max"] }] });
  assert.deepEqual(antigravity, { status: "verified", protocol: "acp", protocolVersion: 1, models: null });
  assert.deepEqual(grok, antigravity);
  assert.deepEqual(qwen, antigravity);
  assert.deepEqual(kimi, antigravity);
  assert.deepEqual(vibe, antigravity);
  assert.deepEqual(minimax, antigravity);
});

test("CLI transport rejects out-of-order, duplicate, unsolicited and invalid replies", async () => {
  await Promise.all([
    assert.rejects(start("openai", "early").result, /unexpected response/),
    assert.rejects(start("openai", "wrongPlatform").result, /platformOs/),
    assert.rejects(start("openai", "wrongProfile").result, /isolated profile/),
    assert.rejects(start("openai", "duplicate").result, /duplicate model ID/),
    assert.rejects(start("openai", "contradictory").result, /reported a protocol error/),
    assert.rejects(start("anthropic", "tool").result, /requested an action/),
    assert.rejects(start("google", "permission").result, /requested an action/),
    assert.rejects(start("google", "notification").result, /unexpected message during initialization/),
    assert.rejects(start("google", "wrongVersion").result, /protocolVersion/),
    assert.rejects(start("google", "wrongEnvelope").result, /jsonrpc/),
    assert.rejects(start("google", "wrongAgent").result, /identity did not match/),
    assert.rejects(start("google", "wrongBinaryVersion").result, /identity did not match/),
    assert.rejects(start("xai", "unknownAuth").result, /identity did not match/),
    assert.rejects(start("xai", "hasMcpServer").result, /Unexpected response while closing/),
    assert.rejects(start("xai", "duplicateUpdate").result, /Unexpected response while closing/),
    assert.rejects(start("qwen", "wrongAgent").result, /identity did not match/),
    assert.rejects(start("qwen", "wrongBinaryVersion").result, /identity did not match/),
    assert.rejects(start("moonshot", "wrongAgent").result, /identity did not match/),
    assert.rejects(start("mistral", "wrongBinaryVersion").result, /identity did not match/),
    assert.rejects(start("minimax", "wrongAgent").result, /identity did not match/),
    assert.rejects(start("openai", "oversize").result, /output limit/),
    assert.rejects(start("openai", "truncated").result, /incomplete message/),
  ]);
});

test("Cancelling a protocol check waits for the owned process to close", async () => {
  const controller = new AbortController();
  const check = start("anthropic", "hold", controller.signal);
  controller.abort();
  await assert.rejects(check.result);
  assert.equal(check.child.signalCode, "SIGKILL");
});
