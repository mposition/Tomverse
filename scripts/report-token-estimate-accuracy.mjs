// Measures lib/chatTokenEstimate.ts against a real tokenizer, per calibration
// version and per cohort.
//
// A report, not a gate. ESTIMATE-01 (median absolute error <= 5%) and
// ESTIMATE-02 (p95 <= 15%) cannot be argued about until the current error is a
// number, and today it is far outside both -- see
// docs/policy/tomverse-chat-model-capability-inventory.md G1. Failing the build
// on that would only make the gap red; measuring it is what lets it be closed.
//
// Cohorts are reported separately on purpose. A corpus with more English than
// Korean can pass an aggregate p95 while Korean is twice as wrong, so an
// aggregate-only number would hide exactly the failure this product cannot
// afford. G1 is judged per cohort, and the same rule will apply per tokenizer
// family once models carry one.
//
// Only the raw estimate is graded. The reservation's safety multiplier is
// deliberate padding; scoring it as accuracy would fail the gate for being
// safe.
//
// Scope, stated plainly: js-tiktoken covers the OpenAI families (o200k_base for
// the GPT-5 line, cl100k_base for the GPT-4 line). Anthropic and Google
// tokenize differently and only expose token counting over the network, so
// their error is unmeasured here. That makes this a lower bound on the problem,
// not the whole of it.
//
// The corpus is a development fixture for iterating on the estimator. It is
// deliberately not the decision set -- the same separation
// docs/ops/tomverse-chat-router-evaluation-set.md requires, for the same
// reason: an estimator tuned against the sample that judges it reports its own
// fit.

import { getEncoding } from "js-tiktoken";

import {
  ACTIVE_ESTIMATOR_VERSION,
  CJK_CHARACTER_PATTERN,
  ESTIMATOR_CALIBRATIONS,
  estimateRawTextTokens,
} from "../lib/chatTokenEstimate.ts";

const ENCODINGS = [
  { name: "o200k_base", note: "GPT-5 family", encoder: getEncoding("o200k_base") },
  { name: "cl100k_base", note: "GPT-4 family", encoder: getEncoding("cl100k_base") },
];

const CORPUS = [
  {
    id: "ko-prose",
    cohort: "hangul",
    text: "인공지능 모델을 선택할 때 가장 중요한 것은 질문의 성격입니다. 코딩 작업이라면 추론 능력이 강한 모델이 유리하고, 간단한 요약이라면 빠르고 저렴한 모델로 충분합니다. 사용자는 보통 이 차이를 알기 어렵기 때문에 서버가 대신 판단해 주는 편이 낫습니다.",
  },
  { id: "ko-short", cohort: "hangul", text: "오늘 서울 날씨 어때?" },
  {
    id: "ko-technical",
    cohort: "hangul",
    text: "PostgreSQL의 전문 검색은 형태소 분석기 구성에 의존하므로, 한국어 조사와 어미가 분리되지 않으면 재현율이 크게 떨어집니다. 따라서 bigram 색인을 별도로 생성해야 합니다.",
  },
  {
    id: "ko-en-mixed",
    cohort: "hangul",
    text: "이번 Router는 sticky-auto를 기본값으로 하고, hard switch 조건에서만 모델을 변경합니다. fallback은 첫 visible token 이전에만 허용됩니다.",
  },
  {
    id: "ja-prose",
    cohort: "han-kana",
    text: "モデルを選ぶときに最も重要なのは質問の性質です。コーディング作業であれば推論能力の高いモデルが有利です。",
  },
  {
    id: "zh-prose",
    cohort: "han-kana",
    text: "选择模型时最重要的是问题的性质。如果是编程任务，推理能力更强的模型更有优势，而简单的摘要用快速且便宜的模型就足够了。",
  },
  {
    id: "en-prose",
    cohort: "latin-prose",
    text: "When choosing a model, what matters most is the shape of the question. A coding task rewards a stronger reasoning model, while a short summary is well served by something fast and cheap. Users rarely know the difference, so the server should decide on their behalf.",
  },
  { id: "en-short", cohort: "latin-prose", text: "what's the weather in Seoul today?" },
  {
    id: "code-ts",
    cohort: "code-json",
    text: "export const estimatePromptTokens = (text: string) =>\n  text ? Math.max(1, estimateTextTokens(text)) : 0;\n\nconst rows = await prisma.routingRun.findMany({\n  where: { conversationId },\n  orderBy: { createdAt: 'desc' },\n  take: 20,\n});\nif (!rows.length) throw new Error('no routing runs');",
  },
  {
    id: "json-payload",
    cohort: "code-json",
    text: '{"routingRunId":"cuid_abc123","attempts":[{"sequence":1,"provider":"openai","modelId":"gpt-5-6-luna","outcome":"failed_pre_token"},{"sequence":2,"provider":"anthropic","modelId":"claude-fable-5","outcome":"succeeded"}]}',
  },
];

