/**
 * Links a pull request that was just created to the task it belongs to. A pull request the person made from the Git panel is linked at
 * once. One the agent made (publish_changes) is made while its run is still going, and the task cannot take a link until the run has
 * ended: the link waits for that task and is made when the run finishes. Only the open task is ever linked.
 */
export type PullLinkerDeps = {
  /** The id of the task on screen, or null. */
  currentTask(): string | null;
  /** The task on screen can take a link right now (saved, not running, nothing else changing it). */
  ready(): boolean;
  /** Reads and saves the link for the task on screen. */
  link(url: string): Promise<void>;
};

export const MAX_WAITING_PULL_LINKS = 10;

export function createPullLinker(deps: PullLinkerDeps) {
  const waiting = new Map<string, string[]>();
  return {
    /** Called with the address of a pull request that was just created. */
    async add(url: string) {
      const task = deps.currentTask();
      if (!task) return;
      if (deps.ready()) { await deps.link(url); return; }
      const rest = (waiting.get(task) ?? []).filter((item) => item !== url);
      waiting.set(task, [...rest, url].slice(-MAX_WAITING_PULL_LINKS));
    },
    /** The run of this task has ended: links that waited for it are made now, if it is the task on screen. */
    async flush(task: string | null) {
      if (!task) return;
      const urls = waiting.get(task) ?? [];
      waiting.delete(task);
      if (deps.currentTask() !== task) return;
      for (const url of urls) {
        if (deps.currentTask() !== task || !deps.ready()) return;
        try { await deps.link(url); } catch { /* The pull request stays on GitHub; the person can link it by hand. */ }
      }
    },
    /** A task that was deleted or left behind keeps no waiting links. */
    forget(task: string) { waiting.delete(task); },
    waiting: (task: string) => [...(waiting.get(task) ?? [])],
  };
}
