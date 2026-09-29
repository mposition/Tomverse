import "server-only";

// Policy version 18: the execution API (claim, worker registration and
// heartbeat, owned queue, execution, delivery, settlement) opens only when this
// code latch is true AND TOMVERSE_AMUX_EXECUTION_API_ENABLED is exactly "1"
// after trim. NODE_ENV plays no part: a test opens it the same way production
// does, by setting the variable. Turning the latch to false is a closing change
// the policy allows without a revision; turning it back on is a revision.
//
// Opening this gate does not open local process execution, which production
// still forbids, nor the engineering adapter, which has its own latch.
export const AMUX_EXECUTION_API_CODE_LATCH = true;

export const amuxExecutionApiPermitted = (
  codeLatch: boolean,
  envValue: string | undefined,
): boolean => codeLatch && envValue?.trim() === "1";

export const isAmuxExecutionApiEnabled = () =>
  amuxExecutionApiPermitted(
    AMUX_EXECUTION_API_CODE_LATCH,
    process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED,
  );
