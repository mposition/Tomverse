import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import {
  AmuxCliModelIssueChips,
  AmuxWorkerCapabilityEditor,
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
import { AMUX_WORKER_REGISTRY_V31_SEED } from "@/lib/amux/workerRegistryCore";
import { amuxWorkerCapabilityFormFromRow, type AmuxWorkerCapabilityForm } from "@/lib/amux/workerCapabilityEditCore";
import { buildAmuxCliModelCatalogAdminView } from "@/lib/amux/cliModelCatalogCore";

// The fixtures' names start with their CLI; the registry no longer reads it from them.
const amuxWorkerProviderClassOf = (name: string) =>
  name.slice(0, name.indexOf("-")) as import("@/lib/amux/workerRegistryCore").AmuxWorkerProviderClass;


/**
 * The capability editor of AMUX › Operations settings › Workers (orchestration
 * policy version 35, R2a), executed: the editor is walked, and the
 * single-change run behind an edit is driven with a fake io. What it offers
 * and when it stops. The catalog variables are not read (R2e).
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

const IMPL_ROW = VIEW.rows.find((row) => row.workerName === "claude-impl")!;
const CATALOG = buildAmuxCliModelCatalogAdminView({
  observed: [],
  links: [],
  registry: [
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", apiModel: "claude-sonnet-5", provider: "anthropic",
      catalogDeleted: false, enabled: true, status: "enabled", replacementModelId: null },
    { id: "claude-opus-5", name: "Claude Opus 5", apiModel: "claude-opus-5", provider: "anthropic",
      catalogDeleted: true, enabled: true, status: "enabled", replacementModelId: "claude-sonnet-5" },
  ],
});
const renderEditor = (form: AmuxWorkerCapabilityForm, row = IMPL_ROW, cliModels: typeof CATALOG | null = CATALOG) => {
  const saved: AmuxWorkerCapabilityForm[] = [];
  const tree = AmuxWorkerCapabilityEditor({
    m, row, form, busy: false, writesLatch: true, cliModels,
    onChange: () => {}, onCancel: () => {}, onSave: (sent) => saved.push(sent),
  });
  return { tree, saved };
};

test("the editor is a role, one model and whether AMUX hands it Tasks, and holds what the store would refuse", () => {
  const blank = amuxWorkerCapabilityFormFromRow(IMPL_ROW);
  // Only the presets this worker's ceiling allows are offered.
  const preset = byTestId(renderEditor(blank).tree, "amux-worker-capability-edit-preset")[0]!;
  assert.deepEqual(propsOf(preset.children as ReactNode).filter((props) => "value" in props).map((props) => props.value), ["chore", "impl"]);
  // No free tag, tool or role inputs remain.
  assert.equal(byTestId(renderEditor(blank).tree, "amux-worker-capability-edit-tools").length, 0);
  // A Claude worker's model is chosen from the usable Anthropic models of Admin › Models.
  const select = byTestId(renderEditor(blank).tree, "amux-worker-capability-edit-model")[0]!;
  assert.deepEqual(propsOf(select.children as ReactNode).filter((props) => "value" in props).map((props) => props.value), ["", "claude-sonnet-5"]);
  const refused = renderEditor({ ...blank, model: "gpt-6-luna", oneShot: true }).tree;
  assert.match(textOf(byTestId(refused, "amux-worker-capability-edit-refusal")[0]!.children as ReactNode), /v22_model_unsupported/);
  assert.equal(byTestId(refused, "amux-worker-capability-edit-save")[0]!.disabled, true);
  const fine = { ...blank, model: "claude-sonnet-5", oneShot: true };
  const { tree, saved } = renderEditor(fine);
  assert.equal(byTestId(tree, "amux-worker-capability-edit-refusal").length, 0);
  assert.equal(byTestId(tree, "amux-worker-capability-edit-save")[0]!.disabled, false);
  assert.match(textOf(byTestId(tree, "amux-worker-capability-edit-preview")[0]!.children as ReactNode), /tools: repo_read, repo_write, test_run/);
  const form = propsOf(tree).find((props) => props["data-testid"] === "amux-worker-capability-editor")!;
  (form.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
  assert.deepEqual(saved, [fine]);
  // With no catalog the model is typed.
  assert.equal(byTestId(renderEditor(blank, IMPL_ROW, null).tree, "amux-worker-capability-edit-model")[0]!.maxLength, 160);
});

test("a retired model shows its chip with the replacement Admin › Models names", () => {
  const retired = { ...amuxWorkerCapabilityFormFromRow(IMPL_ROW), model: "claude-opus-5" };
  const props = propsOf(renderEditor(retired).tree).find((candidate) => "cliModels" in candidate && candidate.model === "claude-opus-5")!;
  const chips = AmuxCliModelIssueChips(props as Parameters<typeof AmuxCliModelIssueChips>[0]);
  assert.ok(byTestId(chips, "amux-cli-model-issue-retired")[0], "the chip is shown");
  assert.match(textOf(chips), /Retired in Tomverse · use Claude Sonnet 5/);
  // A usable model shows no chip.
  assert.equal(AmuxCliModelIssueChips({ m, cliModels: CATALOG, cli: "claude", model: "claude-sonnet-5" }), null);
});

test("an edit is one change against the recorded revision, receipt-checked and read back", async () => {
  const recorded = buildAmuxWorkerCapabilityAdminView({
    registrations: REGISTRY,
    current: new Map([["codex-impl", { revision: 3, capability: { model: null, routingTags: ["implementation"], toolCapabilities: [], v22: null }, changedAt: "2026-10-13T00:00:00.000Z" }]]),
    writesLatch: true,
  });
  const row = recorded.rows.find((candidate) => candidate.workerName === "codex-impl")!;
  const form = { ...amuxWorkerCapabilityFormFromRow(row), model: "gpt-6.1-sol", oneShot: true };
  const posted: AmuxWorkerCapabilityImport[] = [];
  const io = (answer: (entry: AmuxWorkerCapabilityImport) => Response): AmuxWorkerCapabilityIo => ({
    post: async (entry) => { posted.push(entry); return answer(entry); },
    read: async () => recorded,
    failureOf: async () => FAILURE,
    networkFailure: () => FAILURE,
  });
  assert.equal(await runAmuxWorkerCapabilityEdit(row, form, io(receipt), () => {}), true);
  assert.deepEqual(posted, [{ workerName: "codex-impl", expectedRevision: 3, capability: {
    model: "gpt-6.1-sol",
    routingTags: ["bugfix", "implementation", "integration", "multi_file", "tests"],
    toolCapabilities: ["repo_read", "repo_write", "test_run"],
    v22: { model: "gpt-6.1-sol", roles: ["implement", "investigate"], tools: ["repo_read", "repo_write"] },
  } }]);
  assert.equal(await runAmuxWorkerCapabilityEdit(row, form, io(() => json(409, { error: "stale_revision" })), () => {}), false);
  assert.equal(await runAmuxWorkerCapabilityEdit(row, form, io(() => json(503, { error: "outcome_unknown" })), () => {}), false);
  assert.equal(posted.length, 3);
});

test("with no listed names for its CLI, the model stays a text input while it is typed", () => {
  // Review r-20261027-041021-42cb25: a lone current value is not a choice.
  const copilot = VIEW.rows.find((row) => row.workerName === "copilot-impl")!;
  for (const model of ["", "k", "kimi-k3"]) {
    const form = { ...amuxWorkerCapabilityFormFromRow(copilot), model };
    const input = byTestId(renderEditor(form, copilot).tree, "amux-worker-capability-edit-model")[0]!;
    assert.equal(input.maxLength, 160, model);
    assert.equal(input.value, model);
  }
});
