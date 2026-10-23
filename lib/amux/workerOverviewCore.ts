import type { AgentOfficeAmuxState, AgentOfficeAmuxWorkerState } from "../agentOffice/live.ts";
import type { AmuxWorkerCapabilityAdminRow, AmuxWorkerCapabilityAdminView } from "./workerCapabilityCore.ts";
import type {
  AmuxWorkerDesiredState,
  AmuxWorkerProviderClass,
  AmuxWorkerRegistryAdminRow,
  AmuxWorkerRegistryAdminView,
  AmuxWorkerRoleCeiling,
} from "./workerRegistryCore.ts";

/**
 * AMUX › Operations settings › Workers: the one list an operator reads.
 *
 * Pure. It joins three reads that already exist -- the registry (what a person
 * asked for), the recorded capabilities (what each worker may do) and the live
 * reading of each worker's bridge (what is true now) -- into one row per
 * worker, with a group, a status, and the next thing a person can do. The
 * copy lives in `lib/adminMessages/amuxWorkers.ts`; this module names a
 * situation and never writes a sentence, so the words stay in both locales
 * and no internal code reaches the screen.
 *
 * Nothing here decides who may change a worker: the registry route does
 * (owner role, the stage latch, a recent step-up) and the change rule in
 * `workerRegistryCore.ts` can still refuse. `actions` only says which
 * change the row's desired state makes sense to offer.
 */

export const AMUX_WORKER_OVERVIEW_GROUPS = ["attention", "assignable", "waiting", "paused", "retired"] as const;
export type AmuxWorkerOverviewGroup = (typeof AMUX_WORKER_OVERVIEW_GROUPS)[number];

/** A filter chip: everything that is still in use, or one group. */
export type AmuxWorkerOverviewFilter = "all" | AmuxWorkerOverviewGroup;
export const AMUX_WORKER_OVERVIEW_FILTERS: readonly AmuxWorkerOverviewFilter[] = ["all", ...AMUX_WORKER_OVERVIEW_GROUPS];

/** The situation a row's status line describes; the screen turns it into a sentence. */
export const AMUX_WORKER_STATUS_KINDS = [
  "assignable_ready",
  "assignable_busy",
  "assignable_starting",
  "connection_lost",
  "bridge_error",
  "bridge_stopped",
  "bridge_not_started",
  "operator_excluded",
  "latch_open",
  "capability_missing",
  "not_in_assignment",
  "live_unread",
  "waiting_activation",
  "paused",
  "retired",
] as const;
export type AmuxWorkerStatusKind = (typeof AMUX_WORKER_STATUS_KINDS)[number];

export type AmuxWorkerStatusTone = "ok" | "attention" | "neutral";

/** A change the row's desired state makes sense to offer. */
export type AmuxWorkerOverviewAction = "activate" | "pause" | "resume";

export type AmuxWorkerOverviewRow = {
  workerName: string;
  providerClass: AmuxWorkerProviderClass;
  /** How a person says the provider: OpenAI, Anthropic, Cursor, GitHub Copilot. */
  providerLabel: string;
  /** `v22` when a one-shot profile is recorded, otherwise a resident session. */
  mode: "v22" | "session";
  roleCeiling: AmuxWorkerRoleCeiling;
  desiredState: AmuxWorkerDesiredState;
  revision: number;
  changedAt: string;
  group: AmuxWorkerOverviewGroup;
  status: AmuxWorkerStatusKind;
  tone: AmuxWorkerStatusTone;
  /** The live reading, or null when it could not be read. */
  live: AgentOfficeAmuxWorkerState | null;
  /** Seconds between the bridge's last signal and the read; null when it never signalled. */
  heartbeatAgeSeconds: number | null;
  model: string | null;
  routingTags: string[];
  /** The capability row the editor starts from; null when none is recorded. */
  capability: AmuxWorkerCapabilityAdminRow | null;
  actions: AmuxWorkerOverviewAction[];
};

export type AmuxWorkerProviderCount = { providerClass: AmuxWorkerProviderClass; count: number };

export type AmuxWorkerOverviewSummary = {
  total: number;
  assignable: { count: number; byProvider: AmuxWorkerProviderCount[] };
  attention: { count: number; sample: { workerName: string; status: AmuxWorkerStatusKind } | null };
  waiting: { count: number; byProvider: AmuxWorkerProviderCount[] };
  paused: number;
  retired: number;
};

