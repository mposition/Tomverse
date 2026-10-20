import assert from "node:assert/strict";
import { basename } from "node:path";
import test from "node:test";

import { CLAUDE_ARGS, readRunnerConfig, runLocked, runOnce } from "../tools/auto-rec-agent/bin/autorec-runner.mjs";
import { LIMITS } from "../tools/auto-rec-agent/lib/contract.mjs";
import { INSTRUCTION_PREAMBLE, branchNameFor } from "../tools/auto-rec-agent/lib/core.mjs";

const BASE = "e".repeat(40);
const HEAD = "c".repeat(40);
const JOB = "r-20261020-010203-abcdef";
const PR_URL = "https://github.com/mposition/Tomverse/pull/2900";
const NOW = Date.parse("2026-10-20T00:00:00.000Z");
const CLAIM = {
  id: "rec_01HZY3",
  recommendation: "Retry a failed answer call once on a same-credit fallback model.",
  findings: { failures: 12 },
  target: { area: "auto-router" },
  instruction: "Implement the retry in lib/chatAttemptExecution.ts with a unit test.",
  leaseUntil: "2026-10-20T06:00:00.000Z",
  claimId: "11111111-2222-4333-8444-555555555555",
};
const BRANCH = branchNameFor(CLAIM.id);
const raw = (path, status = "M", mode = "100644") => `:${mode} ${mode} ${"a".repeat(40)} ${"b".repeat(40)} ${status}\0${path}\0`;
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", timedOut: false });
const exit = (code, stdout = "") => ({ code, stdout, stderr: "", timedOut: false });
const TEST_TEXTS = {
  "tests/chatAttemptExecution.test.mjs": 'import { run } from "../lib/chatAttemptExecution.ts";',
  "tests/other.test.mjs": 'import "../lib/other.ts";',
};

/** The happy path, by command. Each scenario overrides what it needs, first match wins. */
const DEFAULT_RULES = [
  [/^git .* remote get-url origin$/, ok("https://github.com/mposition/Tomverse.git\n")],
  [/^git .* rev-parse --verify refs\/remotes\/origin\/develop\^\{commit\}$/, ok(`${BASE}\n`)],
  [/^git .* rev-parse \S+:package-lock\.json/, ok("lock1\nschema1\n")],
  [/^git .* rev-parse --verify HEAD\^\{commit\}$/, ok(`${HEAD}\n`)],
  [/^git .* diff --raw/, ok(raw("lib/chatAttemptExecution.ts") + raw("tests/chatAttemptExecution.test.mjs"))],
  [/^claude /, ok(JSON.stringify({ subtype: "success", result: "Implemented and committed.", num_turns: 7 }))],
  [/review\.mjs submit /, exit(3, JSON.stringify({ jobId: JOB, status: "pending" }))],
  [/review\.mjs wait /, ok(JSON.stringify({ jobId: JOB, status: "accept", head: HEAD }))],
];

