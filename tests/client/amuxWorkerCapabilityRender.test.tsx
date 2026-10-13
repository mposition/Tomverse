import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import {
  AmuxWorkerCapabilityView,
  runAmuxWorkerCapabilityImport,
  type AmuxWorkerCapabilityImport,
  type AmuxWorkerCapabilityIo,
  type AmuxWorkerCapabilityUpdate,
} from "@/components/admin/AmuxWorkerCapabilityPanel";
import type { AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminAmuxWorkerCapabilityMessages } from "@/lib/adminMessages/amuxWorkerCapability";
import {
  amuxWorkerCapabilityImportsToWrite,
  buildAmuxWorkerCapabilityAdminView,
  type AmuxWorkerCapabilityAdminView,
} from "@/lib/amux/workerCapabilityCore";
import { AMUX_WORKER_REGISTRY_V31_SEED, amuxWorkerProviderClassOf } from "@/lib/amux/workerRegistryCore";

/**
 * AMUX › Execution › Workers, capabilities (orchestration policy version 35,
 * R2a), executed: the hook-free view is walked, and the import run is driven
 * with a fake io. What it offers, to whom, and when it stops.
 */

const m = adminAmuxWorkerCapabilityMessages.en;
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
const byTestId = (node: ReactNode, id: string) => propsOf(node).filter((props) => props["data-testid"] === id);

const REGISTRY = AMUX_WORKER_REGISTRY_V31_SEED.map((entry) => ({
  workerName: entry.workerName,
  providerClass: amuxWorkerProviderClassOf(entry.workerName)!,
  roleCeiling: entry.roleCeiling,
  desiredState: entry.desiredState,
  revision: 1,
}));
const LEGACY = [
  { worker_name: "claude-chore", provider: "claude", routing_roles: ["chore"] },
  { worker_name: "claude-impl", provider: "claude", routing_roles: ["implementation"] },
  { worker_name: "codex-impl", provider: "codex", routing_roles: ["implementation"] },
];
const V22 = [
  { worker_name: "claude-chore", provider: "anthropic", model: "claude-opus-5-5", routing_roles: ["investigate"], tool_capabilities: ["repo_read"] },
];
const VIEW = buildAmuxWorkerCapabilityAdminView({ registrations: REGISTRY, current: new Map(), legacy: LEGACY, v22: V22, writesLatch: true });

const render = (overrides: Partial<{ view: AmuxWorkerCapabilityAdminView | null; isOwner: boolean; onImport: (imports: AmuxWorkerCapabilityImport[]) => void }> = {}) =>
  AmuxWorkerCapabilityView({
    m,
    view: "view" in overrides ? overrides.view! : VIEW,
    isOwner: overrides.isOwner ?? true,
    pending: null,
    notice: null,
    refusal: null,
    failure: null,
    onImport: overrides.onImport ?? (() => {}),
    onReread: () => {},
  });

test("the owner is offered exactly the proposals that can be recorded", () => {
  let sent: AmuxWorkerCapabilityImport[] | null = null;
  const tree = render({ onImport: (imports) => { sent = imports; } });
  const [button] = byTestId(tree, "amux-worker-capability-import-run");
  assert.equal(button.disabled, false);
  assert.equal(textOf(button.children as ReactNode), m.importRun(3));
  (button.onClick as () => void)();
  assert.deepEqual(sent, amuxWorkerCapabilityImportsToWrite(VIEW));
  assert.match(textOf(byTestId(tree, "amux-worker-capability-status-claude-chore")[0]!.children as ReactNode), /will be recorded/);
  assert.match(textOf(byTestId(tree, "amux-worker-capability-status-cursor-impl")[0]!.children as ReactNode), /nothing to import/);
});

