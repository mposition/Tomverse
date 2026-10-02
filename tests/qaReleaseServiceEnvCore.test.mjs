import assert from "node:assert/strict";
import test from "node:test";

import {
  QA_RELEASE_SERVICE_VARIABLES,
  checkQaReleaseServiceEnv,
  decideQaReleaseServiceStart,
} from "../lib/qaReleaseServiceEnvCore.ts";

const runtime = { PATH: "/usr/bin", HOME: "/root", NODE_ENV: "production", RAILWAY_ENVIRONMENT_NAME: "staging", RAILWAY_DEPLOYMENT_ID: "d" };

const digestEnv = (overrides = {}) => ({
  ...runtime,
  QA_RELEASE_DIGEST_ENABLED: "true",
  QA_RELEASE_DIGEST_SECRET: "s".repeat(40),
  QA_RELEASE_GITHUB_READ_TOKEN: "t",
  QA_RELEASE_CONTROL_REVISION: "1",
  ...overrides,
});

const laneEnv = (overrides = {}) => ({
  ...runtime,
  QA_RELEASE_MERGE_LANE_SECRET: "s".repeat(40),
  QA_RELEASE_MERGE_LANE_APP_ID: "1",
  QA_RELEASE_MERGE_LANE_APP_PRIVATE_KEY: "k",
  QA_RELEASE_MERGE_LANE_RAILWAY_TOKEN: "r",
  QA_RELEASE_MERGE_LANE_ENABLED: "true",
  QA_RELEASE_CONTROL_REVISION: "3",
  ...overrides,
});

test("the three services share no secret or credential variable", () => {
  const [digest, monitor, lane] = Object.values(QA_RELEASE_SERVICE_VARIABLES);
  const shared = (a, b) => a.filter((name) => b.includes(name) && name !== "QA_RELEASE_CONTROL_REVISION");
  assert.deepEqual(shared(digest, monitor), []);
  assert.deepEqual(shared(digest, lane), []);
  assert.deepEqual(shared(monitor, lane), []);
});

test("a product-database or other credential name stops the service, without naming it", () => {
  for (const name of ["DATABASE_URL", "MAINTENANCE_SECRET", "OPS_ALERT_SLACK_WEBHOOK_URL", "GITHUB_TOKEN"]) {
    assert.deepEqual(checkQaReleaseServiceEnv("digest", [...Object.keys(digestEnv()), name]), {
      ok: false,
      unexpectedCount: 1,
    });
    assert.equal(decideQaReleaseServiceStart("digest", digestEnv({ [name]: "x" })), "refuse", name);
  }
});

test("another service's variable is unexpected too", () => {
  assert.equal(decideQaReleaseServiceStart("digest", digestEnv({ QA_RELEASE_MONITOR_SECRET: "m" })), "refuse");
  assert.equal(decideQaReleaseServiceStart("monitor", { ...runtime, QA_RELEASE_MONITOR_SECRET: "m", QA_RELEASE_CONTROL_REVISION: "1", QA_RELEASE_DIGEST_SECRET: "d" }), "refuse");
});

test("a complete digest environment runs; switched off exits quietly", () => {
  assert.equal(decideQaReleaseServiceStart("digest", digestEnv()), "run");
  assert.equal(decideQaReleaseServiceStart("digest", digestEnv({ QA_RELEASE_DIGEST_ENABLED: undefined })), "disabled");
  assert.equal(decideQaReleaseServiceStart("digest", digestEnv({ QA_RELEASE_DIGEST_ENABLED: "yes" })), "disabled");
});

test("enabled but missing a required value or a valid revision refuses", () => {
  assert.equal(decideQaReleaseServiceStart("digest", digestEnv({ QA_RELEASE_DIGEST_SECRET: "  " })), "refuse");
  for (const revision of ["", "0", "-1", "1.5", "abc", "1234567890"]) {
    assert.equal(decideQaReleaseServiceStart("digest", digestEnv({ QA_RELEASE_CONTROL_REVISION: revision })), "refuse", revision);
  }
});

test("the merge lane stops on any kill-switch value, before anything else", () => {
  assert.equal(decideQaReleaseServiceStart("mergeLane", laneEnv()), "run");
  for (const value of ["1", "true", "false", "off", "x"]) {
    assert.equal(decideQaReleaseServiceStart("mergeLane", laneEnv({ QA_RELEASE_MERGE_LANE_KILL_SWITCH: value })), "disabled", value);
  }
  assert.equal(decideQaReleaseServiceStart("mergeLane", laneEnv({ QA_RELEASE_MERGE_LANE_KILL_SWITCH: "" })), "run");
  assert.equal(decideQaReleaseServiceStart("mergeLane", laneEnv({ QA_RELEASE_MERGE_LANE_ENABLED: "false" })), "disabled");
});

test("the monitor runs with its own secret and a revision", () => {
  assert.equal(decideQaReleaseServiceStart("monitor", { ...runtime, QA_RELEASE_MONITOR_SECRET: "m", QA_RELEASE_CONTROL_REVISION: "2" }), "run");
  assert.equal(decideQaReleaseServiceStart("monitor", { ...runtime, QA_RELEASE_CONTROL_REVISION: "2" }), "refuse");
});

test("Railway variables are admitted by exact name only, never by prefix", () => {
  for (const name of ["RAILWAY_TOKEN", "RAILWAY_API_TOKEN", "RAILWAY_DATABASE_URL", "RAILWAY_"]) {
    assert.deepEqual(checkQaReleaseServiceEnv("digest", [...Object.keys(runtime), name]), { ok: false, unexpectedCount: 1 }, name);
  }
  assert.deepEqual(checkQaReleaseServiceEnv("digest", ["RAILWAY_GIT_COMMIT_SHA", "RAILWAY_SERVICE_ID", "PORT"]), { ok: true });
});

test("an unset or whitespace kill switch reads as empty, as policy section 8 item 6 defines it", () => {
  const unset = laneEnv();
  delete unset.QA_RELEASE_MERGE_LANE_KILL_SWITCH;
  assert.equal(decideQaReleaseServiceStart("mergeLane", unset), "run");
  assert.equal(decideQaReleaseServiceStart("mergeLane", laneEnv({ QA_RELEASE_MERGE_LANE_KILL_SWITCH: undefined })), "run");
  assert.equal(decideQaReleaseServiceStart("mergeLane", laneEnv({ QA_RELEASE_MERGE_LANE_KILL_SWITCH: "  " })), "run");
  // The other two inputs are not optional: an unset enable flag stops the lane.
  const noFlag = laneEnv();
  delete noFlag.QA_RELEASE_MERGE_LANE_ENABLED;
  assert.equal(decideQaReleaseServiceStart("mergeLane", noFlag), "disabled");
});
