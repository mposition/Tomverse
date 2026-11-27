import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionProvider } from "next-auth/react";
import { LanguageProvider } from "@/components/LanguageProvider";
import { ChatMessageList } from "@/components/chat/ChatMessageList";
import type { Message } from "@/components/chat/types";

/*
  S3: an answer the server streamed and then could not save (the trailer's
  `notSaved`, on a turn with no durable attempt row) keeps its text and says,
  under it and in the reader's language, that a reload will not show it.
*/

const question: Message = { id: "u", role: "user", content: "Question" };
const render = (messages: Message[], lang: "en" | "ko" = "en") =>
  renderToStaticMarkup(
    <SessionProvider session={null}>
      <LanguageProvider initialLang={lang}>
        <ChatMessageList messages={messages} currentChatId="c" isSending={false} />
      </LanguageProvider>
    </SessionProvider>
  );

test("an unsaved answer keeps its body and shows the not-saved notice", () => {
  const html = render([question, { id: "a", role: "assistant", status: "normal",
    content: "The full answer.", modelId: "claude-haiku-4-5", notSaved: true }]);
  assert.match(html, /The full answer\./);
  assert.match(html, /data-testid="response-not-saved-notice"[^>]*>This answer was not saved\./);
});

test("the notice is localized", () => {
  const html = render([question, { id: "a", role: "assistant", status: "normal",
    content: "답변", modelId: "claude-haiku-4-5", notSaved: true }], "ko");
  assert.match(html, /이 답변은 저장되지 않았습니다\./);
});

test("a saved answer shows no such notice", () => {
  const html = render([question, { id: "a", role: "assistant", status: "normal",
    content: "The full answer.", modelId: "claude-haiku-4-5" }]);
  assert.doesNotMatch(html, /response-not-saved-notice/);
});
