import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
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

const pdfText = async (bytes) => {
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
  if (process.env.CONVERSATION_PDF_SAMPLE) writeFileSync(process.env.CONVERSATION_PDF_SAMPLE, rendered.bytes);
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
