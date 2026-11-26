/**
 * Settings of subagent orchestration (see orchestrate.ts). Dependency-free on purpose: the Desktop settings screen and the CLI
 * config both read the same numbers.
 *
 * Orchestration is off unless the person turns it on: it can multiply the requests of a task several times over, so what it may use
 * is shown when it is turned on and again before each run.
 */

export type OrchestrationLimits = {
    /** Subagent subtasks running at the same time. */
    maxSubagents: number;
    /** Model requests every subtask of one task shares (work, checks, retries, verification); the task's own request limit still applies. */
    maxRequests: number;
};

export const ORCHESTRATION_DEFAULTS: OrchestrationLimits = { maxSubagents: 3, maxRequests: 90 };
export const ORCHESTRATION_BOUNDS = { maxSubagents: { min: 1, max: 6 }, maxRequests: { min: 6, max: 400 } } as const;

const clamp = (value: unknown, bounds: { min: number; max: number }, fallback: number) => {
    const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.min(bounds.max, Math.max(bounds.min, number));
};

/** The limits to use for a partial setting: missing or out-of-range numbers fall back to the defaults or the nearest allowed value. */
export const normalizeOrchestration = (input: Partial<OrchestrationLimits> = {}): OrchestrationLimits => ({
    maxSubagents: clamp(input.maxSubagents, ORCHESTRATION_BOUNDS.maxSubagents, ORCHESTRATION_DEFAULTS.maxSubagents),
    maxRequests: clamp(input.maxRequests, ORCHESTRATION_BOUNDS.maxRequests, ORCHESTRATION_DEFAULTS.maxRequests),
});

/** What the person is told when it is turned on and before a run. */
export const describeOrchestration = (limits: OrchestrationLimits) =>
    `up to ${limits.maxSubagents} subagent${limits.maxSubagents === 1 ? "" : "s"} at once, ${limits.maxRequests} requests in all`;
