import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const mod = path => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let now = Date.now(), reads = 0, failure = false, pages = [];
mock.method(Date, "now", () => now);
mock.module(mod("lib/githubRepoRead.ts"), { namedExports: { createGithubRepoReader: () => async path => {
  assert.match(path, /^\/pulls\?state=all&base=develop&sort=updated&direction=desc&per_page=100&page=[123]$/);
  reads++;
  if (failure) throw Error("private provider response");
  return pages[Number(path.slice(-1)) - 1] ?? [];
} } });
const { readDailyImplementations } = await import(mod("lib/dailyProductImplementation.ts"));
test("repository reads are bounded, cached and shared by concurrent claim/page reads", async () => {
  pages = [Array(100).fill(null), Array(100).fill(null), []];
  const result = await Promise.all([readDailyImplementations(), readDailyImplementations()]);
  assert.equal(result[0].status, "available");
  assert.equal(reads, 3);
  await readDailyImplementations();
  assert.equal(reads, 3);
});
test("expired evidence is not served on a failed lookup and unknown outcomes never look available", async () => {
  now += 60_001; failure = true;
  assert.deepEqual(await readDailyImplementations(), { status: "unavailable", byTask: {}, byUrl: {} });
  failure = false; pages = [];
  assert.equal((await readDailyImplementations()).status, "available");
  assert.equal(reads, 5);
});
test("a malformed page is not a successful empty queue", async () => {
  now += 60_001; pages = [{ error: "untrusted" }];
  assert.equal((await readDailyImplementations()).status, "unavailable");
});
