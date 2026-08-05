// Measures lib/chatTokenEstimate.ts against a real tokenizer.
//
// A report, not a gate. ESTIMATE-01 (median absolute error <= 5%) and
// ESTIMATE-02 (p95 <= 15%) cannot be argued about until the current error is a
// number, and today it is far outside both -- see
// docs/policy/tomverse-chat-model-capability-inventory.md G1. Failing the build
// on that would only make the gap red; measuring it is what lets it be closed.
//
// It imports the shipped estimator rather than a copy. A copy would drift and
// then report on an implementation nobody runs.
//
// Scope, stated plainly: js-tiktoken covers the OpenAI families (o200k_base for
// the GPT-5 line, cl100k_base for the GPT-4 line). Anthropic and Google
// tokenize differently and only expose token counting over the network, so
// their error is unmeasured here. That makes this a lower bound on the problem,
// not the whole of it, and ESTIMATE-01/02 evidence needs the other families
// before it is decision-grade.
//
// The corpus below is a development fixture for iterating on the estimator. It
// is deliberately not the decision set -- the same separation
// docs/ops/tomverse-chat-router-evaluation-set.md requires, for the same
// reason: an estimator tuned against the sample that judges it reports its own
// fit.

import { getEncoding } from "js-tiktoken";

import { estimateTextTokens } from "../lib/chatTokenEstimate.ts";

const ENCODINGS = [
  { name: "o200k_base", note: "GPT-5 family", encoder: getEncoding("o200k_base") },
  { name: "cl100k_base", note: "GPT-4 family", encoder: getEncoding("cl100k_base") },
];

const CORPUS = [
  {
    id: "ko-prose",
    text: "인공지능 모델을 선택할 때 가장 중요한 것은 질문의 성격입니다. 코딩 작업이라면 추론 능력이 강한 모델이 유리하고, 간단한 요약이라면 빠르고 저렴한 모델로 충분합니다. 사용자는 보통 이 차이를 알기 어렵기 때문에 서버가 대신 판단해 주는 편이 낫습니다.",
  },
  { id: "ko-short", text: "오늘 서울 날씨 어때?" },
  {
    id: "ko-technical",
    text: "PostgreSQL의 전문 검색은 형태소 분석기 구성에 의존하므로, 한국어 조사와 어미가 분리되지 않으면 재현율이 크게 떨어집니다. 따라서 bigram 색인을 별도로 생성해야 합니다.",
  },
  {
    id: "ko-en-mixed",
    text: "이번 Router는 sticky-auto를 기본값으로 하고, hard switch 조건에서만 모델을 변경합니다. fallback은 첫 visible token 이전에만 허용됩니다.",
  },
  {
    id: "en-prose",
    text: "When choosing a model, what matters most is the shape of the question. A coding task rewards a stronger reasoning model, while a short summary is well served by something fast and cheap. Users rarely know the difference, so the server should decide on their behalf.",
  },
  { id: "en-short", text: "what's the weather in Seoul today?" },
  {
    id: "code-ts",
    text: "export const estimatePromptTokens = (text: string) =>\n  text ? Math.max(1, estimateTextTokens(text)) : 0;\n\nconst rows = await prisma.routingRun.findMany({\n  where: { conversationId },\n  orderBy: { createdAt: 'desc' },\n  take: 20,\n});\nif (!rows.length) throw new Error('no routing runs');",
  },
  {
    id: "json-payload",
    text: '{"routingRunId":"cuid_abc123","attempts":[{"sequence":1,"provider":"openai","modelId":"gpt-5-6-luna","outcome":"failed_pre_token"},{"sequence":2,"provider":"anthropic","modelId":"claude-fable-5","outcome":"succeeded"}]}',
  },
  {
    id: "ja-prose",
    text: "モデルを選ぶときに最も重要なのは質問の性質です。コーディング作業であれば推論能力の高いモデルが有利です。",
  },
  {
    id: "zh-prose",
    text: "选择模型时最重要的是问题的性质。如果是编程任务，推理能力更强的模型更有优势，而简单的摘要用快速且便宜的模型就足够了。",
  },
];

const ESTIMATE_01_MEDIAN_LIMIT = 5;
const ESTIMATE_02_P95_LIMIT = 15;

const signedErrorPercent = (estimate, actual) => ((estimate - actual) / Math.max(actual, 1)) * 100;

const percentile = (sorted, p) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

for (const { name, note, encoder } of ENCODINGS) {
  console.log(`\n${name} (${note})`);
  console.log(
    "  " +
      "sample".padEnd(14) +
      "actual".padStart(8) +
      "estimate".padStart(10) +
      "signed".padStart(10)
  );

  const absoluteErrors = [];
  for (const { id, text } of CORPUS) {
    const actual = encoder.encode(text).length;
    const estimate = estimateTextTokens(text);
    const signed = signedErrorPercent(estimate, actual);
    absoluteErrors.push(Math.abs(signed));
    console.log(
      "  " +
        id.padEnd(14) +
        String(actual).padStart(8) +
        String(estimate).padStart(10) +
        `${signed >= 0 ? "+" : ""}${signed.toFixed(1)}%`.padStart(10)
    );
  }

  absoluteErrors.sort((a, b) => a - b);
  const median = percentile(absoluteErrors, 0.5);
  const p95 = percentile(absoluteErrors, 0.95);
  console.log(
    `  median ${median.toFixed(1)}% (ESTIMATE-01 limit ${ESTIMATE_01_MEDIAN_LIMIT}%), ` +
      `p95 ${p95.toFixed(1)}% (ESTIMATE-02 limit ${ESTIMATE_02_P95_LIMIT}%)`
  );
  if (median > ESTIMATE_01_MEDIAN_LIMIT || p95 > ESTIMATE_02_P95_LIMIT) {
    console.log("  -> outside the ESTIMATE-01/02 budget on this corpus.");
  }
}

// The heuristic's own constants, checked against what the tokenizers actually
// do. This is where the gap comes from: the constants were calibrated for the
// GPT-4-era tokenizer, and the newer one is far more efficient on CJK.
const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/gu;
const cjkSamples = CORPUS.filter((sample) => (sample.text.match(CJK_PATTERN) || []).length > 20);

console.log("\nheuristic constants versus measured behaviour");
console.log(
  "  " + "sample".padEnd(14) + "cjkChars".padStart(9) + ENCODINGS.map((e) => `${e.name} tok/char`.padStart(22)).join("")
);
for (const { id, text } of cjkSamples) {
  const chars = (text.match(CJK_PATTERN) || []).length;
  const ratios = ENCODINGS.map(({ encoder }) =>
    (encoder.encode(text).length / chars).toFixed(2).padStart(22)
  ).join("");
  console.log("  " + id.padEnd(14) + String(chars).padStart(9) + ratios);
}
console.log("  the estimator assumes 1.5 tokens per CJK character.");

console.log(
  "\nReport only; this script never fails the build. Closing the gap is G1 in " +
    "docs/policy/tomverse-chat-model-capability-inventory.md."
);
