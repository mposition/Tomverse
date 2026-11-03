import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import {
  AmuxWorkersOverviewView,
  amuxWorkerAgeText,
  amuxWorkerReasonText,
} from "@/components/admin/AmuxWorkersOverview";
import { adminAmuxWorkerCapabilityMessages } from "@/lib/adminMessages/amuxWorkerCapability";
import { adminAmuxWorkersMessages } from "@/lib/adminMessages/amuxWorkers";
import { buildAmuxWorkerCapabilityAdminView } from "@/lib/amux/workerCapabilityCore";
import { amuxWorkerCapabilityFormFromRow } from "@/lib/amux/workerCapabilityEditCore";
import {
  buildAmuxWorkerOverview,
  type AmuxWorkerOverview,
  type AmuxWorkerOverviewFilter,
} from "@/lib/amux/workerOverviewCore";
import {
  AMUX_WORKER_REGISTRY_V31_SEED,
  buildAmuxWorkerRegistryAdminView,
} from "@/lib/amux/workerRegistryCore";

// The fixtures' names start with their CLI; the registry no longer reads it from them.
const amuxWorkerProviderClassOf = (name: string) =>
  name.slice(0, name.indexOf("-")) as import("@/lib/amux/workerRegistryCore").AmuxWorkerProviderClass;


/**
 * AMUX › Operations settings › Workers, executed: the hook-free view is called
 * and the element tree it returns is walked, as the other client render tests
 * do. What it shows, what it offers to whom, and that it never prints an
 * internal code or a build-stage name.
 */

const m = adminAmuxWorkersMessages.en;
const ko = adminAmuxWorkersMessages.ko;
const cm = adminAmuxWorkerCapabilityMessages.en;

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

const NOW = Date.parse("2026-10-20T04:00:00.000Z");
const reg = (workerName: string, desiredState: "requested" | "active" | "paused" | "retired", roleCeiling: "chore" | "implementation" | "contract" = "implementation") => ({
  workerName,
  providerClass: amuxWorkerProviderClassOf(workerName)!,
  roleCeiling,
  desiredState,
  revision: 1,
  changedAt: "2026-10-13T08:52:00.000Z",
});

const REGISTRATIONS = [
  reg("claude-chore", "active", "chore"),
  reg("codex-impl", "active"),
  reg("cursor-impl", "requested"),
  reg("copilot-impl", "paused"),
  reg("copilot-chore", "retired", "chore"),
];
const REGISTRY = buildAmuxWorkerRegistryAdminView({ registrations: REGISTRATIONS, latches: new Map(), observations: new Map(), writesLatch: true });
const CAPABILITIES = buildAmuxWorkerCapabilityAdminView({
  registrations: REGISTRATIONS,
  current: new Map([
    ["codex-impl", { revision: 1, changedAt: "2026-10-14T00:00:00.000Z", capability: { model: "gpt-5-3-codex", routingTags: ["implementation", "tests"], toolCapabilities: [], v22: null } }],
  ]),
  writesLatch: true,
});
const LIVE = {
  kind: "observed" as const,
  catalogConfigured: true,
  workers: [
    { name: "claude-chore", provider: "anthropic", state: "lost" as const, heartbeatAt: new Date(NOW - 600_000).toISOString() },
    { name: "codex-impl", provider: "openai", state: "ready" as const, heartbeatAt: new Date(NOW - 12_000).toISOString() },
  ],
};
const OVERVIEW = buildAmuxWorkerOverview({ registry: REGISTRY, capabilities: CAPABILITIES, live: LIVE, nowMs: NOW })!;

type Overrides = Partial<{
  overview: AmuxWorkerOverview | null;
  isOwner: boolean;
  writesLatch: boolean;
  filter: AmuxWorkerOverviewFilter;
  query: string;
  openWorker: string | null;
  pending: Parameters<typeof AmuxWorkersOverviewView>[0]["pending"];
  notice: Parameters<typeof AmuxWorkersOverviewView>[0]["notice"];
  lastRun: "seed" | "change" | null;
  changeWorker: string | null;
  refusal: { workerName: string; code: string } | null;
  seedEntries: Parameters<typeof AmuxWorkersOverviewView>[0]["seedEntries"];
  editing: Parameters<typeof AmuxWorkersOverviewView>[0]["editing"];
  copied: boolean;
  calls: Record<string, unknown[]>;
}>;

