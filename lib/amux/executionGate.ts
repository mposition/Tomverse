import "server-only";

export const isAmuxExecutionApiEnabled = () =>
  process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED?.trim() ===
  "1";
