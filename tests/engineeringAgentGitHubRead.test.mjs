import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ENGINEERING_AGENT_GITHUB_READ_TOKEN_ENV,
  EngineeringAgentGitHubReadError,
  readEngineeringAgentBacklogAt,
  readEngineeringAgentCheckRunsAt,
  readEngineeringAgentDependabotFailures,
  readEngineeringAgentDevelopChecks,
  readEngineeringAgentDevelopHead,
  readEngineeringAgentGitBlob,
  readEngineeringAgentPinnedBaseTree,
  readEngineeringAgentPullObservation,
} from "../lib/engineeringAgentGitHubRead.ts";

// The app's read-only GitHub view for registration (docs/policy/engineering-
// agent.md §2.2, §8): one fixed repository, a pinned commit that must be on
// the source's branch, whole answers only, and errors that carry a code only.

const env = { [ENGINEERING_AGENT_GITHUB_READ_TOKEN_ENV]: "read-only-token" };
const PIN = "a".repeat(40);
const NEXT = '<https://api.github.com/repositories/1/pulls?page=2>; rel="next", <https://api.github.com/repositories/1/pulls?page=3>; rel="last"';

/** Routes answer a body, or `{ body, link }` to also send a Link header. */
const fakeFetch = (routes) => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init });
    const path = String(url).replace("https://api.github.com/repos/mposition/Tomverse", "");
    const handler = routes[path.split("?")[0]];
    if (!handler) return new Response("{}", { status: 404 });
    const answer = handler(path);
    const withLink = answer !== null && typeof answer === "object" && "link" in answer;
    return new Response(JSON.stringify(withLink ? answer.body : answer), {
      status: 200,
      headers: withLink ? { link: answer.link } : {},
    });
  };
  return { fetchImpl, seen };
};

const runs = (list) => ({ total_count: list.length, check_runs: list });

test("v22 publication pins a read-only develop head, never a caller URL", async () => {
  const { fetchImpl, seen } = fakeFetch({
    "/commits/develop": () => ({ sha: PIN }),
  });
  assert.equal(await readEngineeringAgentDevelopHead({ env, fetchImpl }), PIN);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.method, "GET");
  assert.equal(seen[0].init.redirect, "error");
  assert.match(seen[0].url, /\/repos\/mposition\/Tomverse\/commits\/develop$/);
  await assert.rejects(readEngineeringAgentDevelopHead({ env, fetchImpl:
    fakeFetch({ "/commits/develop": () => ({ sha: "not-a-commit" }) }).fetchImpl }),
  /invalid_response/);
});

