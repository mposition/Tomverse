import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { shouldStopAmuxV19LocalAnalysis } from
  "../lib/amux/ideaLocalAnalysisStopPoll.mjs";
import { amuxV4CliExitFailureStage, awaitAmuxV19StoppableChild } from
  "../lib/amux/ideaLocalIsolatedCliRunner.mjs";
import { amuxV4AnalysisCliDiagnostic } from
  "../lib/amux/ideaLocalAnalysisDiagnostics.mjs";

const secret = "v19_stop_poll_012345678901234567890123456789";
const base = { origin: "https://tomverse.example/",
  agentSecret: secret, holdId: "hold_1" };
const reply = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

test("local stop poll continues only on exact authenticated 200 false", async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(url,
      "https://tomverse.example/api/internal/amux/v19/analysis-stop?holdId=hold_1");
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    assert.equal(options.cache, "no-store");
    assert.equal(options.headers.authorization, `Bearer ${secret}`);
    assert.equal(options.headers["x-amux-agent-id"], "amux-intake");
    return reply({ holdId: "hold_1", stop: false });
  };
  assert.equal(await shouldStopAmuxV19LocalAnalysis({ ...base, fetchImpl }), false);
  assert.equal(calls, 1);
  for (const input of [{ ...base, holdId: "../other" },
    { ...base, origin: "http://tomverse.example/" },
    { ...base, agentSecret: "short" }]) {
    assert.equal(await shouldStopAmuxV19LocalAnalysis({ ...input, fetchImpl }),
      true);
  }
  assert.equal(calls, 1);
});

test("local stop poll fails closed for stop, stale identity and uncertain transport", async () => {
  const check = (fetchImpl) => shouldStopAmuxV19LocalAnalysis({
    ...base, fetchImpl,
  });
  for (const response of [
    reply({ holdId: "hold_1", stop: true }),
    reply({ holdId: "other", stop: false }),
    reply({ holdId: "hold_1", stop: false, extra: true }),
    reply({ holdId: "hold_1", stop: "false" }),
    reply({ error: "unavailable" }, 503),
    new Response("no", { status: 200 }),
    new Response("x".repeat(257), {
      headers: { "content-type": "application/json" },
    }),
  ]) assert.equal(await check(async () => response), true);
  assert.equal(await check(async () => { throw new Error("network"); }), true);
});

test("v19 stop signals the entire fake CLI process group without a time deadline", {
  skip: process.platform !== "linux",
}, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
    { detached: true, stdio: "ignore", shell: false });
  let polls = 0;
  const exit = await awaitAmuxV19StoppableChild(child, async () => {
    polls += 1;
    return polls >= 2;
  }, 20);
  assert.ok(polls >= 2);
  assert.equal(exit.stopped, true);
  assert.equal(exit.timedOut, false);
  assert.equal(exit.signal, "SIGKILL");
  assert.equal(amuxV4CliExitFailureStage(exit, false), "stop_requested");
  assert.deepEqual(amuxV4AnalysisCliDiagnostic({
    kind: "outcome_unknown", failureStage: "stop_requested",
  }), { failureStage: "stop_requested", parserReason: null,
    rejectionPoint: null });
});

test("v19 live child can complete after an interval without forced timeout", {
  skip: process.platform !== "linux",
}, async () => {
  const child = spawn(process.execPath, ["-e",
    "setTimeout(() => process.exit(0), 80)"],
  { detached: true, stdio: "ignore", shell: false });
  const exit = await awaitAmuxV19StoppableChild(child, async () => false, 10);
  assert.equal(exit.code, 0);
  assert.equal(exit.stopped, false);
  assert.equal(exit.timedOut, false);
});
