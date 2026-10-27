import assert from "node:assert/strict";
import test from "node:test";

import {
  runAmuxWorkerRegistryReread,
  runAmuxWorkerSeedRegistration,
  runAmuxWorkerRegistration,
  runAmuxWorkerStateChange,
  type AmuxWorkerChangeRequest,
  type AmuxWorkerRegistryIo,
  type AmuxWorkerRegistryUpdate,
} from "@/components/admin/amuxWorkerRegistryRun";
import type { AdminApiFailure } from "@/lib/adminApiOutcome";
import {
  AMUX_WORKER_REGISTRY_V31_SEED,
  buildAmuxWorkerRegistryAdminView,
  parseAmuxWorkerRegistryAdminView,
  type AmuxWorkerRegistryAdminView,
} from "@/lib/amux/workerRegistryCore";

// The fixtures' names start with their CLI; the registry no longer reads it from them.
const amuxWorkerProviderClassOf = (name: string) =>
  name.slice(0, name.indexOf("-")) as import("@/lib/amux/workerRegistryCore").AmuxWorkerProviderClass;


/**
 * The requests behind AMUX › Operations settings › Workers, executed with a
 * fake io: what is sent, in what order, and when a run stops. The screen
 * itself is covered by amuxWorkersOverviewRender.test.tsx.
 */

const registration = (workerName: string, desiredState: "requested" | "active", roleCeiling: "chore" | "implementation" | "contract") => ({
  workerName,
  providerClass: amuxWorkerProviderClassOf(workerName)!,
  roleCeiling,
  desiredState,
  revision: 1,
  changedAt: "2026-10-12T05:00:00.000Z",
});

const EMPTY = buildAmuxWorkerRegistryAdminView({
  registrations: [],
  latches: new Map(),
  observations: new Map(),
  writesLatch: true,
});

const PARTIAL = buildAmuxWorkerRegistryAdminView({
  registrations: [registration("claude-impl", "active", "implementation"), registration("cursor-impl", "requested", "implementation")],
  latches: new Map(),
  observations: new Map(),
  writesLatch: true,
});

const FULL = buildAmuxWorkerRegistryAdminView({
  registrations: AMUX_WORKER_REGISTRY_V31_SEED.map((entry) => registration(entry.workerName, entry.desiredState, entry.roleCeiling)),
  latches: new Map(),
  observations: new Map(),
  writesLatch: true,
});

// ---------------------------------------------------------------------------
// The registration run

const FAILURE: AdminApiFailure = { kind: "failure", message: "failed" } as unknown as AdminApiFailure;
const NETWORK: AdminApiFailure = { kind: "network", message: "network" } as unknown as AdminApiFailure;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SEED = AMUX_WORKER_REGISTRY_V31_SEED.map(({ workerName, providerClass, roleCeiling, desiredState }) => ({ workerName, providerClass, roleCeiling, desiredState }));

const receipt = (entry: AmuxWorkerChangeRequest) =>
  json(200, { workerName: entry.workerName, revision: 1, action: "amux.worker.register", eventId: "event-1", sequence: "1", createdAt: "2026-10-12T00:00:00.000Z" });

/** A response whose headers arrived and whose body then broke off. */
const brokenBody = (status: number) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error("connection reset"));
      },
    }),
    { status, headers: { "content-type": "application/json" } },
  );

const runWith = async (
  answers: Array<(entry: AmuxWorkerChangeRequest) => Promise<Response>>,
  readResult: AmuxWorkerRegistryAdminView | null,
) => {
  const updates: AmuxWorkerRegistryUpdate[] = [];
  const posted: string[] = [];
  let reads = 0;
  const io: AmuxWorkerRegistryIo = {
    post: async (entry) => {
      posted.push(entry.workerName);
      const answer = answers[posted.length - 1] ?? ((sent: AmuxWorkerChangeRequest) => Promise.resolve(receipt(sent)));
      return answer(entry);
    },
    read: async () => {
      reads += 1;
      return readResult;
    },
    failureOf: async () => FAILURE,
    networkFailure: () => NETWORK,
  };
  await runAmuxWorkerSeedRegistration(SEED, io, (changes) => updates.push(changes));
  const last = <K extends keyof AmuxWorkerRegistryUpdate>(key: K) =>
    [...updates].reverse().find((changes) => key in changes)?.[key];
  return { updates, posted, reads, last };
};