export type AmuxWorkerOverview = {
  /** False when the live reading could not be made: no row claims to be connected. */
  liveReadable: boolean;
  /** False when the recorded capabilities could not be read: the editor is not offered. */
  capabilitiesReadable: boolean;
  rows: AmuxWorkerOverviewRow[];
  summary: AmuxWorkerOverviewSummary;
};

const PROVIDER_LABELS: Readonly<Record<AmuxWorkerProviderClass, string>> = Object.freeze({
  claude: "Anthropic",
  codex: "OpenAI",
  cursor: "Cursor",
  copilot: "GitHub Copilot",
});

export const amuxWorkerProviderLabel = (providerClass: AmuxWorkerProviderClass): string =>
  PROVIDER_LABELS[providerClass];

/** The status of a worker whose desired state is `active`, from its live reading. */
function activeStatus(
  live: AgentOfficeAmuxWorkerState | null,
  registryReasons: AmuxWorkerRegistryAdminRow["reasons"],
  /** False only when the capabilities were read and this worker has none recorded. */
  capabilityRecorded: boolean,
): AmuxWorkerStatusKind {
  if (live === null) return "live_unread";
  switch (live) {
    case "ready":
    case "idle":
      return "assignable_ready";
    case "busy":
      return "assignable_busy";
    case "starting":
      return "assignable_starting";
    case "lost":
      return "connection_lost";
    case "error":
      return "bridge_error";
    case "stopped":
      return "bridge_stopped";
    case "not_running":
      return "bridge_not_started";
    case "blocked":
    case "isolated":
    case "paused":
      return "operator_excluded";
    case "not_admitted":
    case "catalog_unknown":
      // The derived catalog leaves out an active worker with no recorded
      // capability, so say that and where to fix it, not just that it is out.
      return registryReasons.includes("latch_open") ? "latch_open"
        : capabilityRecorded ? "not_in_assignment" : "capability_missing";
  }
}

const STATUS_GROUP: Readonly<Record<AmuxWorkerStatusKind, AmuxWorkerOverviewGroup>> = Object.freeze({
  assignable_ready: "assignable",
  assignable_busy: "assignable",
  assignable_starting: "assignable",
  connection_lost: "attention",
  bridge_error: "attention",
  bridge_stopped: "attention",
  bridge_not_started: "attention",
  operator_excluded: "attention",
  latch_open: "attention",
  capability_missing: "attention",
  not_in_assignment: "attention",
  live_unread: "attention",
  waiting_activation: "waiting",
  paused: "paused",
  retired: "retired",
});

const toneOf = (group: AmuxWorkerOverviewGroup): AmuxWorkerStatusTone =>
  group === "assignable" ? "ok" : group === "attention" ? "attention" : "neutral";

const ACTIONS: Readonly<Record<AmuxWorkerDesiredState, AmuxWorkerOverviewAction[]>> = Object.freeze({
  requested: ["activate"],
  active: ["pause"],
  paused: ["resume"],
  retired: [],
});

const byProvider = (rows: readonly AmuxWorkerOverviewRow[]): AmuxWorkerProviderCount[] => {
  const counts = new Map<AmuxWorkerProviderClass, number>();
  for (const row of rows) counts.set(row.providerClass, (counts.get(row.providerClass) ?? 0) + 1);
  return [...counts.entries()]
    .map(([providerClass, count]) => ({ providerClass, count }))
    .sort((a, b) => b.count - a.count || a.providerClass.localeCompare(b.providerClass));
};

/**
 * One row per registered worker, grouped and described. Null when the
 * registry itself cannot be read: nothing is shown rather than a guessed list.
 * `live` and `capabilities` may each be null; the rows then say so instead of
 * claiming a connection or a capability they have not read.
 */
