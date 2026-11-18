import "server-only";
import { createGithubRepoReader } from "@/lib/githubRepoRead";
import { dailyImplementationLookup, type DailyImplementationLookup } from "@/lib/dailyProductImplementationCore";

// Reuse the existing read-only repository integration. No worker credentials,
// source status writes, completion assumptions, or publication retries.
const CACHE_MS = 60_000;
let cached: { at: number; value: DailyImplementationLookup } | undefined;
let pending: Promise<DailyImplementationLookup> | undefined;
export async function readDailyImplementations(): Promise<DailyImplementationLookup> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  if (pending) return pending;
  pending = (async () => {
    try {
      const read = createGithubRepoReader();
      const pulls: unknown[] = [];
      // Bounded recent evidence complements the worker's code/open-PR check;
      // absence here never establishes that a historical implementation is missing.
      for (let page = 1; page <= 3; page++) {
        const rows = await read(`/pulls?state=all&base=develop&sort=updated&direction=desc&per_page=100&page=${page}`);
        if (!Array.isArray(rows)) throw new Error("invalid_github_response");
        pulls.push(...rows);
        if (rows.length < 100) break;
      }
      const value = dailyImplementationLookup(pulls);
      cached = { at: Date.now(), value };
      return value;
    } catch {
      return { status: "unavailable" as const, byTask: {}, byUrl: {} };
    }
  })();
  try { return await pending; } finally { pending = undefined; }
}
