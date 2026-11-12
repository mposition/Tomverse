import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// The owner's recreate and close on a legacy WORKBOARD card
// (app/api/admin/amux/legacy-card): who may act, what refuses before any idea
// is saved, and that a recreate saves through the shared send path and then closes.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;

class FakeOwnerError extends Error {
  constructor(readonly code: "forbidden" | "busy") { super(code); }
}
class FakeSubmissionError extends Error {
  constructor(readonly code: string, readonly status: number, readonly ideaId?: string) { super(code); }
}

type Card = { id: string; displayKey: string | null; sourceSystem: string | null; description: string | null;
  executionBrief: string | null; revision: number };
const world = {
  session: { user: { id: "owner-1" } } as { user: { id: string } } | null,
  role: "owner", recent: true,
  card: null as Card | null,
  refusal: null as string | null,
  /** The card's kind in the detail read; null: not a stopped card. */
  kind: "workboard" as "workboard" | "pre_v22_task" | "stopped_task" | null,
  /** Why the detail read says the card cannot be completed; only a stopped v22 Task reads null. */
  completeRefusal: "not_completable" as string | null,
  completes: [] as Array<{ taskId: string; revision: number; reason: string }>,
  completeOutcome: "completed" as "completed" | "refused",
  engineeringClosedFor: [] as string[],
  engineeringFails: false,
  readBack: [] as Array<{ status: "absent" } | { status: "committed"; ideaId: string }>,
  submits: [] as string[],
  sendPathIdeas: [] as Array<{ requestId: string; idea: string; sessionDisplay: string }>,
  closes: [] as Array<{ taskId: string; revision: number; ideaId: string | null }>,
  closeOutcome: "closed" as "closed" | "refused" | "busy",
  archived: false,
  writeOn: "true",
};
const reset = () => {
  world.session = { user: { id: "owner-1" } }; world.role = "owner"; world.recent = true;
  world.card = { id: "cmlegacy0001", displayKey: "AMUX-WORKBOARD-061", sourceSystem: "tomverse_private_workboard",
    description: JSON.stringify({ problem: "The renewal date is hidden. Users ask support.",
      completionCriteria: ["The date shows"] }), executionBrief: null, revision: 4 };
  world.refusal = null; world.kind = "workboard"; world.readBack = [{ status: "absent" }]; world.submits = []; world.sendPathIdeas = [];
  world.closes = []; world.closeOutcome = "closed"; world.writeOn = "true"; world.archived = false;
  world.completeRefusal = "not_completable"; world.completes = []; world.completeOutcome = "completed";
  world.engineeringClosedFor = []; world.engineeringFails = false;
};