test("all answered: each worker sent once, in seed order, then the registry read once", async () => {
  const { posted, reads, last, updates } = await runWith([], FULL);
  assert.deepEqual(posted, SEED.map((entry) => entry.workerName));
  assert.equal(reads, 1);
  assert.equal(last("notice"), "done");
  assert.deepEqual(last("view"), FULL);
  assert.equal(updates.at(-1)!.pending, null);
  assert.ok(updates.some((changes) => (changes.pending as { done?: number } | undefined)?.done === 13));
});

test("a refusal by the change rule stops the run on that worker; nothing more is sent", async () => {
  const { posted, reads, last } = await runWith(
    [(entry) => Promise.resolve(receipt(entry)), () => Promise.resolve(json(409, { error: "stale_revision" }))],
    PARTIAL,
  );
  assert.deepEqual(posted, SEED.slice(0, 2).map((entry) => entry.workerName));
  assert.equal(reads, 1);
  assert.equal(last("notice"), "stopped");
  assert.deepEqual(last("refusal"), { workerName: SEED[1]!.workerName, code: "stale_revision" });
});

test("the code latch's refusal stops the run before anything is written", async () => {
  const { posted, last } = await runWith([() => Promise.resolve(json(409, { error: "registry_writes_off" }))], EMPTY);
  assert.equal(posted.length, 1);
  assert.equal(last("notice"), "stopped");
  assert.deepEqual(last("refusal"), { workerName: SEED[0]!.workerName, code: "registry_writes_off" });
});

for (const [label, answer] of [
  ["a stale step-up", () => Promise.resolve(json(428, { code: "ADMIN_REAUTHENTICATION_REQUIRED" }))],
  ["a missing role", () => Promise.resolve(json(403, { error: "Forbidden." }))],
  ["the rate limit", () => Promise.resolve(json(429, { error: "Too many requests." }))],
  ["a rolled-back change", () => Promise.resolve(json(503, { error: "registry_change_failed" }))],
] as const) {
  test(`${label}: stopped with the failure shown, nothing more sent, the registry read again`, async () => {
    const { posted, reads, last } = await runWith([answer], EMPTY);
    assert.equal(posted.length, 1);
    assert.equal(reads, 1);
    assert.equal(last("notice"), "stopped");
    assert.equal(last("failure"), FAILURE);
  });
}

for (const [label, answer] of [
  ["an unknown outcome", () => Promise.resolve(json(503, { error: "outcome_unknown" }))],
  ["a 500", () => Promise.resolve(json(500, { error: "internal" }))],
  ["a 502 from a proxy", () => Promise.resolve(new Response("bad gateway", { status: 502 }))],
  ["no answer", () => Promise.reject(new TypeError("fetch failed"))],
  // A 2xx is a success only with this worker's receipt.
  ["a 200 whose body broke off", () => Promise.resolve(brokenBody(200))],
  ["a 200 that is not JSON", () => Promise.resolve(new Response("ok", { status: 200 }))],
  ["a 200 with an empty body object", () => Promise.resolve(json(200, {}))],
  ["a 200 naming another worker", () => Promise.resolve(json(200, { workerName: "claude-chore", revision: 1, action: "amux.worker.register", eventId: "e" }))],
  // Each receipt field on its own: everything else matches.
  ["a 200 at another revision", (entry: AmuxWorkerChangeRequest) => Promise.resolve(json(200, { workerName: entry.workerName, revision: 2, action: "amux.worker.register", eventId: "e" }))],
  ["a 200 under another action", (entry: AmuxWorkerChangeRequest) => Promise.resolve(json(200, { workerName: entry.workerName, revision: 1, action: "amux.worker.change", eventId: "e" }))],
  ["a 200 without an event id", (entry: AmuxWorkerChangeRequest) => Promise.resolve(json(200, { workerName: entry.workerName, revision: 1, action: "amux.worker.register" }))],
  ["a 200 with an empty event id", (entry: AmuxWorkerChangeRequest) => Promise.resolve(json(200, { workerName: entry.workerName, revision: 1, action: "amux.worker.register", eventId: "" }))],
] as const) {
  test(`${label}: the outcome is unknown, so nothing more is sent and the registry is read before release`, async () => {
    const { posted, reads, last, updates } = await runWith([(entry) => Promise.resolve(receipt(entry)), answer], PARTIAL);
    assert.equal(posted.length, 2);
    assert.equal(reads, 1);
    assert.equal(last("notice"), "outcome_unknown");
    const viewAt = updates.findIndex((changes) => "view" in changes);
    const releasedAt = updates.findIndex((changes) => "pending" in changes && changes.pending === null);
    assert.ok(viewAt >= 0 && viewAt < releasedAt);
  });
}

