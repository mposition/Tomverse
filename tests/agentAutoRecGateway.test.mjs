import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { checkPeer, handleRequest, peerPidFromInstance, readGatewayConfig, splitRequest } from "../tools/auto-rec-agent/bin/autorec-gateway.mjs";
import { LIMITS } from "../tools/auto-rec-agent/lib/contract.mjs";
import { PR_BODY_FOOTER, branchNameFor } from "../tools/auto-rec-agent/lib/core.mjs";

const ID = "rec_01HZY3";
const BRANCH = branchNameFor(ID);
const HEAD = "c".repeat(40);
const FORK = "f".repeat(40);
// Placeholder values of the right length; nothing here is a credential.
const ENV = {
  AUTOREC_APP_URL: "https://app.example.test",
  AUTOREC_APP_SECRET: "s".repeat(32),
  AUTOREC_GITHUB_TOKEN: "t".repeat(40),
  STATE_DIRECTORY: "/state",
  PATH: "/usr/bin",
  // systemd Accept=yes instance name: connection 3, peer PID 4242, peer UID 1001.
  AUTOREC_PEER: "3-4242-1001",
};
const PTRACE_SCOPE = "/proc/sys/kernel/yama/ptrace_scope";
const PR_URL = "https://github.com/mposition/Tomverse/pull/2900";
const raw = (path, mode = "100644") => `:${mode} ${mode} ${"a".repeat(40)} ${"b".repeat(40)} M\0${path}\0`;

function jsonResponse(status, body) {
  return {
    status,
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  };
}

/**
 * Fake git and fetch. `git` answers by the subcommand after `-C <mirror>`;
 * `github` is a list of answers consumed in order for api.github.com calls.
 */
function fakeDeps({ gitAnswers = {}, github = [], app = [], files = {}, env = ENV, mainPid = 4242 } = {}) {
  let clock = Date.parse("2026-10-20T00:00:00.000Z");
  const gitCalls = [];
  const fetchCalls = [];
  const store = { [PTRACE_SCOPE]: "1", ...files };
  const deps = {
    config: readGatewayConfig(env),
    runnerMainPid: async () => mainPid,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    git: async (args, options) => {
      gitCalls.push({ args, options });
      const sub = args[0] === "-C" ? args[2] : args[0];
      const answer = gitAnswers[sub];
      if (typeof answer === "function") return answer(args, options);
      if (answer) return answer;
      if (sub === "rev-parse") return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
      if (sub === "merge-base") return { code: 0, stdout: `${FORK}\n`, stderr: "" };
      if (sub === "diff") return { code: 0, stdout: raw("lib/chatAttemptExecution.ts") + raw("tests/chatAttemptExecution.test.mjs"), stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      const queue = url.startsWith("https://api.github.com") ? github : app;
      const next = queue.shift();
      if (next === undefined) throw new Error(`unexpected fetch ${init.method} ${url}`);
      if (next instanceof Error) throw next;
      return next;
    },
    fs: {
      exists: (path) => path in store,
      readText: (path) => store[path] ?? null,
      writeTextAtomic: (path, text) => {
        store[path] = text;
      },
      writeBuffer: (path, buffer) => {
        store[path] = buffer;
      },
      remove: (path) => {
        delete store[path];
      },
    },
    log: () => {},
  };
  return { deps, gitCalls, fetchCalls, store };
}

const publishHeader = (overrides = {}) => ({
  op: "publish",
  id: ID,
  branch: BRANCH,
  head: HEAD,
  title: "auto-rec: retry once",
  body: "Recommendation body",
  ...overrides,
});
const LOG = join("/state", "publishes.json");
const MIRROR_HEAD = join("/state", "mirror.git", "HEAD");
const BUNDLE = Buffer.from("# v2 git bundle\n");
const gitSubs = (calls) => calls.map(({ args }) => (args[0] === "-C" ? args[2] : args[0]));

test("a gateway without its settings refuses every request", async () => {
  const { deps, fetchCalls } = fakeDeps({ env: { ...ENV, AUTOREC_GITHUB_TOKEN: "" } });
  const answer = await handleRequest(deps, { op: "claim" }, Buffer.alloc(0));
  assert.equal(answer.code, "gateway_config_missing");
  assert.deepEqual(answer.missing, ["AUTOREC_GITHUB_TOKEN"]);
  assert.equal(fetchCalls.length, 0);
  assert.deepEqual(readGatewayConfig({ ...ENV, AUTOREC_APP_URL: "http://app.example.test" }).missing, ["AUTOREC_APP_URL"]);
  assert.deepEqual(readGatewayConfig({ ...ENV, AUTOREC_APP_URL: "https://app.example.test/api" }).missing, ["AUTOREC_APP_URL"]);
});

test("claim posts with the bearer secret and passes a valid claim through", async () => {
  const claim = {
    id: ID,
    recommendation: "Retry once",
    findings: [],
    target: {},
    instruction: "Do it",
    leaseUntil: "2026-10-20T03:00:00.000Z",
  };
  const { deps, fetchCalls } = fakeDeps({ app: [jsonResponse(200, claim)] });
  const answer = await handleRequest(deps, { op: "claim" }, Buffer.alloc(0));
  assert.equal(answer.status, "claimed");
  assert.equal(answer.claim.id, ID);
  const [call] = fetchCalls;
  assert.equal(call.url, "https://app.example.test/api/internal/auto-router/recommendations/claim");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.authorization, `Bearer ${ENV.AUTOREC_APP_SECRET}`);
  assert.equal(call.init.redirect, "error");
});