let installed = false;
async function loadRoute(): Promise<{ POST: (request: Request) => Promise<Response> }> {
  if (!installed) {
    installed = true;
    mock.module("next-auth/next", { namedExports: { getServerSession: async () => world.session } });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/adminAuth.ts"), { namedExports: {
      isAdminSession: () => world.session !== null, getAdminRole: () => world.role } });
    mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
      assertRecentAdminAuthentication: async () => { if (!world.recent) throw new Error("reauth"); },
      isAdminReauthenticationError: (error: unknown) => error instanceof Error && error.message === "reauth" } });
    mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
      consumeApiRateLimit: async () => {},
      apiSecurityResponse: (error: unknown) => error instanceof Error && error.message === "invalid request" ?
        Response.json({ error: "Invalid request payload." }, { status: 400 }) : null,
      readLimitedJson: async (request: Request, limit: number, schema: {
        safeParse: (value: unknown) => { success: boolean; data: unknown } }) => {
        const raw = await request.text();
        if (raw.length > limit) throw new Error("invalid request");
        const parsed = schema.safeParse(JSON.parse(raw));
        if (!parsed.success) throw new Error("invalid request");
        return parsed.data;
      } } });
    mock.module(mod("lib/requestOrigin.ts"), { namedExports: {
      hasValidMutationOrigin: (request: Request) => request.headers.get("origin") === "https://tomverse.test" } });
    mock.module(mod("lib/amux/ideaSubmissionCore.ts"), { namedExports: {
      AMUX_V4_IDEA_SUBMISSION_ENV: "W", AMUX_V4_IDEA_READBACK_ENV: "R",
      ideaSubmissionWritePermitted: () => world.writeOn === "true",
      ideaSubmissionReadBackPermitted: () => true } });
    mock.module(mod("lib/amux/ideaSubmissionService.ts"), { namedExports: { IdeaSubmissionError: FakeSubmissionError } });
    mock.module(mod("lib/amux/ideaSessionSubmissionService.ts"), { namedExports: {
      AmuxIdeaSessionSubmissionError: class extends Error { code = "x"; } } });
    mock.module(mod("lib/amux/ideaSessionSubmissionCore.ts"), { namedExports: {
      amuxIdeaSessionPrewriteStatus: () => null } });
    mock.module(mod("lib/amux/ideaSendPath.ts"), { namedExports: {
      ideaSendPath: async (input: { requestId: string; idea: string; sessionDisplay: string }) => {
        world.sendPathIdeas.push({ requestId: input.requestId, idea: input.idea,
          sessionDisplay: input.sessionDisplay });
        return { ok: true,
          readBack: async () => world.readBack.shift() ?? { status: "absent" },
          submit: async () => { world.submits.push(input.requestId); return { ideaId: "idea-1" }; },
          isAlreadySeen: () => false };
      } } });
    // The card detail read builds the view on the server (lib/amux/adminExecutionRead.ts).
    mock.module(mod("lib/amux/adminExecutionRead.ts"), { namedExports: {
      readAmuxExecutionTaskDetail: async (taskId: string) => {
        const card: Card | null = world.card;
        if (!card || card.id !== taskId) return null;
        return { id: card.id, revision: card.revision, legacyCard: world.kind === null ? null : {
          kind: world.kind, closeRefusal: world.refusal, completeRefusal: world.completeRefusal,
          idea: card.description?.includes("someone@") ? { state: "refused", code: "content_refused" } :
            { state: "ready", title: "The renewal date is hidden.", truncated: false,
              text: `The renewal date is hidden.\n\n${card.description}` } } };
      } } });
    mock.module(mod("lib/amux/legacyCardOwnerService.ts"), { namedExports: {
      AmuxLegacyCardOwnerError: FakeOwnerError,
      assertAmuxLegacyCardOwner: async () => { if (!world.recent) throw new Error("reauth"); },
      closeAmuxLegacyCardForOwner: async (input: { taskId: string; revision: number; ideaId: string | null }) => {
        world.closes.push(input);
        if (world.closeOutcome === "busy") throw new FakeOwnerError("busy");
        return world.closeOutcome === "closed" ?
          { outcome: "closed", archivedAt: "2026-11-08T09:00:00.000Z", alreadyArchived: world.archived,
            escalationsResolved: 1, auditId: "a1" } :
          { outcome: "refused", reason: "running" };
      },
      completeAmuxStoppedCardForOwner: async (input: { taskId: string; revision: number; reason: string }) => {
        world.completes.push(input);
        return world.completeOutcome === "completed" ?
          { outcome: "completed", revision: input.revision + 1, escalationsResolved: 1, auditId: "a2" } :
          { outcome: "refused", reason: "changed" };
      } } });
    // The engineering agent's own items for the card, closed after the settlement commits.
    mock.module(mod("lib/amux/ownerSettlementEngineering.ts"), { namedExports: {
      closeEngineeringOwnerItemsForSettledCard: async (input: { taskId: string }) => {
        world.engineeringClosedFor.push(input.taskId);
        if (world.engineeringFails) throw new Error("engineering store unavailable");
        return { draftsRejected: 1, decisionsAcknowledged: 2, left: 0 };
      } } });
  }
  return import(mod("app/api/admin/amux/legacy-card/route.ts"));
}

const post = (body: unknown, origin = "https://tomverse.test", contentType = "application/json") =>
  new Request("https://tomverse.test/api/admin/amux/legacy-card", { method: "POST",
    headers: { "content-type": contentType, origin }, body: JSON.stringify(body) });
const recreate = { action: "recreate", taskId: "cmlegacy0001", revision: 4, ownerConfirmed: true };
const close = { ...recreate, action: "close" };