test("v22 base tree is complete, self-consistent and read from the fixed repo", async () => {
  const blob = Buffer.from("hello\n");
  const blobId = createHash("sha1").update(`blob ${blob.length}\0`)
    .update(blob).digest("hex");
  const treeBody = Buffer.concat([Buffer.from("100644 safe.txt\0"),
    Buffer.from(blobId, "hex")]);
  const treeId = createHash("sha1").update(`tree ${treeBody.length}\0`)
    .update(treeBody).digest("hex");
  const routes = {
    "/commits/develop": () => ({ sha: PIN }),
    [`/git/commits/${PIN}`]: () => ({ sha: PIN, tree: { sha: treeId },
      verification: { verified: true, payload:
        `tree ${treeId}\ncommitter GitHub <noreply@github.com> 1791336934 +1000\n\nmessage\n` },
    }),
    [`/git/trees/${treeId}`]: () => ({ sha: treeId, truncated: false,
      tree: [{ path: "safe.txt", type: "blob", mode: "100644",
        sha: blobId }] }),
  };
  const { fetchImpl, seen } = fakeFetch(routes);
  assert.deepEqual(await readEngineeringAgentPinnedBaseTree(PIN, { env, fetchImpl }),
    { base: [{ path: "safe.txt", type: "blob", mode: "100644",
      oid: blobId }], rootTreeId: treeId, baseGitattributes: null,
      baseCommitterDate: "1791336934 +1000" });
  assert.ok(seen.every((call) => call.init.method === "GET"));
  const unsigned = await readEngineeringAgentPinnedBaseTree(PIN, { env,
    fetchImpl: fakeFetch({ ...routes,
      [`/git/commits/${PIN}`]: () => ({ sha: PIN,
        tree: { sha: treeId }, verification: { verified: false,
          payload: null } }),
    }).fetchImpl });
  assert.equal(unsigned.baseCommitterDate, null);
  const messageSpoof = await readEngineeringAgentPinnedBaseTree(PIN, { env,
    fetchImpl: fakeFetch({ ...routes,
      [`/git/commits/${PIN}`]: () => ({ sha: PIN,
        tree: { sha: treeId }, verification: { verified: true,
          payload: `tree ${treeId}\nauthor A <a@example.com> 1791336934 +1000\n\ncommitter Spoof <s@example.com> 1791336934 +1000\n` } }),
    }).fetchImpl });
  assert.equal(messageSpoof.baseCommitterDate, null);
  await assert.rejects(readEngineeringAgentPinnedBaseTree(PIN, { env,
    fetchImpl: fakeFetch({ ...routes,
      [`/git/trees/${treeId}`]: () => ({ sha: treeId, truncated: true,
        tree: [] }) }).fetchImpl }), /invalid_response/);
  await assert.rejects(readEngineeringAgentPinnedBaseTree("b".repeat(40),
    { env, fetchImpl }), /invalid_input/);
  // A tier read after settlement: develop moved on, and the base is still
  // one of its commits only when GitHub says the head contains it.
  const moved = "c".repeat(40);
  const movedRoutes = (compare) => fakeFetch({ ...routes,
    "/commits/develop": () => ({ sha: moved }),
    [`/compare/${PIN}...${moved}`]: () => compare }).fetchImpl;
  const contained = { status: "ahead", behind_by: 0,
    merge_base_commit: { sha: PIN } };
  assert.equal((await readEngineeringAgentPinnedBaseTree(PIN,
    { env, fetchImpl: movedRoutes(contained) }, { onDevelop: true })).rootTreeId,
  treeId);
  await assert.rejects(readEngineeringAgentPinnedBaseTree(PIN,
    { env, fetchImpl: movedRoutes(contained) }), /invalid_input/);
  for (const compare of [{ ...contained, status: "diverged" },
    { ...contained, behind_by: 1 },
    { ...contained, merge_base_commit: { sha: "d".repeat(40) } }])
    await assert.rejects(readEngineeringAgentPinnedBaseTree(PIN,
      { env, fetchImpl: movedRoutes(compare) }, { onDevelop: true }),
    /invalid_input/);
  const blobFetch = fakeFetch({ [`/git/blobs/${blobId}`]: () => ({
    sha: blobId, encoding: "base64", size: blob.length,
    content: blob.toString("base64"),
  }) }).fetchImpl;
  assert.deepEqual(Buffer.from(await readEngineeringAgentGitBlob(blobId,
    { env, fetchImpl: blobFetch })), blob);
  await assert.rejects(readEngineeringAgentGitBlob(blobId, { env,
    fetchImpl: fakeFetch({ [`/git/blobs/${blobId}`]: () => ({
      sha: blobId, encoding: "base64", size: blob.length,
      content: Buffer.from("wrong").toString("base64"),
    }) }).fetchImpl }), /invalid_response/);
});

test("the backlog is read at the pin only when the pin is on the backlog branch", async () => {
  const text = "| ID | 상태·분류 | 다음 완료 단위 |\n|---|---|---|\n| ENG-1 | P2 진행 | 다음 |\n";
  const content = Buffer.from(text, "utf8").toString("base64");
  const branch = encodeURIComponent("codex/product-idea-backlog-2026-09-15");
  const file = { type: "file", encoding: "base64", content };
  for (const status of ["identical", "ahead"]) {
    const { fetchImpl, seen } = fakeFetch({
      [`/compare/${PIN}...${branch}`]: () => ({ status }),
      "/contents/.github/audits/tomverse-product-idea-backlog.md": () => file,
    });
    assert.equal(await readEngineeringAgentBacklogAt(PIN, { env, fetchImpl }), text);
    assert.ok(seen.every((call) => call.init.method === "GET"), "only reads");
    assert.ok(seen.every((call) => call.init.headers.Authorization === "Bearer read-only-token"));
    assert.ok(seen.some((call) => call.url.includes(`ref=${PIN}`)), "the file is read at the pin");
  }
  for (const status of ["behind", "diverged"]) {
    const { fetchImpl } = fakeFetch({
      [`/compare/${PIN}...${branch}`]: () => ({ status }),
      "/contents/.github/audits/tomverse-product-idea-backlog.md": () => file,
    });
    await assert.rejects(readEngineeringAgentBacklogAt(PIN, { env, fetchImpl }), /invalid_input/);
  }
});

