// The polarity distance, and the two defects the first calibration run found.
//
// `.github/audits/memory-eval-gold-contract-2026-08-27.md` §9.1. Both defects
// were categorical rather than numeric -- the rule read a negation marker out
// of a sentence that contains none -- so each gets a test that fails on the
// sentence that exposed it, not on a threshold.

import assert from "node:assert/strict";
import test from "node:test";

import { POLARITY_CALIBRATION_CASES } from "../lib/memoryEvalPolarityCalibration/corpus.ts";
import {
  POLARITY_MARKERS,
  polarityGap,
  polarityMatches,
} from "../lib/memoryEvalPolarityCalibration/distance.ts";
import { canon, canonNS } from "../lib/memoryEvalPolarityCalibration/normalise.ts";

const gap = (statement, factValueAll, language) =>
  polarityGap({ statement, factValueAll, language });

test("English is not measured without spaces", () => {
  // canonNS("The user lives in Ottawa") contains `not`, spanning the boundary
  // between `in` and `Ottawa`. Measured on that string, the sentence denies
  // its own subject at every K.
  assert.ok(canonNS("The user lives in Ottawa.").includes("not"));
  assert.ok(!canon("The user lives in Ottawa.").includes("not"));
  assert.equal(gap("The user lives in Ottawa.", ["ottawa"], "en"), null);
});

test("English markers are whole words", () => {
  for (const statement of [
    "The user knows the schedule.", // `no` inside `know`
    "The user has nothing scheduled.", // `not` inside `nothing`
    "The user works in Nottingham.", // `not` inside a place name
  ]) {
    assert.equal(gap(statement, ["user"], "en"), null, statement);
  }
});

test("fact values stay substrings, so a stem still matches", () => {
  // §2.1's stem list is prefix matching. A boundary test on the fact value
  // would abolish it: `sibling` would stop matching `siblings`.
  assert.equal(gap("The user has no siblings.", ["sibling"], "en"), 1);
});

test("n't reaches the marker list", () => {
  assert.ok(POLARITY_MARKERS.en.includes("not"));
  assert.equal(canon("The user doesn't drive."), "the user does not drive");
  assert.notEqual(gap("The user doesn't drive.", ["drive"], "en"), null);
});

test("cannot is a negation", () => {
  assert.ok(POLARITY_MARKERS.en.includes("cannot"));
  assert.notEqual(gap("The user cannot drive.", ["drive"], "en"), null);
});

test("Korean is measured without spaces, and markers stay substrings", () => {
  // Spacing is not stable, and the markers are morphemes bound to the stem
  // they negate -- neither of which a whole-word rule could express.
  assert.equal(gap("사용자는 인천에 살지 않는다.", ["인천"], "ko"), 3);
  assert.equal(gap("사용자는 인천에 살지않는다.", ["인천"], "ko"), 3);
});

test("a distant marker is not the fact's own", () => {
  // The sentence this whole distance exists for: a marker is present and
  // belongs to something else.
  assert.equal(
    polarityMatches({
      statement: "사용자는 인천에 살며 이사 계획이 없다.",
      factValueAll: ["인천"],
      language: "ko",
      polarity: "affirms",
      k: 7,
    }),
    true
  );
});

test("the corpus admits no K for English", () => {
  // §9.2. This is the finding, so it is pinned: if a later edit to the corpus
  // or the markers opens a window, that is a change to the finding and has to
  // be seen rather than absorbed.
  const forShape = (language, shape) =>
    POLARITY_CALIBRATION_CASES.filter(
      (item) => item.language === language && item.shape === shape
    )
      .map((item) => gap(item.statement, item.factValueAll, item.language))
      .filter((value) => value !== null);

  const floor = (language) => Math.max(...forShape(language, "negative"));
  const ceiling = (language) => Math.min(...forShape(language, "affirmative")) - 1;

  assert.equal(floor("ko"), 7);
  assert.equal(ceiling("ko"), 7, "ko has a one-value window and no margin");
  assert.equal(floor("en"), 18);
  assert.equal(ceiling("en"), 5);
  assert.ok(floor("en") > ceiling("en"), "en window must stay empty");
});

test("every corpus case is labelled and reachable by its own fact value", () => {
  const seen = new Set();
  for (const item of POLARITY_CALIBRATION_CASES) {
    assert.ok(!seen.has(item.id), `duplicate id ${item.id}`);
    seen.add(item.id);
    assert.equal(typeof item.assertsGold, "boolean", item.id);
    const form = item.language === "ko" ? canonNS : canon;
    for (const token of item.factValueAll) {
      assert.ok(
        form(item.statement).includes(form(token)),
        `${item.id}: fact value ${token} does not occur in its own statement`
      );
    }
  }
  assert.equal(seen.size, 60);
});
