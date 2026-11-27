import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codeCloudRequestSchema, type CodeCloudJobView } from "../../../lib/codeCloudContract";
import { cloudFailureFor } from "../src/cloud-execution-contract";
import { createCloudExecutionClient, type CloudSend } from "../src/host/cloud-execution-client";
import { createCloudExecutionHost, type CloudProject } from "../src/host/cloud-execution-host";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.autocrlf=false", ...args], { cwd }).toString();
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function project() {
  const root = mkdtempSync(join(tmpdir(), "cloud-host-"));
  git(root, "init", "--quiet");
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "base");
  return root;
}

/** A fake of the three job routes that checks each request the way the server does and keeps the jobs it made. */
function fakeServer() {
  const jobs = new Map<string, CodeCloudJobView & { bundle?: Buffer; patchBytes?: Buffer }>();
  const requests: Array<{ path: string; method: string; headers: Record<string, string>; body?: unknown; raw?: { bytes: Uint8Array; type: string } }> = [];
  let failNext = 0;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const view = (job: CodeCloudJobView) => Object.fromEntries(Object.entries(job).filter(([key]) => key !== "bundle" && key !== "patchBytes")) as CodeCloudJobView;
  const send: CloudSend = async (request, _accept, _timeout, extra = {}) => {
    requests.push({ path: request.path, method: request.method ?? "GET", headers: extra, body: request.body, raw: request.raw });
    if (failNext > 0) { failNext--; throw new TypeError("network"); }
    assert.equal(extra["X-Tomverse-Code"], "1");
    const url = new URL(request.path, "https://tomverse.test");
    if (url.pathname === "/api/code/cloud") {
      const body = codeCloudRequestSchema.parse(request.body);
      if (body.action === "create") {
        const prior = [...jobs.values()].find((job) => job.taskId === body.taskId);
        if (prior) return json(view(prior));
        const job: CodeCloudJobView = { jobId: randomUUID(), taskId: body.taskId, status: "uploading", instruction: body.instruction, executorModelId: body.executorModelId,
          reviewerModelId: body.reviewerModelId, approvedCredits: body.approvedCredits, cancelRequested: false, failureCode: null, summary: null, billing: null, patch: null,
          logs: [], logSeq: 0, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, expiresAt: new Date(Date.now() + 1e6).toISOString() };
        jobs.set(job.jobId, Object.assign(job, { bundleSha256: body.bundleSha256, bundleBytes: body.bundleBytes }));
        return json(job);
      }
      if (body.action === "list") return json({ jobs: [...jobs.values()].map((job) => ({ ...view(job), logs: [] })) });
      const job = jobs.get(body.jobId);
      if (!job) return json({ error: "CODE_CLOUD_JOB_NOT_FOUND" }, 404);
      if (body.action === "cancel") { job.cancelRequested = true; return json(view(job)); }
      if (body.action === "status") return json({ ...view(job), logs: job.logs.filter((line) => line.seq > (body.afterLog ?? 0)) });
    }
    if (url.pathname === "/api/code/cloud/bundle") {
      const job = jobs.get(url.searchParams.get("job")!)!;
      assert.equal(request.method, "PUT");
      assert.equal(request.raw?.type, "application/x-git-bundle");
      const bytes = Buffer.from(request.raw!.bytes);
      const declared = job as unknown as { bundleSha256: string; bundleBytes: number };
      if (sha(bytes) !== declared.bundleSha256 || bytes.length !== declared.bundleBytes) return json({ error: "CODE_CLOUD_BUNDLE_INVALID" }, 400);
      job.bundle = bytes;
      job.status = "queued";
      return json(view(job));
    }
    if (url.pathname === "/api/code/cloud/patch") {
      const job = jobs.get(url.searchParams.get("job")!)!;
      return new Response(new Uint8Array(job.patchBytes!), { status: 200, headers: { "content-type": "text/x-diff" } });
    }
    return json({ error: "NOT_FOUND" }, 404);
  };
  return { jobs, requests, send, failOnce: () => { failNext = 1; } };
}