function fakeRunner({ rules = [], gateway = {}, now = NOW, lockFree = true, files = {} } = {}) {
  const calls = [];
  const gatewayCalls = [];
  const events = [];
  let clock = now;
  const allRules = [...rules, ...DEFAULT_RULES];
  const replies = {
    claim: { status: "claimed", claim: CLAIM },
    publish: { status: "published", prUrl: PR_URL, number: 2900, bodyUpdated: true },
    result: { status: "reported" },
    ...gateway,
  };
  const deps = {
    config: readRunnerConfig({ HOME: "/home/autorec", PATH: "/usr/bin" }),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    exec: async (command, args, options) => {
      const signature = [basename(command).replace(/\.exe$/i, ""), ...args].join(" ");
      calls.push({ signature, command, args, options });
      const rule = allRules.find(([pattern]) => pattern.test(signature));
      const answer = rule ? rule[1] : ok();
      return typeof answer === "function" ? answer(signature, options) : answer;
    },
    gateway: async (header, payload, timeoutMs) => {
      gatewayCalls.push({ header, payload, timeoutMs });
      const reply = replies[header.op];
      if (reply instanceof Error) throw reply;
      return typeof reply === "function" ? reply(header) : reply;
    },
    lock: { acquire: () => (lockFree ? "token" : null), release: () => {} },
    fs: {
      exists: () => true,
      readText: (path) => {
        const normal = path.replace(/\\/g, "/");
        if (normal.endsWith("autorec-deps-key")) return files.depsKey ?? "lock1 schema1";
        const key = Object.keys(TEST_TEXTS).find((name) => normal.endsWith(name));
        return key ? TEST_TEXTS[key] : null;
      },
      readBuffer: () => Buffer.from("bundle"),
      writeText: () => {},
      remove: () => {},
      symlink: () => {},
      listTestFiles: () => files.testFiles ?? Object.keys(TEST_TEXTS),
    },
    log: (event, fields = {}) => events.push({ event, ...fields }),
    runLog: () => {},
    startRunLog: () => {},
    pruneLogs: () => {},
  };
  return { deps, calls, gatewayCalls, events };
}

const ops = (gatewayCalls) => gatewayCalls.map(({ header }) => header.op);
const resultOf = (gatewayCalls) => gatewayCalls.find(({ header }) => header.op === "result")?.header;
const ran = (calls, pattern) => calls.some(({ signature }) => pattern.test(signature));

test("happy path: claim, agent, tests, lint, review, publish, report the PR", async () => {
  const { deps, calls, gatewayCalls } = fakeRunner();
  assert.equal(await runOnce(deps), 0);
  assert.deepEqual(ops(gatewayCalls), ["claim", "publish", "result"]);
  assert.deepEqual(resultOf(gatewayCalls), { op: "result", id: CLAIM.id, claimId: CLAIM.claimId, outcome: "pr_opened", prUrl: PR_URL });

  const publish = gatewayCalls[1];
  assert.equal(publish.header.branch, BRANCH);
  assert.equal(publish.header.head, HEAD);
  assert.ok(publish.header.body.includes(JOB));
  assert.deepEqual(publish.payload, Buffer.from("bundle"));

  const worktreeAdd = calls.find(({ signature }) => / worktree add /.test(signature));
  assert.ok(worktreeAdd.args.includes(BRANCH));
  assert.equal(worktreeAdd.args.at(-1), BASE);

  const claude = calls.find(({ signature }) => signature.startsWith("claude "));
  assert.equal(claude.command, "/home/autorec/.local/bin/claude");
  assert.deepEqual(claude.args, [...CLAUDE_ARGS]);
  assert.ok(claude.options.input.startsWith(INSTRUCTION_PREAMBLE));
  assert.ok(claude.options.input.includes(CLAIM.instruction));
  assert.equal(claude.options.timeoutMs, LIMITS.claudeMs);

  const testRun = calls.find(({ signature }) => /--test-concurrency=1/.test(signature));
  assert.ok(testRun.args.includes("tests/chatAttemptExecution.test.mjs"));
  assert.ok(!testRun.args.includes("tests/other.test.mjs"));
  assert.ok(testRun.args.includes("--conditions=react-server"));
  const lint = calls.find(({ signature }) => /eslint\.js/.test(signature));
  assert.ok(lint.args.includes("lib/chatAttemptExecution.ts"));
  assert.ok(lint.args.includes("--max-warnings=0"));

  const submit = calls.find(({ signature }) => /review\.mjs submit/.test(signature));
  assert.deepEqual(submit.args.slice(1, 4), ["submit", "--author", "claude"]);
  // The worktree goes away at the end.
  assert.ok(ran(calls, / worktree remove --force /));
  assert.ok(ran(calls, new RegExp(` branch -D ${BRANCH.replace(/[/]/g, "\\/")}$`)));
});

