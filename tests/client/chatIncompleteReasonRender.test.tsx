import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionProvider } from "next-auth/react";
import { LanguageProvider } from "@/components/LanguageProvider";
import { ChatMessageList } from "@/components/chat/ChatMessageList";
import type { Message } from "@/components/chat/types";

/*
  S2: an answer the provider broke off mid-stream is `incomplete` like one
  that ran out of room, but it must not be explained as the output ceiling.
  The trailer's reason picks the notice. A reloaded answer has no reason --
  neither the Message nor the attempt row stores one -- so it says only that
  the answer did not finish, rather than claiming the output ceiling for an
  answer the provider may have broken off (review r-20261127-041211-93f81f).
*/

const question: Message = { id: "u", role: "user", content: "Question" };
const render = (messages: Message[]) =>
  renderToStaticMarkup(
    <SessionProvider session={null}>
      <LanguageProvider initialLang="en">
        <ChatMessageList messages={messages} currentChatId="c" isSending={false} />
      </LanguageProvider>
    </SessionProvider>
  );
const incomplete = (extra: Partial<Message>): Message => ({
  id: "a", role: "assistant", status: "incomplete", content: "Half an answer",
  modelId: "claude-haiku-4-5", ...extra,
});

test("an interrupted answer keeps its text and says the provider cut it off", () => {
  const html = render([question, incomplete({ incompleteReason: "interrupted" })]);
  assert.match(html, /Half an answer/);
  assert.match(html, /data-testid="response-incomplete-notice"[^>]*>The response was cut off by a problem on the AI provider&#x27;s side/);
  assert.doesNotMatch(html, /output length limit/);
});

test("a length-truncated answer keeps the ceiling notice", () => {
  const html = render([question, incomplete({ incompleteReason: "length" })]);
  assert.match(html, /data-testid="response-incomplete-notice"[^>]*>The response was cut off by the output length limit/);
});

test("a reloaded incomplete answer, whose reason is unknown, does not claim a cause", () => {
  const html = render([question, incomplete({})]);
  assert.match(html, /Half an answer/);
  assert.match(html, /data-testid="response-incomplete-notice"[^>]*>The response did not finish\./);
  assert.doesNotMatch(html, /output length limit/);
  assert.doesNotMatch(html, /AI provider/);
});