const render = (overrides: Overrides = {}) => {
  const calls = overrides.calls ?? {};
  const record = (name: string) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };
  return AmuxWorkersOverviewView({
    m,
    cm,
    overview: "overview" in overrides ? overrides.overview! : OVERVIEW,
    isOwner: overrides.isOwner ?? true,
    writesLatch: overrides.writesLatch ?? true,
    filter: overrides.filter ?? "all",
    query: overrides.query ?? "",
    openWorker: overrides.openWorker ?? null,
    pending: overrides.pending ?? null,
    notice: overrides.notice ?? null,
    lastRun: overrides.lastRun ?? null,
    changeWorker: overrides.changeWorker ?? null,
    refusal: overrides.refusal ?? null,
    failure: null,
    seedEntries: overrides.seedEntries ?? null,
    editing: overrides.editing ?? null,
    capabilityBusy: false,
    capabilityNotice: null,
    capabilityRefusal: null,
    capabilityFailure: null,
    copied: overrides.copied ?? false,
    onFilter: record("filter"),
    onQuery: record("query"),
    onOpen: record("open"),
    onAction: record("action"),
    onSeed: record("seed"),
    onReread: record("reread"),
    onEditStart: record("editStart"),
    onEditChange: record("editChange"),
    onEditCancel: record("editCancel"),
    onEditSave: record("editSave"),
    onCopy: record("copy"),
  });
};

test("an unreadable registry shows no list, only reading again", () => {
  const tree = render({ overview: null });
  assert.equal(byTestId(tree, "amux-workers-unavailable").length, 1);
  assert.equal(byTestId(tree, "amux-workers-reread").length, 1);
  assert.equal(byTestId(tree, "amux-workers-table-scroll").length, 0);
});

test("three summary cards count the groups, and a card selects its group", () => {
  const calls: Record<string, unknown[]> = {};
  const tree = render({ calls });
  assert.equal(textOf(byTestId(tree, "amux-workers-card-assignable-count")[0]!.children as ReactNode), "1");
  assert.equal(textOf(byTestId(tree, "amux-workers-card-attention-count")[0]!.children as ReactNode), "1");
  assert.equal(textOf(byTestId(tree, "amux-workers-card-waiting-count")[0]!.children as ReactNode), "1");
  const attention = byTestId(tree, "amux-workers-card-attention")[0]!;
  assert.match(textOf(attention.children as ReactNode), /claude-chore — Connection lost/);
  (attention.onClick as () => void)();
  assert.deepEqual(calls.filter, [["attention"]]);
  // A second press on the active card goes back to the whole list.
  const pressed = byTestId(render({ filter: "attention" }), "amux-workers-card-attention")[0]!;
  assert.equal(pressed["aria-pressed"], true);
  (pressed.onClick as () => void)();
});

test("the table puts what needs a look first and omits the kept workers by default", () => {
  const tree = render();
  const groups = propsOf(tree).map((props) => String(props["data-testid"] ?? "")).filter((id) => id.startsWith("amux-workers-group-"));
  assert.deepEqual(groups, ["amux-workers-group-attention", "amux-workers-group-assignable", "amux-workers-group-waiting", "amux-workers-group-paused"]);
  assert.equal(byTestId(tree, "amux-worker-row-copilot-chore").length, 0);
  assert.equal(byTestId(render({ filter: "retired" }), "amux-worker-row-copilot-chore").length, 1);
});