test("no child process ever receives a gateway secret or a GitHub token", async () => {
  const { deps, calls } = fakeRunner();
  deps.config.claudeOauthToken = "oauth-placeholder";
  await runOnce(deps);
  for (const { signature, options } of calls) {
    for (const key of Object.keys(options.env ?? {})) {
      assert.ok(!/SECRET|GITHUB|AUTOREC_APP/.test(key), `${signature} got ${key}`);
    }
    const claude = signature.startsWith("claude ");
    assert.equal("CLAUDE_CODE_OAUTH_TOKEN" in (options.env ?? {}), claude, signature);
  }
  const claude = calls.find(({ signature }) => signature.startsWith("claude "));
  assert.equal(claude.options.env.GIT_AUTHOR_NAME, "tomverse-auto-rec[bot]");
});

test("nothing to claim, a busy lock or an unreachable gateway end the run without work", async () => {
  const empty = fakeRunner({ gateway: { claim: { status: "empty" } } });
  assert.equal(await runOnce(empty.deps), 0);
  assert.equal(empty.calls.length, 0);

  const busy = fakeRunner({ lockFree: false });
  assert.equal(await runOnce(busy.deps), 0);
  assert.equal(busy.gatewayCalls.length, 0);

  const down = fakeRunner({ gateway: { claim: new Error("gateway_ENOENT") } });
  assert.equal(await runOnce(down.deps), 1);
  assert.equal(down.calls.length, 0);

  const bad = fakeRunner({ gateway: { claim: { status: "error", code: "http_401" } } });
  assert.equal(await runOnce(bad.deps), 1);
  assert.deepEqual(ops(bad.gatewayCalls), ["claim"]);
});

/** Scenarios that end in a reported failure without publishing. */
const FAILURES = [
  ["the mirror holds a credential", [[/remote get-url origin$/, ok("https://x-access-token:abc@github.com/mposition/Tomverse.git\n")]], "setup_failed"],
  ["develop cannot be fetched", [[/ fetch --no-tags/, exit(128)]], "setup_failed"],
  ["dependencies cannot be installed", [[/^npm ci/, exit(1)]], "setup_failed", { depsKey: "stale" }],
  ["the agent times out", [[/^claude /, { code: 137, stdout: "", stderr: "", timedOut: true }]], "timeout"],
  ["the agent fails", [[/^claude /, exit(1)]], "agent_error"],
  ["the agent commits nothing", [[/ diff --raw/, ok("")]], "no_change"],
  ["the agent touches a workflow", [[/ diff --raw/, ok(raw("lib/a.ts") + raw(".github/workflows/x.yml"))]], "out_of_scope"],
  ["the agent touches AGENTS.md", [[/ diff --raw/, ok(raw("AGENTS.md"))]], "out_of_scope"],
  ["no test relates to the change", [[/ diff --raw/, ok(raw("lib/unrelatedThing.ts"))]], "tests"],
  ["a related test fails", [[/--test-concurrency=1/, exit(1)]], "tests"],
  ["lint fails", [[/eslint\.js/, exit(1)]], "tests"],
  ["review rejects", [[/review\.mjs wait/, exit(1, "{}")]], "review_reject"],
  ["review is unknown", [[/review\.mjs wait/, exit(2, "{}")]], "review_unknown"],
  ["review cannot be submitted", [[/review\.mjs submit/, exit(64, "")]], "review_unknown"],
  ["review accepts another head", [[/review\.mjs wait/, ok(JSON.stringify({ status: "accept", head: "d".repeat(40) }))]], "review_unknown"],
];

for (const [name, rules, reason, files] of FAILURES) {
  test(`reported failure: ${name} -> ${reason}`, async () => {
    const { deps, gatewayCalls, calls } = fakeRunner({ rules, files });
    assert.equal(await runOnce(deps), 0);
    assert.deepEqual(ops(gatewayCalls), ["claim", "result"]);
    assert.deepEqual(resultOf(gatewayCalls), { op: "result", id: CLAIM.id, claimId: CLAIM.claimId, outcome: "failed", reason });
    assert.ok(!ran(calls, / bundle create /));
  });
}