test("claim answers: 204 empty, 4xx error, 5xx and no answer unknown, bad body error", async () => {
  const cases = [
    [jsonResponse(204), { status: "empty" }],
    [jsonResponse(401, {}), { status: "error", code: "http_401" }],
    [jsonResponse(503, {}), { status: "unknown", code: "http_503" }],
    [new Error("ECONNRESET"), { status: "unknown", code: "network" }],
    [jsonResponse(200, { id: ID }), { status: "error", code: "claim_instruction_missing" }],
    [jsonResponse(200), { status: "error", code: "claim_not_object" }],
  ];
  for (const [response, expected] of cases) {
    const { deps } = fakeDeps({ app: [response] });
    assert.deepEqual(await handleRequest(deps, { op: "claim" }, Buffer.alloc(0)), expected);
  }
});

test("result sends only the contract's fields and refuses anything else without calling the app", async () => {
  const { deps, fetchCalls } = fakeDeps({ app: [jsonResponse(200, {})] });
  const answer = await handleRequest(deps, { op: "result", id: ID, outcome: "pr_opened", prUrl: PR_URL, extra: "x" }, Buffer.alloc(0));
  assert.deepEqual(answer, { status: "reported" });
  assert.equal(fetchCalls[0].url, "https://app.example.test/api/internal/auto-router/recommendations/result");
  assert.deepEqual(JSON.parse(fetchCalls[0].init.body), { id: ID, outcome: "pr_opened", prUrl: PR_URL });

  const bad = fakeDeps();
  assert.equal((await handleRequest(bad.deps, { op: "result", id: ID, outcome: "failed", reason: "free text" }, Buffer.alloc(0))).code, "result_reason_invalid");
  assert.equal((await handleRequest(bad.deps, { op: "result", id: ID, outcome: "pr_opened", prUrl: "https://evil.test/pull/1" }, Buffer.alloc(0))).code, "result_pr_url_invalid");
  assert.equal(bad.fetchCalls.length, 0);

  const lost = fakeDeps({ app: [new Error("timeout")] });
  assert.equal((await handleRequest(lost.deps, { op: "result", id: ID, outcome: "failed", reason: "tests" }, Buffer.alloc(0))).status, "unknown");
});

test("publish refuses a branch that is not the recommendation's own, before any git or network call", async () => {
  for (const overrides of [
    { branch: "claude/to-develop/auto-rec-other-12345678" },
    { branch: "develop" },
    { head: "HEAD" },
    { id: "../x" },
  ]) {
    const { deps, gitCalls, fetchCalls } = fakeDeps();
    const answer = await handleRequest(deps, publishHeader(overrides), BUNDLE);
    assert.equal(answer.status, "refused");
    assert.equal(answer.code, "runner_error");
    assert.equal(gitCalls.length + fetchCalls.length, 0);
  }
  const empty = fakeDeps();
  assert.equal((await handleRequest(empty.deps, publishHeader(), Buffer.alloc(0))).detail, "bundle_size");
});