test("each row says its status and one sentence of why, without internal codes", () => {
  const tree = render();
  assert.equal(textOf(byTestId(tree, "amux-worker-status-codex-impl")[0]!.children as ReactNode).trim(), m.status.assignable_ready);
  assert.equal(textOf(byTestId(tree, "amux-worker-reason-codex-impl")[0]!.children as ReactNode), "Last signal 12 s ago · no work in progress");
  assert.match(textOf(byTestId(tree, "amux-worker-reason-claude-chore")[0]!.children as ReactNode), /bridge connection dropped \(last signal 10 min ago\)/);
  assert.match(textOf(byTestId(tree, "amux-worker-reason-cursor-impl")[0]!.children as ReactNode), /Registered only\. Turn it on/);
  assert.match(textOf(byTestId(tree, "amux-worker-reason-copilot-impl")[0]!.children as ReactNode), /Paused\. Turn it back on/);
  // The same sentence in Korean, from the same row.
  const row = OVERVIEW.rows.find((candidate) => candidate.workerName === "codex-impl")!;
  assert.equal(amuxWorkerReasonText(ko, row), "마지막 신호 12초 전 · 진행 중인 작업 없음");
  assert.equal(amuxWorkerAgeText(m, null), null);
  assert.equal(amuxWorkerAgeText(ko, 59), "59초 전");
  assert.equal(amuxWorkerAgeText(ko, 3600), "1시간 전");
  assert.equal(amuxWorkerAgeText(ko, 86_400 * 3), "3일 전");
});

test("a row's capability chips show the recorded model and tags; a missing record says so", () => {
  const tree = render();
  const row = byTestId(tree, "amux-worker-row-codex-impl")[0]!;
  const text = textOf(row.children as ReactNode);
  assert.match(text, /gpt-5-3-codex/);
  assert.match(text, /implementation/);
  assert.match(text, /tests/);
  assert.match(textOf(byTestId(tree, "amux-worker-row-cursor-impl")[0]!.children as ReactNode), new RegExp(m.noCapability));
});

test("the owner is offered the change that fits each state, plus details; nothing for a kept worker", () => {
  const calls: Record<string, unknown[]> = {};
  const tree = render({ calls });
  assert.equal(byTestId(tree, "amux-worker-activate-cursor-impl").length, 1);
  assert.equal(byTestId(tree, "amux-worker-pause-codex-impl").length, 1);
  assert.equal(byTestId(tree, "amux-worker-pause-claude-chore").length, 1);
  assert.equal(byTestId(tree, "amux-worker-resume-copilot-impl").length, 1);
  assert.equal(byTestId(tree, "amux-worker-activate-codex-impl").length, 0);
  const activate = byTestId(tree, "amux-worker-activate-cursor-impl")[0]!;
  assert.equal(activate["aria-label"], m.actions.activateLabel("cursor-impl"));
  (activate.onClick as () => void)();
  assert.equal(calls.action!.length, 1);
  assert.equal((calls.action![0] as [{ workerName: string }, string])[0].workerName, "cursor-impl");
  assert.equal((calls.action![0] as [unknown, string])[1], "activate");
  const details = byTestId(tree, "amux-worker-details-codex-impl")[0]!;
  (details.onClick as () => void)();
  assert.deepEqual(calls.open, [["codex-impl"]]);
  const retiredTree = render({ filter: "retired" });
  assert.equal(byTestId(retiredTree, "amux-worker-details-copilot-chore").length, 1);
  assert.equal(propsOf(retiredTree).filter((props) => /^amux-worker-(activate|pause|resume)-/.test(String(props["data-testid"] ?? ""))).length, 0);
});

test("a non-owner, or a build with the code latch off, is offered details only", () => {
  for (const overrides of [{ isOwner: false }, { writesLatch: false }] as const) {
    const tree = render(overrides);
    const changes = propsOf(tree).filter((props) => /^amux-worker-(activate|pause|resume)-/.test(String(props["data-testid"] ?? "")));
    assert.equal(changes.length, 0, JSON.stringify(overrides));
    assert.equal(byTestId(tree, "amux-worker-details-codex-impl").length, 1);
  }
  assert.equal(byTestId(render({ isOwner: false }), "amux-workers-read-only").length, 1);
  assert.equal(byTestId(render({ writesLatch: false }), "amux-workers-writes-off").length, 1);
});

test("while one change is in flight every change control is held, and the worker's own says so", () => {
  const tree = render({ pending: { done: 0, total: 1 }, lastRun: "change", changeWorker: "cursor-impl" });
  const activate = byTestId(tree, "amux-worker-activate-cursor-impl")[0]!;
  assert.equal(activate.disabled, true);
  assert.equal(textOf(activate.children as ReactNode), m.actions.working);
  assert.equal(byTestId(tree, "amux-worker-pause-codex-impl")[0]!.disabled, true);
  assert.equal(textOf(byTestId(tree, "amux-worker-pause-codex-impl")[0]!.children as ReactNode), m.actions.pause);
});

