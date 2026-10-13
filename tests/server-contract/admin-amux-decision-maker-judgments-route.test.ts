import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// AMUX Decision Maker policy version 1, sections 2-6, 6 and 12 S2: the
// judgment route. A judgment needs `ops:write` and a recent step-up, both
// checked before the body is read, and a stale step-up is 428 with the
// reauthentication code a panel turns into the way back. The store's refusal
// is 409 with its reason; an unknown outcome says so. Only an edited answer
// reads the digest key ring, before the database. The store and the DB
// boundary are faked; the boundary around the real store is the agents lane's
// (tests/integration/amux-decision-maker-judgment.db.test.ts).

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;
const require = createRequire(import.meta.url);

class FakeBoundaryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

class FakeWriteError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

class FakeKeyError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

type Judgment = { requestId: unknown; kind: unknown; shown: unknown; accuracy: unknown; operatorAnswer: unknown; keyRing: unknown };
type World = {
  session: { user: { id: string; authenticatedAt?: string } } | null;
  admin: boolean;
  opsWrite: boolean;
  boundaries: string[];
  judgments: Judgment[];
  keyRingReads: number;
  keyRingError: Error | null;
  boundaryError: Error | null;
  storeError: Error | null;
  storeAnswer: unknown;
  budgetDepth: number;
  sessionReadsInBudget: boolean[];
};
let world: World;
const RECORDED = {
  recorded: true,
  judgment: {
    judgmentId: "00000000-0000-4000-8000-0000000000aa",
    requestId: "00000000-0000-4000-8000-000000000011",
    kind: "confirm",
    instance: "decision-maker-openai",
    auditLogId: "audit-1",
    accuracy: { accuracy: "not_judged", mismatchedItems: [] },
    operatorAnswerDigest: null,
    createdAt: "2026-10-13T00:00:00.000Z",
  },
};
const RING = new Map([[700, Buffer.alloc(32, 7)]]);
const reset = (changes: Partial<World> = {}) => {
  world = {
    session: { user: { id: "operator-1", authenticatedAt: new Date().toISOString() } },
    admin: true,
    opsWrite: true,
    boundaries: [],
    judgments: [],
    keyRingReads: 0,
    keyRingError: null,
    boundaryError: null,
    storeError: null,
    storeAnswer: RECORDED,
    budgetDepth: 0,
    sessionReadsInBudget: [],
    ...changes,
  };
};
reset();

type Route = { POST: (request: Request) => Promise<Response> };

let installed = false;
async function loadRoute(): Promise<Route> {
  if (!installed) {
    installed = true;
    mock.module("next-auth/next", {
      namedExports: {
        getServerSession: async () => {
          world.sessionReadsInBudget.push(world.budgetDepth === 1);
          return world.session;
        },
      },
    });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/adminAuth.ts"), {
      namedExports: {
        isAdminSession: () => world.admin,
        hasAdminPermission: (_session: unknown, permission: string) => permission === "ops:write" && world.opsWrite,
      },
    });
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts"));
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => {} },
    });
    mock.module(mod("lib/amux/dbBoundary.ts"), {
      namedExports: {
        AMUX_DB_BOUNDARIES: { decisionMakerJudgment: { operation: "decision_maker_judgment" } },
        AmuxDbBoundaryError: FakeBoundaryError,
        withAmuxRouteBudget: async (work: () => Promise<unknown>) => {
          world.budgetDepth += 1;
          try {
            return await work();
          } finally {
            world.budgetDepth -= 1;
          }
        },
        withAmuxDbBoundary: async (boundary: { operation: string }, work: (tx: unknown) => Promise<unknown>) => {
          assert.equal(world.budgetDepth, 1, "a boundary runs only inside the route budget");
          world.boundaries.push(boundary.operation);
          if (world.boundaryError) throw world.boundaryError;
          return work({ fake: "tx" });
        },
      },
    });
    mock.module(mod("lib/amux/decisionMakerDigestKeys.ts"), {
      namedExports: {
        DecisionMakerDigestKeyError: FakeKeyError,
        loadDecisionMakerDigestKeyRing: () => {
          world.keyRingReads += 1;
          if (world.keyRingError) throw world.keyRingError;
          return RING;
        },
      },
    });
    mock.module(mod("lib/amux/decisionMakerJudgmentStore.ts"), {
      namedExports: {
        DecisionMakerJudgmentWriteError: FakeWriteError,
        recordDecisionMakerJudgment: async (tx: unknown, input: Judgment & { session: unknown; request: unknown }) => {
          assert.deepEqual(tx, { fake: "tx" });
          assert.ok(input.session, "the session is the store's to check");
          assert.ok(input.request instanceof Request, "the request goes to the person's audit");
          world.judgments.push({
            requestId: input.requestId,
            kind: input.kind,
            shown: input.shown,
            accuracy: input.accuracy,
            operatorAnswer: input.operatorAnswer,
            keyRing: input.keyRing,
          });
          if (world.storeError) throw world.storeError;
          return world.storeAnswer;
        },
      },
    });
  }
  return import(mod("app/api/admin/amux/decision-maker/judgments/route.ts"));
}