test("latched off, the control is disabled; a non-owner is offered nothing; an unread view offers only reading again", () => {
  assert.equal(byTestId(render({ view: { ...VIEW, writesLatch: false } }), "amux-worker-capability-import-run")[0]!.disabled, true);
  assert.equal(byTestId(render({ isOwner: false }), "amux-worker-capability-import").length, 0);
  const unread = render({ view: null });
  assert.equal(byTestId(unread, "amux-worker-capability-unavailable").length, 1);
  assert.equal(byTestId(unread, "amux-worker-capability-import-run").length, 0);
});

const FAILURE = { kind: "failure", message: "failed" } as unknown as AdminApiFailure;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const receipt = (entry: AmuxWorkerCapabilityImport) =>
  json(200, { workerName: entry.workerName, revision: entry.expectedRevision + 1, action: "amux.worker.capability", eventId: "e-1" });
const IMPORTS = amuxWorkerCapabilityImportsToWrite(VIEW);

const runWith = async (answers: Array<(entry: AmuxWorkerCapabilityImport) => Promise<Response>>, readResult: AmuxWorkerCapabilityAdminView | null) => {
  const updates: AmuxWorkerCapabilityUpdate[] = [];
  const posted: string[] = [];
  let reads = 0;
  const io: AmuxWorkerCapabilityIo = {
    post: async (entry) => {
      posted.push(entry.workerName);
      const answer = answers[posted.length - 1] ?? ((sent: AmuxWorkerCapabilityImport) => Promise.resolve(receipt(sent)));
      return answer(entry);
    },
    read: async () => {
      reads += 1;
      return readResult;
    },
    failureOf: async () => FAILURE,
    networkFailure: () => FAILURE,
  };
  await runAmuxWorkerCapabilityImport(IMPORTS, io, (changes) => updates.push(changes));
  const last = <K extends keyof AmuxWorkerCapabilityUpdate>(key: K) => [...updates].reverse().find((changes) => key in changes)?.[key];
  return { posted, reads, last };
};

test("each import is sent once with its receipt checked, then read back", async () => {
  const { posted, reads, last } = await runWith([], VIEW);
  assert.deepEqual(posted, IMPORTS.map((entry) => entry.workerName));
  assert.equal(reads, 1);
  assert.equal(last("notice"), "done");
});

for (const [label, answer] of [
  ["a receipt at the wrong revision", (entry: AmuxWorkerCapabilityImport) => Promise.resolve(json(200, { workerName: entry.workerName, revision: entry.expectedRevision + 2, action: "amux.worker.capability", eventId: "e" }))],
  ["a receipt for another action", (entry: AmuxWorkerCapabilityImport) => Promise.resolve(json(200, { workerName: entry.workerName, revision: entry.expectedRevision + 1, action: "amux.worker.register", eventId: "e" }))],
  ["an empty body", () => Promise.resolve(json(200, {}))],
  ["an unknown outcome", () => Promise.resolve(json(503, { error: "outcome_unknown" }))],
  ["no answer", () => Promise.reject(new TypeError("fetch failed"))],
] as const) {
  test(`${label}: the outcome is unknown and nothing more is sent`, async () => {
    const { posted, reads, last } = await runWith([answer], VIEW);
    assert.equal(posted.length, 1);
    assert.equal(reads, 1);
    assert.equal(last("notice"), "outcome_unknown");
  });
}

test("a refusal by the ceiling rule, the latch or a stale revision stops on that worker", async () => {
  for (const code of ["tag_above_ceiling", "capability_writes_off", "stale_revision"]) {
    const { posted, last } = await runWith([() => Promise.resolve(json(409, { error: code }))], VIEW);
    assert.equal(posted.length, 1, code);
    assert.equal(last("notice"), "stopped", code);
    assert.deepEqual(last("refusal"), { workerName: IMPORTS[0]!.workerName, code });
  }
  const stale = await runWith([() => Promise.resolve(json(428, { code: "ADMIN_REAUTHENTICATION_REQUIRED" }))], VIEW);
  assert.equal(stale.last("failure"), FAILURE);
  const unread = await runWith([], null);
  assert.equal(unread.last("notice"), "unread");
});