test("publish stops at the daily cap; stamps older than a day do not count", async () => {
  const now = Date.parse("2026-10-20T00:00:00.000Z");
  const full = Array.from({ length: LIMITS.publishesPerDay }, (_, i) => now - i * 60_000);
  const capped = fakeDeps({ files: { [LOG]: JSON.stringify(full) } });
  assert.deepEqual(await handleRequest(capped.deps, publishHeader(), BUNDLE), { status: "refused", code: "rate_limited" });
  assert.equal(capped.gitCalls.length, 0);

  const stale = full.map((t) => t - 25 * 60 * 60_000);
  const unreadable = fakeDeps({ files: { [LOG]: "{" } });
  assert.equal((await handleRequest(unreadable.deps, publishHeader(), BUNDLE)).code, "rate_limited");
  const old = fakeDeps({
    files: { [LOG]: JSON.stringify(stale) },
    gitAnswers: { diff: { code: 0, stdout: raw("AGENTS.md"), stderr: "" } },
  });
  await handleRequest(old.deps, publishHeader(), BUNDLE);
  assert.deepEqual(JSON.parse(old.store[LOG]), [now]);
});

test("publish re-checks the scope against its own develop and never pushes an out-of-scope change", async () => {
  const { deps, gitCalls } = fakeDeps({
    gitAnswers: { diff: { code: 0, stdout: raw("lib/chatAttemptExecution.ts") + raw(".github/workflows/x.yml"), stderr: "" } },
  });
  const answer = await handleRequest(deps, publishHeader(), BUNDLE);
  assert.deepEqual(answer, { status: "refused", code: "out_of_scope" });
  assert.ok(!gitSubs(gitCalls).includes("push"));
  // It judged the change against develop as fetched from GitHub, without credentials.
  const fetchDevelop = gitCalls.find(({ args }) => args[2] === "fetch" && args.includes("+refs/heads/develop:refs/remotes/origin/develop"));
  assert.ok(fetchDevelop);
  assert.equal(fetchDevelop.options.env.GIT_CONFIG_COUNT, undefined);
  assert.equal(gitCalls[0].args[0], "init");
});

test("publish refuses a bundle whose tip is not the reviewed head", async () => {
  const { deps, gitCalls } = fakeDeps({ gitAnswers: { "rev-parse": { code: 0, stdout: `${"d".repeat(40)}\n`, stderr: "" } } });
  const answer = await handleRequest(deps, publishHeader(), BUNDLE);
  assert.deepEqual(answer, { status: "refused", code: "setup_failed", detail: "head_mismatch" });
  assert.ok(!gitSubs(gitCalls).includes("push"));
});

test("publish pushes create-only with the token in git's environment, then adopts Auto PR's draft", async () => {
  const pr = { number: 2900, html_url: PR_URL };
  const { deps, gitCalls, fetchCalls, store } = fakeDeps({
    files: { [MIRROR_HEAD]: "ref" },
    github: [jsonResponse(200, []), jsonResponse(200, [pr]), jsonResponse(200, pr)],
  });
  const answer = await handleRequest(deps, publishHeader(), BUNDLE);
  assert.deepEqual(answer, { status: "published", prUrl: PR_URL, number: 2900, bodyUpdated: true });

  const push = gitCalls.find(({ args }) => args[2] === "push");
  assert.ok(push.args.includes(`--force-with-lease=refs/heads/${BRANCH}:`));
  assert.ok(push.args.includes(`${HEAD}:refs/heads/${BRANCH}`));
  assert.ok(!push.args.some((arg) => arg.includes(ENV.AUTOREC_GITHUB_TOKEN)));
  const header = Buffer.from(push.options.env.GIT_CONFIG_VALUE_0.replace("AUTHORIZATION: basic ", ""), "base64").toString();
  assert.equal(header, `x-access-token:${ENV.AUTOREC_GITHUB_TOKEN}`);
  assert.equal(push.options.env.GIT_CONFIG_GLOBAL, "/dev/null");
  // Only the push carries the token.
  assert.equal(gitCalls.filter(({ options }) => options.env.GIT_CONFIG_VALUE_0).length, 1);
  // No init: the mirror exists. The bundle file is gone afterwards.
  assert.ok(!gitSubs(gitCalls).includes("init"));
  assert.deepEqual(Object.keys(store).filter((key) => key.endsWith(".bundle")), []);

  const [firstList, secondList, patch] = fetchCalls;
  assert.ok(firstList.url.includes(`head=${encodeURIComponent(`mposition:${BRANCH}`)}`));
  assert.ok(firstList.url.includes("base=develop"));
  assert.equal(secondList.init.method, "GET");
  assert.equal(patch.init.method, "PATCH");
  assert.ok(patch.url.endsWith("/pulls/2900"));
  assert.ok(JSON.parse(patch.init.body).body.endsWith(PR_BODY_FOOTER));
  assert.equal(firstList.init.headers.authorization, `Bearer ${ENV.AUTOREC_GITHUB_TOKEN}`);
});

