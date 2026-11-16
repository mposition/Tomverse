import assert from "node:assert/strict";
import { basename } from "node:path";
import test from "node:test";

import { CLAUDE_ARGS, readRunnerConfig, runDailyBatch, runLocked, runOnce } from "../tools/auto-rec-agent/bin/autorec-runner.mjs";
import { LIMITS } from "../tools/auto-rec-agent/lib/contract.mjs";
import { INSTRUCTION_PREAMBLE, branchNameFor } from "../tools/auto-rec-agent/lib/core.mjs";

const BASE = "e".repeat(40);
const HEAD = "c".repeat(40);
const TREE = "f".repeat(40);
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
  [/^git .* rev-parse --verify HEAD\^\{tree\}$/, ok(`${TREE}\n`)],
  [/^git .* commit-tree /, ok(`${HEAD}\n`)],
  [/^git .* diff --raw/, ok(raw("lib/chatAttemptExecution.ts") + raw("tests/chatAttemptExecution.test.mjs"))],
  [/^claude /, ok(JSON.stringify({ subtype: "success", result: JSON.stringify({ disposition: "implemented", evidence: "Adds an unmet behavior with a regression test." }), num_turns: 7 }))],
  [/review\.mjs submit /, exit(3, JSON.stringify({ jobId: JOB, status: "pending" }))],
  [/review\.mjs wait /, ok(JSON.stringify({ jobId: JOB, status: "accept", base: BASE, head: HEAD, focus: null }))],
];

function fakeRunner({ rules = [], gateway = {}, now = NOW, lockFree = true, files = {} } = {}) {
  const calls = [];
  const gatewayCalls = [];
  const events = [];
  const runLogs = [];
  let clock = now;
  const allRules = [...rules, ...DEFAULT_RULES];
  const replies = {
    claim: { status: "claimed", claim: CLAIM },
    publish: { status: "published", prUrl: PR_URL, number: 2900, bodyUpdated: true },
    result: { status: "reported" },
    halt_notice: { status: "recorded" },
    work_context: { status: "context", pulls: [] },
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
    runLog: (section, text) => runLogs.push({ section, text }),
    startRunLog: () => {},
    pruneLogs: () => {},
  };
  return { deps, calls, gatewayCalls, events, runLogs };
}

const ops = (gatewayCalls) => gatewayCalls.map(({ header }) => header.op);

