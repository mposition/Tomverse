import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionProvider } from "next-auth/react";
import { LanguageProvider } from "@/components/LanguageProvider";
import { ChatMessageList } from "@/components/chat/ChatMessageList";
import type { Message } from "@/components/chat/types";

const question: Message = { id: "u", role: "user", content: "Specific question" };
const render = (messages: Message[], recovering = true, isSending = false) =>
  renderToStaticMarkup(
    <SessionProvider session={null}>
      <LanguageProvider initialLang="en">
        <ChatMessageList messages={messages} currentChatId="c" isSending={isSending}
          onRestoreQuestion={recovering ? () => {} : undefined} />
      </LanguageProvider>
    </SessionProvider>
  );

test("transport error preserves the complete markdown body and separates its notice", () => {
  const html = render([question, { id: "a", role: "assistant", modelId: "gpt-5-6-luna",
    status: "error", content: "First paragraph\n\nSecond **paragraph**",
    recoveryNotice: "Connection interrupted\nTrace ID: local-trace" }]);
  assert.match(html, /First paragraph/);
  assert.match(html, /Second <strong>paragraph<\/strong>/);
  assert.match(html, /data-testid="chat-recovery-notice"[^>]*>Connection interrupted/);
  assert.match(html, /data-testid="chat-error-auxiliary-info"/);
  assert.match(html, /Trace ID: local-trace/);
  assert.equal((html.match(/data-testid="restore-chat-question"/g) ?? []).length, 1);
});
test("error before text renders the notice without a phantom generating indicator", () => {
  const html = render([question, { id: "a", role: "assistant", status: "error",
    content: "", recoveryNotice: "Unable to connect" }]);
  assert.match(html, /Unable to connect/);
  assert.doesNotMatch(html, /responseGenerating|Generating a response/);
  assert.match(html, /restore-chat-question/);
});
test("cancelled and trailing pre-saved questions offer explicit restoration, not active ones", () => {
  assert.match(render([question]), /restore-chat-question/);
  assert.match(render([question, { id: "a", role: "assistant", status: "cancelled", content: "Kept partial" }]), /restore-chat-question/);
  assert.doesNotMatch(render([question], true, true), /restore-chat-question/);
  assert.doesNotMatch(render([question], false), /restore-chat-question/);
});
test("legacy Review errors still split their existing title and auxiliary details", () => {
  const html = render([question, { id: "a", role: "assistant", status: "error",
    content: "Existing error\nTrace ID: review" }], false);
  assert.match(html, /Existing error/);
  assert.match(html, /Trace ID: review/);
  assert.doesNotMatch(html, /chat-recovery-notice|restore-chat-question/);
});
