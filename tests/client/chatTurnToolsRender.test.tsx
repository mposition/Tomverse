import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionProvider } from "next-auth/react";
import { LanguageProvider } from "@/components/LanguageProvider";
import { ChatMessageList } from "@/components/chat/ChatMessageList";
import type { Message } from "@/components/chat/types";

const question: Message = { id: "u1", role: "user", content: "Question" };
const answerWith = (content: string, extra: Partial<Message> = {}): Message => ({
  id: "a1",
  role: "assistant",
  modelId: "gpt-5-6-luna",
  status: "normal",
  content,
  ...extra,
});

type ListProps = Partial<React.ComponentProps<typeof ChatMessageList>>;
const render = (messages: Message[], props: ListProps = {}, lang: "en" | "ko" = "en") =>
  renderToStaticMarkup(
    <SessionProvider session={null}>
      <LanguageProvider initialLang={lang}>
        <ChatMessageList messages={messages} currentChatId="c1" {...props} />
      </LanguageProvider>
    </SessionProvider>
  );

const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

/* ----------------------------------------------------------------- math */

test("formulas render with KaTeX in inline and display form", () => {
  const html = render([
    question,
    answerWith(["Inline $E=mc^2$ and \\(a+b\\).", "", "$$", "\\int_0^1 x\\,dx", "$$", "", "\\[ x^2 \\]"].join("\n")),
  ]);
  assert.equal(count(html, /class="katex"/g), 4);
  assert.ok(count(html, /katex-display/g) >= 2);
  assert.ok(!html.includes("katex-error"));
  // A display formula is not dressed as a code block.
  assert.ok(!html.includes('data-testid="chat-code-copy-button"'));
});

test("prices are never read as formulas", () => {
  const html = render([question, answerWith("It costs $5 and $10, or US$20-$30 in total.")]);
  assert.equal(count(html, /class="katex"/g), 0);
  assert.match(html, /It costs \$5 and \$10, or US\$20-\$30 in total\./);
});

test("code stays code, and a half-written formula shows as text without an error", () => {
  const code = render([question, answerWith("```js\nconst a = '$x$'; // \\(y\\)\n```\n\nUse `$z$` here.")]);
  assert.equal(count(code, /class="katex"/g), 0);
  assert.match(code, /\$x\$/);
  assert.match(code, /data-testid="chat-code-copy-button"/);

  const streaming = render([question, answerWith("The result is $$\\frac{a}{")], { isSending: true });
  assert.equal(count(streaming, /class="katex"/g), 0);
  assert.ok(!streaming.includes("katex-error"));
  assert.match(streaming, /The result is/);
});

test("a user's own message is not parsed for formulas", () => {
  const html = render([{ id: "u1", role: "user", content: "What is $$x^2$$ and $y$?" }]);
  assert.equal(count(html, /class="katex"/g), 0);
});

/* -------------------------------------------------------------- mermaid */

test("a mermaid block is shown as its code until a diagram is drawn", () => {
  const html = render([question, answerWith("```mermaid\ngraph TD\n  A-->B\n```")]);
  // Server render never draws: the fallback is the ordinary code block.
  assert.match(html, /data-testid="chat-code-copy-button"/);
  assert.match(html, /A--&gt;B/);
  assert.ok(!html.includes("chat-mermaid-diagram"));
});

/* ---------------------------------------------------------------- chart */

const chartBlock = (spec: object) => ["```chart", JSON.stringify(spec), "```"].join("\n");
const figureOf = (html: string) => html.match(/<figure[\s\S]*?<\/figure>/)?.[0] ?? "";
const barSpec = { type: "bar", title: "Revenue", labels: ["Q1", "Q2"], series: [{ name: "2026", values: [120, 150] }] };

test("a finished answer's chart block is drawn with its data as a table", () => {
  const html = render([question, answerWith(chartBlock(barSpec))]);
  assert.match(html, /data-testid="chat-chart"/);
  assert.equal(count(figureOf(html), /<rect /g), 2);
  assert.match(html, /<figcaption[^>]*>Revenue<\/figcaption>/);
  assert.match(html, /role="img" aria-label="Bar chart: Revenue"/);
  assert.match(html, /<table[^>]*data-testid="chat-chart-data"/);
  assert.ok(!html.includes("chat-code-copy-button"));
});

