import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionProvider } from "next-auth/react";
import { LanguageProvider } from "@/components/LanguageProvider";
import { ChatMessageList } from "@/components/chat/ChatMessageList";
import type { Message } from "@/components/chat/types";

/*
  docs/policy/generated-artifacts.md section 8 (2026-11-27): a turn whose only
  output is a file the server kept is stored with an empty body. The card is
  the answer, and the sentence above it is this screen's, in the reader's
  language -- never an endless "generating" indicator.
*/

const question: Message = { id: "u", role: "user", content: "Make me a spreadsheet" };
const readyFile = {
  id: "row_1",
  ordinal: 0,
  format: "xlsx" as const,
  filename: "budget.xlsx",
  mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  byteSize: 2048,
  status: "ready" as const,
  modelId: "claude-haiku-4-5",
};
const render = (messages: Message[], lang: "en" | "ko" = "en") =>
  renderToStaticMarkup(
    <SessionProvider session={null}>
      <LanguageProvider initialLang={lang}>
        <ChatMessageList messages={messages} currentChatId="c" isSending={false} />
      </LanguageProvider>
    </SessionProvider>
  );

test("a file-only answer shows the card under the screen's own sentence", () => {
  const html = render([question, { id: "a", role: "assistant", status: "normal",
    content: "", modelId: "claude-haiku-4-5", artifacts: [readyFile] }]);
  assert.match(html, /Here is the file you asked for\./);
  assert.match(html, /budget\.xlsx/);
  assert.doesNotMatch(html, /Generating a response/);
});

test("the sentence follows the reader's language, not the server's", () => {
  const html = render([question, { id: "a", role: "assistant", status: "normal",
    content: "", modelId: "claude-haiku-4-5", artifacts: [readyFile] }], "ko");
  assert.match(html, /요청하신 파일을 만들었습니다\./);
});

test("an answer with prose keeps its own words above the card", () => {
  const html = render([question, { id: "a", role: "assistant", status: "normal",
    content: "Your budget is ready.", modelId: "claude-haiku-4-5", artifacts: [readyFile] }]);
  assert.match(html, /Your budget is ready\./);
  assert.doesNotMatch(html, /Here is the file you asked for\./);
});

test("a failure card alone is shown as the answer, with no sentence and no empty-response error", () => {
  const html = render([question, { id: "a", role: "assistant", status: "incomplete",
    content: "", modelId: "claude-haiku-4-5", artifacts: [{
      ...readyFile, status: "failed" as const, failureCode: "turn_incomplete" as const,
      format: "txt" as const, filename: "generated.txt", byteSize: 0,
    }] }]);
  assert.match(html, /data-testid="generated-artifact-card"[^>]*data-artifact-status="failed"/);
  assert.match(html, /The answer ended before the file was finished\./);
  assert.match(html, /data-testid="response-incomplete-notice"/);
  assert.doesNotMatch(html, /Here is the file you asked for\./);
  assert.doesNotMatch(html, /Generating a response/);
});
