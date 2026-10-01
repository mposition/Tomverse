import assert from "node:assert/strict";
import test from "node:test";

import { collectAmuxIdeaPullRequestFileList } from "../lib/amux/ideaPullRequestFileListAdapter.ts";

const ID = 25;
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const ROOT = "/repos/mposition/Tomverse";

function fixture() {
  const calls = [];
  const state = {
    repo: { id: ID, full_name: "mposition/Tomverse" },
    repoAfter: null,
    before: {
      number: 17, changed_files: 2,
      base: { sha: BASE, repo: { id: ID } },
      head: { sha: HEAD, repo: { id: ID } },
    },
    after: null,
    files: [
      { filename: "docs/new.md", previous_filename: "docs/old.md", status: "renamed" },
      { filename: "lib/changed.ts", status: "modified" },
    ],
    link: null,
    fileResponse: null,
  };
  let prReads = 0;
  let repoReads = 0;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ path: `${parsed.pathname}${parsed.search}`, init });
    if (parsed.pathname === ROOT) {
      return Response.json(repoReads++ === 0 ? state.repo : state.repoAfter ?? state.repo);
    }
    if (parsed.pathname === `${ROOT}/pulls/17`) {
      const body = prReads++ === 0 ? state.before : state.after ?? state.before;
      return Response.json(body);
    }
    if (parsed.pathname === `${ROOT}/pulls/17/files`) {
      if (state.fileResponse) return state.fileResponse;
      return Response.json(state.files, {
        headers: state.link ? { link: state.link } : {},
      });
    }
    throw new Error("unexpected endpoint");
  };
  const config = {
    owner: "mposition", repo: "Tomverse", expectedRepositoryId: ID,
    token: "test-read-token", fetchImpl,
  };
  return { state, calls, config };
}

test("collector proves a bounded same-repository PR file page without returning bytes", async () => {
  const item = fixture();
  const result = await collectAmuxIdeaPullRequestFileList(item.config, 17);
  assert.deepEqual(result, {
    status: "complete", repositoryId: ID, number: 17,
    baseSha: BASE, headSha: HEAD,
    basePaths: ["docs/old.md", "lib/changed.ts"],
    headPaths: ["docs/new.md", "lib/changed.ts"],
  });
  assert.deepEqual(item.calls.map(({ path }) => path), [
    ROOT, `${ROOT}/pulls/17`, `${ROOT}/pulls/17/files?per_page=100&page=1`,
    `${ROOT}/pulls/17`, ROOT,
  ]);
  assert(item.calls.every(({ init }) => init.method === "GET" &&
    init.redirect === "error" && init.cache === "no-store" &&
    init.headers.Authorization === "Bearer test-read-token"));
});

test("collector holds changed PR snapshot and incomplete pagination", async () => {
  const drift = fixture();
  drift.state.after = {
    ...drift.state.before,
    head: { sha: "c".repeat(40), repo: { id: ID } },
  };
  assert.deepEqual(await collectAmuxIdeaPullRequestFileList(drift.config, 17),
    { status: "hold", reason: "pr_snapshot_unverified" });

  const paged = fixture();
  paged.state.link = `<https://api.github.com${ROOT}/pulls/17/files?per_page=100&page=2>; rel=next`;
  assert.deepEqual(await collectAmuxIdeaPullRequestFileList(paged.config, 17),
    { status: "hold", reason: "file_list_incomplete" });
});

test("collector never fetches a fork, oversized list, or wrong repository", async () => {
  const fork = fixture();
  fork.state.before.head.repo.id = 99;
  assert.deepEqual(await collectAmuxIdeaPullRequestFileList(fork.config, 17),
    { status: "hold", reason: "pr_snapshot_unverified" });
  assert.equal(fork.calls.length, 2);

  const large = fixture();
  large.state.before.changed_files = 101;
  assert.deepEqual(await collectAmuxIdeaPullRequestFileList(large.config, 17),
    { status: "hold", reason: "pr_snapshot_unverified" });
  assert.equal(large.calls.length, 2);

  const wrong = fixture();
  wrong.state.repo.id = 99;
  assert.deepEqual(await collectAmuxIdeaPullRequestFileList(wrong.config, 17),
    { status: "hold", reason: "wrong_repository" });
  assert.equal(wrong.calls.length, 1);

  const lateWrong = fixture();
  lateWrong.state.repoAfter = { id: 99, full_name: "mposition/Tomverse" };
  assert.deepEqual(await collectAmuxIdeaPullRequestFileList(lateWrong.config, 17),
    { status: "hold", reason: "wrong_repository" });
  assert.equal(lateWrong.calls.length, 5);
});

test("collector normalizes absent previous_filename but rejects malformed file data", async () => {
  const absent = fixture();
  assert.equal((await collectAmuxIdeaPullRequestFileList(absent.config, 17)).status, "complete");

  const malformed = fixture();
  malformed.state.files[0].previous_filename = null;
  assert.deepEqual(await collectAmuxIdeaPullRequestFileList(malformed.config, 17),
    { status: "hold", reason: "invalid_response" });

  const invalidPath = fixture();
  invalidPath.state.files[0].filename = "../secret";
  assert.deepEqual(await collectAmuxIdeaPullRequestFileList(invalidPath.config, 17),
    { status: "hold", reason: "file_list_invalid" });
});

test("collector holds HTTP, content-type, UTF-8 and response-size failures", async () => {
  const cases = [
    [new Response("unavailable", { status: 429 }), "http_error"],
    [new Response("<html>error</html>", { headers: { "content-type": "text/html" } }), "invalid_response"],
    [new Response(Uint8Array.of(0xff), { headers: { "content-type": "application/json" } }), "invalid_response"],
    [new Response(" ".repeat(2 * 1024 * 1024 + 1),
      { headers: { "content-type": "application/json" } }), "oversized_response"],
  ];
  for (const [response, reason] of cases) {
    const item = fixture();
    item.state.fileResponse = response;
    assert.deepEqual(await collectAmuxIdeaPullRequestFileList(item.config, 17),
      { status: "hold", reason });
  }
});

test("collector rejects whitespace token and a changed base SHA", async () => {
  const invalid = fixture();
  invalid.config.token = " test-read-token ";
  assert.deepEqual(await collectAmuxIdeaPullRequestFileList(invalid.config, 17),
    { status: "hold", reason: "invalid_collector_config" });
  assert.equal(invalid.calls.length, 0);

  const drift = fixture();
  drift.state.after = {
    ...drift.state.before,
    base: { sha: "c".repeat(40), repo: { id: ID } },
  };
  assert.deepEqual(await collectAmuxIdeaPullRequestFileList(drift.config, 17),
    { status: "hold", reason: "pr_snapshot_unverified" });
});

test("transport failure holds without leaking upstream text", async () => {
  const item = fixture();
  item.config.fetchImpl = async () => { throw new Error("TOKEN=do-not-log"); };
  const result = await collectAmuxIdeaPullRequestFileList(item.config, 17);
  assert.deepEqual(result, { status: "hold", reason: "transport_error" });
  assert(!JSON.stringify(result).includes("do-not-log"));
});
