import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createAmuxV22ReadOnlyApiBroker, createAmuxV22ReadOnlyApiSnapshotManifest } from
  "../lib/amux/v22ReadOnlyApiBroker.mjs";
import { createAmuxV22ReadOnlyApiExecutor } from
  "../lib/amux/v22ReadOnlyApiExecutor.mjs";
import {
  AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST,
  AMUX_V22_READ_ONLY_API_COUNT_TOKENS_URL,
  AMUX_V22_READ_ONLY_API_PROVIDER_URL,
  AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST,
  AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST,
  amuxV22ReadOnlyApiExecutionFrameDigest,
  amuxV22ReadOnlyApiRepositoryScopeDigest,
} from "../lib/amux/v22ReadOnlyApiProtocol.mjs";

const now = Date.parse("2026-10-13T01:00:00.000Z");
const scope = { sourceRevision: "a".repeat(40), allowedPrefixes: ["safe"] };
const scopeDigest = amuxV22ReadOnlyApiRepositoryScopeDigest(scope);
const frame = (overrides = {}) => ({
  version: 1, executorKind: "read_only_api_retry_v1", provider: "anthropic",
  modelId: "claude-opus-5-5", routeId: "recovery:anthropic",
  routePolicyDigest: "1".repeat(64), catalogApprovalId: "catalog:approved",
  catalogVersion: "catalog-v1", catalogDigest: "2".repeat(64),
  pricingVersion: "pricing-v1", pricingSource: "verified-record",
  pricingVerifiedAt: "2026-10-13T00:00:00.000Z",
  pricingExpiresAt: "2026-10-20T00:00:00.000Z",
  uncachedInputMicroUsdPerMillion: 1_000_000,
  cacheReadMicroUsdPerMillion: 100_000,
  cacheWriteMicroUsdPerMillion: 1_250_000,
  outputMicroUsdPerMillion: 5_000_000,
  tokenLimits: { uncachedInputTokens: 1_000, cacheReadTokens: 500,
    cacheWriteTokens: 500, outputTokens: 1_000 },
  maxProviderTurns: 8, maxOutputTokensPerTurn: 1_000, maxRetries: 0,
  maximumCostMicroUsd: 6_675,
  credentialProfileId: "first-task-recovery-anthropic",
  credentialMetadataDigest: "3".repeat(64), executorArtifactDigest: "4".repeat(64),
  settingsDigest: AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST,
  repositoryScopeDigest: scopeDigest,
  brokerPolicyDigest: AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST,
  toolSchemaDigest: AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST,
  ...overrides,
});
const request = basis => ({ version: 1, capability: "read_only_api_retry_v1",
  attemptId: "00000000-0000-4000-8000-000000000001",
  invocationId: "00000000-0000-4000-8000-000000000002",
  prompt: "Inspect the approved source and report the finding.",
  apiExecutionFrame: basis,
  apiExecutionFrameDigest: amuxV22ReadOnlyApiExecutionFrameDigest(basis) });
const provider = (overrides = {}) => ({ type: "message", role: "assistant",
  model: "claude-opus-5-5", content: [{ type: "text", text: "done" }],
  stop_reason: "end_turn", usage: { input_tokens: 50, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0, output_tokens: 20 }, ...overrides });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const countResponse = (inputTokens = 100) => response({ input_tokens: inputTokens });
const execFileAsync = promisify(execFile);
const gitBinary = process.platform === "win32" ?
  "C:\\Program Files\\Git\\mingw64\\bin\\git.exe" : "/usr/bin/git";
const gitNullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
const git = async (root, args) => execFileAsync(gitBinary,
  ["--no-pager", "-c", `core.hooksPath=${gitNullDevice}`,
    "-c", "commit.gpgSign=false", ...args], {
    cwd: root, windowsHide: true,
    env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitNullDevice,
      GIT_TERMINAL_PROMPT: "0", LANG: "C", LC_ALL: "C" },
  });