test("each chart kind draws, in Korean too", () => {
  const kinds = [
    { type: "line", labels: ["a", "b", "c"], series: [{ name: "x", values: [1, 3, 2] }, { name: "y", values: [2, 2, 4] }] },
    { type: "area", labels: ["a", "b"], series: [{ values: [1, 3] }] },
    { type: "pie", labels: ["a", "b", "c"], series: [{ values: [1, 2, 3] }] },
    { type: "scatter", series: [{ name: "g", points: [[1, 2], [2, 5], [3, 4]] }] },
  ];
  for (const spec of kinds) {
    const html = render([question, answerWith(chartBlock(spec))], {}, "ko");
    assert.match(html, new RegExp(`data-chart-type="${spec.type}"`));
    assert.ok(!html.includes("NaN"), spec.type);
  }
  assert.match(render([question, answerWith(chartBlock(kinds[2]))], {}, "ko"), /원형 차트/);
  assert.equal(count(figureOf(render([question, answerWith(chartBlock(kinds[3]))])), /<circle /g), 3);
});

test("a chart is code while the answer streams, and when its spec is invalid", () => {
  const streaming = render([question, answerWith(chartBlock(barSpec))], { isSending: true });
  assert.ok(!streaming.includes("chat-chart"));
  assert.match(streaming, /data-testid="chat-code-copy-button"/);
  const invalid = render([question, answerWith(chartBlock({ type: "bar", labels: ["a"], series: [{ values: [1, 2] }] }))]);
  assert.ok(!invalid.includes("data-testid=\"chat-chart\""));
  assert.match(invalid, /data-testid="chat-code-copy-button"/);
});

/* --------------------------------------------------------------- branch */

test("every finished answer offers a branch when Chat wires it, and nothing else does", () => {
  const messages: Message[] = [
    { id: "u0", role: "user", content: "Older" },
    answerWith("Older answer", { id: "a0" }),
    question,
    answerWith("Newest answer"),
  ];
  const html = render(messages, { onBranchFromAnswer: async () => {} });
  assert.equal(count(html, /data-testid="chat-branch-answer"/g), 2);
  assert.match(html, /Branch to a new chat/);
  assert.match(render(messages, { onBranchFromAnswer: async () => {} }, "ko"), /여기서 새 대화로/);
  // Review and the model panels never pass it.
  assert.ok(!render(messages).includes("chat-branch-answer"));
  // A stopped answer and an imported transcript are not branch points.
  assert.ok(!render([question, answerWith("Half", { status: "incomplete" })], { onBranchFromAnswer: async () => {} }).includes("chat-branch-answer"));
});

test("a branch is not offered while an answer is streaming, and is disabled while sending", () => {
  const messages: Message[] = [question, answerWith("Done"), { id: "u2", role: "user", content: "Next" }, answerWith("Partial", { id: "a2" })];
  const streaming = render(messages, { onBranchFromAnswer: async () => {}, isSending: true });
  assert.equal(count(streaming, /data-testid="chat-branch-answer"/g), 1, "only the finished answer");
  assert.match(streaming, /data-testid="chat-branch-answer"[^>]*disabled=""/);
});

/* --------------------------------------------- regenerate, edit, quote */

test("the newest finished answer offers regenerate and another model; older ones do not", () => {
  const messages: Message[] = [
    { id: "u0", role: "user", content: "Older" },
    answerWith("Older answer", { id: "a0" }),
    question,
    answerWith("Newest answer"),
  ];
  const html = render(messages, { onRegenerateAnswer: () => {}, onChooseAnotherModel: () => {} });
  assert.equal(count(html, /data-testid="chat-regenerate-answer"/g), 1);
  assert.equal(count(html, /data-testid="chat-regenerate-another-model"/g), 1);
  assert.ok(html.indexOf("Newest answer") < html.indexOf("chat-regenerate-answer"));
  assert.ok(html.indexOf("Older answer") < html.indexOf("Newest answer"));
  assert.match(html, /Regenerate/);
  assert.match(html, /Try another model/);
  // Without the Chat handlers (Review, or a conversation that cannot resend) nothing is offered.
  assert.ok(!render(messages).includes("chat-regenerate-answer"));
});

