import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  auditProcessingTierMentions,
  PROCESSING_TIER_REQUEST_ALLOWLIST,
  PROCESSING_TIER_SELECTOR_PATTERN,
} from "../scripts/check-processing-tier-core.mjs";

/**
 * The guard behind `npm run check:model-pricing` that stops a request-side
 * price selector (`service_tier`, `inference_geo`) reaching a provider without
 * the pricing profile that describes it.
 *
 * It went blind once, in the least visible way available. `app/api/chat/route.ts`
 * kept its allowlist entry after the mention it was written for disappeared --
 * the classifier moved behind an `observeServedProcessingTier` import, which
 * names no tier. The check downgraded that to a warning and carried on, so the
 * one file in the tree that builds the provider request held a standing
 * exemption: `service_tier: "flex"` in its `streamText` call would have been
 * waved through, mis-costing every request served on that tier.
 *
 * The entry was withdrawn, and the allowlist now pins lines rather than files,
 * so the same failure cannot recur one level down -- an allowlisted file that
 * reads a tier off a response cannot quietly gain a line that sets one. These
 * tests pin every way that can go wrong.
 */

const entry = (file, mentions, sendsATier = false) => ({
  file,
  sendsATier,
  reason: "fixture",
  mentions,
});

const lines = (...pairs) => pairs.map(([file, text]) => ({ file, text }));

const CLASSIFIER = "const value = byProvider.serviceTier;";

test("a file that is not allowlisted at all fails", () => {
  const { errors } = auditProcessingTierMentions({
    matchedLines: lines(
      ["lib/servedProcessingTier.ts", CLASSIFIER],
      ["app/api/chat/route.ts", 'service_tier: "flex",']
    ),
    allowlist: [entry("lib/servedProcessingTier.ts", [CLASSIFIER])],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /app\/api\/chat\/route\.ts/);
  assert.match(errors[0], /not in the allowlist/);
});

test("an allowlisted file that gains an unpinned line fails", () => {
  // The failure file-level exemptions could not see: this file is listed
  // because it *reads* the tier off a response, and it just gained a line that
  // sets one.
  const { errors } = auditProcessingTierMentions({
    matchedLines: lines(
      ["lib/servedProcessingTier.ts", CLASSIFIER],
      ["lib/servedProcessingTier.ts", 'service_tier: "flex",']
    ),
    allowlist: [entry("lib/servedProcessingTier.ts", [CLASSIFIER])],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not pinned/);
  assert.match(errors[0], /flex/);
});

test("an exemption that outlives its file fails rather than warning", () => {
  // The original regression. The file matches nothing any more, so the old
  // check printed a warning and exited 0, leaving the exemption in place.
  const { errors } = auditProcessingTierMentions({
    matchedLines: lines(["lib/servedProcessingTier.ts", CLASSIFIER]),
    allowlist: [
      entry("lib/servedProcessingTier.ts", [CLASSIFIER]),
      entry("app/api/chat/route.ts", ['service_tier = "standard";']),
    ],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /app\/api\/chat\/route\.ts/);
  assert.match(errors[0], /no longer names one/);
});

test("a pin whose line is gone fails, so the list cannot rot in place", () => {
  const { errors } = auditProcessingTierMentions({
    matchedLines: lines(["lib/servedProcessingTier.ts", CLASSIFIER]),
    allowlist: [
      entry("lib/servedProcessingTier.ts", [CLASSIFIER, "const gone = serviceTier;"]),
    ],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no longer in the file/);
});

test("re-indenting a pinned line is not a change", () => {
  const { errors } = auditProcessingTierMentions({
    matchedLines: lines(["lib/servedProcessingTier.ts", `      ${CLASSIFIER}`]),
    allowlist: [entry("lib/servedProcessingTier.ts", [`  ${CLASSIFIER}`])],
  });
  assert.deepEqual(errors, []);
});

test("sendsATier: true is an error even for an allowlisted file", () => {
  const { errors } = auditProcessingTierMentions({
    matchedLines: lines(["lib/someRequestBuilder.ts", CLASSIFIER]),
    allowlist: [entry("lib/someRequestBuilder.ts", [CLASSIFIER], true)],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /sendsATier: true/);
});

test("the live allowlist is clean, line for line", () => {
  // Run against the real tree with the real pattern. `--untracked` matters for
  // the same reason it does in the check: a guard that answers differently
  // before and after `git add` is not a guard.
  const grep = spawnSync(
    "git",
    [
      "grep",
      "--untracked",
      "-nE",
      PROCESSING_TIER_SELECTOR_PATTERN,
      "--",
      "app",
      "lib",
      "components",
      "scripts",
    ],
    { encoding: "utf8" }
  );
  const selfReferential = new Set([
    "lib/modelPricing.ts",
    "scripts/check-model-pricing.mjs",
    "scripts/check-processing-tier-core.mjs",
  ]);
  const matchedLines = (grep.stdout || "")
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      const first = row.indexOf(":");
      const second = row.indexOf(":", first + 1);
      return { file: row.slice(0, first), text: row.slice(second + 1) };
    })
    .filter((line) => !selfReferential.has(line.file));

  assert.ok(matchedLines.length > 0, "expected the pattern to match something");
  const { errors } = auditProcessingTierMentions({
    matchedLines,
    allowlist: PROCESSING_TIER_REQUEST_ALLOWLIST,
  });
  assert.deepEqual(errors, []);
});

test("app/api/chat/route.ts holds no exemption of any kind", () => {
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

test("every entry pins at least one line", () => {
  // An entry with an empty `mentions` would be the file-level exemption again,
  // spelled differently: nothing in the file would ever be pinned, so nothing
  // in it could ever fail.
  for (const item of PROCESSING_TIER_REQUEST_ALLOWLIST) {
    assert.ok(item.mentions.length > 0, `${item.file} pins no lines`);
  }
});
