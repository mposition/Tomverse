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
 *   - "merged" is only accepted with a GitHub read-back shape, and staging
 *     verification only with the exact merge SHA.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";

const SECRET = "a-feedback-autofix-sync-secret-32ch!";

type CaseRow = Record<string, unknown> & { id: string; state: string };

type World = { cases: CaseRow[] };
const freshWorld = (): World => ({ cases: [] });
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
  return true;
};

async function loadRoutes() {
  if (!mocksInstalled) {
    mocksInstalled = true;
    const fakePrisma = {
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
});

test.beforeEach(() => {
  world = freshWorld();
});

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
    const second = (await (
      await claim(post("claim", { caseId: "case-claim-1x" }, SECRET))
    ).json()) as { claimed: boolean };
    assert.equal(second.claimed, false, "the replay loses the CAS");
  });
});

test("a proof that violates the change policy is refused server-side", async () => {
  await withEnv(ENABLED_ENV, async () => {
    const { result } = await loadRoutes();
    world.cases.push({ ...candidateCase("case-bad-policy"), state: "fix_attempting" });
    const body = (await (
      await result(
        post(
          "result",
          {
            caseId: "case-bad-policy",
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

test("the full result sequence transitions in order and refuses replays", async () => {
  await withEnv(ENABLED_ENV, async () => {
    const { result } = await loadRoutes();
    world.cases.push({ ...candidateCase("case-sequence00"), state: "fix_attempting" });
    const send = async (payload: unknown) =>
      (await (
        await result(post("result", { caseId: "case-sequence00", result: payload }, SECRET))
      ).json()) as { applied: boolean; reason?: string };

    const proven = await send({
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
    });
    assert.equal(proven.applied, true);
    assert.equal(world.cases[0].state, "red_green_proven");

    // Out of order: merged before a PR exists is refused by the graph.
    const early = await send({
      outcome: "merged",
      mergedAt: "2026-08-03T12:00:00Z",
      mergeSha: "c".repeat(40),
    });
    assert.equal(early.applied, false);

    const pr = await send({ outcome: "pr_open", prNumber: 999, prUrl: "https://github.com/mposition/Tomverse/pull/999" });
    assert.equal(pr.applied, true);
    assert.equal(world.cases[0].state, "pr_open");

    const merged = await send({
      outcome: "merged",
      mergedAt: "2026-08-03T12:00:00Z",
      mergeSha: "c".repeat(40),
    });
    assert.equal(merged.applied, true);
    assert.equal(world.cases[0].mergeSha, "c".repeat(40));

    // Staging must present the exact merge SHA.
    const wrongStaging = await send({ outcome: "staging_verified", stagingSha: "d".repeat(40) });
    assert.equal(wrongStaging.applied, false);
    const staging = await send({ outcome: "staging_verified", stagingSha: "c".repeat(40) });
    assert.equal(staging.applied, true);
    assert.equal(world.cases[0].state, "staging_verified");

    // A replayed earlier callback is a refused no-op, not a state rewind.
    const replay = await send({ outcome: "pr_open", prNumber: 999, prUrl: "https://github.com/mposition/Tomverse/pull/999" });
    assert.equal(replay.applied, false);
    assert.equal(world.cases[0].state, "staging_verified");
  });
});

test("heartbeat only answers alive for a case under an active fix lease", async () => {
  await withEnv(ENABLED_ENV, async () => {
    const { heartbeat } = await loadRoutes();
    world.cases.push({ ...candidateCase("case-heartbeat0"), state: "fix_attempting" });
    const alive = (await (
      await heartbeat(post("heartbeat", { caseId: "case-heartbeat0" }, SECRET))
    ).json()) as { alive: boolean };
    assert.equal(alive.alive, true);
    world.cases[0].state = "fix_failed";
    const dead = (await (
      await heartbeat(post("heartbeat", { caseId: "case-heartbeat0" }, SECRET))
    ).json()) as { alive: boolean };
    assert.equal(dead.alive, false);
  });
});
