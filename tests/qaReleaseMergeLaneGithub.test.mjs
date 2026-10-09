import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  QA_RELEASE_APP_TOKEN_PERMISSIONS,
  createQaReleaseGithubPorts,
  qaReleaseAppJwt,
  qaReleaseInstallationToken,
} from "../lib/qaReleaseMergeLaneGithub.ts";

const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const TIP = "c".repeat(40);
const API = "https://api.github.com";
const REPO = `${API}/repos/mposition/Tomverse`;

const json = (status, body) => ({ status, text: JSON.stringify(body) });

/** A fake GitHub: routes by method and URL, records every call. */
function fakeHttp(routes) {
  const calls = [];
  const http = async (request) => {
    calls.push(request);
    for (const [match, answer] of routes) {
      if (match(request)) return typeof answer === "function" ? answer(request) : answer;
    }
    return json(404, { message: "Not Found" });
  };
  return { http, calls };
}
const is = (method, url) => (request) => request.method === method && request.url === url;
const startsWith = (method, prefix) => (request) => request.method === method && request.url.startsWith(prefix);

const graphqlPull = (overrides = {}) => ({
  number: 12,
  createdAt: "2026-10-04T00:00:00Z",
  baseRefName: "develop",
  headRefName: "claude/to-develop/x",
  headRefOid: HEAD,
  isDraft: false,
  mergeable: "MERGEABLE",
  state: "OPEN",
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              pageInfo: { hasNextPage: false },
              nodes: [
                { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", checkSuite: { workflowRun: { workflow: { name: "PR Fast Gate" } } } },
                { __typename: "StatusContext", context: "railway", state: "SUCCESS" },
              ],
            },
          },
        },
      },
    ],
  },
  ...overrides,
});

const ports = (routes) => {
  const fake = fakeHttp(routes);
  return { ...fake, github: createQaReleaseGithubPorts({ http: fake.http, token: async () => "ghs_test" }) };
};

test("the App JWT is RS256, issued a minute back and valid nine minutes", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" });
  const jwt = qaReleaseAppJwt("123456", pem, 1_700_000_000_000);
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url")), { iat: 1_700_000_000 - 60, exp: 1_700_000_000 + 540, iss: "123456" });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, "base64url")), true);
  assert.throws(() => qaReleaseAppJwt("12a", pem, 0), /github_app_id_invalid/);
});

test("the installation token is scoped to this repository and section 3's permissions, fetched once", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" });
  const { http, calls } = fakeHttp([
    [is("GET", `${REPO}/installation`), json(200, { id: 77 })],
    [is("POST", `${API}/app/installations/77/access_tokens`), json(201, { token: "ghs_x" })],
  ]);
  const token = qaReleaseInstallationToken(http, "1", pem, () => 1_700_000_000_000);
  assert.equal(await token(), "ghs_x");
  assert.equal(await token(), "ghs_x");
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].body), { repositories: ["Tomverse"], permissions: QA_RELEASE_APP_TOKEN_PERMISSIONS });
  assert.deepEqual(QA_RELEASE_APP_TOKEN_PERMISSIONS, { contents: "write", pull_requests: "write", checks: "read", statuses: "read", metadata: "read" });
});

test("open develop pull requests come back in the merge train's rollup shape", async () => {
  const { github, calls } = ports([
    [is("POST", `${API}/graphql`), json(200, { data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [graphqlPull()] } } } })],
  ]);
  const [pull] = await github.listOpenDevelopPulls();
  assert.equal(pull.number, 12);
  assert.equal(pull.headRefOid, HEAD);
  assert.deepEqual(pull.statusCheckRollup, [
    { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "PR Fast Gate" },
    { __typename: "StatusContext", context: "railway", state: "SUCCESS" },
  ]);
  assert.equal(calls[0].headers.authorization, "Bearer ghs_test");
  assert.match(JSON.parse(calls[0].body).query, /baseRefName: "develop"/);
});

test("a rollup past one page is a failing context, and an unbounded list or a GraphQL error is an error", async () => {
  const paged = graphqlPull();
  paged.commits.nodes[0].commit.statusCheckRollup.contexts.pageInfo.hasNextPage = true;
  const one = ports([[is("POST", `${API}/graphql`), json(200, { data: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [paged] } } } })]]);
  assert.deepEqual((await one.github.listOpenDevelopPulls())[0].statusCheckRollup, [{ __typename: "StatusContext", context: "unread", state: "ERROR" }]);

  const endless = ports([[is("POST", `${API}/graphql`), json(200, { data: { repository: { pullRequests: { pageInfo: { hasNextPage: true, endCursor: "x" }, nodes: [] } } } })]]);
  await assert.rejects(endless.github.listOpenDevelopPulls(), /github_pulls_unbounded/);
  const errors = ports([[is("POST", `${API}/graphql`), json(200, { errors: [{ message: "x" }] })]]);
  await assert.rejects(errors.github.listOpenDevelopPulls(), /github_graphql_errors/);
});

