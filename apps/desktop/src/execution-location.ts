/**
 * Where Code can run a task. This is a description, not a switch: choosing a location is not wired to starting a task
 * yet, so the list only tells the person which places exist on this build and why one is not available.
 *
 * `cloud` is never available here. Nothing in this repository runs a person's project on a Tomverse server
 * (see docs/ops/desktop-cloud-execution.md), so the row exists to say that plainly instead of promising it.
 * `ssh` is filled in by the remote lane through `ssh`; until then it reads as not set up.
 */
export type ExecutionLocationId = "local" | "worktree" | "ssh" | "cloud";

export type ExecutionLocationUnavailable = "not_set_up" | "server_infrastructure_required";

export type ExecutionLocation =
  | { id: ExecutionLocationId; available: true }
  | { id: ExecutionLocationId; available: false; reason: ExecutionLocationUnavailable };

export type ExecutionLocationInput = {
  /** Set by the remote lane once a host can be reached; absent means not set up. */
  ssh?: { available: true } | { available: false; reason: ExecutionLocationUnavailable };
};

export function describeExecutionLocations(input: ExecutionLocationInput = {}): ExecutionLocation[] {
  return [
    { id: "local", available: true },
    { id: "worktree", available: true },
    input.ssh ? { id: "ssh", ...input.ssh } : { id: "ssh", available: false, reason: "not_set_up" },
    { id: "cloud", available: false, reason: "server_infrastructure_required" },
  ];
}
