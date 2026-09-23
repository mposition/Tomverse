import "server-only";

// Phase A is selection-only. A deployed build cannot enable the mutation
// lifecycle by changing an environment variable; activation requires a
// separately reviewed code change after DB and staging evidence exists.
export const isAmuxExecutionApiEnabled = () =>
  process.env.NODE_ENV === "test" &&
  process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED?.trim() === "1";