const commitFiles = async (root, paths, message = "snapshot") => {
  await git(root, ["init", "--quiet"]);
  await git(root, ["add", "--", ...paths]);
  await git(root, ["-c", "user.name=AMUX Test", "-c", "user.email=amux@example.invalid",
    "commit", "--quiet", "-m", message]);
  return (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
};
const runtime = (fetcher, overrides = {}) => ({
  testOnly: true,
  environment: { TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED: "true" },
  operationalGatesSatisfied: true,
  credential: { verified: true, dedicated: true, apiKey: "sk-ant-mock-only-never-sent",
    profileId: "first-task-recovery-anthropic", metadataDigest: "3".repeat(64) },
  executorArtifactDigest: "4".repeat(64), settingsDigest: AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST,
  repositoryScopeDigest: scopeDigest,
  brokerPolicyDigest: AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST,
  toolSchemaDigest: AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST,
  broker: { repositoryScopeDigest: scopeDigest,
    execute: async (name, input) => JSON.stringify({ name, input, result: "mock" }) },
  fetcher, clock: () => now, hostDeadlineAtMs: now + 600_000, ...overrides,
});

test("mock-only Anthropic tool loop returns one complete content-free receipt", async () => {
  const calls = [];
  const first = provider({ content: [{ type: "tool_use", id: "tool_1", name: "Read",
    input: { path: "safe/a.txt" } }], stop_reason: "tool_use",
  usage: { input_tokens: 100, cache_read_input_tokens: 20,
    cache_creation_input_tokens: 10, output_tokens: 5 } });
  let messageCalls = 0;
  const executor = createAmuxV22ReadOnlyApiExecutor(runtime(async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (url === AMUX_V22_READ_ONLY_API_COUNT_TOKENS_URL) return countResponse(200);
    messageCalls += 1;
    return response(messageCalls === 1 ? first : provider());
  }));
  const basis = frame();
  assert.deepEqual(executor.capabilities(), [], "a capability needs a current verified frame");
  assert.deepEqual(executor.capabilities(basis, { now }), ["read_only_api_retry_v1"]);
  const result = await executor.execute(request(basis));
  assert.equal(result.kind, "succeeded");
  assert.equal(result.resultText, "done");
  assert.equal(calls.length, 4);
  assert.equal(calls[0].url, AMUX_V22_READ_ONLY_API_COUNT_TOKENS_URL);
  assert.equal(calls[0].init.redirect, "error");
  const paidCalls = calls.filter(call => call.url === AMUX_V22_READ_ONLY_API_PROVIDER_URL);
  assert.equal(paidCalls[0].body.max_tokens, basis.maxOutputTokensPerTurn);
  assert.equal(paidCalls[1].body.max_tokens, 995);
  assert.deepEqual(calls[0].body.tools.map(tool => tool.name), ["Read", "Grep", "Glob"]);
  assert.deepEqual(paidCalls[1].body.messages.at(-1), { role: "user", content: [{
    type: "tool_result", tool_use_id: "tool_1",
    content: JSON.stringify({ name: "Read", input: { path: "safe/a.txt" }, result: "mock" }),
  }] });
  assert.deepEqual(result.apiExecutionReceipt, {
    ...result.apiExecutionReceipt, actualModelId: basis.modelId,
    actualModelUniform: true, usageComplete: true, providerTurnCount: 2,
    uncachedInputTokens: 150, cacheReadTokens: 20, cacheWriteTokens: 10,
    outputTokens: 25, projectedCostMicroUsd: 290,
  });
  assert.equal(JSON.stringify(result.apiExecutionReceipt).includes("prompt"), false);
  const replay = await executor.execute(request(basis));
  assert.deepEqual(replay, result);
  assert.equal(calls.length, 4, "replay must not call the provider again");
});

