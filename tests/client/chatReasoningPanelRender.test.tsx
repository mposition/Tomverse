import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionProvider } from "next-auth/react";
import { LanguageProvider } from "@/components/LanguageProvider";
import { ChatMessageList } from "@/components/chat/ChatMessageList";
import type { Message } from "@/components/chat/types";
import { withStoredReasoning, storedChatReasoning } from "@/lib/chatReasoningDisplay";

/*
  The reasoning summary above an answer: shown while the model thinks, folded
  to "Thought for N seconds" once the answer starts, and still there after a
  reload. Rendered through the real message list so the card is proven to sit
  where the list puts it, and a message with no summary is proven unchanged.
*/

const question: Message = { id: "u", role: "user", content: "Question" };
const render = (messages: Message[], isSending = false, lang: "en" | "ko" = "en") =>
  renderToStaticMarkup(
    <SessionProvider session={null}>
      <LanguageProvider initialLang={lang}>
        <ChatMessageList messages={messages} currentChatId="c" isSending={isSending} />
      </LanguageProvider>
    </SessionProvider>
  );
const answer = (extra: Partial<Message>): Message => ({
  id: "a",
  role: "assistant",
  content: "",
  status: "normal",
  modelId: "claude-haiku-4-5",
  ...extra,
});

test("while the model thinks the summary streams in an open card and no 'connecting' text competes with it", () => {
  const html = render(
    [question, answer({ reasoning: { text: "**Plan**\n\nCompare both options.", done: false, durationMs: null, truncated: false } })],
    true
  );
  assert.match(html, /data-testid="chat-reasoning"[^>]*data-reasoning-state="thinking"/);
  assert.match(html, />Thinking</);
  assert.match(html, /data-testid="chat-reasoning-toggle"[^>]*aria-expanded="true"/);
  assert.match(html, /data-testid="chat-reasoning-body"/);
  assert.match(html, /<strong>Plan<\/strong>/);
  assert.match(html, /Compare both options\./);
  assert.doesNotMatch(html, /Connecting/i);
});

test("a model that reasons without sending text still shows that it is thinking", () => {
  const html = render([question, answer({ reasoning: { text: "", done: false, durationMs: null, truncated: false } })], true);
  assert.match(html, /data-reasoning-state="thinking"/);
  assert.match(html, /data-testid="chat-reasoning-label"[^>]*>[\s\S]*Thinking/);
  // Nothing to open, so no control that opens nothing.
  assert.doesNotMatch(html, /chat-reasoning-toggle/);
  assert.doesNotMatch(html, /chat-reasoning-body/);
});

test("once the answer has started the card folds into one line with the time, and can be opened", () => {
  const html = render([
    question,
    answer({ content: "The answer.", reasoning: { text: "Weighed it up.", done: true, durationMs: 12_400, truncated: false } }),
  ]);
  assert.match(html, /data-reasoning-state="done"/);
  assert.match(html, /Thought for 12s/);
  assert.match(html, /data-testid="chat-reasoning-toggle"[^>]*aria-expanded="false"/);
  // Folded: the summary text is not in the page until it is opened.
  assert.doesNotMatch(html, /Weighed it up\./);
  assert.match(html, /The answer\./);
});

test("the one line is in the reader's language", () => {
  const html = render(
    [question, answer({ content: "답변", reasoning: { text: "생각", done: true, durationMs: 7_000, truncated: false } })],
    false,
    "ko"
  );
  assert.match(html, /7초 동안 생각함/);
});

test("a reloaded answer keeps its folded line from the saved copy, with the time", () => {
  const searchMetadata = withStoredReasoning(
    { requested: false, supported: true, executed: false, provider: "anthropic", citations: [] },
    storedChatReasoning({ text: "Saved summary.", durationMs: 5_000, truncated: false })
  );
  const html = render([question, answer({ content: "Answer", searchMetadata: searchMetadata as Message["searchMetadata"] })]);
  assert.match(html, /Thought for 5s/);
  assert.match(html, /data-testid="chat-reasoning-toggle"[^>]*aria-expanded="false"/);
});

test("an answer with no summary renders exactly as before", () => {
  const html = render([question, answer({ content: "Plain answer." })]);
  assert.doesNotMatch(html, /chat-reasoning/);
  assert.match(html, /Plain answer\./);
});

test("an interrupted card is not left saying it is still thinking", () => {
  // The stream broke before 'done'; the turn is no longer generating.
  const html = render([
    question,
    answer({ content: "Half", status: "incomplete", reasoning: { text: "Partial thought", done: false, durationMs: null, truncated: false } }),
  ]);
  assert.match(html, /data-reasoning-state="done"/);
  assert.doesNotMatch(html, />Thinking</);
});

test("the summary is rendered as the answer is: no links, no images, no raw HTML, no live region", () => {
  const html = render(
    [
      question,
      answer({
        reasoning: {
          text: "See [docs](https://evil.example/steal) and ![t](https://evil.example/pixel.png)\n\n<script>alert(1)</script>\n\n<img src=\"https://evil.example/raw.png\">",
          done: false,
          durationMs: null,
          truncated: true,
        },
      }),
    ],
    true
  );
  const card = html.slice(html.indexOf('data-testid="chat-reasoning"'), html.indexOf('data-testid="chat-reasoning-body"') + 4000);
  assert.doesNotMatch(card, /<a\b/);
  assert.doesNotMatch(card, /<img\b/);
  assert.doesNotMatch(card, /<script\b/);
  assert.doesNotMatch(card, /href=/);
  assert.doesNotMatch(card, /evil\.example\/pixel/);
  assert.match(card, /docs/);
  assert.match(card, /role="note"/);
  // The text reached the page, so it is read when a reader moves to it, not announced piece by piece.
  assert.doesNotMatch(card, /aria-live|role="status"|role="alert"/);
  // A cut summary says so.
  assert.match(card, /…/);
});
