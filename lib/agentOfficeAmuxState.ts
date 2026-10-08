/**
 * The AMUX execution room's state, from the worker catalog and the runtime rows.
 *
 * The catalog is the app's own (`getConfiguredAmuxWorkerCatalog`): the workers
 * AMUX may route to, with the operator's static exclusions. An archived worker
 * is left out. Each remaining worker is read against its runtime row the way
 * AMUX reads it when it hands out work: a runtime is live while its lease has
 * not run out and its status is idle or busy (lib/amux/v22WorkerClaimService.ts).
 * The operator's exclusions come first, because AMUX skips an excluded worker
 * however alive it is. Only names, providers, states and heartbeat times leave
 * here -- never a card, a task or a model's output.
 */

import type { AgentOfficeAmuxState, AgentOfficeAmuxWorkerState } from "@/lib/agentOffice/live";

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

export function agentOfficeAmuxState(input: {
  catalog: readonly CatalogWorker[] | null;
  runtimes: readonly Runtime[];
  now: Date;
}): AgentOfficeAmuxState {
  if (!input.catalog) return { kind: "no_catalog" };
  const runtimes = new Map(input.runtimes.map((runtime) => [runtime.workerName, runtime]));
  return {
    kind: "observed",
    workers: input.catalog
      .filter((worker) => !worker.archived)
      .map((worker) => {
        const runtime = runtimes.get(worker.worker_name);
        return {
          name: worker.worker_name,
          provider: worker.provider,
          state: workerState(worker, runtime, input.now),
          heartbeatAt: runtime?.heartbeatAt.toISOString() ?? null,
        };
      }),
  };
}