test("daily work inspects an open PR by SHA and skips a differently named duplicate without publishing", async () => {
  const prHead = "d".repeat(40);
  const { deps, calls, gatewayCalls } = fakeRunner({ gateway: { work_context: { status: "context", pulls: [{ number: 4035, head: prHead, title: "Different wording" }] } }, rules: [
    [/rev-parse refs\/autorec\/context\//, ok(prHead)],
    [/^claude /, (_signature, options) => {
      assert.match(options.input, /4035/);
      assert.match(options.input, new RegExp(prHead));
      return ok(JSON.stringify({ result: JSON.stringify({ disposition: "covered_by_pr", relatedPr: 4035, evidence: "The open PR already collapses this diagnostic content." }) }));
    }],
  ] });
  deps.config.dailyProduct = true;
  assert.equal(await runLocked(deps), 0);
  assert.equal(gatewayCalls.find(x => x.header.op === "result").header.reason, "covered_by_pr");
  assert.equal(ops(gatewayCalls).includes("publish"), false);
  assert.equal(calls.some(x => /review\.mjs submit|commit-tree/.test(x.signature)), false);
});

test("daily no-op assessments require a real base ancestor or a supplied PR", async () => {
  for (const [assessment, reason] of [
    [{ disposition: "already_satisfied", satisfiedByCommit: BASE, evidence: "Existing implementation and regression test." }, "already_satisfied"],
    [{ disposition: "covered_by_pr", relatedPr: 999, evidence: "Not in the snapshot." }, "no_change"],
    [{ disposition: "already_satisfied", satisfiedByCommit: "not-a-commit", evidence: "Invalid reference." }, "no_change"],
  ]) {
    const { deps, gatewayCalls } = fakeRunner({ rules: [[/^claude /, ok(JSON.stringify({ result: JSON.stringify(assessment) }))]] });
    deps.config.dailyProduct = true;
    await runLocked(deps);
    assert.equal(gatewayCalls.find(x => x.header.op === "result").header.reason, reason);
    assert.equal(ops(gatewayCalls).includes("publish"), false);
  }
});

test("daily batches carry previous work forward and advance after a verified no-op", async () => {
  let claimed = 0, implemented = 0;
  const { deps, gatewayCalls } = fakeRunner({ gateway: { claim: () => ++claimed <= 2 ? { status: "claimed", claim: { ...CLAIM, id: `scout.${claimed}` } } : { status: "empty" } }, rules: [
    [/^claude /, (_signature, options) => {
      if (++implemented === 2) assert.match(options.input, /scout\.1/);
      return ok(JSON.stringify({ result: JSON.stringify({ disposition: "already_satisfied", satisfiedByCommit: BASE, evidence: "Current develop already provides the behavior." }) }));
    }],
  ] });
  deps.config.dailyProduct = true;
  assert.equal(await runDailyBatch(deps), 0);
  assert.equal(implemented, 2);
  assert.equal(gatewayCalls.filter(x => x.header.op === "result" && x.header.reason === "already_satisfied").length, 2);
});

test("daily work fails closed when the open PR snapshot is unavailable", async () => {
  const { deps, calls, gatewayCalls } = fakeRunner({ gateway: { work_context: { status: "error" } } });
  deps.config.dailyProduct = true;
  await runLocked(deps);
  assert.equal(gatewayCalls.find(x => x.header.op === "result").header.reason, "setup_failed");
  assert.equal(calls.some(x => /^claude /.test(x.signature)), false);
});

test("an unmet daily task with an explicit assessment still completes review and publication", async () => {
  const { deps, gatewayCalls } = fakeRunner();
  deps.config.dailyProduct = true;
  assert.equal(await runLocked(deps), 0);
  assert.deepEqual(ops(gatewayCalls), ["claim", "work_context", "publish", "result"]);
  assert.equal(gatewayCalls.at(-1).header.outcome, "pr_opened");
});

test("a push during PR snapshot fetch uses the fetched SHA without halting the daily work", async () => {
  const { deps, calls, gatewayCalls } = fakeRunner({ gateway: { work_context: { status: "context", pulls: [{ number: 5, head: HEAD }] } },
    rules: [[/rev-parse refs\/autorec\/context\//, ok(BASE)]] });
  deps.config.dailyProduct = true;
  await runLocked(deps);
  assert.equal(gatewayCalls.find(x => x.header.op === "result").header.outcome, "pr_opened");
  const model = calls.find(x => /^claude /.test(x.signature));
  assert.match(model.options.input, new RegExp(`"head":"${BASE}"`));
  assert.ok(calls.some(x => /update-ref -d refs\/autorec\/context\/pr-5/.test(x.signature)));
});

test("daily skip assessments accept a single JSON fence without losing a valid result", async () => {
  const assessment = { disposition: "already_satisfied", satisfiedByCommit: BASE, evidence: "Existing implementation and regression test." };
  const { deps, gatewayCalls } = fakeRunner({ rules: [[/^claude /, ok(JSON.stringify({ result: "```json\n" + JSON.stringify(assessment) + "\n```" }))]] });
  deps.config.dailyProduct = true;
  await runLocked(deps);
  assert.equal(gatewayCalls.find(x => x.header.op === "result").header.reason, "already_satisfied");
});

test("an unrelated PR without a usable diff does not halt daily implementation", async () => {
  const { deps, gatewayCalls } = fakeRunner({ gateway: { work_context: { status: "context", pulls: [{ number: 5, head: HEAD }] } }, rules: [
    [/rev-parse refs\/autorec\/context\//, ok(HEAD)],
    [/diff --name-only/, exit(128)],
    [/^claude /, (_signature, options) => {
      assert.match(options.input, /"pathsUnavailable":true/);
      return ok(JSON.stringify({ result: JSON.stringify({ disposition: "implemented", evidence: "An unmet change remains; the unrelated PR cannot provide it." }) }));
    }],
  ] });
  deps.config.dailyProduct = true;
  assert.equal(await runLocked(deps), 0);
  assert.equal(gatewayCalls.find(x => x.header.op === "result").header.outcome, "pr_opened");
});

test("daily mode continues after a known no-change result and ends at an empty queue", async () => {
  let claims = 0;
  const { deps, gatewayCalls } = fakeRunner({
    rules: [[/^git .* diff --raw/, ok("")]],
    gateway: { claim: () => ++claims <= 2 ? { status: "claimed", claim: { ...CLAIM, id: `scout.item${claims}` } } : { status: "empty" } },
  });
  deps.config.dailyProduct = true;
  assert.equal(await runOnce(deps), 0);
  assert.deepEqual(ops(gatewayCalls), ["claim", "work_context", "result", "claim", "work_context", "result", "claim"]);
  assert.ok(gatewayCalls.filter(({ header }) => header.op === "result").every(({ header }) => header.reason === "no_change"));
});

test("daily mode stops on unknown publishing or reporting without claiming another task", async () => {
  for (const gateway of [{ publish: { status: "unknown", step: "pr_not_draft" } }, { result: { status: "unknown" } }]) {
    const { deps, gatewayCalls, events } = fakeRunner({ gateway });
    assert.equal(await runDailyBatch(deps), 1);
    assert.equal(ops(gatewayCalls).filter((op) => op === "claim").length, 1);
    const notice = gatewayCalls.filter(({ header }) => header.op === "halt_notice");
    assert.equal(notice.length, 1);
    assert.equal(notice[0].header.reason, gateway.publish ? "publish_unknown" : "result_unknown");
    if (gateway.publish) assert.equal(events.find((event) => event.event === "publish_answer")?.step, "pr_not_draft");
  }
});

test("a daily batch is bounded by the existing 24-publication daily ceiling", async () => {
  const { deps, gatewayCalls } = fakeRunner({ rules: [[/^git .* diff --raw/, ok("")]] });
  assert.equal(await runDailyBatch(deps), 0);
  assert.equal(ops(gatewayCalls).filter((op) => op === "claim").length, LIMITS.tasksPerDay);
});

test("a reported infrastructure failure pauses the batch before it can consume more suggestions", async () => {
  const { deps, gatewayCalls, events } = fakeRunner({ rules: [[/^claude /, exit(1)]] });
  assert.equal(await runDailyBatch(deps), 1);
  assert.deepEqual(ops(gatewayCalls), ["claim", "result", "halt_notice"]);
  assert.equal(gatewayCalls[1].header.reason, "agent_error");
  assert.ok(events.some((event) => event.event === "daily_batch_paused"));
});

test("a halt notice carries the last confirmed PR and never retries an unknown notice", async () => {
  let publications = 0;
  const { deps, gatewayCalls, events } = fakeRunner({ gateway: {
    publish: () => ++publications === 1 ? { status: "published", prUrl: PR_URL } : { status: "unknown" },
    halt_notice: new Error("lost answer"),
  } });
  assert.equal(await runDailyBatch(deps), 1);
  const notices = gatewayCalls.filter(({ header }) => header.op === "halt_notice");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].header.attempted, 2);
  assert.equal(notices[0].header.prOpened, 1);
  assert.equal(notices[0].header.lastPrUrl, PR_URL);
  assert.equal(notices[0].header.reason, "publish_unknown");
  assert.equal(gatewayCalls.filter(({ header }) => header.op === "claim").length, 2);
  assert.ok(events.some(({ event }) => event === "halt_notice_unknown"));
});

test("an empty queue and the normal daily cap do not page the operator", async () => {
  const { deps, gatewayCalls } = fakeRunner({ gateway: { claim: { status: "empty" } } });
  assert.equal(await runDailyBatch(deps), 0);
  assert.deepEqual(ops(gatewayCalls), ["claim"]);
  const full = fakeRunner({ rules: [[/^git .* diff --raw/, ok("")]] });
  assert.equal(await runDailyBatch(full.deps), 0);
  assert.equal(full.gatewayCalls.some(({ header }) => header.op === "halt_notice"), false);
});

test("a known result refusal is distinct from an unknown publication", async () => {
  const { deps, gatewayCalls } = fakeRunner({ gateway: { result: { status: "error", code: "http_409" } } });
  assert.equal(await runDailyBatch(deps), 1);
  const notice = gatewayCalls.find(({ header }) => header.op === "halt_notice").header;
  assert.equal(notice.reason, "result_failed");
  assert.equal(notice.prOpened, 1);
  assert.equal(notice.lastPrUrl, PR_URL);
  assert.equal(gatewayCalls.filter(({ header }) => header.op === "claim").length, 1);
});

test("the same agent call supplies the public commit and PR summary without copying Scout source text", async () => {
  const publicSummary = "Keep the mobile model label visible";
  const privateText = "Private Scout analysis note";
  const { deps, gatewayCalls, calls } = fakeRunner({
    gateway: { claim: { status: "claimed", claim: { ...CLAIM, id: "scout.one", recommendation: privateText } } },
    rules: [[/^claude /, ok(JSON.stringify({ result: JSON.stringify({ publicSummary, outcomeNote: "Tested" }) }))]],
  });
  assert.equal(await runLocked(deps), 0);
  const published = gatewayCalls.find(({ header }) => header.op === "publish").header;
  assert.equal(published.title, `fix: ${publicSummary}`);
  assert.ok(published.body.includes(publicSummary));
  assert.ok(!published.body.includes(privateText));
  assert.equal(calls.find((call) => call.args.includes("commit-tree")).options.input, `fix: ${publicSummary}\n`);
});
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

  const fetchDevelop = calls.find(({ signature }) => / fetch --no-tags /.test(signature));
  assert.deepEqual(fetchDevelop.args.slice(2, 5), ["-c", "http.version=HTTP/1.1", "fetch"]);

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
  assert.deepEqual(submit.args.slice(1, 6), ["submit", "--author", "claude", "--base", BASE]);
  // The worktree goes away at the end.
  assert.ok(ran(calls, / worktree remove --force /));
  assert.ok(calls.some(({ signature }) => signature.endsWith(` branch -D ${BRANCH}`)));
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
  ["review accepts another head", [[/review\.mjs wait/, ok(JSON.stringify({ status: "accept", base: BASE, head: "d".repeat(40) }))]], "review_unknown"],
  ["review accepts another base", [[/review\.mjs wait/, ok(JSON.stringify({ status: "accept", base: HEAD, head: HEAD }))]], "review_unknown"],
  [
    "review accepts only a focus range",
    [[/review\.mjs wait/, ok(JSON.stringify({ status: "accept", base: BASE, head: HEAD, focus: "d".repeat(40) }))]],
    "review_unknown",
  ],
  ["the squash commit cannot be made", [[/ commit-tree /, exit(128)]], "runner_error"],
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

test("a refused review submit preserves a redacted private diagnostic and exact range without retrying", async () => {
  const syntheticAccessKey = ["AK", "IA", "1234567890123456"].join("");
  const stderr = JSON.stringify({ error: "client", message: "git bundle failed: retained-error-detail" }) +
    "\nBearer confidential-bearer-value\npassword=confidential-password-value\n" +
    "https://fixture:confidential-url-value@example.test/repo\nghp_confidentialTokenValue123" +
    '\n{"token": "confidential quoted multi word value"}\n' +
    "-----BEGIN PRIVATE KEY-----\nconfidential-private-key\n-----END PRIVATE KEY-----\n" +
    syntheticAccessKey + "\npassword=confidential-value;punctuation-secret,tail";
  const { deps, calls, gatewayCalls, events, runLogs } = fakeRunner({ rules: [
    [/review\.mjs submit/, { ...exit(64), stderr }],
  ] });
  assert.equal(await runDailyBatch(deps), 1);
  assert.deepEqual(ops(gatewayCalls), ["claim", "result", "halt_notice"]);
  assert.equal(calls.filter(({ signature }) => /review\.mjs submit/.test(signature)).length, 1);
  assert.equal(ran(calls, /review\.mjs wait/), false);
  assert.deepEqual(events.find(({ event }) => event === "review_requested"), { event: "review_requested", base: BASE, head: HEAD });
  const diagnostic = runLogs.find(({ section }) => section === "review_submit")?.text;
  assert.match(diagnostic, /retained-error-detail/);
  assert.doesNotMatch(diagnostic, /confidential/);
  assert.doesNotMatch(diagnostic, /quoted multi word|punctuation-secret/);
  assert.equal(diagnostic.includes(syntheticAccessKey), false);
  assert.doesNotMatch(JSON.stringify({ gatewayCalls, events }), /retained-error-detail|confidential/);
});

test("a failed test preserves the prepared range before worktree cleanup without submitting review", async () => {
  const { deps, calls, gatewayCalls, events } = fakeRunner({ rules: [[/--test-concurrency=1/, exit(1)]] });
  assert.equal(await runLocked(deps), 0);
  assert.deepEqual(events.find(({ event }) => event === "change_prepared"), { event: "change_prepared", base: BASE, head: HEAD });
  assert.ok(events.findIndex(({ event }) => event === "change_prepared") < events.findIndex(({ event }) => event === "tests_run"));
  assert.equal(resultOf(gatewayCalls).reason, "tests");
  assert.equal(ran(calls, /review\.mjs submit/), false);
  assert.equal(ops(gatewayCalls).includes("publish"), false);
});

test("an unknown review wait preserves diagnostics without submitting another review", async () => {
  const { deps, calls, runLogs, gatewayCalls } = fakeRunner({ rules: [
    [/review\.mjs wait/, { ...exit(2), stderr: "review-outcome-unknown-fixture" }],
  ] });
  assert.equal(await runDailyBatch(deps), 1);
  assert.equal(calls.filter(({ signature }) => /review\.mjs submit/.test(signature)).length, 1);
  assert.match(runLogs.find(({ section }) => section === "review_wait")?.text, /review-outcome-unknown-fixture/);
  assert.deepEqual(ops(gatewayCalls), ["claim", "result", "halt_notice"]);
});

test("a review range mismatch keeps the actual response privately and stays fail-closed", async () => {
  const actualHead = "d".repeat(40);
  const { deps, runLogs, gatewayCalls } = fakeRunner({ rules: [
    [/review\.mjs wait/, ok(JSON.stringify({ status: "accept", base: BASE, head: actualHead }))],
  ] });
  assert.equal(await runDailyBatch(deps), 1);
  assert.deepEqual(ops(gatewayCalls), ["claim", "result", "halt_notice"]);
  assert.match(runLogs.find(({ section }) => section === "review_wait")?.text, new RegExp(actualHead));
});

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

test("what leaves is one runner-made commit of the agent's final tree on this run's develop", async () => {
  const { deps, calls } = fakeRunner();
  await runOnce(deps);
  const order = (pattern) => calls.findIndex(({ signature }) => pattern.test(signature));
  const squash = calls[order(/ commit-tree /)];
  assert.deepEqual(squash.args.slice(-5), [TREE, "-p", BASE, "-F", "-"]);
  assert.equal(squash.options.env.GIT_AUTHOR_NAME, "tomverse-auto-rec[bot]");
  assert.ok(!("CLAUDE_CODE_OAUTH_TOKEN" in squash.options.env));
  // The branch moves onto it before the scope check, the tests and the review.
  assert.ok(order(new RegExp(` reset --quiet --hard ${HEAD}$`)) > order(/ commit-tree /));
  assert.ok(order(/ commit-tree /) < order(/ diff --raw/));
  assert.deepEqual(calls[order(/ diff --raw/)].args.slice(-2), [BASE, HEAD]);
});

test("a pending review is waited on until it decides", async () => {
  let waits = 0;
  const { deps, gatewayCalls } = fakeRunner({
    rules: [[/review\.mjs wait/, () => (++waits < 3 ? exit(3, "{}") : ok(JSON.stringify({ status: "accept", base: BASE, head: HEAD })))]],
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
        () => (++waits === 1 ? { code: 137, stdout: "", stderr: "", timedOut: true } : ok(JSON.stringify({ status: "accept", base: BASE, head: HEAD }))),
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

test("a failing related test names itself in the journal, not only in the totals", async () => {
  const tap = ["not ok 1 - the change breaks this", "  ---", "  error: 'boom'", "  ...", "# fail 1"].join("\n");
  const { deps, events } = fakeRunner({ rules: [[/--test-concurrency=1/, { code: 1, stdout: tap, stderr: "", timedOut: false }]] });
  assert.equal(await runOnce(deps), 0);
  const failed = events.find((entry) => entry.event === "tests_failed");
  assert.deepEqual(failed?.failures, ["the change breaks this"]);
});
