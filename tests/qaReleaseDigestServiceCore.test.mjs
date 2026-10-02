import assert from "node:assert/strict";
import test from "node:test";

import { runQaReleaseDigestService } from "../lib/qaReleaseDigestServiceCore.ts";
import { qaReleaseDigestSchema } from "../lib/qaReleaseDigestSchemaCore.ts";

const SHA = "b".repeat(40);
const env = (overrides = {}) => ({
  PATH: "/usr/bin",
  RAILWAY_ENVIRONMENT_NAME: "staging",
  RAILWAY_GIT_COMMIT_SHA: SHA,
  QA_RELEASE_DIGEST_ENABLED: "true",
  QA_RELEASE_DIGEST_SECRET: "s".repeat(40),
  QA_RELEASE_GITHUB_READ_TOKEN: "read-token",
  QA_RELEASE_CONTROL_REVISION: "4",
  ...overrides,
});

const gateJson = JSON.stringify({
  classified: [
    { id: "ROUTE-01", status: "pending", verdict: "implemented_unmeasured", note: "free text" },
    { id: "MEMORY-01", status: "pending", verdict: "applicability_unknown" },
  ],
});

function ports(overrides = {}) {
  const calls = { scripts: [], posts: [] };
  const value = {
    calls,
    runScript: async (name, args, extraEnv) => {
      calls.scripts.push({ name, args: [...args], extraEnv });
      if (name === "report:release-gate-evidence") return { exitCode: 0, stdout: gateJson };
      if (name === "report:issue-backlog") {
        return { exitCode: 0, stdout: JSON.stringify({ classified: [{ number: 7, verdict: "open_work", title: "t" }] }) };
      }
      return { exitCode: name === "check:release-records" ? 1 : 0, stdout: "" };
    },
    collectCi: async () => ({ ci: [], releaseLane: [] }),
    postJson: async (url, headers, body) => {
      calls.posts.push({ url, headers, body });
      return { status: 201 };
    },
    now: () => new Date("2026-10-03T21:00:00.000Z"),
    ...overrides,
  };
  return value;
}

test("a full run builds a schema-valid digest and submits it to the fixed destination", async () => {
  const p = ports();
  assert.deepEqual(await runQaReleaseDigestService(env(), p), { exitCode: 0, outcome: "created" });
  assert.equal(p.calls.posts.length, 1);
  const [post] = p.calls.posts;
  assert.equal(post.url, "https://staging.tomverse.app/api/internal/agents/qa-release/digest");
  assert.equal(post.headers.authorization, `Bearer ${"s".repeat(40)}`);
  assert.equal(post.headers["x-qa-release-control-revision"], "4");
  const digest = qaReleaseDigestSchema.parse(JSON.parse(post.body));
  assert.equal(digest.digestDate, "2026-10-03");
  assert.equal(digest.baseSha, SHA);
  assert.equal(digest.runDeadline, "2026-10-03T21:15:00.000Z");
  assert.deepEqual(digest.issues.candidates, [7]);
  assert.deepEqual(
    digest.checks.find((c) => c.name === "check:release-records"),
    { name: "check:release-records", result: "fail" },
  );
  assert.equal(digest.hypothetical.length, 2);
  assert.equal(post.body.includes("free text"), false);
});

test("the read token reaches only the issue report, under the name it expects", async () => {
  const p = ports();
  await runQaReleaseDigestService(env(), p);
  const withToken = p.calls.scripts.filter((c) => c.extraEnv?.GITHUB_TOKEN);
  assert.deepEqual(withToken.map((c) => c.name), ["report:issue-backlog"]);
  assert.equal(withToken[0].extraEnv.GITHUB_TOKEN, "read-token");
});

test("switched off, refused, or without a commit it never runs a script", async () => {
  for (const [overrides, expected] of [
    [{ QA_RELEASE_DIGEST_ENABLED: "false" }, { exitCode: 0, outcome: "disabled" }],
    [{ DATABASE_URL: "postgres://x" }, { exitCode: 1, outcome: "refused_to_start" }],
    [{ RAILWAY_GIT_COMMIT_SHA: "main" }, { exitCode: 1, outcome: "base_sha_unknown" }],
  ]) {
    const p = ports();
    assert.deepEqual(await runQaReleaseDigestService(env(overrides), p), expected, JSON.stringify(overrides));
    assert.equal(p.calls.scripts.length, 0);
    assert.equal(p.calls.posts.length, 0);
  }
});

test("no gate report means no submission; a missing issue report or CI read is said, not hidden", async () => {
  const failed = ports({ runScript: async () => ({ exitCode: 1, stdout: "" }) });
  assert.deepEqual(await runQaReleaseDigestService(env(), failed), { exitCode: 1, outcome: "gate_report_failed" });
  assert.equal(failed.calls.posts.length, 0);

  const partial = ports({ collectCi: async () => null });
  const original = partial.runScript;
  partial.runScript = async (name, args, extraEnv) =>
    name === "report:issue-backlog" ? { exitCode: 1, stdout: "" } : original(name, args, extraEnv);
  await runQaReleaseDigestService(env(), partial);
  const digest = JSON.parse(partial.calls.posts[0].body);
  assert.equal(digest.issues.status, "unavailable");
  assert.ok(digest.notChecked.includes("issue_backlog_unavailable"));
  assert.ok(digest.notChecked.includes("github_read_unavailable"));
});

test("a refusal or an unknown outcome fails the run once, never retried", async () => {
  for (const [status, outcome] of [
    [409, "submission_refused"],
    [401, "submission_refused"],
    [503, "submission_outcome_unknown"],
  ]) {
    const p = ports({ postJson: async (url, headers, body) => (p.calls.posts.push({ url, headers, body }), { status }) });
    assert.deepEqual(await runQaReleaseDigestService(env(), p), { exitCode: 1, outcome, status });
    assert.equal(p.calls.posts.length, 1);
  }
  const thrown = ports({ postJson: async () => { throw new Error("socket hang up"); } });
  assert.deepEqual(await runQaReleaseDigestService(env(), thrown), { exitCode: 1, outcome: "submission_outcome_unknown" });
  const replay = ports({ postJson: async () => ({ status: 200 }) });
  assert.deepEqual(await runQaReleaseDigestService(env(), replay), { exitCode: 0, outcome: "replayed" });
});
