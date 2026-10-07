import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { keywordFlagsIn, KEYWORD_LOCALES, SUPPORT_TRIAGE_KEYWORDS } = await import("../lib/supportTriageKeywords.ts");
const core = await import("../lib/supportTriageCore.ts");

// The keyword flags and the lane rule (docs/policy/support-triage.md §1),
// measured against an answer-keyed synthetic corpus.

const corpus = JSON.parse(
  readFileSync(new URL("./fixtures/supportTriageKeywords/corpus.json", import.meta.url), "utf8")
);

test("every corpus case produces exactly its flags and its lane", () => {
  for (const item of corpus.cases) {
    const flags = keywordFlagsIn(item.message);
    assert.deepEqual(flags, item.flags, item.id);
    const lane = core.triageLaneFor({ type: item.type, keywordFlags: flags, errorReportVerification: item.verification });
    assert.equal(lane, item.lane, item.id);
  }
});

test("the corpus covers every flag, every lane and every locale", () => {
  const flags = new Set(corpus.cases.flatMap((item) => item.flags));
  for (const flag of core.KEYWORD_FLAGS) assert.ok(flags.has(flag), flag);
  const lanes = new Set(corpus.cases.map((item) => item.lane));
  for (const lane of core.TRIAGE_LANES) assert.ok(lanes.has(lane), lane);
  const prefixes = new Set(corpus.cases.map((item) => item.id.split("-")[0]));
  for (const locale of KEYWORD_LOCALES) assert.ok(prefixes.has(locale), locale);
});

test("every flag has a list in every locale, and the flags are the core's", () => {
  assert.deepEqual(Object.keys(SUPPORT_TRIAGE_KEYWORDS).sort(), [...core.KEYWORD_FLAGS].sort());
  for (const flag of core.KEYWORD_FLAGS) {
    for (const locale of KEYWORD_LOCALES) {
      assert.ok(SUPPORT_TRIAGE_KEYWORDS[flag][locale].length > 0, `${flag} ${locale}`);
    }
  }
});

test("flags come out distinct, in the core order, and nothing else does", () => {
  const flags = keywordFlagsIn("REFUND!! refund my subscription, I was hacked, my lawyer, delete my account");
  assert.deepEqual(flags, ["money", "account_privacy", "security", "legal"]);
  for (const value of [null, undefined, 42, ""]) assert.deepEqual(keywordFlagsIn(value), []);
  // Full-width and composed forms normalise before matching.
  assert.deepEqual(keywordFlagsIn("ＲＥＦＵＮＤ"), ["money"]);
});

test("trust and safety wins over money, money over type", () => {
  assert.equal(core.triageLaneFor({ type: "billing", keywordFlags: ["money", "legal"], errorReportVerification: null }), "trust_safety_human");
  assert.equal(core.triageLaneFor({ type: "bug", keywordFlags: ["money"], errorReportVerification: "verified" }), "billing_human");
  assert.equal(core.triageLaneFor({ type: "support", keywordFlags: [], errorReportVerification: "verified" }), "other");
});