test("a rejected push is a known refusal and is not verified or retried", async () => {
  const { deps, gitCalls } = fakeDeps({
    gitAnswers: { push: { code: 1, stdout: `To x\n!\t${HEAD}:refs/heads/${BRANCH}\t[rejected] (stale info)\nDone\n`, stderr: "" } },
  });
  assert.deepEqual(await handleRequest(deps, publishHeader(), BUNDLE), { status: "refused", code: "push_rejected" });
  assert.equal(gitSubs(gitCalls).filter((sub) => sub === "push").length, 1);
  assert.ok(!gitSubs(gitCalls).includes("ls-remote"));
});

test("an unclear push is looked up once: there, absent, or still unknown", async () => {
  const pr = { number: 5, html_url: "https://github.com/mposition/Tomverse/pull/5" };
  const failing = { code: 128, stdout: "", stderr: "fatal: unable to access" };

  const landed = fakeDeps({
    gitAnswers: { push: failing, "ls-remote": { code: 0, stdout: `${HEAD}\trefs/heads/${BRANCH}\n`, stderr: "" } },
    github: [jsonResponse(200, [pr]), jsonResponse(200, pr)],
  });
  assert.equal((await handleRequest(landed.deps, publishHeader(), BUNDLE)).status, "published");
  const lookup = landed.gitCalls.find(({ args }) => args[2] === "ls-remote");
  assert.equal(lookup.options.env.GIT_CONFIG_VALUE_0, undefined);

  const absent = fakeDeps({ gitAnswers: { push: failing, "ls-remote": { code: 0, stdout: "", stderr: "" } } });
  assert.deepEqual(await handleRequest(absent.deps, publishHeader(), BUNDLE), { status: "refused", code: "push_failed" });

  const unknown = fakeDeps({ gitAnswers: { push: failing, "ls-remote": { code: 128, stdout: "", stderr: "" } } });
  assert.deepEqual(await handleRequest(unknown.deps, publishHeader(), BUNDLE), { status: "unknown", step: "push" });
  assert.equal(gitSubs(unknown.gitCalls).filter((sub) => sub === "push").length, 1);
});

test("when Auto PR does not open one in time, the gateway opens the draft itself", async () => {
  const polls = Math.floor(LIMITS.autoPrWaitMs / LIMITS.autoPrPollMs) + 1;
  const created = { number: 9, html_url: "https://github.com/mposition/Tomverse/pull/9" };
  const { deps, fetchCalls } = fakeDeps({
    github: [...Array.from({ length: polls }, () => jsonResponse(200, [])), jsonResponse(201, created)],
  });
  const answer = await handleRequest(deps, publishHeader(), BUNDLE);
  assert.deepEqual(answer, { status: "published", prUrl: created.html_url, number: 9, bodyUpdated: true });
  const post = fetchCalls.at(-1);
  assert.equal(post.init.method, "POST");
  assert.deepEqual(
    (({ head, base, draft }) => ({ head, base, draft }))(JSON.parse(post.init.body)),
    { head: BRANCH, base: "develop", draft: true },
  );
});