test("a run whose re-read fails shows no registry and says so", async () => {
  const { last } = await runWith([], null);
  assert.equal(last("view"), null);
  assert.equal(last("notice"), "unread");
});

test("reading again replaces the view and clears the last run's messages; a failed read leaves none", async () => {
  const run = async (result: AmuxWorkerRegistryAdminView | null) => {
    const updates: AmuxWorkerRegistryUpdate[] = [];
    await runAmuxWorkerRegistryReread({ read: async () => result }, (changes) => updates.push(changes));
    return updates;
  };
  const ok = await run(FULL);
  assert.ok(ok.some((changes) => changes.view === FULL && changes.notice === null && changes.refusal === null));
  const failed = await run(null);
  assert.ok(failed.some((changes) => "view" in changes && changes.view === null));
  assert.equal(failed.at(-1)!.pending, null);
});

test("the GET body is accepted only in its exact shape", () => {
  for (const view of [EMPTY, PARTIAL, FULL]) {
    assert.deepEqual(parseAmuxWorkerRegistryAdminView(JSON.parse(JSON.stringify(view))), view);
  }
  const body = JSON.parse(JSON.stringify(PARTIAL));
  for (const broken of [
    null,
    "x",
    { ...body, writesLatch: "yes" },
    { ...body, rows: [{ ...body.rows[0], desiredState: "autonomous" }] },
    { ...body, rows: [{ ...body.rows[0], providerClass: "devin" }] },
    { ...body, seed: body.seed.map((entry: { providerClass: string }, index: number) => (index === 0 ? { ...entry, providerClass: "codex" } : entry)) },
    { ...body, rows: [{ ...body.rows[0], reasons: ["because"] }] },
    { ...body, seed: body.seed.slice(1) },
    { ...body, seed: body.seed.map((entry: { desiredState: string }, index: number) => (index === 7 ? { ...entry, desiredState: "active" } : entry)) },
    { ...body, registryReadable: false },
  ]) {
    assert.equal(parseAmuxWorkerRegistryAdminView(broken), null, JSON.stringify(broken)?.slice(0, 80));
  }
});

// ---------------------------------------------------------------------------
// Turning one worker on, off or back on

const REQUEST: AmuxWorkerChangeRequest = {
  workerName: "cursor-impl",
  providerClass: "cursor",
  roleCeiling: "implementation",
  desiredState: "active",
  expectedRevision: 1,
};

const changeReceipt = (request: AmuxWorkerChangeRequest, overrides: Record<string, unknown> = {}) =>
  json(200, {
    workerName: request.workerName,
    revision: request.expectedRevision + 1,
    action: "amux.worker.change",
    eventId: "event-2",
    sequence: "2",
    createdAt: "2026-10-20T00:00:00.000Z",
    ...overrides,
  });

