import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import {
  AmuxWorkerRegistryView,
  runAmuxWorkerRegistryReread,
  runAmuxWorkerSeedRegistration,
  type AmuxWorkerRegistryIo,
  type AmuxWorkerRegistryNotice,
  type AmuxWorkerRegistryPending,
  type AmuxWorkerRegistryUpdate,
} from "@/components/admin/AmuxWorkerRegistryPanel";
import type { AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminAmuxWorkerRegistryMessages } from "@/lib/adminMessages/amuxWorkerRegistry";
import {
  AMUX_WORKER_REGISTRY_V31_SEED,
  amuxWorkerProviderClassOf,
  buildAmuxWorkerRegistryAdminView,
  parseAmuxWorkerRegistryAdminView,
  type AmuxWorkerRegistryAdminView,
  type AmuxWorkerSeedEntry,
} from "@/lib/amux/workerRegistryCore";

/**
 * AMUX › Execution › Workers (orchestration policy version 31, sections 3 and
 * 8), executed: the hook-free view is called and the element tree it returns
 * is walked, as the other client render tests do; the registration run is
 * driven with a fake io. What it may offer, to whom, and when it stops.
 */

const m = adminAmuxWorkerRegistryMessages.en;

type Props = Record<string, unknown>;

const propsOf = (node: ReactNode, found: Props[] = []) => {
  if (node === null || node === undefined || typeof node === "boolean") return found;
  if (typeof node === "string" || typeof node === "number") return found;
  if (Array.isArray(node)) {
    for (const child of node) propsOf(child, found);
    return found;
  }
  const element = node as { props?: Props };
  if (element.props) {
    found.push(element.props);
    propsOf(element.props.children as ReactNode, found);
  }
  return found;
};

const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const element = node as { props?: { children?: ReactNode } };
  return element.props ? textOf(element.props.children) : "";
};

const byTestId = (node: ReactNode, id: string) =>
  propsOf(node).filter((props) => props["data-testid"] === id);

const registration = (workerName: string, desiredState: "requested" | "active", roleCeiling: "chore" | "implementation" | "contract") => ({
  workerName,
  providerClass: amuxWorkerProviderClassOf(workerName)!,
  roleCeiling,
  desiredState,
  revision: 1,
  changedAt: "2026-10-12T05:00:00.000Z",
});

const catalogEntry = (worker_name: string, provider: string) => ({
  worker_name,
  provider,
  archived: false,
  paused: false,
  isolated: false,
  blocked: false,
});

const EMPTY = buildAmuxWorkerRegistryAdminView({
  registrations: [],
  latches: new Map(),
  observations: new Map(),
  catalog: [catalogEntry("claude-impl", "claude")],
  writesLatch: true,
});

const PARTIAL = buildAmuxWorkerRegistryAdminView({
  registrations: [registration("claude-impl", "active", "implementation"), registration("cursor-impl", "requested", "implementation")],
  latches: new Map(),
  observations: new Map(),
  catalog: [catalogEntry("claude-impl", "claude"), catalogEntry("codex-impl", "codex")],
  writesLatch: true,
});

const FULL = buildAmuxWorkerRegistryAdminView({
  registrations: AMUX_WORKER_REGISTRY_V31_SEED.map((entry) => registration(entry.workerName, entry.desiredState, entry.roleCeiling)),
  latches: new Map(),
  observations: new Map(),
  catalog: null,
  writesLatch: true,
});

const render = (
  overrides: Partial<{
    view: AmuxWorkerRegistryAdminView | null;
    isOwner: boolean;
    pending: AmuxWorkerRegistryPending;
    notice: AmuxWorkerRegistryNotice;
    onRegister: (entries: AmuxWorkerSeedEntry[]) => void;
  }> = {},
) =>
  AmuxWorkerRegistryView({
    m,
    view: "view" in overrides ? overrides.view! : EMPTY,
    isOwner: overrides.isOwner ?? true,
    pending: overrides.pending ?? null,
    notice: overrides.notice ?? null,
    refusal: null,
    failure: null,
    onRegister: overrides.onRegister ?? (() => {}),
    onReread: () => {},
  });

