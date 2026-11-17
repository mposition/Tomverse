/** Read-only PR evidence. A develop merge is never proof of production deployment. */
export type DailyTaskImplementation = { prUrl: string; state: "open" | "merged" | "closed" };
export type DailyImplementationLookup = {
  status: "available" | "unavailable";
  byTask: Record<string, DailyTaskImplementation>;
  byUrl: Record<string, DailyTaskImplementation>;
};
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const taskPattern = /^(?:scout\.[A-Za-z0-9_-]{1,64}|[A-Za-z0-9_-]{1,64}:\d{1,2})$/;
export function dailyImplementationLookup(pulls: readonly unknown[]): DailyImplementationLookup {
  const result: DailyImplementationLookup = { status: "available", byTask: {}, byUrl: {} };
  const ranked = pulls.map(record).filter((value): value is Record<string, unknown> => !!value)
    .sort((a, b) => Number(a.number) - Number(b.number));
  for (const pull of ranked) {
    const head = record(pull.head), base = record(pull.base);
    if (record(head?.repo)?.full_name !== "mposition/Tomverse" || base?.ref !== "develop" ||
        record(base.repo)?.full_name !== "mposition/Tomverse" || !Number.isSafeInteger(pull.number) || Number(pull.number) < 1) continue;
    const prUrl = `https://github.com/mposition/Tomverse/pull/${pull.number}`;
    if (pull.html_url !== prUrl || !["open", "closed"].includes(String(pull.state))) continue;
    const implementation: DailyTaskImplementation = { prUrl,
      state: pull.merged_at ? "merged" : pull.state === "open" ? "open" : "closed" };
    result.byUrl[prUrl] = implementation;
    if (typeof pull.body !== "string") continue;
    for (const match of pull.body.matchAll(/^Goal-Step: daily-product-improvements\/(\S+?)(?: completes)?\s*$/gm)) {
      const task = match[1];
      if (!taskPattern.test(task)) continue;
      const prior = result.byTask[task];
      // A newer closed/abandoned attempt cannot erase a useful existing PR.
      if (prior?.state === "merged" && implementation.state !== "merged" || prior?.state === "open" && implementation.state === "closed") continue;
      result.byTask[task] = implementation;
    }
  }
  return result;
}
export function taskImplementation(lookup: DailyImplementationLookup, id: string, prUrl?: string): DailyTaskImplementation | undefined {
  const linked = lookup.byTask[id];
  return linked && linked.state !== "closed" ? linked : prUrl ? lookup.byUrl[prUrl] ?? linked : linked;
}
export const implementationCoversTask = (value: DailyTaskImplementation | undefined) =>
  value?.state === "open" || value?.state === "merged";
