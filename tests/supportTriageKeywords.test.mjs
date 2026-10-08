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

test("every term of every locale raises its flag inside a sentence", () => {
  for (const flag of core.KEYWORD_FLAGS) {
    for (const locale of KEYWORD_LOCALES) {
      for (const term of SUPPORT_TRIAGE_KEYWORDS[flag][locale]) {
        assert.ok(keywordFlagsIn(`Hello. ${term}. Thanks`).includes(flag), `${flag} ${locale} ${term}`);
      }
    }
  }
});

test("spacing, inflections and inserted words that previously slipped through", () => {
  const cases = [
    ["요즘 죽고싶어요", ["self_harm_threat"]],
    ["살기싫어요 정말", ["self_harm_threat"]],
    ["계정삭제 해주세요", ["account_privacy"]],
    ["请删除我的账号", ["account_privacy"]],
    ["請刪除我的帳號", ["account_privacy"]],
    ["Mein Rechtsanwalt meldet sich", ["legal"]],
    ["Lesen Sie Ihre Datenschutzerklärung", ["account_privacy"]],
    ["They sued another company", ["legal"]],
    ["Our lawyers are reviewing this", ["legal"]],
    ["This content is copyrighted", ["legal"]],
    ["Tengo dos pagos duplicados", ["money"]],
    // charges is money and press charges legal; trust and safety still wins the lane.
    ["I will press charges", ["money", "legal"]],
    ["They are pressing charges", ["money", "legal"]],
    ["Unexpected charges on my card", ["money"]],
    ["A double charge again", ["money"]],
    ["请删除我的账户", ["account_privacy"]],
    ["請註銷我的帳戶", ["account_privacy"]],
    ["I was in charge of the team", []],
    ["Thanks for the courtesy", []],
    ["He courted the idea", []],
    // Plurals by suffix, verb forms by list.
    ["The courts decided", ["legal"]],
    ["He sues everyone", ["legal"]],
    ["I was subpoenaed", ["legal"]],
    ["Our data was breached", ["security"]],
    ["They exploited a bug", ["security"]],
    ["I keep self-harming", ["self_harm_threat"]],
    ["I was invoiced twice", ["money"]],
    ["Two credit cards were billed", ["money"]],
    ["Mes factures sont fausses", ["money"]],
    ["Meine Rechnungen stimmen nicht", ["money"]],
    ["Minhas assinaturas", ["money"]],
    ["Tengo demandas pendientes", ["legal"]],
    ["Los tribunales", ["legal"]],
    // Legal idioms around charges carry the legal flag, so the lane is trust and safety.
    ["They filed charges against me", ["money", "legal"]],
    ["Facing criminal charges", ["money", "legal"]],
    // Separate words never fuse into a term.
    ["혼자 살아요", []],
    ["혼자 해결했어요", []],
    ["방법 원해요", []],
    ["방법 적용해 주세요", []],
    ["정보 안내해 주세요", []],
    ["그래도 용서해 주세요", []],
    ["해결 제안", []],
    ["西安 全部", []],
    ["There is an issue here", []],
  ];
  for (const [text, flags] of cases) assert.deepEqual(keywordFlagsIn(text), flags, text);
});

test("money and the trust and safety flags partition the flags exactly", () => {
  assert.deepEqual(["money", ...core.TRUST_SAFETY_FLAGS].sort(), [...core.KEYWORD_FLAGS].sort());
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
