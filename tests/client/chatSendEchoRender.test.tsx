import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionProvider } from "next-auth/react";
import { LanguageProvider } from "@/components/LanguageProvider";
import { ChatMessageList, type SendEcho } from "@/components/chat/ChatMessageList";
import type { Message } from "@/components/chat/types";

const earlier: Message[] = [
  { id: "u1", role: "user", content: "Earlier question" },
  { id: "a1", role: "assistant", modelId: "gpt-5-6-luna", content: "Earlier answer" },
];
const render = (messages: Message[], sendEcho: SendEcho | null) =>
  renderToStaticMarkup(
    <SessionProvider session={null}>
      <LanguageProvider initialLang="en">
        <ChatMessageList messages={messages} currentChatId="c" sendEcho={sendEcho}
          onRestoreQuestion={() => {}} />
      </LanguageProvider>
    </SessionProvider>
  );

test("a pressed send shows the question and a waiting line below the transcript at once", () => {
  const html = render(earlier, { text: "New question\nsecond line", attachmentCount: 0 });
  assert.equal((html.match(/data-testid="chat-send-echo"/g) ?? []).length, 1);
  assert.ok(html.indexOf("Earlier answer") < html.indexOf("chat-send-echo"));
  assert.match(html, /New question\nsecond line/);
  assert.match(html, /Sending your question/);
  // A picture of the question only: no attachment line, and none of the
  // actions a saved user turn offers.
  assert.doesNotMatch(html.slice(html.indexOf("chat-send-echo")), /restore-chat-question/);
  assert.doesNotMatch(html.slice(html.indexOf("chat-send-echo")), /lucide-paperclip/);
});

test("an echo with files says how many, and an empty conversation still shows it", () => {
  const html = render([], { text: "", attachmentCount: 2 });
  assert.match(html, /data-testid="chat-send-echo"/);
  assert.match(html, /lucide-paperclip/);
  assert.match(html, />2</);
});

test("no echo renders nothing extra", () => {
  assert.doesNotMatch(render(earlier, null), /chat-send-echo|Sending your question/);
});
