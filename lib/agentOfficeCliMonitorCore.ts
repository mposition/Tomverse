import { z } from "zod";
import { detectSecrets } from "./engineeringAgentSecretPatterns";

/** Pilot scope: one existing resident session; never an execution allowlist. */
export const AGENT_OFFICE_CLI_WORKER = "codex-impl";
export const AGENT_OFFICE_CLI_MAX_BYTES = 65_536;
export const AGENT_OFFICE_CLI_STALE_MS = 20_000;
export const AGENT_OFFICE_CLI_TTL_MS = 15 * 60_000;
export const AGENT_OFFICE_CLI_POLL_MS = 5_000;

export const agentOfficeCliSnapshotSchema = z.object({
  worker: z.literal(AGENT_OFFICE_CLI_WORKER),
  source: z.literal("amux-codex-rollout"),
  capturedAt: z.string().datetime(),
  truncated: z.boolean(),
  events: z.array(z.object({
    kind: z.enum(["prompt", "assistant", "tool", "output"]),
    text: z.string().max(4_000),
  }).strict()).max(80),
  rawOutput: z.string().max(8_000),
}).strict().refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <=
  AGENT_OFFICE_CLI_MAX_BYTES);

export type AgentOfficeCliSnapshot = z.infer<typeof agentOfficeCliSnapshotSchema>;
export type AgentOfficeCliReading = {
  state: "live" | "stale" | "unavailable";
  receivedAt: string | null;
  snapshot: AgentOfficeCliSnapshot | null;
};

/** Reuse the existing secret scanner. A hit hides the entire event before
 * truncation, including multi-line private keys. This is best-effort masking,
 * not a guarantee that arbitrary confidential prose can be identified. */
export function maskAgentOfficeCliText(text: string): string {
  const plain = text.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  return detectSecrets(plain).length ? "[REDACTED: sensitive output]" : plain;
}

export function sanitizeAgentOfficeCliSnapshot(input: AgentOfficeCliSnapshot): AgentOfficeCliSnapshot {
  return { ...input, events: input.events.map((event) => ({ ...event,
    text: maskAgentOfficeCliText(event.text) })),
  rawOutput: maskAgentOfficeCliText(input.rawOutput) };
}
