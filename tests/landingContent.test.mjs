import assert from "node:assert/strict";
import test from "node:test";
import { landingCopy, interpolate } from "../components/marketing/landingContent.ts";

const languages = ["en", "ko", "zh", "fr", "de", "es", "pt"];

// The landing copy table used to be `{ en } & Partial<Record<Language, ...>>`,
// so a key that no locale overrode silently shipped in English and a key no
// component read shipped nowhere at all. The type is now total, and this
// walks it to catch the two failures a type cannot: a translation left as the
// English string, and a claim that outran the product.

/** Every string reachable from a copy object, with its dotted path. */
const walkStrings = (value, path = "", collected = []) => {
  if (typeof value === "string") {
    collected.push([path, value]);
    return collected;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, `${path}[${index}]`, collected));
    return collected;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      walkStrings(item, path ? `${path}.${key}` : key, collected);
    }
    return collected;
  }
  return collected;
};

// Brand names, product names and plan names are the same in every language on
// purpose; they are the only strings allowed to match the English table.
// `pricing.plans[].id` is an identifier the billing config keys on, not copy.
const SHARED_BY_DESIGN = new Set([
  "badge",
  "preview.reviewTitle",
  "pricing.plans[0].id",
  "pricing.plans[1].id",
  "pricing.plans[2].id",
  "pricing.plans[0].title",
  "pricing.plans[1].title",
  "pricing.plans[2].title",
  "evidence.deepResearch.title",
  "proof.stages[2].title",
  "support.items[4].title",
  // "Contradiction" is spelled identically in French; this is a real
  // collision, not a missing translation.
  "preview.reviewItems[1]",
  "faqs[1].question",
]);

// Both halves of the boundary notice, per locale: the limit on what AI Review
// does by itself, and the pointer to the check that does exist. Asserted as
// patterns rather than a length, because the same sentence is far shorter in
// Chinese than in German.
const BOUNDARY_PATTERNS = {
  en: [/compares only the supplied answers/, /separate web check/],
  ko: [/제공된 답변끼리만 비교/, /웹 확인/],
  zh: [/只比较提供的回答/, /网页核实/],
  fr: [/compare uniquement les réponses fournies/, /vérification web/],
  de: [/vergleicht nur gelieferte Antworten/, /Web-Check/],
  es: [/solo compara las respuestas dadas/, /verificación web/],
  pt: [/compara apenas as respostas fornecidas/, /verificação web/],
};

test("landing copy exists for every supported language", () => {
  assert.deepEqual(Object.keys(landingCopy).sort(), [...languages].sort());
});

test("every locale defines the same set of copy keys", () => {
  const englishKeys = walkStrings(landingCopy.en)
    .map(([path]) => path)
    .sort();
  for (const language of languages) {
    const keys = walkStrings(landingCopy[language])
      .map(([path]) => path)
      .sort();
    assert.deepEqual(keys, englishKeys, `${language} copy shape differs from en`);
  }
});

test("no locale leaves a general string as its English fallback", () => {
  const english = new Map(walkStrings(landingCopy.en));
  const leftovers = [];
  for (const language of languages) {
    if (language === "en") continue;
    for (const [path, value] of walkStrings(landingCopy[language])) {
      if (SHARED_BY_DESIGN.has(path)) continue;
      if (english.get(path) === value) leftovers.push(`${language}: ${path}`);
    }
  }
  assert.deepEqual(leftovers, [], "untranslated strings");
});

test("every locale names the four evidence capabilities", () => {
  for (const language of languages) {
    const { evidence } = landingCopy[language];
    for (const key of ["webSearch", "deepResearch", "sourceGrounding", "itemVerification"]) {
      assert.ok(evidence[key].title.length > 2, `${language} ${key} title missing`);
      assert.ok(
        evidence[key].description.length > 40,
        `${language} ${key} description too thin to be a claim`
      );
      assert.ok(
        typeof evidence[key].condition === "string" && evidence[key].condition.length > 10,
        `${language} ${key} states a capability without its condition`
      );
    }
    // Deep Research is plan-gated, and the page advertises it, so the plan
    // has to be named where it is advertised.
    assert.match(
      evidence.deepResearch.condition,
      /Pro/,
      `${language} does not name the Deep Research plan requirement`
    );
  }
});

test("the review boundary keeps its generation-step limits and names the separate web check", () => {
  for (const language of languages) {
    const boundary = landingCopy[language].proof.reviewBoundary;
    for (const pattern of BOUNDARY_PATTERNS[language]) {
      assert.match(boundary, pattern, `${language} boundary notice lost a required clause`);
    }
  }
});

test("no locale reintroduces superseded product figures or unguaranteed outcomes", () => {
  const banned = [
    "4 credits used",
    "Review confidence",
    "Real product UI",
    "source-linked",
    "근거와 연결된 체크리스트",
  ];
  for (const language of languages) {
    const serialized = walkStrings(landingCopy[language])
      .map(([, value]) => value)
      .join("\n");
    for (const phrase of banned) {
      assert.ok(
        !serialized.includes(phrase),
        `${language} copy contains the superseded phrase "${phrase}"`
      );
    }
  }
});

test("the hero keeps the guest-start note and the AI Review promise unqualified", () => {
  // Guest access to AI Review and to attachments is being widened by a
  // separate platform change. Until it lands, the landing page must neither
  // advertise those as account-only nor drop them.
  for (const language of languages) {
    const copy = landingCopy[language];
    assert.ok(copy.heroSignupNote.length > 10, `${language} lost the guest-start note`);
    assert.match(copy.description, /AI Review/, `${language} hero dropped AI Review`);
    assert.match(
      copy.proof.steps[2].title + copy.proof.steps[2].description,
      /AI Review/,
      `${language} lost the AI Review step`
    );
    for (const field of [copy.heroSignupNote, copy.guestNote, copy.description]) {
      assert.doesNotMatch(
        field,
        /Account required|계정 필요/,
        `${language} hero qualifies a promise owned by the platform change`
      );
    }
  }
});

test("plan credits are a template, not a fixed number", () => {
  for (const language of languages) {
    const { creditsLine } = landingCopy[language].pricing;
    assert.match(
      creditsLine,
      /\{credits\}/,
      `${language} hard-codes a credit allowance instead of interpolating one`
    );
    assert.doesNotMatch(creditsLine, /300|3,000|10,000/);
  }
  assert.equal(
    interpolate(landingCopy.en.pricing.creditsLine, { credits: "3,000" }),
    "3,000 monthly AI credits"
  );
});

test("the provider note is derived, never a written-out count", () => {
  for (const language of languages) {
    assert.match(
      landingCopy[language].catalogue.providerNote,
      /\{count\}/,
      `${language} writes the provider count into copy`
    );
  }
});
