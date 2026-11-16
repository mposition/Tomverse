import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE = resolve(ROOT, "tests/fixtures/sentry-openai-stream.mjs");

// Each run gets its own process: Sentry.init is process-global.
const runFixture = (mode) => {
  const result = spawnSync(process.execPath, ["--import", "tsx", FIXTURE, mode], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, SENTRY_DSN: "", NEXT_PUBLIC_SENTRY_DSN: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
};

test("the server Sentry setup leaves a streamed OpenAI call readable", () => {
  const outcome = runFixture("app");
  assert.equal(outcome.subscribed, false, "no Sentry subscriber may tap the AI SDK model stream");
  assert.equal(outcome.error, null);
  assert.equal(outcome.text, "Hello there");
});

test("Sentry's default VercelAI integration is what locks the stream", () => {
  // The control: if this ever passes as readable, the SDK or Sentry fixed the
  // copy/tap mismatch and the integration can come back.
  const outcome = runFixture("sentry-default");
  assert.equal(outcome.subscribed, true);
  assert.equal(outcome.text, "");
  assert.match(outcome.error ?? "", /ERR_INVALID_STATE/);
});