const catalog = async () => ({ kind: "ok" as const, value: { version: 3, contentHash: "hash", models: [
  { modelId: "gpt-6-luna", name: "GPT 6 Luna", provider: "openai", minimumPlan: "Pro" as const, channels: ["code"], capabilities: { structuredOutput: "json_mode" } },
  { modelId: "claude-haiku-4-5", name: "Claude Haiku", provider: "anthropic", minimumPlan: "Pro" as const, channels: ["code"], capabilities: { structuredOutput: "json_mode" } },
] } });

test("starting a cloud task uploads the snapshot it described, once, even after an unanswered create", async () => {
  const root = project();
  const server = fakeServer();
  const signal = new AbortController().signal;
  const host = createCloudExecutionHost({ client: createCloudExecutionClient({ send: server.send, signal }), catalog,
    project: async (): Promise<CloudProject> => ({ name: "demo", git: { root, executable: "git" } }), signal });
  server.failOnce();
  const view = await host.run({ action: "start", instruction: "Add a test", executorModelId: "gpt-6-luna", reviewerModelId: "claude-haiku-4-5", approvedCredits: 25 });
  assert.equal(view.notice?.kind, "started");
  assert.equal(server.jobs.size, 1);
  const creates = server.requests.filter((r) => (r.body as { action?: string } | undefined)?.action === "create");
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[0]!.body, creates[1]!.body);
  const [job] = [...server.jobs.values()];
  assert.equal(job!.status, "queued");
  assert.equal(job!.approvedCredits, 25);
  // The renderer never named a path or a model outside the catalogue; the request carries the catalogue pin.
  assert.equal((creates[0]!.body as { catalogVersion: number }).catalogVersion, 3);
  const refused = await host.run({ action: "start", instruction: "x", executorModelId: "not-in-catalogue", reviewerModelId: "claude-haiku-4-5", approvedCredits: 5 });
  assert.deepEqual(refused.notice, { kind: "refused", refusal: "unavailable" });
  rmSync(root, { recursive: true, force: true });
});

test("progress lines are merged by sequence, and a stop is sent for the job", async () => {
  const root = project();
  const server = fakeServer();
  const signal = new AbortController().signal;
  const host = createCloudExecutionHost({ client: createCloudExecutionClient({ send: server.send, signal }), catalog,
    project: async () => ({ name: "demo", git: { root, executable: "git" } }), signal });
  await host.run({ action: "start", instruction: "Do it", executorModelId: "gpt-6-luna", reviewerModelId: "claude-haiku-4-5", approvedCredits: 5 });
  const job = [...server.jobs.values()][0]!;
  job.status = "running";
  job.logs = [{ seq: 1, text: "Reading" }];
  let view = await host.run({ action: "read" });
  job.logs.push({ seq: 2, text: "Writing" });
  view = await host.run({ action: "read" });
  assert.deepEqual(view.jobs[0]!.logs.map((line) => line.text), ["Reading", "Writing"]);
  view = await host.run({ action: "cancel", jobId: job.jobId });
  assert.equal(view.jobs[0]!.cancelRequested, true);
  rmSync(root, { recursive: true, force: true });
});

