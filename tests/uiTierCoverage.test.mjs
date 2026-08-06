import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  auditUiTierCoverage,
  specMentions,
  UI_RISK_TAG,
} from "../scripts/check-ui-tier-coverage-core.mjs";

/**
 * The guard over `.github/audits/ui-test-tiers.md`, which declares itself the
 * single source of truth for which spec runs in which CI tier.
 *
 * It had stopped being one, in the way a tag-selected tier always will: specs
 * join by adding `@ui-risk` and nothing asks the document to keep up.
 * Twenty-five tagged files against a table naming five, in a tier that blocks
 * merges and whose recorded size is what people reason about when deciding
 * whether to tag one more.
 */

test("a tagged spec missing from the document is an error", () => {
  const { errors } = auditUiTierCoverage({
    taggedSpecs: ["korean-typography.spec.ts", "brand-new.spec.ts"],
    documentedSpecs: new Set(["korean-typography.spec.ts"]),
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /brand-new\.spec\.ts/);
  assert.match(errors[0], /blocks merges and nothing says so/);
});

test("a documented spec that lost its tag is an error", () => {
  // The direction that matters more: the document would keep describing
  // coverage that no longer runs, which is worse than describing none.
  const { errors } = auditUiTierCoverage({
    taggedSpecs: [],
    documentedSpecs: new Set(["korean-typography.spec.ts"]),
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no longer carries the tag/);
  assert.match(errors[0], /coverage that does not run/);
});

test("an exact pairing produces no errors", () => {
  const specs = ["a.spec.ts", "b.spec.ts"];
  const { errors } = auditUiTierCoverage({
    taggedSpecs: specs,
    documentedSpecs: new Set(specs),
  });
  assert.deepEqual(errors, []);
});

test("spec names are read from code spans, not from prose", () => {
  // The document discusses specs it deliberately keeps *out* of the PR tier.
  // Reading a bare filename out of a sentence would invert the check, so only
  // code spans count -- and the script narrows to the tier's own section
  // before this runs at all.
  const found = specMentions(
    [
      "| `korean-typography.spec.ts` | ... |",
      "chat-state-visual-regression.spec.ts is deliberately excluded.",
      "See `pricing-promotion-reflow.spec.ts` for the reflow cases.",
    ].join("\n")
  );
  assert.deepEqual(
    [...found].sort(),
    ["korean-typography.spec.ts", "pricing-promotion-reflow.spec.ts"]
  );
});

test("the tag the check greps for is the tag the suite greps for", () => {
  // `test:e2e:ui-risk` runs `--grep=@ui-risk`. A guard looking for a different
  // string would pass while measuring nothing.
  const scripts = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ).scripts;
  assert.ok(scripts["test:e2e:ui-risk"].includes(`--grep=${UI_RISK_TAG}`));
});
