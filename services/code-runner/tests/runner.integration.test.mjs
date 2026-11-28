// The cloud runner end to end on this machine: a fake Tomverse server (the runner channel and the bundle route), a
// scripted model behind it, a real git bundle and the real Tomverse CLI engine from apps/tomverse-cli/src. Proves
// that a claimed job reads its bundle, runs the agent, sends every model call to the server as a managed call that
// the managed path's own bounds accept, reports progress, and returns a patch that applies to the original folder.
// On machines without bubblewrap the worker runs unsandboxed (CODE_RUNNER_ALLOW_UNISOLATED), which only tests set.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { serve } from "../runner.mjs";
import { codeSchemaAndPrompt } from "../../../lib/codeManagedCore.ts";
import { codeCloudRunnerRequestSchema } from "../../../lib/codeCloudContract.ts";

const SECRET = "integration-runner-secret-0123456789abcdef";
const CLI_RUNTIME = resolve(import.meta.dirname, "../../../apps/tomverse-cli/src/runtime.ts");
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.autocrlf=false", ...args], { cwd }).toString();

function snapshot() {
  const repo = mkdtempSync(join(tmpdir(), "cloud-runner-repo-"));
  git(repo, "init", "--quiet");
  writeFileSync(join(repo, "greeting.txt"), "hello\n");
  writeFileSync(join(repo, "README.md"), "# Fixture\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "fixture");
  const base = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "update-ref", "refs/heads/snapshot", base);
  const bundlePath = join(repo, "..", `${randomUUID()}.bundle`);
  git(repo, "bundle", "create", bundlePath, "refs/heads/snapshot");
  const bundle = readFileSync(bundlePath);
  rmSync(bundlePath);
  return { repo, base, bundle };
}

/** The runner channel of the Tomverse server with a scripted model. `turns` answers model calls in order. */
function fakeServer({ job, turns, heartbeat = () => ({ cancel: false, stop: false }) }) {
  const seen = { claims: 0, models: [], heartbeats: [], finish: null, logs: [] };
  let claimed = false, resolveFinish;
  const finished = new Promise((r) => { resolveFinish = r; });
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const reply = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${SECRET}`) return reply(401, { error: "CODE_CLOUD_RUNNER_FORBIDDEN" });
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/api/code/cloud/runner/bundle") {
      if (req.headers["x-tomverse-job-token"] !== job.token || url.searchParams.get("job") !== job.jobId) return reply(404, { error: "CODE_CLOUD_JOB_NOT_FOUND" });
      res.writeHead(200, { "content-type": "application/x-git-bundle" });
      return res.end(job.bundle);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    // Every runner request must be one the real server's schema accepts.
    assert.equal(codeCloudRunnerRequestSchema.safeParse(body).success, true, JSON.stringify(body).slice(0, 300));
    if (body.action === "claim") {
      seen.claims++;
      if (claimed) return reply(200, { job: null });
      claimed = true;
      const { bundle, ...wire } = job;
      return reply(200, { job: { ...wire, bundleBytes: bundle.length, bundleSha256: createHash("sha256").update(bundle).digest("hex") } });
    }
    if (req.headers["x-tomverse-job-token"] !== job.token) return reply(404, { error: "CODE_CLOUD_JOB_NOT_FOUND" });
    if (body.action === "heartbeat") {
      seen.heartbeats.push(body);
      seen.logs.push(...body.logs);
      return reply(200, heartbeat(seen));
    }
    if (body.action === "model") {
      seen.models.push(body);
      const turn = turns[seen.models.length - 1];
      if (!turn) return reply(409, { error: "CODE_TASK_CAP_EXCEEDED", dispatchState: "not_dispatched" });
      return reply(200, { value: turn, usage: { inputTokens: 100, outputTokens: 20 }, callCredits: 1, billing: null });
    }
    if (body.action === "finish") {
      seen.finish = body;
      seen.logs.push(...(body.logs ?? []));
      reply(200, { ok: true });
      return resolveFinish(body);
    }
    return reply(400, { error: "bad" });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, seen, finished, origin: `http://127.0.0.1:${server.address().port}` })));
}

const runnerEnv = (origin) => ({ ...process.env, TOMVERSE_ORIGIN: origin, CODE_CLOUD_RUNNER_SECRET: SECRET, CODE_RUNNER_ALLOW_UNISOLATED: "true",
  CODE_RUNNER_CLI_RUNTIME: CLI_RUNTIME, CODE_RUNNER_ID: "integration" });