test("default-off, missing key and frame/config/price drift fail before fetch", async () => {
  for (const change of [
    { environment: {} },
    { credential: { verified: false, dedicated: true, apiKey: "", profileId: "x",
      metadataDigest: "3".repeat(64) } },
    { settingsDigest: "9".repeat(64) },
  ]) {
    let calls = 0;
    const executor = createAmuxV22ReadOnlyApiExecutor(runtime(async () => {
      calls += 1; return response(provider());
    }, change));
    assert.equal((await executor.execute(request(frame()))).kind, "blocked");
    assert.equal(calls, 0);
    assert.deepEqual(executor.capabilities(frame(), { now }), []);
  }
  for (const basis of [
    frame({ pricingExpiresAt: "2026-10-13T01:00:00.000Z" }),
    frame({ maxRetries: 1 }), frame({ maxProviderTurns: 7 }),
    frame({ maximumCostMicroUsd: 3_400_001 }),
  ]) {
    let calls = 0;
    const executor = createAmuxV22ReadOnlyApiExecutor(runtime(async () => {
      calls += 1; return response(provider());
    }));
    const raw = { ...request(frame()), apiExecutionFrame: basis };
    const result = await executor.execute(raw);
    assert.equal(result.error, "read_only_api_frame_invalid");
    assert.equal(calls, 0);
  }
  let calls = 0;
  const executor = createAmuxV22ReadOnlyApiExecutor(runtime(async () => {
    calls += 1; return response(provider());
  }));
  const drifted = { ...request(frame()), apiExecutionFrameDigest: "f".repeat(64) };
  assert.equal((await executor.execute(drifted)).error, "read_only_api_frame_invalid");
  assert.equal(calls, 0);
});

test("forbidden tool, missing usage/model and token cap close after one fetch", async () => {
  const cases = [
    provider({ content: [{ type: "tool_use", id: "tool_1", name: "Bash",
      input: { command: "whoami" } }], stop_reason: "tool_use" }),
    provider({ usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
    provider({ model: "claude-other" }),
    provider({ usage: { input_tokens: 1_001, cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0, output_tokens: 1 } }),
  ];
  for (const body of cases) {
    let calls = 0;
    let messages = 0;
    const executor = createAmuxV22ReadOnlyApiExecutor(runtime(async url => {
      calls += 1;
      if (url === AMUX_V22_READ_ONLY_API_COUNT_TOKENS_URL) return countResponse();
      messages += 1;
      return response(body);
    }));
    const result = await executor.execute(request(frame()));
    assert.equal(result.kind, "outcome_unknown");
    assert.equal(result.apiExecutionReceipt, null);
    assert.equal(calls, 2);
    assert.equal(messages, 1);
  }
});

test("network, response loss, timeout, 429 and 5xx are never retried", async () => {
  const failures = [
    async () => { throw new Error("network"); },
    async () => ({ status: 200, arrayBuffer: async () => { throw new Error("lost"); } }),
    async () => response({ error: "rate" }, 429),
    async () => response({ error: "server" }, 503),
    async () => ({ status: 200, redirected: true, url: "https://other.invalid/",
      arrayBuffer: async () => new ArrayBuffer(0) }),
  ];
  for (const fetcher of failures) {
    let calls = 0;
    const executor = createAmuxV22ReadOnlyApiExecutor(runtime(async (...args) => {
      calls += 1; return fetcher(...args);
    }));
    const result = await executor.execute(request(frame()));
    assert.equal(result.error, "read_only_api_outcome_unknown");
    assert.equal(calls, 1);
  }
  let timeoutCalls = 0;
  const timeoutExecutor = createAmuxV22ReadOnlyApiExecutor(runtime(async (_url, init) => {
    timeoutCalls += 1;
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () =>
      reject(new Error("aborted")), { once: true }));
  }, { hostDeadlineAtMs: now + 5 }));
  assert.equal((await timeoutExecutor.execute(request(frame()))).error,
    "read_only_api_outcome_unknown");
  assert.equal(timeoutCalls, 1);
});

