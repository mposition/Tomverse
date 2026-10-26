import { z } from "zod";
import { detectSecrets } from "./engineeringAgentSecretPatterns";
import { AGENT_OFFICE_AMUX_ROSTER } from "./agentOffice/amuxRoster";

/** Owner-approved resident monitoring scope; never an execution allowlist. */
export const AGENT_OFFICE_CLI_WORKER = "codex-impl";
export type AgentOfficeCliWorker = (typeof AGENT_OFFICE_AMUX_ROSTER)[number]["name"];
export const AGENT_OFFICE_CLI_WORKERS = Object.freeze(AGENT_OFFICE_AMUX_ROSTER.map(worker => worker.name) as
  [AgentOfficeCliWorker, ...AgentOfficeCliWorker[]]);
export function isAgentOfficeCliWorker(value: unknown): value is AgentOfficeCliWorker {
  return typeof value === "string" && AGENT_OFFICE_CLI_WORKERS.includes(value as AgentOfficeCliWorker);
}
export function agentOfficeCliProvider(worker: AgentOfficeCliWorker) {
  const provider = AGENT_OFFICE_AMUX_ROSTER.find(entry => entry.name === worker)?.provider;
  if (!provider) throw new TypeError("invalid worker");
  return { openai: "codex", anthropic: "claude", cursor: "cursor", "github-copilot": "copilot" }[provider] as
    "codex" | "claude" | "cursor" | "copilot";
}
export const AGENT_OFFICE_CLI_MAX_BYTES = 65_536;
export const AGENT_OFFICE_CLI_STALE_MS = 20_000;
export const AGENT_OFFICE_CLI_TTL_MS = 15 * 60_000;
export const AGENT_OFFICE_CLI_POLL_MS = 5_000;

export const agentOfficeCliSnapshotSchema = z.object({
  worker: z.enum(AGENT_OFFICE_CLI_WORKERS),
  source: z.enum(["amux-codex-rollout", "amux-transcript", "amux-terminal"]),
  capturedAt: z.string().datetime(),
  truncated: z.boolean(),
  events: z.array(z.object({
    kind: z.enum(["prompt", "assistant", "tool", "output"]),
    text: z.string().max(4_000),
  }).strict()).max(80),
  rawOutput: z.string().max(8_000),
}).strict().refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <=
  AGENT_OFFICE_CLI_MAX_BYTES).refine(value => value.source !== "amux-codex-rollout" ||
    agentOfficeCliProvider(value.worker) === "codex");

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
  // A viewport can begin after the BEGIN line. Hide key footers and long
  // base64 lines too; false positives are preferable to displaying key bytes.
  const partialKey = /-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/.test(plain) ||
    /(?:^|\n)[ \t]*[A-Za-z0-9+/]{48,}={0,2}[ \t]*(?:\r?\n|$)/.test(plain);
  return partialKey || detectSecrets(plain).length ? "[REDACTED: sensitive output]" : plain;
}

export function sanitizeAgentOfficeCliSnapshot(input: AgentOfficeCliSnapshot): AgentOfficeCliSnapshot {
  return { ...input, events: input.events.map((event) => ({ ...event,
    text: maskAgentOfficeCliText(event.text) })),
  rawOutput: maskAgentOfficeCliText(input.rawOutput) };
}