test("changes are applied only after a review of that patch, to the folder the task came from", async () => {
  const root = project(), other = project();
  const server = fakeServer();
  const signal = new AbortController().signal;
  let open = root;
  const host = createCloudExecutionHost({ client: createCloudExecutionClient({ send: server.send, signal }), catalog,
    project: async () => ({ name: "demo", git: { root: open, executable: "git" } }), signal });
  await host.run({ action: "start", instruction: "Change a", executorModelId: "gpt-6-luna", reviewerModelId: "claude-haiku-4-5", approvedCredits: 5 });
  const job = [...server.jobs.values()][0]!;
  const patch = Buffer.from("diff --git a/a.txt b/a.txt\nindex 7898192..2e65efe 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n");
  Object.assign(job, { status: "completed", patch: { bytes: patch.length, sha256: sha(patch) }, patchBytes: patch });
  await host.run({ action: "read" });
  // Applying without having been shown the patch is refused.
  assert.deepEqual((await host.run({ action: "apply", jobId: job.jobId })).notice, { kind: "refused", refusal: "patchUnavailable" });
  open = other;
  assert.deepEqual((await host.run({ action: "review", jobId: job.jobId })).notice, { kind: "refused", refusal: "otherProject" });
  open = root;
  const reviewed = await host.run({ action: "review", jobId: job.jobId });
  assert.equal(reviewed.review?.applies, true);
  assert.equal(reviewed.review?.files[0]?.path, "a.txt");
  assert.equal(reviewed.review?.files[0]?.added, 1);
  const applied = await host.run({ action: "apply", jobId: job.jobId });
  assert.deepEqual(applied.notice, { kind: "applied", jobId: job.jobId });
  assert.equal(applied.review, null);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "b\n");
  // A patch whose bytes do not match the job's record is never used.
  Object.assign(job, { patchBytes: Buffer.from("tampered") });
  assert.deepEqual((await host.run({ action: "review", jobId: job.jobId })).notice, { kind: "refused", refusal: "patchUnavailable" });
  // A file the panel cannot name (a quoted path) makes the whole patch not offered for applying.
  const hidden = Buffer.from([
    String.raw`diff --git "a/x\ty.txt" "b/x\ty.txt"`, "new file mode 100644", "--- /dev/null", String.raw`+++ "b/x\ty.txt"`, "@@ -0,0 +1 @@", "+z", "",
  ].join("\n"));
  await host.run({ action: "start", instruction: "Add a file", executorModelId: "gpt-6-luna", reviewerModelId: "claude-haiku-4-5", approvedCredits: 5 });
  const second = [...server.jobs.values()].find((row) => row.instruction === "Add a file")!;
  Object.assign(second, { status: "completed", patch: { bytes: hidden.length, sha256: sha(hidden) }, patchBytes: hidden });
  await host.run({ action: "read" });
  const unseen = await host.run({ action: "review", jobId: second.jobId });
  assert.equal(unseen.review?.applies, false);
  assert.equal(unseen.review?.hidden, true);
  assert.deepEqual((await host.run({ action: "apply", jobId: second.jobId })).notice, { kind: "refused", refusal: "patchUnavailable" });
  // So does a binary file, whose content the panel cannot show either, even when the patch would apply.
  const binary = Buffer.from(["diff --git a/logo.bin b/logo.bin", "new file mode 100644", "index 0000000..f2e4113", "GIT binary patch",
    "literal 3", "KcmZQzWB>pF00961", "", "literal 0", "HcmV?d00001", "", ""].join("\n"));
  await host.run({ action: "start", instruction: "Add a logo", executorModelId: "gpt-6-luna", reviewerModelId: "claude-haiku-4-5", approvedCredits: 5 });
  const third = [...server.jobs.values()].find((row) => row.instruction === "Add a logo")!;
  Object.assign(third, { status: "completed", patch: { bytes: binary.length, sha256: sha(binary) }, patchBytes: binary });
  await host.run({ action: "read" });
  const opaque = await host.run({ action: "review", jobId: third.jobId });
  assert.equal(opaque.review?.files[0]?.omitted, "binary");
  assert.equal(opaque.review?.hidden, true);
  assert.equal(opaque.review?.applies, false);
  assert.deepEqual((await host.run({ action: "apply", jobId: third.jobId })).notice, { kind: "refused", refusal: "patchUnavailable" });
  rmSync(root, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

test("a failure code reads as a managed refusal or a runner reason", () => {
  assert.deepEqual(cloudFailureFor("CREDIT_BALANCE_INSUFFICIENT"), { kind: "managed", refusal: "insufficientCredits" });
  assert.deepEqual(cloudFailureFor("CODE_CLOUD_RUNNER_LOST"), { kind: "runner", reason: "lost" });
  assert.deepEqual(cloudFailureFor("CODE_CLOUD_AGENT_LIMIT_REACHED"), { kind: "runner", reason: "agent" });
  assert.deepEqual(cloudFailureFor("SOMETHING_ELSE"), { kind: "runner", reason: "other" });
  assert.equal(cloudFailureFor(null), null);
});