const changeWith = async (answer: () => Promise<Response>, readResult: AmuxWorkerRegistryAdminView | null) => {
  const updates: AmuxWorkerRegistryUpdate[] = [];
  const posted: AmuxWorkerChangeRequest[] = [];
  let reads = 0;
  const io: AmuxWorkerRegistryIo = {
    post: async (request) => {
      posted.push(request);
      return answer();
    },
    read: async () => {
      reads += 1;
      return readResult;
    },
    failureOf: async () => FAILURE,
    networkFailure: () => NETWORK,
  };
  await runAmuxWorkerStateChange(REQUEST, io, (changes) => updates.push(changes));
  const last = <K extends keyof AmuxWorkerRegistryUpdate>(key: K) =>
    [...updates].reverse().find((changes) => key in changes)?.[key];
  return { posted, reads, last, updates };
};

test("a state change is sent once with the revision the person saw, then the registry is read back", async () => {
  const { posted, reads, last, updates } = await changeWith(() => Promise.resolve(changeReceipt(REQUEST)), FULL);
  assert.deepEqual(posted, [REQUEST]);
  assert.equal(reads, 1);
  assert.equal(last("notice"), "done");
  assert.deepEqual(last("view"), FULL);
  assert.equal(updates.at(-1)!.pending, null);
});

test("the server's own refusal of a turn-on is shown as a refusal and writes nothing", async () => {
  for (const code of ["role_widening_requires_trial", "stale_revision", "registry_writes_off", "retired"]) {
    const { posted, last } = await changeWith(() => Promise.resolve(json(409, { error: code })), PARTIAL);
    assert.equal(posted.length, 1, code);
    assert.equal(last("notice"), "stopped", code);
    assert.deepEqual(last("refusal"), { workerName: REQUEST.workerName, code });
  }
});

test("a stale step-up is a failure with the way back, not a refusal", async () => {
  const { last } = await changeWith(() => Promise.resolve(json(428, { code: "ADMIN_REAUTHENTICATION_REQUIRED" })), PARTIAL);
  assert.equal(last("failure"), FAILURE);
  assert.equal(last("notice"), "stopped");
  assert.equal(last("refusal"), null);
});

for (const [label, answer] of [
  ["a receipt for the register action", () => Promise.resolve(changeReceipt(REQUEST, { action: "amux.worker.register" }))],
  ["a receipt at the wrong revision", () => Promise.resolve(changeReceipt(REQUEST, { revision: 5 }))],
  ["a receipt for another worker", () => Promise.resolve(changeReceipt(REQUEST, { workerName: "cursor-chore" }))],
  ["an unknown outcome", () => Promise.resolve(json(503, { error: "outcome_unknown" }))],
  ["no answer", () => Promise.reject(new TypeError("fetch failed"))],
] as const) {
  test(`${label}: the outcome is unknown, so the registry is read before release and nothing is sent again`, async () => {
    const { posted, reads, last } = await changeWith(answer, PARTIAL);
    assert.equal(posted.length, 1);
    assert.equal(reads, 1);
    assert.equal(last("notice"), "outcome_unknown");
  });
}

test("registering a new worker sends its chosen CLI once, waiting to be turned on, at revision 0", async () => {
  // Owner decision 2026-10-27: the name does not carry the CLI.
  const posted: AmuxWorkerChangeRequest[] = [];
  const io: AmuxWorkerRegistryIo = {
    post: async (request) => {
      posted.push(request);
      return json(200, { workerName: request.workerName, revision: 1, action: "amux.worker.register", eventId: "event-1" });
    },
    read: async () => FULL,
    failureOf: async () => FAILURE,
    networkFailure: () => NETWORK,
  };
  const updates: AmuxWorkerRegistryUpdate[] = [];
  await runAmuxWorkerRegistration({ workerName: "kimi-impl", providerClass: "copilot", roleCeiling: "implementation" }, io,
    (changes) => updates.push(changes));
  assert.deepEqual(posted, [{ workerName: "kimi-impl", providerClass: "copilot", roleCeiling: "implementation",
    desiredState: "requested", expectedRevision: 0 }]);
  assert.equal([...updates].reverse().find((changes) => "notice" in changes)?.notice, "done");
});
