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
test("Chat error cards offer a direct retry and a model picker beside restore", () => {
  const renderChat = (messages: Message[]) => renderToStaticMarkup(
    <SessionProvider session={null}>
      <LanguageProvider initialLang="en">
        <ChatMessageList messages={messages} currentChatId="c" onRestoreQuestion={() => {}}
          onRetryQuestion={() => {}} onChooseAnotherModel={() => {}} />
      </LanguageProvider>
    </SessionProvider>
  );
  const failed: Message = { id: "a", role: "assistant", status: "error", content: "",
    recoveryNotice: "Connection interrupted" };
  const html = renderChat([question, failed]);
  assert.match(html, /data-testid="retry-chat-question"/);
  assert.match(html, /data-testid="chat-error-choose-model"[^>]*>.*Choose another model/);
  assert.match(html, /restore-chat-question/);
  assert.doesNotMatch(html, /Send separately to request a new answer/);
  assert.ok(html.indexOf("retry-chat-question") < html.indexOf("restore-chat-question"));
  // A resend carries no files: that question is only restored.
  const withFile = renderChat([{ ...question, attachments: [{ id: "f", name: "f.pdf", mediaType: "application/pdf", size: 1, kind: "file" }] }, failed]);
  assert.doesNotMatch(withFile, /retry-chat-question/);
  assert.match(withFile, /restore-chat-question/);
  // A trailing unanswered question and the legacy surface are unchanged.
  assert.doesNotMatch(renderChat([question]), /retry-chat-question/);
  assert.doesNotMatch(render([question, failed]), /retry-chat-question|chat-error-choose-model/);
});
test("legacy Review errors still split their existing title and auxiliary details", () => {
  const html = render([question, { id: "a", role: "assistant", status: "error",
    content: "Existing error\nTrace ID: review" }], false);
  assert.match(html, /Existing error/);
  assert.match(html, /Trace ID: review/);
  assert.doesNotMatch(html, /chat-recovery-notice|restore-chat-question/);
});

test("Chat attachment errors classify the recovery notice, not an empty or unrelated partial body", () => {
  for (const content of ["", "Kept partial answer"]) {
    const html = render([question, { id: "a", role: "assistant", status: "error", content,
      errorHadAttachments: true, recoveryNotice: "Invalid PDF document" }]);
    assert.match(html, /Attachment troubleshooting/);
  }
  const generic = render([question, { id: "a", role: "assistant", status: "error",
    content: "This partial answer mentions PDF and invalid inputs", errorHadAttachments: true,
    recoveryNotice: "Connection interrupted" }]);
  assert.doesNotMatch(generic, /Attachment troubleshooting/);
  const review = render([question, { id: "a", role: "assistant", status: "error",
    content: "Invalid PDF document", errorHadAttachments: true }], false);
  assert.match(review, /Attachment troubleshooting/);
});

test("Chat error cards offer the model picker beside question restoration; Review does not", () => {
  const failed: Message = { id: "a", role: "assistant", status: "error", content: "",
    recoveryNotice: "Connection interrupted" };
  const withPicker = (recovering: boolean, retry?: () => void) => renderToStaticMarkup(
    <SessionProvider session={null}>
      <LanguageProvider initialLang="en">
        <ChatMessageList messages={[question, failed]} currentChatId="c"
          onRestoreQuestion={recovering ? () => {} : undefined}
          onRetryLast={retry} onRequestCloseModel={() => {}} />
      </LanguageProvider>
    </SessionProvider>
  );
  const chat = withPicker(true);
  assert.equal((chat.match(/data-testid="chat-error-choose-model"/g) ?? []).length, 1);
  assert.match(chat, /restore-chat-question/);
  assert.doesNotMatch(withPicker(false, () => {}), /chat-error-choose-model/);
  assert.doesNotMatch(render([question, failed]), /chat-error-choose-model/);
});
