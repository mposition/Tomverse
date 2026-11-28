/**
 * Where Code can run a task. This is a description of the places this build and the server it reached offer, with the
 * reason a place is not available.
 *
 * `cloud` is available only when the server names `desktopCloudExecution` (docs/ops/desktop-cloud-execution.md): a task
 * then runs on a Tomverse runner on a snapshot of the project's tracked files, and comes back as a patch to review.
 * `ssh` is filled in by the remote lane through `ssh`; until then it reads as not set up.
 */
export type ExecutionLocationId = "local" | "worktree" | "ssh" | "cloud";

export type ExecutionLocationUnavailable = "not_set_up" | "not_offered";

export type ExecutionLocation =
  | { id: ExecutionLocationId; available: true }
  | { id: ExecutionLocationId; available: false; reason: ExecutionLocationUnavailable };

export type ExecutionLocationInput = {
  /** Set by the remote lane once a host can be reached; absent means not set up. */
  ssh?: { available: true } | { available: false; reason: ExecutionLocationUnavailable };
  /** The server's `desktopCloudExecution` capability. */
  cloud?: boolean;
};

export function describeExecutionLocations(input: ExecutionLocationInput = {}): ExecutionLocation[] {
  return [
    { id: "local", available: true },
    { id: "worktree", available: true },
    input.ssh ? { id: "ssh", ...input.ssh } : { id: "ssh", available: false, reason: "not_set_up" },
    input.cloud ? { id: "cloud", available: true } : { id: "cloud", available: false, reason: "not_offered" },
  ];
}