const jobFor = ({ base, bundle }, extra = {}) => ({
  jobId: randomUUID(), token: randomUUID(), instruction: "Change the greeting in greeting.txt to say hi.", baseCommit: base, bundle, cancelRequested: false,
  executor: { modelId: "gpt-6-luna", name: "GPT 6 Luna", provider: "openai", maxOutputTokens: 1000, maxContextTokens: 400_000 },
  limits: { maxRuntimeMs: 120_000, heartbeatMs: 300, leaseMs: 10_000 }, ...extra,
});

test("a claimed job runs the CLI engine, settles each turn through the server and returns a patch that applies", { timeout: 180_000 }, async () => {
  const fixture = snapshot();
  const job = jobFor(fixture);
  const turns = [
    { content: "Updating the greeting.", tool_calls: [{ name: "apply_patch", arguments: { edits: [{ path: "greeting.txt", action: "update", replacements: [{ old: "hello", new: "hi" }] }], explanation: "Say hi" } }] },
    { content: "Changed greeting.txt to say hi.", tool_calls: [] },
  ];
  const { server, seen, finished, origin } = await fakeServer({ job, turns });
  const controller = new AbortController();
  const serving = serve({ env: runnerEnv(origin), signal: controller.signal, log: () => {} });
  try {
    const finish = await finished;
    assert.equal(finish.outcome, "completed", JSON.stringify(finish).slice(0, 500));
    assert.equal(finish.summary, "Changed greeting.txt to say hi.");
    assert.equal(seen.models.length, 2);
    // The CLI's own system prompt and tools reached the call, and the managed path's bounds accept it as sent.
    const first = seen.models[0];
    assert.match(first.prompt.system, /apply_patch/);
    assert.match(first.prompt.user, /Change the greeting/);
    for (const call of seen.models) {
      assert.doesNotThrow(() => codeSchemaAndPrompt({ ...call, action: "complete", reservationId: randomUUID(), role: "executor", modelId: "gpt-6-luna" },
        { capabilities: { maxOutputTokens: 1000, maxContextTokens: 400_000 } }));
    }
    assert.match(seen.models[1].prompt.user, /\[result of call_/);
    const patch = Buffer.from(finish.patchBase64, "base64");
    assert.equal(createHash("sha256").update(patch).digest("hex"), finish.patchSha256);
    assert.match(patch.toString("utf8"), /-hello\n\+hi/);
    // The patch applies to the person's own folder, which still holds the snapshot.
    const patchFile = join(fixture.repo, "..", `${randomUUID()}.patch`);
    writeFileSync(patchFile, patch);
    git(fixture.repo, "apply", "--check", patchFile);
    git(fixture.repo, "apply", patchFile);
    rmSync(patchFile);
    assert.equal(readFileSync(join(fixture.repo, "greeting.txt"), "utf8"), "hi\n");
    assert.ok(seen.logs.some((line) => /Model call settled: 1 credits/.test(line)), seen.logs.join("\n"));
    assert.ok(seen.logs.some((line) => /greeting\.txt/.test(line)));
  } finally {
    controller.abort();
    await serving;
    server.close();
    rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test("a cancel from the person stops the agent mid-command and reports cancelled with no patch", { timeout: 180_000 }, async () => {
  const fixture = snapshot();
  const job = jobFor(fixture);
  const turns = [{ content: "Running a long check.", tool_calls: [{ name: "run_command", arguments: { argv: [process.execPath, "-e", "setTimeout(() => {}, 60000)"] } }] }];
  const { server, finished, origin, seen } = await fakeServer({ job, turns, heartbeat: (state) => ({ cancel: state.models.length > 0, stop: false }) });
  const controller = new AbortController();
  const started = Date.now();
  const serving = serve({ env: runnerEnv(origin), signal: controller.signal, log: () => {} });
  try {
    const finish = await finished;
    assert.equal(finish.outcome, "cancelled");
    assert.equal(finish.patchBase64, undefined);
    assert.ok(Date.now() - started < 50_000, "stopped well before the command would have ended");
    assert.equal(seen.models.length, 1);
  } finally {
    controller.abort();
    await serving;
    server.close();
    rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test("a bundle that does not match its claim is refused before anything runs", { timeout: 60_000 }, async () => {
  const fixture = snapshot();
  const job = jobFor(fixture, { baseCommit: "0".repeat(40) });
  const { server, finished, origin, seen } = await fakeServer({ job, turns: [] });
  const controller = new AbortController();
  const serving = serve({ env: runnerEnv(origin), signal: controller.signal, log: () => {} });
  try {
    const finish = await finished;
    assert.equal(finish.outcome, "failed");
    assert.equal(finish.failureCode, "CODE_CLOUD_BUNDLE_INVALID");
    assert.equal(seen.models.length, 0);
  } finally {
    controller.abort();
    await serving;
    server.close();
    rmSync(fixture.repo, { recursive: true, force: true });
  }
});