test("filters and the search say how many each shows, and an empty result says so", () => {
  const tree = render();
  assert.equal(textOf(byTestId(tree, "amux-workers-filter-all")[0]!.children as ReactNode).replace(/\s+/g, " ").trim(), "All 4");
  assert.equal(textOf(byTestId(tree, "amux-workers-filter-retired")[0]!.children as ReactNode).replace(/\s+/g, " ").trim(), "Kept 1");
  assert.equal(byTestId(render({ query: "nobody" }), "amux-workers-no-match").length, 1);
  assert.equal(byTestId(render({ query: "cursor" }), "amux-worker-row-codex-impl").length, 0);
  const empty = buildAmuxWorkerOverview({
    registry: buildAmuxWorkerRegistryAdminView({ registrations: [], latches: new Map(), observations: new Map(), writesLatch: true }),
    capabilities: buildAmuxWorkerCapabilityAdminView({ registrations: [], current: new Map(), writesLatch: true }),
    live: LIVE,
    nowMs: NOW,
  })!;
  assert.equal(byTestId(render({ overview: empty }), "amux-workers-empty").length, 1);
});

test("an unread live reading is said once, at the top", () => {
  const overview = buildAmuxWorkerOverview({ registry: REGISTRY, capabilities: CAPABILITIES, live: { kind: "unread" }, nowMs: NOW })!;
  const tree = render({ overview });
  assert.equal(byTestId(tree, "amux-workers-live-unread").length, 1);
  assert.equal(textOf(byTestId(tree, "amux-worker-status-codex-impl")[0]!.children as ReactNode).trim(), m.status.live_unread);
});

test("the drawer shows the live state, the process, the command, and the owner's edit and on-off controls", () => {
  const calls: Record<string, unknown[]> = {};
  const tree = render({ openWorker: "codex-impl", calls });
  assert.equal(byTestId(tree, "amux-worker-drawer").length, 1);
  assert.equal(textOf(byTestId(tree, "amux-worker-drawer-connection")[0]!.children as ReactNode), "Connected · last signal 12 s ago");
  assert.equal(textOf(byTestId(tree, "amux-worker-drawer-process")[0]!.children as ReactNode), "tomverse-amux-bridge@codex-impl");
  assert.equal(textOf(byTestId(tree, "amux-worker-drawer-command")[0]!.children as ReactNode), "sudo systemctl enable --now tomverse-amux-bridge@codex-impl.service");
  (byTestId(tree, "amux-worker-drawer-copy")[0]!.onClick as () => void)();
  assert.deepEqual(calls.copy, [["sudo systemctl enable --now tomverse-amux-bridge@codex-impl.service"]]);
  assert.equal(textOf(byTestId(render({ openWorker: "codex-impl", copied: true }), "amux-worker-drawer-copy")[0]!.children as ReactNode), m.drawer.copied);
  (byTestId(tree, "amux-worker-drawer-edit-capability")[0]!.onClick as () => void)();
  assert.equal((calls.editStart![0] as [{ workerName: string }])[0].workerName, "codex-impl");
  assert.equal(byTestId(tree, "amux-worker-pause-codex-impl").length, 2);
  (byTestId(tree, "amux-worker-drawer-close")[0]!.onClick as () => void)();
  assert.deepEqual(calls.open, [[null]]);
  assert.equal(byTestId(render({ openWorker: "ghost-worker" }), "amux-worker-drawer").length, 0);
});

test("the drawer's edit is the existing capability editor, for one worker at a time", () => {
  const row = OVERVIEW.rows.find((candidate) => candidate.workerName === "codex-impl")!;
  const form = amuxWorkerCapabilityFormFromRow(row.capability!);
  const tree = render({ openWorker: "codex-impl", editing: form });
  const editor = propsOf(tree).find((props) => props.form !== undefined && props.row !== undefined)!;
  assert.equal((editor.row as { workerName: string }).workerName, "codex-impl");
  assert.equal(byTestId(tree, "amux-worker-drawer-edit-capability").length, 0);
  // A form for another worker is not shown in this worker's drawer.
  const other = render({ openWorker: "claude-chore", editing: form });
  assert.equal(propsOf(other).some((props) => props.form !== undefined && props.row !== undefined), false);
});

