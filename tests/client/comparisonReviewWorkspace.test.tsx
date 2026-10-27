import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider } from "@/components/LanguageProvider";
import { ComparisonReviewWorkspace } from "@/components/chat/ComparisonReviewWorkspace";
import type { SingleReviewResult } from "../../packages/chat-core/src/review";

const result: SingleReviewResult = {
  consensus: [],
  differences: [],
  contradictions: [
    {
      text: "Different dates",
      citations: [{ responseId: "B", quote: "three weeks", verified: false }],
      verified: false,
    },
  ],
  missingPoints: [],
  verificationNeeded: [],
  modelAssessments: [],
  synthesis: "",
  confidence: "low",
  limitations: [],
  groundingStats: { totalCitations: 1, verifiedCitations: 0 },
};
const responseMap = [
  {
    responseId: "B" as const,
    messageId: "answer-b",
    modelId: "model-b",
    modelName: "Model B",
  },
];
const render = (source?: {
  question: string;
  responses: Array<{ messageId: string; content: string }>;
}) =>
  renderToStaticMarkup(
    <LanguageProvider>
      <ComparisonReviewWorkspace
        result={result}
        responseMap={responseMap}
        source={source}
        renderActions={() => <button>Feedback</button>}
      />
    </LanguageProvider>,
  );

test("the workspace binds source text by message id and highlights the literal quotation", () => {
  const html = render({
    question: "When?",
    responses: [
      { messageId: "answer-a", content: "Wrong answer" },
      { messageId: "answer-b", content: "It takes three weeks." },
    ],
  });
  assert.match(html, /<mark[^>]*>three weeks<\/mark>/);
  assert.doesNotMatch(html, /Wrong answer/);
  assert.match(html, /Feedback/);
  assert.match(html, /not its factual accuracy/);
});

test("a missing exact quote remains visible without a fabricated highlight", () => {
  const html = render({
    question: "When?",
    responses: [{ messageId: "answer-b", content: "21 days" }],
  });
  assert.match(html, /This exact quotation was not found/);
  assert.match(html, /three weeks/);
  assert.doesNotMatch(html, /<mark/);
});

test("an unavailable original is explicit, not replaced by its quotation", () => {
  assert.match(render(), /The original answer is unavailable/);
  assert.doesNotMatch(render(), /data-testid="ai-review-source-content"/);
});
