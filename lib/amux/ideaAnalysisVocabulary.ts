/** Shared, client-safe proposal vocabulary; no model response is trusted by this list. */
export const AMUX_TASK_ROLE_PROPOSALS = [
  "design", "implement", "test", "review", "verify", "investigate", "operate",
] as const;
export const AMUX_EXECUTION_GRADE_PROPOSALS = ["routine", "advanced", "frontier"] as const;
