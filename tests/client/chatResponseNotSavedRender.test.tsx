import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionProvider } from "next-auth/react";
import { LanguageProvider } from "@/components/LanguageProvider";
import { ChatMessageList } from "@/components/chat/ChatMessageList";
import type { Message } from "@/components/chat/types";

/*
  S3: an answer the server streamed and then did not save (the trailer's
  `persistence`, on a turn with no durable attempt row) keeps its text and
  says, under it and in the reader's language, what a reload will show:
  `not_saved` -- the server checked that nothing landed; `unknown` -- it could
  not check, and a reload will tell.
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
    content: "The full answer.", modelId: "claude-haiku-4-5", persistence: "not_saved" }]);
  assert.match(html, /The full answer\./);
  assert.match(html, /data-testid="response-not-saved-notice"[^>]*>This answer was not saved\./);
});

test("the notice is localized", () => {
  const html = render([question, { id: "a", role: "assistant", status: "normal",
    content: "답변", modelId: "claude-haiku-4-5", persistence: "not_saved" }], "ko");
  assert.match(html, /이 답변은 저장되지 않았습니다\./);
});

test("an answer whose save could not be confirmed says so, and says to reload", () => {
  const html = render([question, { id: "a", role: "assistant", status: "normal",
    content: "The full answer.", modelId: "claude-haiku-4-5", persistence: "unknown" }]);
  assert.match(html, /data-persistence="unknown"[^>]*>We could not confirm that this answer was saved\. Reload to check\./);
  assert.doesNotMatch(html, /This answer was not saved/);
});

test("a saved answer shows no such notice", () => {
  const html = render([question, { id: "a", role: "assistant", status: "normal",
    content: "The full answer.", modelId: "claude-haiku-4-5" }]);
  assert.doesNotMatch(html, /response-not-saved-notice/);
});