test("regenerate and edit are withheld while generating and for turns with their own retry", () => {
  const props = { onRegenerateAnswer: () => {}, onEditLastQuestion: () => {} };
  const busy = render([question, answerWith("Done")], { ...props, isSending: true });
  assert.ok(!busy.includes('data-testid="chat-regenerate-answer"') || /data-testid="chat-regenerate-answer"[^>]*disabled/.test(busy));
  assert.match(busy, /data-testid="chat-edit-last-question"[^>]*disabled/);
  for (const extra of [{ status: "error" as const }, { status: "cancelled" as const }]) {
    const html = render([question, answerWith("Partial", extra)], props);
    assert.ok(!html.includes("chat-regenerate-answer"), JSON.stringify(extra));
    assert.ok(!html.includes("chat-edit-last-question"), JSON.stringify(extra));
  }
});

test("only the newest text-only question can be edited", () => {
  const onEdit = () => {};
  const html = render(
    [{ id: "u0", role: "user", content: "Older" }, answerWith("Older answer", { id: "a0" }), question, answerWith("New")],
    { onEditLastQuestion: onEdit }
  );
  assert.equal(count(html, /data-testid="chat-edit-last-question"/g), 1);
  assert.ok(html.indexOf("Question") < html.indexOf("chat-edit-last-question"));

  const withFile: Message = {
    ...question,
    attachments: [{ id: "f1", name: "f.pdf", mediaType: "application/pdf", size: 10, kind: "file" } as never],
  };
  const fileHtml = render([withFile, answerWith("New")], { onEditLastQuestion: onEdit, onRegenerateAnswer: () => {} });
  assert.ok(!fileHtml.includes("chat-edit-last-question"));
  // A resend carries no files, so regenerate is not offered either.
  assert.ok(!fileHtml.includes("chat-regenerate-answer"));
});

test("the Korean labels are Korean", () => {
  const html = render([question, answerWith("답변")], { onRegenerateAnswer: () => {}, onChooseAnotherModel: () => {} }, "ko");
  assert.match(html, /다시 생성/);
  assert.match(html, /다른 모델로 다시/);
});

/* -------------------------------------------------------------- credits */

test("a settled Chat answer shows what it was charged, and Review shows nothing", () => {
  const messages: Message[] = [question, answerWith("Done", { settledCredits: 3 })];
  const html = render(messages, { showAnswerCredits: true });
  assert.equal(count(html, /data-testid="chat-answer-credits"/g), 1);
  assert.match(html, /3 credits/);
  assert.match(html, /title="Credits charged for this answer"/);
  assert.ok(html.indexOf("Done") < html.indexOf("chat-answer-credits"));
  assert.match(render([question, answerWith("Done", { settledCredits: 1 })], { showAnswerCredits: true }), /1 credit</);
  assert.match(render(messages, { showAnswerCredits: true }, "ko"), /3크레딧/);
  // Review and the model panels never turn it on, whatever the message carries.
  assert.ok(!render(messages).includes("chat-answer-credits"));
});

test("no figure while streaming, for nothing charged, or without a settled value", () => {
  const streaming = render([question, answerWith("Partial", { settledCredits: 3 })], {
    showAnswerCredits: true,
    isSending: true,
  });
  assert.ok(!streaming.includes("chat-answer-credits"));
  for (const extra of [{ settledCredits: 0 }, {}, { settledCredits: Number.NaN }]) {
    const html = render([question, answerWith("Done", extra)], { showAnswerCredits: true });
    assert.ok(!html.includes("chat-answer-credits"), JSON.stringify(extra));
  }
  // The user's own question never carries one.
  const asked = render([{ ...question, settledCredits: 4 } as Message], { showAnswerCredits: true });
  assert.ok(!asked.includes("chat-answer-credits"));
});

test("a stopped answer that was charged shows its figure without the tools row", () => {
  const html = render([question, answerWith("Half an answer", { status: "cancelled", settledCredits: 2 })], {
    showAnswerCredits: true,
    onBranchFromAnswer: async () => {},
  });
  assert.equal(count(html, /data-testid="chat-answer-credits"/g), 1);
  assert.match(html, /2 credits/);
  assert.ok(!html.includes("chat-branch-answer"));
});
