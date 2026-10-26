import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";

import {
  QA_RELEASE_IMAGE_VARIABLES,
  QA_RELEASE_SERVICE_VARIABLES,
  checkQaReleaseServiceEnv,
  decideQaReleaseServiceStart,
  isUnconfiguredAgentService,
} from "../lib/qaReleaseServiceEnvCore.ts";

const runtime = { PATH: "/usr/bin", HOME: "/root", NODE_ENV: "production", RAILWAY_ENVIRONMENT_NAME: "staging", RAILWAY_DEPLOYMENT_ID: "d" };

test("only a runtime-only environment with no operator configuration is dormant", () => {
  const own = ["SUPPORT_TRIAGE_RETENTION_SECRET"];
  assert.equal(isUnconfiguredAgentService(runtime, own), true);
  for (const environment of ["production", "dev", "pr-1", undefined])
    assert.equal(isUnconfiguredAgentService({ ...runtime, RAILWAY_ENVIRONMENT_NAME: environment }, own), false);
  for (const value of ["", " ", "synthetic"])
    assert.equal(isUnconfiguredAgentService({ ...runtime, SUPPORT_TRIAGE_RETENTION_SECRET: value }, own), false);
  for (const name of ["DATABASE_URL", "RAILWAY_TOKEN", "GITHUB_TOKEN", "QA_RELEASE_MONITOR_SECRET"])
    assert.equal(isUnconfiguredAgentService({ ...runtime, [name]: "synthetic" }, own), false);
});

test("the retention entry is dormant before importing an unreleased supervisor", { skip: process.platform === "win32" }, () => {
  const run = (extra = {}) => spawnSync(process.execPath,
    ["--experimental-strip-types", "scripts/support-triage-retention-service.mjs"], {
      env: { PATH: process.env.PATH, RAILWAY_ENVIRONMENT_NAME: "staging", ...extra }, encoding: "utf8",
    });
  const dormant = run();
  assert.equal(dormant.status, 0, dormant.stderr);
  assert.equal(JSON.parse(dormant.stdout.trim()).outcome, "unconfigured");
  for (const extra of [{ SUPPORT_TRIAGE_RETENTION_SECRET: "" }, { DATABASE_URL: "postgres://synthetic" }]) {
    const refused = run(extra);
    assert.notEqual(refused.status, 0);
    assert.equal(refused.stdout.includes('"unconfigured"'), false);
  }
});

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
  QA_RELEASE_MERGE_LANE_KILL_SWITCH: "",
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

/**
 * Every name a live Railway container built by Railpack from this repository
 * had beyond the runtime list above, read on 2026-10-09 (names only), plus
 * the two mise shim names the 2026-10-03 measurement recorded. Copied from
 * those measurements, not from the module.
 */
const MEASURED_IMAGE_NAMES = [
  "CI",
  "NEXT_TELEMETRY_DISABLED",
  "NPM_CONFIG_FETCH_RETRIES",
  "NPM_CONFIG_FUND",
  "NPM_CONFIG_PRODUCTION",
  "NPM_CONFIG_UPDATE_NOTIFIER",
  "RAILPACK_BUILT_AT",
  "RAILPACK_VERSION",
  "MISE_CACHE_DIR",
  "MISE_CONFIG_DIR",
  "MISE_DATA_DIR",
  "MISE_INSTALLS_DIR",
  "MISE_SHIMS_DIR",
  "__MISE_DIFF",
  "__MISE_SHIM",
  "RAILWAY_BETA_ENABLE_RUNTIME_V2",
];

test("the names the deployed image provides do not stop a service", () => {
  // Until 2026-10-09 every one of these refused the start, so the Monitor and
  // the Digest exited 1 on every scheduled run without doing anything.
  const image = Object.fromEntries(MEASURED_IMAGE_NAMES.map((name) => [name, "x"]));
  assert.equal(decideQaReleaseServiceStart("digest", digestEnv(image)), "run");
  assert.equal(decideQaReleaseServiceStart("mergeLane", laneEnv(image)), "run");
  assert.equal(
    decideQaReleaseServiceStart("monitor", { ...runtime, ...image, QA_RELEASE_MONITOR_SECRET: "m", QA_RELEASE_CONTROL_REVISION: "2" }),
    "run",
  );
});