test("a backlog that holds a NUL is not text, and the whole source is refused", async () => {
  const branch = encodeURIComponent("codex/product-idea-backlog-2026-09-15");
  const content = Buffer.from("| ID | 상태·분류 | 다음 완료 단위 |\n|---|---|---|\n| ENG-1 | P2\u0000 | 다음 |\n", "utf8").toString("base64");
  const { fetchImpl } = fakeFetch({
    [`/compare/${PIN}...${branch}`]: () => ({ status: "identical" }),
    "/contents/.github/audits/tomverse-product-idea-backlog.md": () => ({ type: "file", encoding: "base64", content }),
  });
  await assert.rejects(readEngineeringAgentBacklogAt(PIN, { env, fetchImpl }), /not_text/);
});

test("an S2 pin is develop's CI only when it is develop's head or behind it", async () => {
  const checks = runs([{ id: 1, name: "unit", conclusion: "failure" }]);
  for (const status of ["identical", "ahead"]) {
    const { fetchImpl } = fakeFetch({
      [`/compare/${PIN}...develop`]: () => ({ status }),
      [`/commits/${PIN}/check-runs`]: () => checks,
    });
    assert.deepEqual(await readEngineeringAgentCheckRunsAt(PIN, { env, fetchImpl }), checks.check_runs);
  }
  for (const status of ["behind", "diverged"]) {
    const { fetchImpl, seen } = fakeFetch({
      [`/compare/${PIN}...develop`]: () => ({ status }),
      [`/commits/${PIN}/check-runs`]: () => checks,
    });
    await assert.rejects(readEngineeringAgentCheckRunsAt(PIN, { env, fetchImpl }), /invalid_input/);
    assert.equal(seen.some((call) => call.url.includes("/check-runs")), false, "a commit off develop is never read");
  }
});

test("a pin, a token and an answer are all checked before anything is trusted", async () => {
  await assert.rejects(readEngineeringAgentBacklogAt("main", { env, fetchImpl: fetch }), /invalid_input/);
  await assert.rejects(readEngineeringAgentCheckRunsAt(PIN, { env: {}, fetchImpl: fetch }), /not_configured/);
  const { fetchImpl } = fakeFetch({
    [`/compare/${PIN}...develop`]: () => ({ status: "identical" }),
    [`/commits/${PIN}/check-runs`]: () => runs([{ name: "x" }]),
  });
  await assert.rejects(readEngineeringAgentCheckRunsAt(PIN, { env, fetchImpl }), (error) => {
    assert.ok(error instanceof EngineeringAgentGitHubReadError);
    assert.equal(error.message, "invalid_response", "the error carries a code, never upstream text");
    return true;
  });
});

test("a page that is not the whole list is refused, not read as the whole", async () => {
  const head = "d".repeat(40);
  const one = [{ id: 1, name: "unit", conclusion: "success" }];
  const cases = [
    { total_count: 101, check_runs: one },
    { body: runs(one), link: NEXT },
  ];
  for (const answer of cases) {
    const { fetchImpl } = fakeFetch({
      "/commits/develop": () => ({ sha: head }),
      [`/commits/${head}/check-runs`]: () => answer,
    });
    await assert.rejects(readEngineeringAgentDevelopChecks({ env, fetchImpl }), /invalid_response/);
  }
  const { fetchImpl } = fakeFetch({
    "/pulls": () => ({ body: [{ number: 7, user: { login: "someone" }, head: { sha: head } }], link: NEXT }),
  });
  await assert.rejects(
    readEngineeringAgentDependabotFailures({ env, fetchImpl }),
    /invalid_response/,
    "dependabot's pull requests may be on the next page: the author is never filtered from a cut list",
  );
});