const URL_ = "https://tomverse.app/api/admin/amux/decision-maker/judgments";
const post = (body: unknown) =>
  new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const stale = () => ({
  session: { user: { id: "operator-1", authenticatedAt: new Date(Date.now() - 6 * 60 * 60_000).toISOString() } },
});

const REQUEST_ID = "00000000-0000-4000-8000-000000000011";
const SHOWN = {
  answerDigest: "2".repeat(64),
  rationaleDigest: "3".repeat(64),
  optionId: null,
  irreversible: false,
  snapshotState: "worker_head",
  snapshotTargetSha: "0123456789abcdef0123456789abcdef01234567",
  snapshotManifestDigest: "b".repeat(64),
};
const CONFIRM = { requestId: REQUEST_ID, kind: "confirm", shown: SHOWN, accuracy: { accuracy: "matched" } };

test("only ops:write with a recent step-up reaches a judgment, before the body is read", async () => {
  const { POST } = await loadRoute();

  reset({ session: null });
  assert.equal((await POST(post(CONFIRM))).status, 404);
  reset({ admin: false });
  assert.equal((await POST(post(CONFIRM))).status, 404);
  reset({ opsWrite: false });
  assert.equal((await POST(post(CONFIRM))).status, 403);
  assert.deepEqual(world.judgments, []);

  reset(stale());
  const staleAnswer = await POST(post({ requestId: "x", kind: "approve", extra: 1 }));
  assert.equal(staleAnswer.status, 428);
  assert.equal((await staleAnswer.json()).code, "ADMIN_REAUTHENTICATION_REQUIRED");
  assert.equal(staleAnswer.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(world.boundaries, []);
  assert.deepEqual(world.judgments, []);

  reset();
  const recorded = await POST(post(CONFIRM));
  assert.equal(recorded.status, 200);
  assert.deepEqual(await recorded.json(), {
    recorded: true,
    kind: "confirm",
    judgmentId: RECORDED.judgment.judgmentId,
    createdAt: RECORDED.judgment.createdAt,
  });
  assert.deepEqual(world.boundaries, ["decision_maker_judgment"]);
  assert.deepEqual(world.judgments, [
    { requestId: REQUEST_ID, kind: "confirm", shown: SHOWN, accuracy: { accuracy: "matched" }, operatorAnswer: undefined, keyRing: undefined },
  ]);
  // A confirmation or a rejection reads no key; only an edit does, before the database.
  assert.equal(world.keyRingReads, 0);
  assert.deepEqual(world.sessionReadsInBudget, [true]);
});

test("an edited answer reads the key ring before the database; without one nothing is written", async () => {
  const { POST } = await loadRoute();
  const edit = { requestId: REQUEST_ID, kind: "edit_confirm", shown: SHOWN, operatorAnswer: "Use the model id." };

  reset();
  assert.equal((await POST(post(edit))).status, 200);
  assert.equal(world.keyRingReads, 1);
  assert.equal(world.judgments[0]!.keyRing, RING);
  assert.equal(world.judgments[0]!.operatorAnswer, "Use the model id.");

  reset({ keyRingError: new FakeKeyError("not_configured") });
  const noKeys = await POST(post(edit));
  assert.equal(noKeys.status, 503);
  assert.deepEqual(await noKeys.json(), { error: "dm_digest_keys_unavailable" });
  assert.deepEqual(world.boundaries, []);
  assert.deepEqual(world.judgments, []);

  // A rejection needs no key at all.
  reset({ keyRingError: new FakeKeyError("not_configured") });
  assert.equal((await POST(post({ requestId: REQUEST_ID, kind: "reject" }))).status, 200);
  assert.equal(world.keyRingReads, 0);
});

test("a body outside the strict shape never reaches the store, and the store's invalid input is 400", async () => {
  const { POST } = await loadRoute();
  for (const body of [
    { ...CONFIRM, extra: 1 },
    { kind: "confirm" },
    { ...CONFIRM, requestId: 1 },
    { ...CONFIRM, shown: { ...SHOWN, extra: true } },
    { ...CONFIRM, accuracy: { accuracy: "matched", mismatchedItems: ["a", "b", "c", "d"] } },
    { requestId: REQUEST_ID, kind: "edit_confirm", operatorAnswer: "x".repeat(8193) },
    "not json",
  ]) {
    reset();
    const answer = await POST(post(body));
    assert.equal(answer.status, 400, typeof body === "string" ? body : Object.keys(body).join(","));
    assert.deepEqual(world.boundaries, []);
  }
  reset({ storeError: new FakeWriteError("invalid_input") });
  const invalid = await POST(post({ requestId: REQUEST_ID, kind: "approve" }));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_judgment" });
  reset({ storeError: new FakeWriteError("no_operator") });
  assert.equal((await POST(post(CONFIRM))).status, 404);
});

test("the store's refusal is 409 with its reason: it wrote nothing", async () => {
  const { POST } = await loadRoute();
  for (const reason of ["closed", "shown_mismatch", "kill_switch_on", "no_proposal", "digest_key_unavailable"]) {
    reset({ storeAnswer: { recorded: false, reason } });
    const refused = await POST(post(CONFIRM));
    assert.equal(refused.status, 409, reason);
    assert.deepEqual(await refused.json(), { error: "judgment_refused", reason }, reason);
  }
  reset({ storeAnswer: { recorded: false, reason: "operator_answer_refused", bodyRefusal: "secret_detected" } });
  const secret = await POST(post({ requestId: REQUEST_ID, kind: "edit_confirm", shown: SHOWN, operatorAnswer: "token=abc" }));
  assert.equal(secret.status, 409);
  assert.deepEqual(await secret.json(), { error: "judgment_refused", reason: "operator_answer_refused", bodyRefusal: "secret_detected" });
});

test("an unknown outcome says so, and every other failure says it was not recorded", async () => {
  const { POST } = await loadRoute();
  reset({ boundaryError: new FakeBoundaryError("AMUX_DB_OUTCOME_UNKNOWN") });
  const unknown = await POST(post(CONFIRM));
  assert.equal(unknown.status, 503);
  assert.deepEqual(await unknown.json(), { error: "outcome_unknown" });
  for (const code of ["AMUX_DB_DEADLINE_EXCEEDED", "AMUX_DB_NOT_STARTED", "AMUX_DB_PRISMA_CALL_CEILING_EXCEEDED"]) {
    reset({ boundaryError: new FakeBoundaryError(code) });
    const failed = await POST(post(CONFIRM));
    assert.equal(failed.status, 503, code);
    assert.deepEqual(await failed.json(), { error: "judgment_failed" }, code);
  }
  for (const error of [new FakeWriteError("state_unreadable"), new FakeWriteError("settings_unreadable"), new Error("guard refused")]) {
    reset({ storeError: error });
    const failed = await POST(post(CONFIRM));
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: "judgment_failed" });
  }
});
