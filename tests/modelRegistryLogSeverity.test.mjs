import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * What the model registry writes to which stream.
 *
 * Not style. Node sends `console.warn` and `console.error` to stderr, and the
 * log collector in front of the deployment files stderr as severity=error. The
 * registry's reconciliation reported its ordinary, successful work through
 * `console.warn`, so every release that withdrew a model filled the error
 * stream with entries that needed no action -- and an error stream that is
 * mostly noise is one nobody reads. A real registry failure was landing in the
 * same place as seven lines saying the deploy went as intended.
 *
 * The taxonomy this pins:
 *
 *   info   reconciliation succeeded, here is what changed
 *   warn   expected, but an operator should know (schema not migrated yet)
 *   error  a row is invalid, or the work failed
 */

const ROOT = join(import.meta.dirname, "..");
const source = readFileSync(join(ROOT, "lib", "modelRegistry.ts"), "utf8");

/** The console call whose argument list contains `needle`. */
const levelOfCallContaining = (needle) => {
  const at = source.indexOf(needle);
  assert.ok(at > 0, `expected to find ${needle} in lib/modelRegistry.ts`);
  const before = source.slice(0, at);
  const call = before.lastIndexOf("console.");
  assert.ok(call > 0, `no console call precedes ${needle}`);
  return source.slice(call, before.length).match(/console\.(\w+)/)?.[1];
};

test("a successful withdrawal is reported at info, not on the error stream", () => {
  assert.equal(
    levelOfCallContaining("model_registry.static_withdrawal_applied"),
    "info"
  );
});

test("a successful metadata reconciliation is reported at info", () => {
  assert.equal(
    levelOfCallContaining("model_registry.static_metadata_reconciled"),
    "info"
  );
});

test("both reconciliation events are structured, not interpolated prose", () => {
  // `changedFields` is the point: an operator asking "what did this deploy
  // change about the catalogue" should be able to query it, not grep a
  // sentence and hope the shape held.
  for (const event of [
    "model_registry.static_withdrawal_applied",
    "model_registry.static_metadata_reconciled",
  ]) {
    const at = source.indexOf(event);
    const window = source.slice(at, at + 700);
    assert.match(window, /severity: "info"/, `${event} must carry its severity`);
    assert.match(window, /modelId/, `${event} must name the model`);
    assert.match(window, /changedFields/, `${event} must say what changed`);
  }
});

test("real failures stay on the error stream", () => {
  // The other half of the contract. Quietening the successes is only safe if
  // the failures did not move with them.
  assert.equal(
    levelOfCallContaining("Ignoring invalid model registry row:"),
    "error"
  );
  assert.equal(
    levelOfCallContaining("Model registry schema is not migrated yet"),
    "warn"
  );
});