test("only dependabot's open pull requests are read, and only their failing checks count", async () => {
  const head = "b".repeat(40);
  const other = "c".repeat(40);
  const { fetchImpl } = fakeFetch({
    "/pulls": () => [
      { number: 7, user: { login: "dependabot[bot]" }, head: { sha: head } },
      { number: 8, user: { login: "someone" }, head: { sha: other } },
    ],
    [`/commits/${head}/check-runs`]: () =>
      runs([
        { id: 1, name: "unit", conclusion: "failure" },
        { id: 2, name: "lint", conclusion: "success" },
        { id: 3, name: "e2e", conclusion: "timed_out" },
      ]),
  });
  assert.deepEqual(await readEngineeringAgentDependabotFailures({ env, fetchImpl }), [
    { prNumber: 7, headSha: head, failingChecks: ["unit", "e2e"] },
  ]);
});

/* The approval observer's read of one published pull request (engineering-agent.md §9-10). */


const pullFetch = (overrides = {}) => {
  const HEAD = "1".repeat(40);
  const diff = "diff --git a/x b/x\n+one\n";
  const routes = {
    "/pulls/42": (accept) => accept === "application/vnd.github.diff" ? diff : {
      number: 42, state: "open", merged: false, merge_commit_sha: null, merged_at: null, merged_by: null,
      changed_files: 1,
      base: { ref: "develop", sha: "2".repeat(40) }, head: { sha: HEAD }, ...overrides.pull,
    },
    "/pulls/42/files": (_accept, url) =>
      typeof overrides.files === "function" ? overrides.files(url) :
        overrides.files ?? [{ filename: "components/chat/Ordinary.tsx",
          status: "modified" }],
    "/pulls/42/reviews": () => overrides.reviews ?? [
      { id: 9, user: { id: 60078951, login: "mposition" }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-10-15T05:30:00Z" },
      { id: 10, user: { id: 60078951, login: "mposition" }, state: "PENDING", commit_id: HEAD },
    ],
    "/branches/develop": () => overrides.branch ?? { protection: { required_status_checks: { checks: [{ context: "Fast Gate" }, { context: "status-only" }] } } },
    [`/commits/${HEAD}/check-runs`]: () => runs(overrides.runs ?? [
      { id: 1, name: "Fast Gate", conclusion: "failure" }, { id: 2, name: "Fast Gate", conclusion: "success" },
    ]),
    [`/commits/${HEAD}/status`]: () => overrides.status ?? { statuses: [{ context: "status-only", state: "success" }] },
  };
  return {
    diff,
    fetchImpl: async (url, init) => {
      const path = String(url).replace("https://api.github.com/repos/mposition/Tomverse", "").split("?")[0];
      const handler = routes[path];
      if (!handler) return new Response("{}", { status: 404 });
      const answer = handler(init.headers.Accept, String(url));
      const body = answer?.body ?? answer;
      return new Response(typeof body === "string" ? body : JSON.stringify(body),
        { status: 200, headers: answer?.link ? { Link: answer.link } : {} });
    },
  };
};

test("a published pull request is read with its reviews, required checks and diff digest", async () => {
  const { fetchImpl, diff } = pullFetch();
  const observed = await readEngineeringAgentPullObservation(42, { env, fetchImpl });
  assert.equal(observed.state, "open");
  assert.equal(observed.merged, false);
  assert.equal(observed.baseRef, "develop");
  // The newest re-run of a required check counts, and a status context is read too.
  assert.deepEqual(observed.requiredChecks, { allPassed: true });
  // A pending review is the reviewer's draft and is not read.
  assert.deepEqual(observed.reviews.map((review) => [review.id, review.login]), [[9, "mposition"]]);
  assert.equal(observed.diffDigest, createHash("sha256").update(diff).digest("hex"));
});

test("a check still running or missing decides nothing; a failed one is a failure", async () => {
  const read = (overrides) => readEngineeringAgentPullObservation(42, { env, fetchImpl: pullFetch(overrides).fetchImpl });
  assert.equal((await read({ runs: [{ id: 2, name: "Fast Gate", conclusion: null }] })).requiredChecks, null);
  assert.equal((await read({ status: { statuses: [] } })).requiredChecks, null);
  assert.equal((await read({ branch: {} })).requiredChecks, null);
  assert.deepEqual((await read({ runs: [{ id: 3, name: "Fast Gate", conclusion: "timed_out" }] })).requiredChecks, { allPassed: false });
  assert.deepEqual((await read({ status: { statuses: [{ context: "status-only", state: "error" }] } })).requiredChecks, { allPassed: false });
  // A check run and a status of the same required name must both pass.
  const both = [{ context: "status-only", state: "success" }];
  assert.deepEqual((await read({ status: { statuses: [...both, { context: "Fast Gate", state: "failure" }] } })).requiredChecks, { allPassed: false });
  assert.equal((await read({ status: { statuses: [...both, { context: "Fast Gate", state: "pending" }] } })).requiredChecks, null);
});

test("a merge is read as its commit, time and merger kind; a merge without them is refused", async () => {
  const merged = { state: "closed", merged: true, merge_commit_sha: "3".repeat(40), merged_at: "2026-10-15T06:00:00Z", merged_by: { type: "User" } };
  const observed = await readEngineeringAgentPullObservation(42, { env, fetchImpl: pullFetch({ pull: merged }).fetchImpl });
  assert.equal(observed.mergeCommitSha, "3".repeat(40));
  assert.equal(observed.mergedAt.toISOString(), "2026-10-15T06:00:00.000Z");
  assert.equal(observed.mergedByKind, "user");
  assert.deepEqual(observed.changedFiles, ["components/chat/Ordinary.tsx"]);
  await assert.rejects(
    readEngineeringAgentPullObservation(42, { env, fetchImpl: pullFetch({ pull: { ...merged, merge_commit_sha: null } }).fetchImpl }),
    (error) => error instanceof EngineeringAgentGitHubReadError && error.code === "invalid_response",
  );
  await assert.rejects(readEngineeringAgentPullObservation(0, { env, fetchImpl: pullFetch().fetchImpl }));
});

test("merged PR file names are complete and include a rename source", async () => {
  const merged = { state: "closed", merged: true,
    merge_commit_sha: "3".repeat(40), merged_at: "2026-10-15T06:00:00Z" };
  const read = (overrides) => readEngineeringAgentPullObservation(42,
    { env, fetchImpl: pullFetch({ pull: merged, ...overrides }).fetchImpl });
  assert.deepEqual((await read({ files: [{ filename: "src/new.ts",
    previous_filename: "lib/amux/old.ts", status: "renamed" }] })).changedFiles,
  ["src/new.ts", "lib/amux/old.ts"]);
  assert.equal((await read({ pull: { ...merged, changed_files: 2 } })).changedFiles, null);
  assert.equal((await read({ files: [{ filename: "src/new.ts",
    status: "renamed" }] })).changedFiles, null);
});

test("merged PR file names span pages and transient read errors remain unreadable", async () => {
  const merged = { state: "closed", merged: true,
    merge_commit_sha: "3".repeat(40), merged_at: "2026-10-15T06:00:00Z",
    changed_files: 101 };
  const names = Array.from({ length: 101 }, (_, index) =>
    ({ filename: `src/file-${index}.ts`, status: "modified" }));
  const files = (url) => new URL(url).searchParams.get("page") === "1" ?
    { body: names.slice(0, 100),
      link: '<https://api.github.com/repos/mposition/Tomverse/pulls/42/files?per_page=100&page=2>; rel="next"' } :
    names.slice(100);
  const { fetchImpl } = pullFetch({ pull: merged, files });
  const observed = await readEngineeringAgentPullObservation(42,
    { env, fetchImpl });
  assert.deepEqual(observed.changedFiles, names.map((file) => file.filename));
  const failSecondPage = (url, init) => String(url).includes("/files?") &&
    String(url).includes("page=2") ?
    new Response("unavailable", { status: 503 }) : fetchImpl(url, init);
  await assert.rejects(readEngineeringAgentPullObservation(42,
    { env, fetchImpl: failSecondPage }),
  (error) => error instanceof EngineeringAgentGitHubReadError &&
    error.code === "http_error");
  const missingSecondPage = pullFetch({ pull: merged,
    files: (url) => new URL(url).searchParams.get("page") === "1" ?
      names.slice(0, 100) : names.slice(100) });
  assert.equal((await readEngineeringAgentPullObservation(42,
    { env, fetchImpl: missingSecondPage.fetchImpl })).changedFiles, null);
});
