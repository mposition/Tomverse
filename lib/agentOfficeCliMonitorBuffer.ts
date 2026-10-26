import {
  AGENT_OFFICE_CLI_STALE_MS, AGENT_OFFICE_CLI_TTL_MS,
  sanitizeAgentOfficeCliSnapshot,
  isAgentOfficeCliWorker,
  type AgentOfficeCliReading, type AgentOfficeCliSnapshot, type AgentOfficeCliWorker,
} from "./agentOfficeCliMonitorCore";

/** One bounded, volatile snapshot per resident worker, on one app replica. */
export function createAgentOfficeCliBuffer(now: () => number = Date.now) {
  const latest = new Map<AgentOfficeCliWorker, { snapshot: AgentOfficeCliSnapshot; receivedAt: number;
    credential: string; expiry?: ReturnType<typeof setTimeout> }>();
  return {
    record(snapshot: AgentOfficeCliSnapshot, credential: string): "recorded" | "older" {
      if (!isAgentOfficeCliWorker(snapshot.worker)) throw new TypeError("invalid worker");
      const previous = latest.get(snapshot.worker);
      if (previous?.credential === credential &&
          Date.parse(snapshot.capturedAt) < Date.parse(previous.snapshot.capturedAt)) return "older";
      clearTimeout(previous?.expiry);
      const entry: NonNullable<typeof previous> = {
        snapshot: sanitizeAgentOfficeCliSnapshot(snapshot), receivedAt: now(), credential,
      };
      entry.expiry = setTimeout(() => {
        if (latest.get(snapshot.worker) === entry) latest.delete(snapshot.worker);
      }, AGENT_OFFICE_CLI_TTL_MS);
      entry.expiry.unref?.();
      latest.set(snapshot.worker, entry);
      return "recorded";
    },
    read(worker: AgentOfficeCliWorker, credential: string): AgentOfficeCliReading {
      const entry = latest.get(worker);
      if (!entry || entry.credential !== credential || now() - entry.receivedAt >= AGENT_OFFICE_CLI_TTL_MS)
        return { state: "unavailable", receivedAt: null, snapshot: null };
      return { state: now() - entry.receivedAt > AGENT_OFFICE_CLI_STALE_MS ? "stale" : "live",
        receivedAt: new Date(entry.receivedAt).toISOString(), snapshot: entry.snapshot };
    },
  };
}

const shared = globalThis as typeof globalThis & {
  agentOfficeCliWorkerBuffer?: ReturnType<typeof createAgentOfficeCliBuffer>;
};
export const agentOfficeCliBuffer = shared.agentOfficeCliWorkerBuffer ??= createAgentOfficeCliBuffer();