export function buildAmuxWorkerOverview(input: {
  registry: AmuxWorkerRegistryAdminView | null;
  capabilities: AmuxWorkerCapabilityAdminView | null;
  live: AgentOfficeAmuxState | null;
  nowMs: number;
}): AmuxWorkerOverview | null {
  const { registry, capabilities, live, nowMs } = input;
  if (registry === null || !registry.registryReadable) return null;
  const liveByName = new Map(live?.kind === "observed" ? live.workers.map((worker) => [worker.name, worker]) : []);
  const capabilityByName = new Map((capabilities?.rows ?? []).map((row) => [row.workerName, row]));
  const liveReadable = live?.kind === "observed";

  const rows = registry.rows.map((row): AmuxWorkerOverviewRow => {
    const reading = liveByName.get(row.workerName) ?? null;
    // A worker the live read has no seat for is unread, not "stopped".
    const liveState = reading?.state ?? null;
    const capability = capabilityByName.get(row.workerName) ?? null;
    const recorded = capability?.current?.capability ?? null;
    const capabilityRecorded = capabilities === null || recorded !== null;
    const status: AmuxWorkerStatusKind =
      row.desiredState === "retired" ? "retired"
      : row.desiredState === "requested" ? "waiting_activation"
      : row.desiredState === "paused" ? "paused"
      : activeStatus(liveState, row.reasons, capabilityRecorded);
    const group = STATUS_GROUP[status];
    const heartbeat = reading?.heartbeatAt ? Date.parse(reading.heartbeatAt) : NaN;
    return {
      workerName: row.workerName,
      providerClass: row.providerClass,
      providerLabel: amuxWorkerProviderLabel(row.providerClass),
      mode: recorded?.v22 ? "v22" : "session",
      roleCeiling: row.roleCeiling,
      desiredState: row.desiredState,
      revision: row.revision,
      changedAt: row.changedAt,
      group,
      status,
      tone: toneOf(group),
      live: liveState,
      heartbeatAgeSeconds: Number.isNaN(heartbeat) ? null : Math.max(0, Math.round((nowMs - heartbeat) / 1000)),
      model: recorded?.model ?? null,
      routingTags: [...(recorded?.routingTags ?? [])],
      capability,
      actions: [...ACTIONS[row.desiredState]],
    };
  });

  // Attention first, then the order a person scans: in use, waiting, paused, kept.
  const order = (group: AmuxWorkerOverviewGroup) => AMUX_WORKER_OVERVIEW_GROUPS.indexOf(group);
  rows.sort((a, b) => order(a.group) - order(b.group) || a.workerName.localeCompare(b.workerName));

  const inGroup = (group: AmuxWorkerOverviewGroup) => rows.filter((row) => row.group === group);
  const attention = inGroup("attention");
  return {
    liveReadable,
    capabilitiesReadable: capabilities !== null,
    rows,
    summary: {
      total: rows.filter((row) => row.group !== "retired").length,
      assignable: { count: inGroup("assignable").length, byProvider: byProvider(inGroup("assignable")) },
      attention: {
        count: attention.length,
        sample: attention[0] ? { workerName: attention[0].workerName, status: attention[0].status } : null,
      },
      waiting: { count: inGroup("waiting").length, byProvider: byProvider(inGroup("waiting")) },
      paused: inGroup("paused").length,
      retired: inGroup("retired").length,
    },
  };
}

/** How many rows a chip would show. "all" leaves out the kept (retired) ones. */
export const amuxWorkerFilterCount = (
  rows: readonly AmuxWorkerOverviewRow[],
  filter: AmuxWorkerOverviewFilter,
): number =>
  filter === "all" ? rows.filter((row) => row.group !== "retired").length
  : rows.filter((row) => row.group === filter).length;

/** The rows a chip and a name search leave, in the list's own order. */
export function filterAmuxWorkerRows(
  rows: readonly AmuxWorkerOverviewRow[],
  filter: AmuxWorkerOverviewFilter,
  query: string,
): AmuxWorkerOverviewRow[] {
  const needle = query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (filter === "all" ? row.group !== "retired" : row.group === filter) &&
      (needle === "" || row.workerName.includes(needle)),
  );
}

/** The non-empty groups of a list of rows, in the order a person scans them. */
export function groupAmuxWorkerRows(
  rows: readonly AmuxWorkerOverviewRow[],
): { group: AmuxWorkerOverviewGroup; rows: AmuxWorkerOverviewRow[] }[] {
  return AMUX_WORKER_OVERVIEW_GROUPS.map((group) => ({
    group,
    rows: rows.filter((row) => row.group === group),
  })).filter((entry) => entry.rows.length > 0);
}

/**
 * The desired state a requested action asks for. The role ceiling is sent
 * unchanged: this screen turns a worker on and off, and widening a role is a
 * separate, gated change.
 */
export const AMUX_WORKER_ACTION_TARGET: Readonly<Record<AmuxWorkerOverviewAction, AmuxWorkerDesiredState>> =
  Object.freeze({ activate: "active", pause: "paused", resume: "active" });

/** The process the Ubuntu host runs for a worker, and the one command that starts it. */
export const amuxWorkerBridgeUnit = (workerName: string): string => `tomverse-amux-bridge@${workerName}`;
export const amuxWorkerEnableCommand = (workerName: string): string =>
  `sudo systemctl enable --now ${amuxWorkerBridgeUnit(workerName)}.service`;