test("only a recently authenticated owner on the same origin acts", async () => {
  const { POST } = await loadRoute();
  for (const [session, role, recent, origin, expected] of [
    [null, "owner", true, "https://tomverse.test", 404],
    [{ user: { id: "ops-1" } }, "ops", true, "https://tomverse.test", 403],
    [{ user: { id: "owner-1" } }, "owner", true, "https://elsewhere.test", 403],
    [{ user: { id: "owner-1" } }, "owner", false, "https://tomverse.test", 428],
  ] as const) {
    reset(); world.session = session; world.role = role; world.recent = recent;
    const response = await POST(post(recreate, origin));
    assert.equal(response.status, expected);
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
    assert.equal(world.submits.length + world.closes.length, 0);
  }
});

test("the body is exact: an action, the card, the shown revision and the owner's confirmation", async () => {
  const { POST } = await loadRoute();
  reset();
  for (const invalid of [{}, { ...recreate, ownerConfirmed: false }, { ...recreate, action: "delete" },
    { ...recreate, extra: 1 }, { ...recreate, taskId: "bad id" }]) {
    assert.equal((await POST(post(invalid))).status, 400);
  }
  assert.equal((await POST(post(recreate, "https://tomverse.test", "text/plain"))).status, 415);
  assert.equal(world.submits.length + world.closes.length, 0);
});

test("a running, closed, changed or missing card refuses before any idea is saved", async () => {
  const { POST } = await loadRoute();
  for (const refusal of ["running", "already_closed", "changed", "not_legacy"]) {
    reset();
    if (refusal === "not_legacy") world.kind = null; else world.refusal = refusal;
    const response = await POST(post(recreate));
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "not_closable", reason: refusal });
    assert.equal(world.sendPathIdeas.length + world.closes.length, 0);
  }
  reset();
  const changed = await POST(post({ ...recreate, revision: 3 }));
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), { error: "not_closable", reason: "changed" });
  reset(); world.card = null;
  assert.equal((await POST(post(recreate))).status, 404);
  assert.equal(world.sendPathIdeas.length, 0);
});

test("an idea the input gate refuses is not saved and says why", async () => {
  const { POST } = await loadRoute();
  reset(); world.card!.description = JSON.stringify({ problem: "Mail someone@example.com." });
  const response = await POST(post(recreate));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "idea_refused", reason: "content_refused" });
  assert.equal(world.sendPathIdeas.length + world.closes.length, 0);
  reset(); world.writeOn = "false";
  assert.equal((await POST(post(recreate))).status, 503);
  assert.equal(world.sendPathIdeas.length, 0);
});

test("a recreate saves the idea under the card's derived request id, then closes the card naming it", async () => {
  const { POST } = await loadRoute();
  const { amuxLegacyCardRecreateRequestId } = await import(mod("lib/amux/legacyCardCore.ts"));
  reset();
  const response = await POST(post(recreate));
  assert.equal(response.status, 200);
  // The mocked idea text: the title line, a blank line, then the description.
  const requestId = amuxLegacyCardRecreateRequestId("cmlegacy0001",
    ["The renewal date is hidden.", "", world.card!.description].join("\n"));
  assert.deepEqual(await response.json(), { status: "recreated", ideaId: "idea-1", requestId, closed: true,
    archivedAt: "2026-11-08T09:00:00.000Z", alreadyArchived: false, escalationsResolved: 1, engineering: { draftsRejected: 1, decisionsAcknowledged: 2, left: 0 } });
  assert.deepEqual(world.engineeringClosedFor, ["cmlegacy0001"]);
  assert.deepEqual(world.submits, [requestId]);
  assert.match(world.sendPathIdeas[0]!.idea, /^The renewal date is hidden\./);
  assert.equal(world.sendPathIdeas[0]!.sessionDisplay, "Legacy WORKBOARD card");
  assert.deepEqual(world.closes, [{ ...world.closes[0], taskId: "cmlegacy0001", revision: 4, ideaId: "idea-1" }]);

  // A second click after a close that did not land reads the same idea back: no second idea.
  reset(); world.readBack = [{ status: "committed", ideaId: "idea-1" }]; world.closeOutcome = "refused";
  const again = await POST(post(recreate));
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { status: "recreated", ideaId: "idea-1", requestId, closed: false,
    reason: "running" });
  assert.equal(world.submits.length, 0);
  // A card that did not close keeps its engineering items.
  assert.equal(world.engineeringClosedFor.length, 0);

  // Changed assigned work saves its own idea instead of reading the old one back.
  reset(); world.card!.description = JSON.stringify({ problem: "Now a different task." });
  const changed = await POST(post(recreate));
  const changedBody = await changed.json() as { requestId: string };
  assert.notEqual(changedBody.requestId, requestId);
  assert.deepEqual(world.submits, [changedBody.requestId]);
});