test("a read-only viewer sees the drawer without edit or on-off controls", () => {
  const tree = render({ openWorker: "codex-impl", isOwner: false });
  assert.equal(byTestId(tree, "amux-worker-drawer-edit-capability").length, 0);
  assert.equal(byTestId(tree, "amux-worker-pause-codex-impl").length, 0);
  assert.equal(byTestId(tree, "amux-worker-drawer-read-only").length, 1);
});

test("a refused change is said in plain words, on the worker's own drawer", () => {
  const tree = render({
    openWorker: "cursor-impl",
    lastRun: "change",
    changeWorker: "cursor-impl",
    notice: "stopped",
    refusal: { workerName: "cursor-impl", code: "role_widening_requires_trial" },
  });
  const text = textOf(byTestId(tree, "amux-workers-refused")[0]!.children as ReactNode);
  assert.match(text, /cursor-impl: A wider role needs a new trial first\./);
  assert.match(text, /Nothing was changed\./);
  assert.doesNotMatch(text, /role_widening_requires_trial/);
  // Without the drawer the same sentence sits under the list.
  const closed = render({ lastRun: "change", changeWorker: "cursor-impl", notice: "stopped", refusal: { workerName: "cursor-impl", code: "stale_revision" } });
  assert.equal(byTestId(closed, "amux-workers-refused").length, 1);
});

test("an unknown outcome is said as an alert, and a done change names its worker", () => {
  const unknown = render({ lastRun: "change", changeWorker: "cursor-impl", notice: "outcome_unknown" });
  const alert = byTestId(unknown, "amux-workers-notice-outcome_unknown")[0]!;
  assert.equal(alert.role, "alert");
  assert.equal(textOf(alert.children as ReactNode), m.change.outcomeUnknown);
  const done = render({ lastRun: "change", changeWorker: "codex-impl", notice: "done" });
  assert.equal(textOf(byTestId(done, "amux-workers-done")[0]!.children as ReactNode), m.change.done("codex-impl"));
});

test("the first-registration control is folded away, offered to the owner only while something is left", () => {
  const calls: Record<string, unknown[]> = {};
  const entries = AMUX_WORKER_REGISTRY_V31_SEED.slice(0, 3).map(({ workerName, providerClass, roleCeiling, desiredState }) => ({ workerName, providerClass, roleCeiling, desiredState }));
  const tree = render({ seedEntries: entries, calls });
  const details = byTestId(tree, "amux-workers-seed")[0]!;
  assert.equal(details["open"], undefined, "folded by default");
  const button = byTestId(tree, "amux-workers-seed-register")[0]!;
  assert.equal(textOf(button.children as ReactNode), m.seed.register(3));
  (button.onClick as () => void)();
  assert.deepEqual(calls.seed, [[entries]]);
  assert.equal(byTestId(render({ seedEntries: [] }), "amux-workers-seed").length, 0);
  assert.equal(byTestId(render({ seedEntries: null }), "amux-workers-seed").length, 0);
  assert.equal(byTestId(render({ seedEntries: entries, writesLatch: false }), "amux-workers-seed-register")[0]!.disabled, true);
  const running = render({ seedEntries: entries, pending: { done: 2, total: 3 }, lastRun: "seed" });
  assert.equal(textOf(byTestId(running, "amux-workers-seed-register")[0]!.children as ReactNode), m.seed.registering(2, 3));
});

test("no sentence on the screen names a policy version, a build stage or an internal refusal code", () => {
  const internal = /\bR[1-5][a-e]?\b|\bv3\d\b|\bversion \d+\b|policy version|stage R|role_widening_requires_trial|stale_revision|registry_writes_off|catalog_unknown|not_admitted/i;
  const texts: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === "string") texts.push(value);
    else if (typeof value === "function") {
      const fn = value as (...args: unknown[]) => unknown;
      texts.push(String(fn(...Array.from({ length: fn.length }, (_, index) => (index === 0 && fn.length > 1 ? "claude-impl" : "3 min ago")))));
    } else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(adminAmuxWorkersMessages.en);
  collect(adminAmuxWorkersMessages.ko);
  assert.ok(texts.length > 100);
  for (const text of texts) assert.doesNotMatch(text, internal, text);
});
