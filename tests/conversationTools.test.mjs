import assert from "node:assert/strict";
import test from "node:test";

import { archivedListWhere } from "../lib/conversationArchive.ts";
import {
  CONVERSATION_SELECTION_LIMIT,
  requestConversationSelection,
  uniqueConversationIds,
} from "../lib/conversationBulkActions.ts";
import {
  ConversationPdfTooLarge,
  PDF_EXPORT_LIMITS,
  conversationPdfSpec,
  markdownToDocumentBlocks,
  renderConversationPdf,
} from "../lib/exportConversationPdf.ts";
import {
  SAVED_PROMPT_LIMITS,
  composerTextWithSavedPrompt,
  savedPromptCreateSchema,
  savedPromptUpdateSchema,
  suggestedSavedPromptTitle,
} from "../lib/savedPromptsCore.ts";
import { SUPPORTED_LANGUAGES } from "../lib/language.ts";
import { DESKTOP_APP_ORIGIN } from "../lib/nativeBearerGate.ts";
import { conversationToolsCopy } from "../locales/conversationTools.ts";
import { savedPromptsCopy } from "../locales/savedPrompts.ts";

/* ------------------------------------------------------------ the list */

test("the web's default list leaves archived rows out and asks for them by name", () => {
  const at = (query, headers = {}) => archivedListWhere(new Request(`https://tomverse.test/api/conversations${query}`, { headers }));
  assert.deepEqual(at(""), { archivedAt: null });
  assert.deepEqual(at("?archived=only"), { archivedAt: { not: null } });
  assert.deepEqual(at("?archived=include"), {});
  assert.deepEqual(at("?archived=anything"), { archivedAt: null });
});

test("the mobile and desktop apps keep their full list, archived rows included", () => {
  const at = (headers) => archivedListWhere(new Request("https://tomverse.test/api/conversations", { headers }));
  assert.deepEqual(at({ origin: DESKTOP_APP_ORIGIN }), {});
  assert.deepEqual(at({ authorization: "Bearer token" }), {});
});

/* ------------------------------------------------------------ selection */

test("a selection names each conversation once", () => {
  assert.deepEqual(uniqueConversationIds(["a", "b", "a", "c", "b"]), ["a", "b", "c"]);
  assert.equal(CONVERSATION_SELECTION_LIMIT, 50);
});

test("the browser's request sends one deduplicated list and reads the server's answer", async () => {
  const sent = [];
  const answer = await requestConversationSelection("delete", ["x", "x", "y"], async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return Response.json({ done: ["x"], skipped: [{ id: "y", reason: "locked" }] });
  });
  assert.deepEqual(sent, [{ url: "/api/conversations/bulk", body: { action: "delete", conversationIds: ["x", "y"] } }]);
  assert.deepEqual(answer, { ok: true, result: { done: ["x"], skipped: [{ id: "y", reason: "locked" }] } });

  const refused = await requestConversationSelection("archive", ["z"], async () =>
    Response.json({ code: "CONVERSATION_NOT_OWNED" }, { status: 403 })
  );
  assert.deepEqual(refused, { ok: false, status: 403, code: "CONVERSATION_NOT_OWNED" });
  const offline = await requestConversationSelection("archive", ["z"], async () => {
    throw new TypeError("network");
  });
  assert.deepEqual(offline, { ok: false, status: 0, code: null });
});

/* ------------------------------------------------------------ saved prompts */

