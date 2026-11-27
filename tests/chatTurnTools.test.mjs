import assert from "node:assert/strict";
import test from "node:test";

import { plainTextForSpeech, splitSpeechChunks } from "../lib/chatSpeechText.ts";
import { appendQuoteToDraft, formatQuote } from "../lib/chatQuote.ts";
import { shouldNotifyAnswerReady } from "../lib/answerNotification.ts";
import {
  conversationExportContentDisposition,
} from "../lib/exportConversation.ts";
import {
  formatConversationHeaderMarkdown,
  formatExportMessageMarkdown,
  formatExportMessagePageMarkdown,
} from "../lib/exportConversationMarkdown.ts";
import { chatTurnToolsCopy } from "../locales/chatTurnTools.ts";
import { SUPPORTED_LANGUAGES } from "../lib/language.ts";

/* ------------------------------------------------------------ read aloud */

test("read aloud skips code, formulas and Markdown symbols", () => {
  const spoken = plainTextForSpeech(
    [
      "# Title",
      "",
      "Some **bold** text and a [link](https://example.com/x) with `inline`.",
      "",
      "```js",
      "const secret = 1;",
      "```",
      "",
      "- first item",
      "2. second item",
      "",
      "$$",
      "x^2 + y^2",
      "$$",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "> quoted line",
    ].join("\n")
  );
  assert.ok(!spoken.includes("```"));
  assert.ok(!spoken.includes("const secret"));
  assert.ok(!spoken.includes("x^2"));
  assert.ok(!spoken.includes("https://"));
  assert.ok(!/[#*`|>]/.test(spoken), spoken);
  for (const word of ["Title", "bold", "link", "inline", "first item", "second item", "quoted line"]) {
    assert.ok(spoken.includes(word), `${word} in ${spoken}`);
  }
  assert.match(spoken, /a, b/);
});

test("an unterminated code fence is not read either", () => {
  const spoken = plainTextForSpeech("Before\n\n```py\nprint('partial')");
  assert.equal(spoken, "Before");
});

test("read aloud splits long text into sentence-sized pieces", () => {
  const text = `${"Sentence number one is here. ".repeat(20)}\nSecond paragraph without a stop`;
  const chunks = splitSpeechChunks(plainTextForSpeech(text), 100);
  assert.ok(chunks.length > 5);
  assert.ok(chunks.every((chunk) => chunk.length <= 100));
  assert.equal(chunks.at(-1), "Second paragraph without a stop");
  // One unbroken run longer than the limit is still cut.
  assert.ok(splitSpeechChunks("x".repeat(450), 180).every((chunk) => chunk.length <= 180));
  assert.deepEqual(splitSpeechChunks(""), []);
  assert.deepEqual(splitSpeechChunks("한국어 문장입니다. 두 번째 문장입니다."), ["한국어 문장입니다. 두 번째 문장입니다."]);
});

/* ------------------------------------------------------------- quoting */

test("a selection becomes a Markdown quote", () => {
  assert.equal(formatQuote("one\ntwo"), "> one\n> two");
  assert.equal(formatQuote("  a\n\nb  "), "> a\n>\n> b");
  assert.equal(formatQuote("   "), "");
  assert.equal(formatQuote("x".repeat(5_000)).length, "> ".length + 2_000);
});

test("a quote lands after the draft and leaves room to reply", () => {
  assert.equal(appendQuoteToDraft("", "> q"), "> q\n\n");
  assert.equal(appendQuoteToDraft("my text", "> q"), "my text\n\n> q\n\n");
  assert.equal(appendQuoteToDraft("my text\n", "> q"), "my text\n\n> q\n\n");
  assert.equal(appendQuoteToDraft("my text\n\n", "> q"), "my text\n\n> q\n\n");
  assert.equal(appendQuoteToDraft("kept", ""), "kept");
});

/* --------------------------------------------------- Markdown download */

test("Markdown export keeps the transcript and escapes the title", () => {
  const header = formatConversationHeaderMarkdown(
    { title: "Plan *A*\n# forged", createdAt: "2026-01-02T03:04:05.000Z", productKey: "chat" },
    "Personalised answers.",
    ["Continued from X."]
  );
  assert.match(header, /^# Plan \\\*A\\\* \\# forged\n/);
  assert.match(header, /\*Tomverse Chat Export · 2026-01-02T03:04:05.000Z\*/);
  assert.match(header, /> Personalised answers\./);
  assert.match(header, /> Continued from X\./);
  assert.equal(header.split("\n").filter((line) => line.startsWith("# ")).length, 1);

  const user = formatExportMessageMarkdown({ role: "user", content: "Hi\n\n```js\nx\n```", createdAt: "2026-01-02T03:04:05.000Z" });
  assert.match(user, /^---\n\n## User · 2026-01-02T03:04:05.000Z\n\nHi/);
  assert.ok(user.includes("```js\nx\n```"));
  assert.match(formatExportMessageMarkdown({ role: "assistant", content: "ok" }), /## Assistant\n/);
});

test("Markdown export pages written back to back keep a blank line before every rule", () => {
  // The route streams one page per read; a page's last paragraph must not sit on
  // the line above the next page's `---`, which would make it a setext heading.
  const firstPage = formatExportMessagePageMarkdown([
    { role: "user", content: "a question" },
    { role: "assistant", content: "the last paragraph of a page" },
  ]);
  const secondPage = formatExportMessagePageMarkdown([{ role: "user", content: "next" }]);
  const file = firstPage + secondPage;
  assert.equal((file.match(/^---$/gm) ?? []).length, 3);
  for (const match of file.matchAll(/^---$/gm)) {
    const before = file.slice(0, match.index);
    assert.ok(before === "" || before.endsWith("\n\n"), `a rule follows a blank line: ${JSON.stringify(before.slice(-40))}`);
  }
  assert.ok(file.includes("the last paragraph of a page\n\n---"));
});

test("Markdown downloads are named .md, text downloads stay .txt", () => {
  assert.match(conversationExportContentDisposition("Plan"), /filename="Plan\.txt"/);
  const md = conversationExportContentDisposition("Plan", ".md");
  assert.match(md, /filename="Plan\.md"/);
  assert.match(md, /filename\*=UTF-8''Plan\.md/);
  const korean = conversationExportContentDisposition("한국어 계획", ".md");
  assert.match(korean, /filename="conversation\.md"/);
  assert.match(korean, /filename\*=UTF-8''%ED%95%9C%EA%B5%AD%EC%96%B4%20%EA%B3%84%ED%9A%8D\.md/);
});

/* -------------------------------------------------------- notification */

test("a notification needs the switch, permission, a hidden tab and a finished answer", () => {
  const ready = {
    enabled: true,
    permission: "granted",
    documentHidden: true,
    wasSending: true,
    isSending: false,
    lastAnswer: { role: "assistant", status: "normal", content: "Done" },
  };
  assert.equal(shouldNotifyAnswerReady(ready), true);
  assert.equal(shouldNotifyAnswerReady({ ...ready, lastAnswer: { ...ready.lastAnswer, status: "incomplete" } }), true);
  for (const change of [
    { enabled: false },
    { permission: "default" },
    { permission: "denied" },
    { permission: "unsupported" },
    { documentHidden: false },
    { wasSending: false },
    { isSending: true },
    { lastAnswer: undefined },
    { lastAnswer: { role: "user", content: "q" } },
    { lastAnswer: { role: "assistant", status: "error", content: "x" } },
    { lastAnswer: { role: "assistant", status: "cancelled", content: "x" } },
    { lastAnswer: { role: "assistant", status: "normal", content: " " } },
  ]) {
    assert.equal(shouldNotifyAnswerReady({ ...ready, ...change }), false, JSON.stringify(change));
  }
});

/* ------------------------------------------------------------- copy */

test("every Chat turn tool string exists in all eight languages", () => {
  const reference = Object.keys(chatTurnToolsCopy.en).sort();
  assert.ok(reference.length > 20);
  assert.deepEqual(Object.keys(chatTurnToolsCopy).sort(), [...SUPPORTED_LANGUAGES].sort());
  for (const language of SUPPORTED_LANGUAGES) {
    const copy = chatTurnToolsCopy[language];
    assert.deepEqual(Object.keys(copy).sort(), reference, language);
    for (const [key, value] of Object.entries(copy)) {
      assert.ok(typeof value === "string" && value.trim().length > 0, `${language}.${key}`);
    }
  }
  // The Korean words are Korean, not the English fallback.
  assert.notEqual(chatTurnToolsCopy.ko.retryAnotherModel, chatTurnToolsCopy.en.retryAnotherModel);
});
