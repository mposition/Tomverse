import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * Contract for the Phase 3 sync endpoints
 * (app/api/internal/feedback-autofix/*).
 *
 * What must hold:
 *   - every endpoint is Bearer-authenticated against a ≥32-char dedicated
 *     secret with a digest comparison; a short or missing secret means the
 *     whole protocol is down, not open;
 *   - everything is dark unless FEEDBACK_AUTOFIX_ENABLED is "true";
 *   - a claim is compare-and-swap and a replayed result callback becomes a
 *     refused no-op instead of a state jump;
 *   - a reported PR is recorded only as GitHub describes it -- this
 *     repository, base develop, the case's own branch, open -- with GitHub's
 *     head and change manifest, and its review request mail commits with it;
 *   - nothing after pr_open can be reported: merged and staging outcomes no
 *     longer exist, and a late fix_failed cannot undo an open PR.
 */

import {
  createFakeGitHub,
  fakeGitHubFetch,
  type FakeGitHub,
} from "../support/fakeGitHubApi";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";

const SECRET = "a-feedback-autofix-sync-secret-32ch!";

type CaseRow = Record<string, unknown> & { id: string; state: string };

type World = {
  cases: CaseRow[];
  deliveries: Array<{ kind: string; referenceId: string }>;
  github: FakeGitHub;
};
const freshWorld = (): World => ({
  cases: [],
  deliveries: [],
  github: createFakeGitHub(),
});
let world = freshWorld();
let mocksInstalled = false;

const matches = (row: CaseRow, where: Record<string, unknown>) => {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (typeof where.state === "string" && row.state !== where.state) {
    return false;
  }
  if (
    where.state &&
    typeof where.state === "object" &&
    "in" in (where.state as Record<string, unknown>)
  ) {
    if (!(where.state as { in: string[] }).in.includes(row.state)) return false;
  }
  if (where.classification !== undefined) {
    if (row.classification !== where.classification) return false;
  }
  if (where.fixAttemptId !== undefined) {
    if (row.fixAttemptId !== where.fixAttemptId) return false;
  }
  return true;
};

async function loadRoutes() {
  if (!mocksInstalled) {
    mocksInstalled = true;
    const fakePrisma: Record<string, unknown> = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakePrisma),
      notificationDelivery: {
        upsert: async ({ create }: { create: { kind: string; referenceId: string } }) => {
          world.deliveries.push(create);
          return { id: "delivery-" + world.deliveries.length };
        },
      },
      feedbackAutoFixCase: {
        count: async () => 0,
        findMany: async ({
          where,
          take,
        }: {
          where: Record<string, unknown>;
          take: number;
        }) => world.cases.filter((row) => matches(row, where)).slice(0, take),
        findUnique: async ({ where }: { where: { id: string } }) =>
          world.cases.find((row) => row.id === where.id) ?? null,
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
    mock.module(mod("lib/prisma.ts"), {
      namedExports: { prisma: fakePrisma },
    });
  }
  const [pending, claim, result, heartbeat] = await Promise.all([
    import(`${mod("app/api/internal/feedback-autofix/pending/route.ts")}?spy=1`),
    import(`${mod("app/api/internal/feedback-autofix/claim/route.ts")}?spy=1`),
    import(`${mod("app/api/internal/feedback-autofix/result/route.ts")}?spy=1`),
    import(
      `${mod("app/api/internal/feedback-autofix/heartbeat/route.ts")}?spy=1`
    ),
  ]);
  return {
    pending: pending.POST as (request: Request) => Promise<Response>,
    claim: claim.POST as (request: Request) => Promise<Response>,
    result: result.POST as (request: Request) => Promise<Response>,
    heartbeat: heartbeat.POST as (request: Request) => Promise<Response>,
  };
}

const post = (path: string, body: unknown, secret?: string) =>
  new Request(`http://127.0.0.1:3100/api/internal/feedback-autofix/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(body),
  });

const withEnv = async <T>(
  env: Record<string, string | undefined>,
  run: () => Promise<T>
): Promise<T> => {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const ENABLED_ENV = {
  FEEDBACK_AUTOFIX_SYNC_SECRET: SECRET,
  FEEDBACK_AUTOFIX_ENABLED: "true",
};

const candidateCase = (id: string): CaseRow => ({
  id,
  state: "awaiting_human_review",
  classification: "application_candidate",
  diagnosticSummary: { errorCode: "AI_PROVIDER_ERROR" },
  sourceRelease: "sha",
  mergeSha: null,
  fixAttemptId: null,
});

/** The attempt id a claim would have minted for a seeded in-flight case. */
const ATTEMPT = "11111111-2222-4333-8444-555555555555";
const inFlight = (id: string, state: string): CaseRow => ({
  ...candidateCase(id),
  state,
  fixAttemptId: ATTEMPT,
});

const realFetch = globalThis.fetch;
test.beforeEach(() => {
  world = freshWorld();
  globalThis.fetch = fakeGitHubFetch(world.github);
});
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

const DEVELOP_SHA = "d".repeat(40);
const HEAD_SHA = "e".repeat(40);
const READ_ENV = {
  ...ENABLED_ENV,
  FEEDBACK_AUTOFIX_GITHUB_READ_TOKEN: "github-read-token",
};

/** A develop PR for `caseId` as GitHub would describe it. */
const openDevelopPr = (
  caseId: string,
  overrides: Partial<FakeGitHub["pulls"][number]> = {}
) => {
  world.github.pulls.push({
    number: 999,
    state: "open",
    merged: false,
    mergeCommitSha: null,
    baseRef: "develop",
    baseSha: DEVELOP_SHA,
    headRef: `feedback-autofix/${caseId}`,
    headSha: HEAD_SHA,
    files: ["lib/webSearchStreamTrailer.ts", "tests/x.test.ts"],
    ...overrides,
  });
  world.github.blobs[DEVELOP_SHA] = { "lib/webSearchStreamTrailer.ts": "1".repeat(40) };
  world.github.blobs[HEAD_SHA] = {
    "lib/webSearchStreamTrailer.ts": "2".repeat(40),
    "tests/x.test.ts": "3".repeat(40),
  };
};

const FIX_REPORT = {
  rootCause: "The trailer parser dropped the final chunk when the stream ended early.",
  fixSummary: "Flush the buffered chunk before closing the trailer.",
  testSummary: "Adds a stream that ends mid-chunk.",
};

test("no secret configured means 401 for everyone, even with a guess", async () => {
  await withEnv(
    { FEEDBACK_AUTOFIX_SYNC_SECRET: undefined, FEEDBACK_AUTOFIX_ENABLED: "true" },
    async () => {
      const { pending } = await loadRoutes();
      assert.equal((await pending(post("pending", { limit: 1 }, SECRET))).status, 401);
    }
  );
  await withEnv(
    { FEEDBACK_AUTOFIX_SYNC_SECRET: "short", FEEDBACK_AUTOFIX_ENABLED: "true" },
    async () => {
      const { pending } = await loadRoutes();
      assert.equal(
        (await pending(post("pending", { limit: 1 }, "short"))).status,
        401,
        "a sub-32-char secret disables the protocol rather than weakening it"
      );
    }
  );
});

test("a wrong bearer is refused; the right one is accepted", async () => {
  await withEnv(ENABLED_ENV, async () => {
    const { pending } = await loadRoutes();
    assert.equal(
      (await pending(post("pending", { limit: 1 }, "wrong-secret-with-32-characters!!"))).status,
      401
    );
    const ok = await pending(post("pending", { limit: 1 }, SECRET));
    assert.equal(ok.status, 200);
  });
});

test("the master flag off answers enabled:false and claims nothing", async () => {
  await withEnv(
    { FEEDBACK_AUTOFIX_SYNC_SECRET: SECRET, FEEDBACK_AUTOFIX_ENABLED: undefined },
    async () => {
      const { pending, claim } = await loadRoutes();
      world.cases.push(candidateCase("case-flag-off"));
      const body = (await (
        await pending(post("pending", { limit: 3 }, SECRET))
      ).json()) as { enabled: boolean; cases: unknown[] };
      assert.equal(body.enabled, false);
      assert.equal(body.cases.length, 0);
      const claimBody = (await (
        await claim(post("claim", { caseId: "case-flag-off" }, SECRET))
      ).json()) as { claimed: boolean };
      assert.equal(claimBody.claimed, false);
      assert.equal(world.cases[0].state, "awaiting_human_review");
    }
  );
});

test("a claim is won exactly once and names the case-id branch", async () => {
  await withEnv(ENABLED_ENV, async () => {
    const { claim } = await loadRoutes();
    world.cases.push(candidateCase("case-claim-1x"));
    const first = (await (
      await claim(post("claim", { caseId: "case-claim-1x" }, SECRET))
    ).json()) as { claimed: boolean; branch?: string };
    assert.equal(first.claimed, true);
    assert.equal(first.branch, "feedback-autofix/case-claim-1x");
    assert.equal(world.cases[0].state, "fix_attempting");
    assert.match(String((first as { attemptId?: string }).attemptId), /^[0-9a-f-]{36}$/);
    assert.equal(world.cases[0].fixAttemptId, (first as { attemptId?: string }).attemptId);
    const second = (await (
      await claim(post("claim", { caseId: "case-claim-1x" }, SECRET))
    ).json()) as { claimed: boolean };
    assert.equal(second.claimed, false, "the replay loses the CAS");
  });
});

test("a proof that violates the change policy is refused server-side", async () => {
  await withEnv(ENABLED_ENV, async () => {
    const { result } = await loadRoutes();
    world.cases.push(inFlight("case-bad-policy", "fix_attempting"));
    const body = (await (
      await result(
        post(
          "result",
          {
            caseId: "case-bad-policy",
            attemptId: ATTEMPT,
            result: {
              outcome: "red_green_proven",
              changedFiles: [
                {
                  path: "prisma/schema.prisma",
                  addedLines: 5,
                  removedLines: 0,
                  changeKind: "modified",
                },
                {
                  path: "tests/x.test.ts",
                  addedLines: 5,
                  removedLines: 0,
                  changeKind: "added",
                },
              ],
              proof: {
                testPath: "tests/x.test.ts",
                baseSha: "a".repeat(40),
                headSha: "b".repeat(40),
                red: { exitCode: 1, assertionFailure: true },
                green: { exitCode: 0 },
              },
            },
          },
          SECRET
        )
      )
    ).json()) as { applied: boolean; reason?: string };
    assert.equal(body.applied, false);
    assert.ok(body.reason?.includes("change policy"));
    assert.equal(world.cases[0].state, "fix_attempting", "no transition");
  });
});

const provenPayload = {
  outcome: "red_green_proven",
  changedFiles: [
    { path: "lib/webSearchStreamTrailer.ts", addedLines: 4, removedLines: 1, changeKind: "modified" },
    { path: "tests/x.test.ts", addedLines: 12, removedLines: 0, changeKind: "added" },
  ],
  proof: {
    testPath: "tests/x.test.ts",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    red: { exitCode: 1, assertionFailure: true },
    green: { exitCode: 0 },
  },
};

const prOpen = { outcome: "pr_open", prNumber: 999, fixReport: FIX_REPORT };

test("the result sequence records the PR as GitHub describes it and refuses replays", async () => {
  await withEnv(READ_ENV, async () => {
    const { result } = await loadRoutes();
    world.cases.push(inFlight("case-sequence00", "fix_attempting"));
    openDevelopPr("case-sequence00");
    const send = async (payload: unknown) =>
      (await (
        await result(
          post("result", { caseId: "case-sequence00", attemptId: ATTEMPT, result: payload }, SECRET)
        )
      ).json()) as { applied: boolean; reason?: string };

    // Out of order: a PR before the proof is refused by the state guard,
    // before anything is read from GitHub.
    assert.equal((await send(prOpen)).applied, false);
    assert.equal(world.github.requests.length, 0);

    assert.equal((await send(provenPayload)).applied, true);
    assert.equal(world.cases[0].state, "red_green_proven");

    const pr = await send(prOpen);
    assert.equal(pr.applied, true, pr.reason);
    const row = world.cases[0];
    assert.equal(row.state, "pr_open");
    assert.equal(row.fixHeadSha, HEAD_SHA);
    assert.equal(row.fixPrUrl, "https://github.com/mposition/Tomverse/pull/999");
    assert.deepEqual(row.fixManifest, [
      { path: "lib/webSearchStreamTrailer.ts", baseBlob: "1".repeat(40), headBlob: "2".repeat(40) },
      { path: "tests/x.test.ts", baseBlob: null, headBlob: "3".repeat(40) },
    ]);
    assert.match(String(row.fixManifestDigest), /^fcm1:[0-9a-f]{64}$/);
    assert.deepEqual(row.fixReport, FIX_REPORT);
    assert.deepEqual(world.deliveries, [
      { kind: "autofix_review_requested", referenceId: "case-sequence00" },
    ]);
    assert.ok(
      world.github.requests.every((request) => request.method === "GET"),
      "the server only reads GitHub"
    );

    // A replay is a refused no-op, and a late failure cannot undo the PR.
    assert.equal((await send(prOpen)).applied, false);
    assert.equal((await send({ outcome: "fix_failed", reason: "late runner" })).applied, false);
    assert.equal(world.cases[0].state, "pr_open");
    assert.equal(world.deliveries.length, 1);
  });
});

test("a PR that is not the case's own open develop PR is never recorded", async () => {
  const variants: Array<[string, Partial<FakeGitHub["pulls"][number]>]> = [
    ["fork head", { headRepository: "someone/Tomverse" }],
    ["wrong base", { baseRef: "main" }],
    ["another case's branch", { headRef: "feedback-autofix/other-case-0000" }],
    ["closed", { state: "closed" }],
  ];
  for (const [label, overrides] of variants) {
    await withEnv(READ_ENV, async () => {
      world = freshWorld();
      globalThis.fetch = fakeGitHubFetch(world.github);
      const { result } = await loadRoutes();
      world.cases.push(inFlight("case-identity0", "red_green_proven"));
      openDevelopPr("case-identity0", overrides);
      const body = (await (
        await result(
          post("result", { caseId: "case-identity0", attemptId: ATTEMPT, result: prOpen }, SECRET)
        )
      ).json()) as { applied: boolean };
      assert.equal(body.applied, false, label);
      assert.equal(world.cases[0].state, "red_green_proven", label);
      assert.equal(world.deliveries.length, 0, label);
    });
  }
});

test("without the GitHub read token a PR is not recorded", async () => {
  await withEnv({ ...READ_ENV, FEEDBACK_AUTOFIX_GITHUB_READ_TOKEN: undefined }, async () => {
    const { result } = await loadRoutes();
    world.cases.push(inFlight("case-no-token0", "red_green_proven"));
    openDevelopPr("case-no-token0");
    const body = (await (
      await result(
        post("result", { caseId: "case-no-token0", attemptId: ATTEMPT, result: prOpen }, SECRET)
      )
    ).json()) as { applied: boolean; reason?: string };
    assert.equal(body.applied, false);
    assert.equal(body.reason, "github_read_unavailable");
  });
});

test("merged and staging outcomes are no longer accepted from a workflow", async () => {
  await withEnv(READ_ENV, async () => {
    const { result } = await loadRoutes();
    world.cases.push({ ...candidateCase("case-legacy000"), state: "pr_open" });
    for (const payload of [
      { outcome: "merged", mergedAt: "2026-08-03T12:00:00Z", mergeSha: "c".repeat(40) },
      { outcome: "staging_verified", stagingSha: "c".repeat(40) },
      { outcome: "pr_open", prNumber: 999, prUrl: "https://github.com/mposition/Tomverse/pull/999" },
    ]) {
      const response = await result(
        post("result", { caseId: "case-legacy000", attemptId: ATTEMPT, result: payload }, SECRET)
      );
      assert.equal(response.status, 400, JSON.stringify(payload));
    }
    assert.equal(world.cases[0].state, "pr_open");
  });
});

test("heartbeat only answers alive for a case under an active fix lease", async () => {
  await withEnv(ENABLED_ENV, async () => {
    const { heartbeat } = await loadRoutes();
    world.cases.push(inFlight("case-heartbeat0", "fix_attempting"));
    const alive = (await (
      await heartbeat(post("heartbeat", { caseId: "case-heartbeat0", attemptId: ATTEMPT }, SECRET))
    ).json()) as { alive: boolean };
    assert.equal(alive.alive, true);
    world.cases[0].state = "fix_failed";
    const dead = (await (
      await heartbeat(post("heartbeat", { caseId: "case-heartbeat0", attemptId: ATTEMPT }, SECRET))
    ).json()) as { alive: boolean };
    assert.equal(dead.alive, false);
  });
});

test("a run whose lease was reclaimed cannot move the next run's case", async () => {
  await withEnv(READ_ENV, async () => {
    const { claim, result, heartbeat } = await loadRoutes();
    world.cases.push(candidateCase("case-stale-run0"));
    const claimOnce = async () =>
      (await (
        await claim(post("claim", { caseId: "case-stale-run0" }, SECRET))
      ).json()) as { claimed: boolean; attemptId: string };

    // Run A claims, then its lease expires and the case returns to the pool.
    const runA = await claimOnce();
    assert.equal(runA.claimed, true);
    // The in-memory prisma cannot evaluate `lt`, so the reclaim's write is
    // applied as reclaimExpiredFixLeases() performs it (asserted below).
    Object.assign(world.cases[0], {
      state: "awaiting_human_review",
      leaseExpiresAt: null,
      claimedAt: null,
      fixAttemptId: null,
    });
    const source = (await import("node:fs")).readFileSync(
      resolve(ROOT, "lib/feedbackAutoFixSync.ts"),
      "utf8"
    );
    const reclaim = source.slice(source.indexOf("export const reclaimExpiredFixLeases"));
    assert.match(reclaim, /fixAttemptId: null/, "the reclaim voids the expired run's id");

    // Run B claims the same case.
    const runB = await claimOnce();
    assert.equal(runB.claimed, true);
    assert.notEqual(runB.attemptId, runA.attemptId);

    const send = async (attemptId: string, payload: unknown) =>
      (await (
        await result(post("result", { caseId: "case-stale-run0", attemptId, result: payload }, SECRET))
      ).json()) as { applied: boolean };

    // A's late callbacks match nothing.
    assert.equal((await send(runA.attemptId, provenPayload)).applied, false);
    assert.equal((await send(runA.attemptId, { outcome: "fix_failed", reason: "late" })).applied, false);
    const staleBeat = (await (
      await heartbeat(post("heartbeat", { caseId: "case-stale-run0", attemptId: runA.attemptId }, SECRET))
    ).json()) as { alive: boolean };
    assert.equal(staleBeat.alive, false);
    assert.equal(world.cases[0].state, "fix_attempting");

    // B's own callback applies.
    assert.equal((await send(runB.attemptId, provenPayload)).applied, true);
    assert.equal(world.cases[0].state, "red_green_proven");
  });
});
