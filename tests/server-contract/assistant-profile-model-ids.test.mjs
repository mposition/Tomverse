import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const catalogue = [
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", enabled: true, status: "enabled" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", enabled: false, status: "disabled", publiclyListed: false, replacementModelId: "claude-sonnet-5-5" },
  { id: "gpt-6-luna", name: "GPT 6 Luna", enabled: true, status: "enabled" },
  { id: "dead-end", name: "Dead end", enabled: false, status: "disabled" },
];
class AssistantProfileError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
mock.module(mod("lib/modelRegistry.ts"), { namedExports: { getRuntimeModels: async () => catalogue } });
mock.module(mod("lib/assistantProfileService.ts"), { namedExports: { AssistantProfileError } });
const { resolveProfileModelIds } = await import(mod("lib/assistantProfileModels.ts"));

test("a retired id ticked beside its successor is published once, under the successor", async () => {
  // Production 2026-11-03: ["claude-sonnet-5-5", "claude-sonnet-5"] was stored
  // and Chat refused the assistant as a multi-model one.
  assert.deepEqual(await resolveProfileModelIds(["claude-sonnet-5-5", "claude-sonnet-5"]), ["claude-sonnet-5-5"]);
  assert.deepEqual(await resolveProfileModelIds(["claude-sonnet-5"]), ["claude-sonnet-5-5"]);
});

test("distinct live models are kept, in order", async () => {
  assert.deepEqual(await resolveProfileModelIds(["gpt-6-luna", "claude-sonnet-5-5"]), ["gpt-6-luna", "claude-sonnet-5-5"]);
});

test("naming none stays none", async () => {
  assert.deepEqual(await resolveProfileModelIds([]), []);
  assert.deepEqual(await resolveProfileModelIds(undefined), []);
});

test("a model with no live successor is refused rather than silently dropped", async () => {
  await assert.rejects(
    resolveProfileModelIds(["gpt-6-luna", "dead-end"]),
    (error) => error instanceof AssistantProfileError && error.code === "ASSISTANT_PROFILE_MODEL_UNAVAILABLE" && error.status === 422
  );
  await assert.rejects(resolveProfileModelIds(["no-such-model"]), AssistantProfileError);
});
