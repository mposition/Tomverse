import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  auditProcessingTierMentions,
  PROCESSING_TIER_SELECTOR_PATTERN,
} from "../scripts/check-processing-tier-core.mjs";
import { PROCESSING_TIER_REQUEST_ALLOWLIST } from "../lib/modelPricing.ts";

/**
 * The guard behind `npm run check:model-pricing` that stops a request-side
 * price selector (`service_tier`, `inference_geo`) reaching a provider without
 * the pricing profile that describes it.
 *
 * It went blind once, in the least visible way available: `app/api/chat/route.ts`
 * kept its allowlist entry after the mention it was written for disappeared --
 * the classifier moved behind an `observeServedProcessingTier` import, which
 * names no tier. The check downgraded that to a warning and carried on, so the
 * one file in the tree that builds the provider request held a standing
 * exemption. `service_tier: "flex"` added to its `streamText` call would have
 * been waved through, mis-costing every request on it.
 *
 * These tests pin both halves: a selector in an unlisted file fails, and an
 * exemption that outlives its mention fails too.
 */

const entry = (file, sendsATier = false) => ({
  file,
  sendsATier,
  reason: "fixture",
});

test("a request-building file that gains a selector fails the check", () => {
  const { errors } = auditProcessingTierMentions({
    matchedFiles: ["lib/servedProcessingTier.ts", "app/api/chat/route.ts"],
    allowlist: [entry("lib/servedProcessingTier.ts")],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /app\/api\/chat\/route\.ts/);
  assert.match(errors[0], /not in the allowlist/);
});

test("an exemption that outlives its mention fails rather than warning", () => {
  // The exact regression. The file matches nothing any more, so the old check
  // printed a warning and exited 0, leaving the exemption in place.
  const { errors } = auditProcessingTierMentions({
    matchedFiles: ["lib/servedProcessingTier.ts"],
    allowlist: [entry("lib/servedProcessingTier.ts"), entry("app/api/chat/route.ts")],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /app\/api\/chat\/route\.ts/);
  assert.match(errors[0], /no longer names one/);
});

test("a stale exemption cannot be laundered by a later selector in the same file", () => {
  // Both halves at once: with the entry withdrawn, the very next selector in
  // that file is reported. This is the state the repository is now in.
  const withdrawn = [entry("lib/servedProcessingTier.ts")];
  assert.equal(
    auditProcessingTierMentions({
      matchedFiles: ["lib/servedProcessingTier.ts"],
      allowlist: withdrawn,
    }).errors.length,
    0
  );
  assert.equal(
    auditProcessingTierMentions({
      matchedFiles: ["lib/servedProcessingTier.ts", "app/api/chat/route.ts"],
      allowlist: withdrawn,
    }).errors.length,
    1
  );
});

test("sendsATier: true is an error even for an allowlisted file", () => {
  const { errors } = auditProcessingTierMentions({
    matchedFiles: ["lib/someRequestBuilder.ts"],
    allowlist: [entry("lib/someRequestBuilder.ts", true)],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /sendsATier: true/);
});

test("the live allowlist is clean and every entry still names a selector", () => {
  // Run against the real tree with the real pattern. `--untracked` matters for
  // the same reason it does in the check: a guard that answers differently
  // before and after `git add` is not a guard.
  const grep = spawnSync(
    "git",
    [
      "grep",
      "--untracked",
      "-lE",
      PROCESSING_TIER_SELECTOR_PATTERN,
      "--",
      "app",
      "lib",
      "components",
      "scripts",
    ],
    { encoding: "utf8" }
  );
  const matchedFiles = (grep.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (file) =>
        file !== "lib/modelPricing.ts" &&
        file !== "scripts/check-model-pricing.mjs" &&
        file !== "scripts/check-processing-tier-core.mjs"
    );

  assert.ok(matchedFiles.length > 0, "expected the pattern to match something");
  const { errors } = auditProcessingTierMentions({
    matchedFiles,
    allowlist: PROCESSING_TIER_REQUEST_ALLOWLIST,
  });
  assert.deepEqual(errors, []);
});

test("app/api/chat/route.ts holds no standing exemption", () => {
  // Named explicitly: it is the file that builds the provider request, so an
  // entry for it means the guard is off exactly where it is needed. If the
  // route ever legitimately needs to name a selector, that is a pricing change
  // and this assertion is where the conversation starts.
  assert.equal(
    PROCESSING_TIER_REQUEST_ALLOWLIST.some(
      (item) => item.file === "app/api/chat/route.ts"
    ),
    false
  );
});
