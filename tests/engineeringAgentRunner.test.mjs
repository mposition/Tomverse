import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import test from "node:test";

import {
  GITHUB_LIST_MAX_PAGES,
  haltOf,
  nextPageUrl,
  observeUnbound,
  readGitHubList,
  runRunnerCycle,
} from "../scripts/engineering-agent-runner-core.mjs";
import { superviseCycle, SUPERVISED_ENV } from "../scripts/engineering-agent-supervisor.mjs";
import { prBodyMarker, shouldSendSuccessHeartbeat } from "../lib/engineeringAgentCore.ts";

// The runner service's cycle (docs/policy/engineering-agent.md §12) against
// fake ports: what it asks the app and in what order. It observes and
// triggers the pull request round; it takes no work and writes no code.

const fakeApp = (overrides = {}) => {
  const calls = [];
  const answers = {
    "worker/register": { status: 200, json: { registered: true, generation: 3 } },
    "observe/known": { status: 200, json: { bindings: [], consumed: [] } },
    "observe/halt": { status: 200, json: { recorded: true } },
    "worker/heartbeat": (body) => ({
      status: 200,
      json: { accepted: true, dispatchReady: body.dispatchReady, leaseExpiresAt: "x", halt: "none" },
    }),
    ...overrides,
  };
  const app = async (path, body) => {
    calls.push({ path, body });
    const answer = answers[path];
    return typeof answer === "function" ? answer(body) : answer;
  };
  return { app, calls };
};

const ports = (app, namespace = { refs: [], pulls: [] }, digests = {}) => ({
  app,
  namespace: async () => namespace,
  commitDigestAt: async (sha) => digests[sha] ?? null,
});

test("a cycle observes, triggers the pull request round and reports itself stopped, never ready", async () => {
  const { app, calls } = fakeApp();
  const result = await runRunnerCycle(ports(app));
  assert.deepEqual(result, { finishedNormally: true, halt: "none", reason: "observed" });
  assert.deepEqual(
    calls.map((call) => call.path),
    ["worker/register", "observe/known", "observe/known", "observe/pull-requests", "worker/heartbeat"],
  );
  const beat = calls.find((call) => call.path === "worker/heartbeat").body;
  assert.equal(beat.status, "stopped");
  assert.equal(beat.dispatchReady, false, "the runner never offers itself for work");
  assert.equal(calls.some((call) => call.path.startsWith("run/") || call.path.startsWith("delivery/")), false);
  assert.equal(shouldSendSuccessHeartbeat(result), true);
});

test("a closed adapter is a normal round; a lost runtime lease is not", async () => {
  const closed = fakeApp({ "worker/register": { status: 409, json: { refused: "adapter_closed" } } });
  assert.equal((await runRunnerCycle(ports(closed.app))).finishedNormally, true);
  assert.deepEqual(closed.calls.map((call) => call.path), ["worker/register"]);

  const lost = fakeApp({ "worker/heartbeat": () => ({ status: 409, json: { accepted: false } }) });
  assert.deepEqual(await runRunnerCycle(ports(lost.app)), {
    finishedNormally: false,
    halt: "unknown",
    reason: "runtime_lease_lost",
  });
});

test("a failed pull request round decides nothing and does not stop the cycle", async () => {
  const { app, calls } = fakeApp({ "observe/pull-requests": { status: 503, json: { error: "unavailable" } } });
  assert.deepEqual(await runRunnerCycle(ports(app)), { finishedNormally: true, halt: "none", reason: "observed" });
  assert.equal(calls.at(-1).path, "worker/heartbeat", "the runner still reports itself stopped");
});

