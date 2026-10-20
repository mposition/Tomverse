import assert from "node:assert/strict";
import test from "node:test";

import { QA_RELEASE_CI_ADMISSION_POLL_MS, runQaReleaseCiAdmissionRound } from "../lib/qaReleaseCiAdmissionService.ts";

const T0 = Date.parse("2026-10-20T01:00:00Z");
const MIN = QA_RELEASE_CI_ADMISSION_POLL_MS;
const env = (overrides = {}) => ({
  QA_RELEASE_MERGE_LANE_APP_ID: "1",
  QA_RELEASE_MERGE_LANE_APP_PRIVATE_KEY: "k",
  QA_RELEASE_MERGE_LANE_KILL_SWITCH: "",
  QA_RELEASE_CONTROL_REVISION: "3",
  QA_RELEASE_CI_ADMISSION_MODE: "on",
  ...overrides,
});
const draft = (number, overrides = {}) => ({
  number,
  nodeId: `PR_${number}`,
  draft: true,
  labels: ["ci:queued"],
  base: "develop",
  head: `claude/to-develop/x${number}`,
  headSha: String(number % 10).repeat(40),
  queuedAt: new Date(T0 - (10 - number) * 60_000).toISOString(),
  ...overrides,
});

/**
 * A fake repository: a pull request marked ready leaves the draft line and,
 * one poll later, shows `jobsPerAdmission` running jobs.
 */
function fakePorts({ jobs = 0, pulls = [], failRead = false, failReady = new Set(), jobsPerAdmission = 0 } = {}) {
  let now = T0;
  const ready = [];
  const logs = [];
  return {
    ready,
    logs,
    ports: {
      github: {
        async activeJobs() {
          if (failRead) throw new Error("github_502");
          const admitted = pulls.filter((p) => ready.includes(p.nodeId));
          return [
            ...Array.from({ length: jobs }, () => ({ headSha: "f".repeat(40) })),
            ...admitted.flatMap((p) => Array.from({ length: jobsPerAdmission }, () => ({ headSha: p.headSha }))),
          ];
        },
        async queuedPullRequests() {
          return pulls.filter((p) => !ready.includes(p.nodeId));
        },
        async markReady(nodeId) {
          if (failReady.has(nodeId)) throw new Error("github_graphql_errors");
          ready.push(nodeId);
        },
      },
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      log: (entry) => logs.push(entry),
    },
  };
}

test("off, undeclared or a kill switch value does nothing and reads nothing", async () => {
  for (const overrides of [
    { QA_RELEASE_CI_ADMISSION_MODE: undefined },
    { QA_RELEASE_CI_ADMISSION_MODE: "off" },
    { QA_RELEASE_MERGE_LANE_KILL_SWITCH: "stop" },
  ]) {
    const fake = fakePorts({ failRead: true });
    assert.deepEqual(await runQaReleaseCiAdmissionRound(env(overrides), fake.ports, T0 + 10 * MIN), { exitCode: 0, admission: "disabled" });
    assert.equal(fake.logs.length, 0);
  }
  const fake = fakePorts();
  assert.deepEqual(await runQaReleaseCiAdmissionRound(env({ QA_RELEASE_CI_ADMISSION_MODE: "yes" }), fake.ports, T0 + MIN), {
    exitCode: 1,
    admission: "refused_to_start",
  });
});

test("on: admits one pull request at a time, in line order, as its jobs leave room", async () => {
  // Pull request 1 queued first; 2 has the priority label and goes ahead of it.
  const pulls = [draft(1), draft(2, { labels: ["ci:queued", "ci:priority"] })];
  const fake = fakePorts({ pulls, jobsPerAdmission: 28 });
  const outcome = await runQaReleaseCiAdmissionRound(env(), fake.ports, T0 + 3 * MIN);
  // Each fills the 28 admissible runners, so the second waits for the first.
  assert.deepEqual(fake.ready, ["PR_2"]);
  assert.equal(outcome.polls, 3);
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(fake.logs.map((entry) => entry.admitted), [[2], [], []]);
});

test("on: nothing is admitted while the repository is full", async () => {
  const fake = fakePorts({ jobs: 40, pulls: [draft(1)] });
  const outcome = await runQaReleaseCiAdmissionRound(env(), fake.ports, T0 + 2 * MIN);
  assert.deepEqual(fake.ready, []);
  assert.deepEqual(outcome.admitted, []);
  assert.equal(fake.logs[0].free, -12);
});

test("shadow: judges and logs but never writes, and never admits the same pull request twice", async () => {
  const fake = fakePorts({ pulls: [draft(1), draft(2)] });
  const outcome = await runQaReleaseCiAdmissionRound(env({ QA_RELEASE_CI_ADMISSION_MODE: "shadow" }), fake.ports, T0 + 3 * MIN);
  assert.equal(outcome.admission, "shadow");
  assert.deepEqual(fake.ready, []);
  assert.deepEqual(outcome.admitted, [1]); // the second waits for the first's estimated room
  assert.ok(fake.logs.every((entry) => entry.admission === "shadow"));
});

test("a failed read ends the round without admitting", async () => {
  const fake = fakePorts({ failRead: true, pulls: [draft(1)] });
  const outcome = await runQaReleaseCiAdmissionRound(env(), fake.ports, T0 + 5 * MIN);
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.polls, 1);
  assert.deepEqual(outcome.failures, ["read:github_502"]);
  assert.deepEqual(fake.ready, []);
});

test("a failed write is reported, not counted as admitted, and not retried in the same poll", async () => {
  const fake = fakePorts({ pulls: [draft(1)], failReady: new Set(["PR_1"]) });
  const outcome = await runQaReleaseCiAdmissionRound(env(), fake.ports, T0 + MIN);
  assert.equal(outcome.exitCode, 1);
  assert.deepEqual(outcome.admitted, []);
  assert.deepEqual(outcome.failures, ["ready:1:github_graphql_errors"]);
});
