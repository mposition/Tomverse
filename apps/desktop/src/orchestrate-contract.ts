import { z } from "zod";

export { ORCHESTRATION_DEFAULTS, describeOrchestration } from "../../tomverse-cli/src/orchestrate-config";

/** Stop one subagent subtask of the open task, or all of them when `subtask` is left out. The main process checks it against the open task. */
export const subagentStopInput = z.object({
  id: z.string().regex(/^s-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/),
  subtask: z.string().regex(/^st-[0-9a-f]{6}$/).optional(),
}).strict();

/** One subtask of an orchestrated delegate call as the Code screen shows it. */
export type CodeSubtask = {
  id: string;
  title: string;
  kind: "explore" | "worker";
  agent?: string;
  paths?: string[];
  criteria?: string;
  state: "queued" | "running" | "verifying" | "success" | "failed" | "rejected" | "cancelled";
  reason?: string;
  attempts: number;
  requests: number;
  /** The newest thing it did, one line. */
  activity?: string;
  filesChanged?: string[];
  verification?: { state: "passed" | "failed" | "unverified" | "skipped"; reason: string; check?: "passed" | "failed" | "denied" | "error" | "not_run" };
};

export type CodeOrchestration = { maxSubagents: number; maxRequests: number; used: number; subtasks: CodeSubtask[] };