const COHORTS = ["hangul", "han-kana", "latin-prose", "code-json"];
const ESTIMATE_01_MEDIAN_LIMIT = 5;
const ESTIMATE_02_P95_LIMIT = 15;

const signedErrorPercent = (estimate, actual) => ((estimate - actual) / Math.max(actual, 1)) * 100;

const percentile = (sorted, p) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

const summarise = (errors) => {
  const sorted = [...errors].sort((a, b) => a - b);
  return { median: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
};

const verdict = ({ median, p95 }) =>
  median <= ESTIMATE_01_MEDIAN_LIMIT && p95 <= ESTIMATE_02_P95_LIMIT ? "within budget" : "OUTSIDE";

const versions = Object.keys(ESTIMATOR_CALIBRATIONS);

for (const { name, note, encoder } of ENCODINGS) {
  console.log(`\n=== ${name} (${note}) ===`);

  for (const version of versions) {
    const active = version === ACTIVE_ESTIMATOR_VERSION ? "  [ACTIVE]" : "";
    console.log(`\n  ${version}${active}`);
    console.log(
      "    " +
        "sample".padEnd(14) +
        "cohort".padEnd(12) +
        "actual".padStart(8) +
        "raw".padStart(8) +
        "signed".padStart(10)
    );

    const byCohort = Object.fromEntries(COHORTS.map((cohort) => [cohort, []]));
    for (const { id, cohort, text } of CORPUS) {
      const actual = encoder.encode(text).length;
      const raw = estimateRawTextTokens(text, version);
      const signed = signedErrorPercent(raw, actual);
      byCohort[cohort].push(Math.abs(signed));
      console.log(
        "    " +
          id.padEnd(14) +
          cohort.padEnd(12) +
          String(actual).padStart(8) +
          String(raw).padStart(8) +
          `${signed >= 0 ? "+" : ""}${signed.toFixed(1)}%`.padStart(10)
      );
    }

    for (const cohort of COHORTS) {
      const stats = summarise(byCohort[cohort]);
      console.log(
        `    ${cohort.padEnd(12)} median ${stats.median.toFixed(1).padStart(6)}%  ` +
          `p95 ${stats.p95.toFixed(1).padStart(6)}%   ${verdict(stats)}`
      );
    }
    const overall = summarise(COHORTS.flatMap((cohort) => byCohort[cohort]));
    console.log(
      `    ${"overall".padEnd(12)} median ${overall.median.toFixed(1).padStart(6)}%  ` +
        `p95 ${overall.p95.toFixed(1).padStart(6)}%   ${verdict(overall)}`
    );
  }
}

// Where the gap comes from: the v1 constants were calibrated for the GPT-4-era
// tokenizer, and the newer one is far more efficient on CJK.
const cjkSamples = CORPUS.filter((sample) => sample.cohort === "hangul" || sample.cohort === "han-kana");
console.log("\n=== calibration constants versus measured behaviour ===");
console.log(
  "  " +
    "sample".padEnd(14) +
    "cjkChars".padStart(9) +
    ENCODINGS.map((encoding) => `${encoding.name} tok/char`.padStart(22)).join("")
);
for (const { id, text } of cjkSamples) {
  const chars = (text.match(CJK_CHARACTER_PATTERN) || []).length;
  const ratios = ENCODINGS.map(({ encoder }) =>
    (encoder.encode(text).length / chars).toFixed(2).padStart(22)
  ).join("");
  console.log("  " + id.padEnd(14) + String(chars).padStart(9) + ratios);
}
for (const version of versions) {
  const { hangulTokensPerCharacter, hanKanaTokensPerCharacter, nonCjkBytesPerToken } =
    ESTIMATOR_CALIBRATIONS[version];
  console.log(
    `  ${version} assumes ${hangulTokensPerCharacter} tokens per Hangul character, ` +
      `${hanKanaTokensPerCharacter} per Han/Kana, and ${nonCjkBytesPerToken} bytes per token elsewhere.`
  );
}

console.log(
  "\nReport only; this script never fails the build. Only the raw estimate is graded -- " +
    "the reservation's safety multiplier is deliberate padding, not error."
);
