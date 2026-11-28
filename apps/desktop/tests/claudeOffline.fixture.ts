import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaudeFixture } from "../src/host/claude-fixture-run";
import type { ClaudeTurnObservation } from "../src/host/claude-turn";
import { bindProjectRoot } from "../src/host/project-root";
import { claudeReadScenario } from "./claude-message-fixture";

assert.equal(process.platform, "linux");
assert.equal(process.getuid?.(), 65534);
const interfaces = (await readFile("/proc/net/dev", "utf8")).trim().split("\n").slice(2);
assert.deepEqual(interfaces.map((line) => line.split(":")[0]?.trim()), ["lo"]);
const executable = process.argv[2];
assert.ok(executable);
const temp = await mkdtemp(join(tmpdir(), "tomverse-claude-offline-"));
const root = join(temp, "workspace");
const inside = join(root, "marker.txt");
const outside = join(temp, "outside.txt");
const denied = join(root, "forbidden.txt");
const scenario = claudeReadScenario({ inside, outside, denied });
const { endpoint, marker, outsideMarker, model, answer } = scenario;
try {
  await mkdir(root);
  await Promise.all([writeFile(inside, marker), writeFile(outside, outsideMarker)]);
  endpoint.listen(0, "127.0.0.1");
  await once(endpoint, "listening");
  const address = endpoint.address();
  assert.ok(address && typeof address !== "string");
  let last: ClaudeTurnObservation | undefined;
  const { status } = await runClaudeFixture({ executable, version: "2.1.278", model, origin: `http://127.0.0.1:${address.port}` },
    { project: bindProjectRoot(root), prompt: "Inspect the selected marker and publish a short plan.", mode: "plan", signal: AbortSignal.timeout(65_000) },
    (observation) => { last = observation; });
  if (scenario.error) throw scenario.error;
  assert.equal(status, "completed", JSON.stringify({ last, requests: scenario.requests }));
  assert.deepEqual(last?.messages, [{ role: "assistant", text: answer }]);
  assert.equal(last?.plan?.activeId, null);
  assert.equal(last?.plan?.proposalOnly, true);
  assert.deepEqual(last?.plan?.analysis, scenario.firstAnalysis);
  assert.deepEqual(last?.plan?.items.map(({ complete, completionUnverified, evidence }) =>
    ({ complete, completionUnverified, reads: evidence.map(({ state }) => state) })), [
    { complete: false, completionUnverified: false, reads: ["succeeded"] },
    { complete: false, completionUnverified: false, reads: ["failed"] },
  ]);
  assert.equal(last?.session.provider, "anthropic");
  assert.equal(last?.session.model, model);
  assert.equal(scenario.requests, 10);
  await assert.rejects(readFile(denied), { code: "ENOENT" });
  assert.equal(await readFile(outside, "utf8"), outsideMarker);
  process.stdout.write(`TOMVERSE_CLAUDE_OFFLINE_PASS ${JSON.stringify({ requests: scenario.requests, status, terminal: last })}\n`);
} finally {
  endpoint.closeAllConnections();
  await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  await rm(temp, { recursive: true, force: true });
}
