import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import {
  AMUX_CLI_MODEL_LINK_NONE,
  AmuxCliModelIssueChips,
  AmuxCliModelLinkForm,
  AmuxWorkerCapabilityEditor,
  amuxCliModelLinkOffered,
  runAmuxCliModelLink,
  type AmuxCliModelLinkChange,
  type AmuxCliModelLinkIo,
  type AmuxCliModelLinkUpdate,
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
import { amuxCliModelStatus, buildAmuxCliModelCatalogAdminView } from "@/lib/amux/cliModelCatalogCore";

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

// ---------------------------------------------------------------------------
// The price link: a CLI model name linked to the Admin › Models entry that
// prices it (owner decision 2026-10-27). The production case of 2026-11-10:
// the Cursor workers' names match no entry, so each is "no price".

const SEEN = "2026-11-10T00:00:00.000Z";
const cursorCatalog = (links: Array<{ cliModel: string; pricedModelId: string | null }> = []) =>
  buildAmuxCliModelCatalogAdminView({
    observed: ["auto", "composer-2.5", "grok-4.7-high"].map((cliModel) => ({
      cli: "cursor", cliModel, displayName: null, listed: true, lastSeenAt: SEEN,
    })),
    links: links.map((link) => ({ cli: "cursor" as const, ...link })),
    registry: [
      { id: "grok-4-7", name: "Grok 4.7", apiModel: "grok-4.7", provider: "xai",
        catalogDeleted: false, enabled: true, status: "enabled", replacementModelId: null },
      { id: "composer-2", name: "Composer 2", apiModel: "composer-2", provider: "cursor",
        catalogDeleted: false, enabled: false, status: "disabled", replacementModelId: null },
      { id: "grok-4-6", name: "Grok 4.6", apiModel: "grok-4.6", provider: "xai",
        catalogDeleted: true, enabled: true, status: "enabled", replacementModelId: "grok-4-7" },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", apiModel: "claude-sonnet-5", provider: "anthropic",
        catalogDeleted: false, enabled: true, status: "enabled", replacementModelId: null },
    ],
  });