test("a saved prompt needs a name and some text, within the limits", () => {
  assert.equal(savedPromptCreateSchema.safeParse({ title: " 요약 ", body: "  줄 맞춤 유지\n" }).data?.title, "요약");
  assert.equal(savedPromptCreateSchema.safeParse({ title: " 요약 ", body: "  줄 맞춤 유지\n" }).data?.body, "  줄 맞춤 유지\n");
  for (const body of [
    { title: "", body: "x" },
    { title: "x", body: "   " },
    { title: "x".repeat(SAVED_PROMPT_LIMITS.titleMax + 1), body: "x" },
    { title: "x", body: "x".repeat(SAVED_PROMPT_LIMITS.bodyMax + 1) },
    { title: "x", body: "x", extra: true },
  ]) {
    assert.equal(savedPromptCreateSchema.safeParse(body).success, false, JSON.stringify(body).slice(0, 60));
  }
  assert.equal(savedPromptUpdateSchema.safeParse({}).success, false);
  assert.equal(savedPromptUpdateSchema.safeParse({ title: "새 이름" }).success, true);
});

test("saving from the composer names the prompt after its first line", () => {
  assert.equal(suggestedSavedPromptTitle("\n  회의록을 세 줄로 요약해 줘\n두 번째 줄"), "회의록을 세 줄로 요약해 줘");
  const long = suggestedSavedPromptTitle("a".repeat(100));
  assert.ok(long.length <= 40 && long.endsWith("…"));
});

test("a picked prompt never replaces a draft: it goes after it", () => {
  assert.equal(composerTextWithSavedPrompt("", "프롬프트"), "프롬프트");
  assert.equal(composerTextWithSavedPrompt("   \n", "프롬프트"), "프롬프트");
  assert.equal(composerTextWithSavedPrompt("쓰던 글  \n", "프롬프트"), "쓰던 글\n\n프롬프트");
});

/* ------------------------------------------------------------ copy */

for (const [name, table] of [["conversationTools", conversationToolsCopy], ["savedPrompts", savedPromptsCopy]]) {
  test(`${name} copy exists in every language, with the same placeholders`, () => {
    const keys = Object.keys(table.en).sort();
    for (const language of SUPPORTED_LANGUAGES) {
      const copy = table[language];
      assert.ok(copy, `${language} is missing`);
      assert.deepEqual(Object.keys(copy).sort(), keys, language);
      for (const key of keys) {
        assert.ok(copy[key].trim().length > 0, `${language}.${key} is empty`);
        const placeholders = (value) => (value.match(/\{[a-z]+\}/g) ?? []).sort();
        assert.deepEqual(placeholders(copy[key]), placeholders(table.en[key]), `${language}.${key}`);
      }
    }
  });
}

/* ------------------------------------------------------------ PDF */

test("an answer's Markdown becomes headings, lists, quotes, code and a table", () => {
  const blocks = markdownToDocumentBlocks(
    [
      "# 결론",
      "",
      "본문에 **강조**와 [링크](https://example.com)가 있습니다.",
      "",
      "- 첫째",
      "  - 안쪽",
      "- 둘째",
      "",
      "1. 하나",
      "",
      "> 인용",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "| 항목 | 금액 |",
      "| --- | --- |",
      "| 예산 | 1,000 |",
      "",
      "$$",
      "x^2",
      "$$",
      "",
      "---",
    ].join("\n")
  );
  assert.deepEqual(blocks, [
    { type: "heading", level: 3, text: "결론" },
    { type: "paragraph", text: "본문에 강조와 링크 (https://example.com)가 있습니다." },
    { type: "bullets", items: ["첫째\n  • 안쪽", "둘째"] },
    { type: "numbers", items: ["하나"] },
    { type: "quote", text: "인용" },
    { type: "code", language: "ts", text: "const x = 1;" },
    { type: "table", columns: ["항목", "금액"], rows: [["예산", "1,000"]] },
    // Maths arrives as its source text.
    { type: "paragraph", text: "$$\nx^2\n$$" },
    { type: "divider" },
  ]);
});

/* ---- nothing is cut: each block limit is met by a block that holds it all */

const LONG = 21_000; // over the writer's 20,000-character text limit

