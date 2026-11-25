import assert from "node:assert/strict";
import test from "node:test";
import { githubPullUrl } from "../src/github-pr-contract";
import { readGithubPull } from "../src/host/github-pr-read";

const head = "a".repeat(40);
const nextHead = "b".repeat(40);
const merge = "c".repeat(40);
const signal = new AbortController().signal;
const link = { url: "https://github.com/example/project/pull/34", environment: "production" };
const pull = { number: 34, head: { sha: head }, base: { ref: "main", repo: { full_name: "Example/project" } },
  mergeable: true, merged: false, merge_commit_sha: null, state: "open" };
const oneRun = { name: "build", head_sha: head, conclusion: "success", app: { id: 7 } };

function fixture(options: {
  forcePush?: boolean;
  moved?: boolean;
  conflict?: boolean;
  merge?: boolean;
  noProtection?: boolean;
  wrongApp?: boolean;
  conclusion?: string | null;
  optionalFailure?: boolean;
  outdatedCheck?: boolean;
  deployment?: "success" | "failure" | "queued" | "wrongEnvironment" | "wrongCommit";
} = {}) {
  let detailCount = 0;
  return async (path: string) => {
    assert.ok(path.startsWith("/repos/example/project/"), path);
    if (path.endsWith("/pulls/34")) {
      detailCount += 1;
      return { ...pull, head: { sha: options.forcePush && detailCount > 1 ? nextHead : head },
        ...(options.moved ? { base: { ...pull.base, repo: { full_name: "New/project" } } } : {}),
        mergeable: !options.conflict, merged: Boolean(options.merge), state: options.merge ? "closed" : "open",
        merge_commit_sha: options.merge ? merge : null };
    }
    if (path.includes("/check-runs?")) return { total_count: options.optionalFailure ? 2 : 1,
      check_runs: [{ ...oneRun, head_sha: options.outdatedCheck ? nextHead : head,
        app: { id: options.wrongApp ? 111 : 7 }, conclusion: options.conclusion === undefined ? "success" : options.conclusion },
        ...(options.optionalFailure ? [{ ...oneRun, name: "optional", conclusion: "failure" }] : [])] };
    if (path.includes("/status?")) return { sha: head, total_count: 0, statuses: [] };
    if (path.endsWith("/protection/required_status_checks")) {
      if (options.noProtection) throw new Error("GitHub API permission denied");
      return { checks: [{ context: "build", app_id: 7 }] };
    }
    if (path.endsWith("/rules/branches/main")) return [{ type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "build", integration_id: 7 }] } }];
    if (path.includes("/deployments?")) {
      const query = new URL("https://api.github.com" + path).searchParams;
      assert.equal(query.get("sha"), merge);
      assert.equal(query.get("environment"), "production");
      return options.deployment
        ? [{ id: 3, environment: options.deployment === "wrongEnvironment" ? "preview" : "production",
          sha: options.deployment === "wrongCommit" ? head : merge, created_at: "2026-10-20T12:00:00Z" }] : [];
    }
    if (path.includes("/deployments/3/statuses?")) return [
      { id: 1, state: "success", environment: "production", created_at: "2026-10-20T12:10:00Z" },
      { id: 2, state: options.deployment, environment: "production", created_at: "2026-10-20T12:20:00Z" },
    ];
    throw new Error("Unexpected GitHub endpoint " + path);
  };
}

test("Only canonical public GitHub pull request URLs can be paired", () => {
  assert.deepEqual(githubPullUrl(link.url), { url: link.url, repo: "example/project", number: 34 });
  for (const invalid of ["https://github.com.evil.example/example/project/pull/34", link.url + "?ref=123",
    "https://github.com/example/../pull/34", "https://bob@github.com/example/project/pull/34", "file:///repo/pull/34"]) {
    assert.equal(githubPullUrl(invalid), null, invalid);
  }
});

test("PR status honors current head, merge conflicts and proven required checks", async () => {
  for (const [options, status] of [
    [{}, "passed"], [{ optionalFailure: true }, "passed"], [{ conclusion: "failure", conflict: true }, "failed"], [{ conflict: true }, "conflict"],
    [{ conclusion: "skipped" }, "pending"], [{ conclusion: null }, "pending"], [{ wrongApp: true }, "pending"],
    [{ noProtection: true }, "unknown"], [{ forcePush: true, conclusion: "failure" }, "unknown"],
    [{ outdatedCheck: true, conclusion: "failure" }, "unknown"], [{ moved: true }, "unavailable"],
  ] as const) {
    assert.equal((await readGithubPull(link, signal, fixture(options))).state, status, JSON.stringify(options));
  }
});

test("A failed required check retains simultaneous conflict detail", async () => {
  const record = await readGithubPull(link, signal, fixture({ conclusion: "failure", conflict: true }));
  assert.equal(record.state, "failed");
  assert.equal(record.conflict, true);
});

test("Deployment evidence must identify the exact merged revision and target environment", async () => {
  for (const [deployment, status] of [
    ["success", "deployed"], ["failure", "deploy_failed"], ["queued", "deploy_pending"], ["wrongEnvironment", "merged"], ["wrongCommit", "merged"], [undefined, "merged"],
  ] as const) {
    const record = await readGithubPull(link, signal, fixture({ merge: true, deployment }));
    assert.equal(record.merge, merge);
    assert.equal(record.state, status);
  }
});
