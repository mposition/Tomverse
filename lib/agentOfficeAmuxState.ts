/**
 * The AMUX execution room's state, from the worker catalog and the runtime rows.
 *
 * The display roster and dispatch catalog are separate: roster membership
 * grants no execution rights. Only admitted resident workers are read against
 * their runtime rows the way AMUX reads them when it hands out work: a runtime
 * is live while its lease has
 * not run out and its status is idle or busy (lib/amux/v22WorkerClaimService.ts).
 * The operator's exclusions come first, because AMUX skips an excluded worker
 * however alive it is. Only names, providers, states and heartbeat times leave
 * here -- never a card, a task or a model's output.
 */

import type {
  AgentOfficeAmuxDetail,
  AgentOfficeAmuxState,
  AgentOfficeAmuxWorkerState,
  AgentOfficeAttemptMark,
  AgentOfficeWorkerDetail,
} from "@/lib/agentOffice/live";

type CatalogWorker = {
  worker_name: string;
  provider: string;
  archived: boolean;
  paused: boolean;
  isolated: boolean;
  blocked: boolean;
};

type Runtime = {
  workerName: string;
  status: string;
  dispatchReady: boolean;
  heartbeatAt: Date;
  leaseExpiresAt: Date;
};

function workerState(worker: CatalogWorker, runtime: Runtime | undefined, now: Date): AgentOfficeAmuxWorkerState {
  if (worker.blocked) return "blocked";
  if (worker.isolated) return "isolated";
  if (worker.paused) return "paused";
  if (!runtime) return "not_running";
  if (runtime.status === "stopped") return "stopped";
  if (runtime.status === "error") return "error";
  if (runtime.leaseExpiresAt.getTime() <= now.getTime()) return "lost";
  if (runtime.status === "busy") return "busy";
  if (runtime.status === "idle") return runtime.dispatchReady ? "ready" : "idle";
  if (runtime.status === "starting") return "starting";
  // A status the runtime table does not define is not a healthy worker.
  return "error";
}

/** The display roster's provider labels, by provider class (version 31). */
const OFFICE_PROVIDER_LABEL: Readonly<Record<string, string>> = Object.freeze({
  claude: "anthropic",
  codex: "openai",
  cursor: "cursor",
  copilot: "github-copilot",
});

/** A provider class as the display roster labels it. */
export const agentOfficeProviderLabel = (providerClass: string): string =>
  OFFICE_PROVIDER_LABEL[providerClass] ?? providerClass;

/**
 * Orchestration policy version 35, section 3: once R2c is on, a seat for
 * every registered worker that is not retired -- assigned or not, which the
 * state says apart. Seats keep the display roster's order; a registered
 * worker the roster does not name follows, in name order.
 */
export function agentOfficeAmuxRosterFromRegistry(
  registrations: readonly { workerName: string; providerClass: string; desiredState: string }[],
  displayOrder: readonly string[],
): { name: string; provider: string }[] {
  const rank = (name: string) => {
    const index = displayOrder.indexOf(name);
    return index < 0 ? displayOrder.length : index;
  };
  return registrations
    .filter((registration) => registration.desiredState !== "retired")
    .map((registration) => ({
      name: registration.workerName,
      provider: agentOfficeProviderLabel(registration.providerClass),
    }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

export function agentOfficeAmuxState(input: {
  catalog: readonly CatalogWorker[] | null;
  roster: readonly { name: string; provider: string }[];
  runtimes: readonly Runtime[];
  now: Date;
}): AgentOfficeAmuxState {
  const catalog = new Map(
    (input.catalog ?? []).filter((worker) => !worker.archived).map((worker) => [worker.worker_name, worker])
  );
  const runtimes = new Map(input.runtimes.map((runtime) => [runtime.workerName, runtime]));
  return {
    kind: "observed",
    catalogConfigured: input.catalog !== null,
    workers: input.roster.map((resident) => {
      const worker = catalog.get(resident.name);
      const runtime = worker ? runtimes.get(resident.name) : undefined;
      const state: AgentOfficeAmuxWorkerState = worker
        ? workerState(worker, runtime, input.now)
        : input.catalog ? "not_admitted" : "catalog_unknown";
      return {
        name: resident.name,
        provider: worker?.provider ?? resident.provider,
        state,
        heartbeatAt: runtime?.heartbeatAt.toISOString() ?? null,
      };
    }),
  };
}

type DetailQuotaRow = { worker: string; remainingBasisPoints: number; exhausted: boolean; observedAt: Date; resetAt: Date | null };
type DetailAttemptRow = { worker: string; outcome: string | null };
type DetailOpenRow = {
  worker: string;
  taskId: string;
  startedAt: Date;
  leaseExpiresAt: Date | null;
  cardKey: string | null;
  cardTitle: string | null;
};
type DetailUsageRow = { worker: string; tokens: bigint | number; cost: bigint | number };
type DetailModelRow = { worker: string; model: string | null };

const attemptMark = (outcome: string | null): AgentOfficeAttemptMark =>
  outcome === "succeeded" ? "s" : outcome === "failed" ? "f" : "u";

/**
 * Per worker, what the floor and the worker sheet show beyond its state: its
 * latest quota observation and its last ten outcomes for everyone; for the
 * owner, its open attempt with the card it holds and today's CLI usage.
 * Rows for a worker the office does not seat are ignored.
 */
export function agentOfficeAmuxDetail(input: {
  names: readonly string[];
  owner: boolean;
  quotas: readonly DetailQuotaRow[];
  attempts: readonly DetailAttemptRow[];
  open: readonly DetailOpenRow[];
  usage: readonly DetailUsageRow[];
  models: readonly DetailModelRow[];
}): AgentOfficeAmuxDetail {
  const workers: Record<string, AgentOfficeWorkerDetail> = {};
  for (const name of input.names) workers[name] = { quota: null, recent: [], work: null, usage: null };
  for (const q of input.quotas) {
    const w = workers[q.worker];
    if (!w || w.quota) continue;
    w.quota = {
      remainingPercent: Math.max(0, Math.min(100, Math.round(q.remainingBasisPoints / 100))),
      exhausted: q.exhausted,
      resetAt: q.resetAt?.toISOString() ?? null,
      observedAt: q.observedAt.toISOString(),
    };
  }
  for (const a of input.attempts) {
    const w = workers[a.worker];
    if (w && w.recent.length < 10) w.recent.push(attemptMark(a.outcome));
  }
  if (input.owner) {
    for (const o of input.open) {
      const w = workers[o.worker];
      if (!w || w.work) continue;
      w.work = {
        taskId: o.taskId,
        cardKey: o.cardKey,
        cardTitle: o.cardTitle,
        startedAt: o.startedAt.toISOString(),
        leaseExpiresAt: o.leaseExpiresAt?.toISOString() ?? null,
      };
    }
    const models = new Map(input.models.map((m) => [m.worker, m.model]));
    for (const name of input.names) {
      const u = input.usage.find((row) => row.worker === name);
      workers[name].usage = {
        tokens: Number(u?.tokens ?? 0),
        apiCostMicrousd: Number(u?.cost ?? 0),
        model: models.get(name) ?? null,
      };
    }
  }
  return { kind: "observed", ownerDetail: input.owner, workers };
}

/** Midnight on Brisbane's clock (AEST, no daylight saving) before `now`, as a UTC instant. */
export function brisbaneMidnight(now: Date): Date {
  const local = now.getTime() + 10 * 3_600_000;
  return new Date(local - (local % 86_400_000) - 10 * 3_600_000);
}
