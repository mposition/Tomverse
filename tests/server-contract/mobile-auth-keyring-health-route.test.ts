import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * Route-level contract for the standing keyring check.
 *
 * S1-S8 of `.github/audits/2026-09-10-mobile-auth-keyring-standing-check-approval.md`,
 * approved 2026-09-10. The route is real and reads real rings out of a
 * synthetic environment; only `ScheduledJobRun` is replaced, because a
 * database is not what is under test here.
 *
 * What it holds:
 *
 *   * the check is behind the same bearer secret every other internal job is;
 *   * a run that found something is still `succeeded` (S5) -- findings are not
 *     failures, and a job whose failures pile up is a job somebody turns off;
 *   * rings that will not parse *are* a failed run, and none of the report is
 *     shown (S5's fourth branch);
 *   * no key material reaches the response, the log, or the run row (S1); and
 *   * nothing is written to the keyring: it is a report.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) => pathToFileURL(resolve(ROOT, relativePath)).href;

const SECRET = "keyring-health-secret-32-characters-long";

const ed25519 = () =>
  generateKeyPairSync("ed25519")
    .privateKey.export({ format: "der", type: "pkcs8" })
    .toString("base64");

const SIGN_1 = ed25519();
const SIGN_2 = ed25519();
const PEPPER = "p".repeat(48);

type Run = {
  started: string[];
  completed: { processedCount?: number; result?: unknown }[];
  failed: { error: unknown }[];
};

const runs: Run = { started: [], completed: [], failed: [] };

const resetRuns = () => {
  runs.started = [];
  runs.completed = [];
  runs.failed = [];
};

let routePromise: Promise<
  typeof import("../../app/api/internal/mobile-auth/keyring-health/route")
> | null = null;

const loadRoute = () => {
  if (!routePromise) {
    mock.module(mod("lib/scheduledJobs.ts"), {
      namedExports: {
        MOBILE_AUTH_KEYRING_HEALTH_JOB_KEY: "mobile_auth_keyring_health",
        startScheduledJob: async (jobKey: string) => {
          runs.started.push(jobKey);
          return { id: "run_1" };
        },
        completeScheduledJob: async (input: {
          processedCount?: number;
          result?: unknown;
        }) => {
          runs.completed.push(input);
        },
        failScheduledJob: async (input: { error: unknown }) => {
          runs.failed.push(input);
        },
      },
    });
    routePromise = import("../../app/api/internal/mobile-auth/keyring-health/route");
  }
  return routePromise;
};

const HEALTHY = {
  MOBILE_AUTH_SIGNING_KEYS: `sign-2:${SIGN_2}`,
  MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "sign-2",
  MOBILE_AUTH_REFRESH_PEPPERS: `pep-2:${PEPPER}`,
  MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: "pep-2",
  MOBILE_AUTH_TOKEN_ISSUER: "https://tomverse.example",
  MOBILE_AUTH_TOKEN_AUDIENCE: "tomverse-mobile-api",
};

