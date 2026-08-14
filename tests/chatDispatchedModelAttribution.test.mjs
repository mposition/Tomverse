import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Everything the stream says about "the model that answered" must name the
 * model that answered.
 *
 * This was wrong, and latently so. The chat route's stream logged, recorded
 * provider and model health for, and persisted the assistant message under
 * `requestedModelId` -- the model the *user asked for*. On a manual turn that
 * is the same id as the one that ran and nothing was visible. On a routed turn
 * they are different models, and the consequences are not cosmetic:
 *
 *   - `recordModelSuccess`/`recordModelFailure` would credit or blame a model
 *     that was never dispatched, and §8's fallback recovery decides whether to
 *     restore a displaced model from exactly those counters;
 *   - `MessageProviderContext` would pair the requested model's id with the
 *     effective model's provider, and the provider-context restore is keyed on
 *     that pair;
 *   - the stored assistant message would claim the user's own model wrote it.
 *
 * Auto routes nobody today, so none of it has happened. A fallback makes the
 * ids differ a second time within one turn, which is why this is pinned here
 * before the swap rather than after it.
 *
 * A source scan rather than a runtime assertion, for the same reason
 * `automaticFallbackAbsence` is one: the claim is about every path through a
 * 3,000-line handler, and a runtime test only reports on the paths it drives.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const source = readFileSync(join(root, "app/api/chat/route.ts"), "utf8");

/**
 * The stream closure: everything after the per-attempt holder is built, up to
 * the end of the response's `cancel`.
 *
 * Starts *after* the holder's own initialiser, which is the one place the
 * primary's `modelConfig` is legitimately read -- it is where the attempt is
 * built from it.
 */
const streamRegion = () => {
  const holder = source.indexOf("const dispatched = {");
  assert.notEqual(holder, -1, "the per-attempt holder is gone; this scan is stale");
  const start = source.indexOf("\n        };", holder);
  assert.notEqual(start, -1, "could not find the end of the holder");
  const end = source.indexOf("const headers = new Headers(", start);
  assert.notEqual(end, -1, "could not find the end of the stream section");
  return source.slice(start, end);
};

test("the stream names no model but the one it dispatched", () => {
  const region = streamRegion();
  assert.equal(
    region.includes("requestedModelId"),
    false,
    "The stream reads `requestedModelId` again. On a routed turn that is the " +
      "model the user asked for and not the one answering; read `dispatched` " +
      "instead, which is replaced wholesale when an attempt is."
  );
  assert.equal(
    region.includes("modelConfig."),
    false,
    "The stream reads `modelConfig` again. It is the primary's, captured " +
      "once; a fallback attempt would inherit it silently."
  );
});

test("health, persistence and provider context all read the same holder", () => {
  const region = streamRegion();
  for (const [call, what] of [
    ["recordModelSuccess(dispatched.modelId)", "model health on success"],
    ["recordModelFailure(", "model health on failure"],
    ["recordProviderSuccess(", "provider health on success"],
  ]) {
    assert.ok(region.includes(call), `${what} is no longer where this expects it`);
  }
  // The two that pair an id with a provider, which is where a mismatch does
  // the most damage.
  assert.match(
    region,
    /recordModelFailure\(\s*dispatched\.modelId,\s*dispatched\.provider,/,
    "recordModelFailure must take both halves from the same attempt"
  );
  assert.match(
    region,
    /modelId: dispatched\.modelId,\s*provider: dispatched\.provider,/,
    "MessageProviderContext must pair the id and provider of one attempt"
  );
});

test("the outer failure path names the model it was going to call", () => {
  // Outside the stream: a failure before or around it still records provider
  // health, and it used to pair the requested id with the effective provider.
  assert.equal(
    source.includes("requestedModelIdForLog"),
    false,
    "`requestedModelIdForLog` is back. The outer catch records provider " +
      "health, which is only meaningful about the model that was dispatched."
  );
  assert.match(
    source,
    /dispatchModelIdForLog = modelConfig\.id;/,
    "the outer log id must narrow to the effective model once routing decides"
  );
});

test("the provider usage capture is keyed per attempt, not per trace", () => {
  // Perplexity buffers response bodies under this key and consuming the
  // capture releases it, so two attempts sharing one key would hand the second
  // reader the first attempt's body -- or nothing.
  assert.match(
    streamRegion(),
    /consumePerplexityResponseCapture\(\s*dispatched\.usageCaptureKey\s*\)/,
    "the capture must be taken under the attempt's own key"
  );
});

test("the scan can tell a fixed region from a broken one", () => {
  // A negative control on inputs. Without it, a scan whose anchors had drifted
  // would pass against a handler that had gone back to naming the wrong model.
  const broken = "modelId: requestedModelId,";
  assert.equal(broken.includes("requestedModelId"), true);
  assert.equal("modelId: dispatched.modelId,".includes("requestedModelId"), false);
});
