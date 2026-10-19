import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import {
  AmuxWorkerCapabilityEditor,
  AmuxWorkerCapabilityView,
  runAmuxWorkerCapabilityEdit,
  runAmuxWorkerCapabilityImport,
  type AmuxWorkerCapabilityImport,
  type AmuxWorkerCapabilityIo,
  type AmuxWorkerCapabilityUpdate,
} from "@/components/admin/AmuxWorkerCapabilityPanel";
import type { AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminAmuxWorkerCapabilityMessages } from "@/lib/adminMessages/amuxWorkerCapability";
import {
  buildAmuxWorkerCapabilityAdminView,
  type AmuxWorkerCapabilityAdminView,
} from "@/lib/amux/workerCapabilityCore";
import { AMUX_WORKER_REGISTRY_V31_SEED, amuxWorkerProviderClassOf } from "@/lib/amux/workerRegistryCore";
import { amuxWorkerCapabilityFormFromRow, type AmuxWorkerCapabilityForm } from "@/lib/amux/workerCapabilityEditCore";

/**
 * AMUX › Execution › Workers, capabilities (orchestration policy version 35,
 * R2a), executed: the hook-free view is walked, and the single-change run
 * behind an edit is driven with a fake io. What it offers, to whom, and when
 * it stops. The catalog variables are not read (R2e).
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
const VIEW = buildAmuxWorkerCapabilityAdminView({ registrations: REGISTRY, current: new Map(), writesLatch: true });

const render = (overrides: Partial<{ view: AmuxWorkerCapabilityAdminView | null; isOwner: boolean }> = {}) =>
  AmuxWorkerCapabilityView({
    m,
    view: "view" in overrides ? overrides.view! : VIEW,
    isOwner: overrides.isOwner ?? true,
    pending: null,
    notice: null,
    refusal: null,
    failure: null,
    onReread: () => {},
  });

test("each registered worker is listed with what is recorded; nothing comes from the catalog variables", () => {
  const tree = render();
  assert.equal(byTestId(tree, "amux-worker-capability-import").length, 0);
  assert.equal(byTestId(tree, "amux-worker-capability-import-run").length, 0);
  assert.equal(byTestId(tree, "amux-worker-capability-catalog-unreadable").length, 0);
  for (const row of VIEW.rows) {
    assert.equal(byTestId(tree, `amux-worker-capability-row-${row.workerName}`).length, 1, row.workerName);
  }
  assert.match(textOf(byTestId(tree, "amux-worker-capability-row-claude-chore")[0]!.children as ReactNode), /none/);
});

test("an unread view offers only reading again", () => {
  const unread = render({ view: null });
  assert.equal(byTestId(unread, "amux-worker-capability-unavailable").length, 1);
  assert.equal(byTestId(unread, "amux-worker-capability-reread").length, 1);
  assert.equal(byTestId(unread, "amux-worker-capability-edit-claude-chore").length, 0);
});

const FAILURE = { kind: "failure", message: "failed" } as unknown as AdminApiFailure;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const receipt = (entry: AmuxWorkerCapabilityImport) =>
  json(200, { workerName: entry.workerName, revision: entry.expectedRevision + 1, action: "amux.worker.capability", eventId: "e-1" });
const capabilityOf = (tag: string) => ({ model: null, routingTags: [tag], toolCapabilities: [], v22: null });
const IMPORTS: AmuxWorkerCapabilityImport[] = [
  { workerName: "claude-chore", expectedRevision: 0, capability: capabilityOf("chore") },
  { workerName: "claude-impl", expectedRevision: 0, capability: capabilityOf("implementation") },
  { workerName: "codex-impl", expectedRevision: 0, capability: capabilityOf("implementation") },
];

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

test("the preview shows the tools, so a tools-only change is visible", () => {
  const view = buildAmuxWorkerCapabilityAdminView({
    registrations: REGISTRY,
    current: new Map([["codex-impl", { revision: 1, capability: { model: null, routingTags: ["implementation"], toolCapabilities: ["shell"], v22: null }, changedAt: "2026-10-13T00:00:00.000Z" }]]),
    writesLatch: true,
  });
  const tree = render({ view });
  const row = byTestId(tree, "amux-worker-capability-row-codex-impl")[0]!;
  assert.match(textOf(row.children as ReactNode), /tools: shell/);
});

// Version 35 R2a, "Admin 편집" (version 36): the owner edits one worker's
// capability in the Workers tab; the save is a single audited change.

const CHORE_ROW = VIEW.rows.find((row) => row.workerName === "claude-chore")!;
const renderEditing = (editing: AmuxWorkerCapabilityForm | null, overrides: Partial<{ isOwner: boolean; view: AmuxWorkerCapabilityAdminView }> = {}) => {
  const started: string[] = [];
  const tree = AmuxWorkerCapabilityView({
    m,
    view: overrides.view ?? VIEW,
    isOwner: overrides.isOwner ?? true,
    pending: null,
    notice: null,
    refusal: null,
    failure: null,
    onReread: () => {},
    editing,
    onEditStart: (row) => started.push(row.workerName),
  });
  return { tree, started };
};

test("the owner gets an edit control per worker; a non-owner none; latched off or mid-edit, it is held", () => {
  const { tree, started } = renderEditing(null);
  const button = byTestId(tree, "amux-worker-capability-edit-cursor-impl")[0]!;
  assert.equal(button.disabled, false);
  assert.equal(button["aria-label"], m.editLabel("cursor-impl"));
  (button.onClick as () => void)();
  assert.deepEqual(started, ["cursor-impl"]);
  assert.equal(byTestId(renderEditing(null, { isOwner: false }).tree, "amux-worker-capability-edit-cursor-impl").length, 0);
  assert.equal(byTestId(renderEditing(null, { view: { ...VIEW, writesLatch: false } }).tree, "amux-worker-capability-edit-cursor-impl")[0]!.disabled, true);
  const mid = renderEditing(amuxWorkerCapabilityFormFromRow(CHORE_ROW)).tree;
  assert.equal(byTestId(mid, "amux-worker-capability-edit-cursor-impl")[0]!.disabled, true);
  const editor = propsOf(mid).find((props) => props.form !== undefined && props.row !== undefined)!;
  assert.equal((editor.row as { workerName: string }).workerName, "claude-chore");
});

const renderEditor = (form: AmuxWorkerCapabilityForm, row = CHORE_ROW, busy = false) => {
  const saved: AmuxWorkerCapabilityForm[] = [];
  const tree = AmuxWorkerCapabilityEditor({
    m, row, form, busy, writesLatch: true,
    onChange: () => {}, onCancel: () => {}, onSave: (sent) => saved.push(sent),
  });
  return { tree, saved };
};

test("the editor says why the store would refuse before sending, and holds the save", () => {
  const blank = amuxWorkerCapabilityFormFromRow(CHORE_ROW);
  assert.equal(byTestId(renderEditor(blank).tree, "amux-worker-capability-edit-save")[0]!.disabled, true);
  const above = { ...blank, routingTags: ["implementation"] };
  const refused = renderEditor(above).tree;
  assert.match(textOf(byTestId(refused, "amux-worker-capability-edit-refusal")[0]!.children as ReactNode), /tag_above_ceiling/);
  assert.equal(byTestId(refused, "amux-worker-capability-edit-save")[0]!.disabled, true);
  const fine = { ...blank, routingTags: ["chore"], tools: "shell, git" };
  const { tree, saved } = renderEditor(fine);
  assert.equal(byTestId(tree, "amux-worker-capability-edit-refusal").length, 0);
  assert.equal(byTestId(tree, "amux-worker-capability-edit-save")[0]!.disabled, false);
  assert.match(textOf(byTestId(tree, "amux-worker-capability-edit-preview")[0]!.children as ReactNode), /tools: git, shell/);
  const form = propsOf(tree).find((props) => props["data-testid"] === "amux-worker-capability-editor")!;
  (form.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
  assert.deepEqual(saved, [fine]);
});

test("an edit is one change against the recorded revision, receipt-checked and read back", async () => {
  const recorded = buildAmuxWorkerCapabilityAdminView({
    registrations: REGISTRY,
    current: new Map([["codex-impl", { revision: 3, capability: { model: null, routingTags: ["implementation"], toolCapabilities: [], v22: null }, changedAt: "2026-10-13T00:00:00.000Z" }]]),
    writesLatch: true,
  });
  const row = recorded.rows.find((candidate) => candidate.workerName === "codex-impl")!;
  const form = { ...amuxWorkerCapabilityFormFromRow(row), tools: "shell" };
  const posted: AmuxWorkerCapabilityImport[] = [];
  const io = (answer: (entry: AmuxWorkerCapabilityImport) => Response): AmuxWorkerCapabilityIo => ({
    post: async (entry) => { posted.push(entry); return answer(entry); },
    read: async () => recorded,
    failureOf: async () => FAILURE,
    networkFailure: () => FAILURE,
  });
  assert.equal(await runAmuxWorkerCapabilityEdit(form, io(receipt), () => {}), true);
  assert.deepEqual(posted, [{ workerName: "codex-impl", expectedRevision: 3, capability: { model: null, routingTags: ["implementation"], toolCapabilities: ["shell"], v22: null } }]);
  assert.equal(await runAmuxWorkerCapabilityEdit(form, io(() => json(409, { error: "stale_revision" })), () => {}), false);
  assert.equal(await runAmuxWorkerCapabilityEdit(form, io(() => json(503, { error: "outcome_unknown" })), () => {}), false);
  assert.equal(posted.length, 3);
});
