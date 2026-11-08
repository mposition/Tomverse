import assert from "node:assert/strict";
import test from "node:test";
import { createPublicModelStatusReader } from "../lib/publicModelStatusClient.ts";

const status = (id = "model-a") => ({ models: [{ id, status: "available" }] });

test("mounted consumers share one in-flight request and a fresh snapshot", async () => {
  let calls = 0;
  let finish;
  const reader = createPublicModelStatusReader({ fetchStatus: () => {
    calls += 1;
    return new Promise(resolve => { finish = resolve; });
  }, now: () => 0 });
  const first = reader.read();
  const second = reader.read();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish(Response.json(status()));
  assert.deepEqual(await first, { snapshot: status(), unavailable: false });
  await reader.read();
  assert.equal(calls, 1);
});

test("429 keeps the last result and Retry-After blocks even manual refresh", async () => {
  let time = 0;
  let calls = 0;
  const reader = createPublicModelStatusReader({ now: () => time, fetchStatus: async () => {
    calls += 1;
    return calls === 2 ? new Response("limited", { status: 429, headers: { "Retry-After": "600" } }) : Response.json(status(`model-${calls}`));
  } });
  await reader.read();
  const stale = await reader.read({ force: true });
  assert.deepEqual(stale, { snapshot: status("model-1"), unavailable: true });
  time = 599_999;
  await reader.read({ force: true });
  assert.equal(calls, 2);
  time = 600_000;
  assert.deepEqual(await reader.read(), { snapshot: status("model-3"), unavailable: false });
});

test("repeated rate limits increase the cooldown and accept HTTP-date Retry-After", async () => {
  let time = Date.parse("2026-11-08T12:00:00Z");
  let calls = 0;
  const reader = createPublicModelStatusReader({ now: () => time, fetchStatus: async () => {
    calls += 1;
    return new Response("limited", { status: 429, headers: { "Retry-After": new Date(time + 60_000).toUTCString() } });
  } });
  assert.equal((await reader.read()).snapshot, null);
  time += 299_999;
  await reader.read({ force: true });
  assert.equal(calls, 1);
  time += 1;
  await reader.read();
  assert.equal(calls, 2);
  time += 599_999;
  await reader.read({ force: true });
  assert.equal(calls, 2);
  time += 1;
  await reader.read();
  assert.equal(calls, 3);
});

test("network and malformed response failures preserve the last good result", async () => {
  let time = 0;
  let calls = 0;
  const reader = createPublicModelStatusReader({ now: () => time, fetchStatus: () => {
    calls += 1;
    if (calls === 2) throw new Error("network unavailable");
    return Promise.resolve(Response.json(calls === 3 ? { models: {} } : status()));
  } });
  await reader.read();
  assert.equal((await reader.read({ force: true })).unavailable, true);
  time = 60_000;
  assert.deepEqual(await reader.read(), { snapshot: status(), unavailable: true });
  time += 120_000;
  assert.deepEqual(await reader.read(), { snapshot: status(), unavailable: false });
  assert.equal(calls, 4);
});

test("a stalled shared request is aborted and becomes a temporary failure", async () => {
  const reader = createPublicModelStatusReader({ timeoutMs: 1, fetchStatus: signal => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("request timed out")), { once: true });
  }) });
  assert.deepEqual(await reader.read(), { snapshot: null, unavailable: true });
});