test("an unreadable registry shows no registry and no registration, only reading again", () => {
  const tree = render({ view: null });
  assert.equal(byTestId(tree, "amux-worker-registry-unavailable").length, 1);
  assert.equal(byTestId(tree, "amux-worker-registry-reread").length, 1);
  assert.equal(byTestId(tree, "amux-worker-registry-seed").length, 0);
  assert.equal(byTestId(tree, "amux-worker-registry-seed-register").length, 0);
});

test("the owner is offered the thirteen in seed order, sent exactly as the seed says", () => {
  let sent: AmuxWorkerSeedEntry[] | null = null;
  const tree = render({ onRegister: (entries) => { sent = entries; } });
  const [button] = byTestId(tree, "amux-worker-registry-seed-register");
  assert.ok(button);
  assert.equal(button.disabled, false);
  assert.equal(textOf(button.children as ReactNode), m.seedRegister(13));
  (button.onClick as () => void)();
  assert.deepEqual(sent, AMUX_WORKER_REGISTRY_V31_SEED.map(({ workerName, roleCeiling, desiredState }) => ({ workerName, roleCeiling, desiredState })));
});

test("only what is missing is offered, and nothing once all thirteen are registered", () => {
  let sent: AmuxWorkerSeedEntry[] | null = null;
  const partial = render({ view: PARTIAL, onRegister: (entries) => { sent = entries; } });
  const [button] = byTestId(partial, "amux-worker-registry-seed-register");
  (button.onClick as () => void)();
  assert.equal(sent!.length, 11);
  assert.equal(sent!.some((entry) => entry.workerName === "claude-impl" || entry.workerName === "cursor-impl"), false);

  const full = render({ view: FULL });
  assert.equal(byTestId(full, "amux-worker-registry-seed-register").length, 0);
  assert.match(textOf(full), new RegExp(m.seedAllRegistered));
});

test("with the code latch off the owner sees what would be registered, and the control is disabled", () => {
  const tree = render({ view: { ...EMPTY, writesLatch: false } });
  assert.match(textOf(byTestId(tree, "amux-worker-registry-latch")[0]!.children as ReactNode), /off/);
  const [button] = byTestId(tree, "amux-worker-registry-seed-register");
  assert.equal(button.disabled, true);
});

test("a non-owner reads the registry and the comparison, and is offered nothing", () => {
  const tree = render({ view: PARTIAL, isOwner: false });
  assert.equal(byTestId(tree, "amux-worker-registry-read-only").length, 1);
  assert.equal(byTestId(tree, "amux-worker-registry-seed").length, 0);
  assert.equal(byTestId(tree, "amux-worker-row-claude-impl").length, 1);
  assert.equal(byTestId(tree, "amux-worker-comparison-codex-impl")[0]!["data-verdict"], "unregistered");
  assert.equal(byTestId(tree, "amux-worker-registry-comparison-status")[0]!["data-status"], "mismatch");
});

test("each worker shows why the registry would not assign it yet", () => {
  const tree = render({ view: PARTIAL });
  assert.equal(
    textOf(byTestId(tree, "amux-worker-effective-claude-impl")[0]!.children as ReactNode),
    m.reason.no_observation,
  );
  assert.equal(
    textOf(byTestId(tree, "amux-worker-effective-cursor-impl")[0]!.children as ReactNode),
    `${m.reason.not_active}, ${m.reason.no_observation}`,
  );
});

test("while a run is in flight the control says how far it is and cannot start another", () => {
  const tree = render({ pending: { done: 4, total: 13 } });
  const [button] = byTestId(tree, "amux-worker-registry-seed-register");
  assert.equal(button.disabled, true);
  assert.equal(textOf(button.children as ReactNode), m.seedRegistering(4, 13));
});

// ---------------------------------------------------------------------------
// The registration run

const FAILURE: AdminApiFailure = { kind: "failure", message: "failed" } as unknown as AdminApiFailure;
const NETWORK: AdminApiFailure = { kind: "network", message: "network" } as unknown as AdminApiFailure;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SEED = AMUX_WORKER_REGISTRY_V31_SEED.map(({ workerName, roleCeiling, desiredState }) => ({ workerName, roleCeiling, desiredState }));