test("the runner imports node builtins and the dependency-free core, and holds no model key", () => {
  const allowedLib = new Set(["lib/engineeringAgentCore.ts"]);
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gms)) {
      const specifier = match[1];
      if (specifier.startsWith("node:")) continue;
      assert.ok(specifier.startsWith("./") || specifier.startsWith("../"), `${file} imports ${specifier}`);
      const target = normalize(join(dirname(file), specifier)).replaceAll("\\", "/");
      assert.ok(
        target.startsWith("scripts/engineering-agent-") || allowedLib.has(target),
        `${file} reaches ${target}`,
      );
      visit(target);
    }
  };
  visit("scripts/engineering-agent-runner.mjs");
  assert.ok(seen.has("lib/engineeringAgentCore.ts"));
  const entry = readFileSync("scripts/engineering-agent-runner.mjs", "utf8");
  const reads = [...entry.matchAll(/required\("([A-Z_]+)"\)/g)].map((match) => match[1]);
  assert.ok(!reads.some((name) => /ANTHROPIC|OPENAI|MODEL/.test(name)), `the runner reads ${reads.join(", ")}`);
});

test("while anything halts, no round sends a success signal (§12, §13-17)", async () => {
  const halted = fakeApp({
    "worker/heartbeat": () => ({ status: 200, json: { accepted: true, dispatchReady: false, halt: "circuit_open" } }),
  });
  const quiet = await runRunnerCycle(ports(halted.app));
  assert.equal(quiet.halt, "circuit_open");
  assert.equal(shouldSendSuccessHeartbeat(quiet), false);

  const silent = fakeApp({ "worker/heartbeat": () => ({ status: 200, json: { accepted: true, dispatchReady: false } }) });
  const unknown = await runRunnerCycle(ports(silent.app));
  assert.equal(unknown.halt, "unknown", "an app that names no halt is not taken to have none");
  assert.equal(shouldSendSuccessHeartbeat(unknown), false);
  assert.equal(haltOf({ halt: "made_up" }), "unknown");
});

test("a branch or pull request passes only at a bound head or an allowed commit, by content not by name", async () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const C = "c".repeat(40);
  const allowed = "d".repeat(64);
  const known = {
    bindings: [{ runId: "111", prNumber: 7, headSha: A, verifiedHeadSha: A }],
    consumed: [{ runId: "222", commitDigest: allowed }],
  };
  const digests = { [C]: allowed, [B]: "e".repeat(64) };
  const commitDigestAt = async (sha) => digests[sha] ?? null;
  const observe = (refs, pulls) => observeUnbound({ refs, pulls, known, commitDigestAt });
  const bound = { number: 7, headRef: "agent/engineering/111", headSha: A, body: prBodyMarker("111") };

  assert.equal(await observe([{ ref: "refs/heads/agent/engineering/111", sha: A }], [bound]), "none");
  assert.equal(await observe([{ ref: "refs/heads/agent/engineering/111", sha: B }], []), "unbound_app_ref", "a bound run's branch moved");
  assert.equal(await observe([], [{ ...bound, headSha: B }]), "unbound_app_pr", "a bound pull request's head moved");
  assert.equal(
    await observe([{ ref: "refs/heads/agent/engineering/222", sha: C }], [{ number: 8, headRef: "agent/engineering/222", headSha: C, body: prBodyMarker("222") }]),
    "none",
    "the publisher's own push and PR, before its result, at exactly the allowed commit",
  );
  assert.equal(await observe([{ ref: "refs/heads/agent/engineering/222", sha: B }], []), "unbound_app_ref", "a consumed run at another commit");
  assert.equal(
    await observe([], [{ number: 8, headRef: "agent/engineering/222", headSha: C, body: "no marker" }]),
    "unbound_app_pr",
    "an unbound pull request needs the run marker too",
  );
  assert.equal(await observe([{ ref: "refs/heads/agent/engineering/333", sha: C }], []), "unbound_app_ref", "no record of the run");
  assert.equal(await observe([{ ref: "refs/heads/agent/engineering/not-a-run", sha: A }], []), "unbound_app_ref");
  assert.equal(await observe([], [{ number: 9, headRef: "feature/x", headSha: A, body: "<!-- engineering-agent run=5 -->" }]), "unbound_app_pr");
  assert.equal(await observe([], [{ number: 10, headRef: "feature/x", headSha: A, body: "hello" }]), "none");

  const { app, calls } = fakeApp();
  const result = await runRunnerCycle(ports(app, { refs: [{ ref: "refs/heads/agent/engineering/999", sha: A }], pulls: [] }));
  assert.deepEqual(result, { finishedNormally: true, halt: "unbound_app_ref", reason: "observed_unbound" });
  assert.deepEqual(calls.find((call) => call.path === "observe/halt").body, { halt: "unbound_app_ref" });
  assert.equal(calls.some((call) => call.path === "run/start"), false, "nothing starts after an unbound observation");
  assert.equal(shouldSendSuccessHeartbeat(result), false);

  const unreadable = fakeApp({ "observe/known": { status: 500, json: null } });
  assert.equal((await runRunnerCycle(ports(unreadable.app))).finishedNormally, false);
});

