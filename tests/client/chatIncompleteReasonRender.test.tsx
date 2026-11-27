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
  The trailer's reason picks the notice; a reloaded answer has no reason and
  keeps the ceiling notice it always had.
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

test("a length-truncated or reloaded incomplete answer keeps the ceiling notice", () => {
  for (const extra of [{ incompleteReason: "length" as const }, {}]) {
    const html = render([question, incomplete(extra)]);
    assert.match(html, /data-testid="response-incomplete-notice"[^>]*>The response was cut off by the output length limit/);
  }
});
