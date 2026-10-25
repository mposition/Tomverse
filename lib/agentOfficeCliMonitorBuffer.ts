import {
  AGENT_OFFICE_CLI_STALE_MS, AGENT_OFFICE_CLI_TTL_MS,
  sanitizeAgentOfficeCliSnapshot,
  type AgentOfficeCliReading, type AgentOfficeCliSnapshot,
} from "./agentOfficeCliMonitorCore";

/** Volatile, bounded pilot buffer: no transcripts in the product DB, files,
 * logs or audit chain. Use one long-running app replica for this pilot. */
export function createAgentOfficeCliBuffer(now: () => number = Date.now) {
  let latest: { snapshot: AgentOfficeCliSnapshot; receivedAt: number; credential: string } | null = null;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  return {
    record(snapshot: AgentOfficeCliSnapshot, credential: string): "recorded" | "older" {
      if (latest?.credential === credential &&
          Date.parse(snapshot.capturedAt) < Date.parse(latest.snapshot.capturedAt)) return "older";
      latest = { snapshot: sanitizeAgentOfficeCliSnapshot(snapshot), receivedAt: now(), credential };
      clearTimeout(expiry);
      expiry = setTimeout(() => { latest = null; }, AGENT_OFFICE_CLI_TTL_MS);
      expiry.unref?.();
      return "recorded";
    },
    read(credential: string): AgentOfficeCliReading {
      if (!latest || latest.credential !== credential || now() - latest.receivedAt >= AGENT_OFFICE_CLI_TTL_MS)
        return { state: "unavailable", receivedAt: null, snapshot: null };
      return { state: now() - latest.receivedAt > AGENT_OFFICE_CLI_STALE_MS ? "stale" : "live",
        receivedAt: new Date(latest.receivedAt).toISOString(), snapshot: latest.snapshot };
    },
  };
}

const shared = globalThis as typeof globalThis & {
  agentOfficeCliBuffer?: ReturnType<typeof createAgentOfficeCliBuffer>;
};
export const agentOfficeCliBuffer = shared.agentOfficeCliBuffer ??= createAgentOfficeCliBuffer();