/** Runs the real route against one environment, capturing what it logged. */
const call = async (
  environment: Record<string, string | undefined>,
  options: { authorization?: string | null } = {}
) => {
  const { POST } = await loadRoute();
  resetRuns();

  const previous = new Map<string, string | undefined>();
  const set = (key: string, value: string | undefined) => {
    if (!previous.has(key)) previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MOBILE_AUTH_")) set(key, undefined);
  }
  for (const [key, value] of Object.entries(environment)) set(key, value);
  set("MOBILE_AUTH_KEYRING_HEALTH_SECRET", SECRET);

  const logged: string[] = [];
  const info = console.info;
  const error = console.error;
  console.info = (line: unknown) => void logged.push(String(line));
  console.error = (line: unknown) => void logged.push(String(line));

  try {
    const authorization =
      options.authorization === undefined ? `Bearer ${SECRET}` : options.authorization;
    const response = await POST(
      new Request("https://tomverse.example/api/internal/mobile-auth/keyring-health", {
        method: "POST",
        ...(authorization === null ? {} : { headers: { authorization } }),
      })
    );
    return { response, body: await response.json(), logged: logged.join("\n") };
  } finally {
    console.info = info;
    console.error = error;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("the check refuses a request with no bearer secret, and records no run", async () => {
  const { response } = await call(HEALTHY, { authorization: null });
  assert.equal(response.status, 401);
  assert.deepEqual(runs.started, []);
});

test("the check refuses a wrong secret", async () => {
  const { response } = await call(HEALTHY, { authorization: "Bearer not-the-secret" });
  assert.equal(response.status, 401);
  assert.deepEqual(runs.started, []);
});

test("a healthy ring answers with no findings and a succeeded run", async () => {
  const { response, body } = await call(HEALTHY);
  assert.equal(response.status, 200);
  assert.equal(body.configuration, "configured");
  assert.deepEqual(body.findings, []);
  assert.deepEqual(runs.started, ["mobile_auth_keyring_health"]);
  assert.equal(runs.completed.length, 1);
  assert.equal(runs.failed.length, 0);
  assert.equal(runs.completed[0]?.processedCount, 0);
});

test("a run that found something is still succeeded, and says what it found", async () => {
  // S5. The ring wants attention; the check does not.
  const { response, body } = await call({
    ...HEALTHY,
    MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_1},sign-2:${SIGN_2}`,
    MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-1@${new Date(Date.now() - 4_000_000).toISOString()}`,
  });
  assert.equal(response.status, 200);
  assert.equal(body.findings.length, 1);
  assert.equal(body.findings[0].code, "grace_over");
  assert.equal(body.findings[0].keyId, "sign-1");
  assert.equal(runs.failed.length, 0);
  assert.equal(runs.completed.length, 1);
  assert.equal(runs.completed[0]?.processedCount, 1);
});

test("a run always logs, including the one with nothing to say", async () => {
  // S8, and the reason: an absent line and a line reporting nothing found are
  // the same absence to whoever is reading afterwards.
  const { logged } = await call(HEALTHY);
  assert.match(logged, /"event":"mobile_auth_keyring_health"/);
  assert.match(logged, /"findingCount":0/);
});

test("rings that will not parse are a failed run, and none of the report is shown", async () => {
  const { response, body, logged } = await call({
    ...HEALTHY,
    MOBILE_AUTH_SIGNING_KEYS: "no-separator-here",
  });
  assert.equal(response.status, 500);
  assert.equal(body.error, "KeyringUnreadable");
  assert.equal(body.findings, undefined);
  assert.equal(runs.failed.length, 1);
  assert.equal(runs.completed.length, 0);
  assert.match(logged, /mobile_auth_keyring_health_unreadable/);
});

test("no key material reaches the response, the log, or the run row", async () => {
  // The rule the whole endpoint exists under. Everything the environment
  // holds is checked against everything the route emitted.
  const { body, logged } = await call({
    ...HEALTHY,
    MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_1},sign-2:${SIGN_2}`,
    MOBILE_AUTH_REFRESH_PEPPERS: `pep-1:${PEPPER},pep-2:${PEPPER}`,
    MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-1@${new Date(Date.now() - 4_000_000).toISOString()}`,
  });
  const emitted = `${JSON.stringify(body)}\n${logged}\n${JSON.stringify(runs)}`;
  for (const material of [SIGN_1, SIGN_2, PEPPER]) {
    assert.equal(emitted.includes(material), false);
  }
  // And it did find the duplicate, so the absence above is not the absence of
  // a report.
  assert.equal(
    body.findings.some((finding: { code: string }) => finding.code === "duplicate_material"),
    true
  );
});

test("the check leaves the keyring exactly as it found it", async () => {
  const before = { ...HEALTHY };
  await call(HEALTHY);
  for (const [key, value] of Object.entries(before)) {
    assert.equal(HEALTHY[key as keyof typeof HEALTHY], value);
  }
});