test("a list item longer than the list writer holds is printed whole, with its marker", () => {
  const item = `${"가".repeat(LONG)}LIST_TAIL`;
  const blocks = markdownToDocumentBlocks(`- 짧은 항목\n- ${item}\n- 마지막`);
  assert.ok(blocks.every((block) => block.type === "paragraph"), JSON.stringify(blocks.map((block) => block.type)));
  const text = blocks.map((block) => block.text).join("\n");
  assert.ok(text.startsWith("• 짧은 항목"));
  assert.ok(text.includes("LIST_TAIL"));
  assert.ok(text.endsWith("• 마지막"));
  assert.equal(text.replace(/\n/g, "").length, `• 짧은 항목• ${item}• 마지막`.length);
});

test("a numbered list keeps its own numbers, its task boxes and its nested lists", () => {
  const blocks = markdownToDocumentBlocks("3. 셋\n4. 넷\n   1. 안쪽\n\n- [x] 끝냄\n- [ ] 남음");
  assert.deepEqual(blocks, [
    { type: "paragraph", text: "3. 셋" },
    { type: "paragraph", text: "4. 넷\n  1. 안쪽" },
    { type: "bullets", items: ["[x] 끝냄", "[ ] 남음"] },
  ]);
});

test("a table cell too long for the table writer, or a table too wide, becomes column: value lines", () => {
  const cell = `${"나".repeat(LONG)}CELL_TAIL`;
  const long = markdownToDocumentBlocks(`| 항목 | 설명 |\n| --- | --- |\n| A | ${cell} |`);
  assert.ok(long.every((block) => block.type === "paragraph"));
  const longText = long.map((block) => block.text).join("\n");
  assert.ok(longText.startsWith("항목: A\n설명: 나"));
  assert.ok(longText.includes("CELL_TAIL"));

  const columns = Array.from({ length: 25 }, (_, index) => `C${index + 1}`);
  const wide = markdownToDocumentBlocks(
    [`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, `| ${columns.map((name) => `v${name}`).join(" | ")} |`].join("\n")
  );
  assert.deepEqual(wide, [{ type: "paragraph", text: columns.map((name) => `${name}: v${name}`).join("\n") }]);
});

test("a heading too long for a heading, an image's address and a reference definition are all kept", () => {
  const heading = `${"제".repeat(400)}HEAD_TAIL`;
  const blocks = markdownToDocumentBlocks(
    `# ${heading}\n\n![도표](https://example.com/a.png)\n\n[가이드][1]\n\n[1]: https://example.com/guide "Guide"`
  );
  assert.deepEqual(blocks, [
    { type: "paragraph", text: heading },
    { type: "paragraph", text: "도표 (https://example.com/a.png)" },
    { type: "paragraph", text: "가이드" },
    { type: "paragraph", text: '[1]: https://example.com/guide "Guide"' },
  ]);
});

test("a quote keeps the list and code inside it as their own blocks", () => {
  const blocks = markdownToDocumentBlocks("> 인용 문단\n>\n> - 하나\n> - 둘\n>\n> ```\n> code()\n> ```");
  assert.deepEqual(blocks, [
    { type: "quote", text: "인용 문단" },
    { type: "bullets", items: ["하나", "둘"] },
    { type: "code", text: "code()" },
  ]);
});

test("the PDF carries the ends of a long item, a long cell, a wide table, a long heading and a long title", async () => {
  const columns = Array.from({ length: 25 }, (_, index) => `C${index + 1}`);
  const spec = conversationPdfSpec({
    title: `${"대화".repeat(200)}TITLE_TAIL`,
    headerLines: [],
    messages: [
      {
        role: "assistant",
        content: [
          `# ${"머".repeat(400)}HEAD_TAIL`,
          "",
          `- 짧음\n- ${"가 ".repeat(LONG / 2)}LIST_TAIL`,
          "",
          `| 항목 | 설명 |\n| --- | --- |\n| A | ${"나 ".repeat(LONG / 2)}CELL_TAIL |`,
          "",
          [`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, `| ${columns.map(() => "x").join(" | ")}WIDE_TAIL |`].join("\n"),
        ].join("\n"),
      },
    ],
  });
  const rendered = renderConversationPdf(spec);
  assert.equal(rendered.ok, true);
  const text = (await pdfText(rendered.bytes)).replace(/\s+/g, "");
  for (const tail of ["TITLE_TAIL", "HEAD_TAIL", "LIST_TAIL", "CELL_TAIL", "C25:xWIDE_TAIL"]) {
    assert.ok(text.includes(tail), `missing: ${tail}`);
  }
});

test("characters the PDF font cannot draw are reported, not passed off as a complete copy", () => {
  const spec = conversationPdfSpec({ title: "t", headerLines: [], messages: [{ role: "user", content: "좋아요 👍 고마워요" }] });
  const rendered = renderConversationPdf(spec);
  assert.equal(rendered.ok, true);
  assert.equal(rendered.charactersReplaced, true);
  assert.equal(renderConversationPdf(conversationPdfSpec({ title: "t", headerLines: [], messages: [{ role: "user", content: "좋아요" }] })).charactersReplaced, false);
});

test("a conversation too long for a PDF is refused, not cut", () => {
  const message = { role: "user", content: "x" };
  assert.throws(
    () => conversationPdfSpec({ title: "t", headerLines: [], messages: Array(PDF_EXPORT_LIMITS.messages + 1).fill(message) }),
    ConversationPdfTooLarge
  );
  assert.throws(
    () =>
      conversationPdfSpec({
        title: "t",
        headerLines: [],
        messages: [{ role: "user", content: "x".repeat(PDF_EXPORT_LIMITS.characters + 1) }],
      }),
    ConversationPdfTooLarge
  );
});

async function pdfText(bytes) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false }).promise;
  let text = "";
  for (let page = 1; page <= document.numPages; page += 1) {
    const content = await (await document.getPage(page)).getTextContent();
    text += content.items.map((item) => item.str ?? "").join("");
  }
  await document.cleanup();
  return text;
};

test("a Korean and Chinese conversation comes back out of the PDF as text", async () => {
  const spec = conversationPdfSpec({
    title: "분기 보고서 정리",
    createdAt: new Date("2026-11-28T00:00:00.000Z"),
    productKey: "chat",
    headerLines: ["Imported from ChatGPT on 2026-11-01"],
    messages: [
      { role: "user", content: "1분기 매출을 표로 정리해 줘. 中文也可以吗？", createdAt: "2026-11-28T01:00:00.000Z" },
      {
        role: "assistant",
        modelId: null,
        content: "## 요약\n\n매출은 **12%** 늘었습니다. 中文没有问题。\n\n| 분기 | 매출 |\n| --- | --- |\n| 1분기 | 1억 2천만 원 |\n\n```python\nprint('안녕')\n```",
        createdAt: "2026-11-28T01:00:05.000Z",
      },
    ],
  });
  const rendered = renderConversationPdf(spec);
  assert.equal(rendered.ok, true);
  // Set CONVERSATION_PDF_SAMPLE to a path to keep the file and look at it.
  const text = (await pdfText(rendered.bytes)).replace(/\s+/g, "");
  for (const expected of ["분기보고서정리", "1분기매출을표로정리해줘.", "中文也可以吗？", "매출은12%늘었습니다.", "中文没有问题。", "1억2천만원", "print('안녕')", "User", "Assistant"]) {
    assert.ok(text.includes(expected), `missing: ${expected}`);
  }
});

test("a conversation in a script the PDF font cannot draw is named, not rendered as boxes", () => {
  const spec = conversationPdfSpec({
    title: "t",
    headerLines: [],
    messages: [{ role: "user", content: "مرحبا بالعالم هذا نص عربي طويل جدا ".repeat(20) }],
  });
  assert.deepEqual(renderConversationPdf(spec), { ok: false, code: "UNSUPPORTED_CHARACTERS" });
});