test("count_tokens admission prevents an over-cap or second paid Messages call", async () => {
  let counted = 0;
  let messages = 0;
  const overCap = createAmuxV22ReadOnlyApiExecutor(runtime(async url => {
    if (url === AMUX_V22_READ_ONLY_API_COUNT_TOKENS_URL) {
      counted += 1;
      return countResponse(1_001);
    }
    messages += 1;
    return response(provider());
  }));
  assert.equal((await overCap.execute(request(frame()))).error,
    "read_only_api_outcome_unknown");
  assert.equal(counted, 1);
  assert.equal(messages, 0, "Messages must not run after count_tokens exceeds input cap");

  counted = 0;
  messages = 0;
  const capExhausted = createAmuxV22ReadOnlyApiExecutor(runtime(async url => {
    if (url === AMUX_V22_READ_ONLY_API_COUNT_TOKENS_URL) {
      counted += 1;
      return countResponse(100);
    }
    messages += 1;
    return response(provider({ content: [{ type: "tool_use", id: "tool_1", name: "Read",
      input: { path: "safe/a.txt" } }], stop_reason: "tool_use",
    usage: { input_tokens: 1_000, cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0, output_tokens: 1 } }));
  }));
  assert.equal((await capExhausted.execute(request(frame()))).error,
    "read_only_api_outcome_unknown");
  assert.equal(counted, 1, "an exhausted category must stop before another count call");
  assert.equal(messages, 1, "an exhausted category must prevent the second Messages call");
});

test("transport injection is test-only and an abort-ignoring late promise stays bounded", async () => {
  let rejectedInjectionCalls = 0;
  const injectedProduction = createAmuxV22ReadOnlyApiExecutor(runtime(async () => {
    rejectedInjectionCalls += 1;
    return countResponse();
  }, { testOnly: false }));
  assert.deepEqual(injectedProduction.capabilities(frame(), { now }), []);
  assert.equal((await injectedProduction.execute(request(frame()))).error,
    "read_only_api_executor_disabled");
  assert.equal(rejectedInjectionCalls, 0);

  let lateSettled = false;
  let lateCalls = 0;
  const bounded = createAmuxV22ReadOnlyApiExecutor(runtime(async () => {
    lateCalls += 1;
    return new Promise(resolve => setTimeout(() => {
      lateSettled = true;
      resolve(countResponse());
    }, 40));
  }, { hostDeadlineAtMs: now + 5 }));
  const started = Date.now();
  const result = await bounded.execute(request(frame()));
  assert.equal(result.error, "read_only_api_outcome_unknown");
  assert.ok(Date.now() - started < 35, "hard deadline must win even when fetch ignores abort");
  assert.equal(lateCalls, 1);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(lateSettled, true, "the ignored late promise may settle without changing outcome");
  assert.equal((await bounded.execute(request(frame()))).error,
    "read_only_api_outcome_unknown");
  assert.equal(lateCalls, 1, "late settlement must not trigger replay or another call");
});

test("a claimed unknown replays before expired runtime readiness without exposing it to mismatches",
  async () => {
    const originalFetch = globalThis.fetch;
    try {
      for (const afterClaim of [
        () => {},
        active => { active.environment.TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED = "false"; },
        active => { active.credential.apiKey = ""; },
      ]) {
        let calls = 0;
        globalThis.fetch = async () => {
          calls += 1;
          return new Promise(resolve => setTimeout(() => resolve(countResponse()), 40));
        };
        const active = runtime(undefined, { testOnly: false,
          hostDeadlineAtMs: Date.now() + 20 });
        delete active.fetcher;
        delete active.clock;
        const executor = createAmuxV22ReadOnlyApiExecutor(active);
        // This test runs on the real clock, so the pricing record must be
        // current relative to it rather than to the fixed fixture date.
        const basis = frame({
          pricingVerifiedAt: new Date(Date.now() - 60_000).toISOString(),
          pricingExpiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        });
        const original = request(basis);
        const claimed = await executor.execute(original);
        assert.equal(claimed.kind, "outcome_unknown");
        assert.equal(calls, 1);
        afterClaim(active);
        const replay = await executor.execute(original);
        assert.deepEqual(replay, claimed,
          "the exact claimed request must replay before deadline, flag, or key readiness");
        assert.equal(calls, 1, "a replay must not invoke global fetch again");
        const mismatch = await executor.execute({ ...original, prompt: `${original.prompt} changed` });
        assert.deepEqual(mismatch, { kind: "blocked", error: "read_only_api_frame_invalid",
          apiExecutionReceipt: null, resultText: null });
        assert.equal(calls, 1, "a mismatched request must neither receive the claim nor refetch");
      }
    } finally { globalThis.fetch = originalFetch; }
  });