test("a pre-v22 Task is recreated and closed the same way, under its own source label", async () => {
  const { POST } = await loadRoute();
  reset(); world.kind = "pre_v22_task";
  const response = await POST(post(recreate));
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { closed: boolean }).closed, true);
  assert.equal(world.sendPathIdeas[0]!.sessionDisplay, "Pre-v22 AMUX Task");
  assert.equal(world.closes.length, 1);
});

test("close only archives without an idea; a held card answers busy", async () => {
  const { POST } = await loadRoute();
  reset();
  const response = await POST(post(close));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "closed", closed: true, archivedAt: "2026-11-08T09:00:00.000Z",
    alreadyArchived: false, escalationsResolved: 1, engineering: { draftsRejected: 1, decisionsAcknowledged: 2, left: 0 } });
  assert.equal(world.sendPathIdeas.length, 0);
  assert.equal(world.closes[0]!.ideaId, null);
  // An archived card still in the owner queue goes through the same close, which says so.
  reset(); world.archived = true;
  const archived = await POST(post(close));
  assert.equal(archived.status, 200);
  assert.equal((await archived.json() as { alreadyArchived: boolean }).alreadyArchived, true);
  reset(); world.closeOutcome = "busy";
  const busy = await POST(post(close));
  assert.equal(busy.status, 409);
  assert.deepEqual(await busy.json(), { error: "busy" });
});

test("the owner completes a stopped v22 Task as done with a reason; nothing else completes", async () => {
  const { POST } = await loadRoute();
  const complete = { ...recreate, action: "complete", reason: "PR merged; the work is on develop." };
  reset(); world.kind = "stopped_task"; world.completeRefusal = null;
  const response = await POST(post(complete));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "completed", revision: 5, escalationsResolved: 1, engineering: { draftsRejected: 1, decisionsAcknowledged: 2, left: 0 } });
  assert.deepEqual(world.completes, [{ ...world.completes[0], taskId: "cmlegacy0001", revision: 4,
    reason: "PR merged; the work is on develop." }]);
  assert.equal(world.closes.length + world.sendPathIdeas.length, 0);
  assert.deepEqual(world.engineeringClosedFor, ["cmlegacy0001"]);

  // The reason is required for a completion and refused on the other two actions.
  reset(); world.kind = "stopped_task"; world.completeRefusal = null;
  assert.equal((await POST(post({ ...recreate, action: "complete" }))).status, 400);
  assert.equal((await POST(post({ ...complete, reason: "   " }))).status, 400);
  assert.equal((await POST(post({ ...close, reason: "not for a close" }))).status, 400);
  assert.equal(world.completes.length + world.closes.length, 0);

  // A legacy card, or a Task the detail read says cannot be done, refuses before any write.
  reset();
  const legacy = await POST(post(complete));
  assert.equal(legacy.status, 409);
  assert.deepEqual(await legacy.json(), { error: "not_completable", reason: "not_completable" });
  assert.equal(world.completes.length, 0);

  // The write judges again under its lock.
  reset(); world.kind = "stopped_task"; world.completeRefusal = null; world.completeOutcome = "refused";
  const moved = await POST(post(complete));
  assert.equal(moved.status, 409);
  assert.deepEqual(await moved.json(), { error: "not_completable", reason: "changed" });
  assert.equal(world.engineeringClosedFor.length, 0);
});

test("a stopped v22 Task is remade under its own source label, and an engineering failure never undoes a settlement", async () => {
  const { POST } = await loadRoute();
  reset(); world.kind = "stopped_task";
  const remade = await POST(post(recreate));
  assert.equal(remade.status, 200);
  assert.equal(world.sendPathIdeas[0]!.sessionDisplay, "Stopped AMUX Task");

  reset(); world.kind = "stopped_task"; world.completeRefusal = null; world.engineeringFails = true;
  const response = await POST(post({ ...recreate, action: "complete", reason: "Verified by hand." }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "completed", revision: 5, escalationsResolved: 1,
    engineering: null });
});