const receipt = (entry: AmuxWorkerSeedEntry) =>
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
  answers: Array<(entry: AmuxWorkerSeedEntry) => Promise<Response>>,
  readResult: AmuxWorkerRegistryAdminView | null,
) => {
  const updates: AmuxWorkerRegistryUpdate[] = [];
  const posted: string[] = [];
  let reads = 0;
  const io: AmuxWorkerRegistryIo = {
    post: async (entry) => {
      posted.push(entry.workerName);
      const answer = answers[posted.length - 1] ?? ((sent: AmuxWorkerSeedEntry) => Promise.resolve(receipt(sent)));
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
  ["a 200 at another revision", (entry: AmuxWorkerSeedEntry) => Promise.resolve(json(200, { workerName: entry.workerName, revision: 2, action: "amux.worker.register", eventId: "e" }))],
  ["a 200 under another action", (entry: AmuxWorkerSeedEntry) => Promise.resolve(json(200, { workerName: entry.workerName, revision: 1, action: "amux.worker.change", eventId: "e" }))],
  ["a 200 without an event id", (entry: AmuxWorkerSeedEntry) => Promise.resolve(json(200, { workerName: entry.workerName, revision: 1, action: "amux.worker.register" }))],
  ["a 200 with an empty event id", (entry: AmuxWorkerSeedEntry) => Promise.resolve(json(200, { workerName: entry.workerName, revision: 1, action: "amux.worker.register", eventId: "" }))],
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
    { ...body, rows: [{ ...body.rows[0], providerClass: "codex" }] },
    { ...body, rows: [{ ...body.rows[0], reasons: ["because"] }] },
    { ...body, comparison: { status: "agree", rows: [] } },
    { ...body, seed: body.seed.slice(1) },
    { ...body, seed: body.seed.map((entry: { desiredState: string }, index: number) => (index === 7 ? { ...entry, desiredState: "active" } : entry)) },
    { ...body, registryReadable: false },
  ]) {
    assert.equal(parseAmuxWorkerRegistryAdminView(broken), null, JSON.stringify(broken)?.slice(0, 80));
  }
});

test("a catalog entry outside the registry's name grammar still reads back, as unregistered", () => {
  // Production 2026-10-12: the catalog variable names workers by the AMUX
  // machine-id rule, not the registry's grammar, and the re-read after the
  // thirteen were registered was refused whole because one such name sat in
  // the comparison. The server built that row correctly; only the reader was
  // too strict.
  const view = buildAmuxWorkerRegistryAdminView({
    registrations: AMUX_WORKER_REGISTRY_V31_SEED.map((entry) => registration(entry.workerName, entry.desiredState, entry.roleCeiling)),
    latches: new Map(),
    observations: new Map(),
    catalog: [
      catalogEntry("claude-impl", "claude"),
      { ...catalogEntry("devin-worker", "devin"), archived: true },
      catalogEntry("Codex.Impl:2", "openai"),
    ],
    writesLatch: true,
  });
  const verdicts = Object.fromEntries(view.comparison.rows.map((row) => [row.workerName, row.verdict]));
  assert.equal(verdicts["devin-worker"], "unregistered");
  assert.equal(verdicts["Codex.Impl:2"], "unregistered");
  assert.deepEqual(parseAmuxWorkerRegistryAdminView(JSON.parse(JSON.stringify(view))), view);

  // Still refused: a name that is not a machine id at all, and a registry
  // state on a name the registry could never hold.
  const body = JSON.parse(JSON.stringify(view));
  const at = body.comparison.rows.findIndex((row: { workerName: string }) => row.workerName === "devin-worker");
  for (const workerName of ["", "devin worker", "-devin", "x".repeat(121), 7]) {
    const rows = body.comparison.rows.map((row: object, index: number) => (index === at ? { ...row, workerName } : row));
    assert.equal(parseAmuxWorkerRegistryAdminView({ ...body, comparison: { ...body.comparison, rows } }), null, String(workerName));
  }
  const rows = body.comparison.rows.map((row: object, index: number) => (index === at ? { ...row, registryState: "active" } : row));
  assert.equal(parseAmuxWorkerRegistryAdminView({ ...body, comparison: { ...body.comparison, rows } }), null);
});