test("an unreadable commit leaves the observation undetermined, and a bound run passes only at its bound head", async () => {
  const A = "a".repeat(40);
  const C = "c".repeat(40);
  const allowed = "d".repeat(64);
  const unbound = { bindings: [], consumed: [{ runId: "222", commitDigest: allowed }] };
  assert.equal(
    await observeUnbound({ refs: [{ ref: "refs/heads/agent/engineering/222", sha: C }], pulls: [], known: unbound, commitDigestAt: async () => null }),
    "undetermined",
  );
  const { app, calls } = fakeApp({ "observe/known": { status: 200, json: unbound } });
  const round = await runRunnerCycle(ports(app, { refs: [{ ref: "refs/heads/agent/engineering/222", sha: C }], pulls: [] }));
  assert.deepEqual(round, { finishedNormally: false, halt: "unknown", reason: "observation_undetermined" });
  assert.equal(calls.some((call) => call.path === "observe/halt"), false, "nothing recorded for an object not read");

  // One unread entry does not hide a definite one beside it.
  assert.equal(
    await observeUnbound({
      refs: [
        { ref: "refs/heads/agent/engineering/222", sha: C },
        { ref: "refs/heads/agent/engineering/333", sha: A },
      ],
      pulls: [],
      known: unbound,
      commitDigestAt: async () => null,
    }),
    "unbound_app_ref",
  );
  assert.equal(
    await observeUnbound({ refs: [{ ref: "refs/heads/agent/engineering/222", sha: null }], pulls: [], known: unbound, commitDigestAt: async () => allowed }),
    "undetermined",
    "a missing sha cannot be compared either",
  );
  const bound = {
    bindings: [{ runId: "222", prNumber: 7, headSha: A, verifiedHeadSha: A }],
    consumed: [{ runId: "222", commitDigest: allowed }],
  };
  assert.equal(
    await observeUnbound({ refs: [{ ref: "refs/heads/agent/engineering/222", sha: C }], pulls: [], known: bound, commitDigestAt: async () => allowed }),
    "unbound_app_ref",
    "once bound, an earlier allowed commit is not the run's",
  );
});

test("a list GitHub did not give whole leaves the round undetermined, and a definite finding in the other is still recorded", async () => {
  const known = { bindings: [], consumed: [] };
  const digestAt = async () => null;
  assert.equal(await observeUnbound({ refs: null, pulls: [], known, commitDigestAt: digestAt }), "undetermined");
  assert.equal(await observeUnbound({ refs: [], pulls: null, known, commitDigestAt: digestAt }), "undetermined");
  assert.equal(
    await observeUnbound({ refs: [{ ref: "refs/heads/agent/engineering/5", sha: "a".repeat(40) }], pulls: null, known, commitDigestAt: digestAt }),
    "unbound_app_ref",
  );
  assert.equal(
    await observeUnbound({ refs: null, pulls: [{ number: 3, headRef: "agent/engineering/5", headSha: "a".repeat(40), body: "" }], known, commitDigestAt: digestAt }),
    "unbound_app_pr",
  );
  const { app, calls } = fakeApp();
  const round = await runRunnerCycle(ports(app, { refs: [{ ref: "refs/heads/agent/engineering/5", sha: "a".repeat(40) }], pulls: null }));
  assert.equal(round.halt, "unbound_app_ref");
  assert.deepEqual(calls.find((call) => call.path === "observe/halt").body, { halt: "unbound_app_ref" });
  const quiet = fakeApp();
  const undetermined = await runRunnerCycle(ports(quiet.app, { refs: [], pulls: null }));
  assert.deepEqual(undetermined, { finishedNormally: false, halt: "unknown", reason: "observation_undetermined" });
  assert.equal(quiet.calls.some((call) => call.path === "observe/halt"), false);
});

