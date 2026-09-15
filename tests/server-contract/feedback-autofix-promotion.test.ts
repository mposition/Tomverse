import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  createFakeGitHub,
  fakeGitHubFetch,
  type FakeGitHub,
  type FakePullRequest,
} from "../support/fakeGitHubApi";

/**
 * Contract for owner-approved promotion (lib/feedbackAutoFixPromotion.ts,
 * docs/policy/trace-feedback-automation.md §9.3).
 *
 * What must hold:
 *   - approval binds the head the owner saw and the manifest recorded at
 *     review; a head or manifest that moved since is refused;
 *   - the observer only ever reads GitHub, and a case moves only on what it
 *     read: a develop merge at exactly the approved head, a main promotion PR
 *     whose manifest is exactly the approved change, deployments judged by the
 *     control-plane-plus-samples rule across a window;
 *   - a head pushed after approval, a merge at another head, or a promotion PR
 *     carrying a different change stops the promotion and mails the operator;
 *   - two promotion PRs, or one from a fork, never advance anything;
 *   - the workflow's prepare call changes nothing.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";

const CASE = "case-promotion01";
const DEVELOP_BASE = "d".repeat(40);
const APPROVED_HEAD = "e".repeat(40);
const PUSHED_HEAD = "f".repeat(40);
const DEVELOP_MERGE = "c".repeat(40);
const MAIN_BASE = "a".repeat(40);
const PROMOTION_HEAD = "b".repeat(40);
const MAIN_MERGE = "9".repeat(40);
const BLOB = { libBefore: "1".repeat(40), libAfter: "2".repeat(40), test: "3".repeat(40) };

type Row = Record<string, unknown> & { id: string; state: string };
type World = {
  cases: Row[];
  deliveries: Array<{ kind: string; referenceId: string }>;
  github: FakeGitHub;
};
let world: World;
let mocksInstalled = false;

const matches = (row: Row, where: Record<string, unknown>) =>
  Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === "object" && "in" in expected) {
      return (expected as { in: unknown[] }).in.includes(row[key]);
    }
    return row[key] === expected;
  });

async function load() {
  if (!mocksInstalled) {
    mocksInstalled = true;
    const fakePrisma: Record<string, unknown> = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakePrisma),
      notificationDelivery: {
        upsert: async ({ create }: { create: { kind: string; referenceId: string } }) => {
          world.deliveries.push(create);
          return { id: `delivery-${world.deliveries.length}` };
        },
      },
      feedbackAutoFixCase: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          world.cases.find((row) => row.id === where.id) ?? null,
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          world.cases.filter((row) => matches(row, where)),
        updateMany: async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const rows = world.cases.filter((row) => matches(row, where));
          for (const row of rows) Object.assign(row, data);
          return { count: rows.length };
        },
      },
    };
    mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: fakePrisma } });
  }
  return import(`${mod("lib/feedbackAutoFixPromotion.ts")}?contract=1`) as Promise<
    typeof import("../../lib/feedbackAutoFixPromotion")
  >;
}

const ENV: Record<string, string> = {
  FEEDBACK_AUTOFIX_ENABLED: "true",
  FEEDBACK_AUTOFIX_GITHUB_READ_TOKEN: "github-read-token",
  RAILWAY_API_TOKEN: "railway-token",
  RAILWAY_PROJECT_ID: "project",
  FEEDBACK_AUTOFIX_RAILWAY_SERVICE_ID: "service",
  FEEDBACK_AUTOFIX_STAGING_RAILWAY_ENVIRONMENT_ID: "staging-env",
  FEEDBACK_AUTOFIX_PRODUCTION_RAILWAY_ENVIRONMENT_ID: "production-env",
};

const realFetch = globalThis.fetch;
const previousEnv = new Map<string, string | undefined>();

test.beforeEach(() => {
  world = { cases: [], deliveries: [], github: createFakeGitHub() };
  globalThis.fetch = fakeGitHubFetch(world.github);
  for (const [key, value] of Object.entries(ENV)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
});
test.afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const approvedManifest = [
  { path: "lib/fix.ts", baseBlob: BLOB.libBefore, headBlob: BLOB.libAfter },
  { path: "tests/fix.test.ts", baseBlob: null, headBlob: BLOB.test },
];

const developPr = (overrides: Partial<FakePullRequest> = {}): FakePullRequest => ({
  number: 700,
  state: "open",
  merged: false,
  mergeCommitSha: null,
  baseRef: "develop",
  baseSha: DEVELOP_BASE,
  headRef: `feedback-autofix/${CASE}`,
  headSha: APPROVED_HEAD,
  files: ["lib/fix.ts", "tests/fix.test.ts"],
  ...overrides,
});

const promotionPr = (overrides: Partial<FakePullRequest> = {}): FakePullRequest => ({
  number: 800,
  state: "open",
  merged: false,
  mergeCommitSha: null,
  baseRef: "main",
  baseSha: MAIN_BASE,
  headRef: `feedback-autofix-main/${CASE}`,
  headSha: PROMOTION_HEAD,
  files: ["lib/fix.ts", "tests/fix.test.ts"],
  ...overrides,
});

const seedBlobs = () => {
  world.github.blobs[DEVELOP_BASE] = { "lib/fix.ts": BLOB.libBefore };
  world.github.blobs[APPROVED_HEAD] = { "lib/fix.ts": BLOB.libAfter, "tests/fix.test.ts": BLOB.test };
  world.github.blobs[MAIN_BASE] = { "lib/fix.ts": BLOB.libBefore };
  world.github.blobs[PROMOTION_HEAD] = { "lib/fix.ts": BLOB.libAfter, "tests/fix.test.ts": BLOB.test };
};

const digestOf = async () => {
  const manifest = await import("../../lib/feedbackAutoFixChangeManifest");
  return manifest.changeManifestDigest(approvedManifest)!;
};

const seedCase = async (state: string, extra: Record<string, unknown> = {}) => {
  const digest = await digestOf();
  world.cases.push({
    id: CASE,
    feedbackId: "feedback-1",
    state,
    fixPrNumber: 700,
    fixHeadSha: APPROVED_HEAD,
    fixManifest: approvedManifest,
    fixManifestDigest: digest,
    approvedHeadSha: state === "pr_open" ? null : APPROVED_HEAD,
    approvedManifestDigest: state === "pr_open" ? null : digest,
    mergeSha: null,
    stagingDeploymentId: null,
    stagingFirstSeenAt: null,
    productionPrNumber: null,
    productionMergeSha: null,
    productionDeploymentId: null,
    productionFirstSeenAt: null,
    ...extra,
  });
  seedBlobs();
};

const healthyPass = (sha: string, deploymentId: string, production: boolean) => ({
  controlPlane: [
    { id: deploymentId, status: "SUCCESS", commitSha: sha },
    { id: "older", status: "REMOVED", commitSha: "0".repeat(40) },
  ],
  buildInfo: Array.from({ length: 5 }, () => ({
    commitSha: sha,
    deploymentId,
    deploymentStatus: "success",
  })),
  ready: production ? Array.from({ length: 5 }, () => true) : [],
});

const clock = (start = Date.parse("2026-09-15T12:00:00Z")) => {
  let now = start;
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
};

// --- approval ----------------------------------------------------------------

test("approval binds the head the owner saw and the recorded manifest", async () => {
  const promotion = await load();
  await seedCase("pr_open");
  world.github.pulls.push(developPr());
  const outcome = await promotion.approveAutoFixCase({
    caseId: CASE,
    headSha: APPROVED_HEAD.toUpperCase(),
  });
  assert.equal(outcome.approved, true);
  const row = world.cases[0];
  assert.equal(row.state, "approved");
  assert.equal(row.approvedHeadSha, APPROVED_HEAD);
  assert.equal(row.approvedManifestDigest, await digestOf());
  // The approver lives in the audit log; the case keeps no account id.
  assert.equal("approvedByUserId" in row, false);
  assert.equal(row.productionBranch, `feedback-autofix-main/${CASE}`);
  assert.ok(world.github.requests.every((request) => request.method === "GET"));
});

test("approval is refused when the head or the manifest moved", async () => {
  const promotion = await load();

  // The console showed a head that is no longer the recorded one.
  await seedCase("pr_open");
  world.github.pulls.push(developPr());
  assert.deepEqual(
    await promotion.approveAutoFixCase({ caseId: CASE, headSha: PUSHED_HEAD }),
    { approved: false, code: "head_changed" }
  );

  // Someone pushed to the PR after the review request.
  world.cases = [];
  world.github.pulls = [developPr({ headSha: PUSHED_HEAD })];
  await seedCase("pr_open");
  world.github.blobs[PUSHED_HEAD] = { "lib/fix.ts": "7".repeat(40), "tests/fix.test.ts": BLOB.test };
  assert.deepEqual(
    await promotion.approveAutoFixCase({ caseId: CASE, headSha: APPROVED_HEAD }),
    { approved: false, code: "head_changed" }
  );
  assert.equal(world.cases[0].state, "pr_open");

  // Same head, but the stored manifest no longer matches what GitHub reports.
  world.cases = [];
  world.github.pulls = [developPr()];
  await seedCase("pr_open", { fixManifestDigest: "fcm1:stale" });
  assert.deepEqual(
    await promotion.approveAutoFixCase({ caseId: CASE, headSha: APPROVED_HEAD }),
    { approved: false, code: "manifest_changed" }
  );
  assert.equal(world.cases[0].state, "pr_open");
});

test("approval needs the open PR state and full configuration", async () => {
  const promotion = await load();
  await seedCase("red_green_proven");
  world.github.pulls.push(developPr());
  assert.deepEqual(
    await promotion.approveAutoFixCase({ caseId: CASE, headSha: APPROVED_HEAD }),
    { approved: false, code: "wrong_state" }
  );
  world.cases[0].state = "pr_open";
  delete process.env.FEEDBACK_AUTOFIX_STAGING_RAILWAY_ENVIRONMENT_ID;
  assert.deepEqual(
    await promotion.approveAutoFixCase({ caseId: CASE, headSha: APPROVED_HEAD }),
    { approved: false, code: "not_configured" }
  );
  assert.equal(world.cases[0].state, "pr_open");
});

// --- observer: the whole way to production ---------------------------------

test("the observer carries an approved fix to production only on what it reads", async () => {
  const promotion = await load();
  await seedCase("approved");
  const time = clock();
  let staging = healthyPass(DEVELOP_MERGE, "stg-1", false);
  let production = healthyPass(MAIN_MERGE, "prd-1", true);
  const deps = {
    now: time.now,
    observe: async (environment: "staging" | "production") =>
      environment === "production" ? production : staging,
  };
  const pass = async () => promotion.runPromotionObserver(deps);

  // Develop PR not merged yet: nothing moves.
  world.github.pulls.push(developPr());
  await pass();
  assert.equal(world.cases[0].state, "approved");
  assert.match(String(world.cases[0].promotionObservation), /waiting for the develop PR/);

  // A person merges it in GitHub at the approved head.
  world.github.pulls[0] = developPr({ state: "closed", merged: true, mergeCommitSha: DEVELOP_MERGE });
  await pass();
  assert.equal(world.cases[0].state, "merged");
  assert.equal(world.cases[0].mergeSha, DEVELOP_MERGE);

  // Staging: one good pass opens the window, a rolling pass resets it, and a
  // good pass after the window verifies.
  await pass();
  assert.equal(world.cases[0].state, "merged");
  assert.equal(world.cases[0].stagingDeploymentId, "stg-1");
  time.advance(11 * 60_000);
  staging = { ...staging, controlPlane: [...staging.controlPlane, { id: "stg-0", status: "REMOVING", commitSha: "0".repeat(40) }] };
  await pass();
  assert.equal(world.cases[0].state, "merged", "a draining old deployment never verifies");
  assert.equal(world.cases[0].stagingDeploymentId, null);
  staging = healthyPass(DEVELOP_MERGE, "stg-1", false);
  await pass();
  time.advance(11 * 60_000);
  await pass();
  assert.equal(world.cases[0].state, "staging_verified");

  // No promotion PR yet; then one appears, open, carrying the approved change.
  await pass();
  assert.equal(world.cases[0].state, "staging_verified");
  assert.match(String(world.cases[0].promotionObservation), /waiting for the main promotion PR/);
  world.github.pulls.push(promotionPr());
  await pass();
  assert.equal(world.cases[0].state, "staging_verified");
  assert.equal(world.cases[0].productionPrNumber, 800);
  assert.match(String(world.cases[0].promotionObservation), /merge it in GitHub/);

  // A person merges the main PR.
  world.github.pulls[1] = promotionPr({ state: "closed", merged: true, mergeCommitSha: MAIN_MERGE });
  await pass();
  assert.equal(world.cases[0].state, "production_merged");
  assert.equal(world.cases[0].productionMergeSha, MAIN_MERGE);

  // Production must also be ready in every sample.
  await pass();
  time.advance(11 * 60_000);
  production = { ...production, ready: [true, true, false, true, true] };
  await pass();
  assert.equal(world.cases[0].state, "production_merged");
  production = healthyPass(MAIN_MERGE, "prd-1", true);
  await pass();
  time.advance(11 * 60_000);
  await pass();
  assert.equal(world.cases[0].state, "production_verified");
  assert.deepEqual(world.deliveries, [
    { kind: "autofix_production_verified", referenceId: CASE },
  ]);
  assert.ok(world.github.requests.every((request) => request.method === "GET"));
});

// --- observer: stops ---------------------------------------------------------

test("a head pushed after approval, or a merge at another head, stops promotion", async () => {
  const promotion = await load();
  const deps = { now: () => new Date(), observe: async () => healthyPass(DEVELOP_MERGE, "x", false) };

  await seedCase("approved");
  world.github.pulls.push(developPr({ headSha: PUSHED_HEAD }));
  await promotion.runPromotionObserver(deps);
  assert.equal(world.cases[0].state, "promotion_failed");
  assert.match(String(world.cases[0].terminalReason), /head changed after approval/);
  assert.deepEqual(world.deliveries, [{ kind: "autofix_promotion_failed", referenceId: CASE }]);

  world.cases = [];
  world.deliveries = [];
  world.github.pulls = [
    developPr({ headSha: PUSHED_HEAD, state: "closed", merged: true, mergeCommitSha: DEVELOP_MERGE }),
  ];
  await seedCase("approved");
  await promotion.runPromotionObserver(deps);
  assert.equal(world.cases[0].state, "promotion_failed");
  assert.match(String(world.cases[0].terminalReason), /head that was not approved/);
});

test("a promotion PR carrying anything but the approved change stops promotion", async () => {
  const promotion = await load();
  const deps = { now: () => new Date(), observe: async () => healthyPass(MAIN_MERGE, "x", true) };

  // main drifted: the file on main is not the approved base any more.
  await seedCase("staging_verified", { mergeSha: DEVELOP_MERGE });
  world.github.pulls.push(promotionPr());
  world.github.blobs[MAIN_BASE] = { "lib/fix.ts": "8".repeat(40) };
  await promotion.runPromotionObserver(deps);
  assert.equal(world.cases[0].state, "promotion_failed");
  assert.match(String(world.cases[0].terminalReason), /contents differ/);

  // An extra file in the promotion PR.
  world.cases = [];
  world.deliveries = [];
  world.github.pulls = [promotionPr({ files: ["lib/fix.ts", "tests/fix.test.ts", "lib/extra.ts"] })];
  await seedCase("staging_verified", { mergeSha: DEVELOP_MERGE });
  world.github.blobs[PROMOTION_HEAD]["lib/extra.ts"] = "6".repeat(40);
  await promotion.runPromotionObserver(deps);
  assert.equal(world.cases[0].state, "promotion_failed");
  assert.match(String(world.cases[0].terminalReason), /set of changed files/);
});

test("two promotion PRs, or one from a fork, advance nothing", async () => {
  const promotion = await load();
  const deps = { now: () => new Date(), observe: async () => healthyPass(MAIN_MERGE, "x", true) };

  await seedCase("staging_verified", { mergeSha: DEVELOP_MERGE });
  world.github.pulls.push(promotionPr(), promotionPr({ number: 801 }));
  await promotion.runPromotionObserver(deps);
  assert.equal(world.cases[0].state, "staging_verified");
  assert.match(String(world.cases[0].promotionObservation), /more than one/);

  world.cases = [];
  world.github.pulls = [
    promotionPr({ headRepository: "mposition/Tomverse-fork", state: "closed", merged: true, mergeCommitSha: MAIN_MERGE }),
  ];
  await seedCase("staging_verified", { mergeSha: DEVELOP_MERGE });
  await promotion.runPromotionObserver(deps);
  assert.equal(world.cases[0].state, "staging_verified");
  assert.equal(world.deliveries.length, 0);
});

test("the observer does nothing without its configuration", async () => {
  const promotion = await load();
  await seedCase("approved");
  world.github.pulls.push(developPr({ state: "closed", merged: true, mergeCommitSha: DEVELOP_MERGE }));
  delete process.env.FEEDBACK_AUTOFIX_GITHUB_READ_TOKEN;
  const summary = await promotion.runPromotionObserver({
    now: () => new Date(),
    observe: async () => healthyPass(DEVELOP_MERGE, "x", false),
  });
  assert.equal(summary.enabled, false);
  assert.equal(world.cases[0].state, "approved");
  assert.equal(world.github.requests.length, 0);
});

// --- prepare ------------------------------------------------------------------

test("prepare answers the workflow without changing the case", async () => {
  const promotion = await load();
  await seedCase("approved");
  world.github.pulls.push(developPr({ state: "closed", merged: true, mergeCommitSha: DEVELOP_MERGE }));
  const before = JSON.stringify(world.cases);

  const ready = await promotion.preparePromotion({ caseId: CASE, prNumber: 700 });
  assert.equal(ready.eligible, true);
  assert.equal(ready.eligible && ready.mergeSha, DEVELOP_MERGE);
  assert.deepEqual(ready.eligible && ready.manifest, approvedManifest);
  assert.equal(JSON.stringify(world.cases), before, "prepare wrote nothing");

  assert.deepEqual(await promotion.preparePromotion({ caseId: CASE, prNumber: 701 }), {
    eligible: false,
    reason: "pull request is not the case's",
  });

  world.github.pulls[0] = developPr({ headSha: PUSHED_HEAD, state: "closed", merged: true, mergeCommitSha: DEVELOP_MERGE });
  assert.equal((await promotion.preparePromotion({ caseId: CASE, prNumber: 700 })).eligible, false);

  world.cases[0].state = "pr_open";
  assert.deepEqual(await promotion.preparePromotion({ caseId: CASE, prNumber: 700 }), {
    eligible: false,
    reason: "not_approved",
  });
  assert.equal(world.deliveries.length, 0);
});

// --- observer: a moving branch ------------------------------------------------

test("a later staging deployment that contains the merge verifies; one that does not never does", async () => {
  const promotion = await load();
  const LATER = "7".repeat(40);
  const time = clock();
  const deps = {
    now: time.now,
    observe: async () => healthyPass(LATER, "stg-later", false),
  };

  // develop moved on after the merge: the live deployment is a descendant.
  await seedCase("merged", { mergeSha: DEVELOP_MERGE });
  await promotion.runPromotionObserver(deps);
  time.advance(11 * 60_000);
  await promotion.runPromotionObserver(deps);
  assert.equal(world.cases[0].state, "staging_verified");
  assert.ok(
    world.github.requests.some((request) =>
      request.url.includes(`/compare/${DEVELOP_MERGE}...${LATER}`)
    ),
    "containment is read from GitHub"
  );

  // A live commit that does not contain the merge (another line of history).
  world.cases = [];
  world.github.mergeBases[`${DEVELOP_MERGE}...${LATER}`] = "5".repeat(40);
  await seedCase("merged", { mergeSha: DEVELOP_MERGE });
  await promotion.runPromotionObserver(deps);
  time.advance(11 * 60_000);
  await promotion.runPromotionObserver(deps);
  assert.equal(world.cases[0].state, "merged");
  assert.match(String(world.cases[0].promotionObservation), /expected_commit_not_deployed/);
});