test("readPull reports merged and the merge commit, and null for a pull request GitHub does not have", async () => {
  const merged = ports([[is("POST", `${API}/graphql`), json(200, { data: { repository: { pullRequest: { ...graphqlPull({ state: "MERGED" }), merged: true, mergeCommit: { oid: MERGE.toUpperCase() } } } } })]]);
  const read = await merged.github.readPull(12);
  assert.equal(read.merged, true);
  assert.equal(read.mergeCommitSha, MERGE);
  const missing = ports([[is("POST", `${API}/graphql`), json(200, { data: { repository: { pullRequest: null } } })]]);
  assert.equal(await missing.github.readPull(99), null);
});

test("the merge is PUT on the merge API with the head pinned, and its answer is mapped without guessing", async () => {
  const merged = ports([[is("PUT", `${REPO}/pulls/12/merge`), json(200, { merged: true, sha: MERGE })]]);
  assert.deepEqual(await merged.github.merge(12, HEAD), { result: "merged", sha: MERGE });
  assert.deepEqual(JSON.parse(merged.calls[0].body), { sha: HEAD, merge_method: "merge" });

  for (const status of [405, 409, 422]) {
    const refused = ports([[is("PUT", `${REPO}/pulls/12/merge`), json(status, { message: "no" })]]);
    assert.deepEqual(await refused.github.merge(12, HEAD), { result: "refused" }, String(status));
  }
  for (const answer of [json(401, {}), json(403, {}), json(429, {}), json(500, {}), json(502, {}), json(200, { merged: false }), { status: 200, text: "<html>" }]) {
    const unknown = ports([[is("PUT", `${REPO}/pulls/12/merge`), answer]]);
    assert.deepEqual(await unknown.github.merge(12, HEAD), { result: "unknown" });
  }
  const thrown = ports([[is("PUT", `${REPO}/pulls/12/merge`), () => { throw new Error("timeout"); }]]);
  assert.deepEqual(await thrown.github.merge(12, HEAD), { result: "unknown" });
  const noSha = ports([]);
  assert.deepEqual(await noSha.github.merge(12, "not-a-sha"), { result: "refused" });
  assert.equal(noSha.calls.length, 0);
});

test("onDevelop and commitsContaining read the compare API's relation; cancelled commits come from check runs", async () => {
  const { github } = ports([
    [is("GET", `${REPO}/compare/${MERGE}...develop?per_page=1`), json(200, { status: "ahead" })],
    [is("GET", `${REPO}/compare/${MERGE}...${TIP}?per_page=1`), json(200, { status: "diverged" })],
    [is("GET", `${REPO}/compare/${MERGE}...${HEAD}?per_page=1`), json(200, { status: "identical" })],
    [is("GET", `${REPO}/commits/${HEAD}/check-runs?per_page=100`), json(200, { total_count: 1, check_runs: [{ conclusion: "success" }] })],
    [is("GET", `${REPO}/commits/${TIP}/check-runs?per_page=100`), json(200, { total_count: 1, check_runs: [{ conclusion: "cancelled" }] })],
  ]);
  assert.equal(await github.onDevelop(MERGE), true);
  assert.deepEqual([...(await github.commitsContaining(MERGE, [TIP, HEAD, "bad"]))], [HEAD]);
  assert.deepEqual([...(await github.cancelledCommits([TIP, HEAD]))], [TIP]);
  const behind = ports([[startsWith("GET", `${REPO}/compare/`), json(200, { status: "behind" })]]);
  assert.equal(await behind.github.onDevelop(MERGE), false);
});

test("exclusion inputs: every changed file to the last page, migration text at the head, policy lists at develop's tip", async () => {
  const policy = readFileSync(new URL("../docs/policy/qa-release-agent.md", import.meta.url), "utf8");
  const agents = "Policy tests: `tests/autoPrAutoMergeArming.test.mjs`.";
  const blob = (text) => json(200, { encoding: "base64", content: Buffer.from(text).toString("base64") });
  const migration = "prisma/migrations/20261005000000_x/migration.sql";
  const files = [
    { filename: "lib/a.ts", status: "modified" },
    { filename: migration, status: "added" },
    { filename: "lib/b.ts", status: "renamed", previous_filename: "lib/old.ts" },
  ];
  const routes = [
    [is("GET", `${REPO}/git/ref/heads/develop`), json(200, { object: { sha: TIP } })],
    [is("GET", `${REPO}/git/trees/${TIP}?recursive=1`), json(200, {
      truncated: false,
      tree: [
        { path: "AGENTS.md", type: "blob", sha: "1".repeat(40) },
        { path: "docs/policy/qa-release-agent.md", type: "blob", sha: "2".repeat(40) },
        { path: "lib/a.ts", type: "blob", sha: "3".repeat(40) },
      ],
    })],
    [is("GET", `${REPO}/git/blobs/${"1".repeat(40)}`), blob(agents)],
    [is("GET", `${REPO}/git/blobs/${"2".repeat(40)}`), blob(policy)],
    [is("GET", `${REPO}/pulls/12`), json(200, { changed_files: 3, head: { sha: HEAD } })],
    [is("GET", `${REPO}/pulls/12/files?per_page=100&page=1`), json(200, files)],
    [is("GET", `${REPO}/contents/${migration}?ref=${HEAD}`), { status: 200, text: 'CREATE TABLE "Thing" ();' }],
  ];
  const { github, calls } = ports(routes);
  const pull = { number: 12, headRefName: "claude/to-develop/x", headRefOid: HEAD };
  const input = await github.exclusionInputs(pull);
  assert.equal(input.headBranch, "claude/to-develop/x");
  assert.equal(input.changedFilesComplete, true);
  assert.deepEqual(input.changedFiles, [
    { path: "lib/a.ts", previousPath: null },
    { path: migration, previousPath: null, migrationSql: 'CREATE TABLE "Thing" ();' },
    { path: "lib/b.ts", previousPath: "lib/old.ts" },
  ]);
  assert.ok(input.policyTestPaths.includes("tests/autoPrAutoMergeArming.test.mjs"));
  assert.ok(input.agentOwnPatterns.includes("lib/qaRelease*"));
  assert.equal(calls.find((call) => call.url.includes("/contents/")).headers.accept, "application/vnd.github.raw+json");

  // Read once per round, however many candidates.
  await github.exclusionInputs(pull);
  assert.equal(calls.filter((call) => call.url.endsWith("/git/ref/heads/develop")).length, 1);
});