test("the image list is exactly the measurement, so a name cannot be added without measuring", () => {
  const imageOnly = MEASURED_IMAGE_NAMES.filter((name) => name !== "RAILWAY_BETA_ENABLE_RUNTIME_V2");
  assert.deepEqual([...QA_RELEASE_IMAGE_VARIABLES].sort(), [...imageOnly].sort());
});

test("the image's families are admitted by exact name only, never by prefix", () => {
  for (const name of ["NPM_CONFIG__AUTH", "NPM_CONFIG_TOKEN", "MISE_GITHUB_TOKEN", "RAILPACK_SECRET", "__MISE_", "RAILWAY_BETA_TOKEN"]) {
    assert.deepEqual(checkQaReleaseServiceEnv("digest", [...Object.keys(digestEnv()), name]), { ok: false, unexpectedCount: 1 }, name);
  }
});

test("the merge lane runs only on a declared, empty kill switch; unset is unreadable and stops it", () => {
  assert.equal(decideQaReleaseServiceStart("mergeLane", laneEnv()), "run");
  const unset = laneEnv();
  delete unset.QA_RELEASE_MERGE_LANE_KILL_SWITCH;
  assert.equal(decideQaReleaseServiceStart("mergeLane", unset), "disabled");
  assert.equal(decideQaReleaseServiceStart("mergeLane", laneEnv({ QA_RELEASE_MERGE_LANE_KILL_SWITCH: undefined })), "disabled");
  for (const value of ["1", "true", "false", "off", "0", " x ", " ", "\t"]) {
    assert.equal(decideQaReleaseServiceStart("mergeLane", laneEnv({ QA_RELEASE_MERGE_LANE_KILL_SWITCH: value })), "disabled", value);
  }
  // The enable flag is just as required: unset stops the lane.
  const noFlag = laneEnv();
  delete noFlag.QA_RELEASE_MERGE_LANE_ENABLED;
  assert.equal(decideQaReleaseServiceStart("mergeLane", noFlag), "disabled");
});

test("the release train is its own service: its own names, its flag is its switch", async () => {
  const { decideQaReleaseTrainStart } = await import("../lib/qaReleaseServiceEnvCore.ts");
  const train = (overrides = {}) => ({
    QA_RELEASE_MERGE_LANE_SECRET: "s".repeat(40),
    QA_RELEASE_MERGE_LANE_APP_ID: "1",
    QA_RELEASE_MERGE_LANE_APP_PRIVATE_KEY: "k",
    QA_RELEASE_CONTROL_REVISION: "3",
    QA_RELEASE_TRAIN_ENABLED: "true",
    ...overrides,
  });
  assert.equal(decideQaReleaseTrainStart(train()), "run");
  assert.equal(decideQaReleaseTrainStart(train({ QA_RELEASE_TRAIN_SLOTS: "9,15" })), "run");
  assert.equal(decideQaReleaseTrainStart(train({ RAILPACK_DEPLOY_APT_PACKAGES: "git" })), "run");
  for (const flag of [undefined, "false", "TRUE", "1"]) assert.equal(decideQaReleaseTrainStart(train({ QA_RELEASE_TRAIN_ENABLED: flag })), "disabled", String(flag));
  assert.equal(decideQaReleaseTrainStart(train({ QA_RELEASE_MERGE_LANE_APP_PRIVATE_KEY: "" })), "refuse");
  assert.equal(decideQaReleaseTrainStart(train({ QA_RELEASE_CONTROL_REVISION: "0" })), "refuse");
  // The develop lane's names are not the train's: a lane variable left on the
  // train service stops it, as any unexpected name does.
  for (const name of ["QA_RELEASE_MERGE_LANE_RAILWAY_TOKEN", "QA_RELEASE_MERGE_LANE_ENABLED", "QA_RELEASE_MERGE_LANE_KILL_SWITCH", "GITHUB_TOKEN"]) {
    assert.equal(decideQaReleaseTrainStart(train({ [name]: "x" })), "refuse", name);
  }
  // And the train's are not the lane's.
  assert.equal(decideQaReleaseServiceStart("mergeLane", laneEnv({ QA_RELEASE_TRAIN_ENABLED: "true" })), "refuse");
});
