import type { TaskSummary } from "../contract";

export const TASK_PAGE_SIZE = 50;

export function nextTaskPage(sorted: readonly TaskSummary[], after: string | null) {
  const first = after === null ? 0 : sorted.findIndex(({ id }) => id < after);
  if (first < 0) return { items: [], cursor: null };
  const items = sorted.slice(first, first + TASK_PAGE_SIZE);
  const cursor = first + items.length < sorted.length ? items.at(-1)?.id ?? null : null;
  return { items, cursor };
}

export function appendTaskPage(current: readonly TaskSummary[], next: readonly TaskSummary[]) {
  const tasks = new Map(current.map((task) => [task.id, task]));
  for (const task of next) tasks.set(task.id, task);
  return [...tasks.values()];
}