test("broker enforces deterministic bounds and refuses traversal, secrets and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "amux-v22-api-broker-"));
  assert.equal(isAbsolute(root), true);
  try {
    await mkdir(join(root, "safe"), { recursive: true });
    await mkdir(join(root, "safe", "good"), { recursive: true });
    await writeFile(join(root, "safe", "b.txt"), "beta\nneedle\n", "utf8");
    await writeFile(join(root, "safe", "a.txt"), "alpha\nneedle\n", "utf8");
    await writeFile(join(root, "safe", "good", "a.txt"), "alpha\nneedle\n", "utf8");
    await writeFile(join(root, "safe", "good", "b.txt"), "beta\nneedle\n", "utf8");
    await writeFile(join(root, "safe", "link.txt"), "not a link", "utf8");
    await writeFile(join(root, "safe", ".env.local"), "SECRET=value", "utf8");
    await writeFile(join(root, "safe", "credential.txt"), "hidden", "utf8");
    await writeFile(join(root, "safe", "leak.txt"),
      "ANTHROPIC_API_KEY=sk-ant-never-expose-this-value", "utf8");
    const sourceRevision = await commitFiles(root, ["safe/a.txt", "safe/b.txt",
      "safe/good/a.txt", "safe/good/b.txt", "safe/link.txt", "safe/leak.txt"]);
    const repositoryScope = { sourceRevision, allowedPrefixes: ["safe"] };
    const repositoryScopeDigest = amuxV22ReadOnlyApiRepositoryScopeDigest(repositoryScope);
    const snapshotConfig = { repositoryRoot: root, ...repositoryScope };
    const snapshotManifest = await createAmuxV22ReadOnlyApiSnapshotManifest(snapshotConfig);
    assert.equal(snapshotManifest.sourceRevision, sourceRevision);
    assert.match(snapshotManifest.sourceTreeObjectId, /^[a-f0-9]{40}$/);
    assert.match(snapshotManifest.gitProofDigest, /^[a-f0-9]{64}$/);
    assert.equal(snapshotManifest.files.every(file => /^[a-f0-9]{40}$/.test(file.objectId)), true);
    const config = { ...snapshotConfig, repositoryScopeDigest,
      brokerPolicyDigest: AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST,
      toolSchemaDigest: AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST, snapshotManifest };
    const broker = createAmuxV22ReadOnlyApiBroker(config);
    assert.equal(await broker.execute("Read", { path: "safe/a.txt" }),
      JSON.stringify({ path: "safe/a.txt", startLine: 1, endLine: 3,
        content: "alpha\nneedle\n" }));
    assert.deepEqual(JSON.parse(await broker.execute("Glob", { pattern: "safe/*.txt" })).paths,
      ["safe/a.txt", "safe/b.txt", "safe/leak.txt", "safe/link.txt"]);
    assert.deepEqual(JSON.parse(await broker.execute("Grep", {
      path: "safe/good", pattern: "needle",
    })).matches.map(item => item.path), ["safe/good/a.txt", "safe/good/b.txt"]);
    for (const path of ["../outside", root, "safe\0x", "safe/.env.local",
      "safe/credential.txt", ".git/config", "safe/leak.txt"])
      await assert.rejects(() => broker.execute("Read", { path }));

    let simulateSymlink = false;
    const symlinkManifest = await createAmuxV22ReadOnlyApiSnapshotManifest(snapshotConfig, {
      lstat: async path => {
        const info = await lstat(path);
        if (!simulateSymlink || !path.endsWith(`${join("safe", "link.txt")}`)) return info;
        return { dev: info.dev, ino: info.ino, ctimeMs: info.ctimeMs, size: info.size,
          nlink: info.nlink, isFile: () => false, isDirectory: () => false,
          isSymbolicLink: () => true };
      },
    });
    const symlinkBroker = createAmuxV22ReadOnlyApiBroker({ ...config,
      snapshotManifest: symlinkManifest });
    simulateSymlink = true;
    await assert.rejects(() => symlinkBroker.execute("Read", { path: "safe/link.txt" }));

    assert.throws(() => createAmuxV22ReadOnlyApiBroker({ ...config,
      snapshotManifest: { ...snapshotManifest } }), /read_only_api_frame_invalid/,
    "a caller-created manifest clone must not acquire root-owned provenance");

    const nonGit = await mkdtemp(join(tmpdir(), "amux-v22-api-nongit-"));
    try {
      await mkdir(join(nonGit, "safe"), { recursive: true });
      await mkdir(join(nonGit, ".git"), { recursive: true });
      await writeFile(join(nonGit, "safe", "a.txt"), "alpha", "utf8");
      await writeFile(join(nonGit, ".git", "HEAD"), `${"a".repeat(40)}\n`, "utf8");
      await assert.rejects(() => createAmuxV22ReadOnlyApiSnapshotManifest({
        repositoryRoot: nonGit, ...scope,
      }), /snapshot_invalid/,
      "a SHA-shaped HEAD without commit, tree, and blob objects is not revision proof");
    } finally { await rm(nonGit, { recursive: true, force: true }); }

    const otherRoot = await mkdtemp(join(tmpdir(), "amux-v22-api-mixed-"));
    try {
      await mkdir(join(otherRoot, "safe"), { recursive: true });
      await writeFile(join(otherRoot, "safe", "a.txt"), "other", "utf8");
      const otherRevision = await commitFiles(otherRoot, ["safe/a.txt"]);
      const otherScope = { sourceRevision: otherRevision, allowedPrefixes: ["safe"] };
      const otherManifest = await createAmuxV22ReadOnlyApiSnapshotManifest({
        repositoryRoot: otherRoot, ...otherScope,
      });
      assert.throws(() => createAmuxV22ReadOnlyApiBroker({ ...config,
        snapshotManifest: otherManifest }), /read_only_api_frame_invalid/,
      "a manifest from another snapshot root must not be mixed in");
    } finally { await rm(otherRoot, { recursive: true, force: true }); }

    const dirtyRoot = await mkdtemp(join(tmpdir(), "amux-v22-api-dirty-"));
    try {
      await mkdir(join(dirtyRoot, "safe"), { recursive: true });
      await writeFile(join(dirtyRoot, "safe", "a.txt"), "committed\n", "utf8");
      const dirtyRevision = await commitFiles(dirtyRoot, ["safe/a.txt"]);
      await writeFile(join(dirtyRoot, "safe", "a.txt"), "dirty before manifest\n", "utf8");
      await assert.rejects(() => createAmuxV22ReadOnlyApiSnapshotManifest({
        repositoryRoot: dirtyRoot, sourceRevision: dirtyRevision, allowedPrefixes: ["safe"],
      }), /snapshot_invalid/,
      "working bytes must match the source revision before a manifest is minted");
    } finally { await rm(dirtyRoot, { recursive: true, force: true }); }

    const wrongHeadRoot = await mkdtemp(join(tmpdir(), "amux-v22-api-wrong-head-"));
    try {
      await mkdir(join(wrongHeadRoot, "safe"), { recursive: true });
      await writeFile(join(wrongHeadRoot, "safe", "a.txt"), "first\n", "utf8");
      const firstRevision = await commitFiles(wrongHeadRoot, ["safe/a.txt"], "first");
      await writeFile(join(wrongHeadRoot, "safe", "a.txt"), "second\n", "utf8");
      await git(wrongHeadRoot, ["add", "--", "safe/a.txt"]);
      await git(wrongHeadRoot, ["-c", "user.name=AMUX Test",
        "-c", "user.email=amux@example.invalid", "commit", "--quiet", "-m", "second"]);
      await assert.rejects(() => createAmuxV22ReadOnlyApiSnapshotManifest({
        repositoryRoot: wrongHeadRoot, sourceRevision: firstRevision,
        allowedPrefixes: ["safe"],
      }), /snapshot_invalid/,
      "an existing but non-HEAD source revision must not brand another checkout");
    } finally { await rm(wrongHeadRoot, { recursive: true, force: true }); }

    const packedRoot = await mkdtemp(join(tmpdir(), "amux-v22-api-packed-"));
    try {
      await mkdir(join(packedRoot, "safe"), { recursive: true });
      await writeFile(join(packedRoot, "safe", "a.txt"), "packed\n", "utf8");
      const packedRevision = await commitFiles(packedRoot, ["safe/a.txt"]);
      await git(packedRoot, ["remote", "add", "origin",
        "https://example.invalid/amux.git"]);
      await git(packedRoot, ["gc", "--quiet", "--prune=now"]);
      const packedScope = { sourceRevision: packedRevision, allowedPrefixes: ["safe"] };
      const packedManifest = await createAmuxV22ReadOnlyApiSnapshotManifest({
        repositoryRoot: packedRoot, ...packedScope,
      });
      assert.equal(packedManifest.sourceRevision, packedRevision);
      const packedBroker = createAmuxV22ReadOnlyApiBroker({
        repositoryRoot: packedRoot, ...packedScope,
        repositoryScopeDigest: amuxV22ReadOnlyApiRepositoryScopeDigest(packedScope),
        brokerPolicyDigest: AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST,
        toolSchemaDigest: AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST,
        snapshotManifest: packedManifest,
      });
      assert.equal(await packedBroker.execute("Read", { path: "safe/a.txt" }),
        JSON.stringify({ path: "safe/a.txt", startLine: 1, endLine: 2,
          content: "packed\n" }));

      const configPath = join(packedRoot, ".git", "config");
      const safeConfig = await readFile(configPath);
      for (const [key, value] of [
        ["include.path", join(packedRoot, "outside.config")],
        ["credential.helper", "!unsafe-helper"],
        ["core.hooksPath", "unsafe-hooks"],
        ["filter.unsafe.smudge", "unsafe-filter"],
        ["pager.cat-file", "unsafe-pager"],
        ["core.sshCommand", "unsafe-ssh"],
        ["remote.origin.uploadpack", "!unsafe-upload-pack"],
      ]) {
        await git(packedRoot, ["config", "--local", key, value]);
        await assert.rejects(() => createAmuxV22ReadOnlyApiSnapshotManifest({
          repositoryRoot: packedRoot, ...packedScope,
        }), /snapshot_invalid/,
        `unsafe repository-local Git config must close before object lookup: ${key}`);
        await writeFile(configPath, safeConfig);
      }
      const childConfigPath = join(packedRoot, ".git", "logs", "config");
      await writeFile(childConfigPath, "[include]\npath = unsafe.config\n", "utf8");
      await assert.rejects(() => createAmuxV22ReadOnlyApiSnapshotManifest({
        repositoryRoot: packedRoot, ...packedScope,
      }), /snapshot_invalid/,
      "the configless child Git directory must remain configless");
      await rm(childConfigPath, { force: true });
      await writeFile(join(packedRoot, "safe", "a.txt"), "packed mutation\n", "utf8");
      await assert.rejects(() => packedBroker.execute("Read", { path: "safe/a.txt" }),
        /snapshot_changed/, "packed provenance must not hide a later working-tree mutation");
    } finally { await rm(packedRoot, { recursive: true, force: true }); }

    await writeFile(join(root, "safe", "a.txt"), "changed\nneedle\n", "utf8");
    await assert.rejects(() => broker.execute("Read", { path: "safe/a.txt" }),
      /snapshot_changed/, "post-manifest mutation must fail closed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
