import "server-only";

/**
 * Whether the comment monitor has recently worked (policy 12.1: no graduation
 * without it, and the autonomous admission asks the same question).
 *
 * The monitor is S4c. Until it exists nothing can have worked, and the honest
 * answer is no: graduation stays unavailable for every account, and the console
 * says why. S4c replaces this body with a read of the monitor's last successful
 * run; the callers do not change.
 */
export async function readMarketingCommentsMonitorHealthy(): Promise<boolean> {
  return false;
}