test("an out-of-scope change never reaches tests or review", async () => {
  const { deps, calls } = fakeRunner({ rules: [[/ diff --raw/, ok(raw("docs/policy/x.md"))]] });
  await runOnce(deps);
  assert.ok(!ran(calls, /--test-concurrency=1/));
  assert.ok(!ran(calls, /review\.mjs/));
});

test("only committed work is tested: leftovers are reset before the diff", async () => {
  const { deps, calls } = fakeRunner();
  await runOnce(deps);
  const order = (pattern) => calls.findIndex(({ signature }) => pattern.test(signature));
  assert.ok(order(/ reset --quiet --hard HEAD$/) > order(/^claude /));
  assert.ok(order(/ clean -fdxq -e \/node_modules$/) < order(/ diff --raw/));
});

test("a pending review is waited on until it decides", async () => {
  let waits = 0;
  const { deps, gatewayCalls } = fakeRunner({
    rules: [[/review\.mjs wait/, () => (++waits < 3 ? exit(3, "{}") : ok(JSON.stringify({ status: "accept", head: HEAD })))]],
  });
  assert.equal(await runOnce(deps), 0);
  assert.equal(waits, 3);
  assert.equal(resultOf(gatewayCalls).outcome, "pr_opened");
});

test("a review still pending at the deadline is unknown", async () => {
  const { deps, gatewayCalls } = fakeRunner({ rules: [[/review\.mjs wait/, exit(3, "{}")]] });
  await runOnce(deps);
  assert.equal(resultOf(gatewayCalls).reason, "review_unknown");
});

test("a lease too close to its end is not published", async () => {
  const late = Date.parse(CLAIM.leaseUntil) - LIMITS.leaseMarginMs + 1;
  const { deps, gatewayCalls } = fakeRunner({ now: late });
  await runOnce(deps);
  assert.deepEqual(ops(gatewayCalls), ["claim", "result"]);
  assert.equal(resultOf(gatewayCalls).reason, "lease_expired");
});

test("gateway refusals are reported as their reason", async () => {
  for (const [reply, reason] of [
    [{ status: "refused", code: "push_rejected" }, "push_rejected"],
    [{ status: "refused", code: "rate_limited" }, "rate_limited"],
    [{ status: "refused", code: "something_new" }, "runner_error"],
    [{ status: "failed", code: "pr_failed", pushed: true }, "pr_failed"],
  ]) {
    const { deps, gatewayCalls } = fakeRunner({ gateway: { publish: reply } });
    assert.equal(await runOnce(deps), 0);
    assert.equal(resultOf(gatewayCalls).reason, reason);
  }
});

test("an unknown publish is logged and not reported or retried", async () => {
  for (const publish of [new Error("gateway_no_answer"), { status: "unknown", step: "push" }, { status: "weird" }]) {
    const { deps, gatewayCalls, events } = fakeRunner({ gateway: { publish } });
    assert.equal(await runOnce(deps), 1);
    assert.deepEqual(ops(gatewayCalls), ["claim", "publish"]);
    assert.ok(events.some(({ event }) => event === "outcome_unknown"));
  }
});

test("a result that cannot be delivered is logged once and not retried", async () => {
  const { deps, gatewayCalls } = fakeRunner({ gateway: { result: new Error("gateway_timeout") } });
  assert.equal(await runOnce(deps), 1);
  assert.deepEqual(ops(gatewayCalls), ["claim", "publish", "result"]);
  const refused = fakeRunner({ gateway: { result: { status: "error", code: "http_409" } } });
  assert.equal(await runOnce(refused.deps), 1);
  assert.equal(ops(refused.gatewayCalls).filter((op) => op === "result").length, 1);
});