test("a first page of more is judged for what it holds, and never read as the whole list", async () => {
  const known = { bindings: [], consumed: [] };
  const digestAt = async () => null;
  const page = [{ number: 3, headRef: "agent/engineering/5", headSha: "a".repeat(40), body: "" }];
  assert.equal(await observeUnbound({ refs: [], pulls: page, pullsComplete: false, known, commitDigestAt: digestAt }), "unbound_app_pr");
  assert.equal(
    await observeUnbound({ refs: [], pulls: [{ number: 4, headRef: "feature/x", headSha: "a".repeat(40), body: "hi" }], pullsComplete: false, known, commitDigestAt: digestAt }),
    "undetermined",
    "nothing definite on the first page, and more pages unread",
  );
  const { app, calls } = fakeApp();
  const round = await runRunnerCycle(ports(app, { refs: [], pulls: page, refsComplete: true, pullsComplete: false }));
  assert.equal(round.halt, "unbound_app_pr");
  assert.deepEqual(calls.find((call) => call.path === "observe/halt").body, { halt: "unbound_app_pr" });
});

test("a GitHub list is read page after page, so more than 100 open pull requests still decide the round", async () => {
  const origin = "https://api.github.com/repos/mposition/Tomverse";
  const linkTo = (page) => `<${origin}/pulls?state=open&per_page=100&page=${page}>; rel="next", <${origin}/pulls?page=9>; rel="last"`;
  const pages = {
    [`${origin}/pulls?state=open&per_page=100`]: { status: 200, link: linkTo(2), body: [{ number: 1 }] },
    [`${origin}/pulls?state=open&per_page=100&page=2`]: { status: 200, link: linkTo(3), body: [{ number: 2 }] },
    [`${origin}/pulls?state=open&per_page=100&page=3`]: { status: 200, link: `<${origin}/pulls?page=1>; rel="first"`, body: [{ number: 3 }] },
  };
  const fetched = [];
  const fetchPage = async (url) => {
    fetched.push(url);
    return pages[url] ?? null;
  };
  const first = `${origin}/pulls?state=open&per_page=100`;
  assert.deepEqual(await readGitHubList(fetchPage, first, { origin }), {
    items: [{ number: 1 }, { number: 2 }, { number: 3 }],
    complete: true,
  });
  assert.equal(fetched.length, 3);

  // The page limit keeps what was read and says it is not the whole list.
  assert.deepEqual(await readGitHubList(fetchPage, first, { origin, maxPages: 2 }), {
    items: [{ number: 1 }, { number: 2 }],
    complete: false,
  });
  // A failed page makes the whole list unread, never a shorter whole list.
  const failing = async (url) => (url === first ? pages[first] : null);
  assert.equal(await readGitHubList(failing, first, { origin }), null);
  const notAList = async (url) => (url === first ? pages[first] : { status: 200, link: null, body: { message: "x" } });
  assert.equal(await readGitHubList(notAList, first, { origin }), null);
  // The read token goes with every page, so a next link off the API origin is not followed.
  const offOrigin = async () => ({ status: 200, link: '<https://evil.example/pulls?page=2>; rel="next"', body: [{ number: 1 }] });
  assert.deepEqual(await readGitHubList(offOrigin, first, { origin }), { items: [{ number: 1 }], complete: false });
  // No ref under the prefix is a 404: the empty, whole list.
  const notFound = async () => ({ status: 404, link: null, body: { message: "Not Found" } });
  assert.deepEqual(await readGitHubList(notFound, first, { origin, notFoundIsEmpty: true }), { items: [], complete: true });
  assert.equal(await readGitHubList(notFound, first, { origin }), null);

  assert.equal(nextPageUrl(null), null);
  assert.equal(nextPageUrl(`<${origin}/a?page=1>; rel="prev", <${origin}/a?page=3>; rel="next"`), `${origin}/a?page=3`);
  assert.equal(nextPageUrl(`<${origin}/a?page=1>; rel="first"`), null);
  assert.equal(GITHUB_LIST_MAX_PAGES >= 2, true);
});