test("exclusion inputs are incomplete or null whenever any part is not read in full", async () => {
  const pull = { number: 12, headRefName: "x", headRefOid: HEAD };
  const base = [
    [is("GET", `${REPO}/git/ref/heads/develop`), json(200, { object: { sha: TIP } })],
    [is("GET", `${REPO}/git/trees/${TIP}?recursive=1`), json(200, { truncated: true, tree: [] })],
  ];
  // Count differs from GitHub's, the head moved, a removed migration: each excluded upstream.
  const short = ports([...base,
    [is("GET", `${REPO}/pulls/12`), json(200, { changed_files: 5, head: { sha: HEAD } })],
    [is("GET", `${REPO}/pulls/12/files?per_page=100&page=1`), json(200, [{ filename: "lib/a.ts", status: "modified" }])],
  ]);
  const shortInput = await short.github.exclusionInputs(pull);
  assert.equal(shortInput.changedFilesComplete, false);
  // A truncated tree leaves both policy lists unread.
  assert.equal(shortInput.policyTestPaths, null);
  assert.equal(shortInput.agentOwnPatterns, null);

  const moved = ports([...base,
    [is("GET", `${REPO}/pulls/12`), json(200, { changed_files: 1, head: { sha: MERGE } })],
    [is("GET", `${REPO}/pulls/12/files?per_page=100&page=1`), json(200, [{ filename: "prisma/migrations/x/migration.sql", status: "removed" }])],
  ]);
  const movedInput = await moved.github.exclusionInputs(pull);
  assert.equal(movedInput.changedFilesComplete, false);
  assert.equal(movedInput.changedFiles[0].migrationSql, null);
});

test("the only write this module makes is the merge API with the head pinned (policy section 3)", () => {
  const source = readFileSync(new URL("../lib/qaReleaseMergeLaneGithub.ts", import.meta.url), "utf8");
  const puts = [...source.matchAll(/method: "(PUT|PATCH|DELETE)"/g)];
  assert.equal(puts.length, 1);
  assert.match(source, /method: "PUT",\s*url: `\$\{QA_RELEASE_GITHUB_API\}\$\{REPO_PATH\}\/pulls\/\$\{number\}\/merge`/);
  assert.match(source, /body: JSON\.stringify\(\{ sha: headSha, merge_method: "merge" \}\)/);
  // POSTs are GraphQL reads and the installation token; nothing else.
  const posts = [...source.matchAll(/method: "POST",\s*url: `([^`]+)`/g)].map((match) => match[1]);
  assert.deepEqual(posts.sort(), ["${QA_RELEASE_GITHUB_API}/app/installations/${id}/access_tokens", "${QA_RELEASE_GITHUB_API}/graphql"]);
  assert.doesNotMatch(source, /mutation|\/git\/refs|\/merges\b|"base"|\/contents\/[^`]*`,\s*\{\s*method/);
});

test("a containing or cancelled lookup that is not read in full is an error, never a smaller list", async () => {
  const failing = ports([
    [is("GET", `${REPO}/compare/${MERGE}...${TIP}?per_page=1`), json(404, {})],
    [is("GET", `${REPO}/commits/${TIP}/check-runs?per_page=100`), json(502, {})],
  ]);
  await assert.rejects(failing.github.commitsContaining(MERGE, [TIP]));
  await assert.rejects(failing.github.cancelledCommits([TIP]));
  const paged = ports([
    [is("GET", `${REPO}/commits/${TIP}/check-runs?per_page=100`), json(200, { total_count: 101, check_runs: [{ conclusion: "success" }] })],
    [is("GET", `${REPO}/compare/${MERGE}...${TIP}?per_page=1`), json(200, { status: "weird" })],
  ]);
  await assert.rejects(paged.github.cancelledCommits([TIP]), /github_check_runs_unread/);
  await assert.rejects(paged.github.commitsContaining(MERGE, [TIP]), /github_shape/);
});