test("a failed PR create is looked up once; still none means pr_failed with the branch pushed", async () => {
  const polls = Math.floor(LIMITS.autoPrWaitMs / LIMITS.autoPrPollMs) + 1;
  const raced = { number: 11, html_url: "https://github.com/mposition/Tomverse/pull/11" };
  const race = fakeDeps({
    github: [...Array.from({ length: polls }, () => jsonResponse(200, [])), jsonResponse(422, {}), jsonResponse(200, [raced]), jsonResponse(200, raced)],
  });
  assert.equal((await handleRequest(race.deps, publishHeader(), BUNDLE)).prUrl, raced.html_url);

  const none = fakeDeps({
    github: [...Array.from({ length: polls }, () => jsonResponse(200, [])), new Error("ETIMEDOUT"), jsonResponse(200, [])],
  });
  assert.deepEqual(await handleRequest(none.deps, publishHeader(), BUNDLE), {
    status: "failed",
    code: "pr_failed",
    pushed: true,
    branch: BRANCH,
  });
});

test("requests are one JSON header line followed by the payload", () => {
  const { header, payload } = splitRequest(Buffer.concat([Buffer.from('{"op":"publish"}\n'), BUNDLE]));
  assert.deepEqual(header, { op: "publish" });
  assert.deepEqual(payload, BUNDLE);
  assert.throws(() => splitRequest(Buffer.from('{"op":"claim"}')), /request_header_invalid/);
  assert.throws(() => splitRequest(Buffer.from("[1]\n")), /request_header_invalid/);
  assert.throws(() => splitRequest(Buffer.from("nope\n")), /request_header_invalid/);
});

test("an unknown op is refused", async () => {
  const { deps } = fakeDeps();
  assert.deepEqual(await handleRequest(deps, { op: "merge" }, Buffer.alloc(0)), { status: "error", code: "op_invalid" });
});

test("only the runner's main process is answered", async () => {
  for (const [options, code] of [
    [{ mainPid: 5000 }, "peer_not_runner"],
    [{ mainPid: null }, "peer_not_runner"],
    [{ env: { ...ENV, AUTOREC_PEER: "3-12-unknown" } }, "peer_unknown"],
    [{ env: { ...ENV, AUTOREC_PEER: undefined } }, "peer_unknown"],
    [{ files: { [PTRACE_SCOPE]: "0\n" } }, "ptrace_scope_unsafe"],
    [{ files: { [PTRACE_SCOPE]: undefined } }, "ptrace_scope_unsafe"],
  ]) {
    const { deps, fetchCalls, gitCalls } = fakeDeps({ ...options, app: [jsonResponse(204)] });
    for (const op of ["claim", "result", "publish"]) {
      assert.deepEqual(await handleRequest(deps, { ...publishHeader(), op }, BUNDLE), { status: "error", code }, `${op} ${code}`);
    }
    assert.equal(fetchCalls.length + gitCalls.length, 0);
  }
  const { deps } = fakeDeps();
  assert.deepEqual(await checkPeer(deps), { ok: true });
});

test("the peer PID is read from every systemd instance-name format", () => {
  assert.equal(peerPidFromInstance("3-4242-1001"), 4242);
  assert.equal(peerPidFromInstance("3-77-4242-1001"), 4242);
  assert.equal(peerPidFromInstance("3-77-4242_991-1001"), 4242);
  for (const value of ["3-unknown", "3-77-unknown", "4242", "3-0-1001", "3-x-1001", "", null]) {
    assert.equal(peerPidFromInstance(value), null, String(value));
  }
});

test("the scope diff starts at the fork point, so develop's newer commits never count", async () => {
  const { deps, gitCalls } = fakeDeps({ gitAnswers: { diff: { code: 0, stdout: raw("AGENTS.md"), stderr: "" } } });
  await handleRequest(deps, publishHeader(), BUNDLE);
  const mergeBase = gitCalls.find(({ args }) => args[2] === "merge-base");
  assert.deepEqual(mergeBase.args.slice(3), ["refs/remotes/origin/develop", HEAD]);
  const diff = gitCalls.find(({ args }) => args[2] === "diff");
  assert.deepEqual(diff.args.slice(-2), [FORK, HEAD]);
});