test("the app's records must not move while GitHub is read, or nothing is judged", async () => {
  let reads = 0;
  const moving = fakeApp({
    "observe/known": () => {
      reads += 1;
      return { status: 200, json: { bindings: [], consumed: reads === 1 ? [] : [{ runId: "999", commitDigest: "f".repeat(64) }] } };
    },
  });
  const result = await runRunnerCycle(
    ports(moving.app, { refs: [{ ref: "refs/heads/agent/engineering/999", sha: "a".repeat(40) }], pulls: [] }),
  );
  assert.deepEqual(result, { finishedNormally: false, halt: "unknown", reason: "observation_raced" });
  assert.equal(moving.calls.some((call) => call.path === "observe/halt"), false, "a raced reading records no halt");
});

test("the supervisor runs the cycle in its own process group and kills the group at the deadline", async () => {
  const listeners = {};
  const spawned = [];
  const killed = [];
  const fetched = [];
  let fire = null;
  const timers = [];
  const child = { pid: 4242, on: (name, fn) => void (listeners[name] = fn) };
  const done = superviseCycle({
    deadlineMs: 1000,
    failUrl: "https://deadman.example/fail",
    event: "test_deadline",
    spawnImpl: (command, args, options) => {
      spawned.push({ command, args, options });
      return child;
    },
    kill: (pid, signal) => killed.push([pid, signal]),
    fetchImpl: async (url) => void fetched.push(url),
    setTimer: (fn, ms) => {
      timers.push(ms);
      // The deadline is held for the test to fire; the grace passes at once.
      if (fire === null) fire = fn;
      else fn();
      return timers.length;
    },
    clearTimer: () => undefined,
    graceMs: 5_000,
    execPath: "/usr/bin/node",
    execArgv: ["--experimental-strip-types"],
    argv: ["/usr/bin/node", "scripts/engineering-agent-runner.mjs"],
    env: { A: "1" },
  });
  assert.equal(spawned[0].options.detached, true, "a process group of its own");
  assert.equal(spawned[0].options.env[SUPERVISED_ENV], "1");
  assert.deepEqual(spawned[0].args, ["--experimental-strip-types", "scripts/engineering-agent-runner.mjs"]);
  await fire();
  assert.equal(await done, 70);
  assert.deepEqual(killed, [[-4242, "SIGTERM"], [-4242, "SIGKILL"]], "the whole group, by negative pid: a chance to revoke, then the kill");
  assert.deepEqual(timers, [1000, 5000]);
  assert.deepEqual(fetched, ["https://deadman.example/fail"], "the failure signal, never the success one");
  listeners.exit?.(137);
  assert.equal(killed.length, 2, "an exit after the deadline changes nothing");

  const normal = [];
  const exits = {};
  const finished = superviseCycle({
    deadlineMs: 1000,
    failUrl: null,
    event: "test",
    spawnImpl: () => ({ pid: 7, on: (name, fn) => void (exits[name] = fn) }),
    kill: (pid, signal) => normal.push([pid, signal]),
    setTimer: () => 1,
    clearTimer: () => undefined,
    argv: ["node", "x.mjs"],
    execArgv: [],
    env: {},
  });
  exits.exit(0);
  assert.equal(await finished, 0);
  assert.deepEqual(normal, [[-7, "SIGKILL"]], "anything the worker left behind ends with it");
});