const renderLink = (
  cliModels: ReturnType<typeof cursorCatalog>,
  cliModel: string,
  choice: string | null = null,
  extra: Partial<{ busy: boolean; writesLatch: boolean }> = {},
) => {
  const saved: AmuxCliModelLinkChange[] = [];
  const tree = AmuxCliModelLinkForm({
    m, cliModels, cli: "cursor", cliModel, choice,
    busy: extra.busy ?? false, writesLatch: extra.writesLatch ?? true,
    onChoose: () => {}, onSave: (change) => saved.push(change),
  });
  const submit = () => {
    const form = propsOf(tree).find((props) => props["data-testid"] === "amux-cli-model-link")!;
    (form.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
  };
  return { tree, saved, submit };
};
const optionValues = (tree: ReactNode) => {
  const select = byTestId(tree, "amux-cli-model-link-select")[0]!;
  return propsOf(select.children as ReactNode).filter((props) => "value" in props).map((props) => props.value);
};

test("each Cursor name with no price is offered the link form, with every entry not retired, the usable ones first", () => {
  const catalog = cursorCatalog();
  for (const cliModel of ["auto", "composer-2.5", "grok-4.7-high"]) {
    assert.deepEqual(amuxCliModelStatus(catalog, "cursor", cliModel).issues, ["unpriced"], cliModel);
    assert.equal(amuxCliModelLinkOffered(catalog, "cursor", cliModel), true, cliModel);
    const { tree } = renderLink(catalog, cliModel);
    // Unchosen first, the enabled entries, then the disabled one, then unlink; the retired one is not offered.
    assert.deepEqual(optionValues(tree), ["", "claude-sonnet-5", "grok-4-7", "composer-2", AMUX_CLI_MODEL_LINK_NONE]);
    assert.equal(textOf(byTestId(tree, "amux-cli-model-link-current")[0]!.children as ReactNode), m.link.currentNone);
    assert.equal(byTestId(tree, "amux-cli-model-link-save")[0]!.disabled, true, "nothing is chosen yet");
  }
  assert.match(textOf(byTestId(renderLink(catalog, "auto").tree, "amux-cli-model-link-select")[0]!.children as ReactNode), /Composer 2 \(composer-2\) · off/);
  // A priced, unlinked model is not offered the form.
  assert.equal(amuxCliModelLinkOffered(CATALOG, "claude", "claude-sonnet-5"), false);
  assert.equal(amuxCliModelLinkOffered(catalog, "cursor", null), false);
});

test("linking grok-4.7-high to Grok 4.7 sends one change, and once recorded the no-price chip is gone", () => {
  const { tree, saved, submit } = renderLink(cursorCatalog(), "grok-4.7-high", "grok-4-7");
  assert.equal(byTestId(tree, "amux-cli-model-link-save")[0]!.disabled, false);
  submit();
  assert.deepEqual(saved, [{ cli: "cursor", cliModel: "grok-4.7-high", pricedModelId: "grok-4-7" }]);
  // Held while busy or with writes off.
  for (const extra of [{ busy: true }, { writesLatch: false }]) {
    const held = renderLink(cursorCatalog(), "grok-4.7-high", "grok-4-7", extra);
    assert.equal(byTestId(held.tree, "amux-cli-model-link-save")[0]!.disabled, true);
    held.submit();
    assert.deepEqual(held.saved, []);
  }
  const linked = cursorCatalog([{ cliModel: "grok-4.7-high", pricedModelId: "grok-4-7" }]);
  assert.deepEqual(amuxCliModelStatus(linked, "cursor", "grok-4.7-high").issues, []);
  assert.equal(AmuxCliModelIssueChips({ m, cliModels: linked, cli: "cursor", model: "grok-4.7-high" }), null);
  // The form stays for a linked name, shows the link, and holds a save of the same value.
  assert.equal(amuxCliModelLinkOffered(linked, "cursor", "grok-4.7-high"), true);
  const again = renderLink(linked, "grok-4.7-high");
  assert.equal(textOf(byTestId(again.tree, "amux-cli-model-link-current")[0]!.children as ReactNode), "Linked now to Grok 4.7 (grok-4-7).");
  assert.equal(byTestId(again.tree, "amux-cli-model-link-select")[0]!.value, "grok-4-7");
  assert.equal(optionValues(again.tree).includes(""), false);
  assert.equal(byTestId(again.tree, "amux-cli-model-link-save")[0]!.disabled, true);
  // The others are still unpriced until linked.
  assert.deepEqual(amuxCliModelStatus(linked, "cursor", "auto").issues, ["unpriced"]);
});

test("unlinking sends a null price and says AMUX then hands it no Tasks", () => {
  const linked = cursorCatalog([{ cliModel: "composer-2.5", pricedModelId: "grok-4-7" }]);
  const { tree, saved, submit } = renderLink(linked, "composer-2.5", AMUX_CLI_MODEL_LINK_NONE);
  assert.equal(byTestId(tree, "amux-cli-model-link-none-help").length, 1);
  submit();
  assert.deepEqual(saved, [{ cli: "cursor", cliModel: "composer-2.5", pricedModelId: null }]);
  const held = cursorCatalog([{ cliModel: "composer-2.5", pricedModelId: null }]);
  const shown = renderLink(held, "composer-2.5");
  assert.equal(byTestId(shown.tree, "amux-cli-model-link-select")[0]!.value, AMUX_CLI_MODEL_LINK_NONE);
  assert.equal(textOf(byTestId(shown.tree, "amux-cli-model-link-current")[0]!.children as ReactNode), m.link.currentHeld);
  // A link to an entry retired since stays visible as what is recorded.
  const stale = cursorCatalog([{ cliModel: "auto", pricedModelId: "grok-4-6" }]);
  assert.equal(optionValues(renderLink(stale, "auto").tree).at(-2), "grok-4-6");
});

const LINK: AmuxCliModelLinkChange = { cli: "cursor", cliModel: "grok-4.7-high", pricedModelId: "grok-4-7" };
const linkReceipt = (change: AmuxCliModelLinkChange) =>
  json(200, { action: "amux.cli_model.link", eventId: "e-1", ...change });
const runLink = async (
  answer: (change: AmuxCliModelLinkChange) => Promise<Response>,
  readResult: AmuxWorkerCapabilityAdminView | null = VIEW,
) => {
  const updates: AmuxCliModelLinkUpdate[] = [];
  const posted: AmuxCliModelLinkChange[] = [];
  let reads = 0;
  const io: AmuxCliModelLinkIo = {
    post: async (change) => { posted.push(change); return answer(change); },
    read: async () => { reads += 1; return readResult; },
    failureOf: async () => FAILURE,
    networkFailure: () => FAILURE,
  };
  const saved = await runAmuxCliModelLink(LINK, io, (changes) => updates.push(changes));
  const last = <K extends keyof AmuxCliModelLinkUpdate>(key: K) => [...updates].reverse().find((changes) => key in changes)?.[key];
  return { saved, posted, reads, last };
};

test("a link is sent once, receipt-checked, and the catalog is read back", async () => {
  const done = await runLink((change) => Promise.resolve(linkReceipt(change)));
  assert.equal(done.saved, true);
  assert.deepEqual(done.posted, [LINK]);
  assert.equal(done.reads, 1);
  assert.equal(done.last("notice"), "done");
  assert.equal(done.last("view"), VIEW);
  assert.equal(done.last("pending"), false);
});

for (const [label, answer] of [
  ["a receipt for another name", () => Promise.resolve(linkReceipt({ ...LINK, cliModel: "auto" }))],
  ["a receipt with another price", () => Promise.resolve(linkReceipt({ ...LINK, pricedModelId: null }))],
  ["a receipt for another action", () => Promise.resolve(json(200, { ...LINK, action: "amux.worker.capability", eventId: "e" }))],
  ["an unknown outcome", () => Promise.resolve(json(503, { error: "outcome_unknown" }))],
  ["a gateway error", () => Promise.resolve(json(502, {}))],
  ["no answer", () => Promise.reject(new TypeError("fetch failed"))],
] as const) {
  test(`a link with ${label}: the outcome is unknown, it is read back and not sent again`, async () => {
    const { saved, posted, reads, last } = await runLink(answer);
    assert.equal(saved, false);
    assert.equal(posted.length, 1);
    assert.equal(reads, 1);
    assert.equal(last("notice"), "outcome_unknown");
  });
}

test("a refused link says why; a stale step-up or a failed write is a failure that wrote nothing", async () => {
  for (const code of ["model_not_found", "no_change", "capability_writes_off"] as const) {
    const { saved, posted, last } = await runLink(() => Promise.resolve(json(409, { error: code })));
    assert.equal(saved, false, code);
    assert.equal(posted.length, 1, code);
    assert.equal(last("notice"), "stopped", code);
    assert.equal(last("refusal"), code);
    assert.ok(m.link.refused[code], code);
  }
  for (const response of [
    () => json(428, { code: "ADMIN_REAUTHENTICATION_REQUIRED" }),
    () => json(403, { error: "Forbidden." }),
    () => json(503, { error: "cli_model_link_failed" }),
  ]) {
    const { last } = await runLink(() => Promise.resolve(response()));
    assert.equal(last("notice"), "stopped");
    assert.equal(last("failure"), FAILURE);
  }
  const unread = await runLink((change) => Promise.resolve(linkReceipt(change)), null);
  assert.equal(unread.saved, false);
  assert.equal(unread.last("notice"), "unread");
});

test("the link copy has the same keys in English and Korean", () => {
  const keys = (value: object): string[] => Object.entries(value).flatMap(([key, child]) =>
    child !== null && typeof child === "object" ? keys(child).map((sub) => `${key}.${sub}`) : [key]);
  assert.deepEqual(keys(adminAmuxWorkerCapabilityMessages.ko.link).sort(), keys(m.link).sort());
});