test("an exception before publishing is reported as runner_error; the worktree is still removed", async () => {
  const { deps, gatewayCalls, calls } = fakeRunner();
  deps.fs.listTestFiles = () => {
    throw new Error("EACCES");
  };
  assert.equal(await runLocked(deps), 0);
  assert.equal(resultOf(gatewayCalls).reason, "runner_error");
  assert.ok(ran(calls, / worktree remove --force /));
});

// Unix sockets only: the request ends with a half-close, which Windows named pipes do not
// support. The runner and the gateway run on Linux (systemd socket activation).
test("the socket client sends one header line and the payload, and reads one JSON line back", { skip: process.platform === "win32" }, async () => {
  const { createServer } = await import("node:net");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { callGateway } = await import("../tools/auto-rec-agent/bin/autorec-runner.mjs");
  const { splitRequest } = await import("../tools/auto-rec-agent/bin/autorec-gateway.mjs");
  const name = `autorec-test-${process.pid}-${Date.now()}`;
  const path = join(tmpdir(), `${name}.sock`);
  const seen = [];
  const server = createServer((socket) => {
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      const { header, payload } = splitRequest(Buffer.concat(chunks));
      seen.push({ header, payload });
      socket.end(`${JSON.stringify({ status: "ok", size: payload.length })}\nignored second line\n`);
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));
  try {
    const payload = Buffer.alloc(300_000, 7);
    assert.deepEqual(await callGateway(path, { op: "publish", id: "x" }, payload, 5_000), { status: "ok", size: 300_000 });
    assert.deepEqual(seen[0].header, { op: "publish", id: "x" });
    assert.ok(seen[0].payload.equals(payload));
    assert.deepEqual(await callGateway(path, { op: "claim" }, null, 5_000), { status: "ok", size: 0 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  await assert.rejects(callGateway(path, { op: "claim" }, null, 2_000), /gateway_/);
});

test("the runner's own tools come from root-owned paths, never the autorec account's PATH", async () => {
  const { deps, calls } = fakeRunner();
  await runOnce(deps);
  for (const { signature, command } of calls) {
    if (signature.startsWith("git ")) assert.equal(command, "/usr/bin/git", signature);
  }
  const submit = calls.find(({ signature }) => /review\.mjs submit/.test(signature));
  assert.equal(submit.command, process.execPath);
  assert.equal(submit.args[0], "/usr/local/lib/autorec-agent/tools/review-orchestrator/client/review.mjs");
  assert.equal(submit.options.env.PATH, "/usr/bin:/bin");
  assert.equal(submit.options.env.REVIEW_ORCH_SSH, "/usr/local/lib/autorec-agent/tools/auto-rec-agent/deploy/review-ssh");
  assert.equal(submit.options.env.REVIEW_ORCH_HOST, "review-orch");
});

test("a `wait` call that times out is still pending, not a verdict", async () => {
  let waits = 0;
  const { deps, gatewayCalls } = fakeRunner({
    rules: [
      [
        /review\.mjs wait/,
        () => (++waits === 1 ? { code: 137, stdout: "", stderr: "", timedOut: true } : ok(JSON.stringify({ status: "accept", head: HEAD }))),
      ],
    ],
  });
  assert.equal(await runOnce(deps), 0);
  assert.equal(waits, 2);
  assert.equal(resultOf(gatewayCalls).outcome, "pr_opened");
});

test("the runner refuses to start unless the SIGUSR1 inspector path is closed", async () => {
  const { startupProblem } = await import("../tools/auto-rec-agent/bin/autorec-runner.mjs");
  assert.equal(startupProblem(["--disable-sigusr1", "--experimental-strip-types"]), null);
  assert.equal(startupProblem(["--experimental-strip-types"]), "inspector_signal_enabled");
  assert.equal(startupProblem([]), "inspector_signal_enabled");
});
