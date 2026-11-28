import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LanguageProvider } from "@/components/LanguageProvider";
import { ChatArtifactWorkspaceProvider, CodeBlockStreamingScope } from "@/components/chat/ChatArtifactWorkspaceContext";
import { CodeBlockPreview } from "@/components/chat/CodeBlockPreview";
import { planCodeRunFileAdd } from "@/components/chat/CodeBlockRun";
import { CODE_RUN_LIMITS } from "@/lib/chatCodeRun";
import { SUPPORTED_LANGUAGES } from "@/lib/language";
import { de } from "@/locales/de";
import { en } from "@/locales/en";
import { es } from "@/locales/es";
import { fr } from "@/locales/fr";
import { ko } from "@/locales/ko";
import { pt } from "@/locales/pt";
import { zh } from "@/locales/zh";
import { zhHant } from "@/locales/zhHant";

const noRef = { current: null };

const block = (language: string, options: { codeRun?: boolean; workspace?: boolean; streaming?: boolean; lang?: "en" | "ko" } = {}) =>
  renderToStaticMarkup(
    <LanguageProvider initialLang={options.lang ?? "en"}>
      <ChatArtifactWorkspaceProvider enabled={options.workspace ?? false} codeRunEnabled={options.codeRun ?? true} fillComposer={() => {}}>
        <CodeBlockStreamingScope streaming={options.streaming ?? false}>
          <CodeBlockPreview preRef={noRef}>
            <code className={`hljs language-${language}`}>print(1)</code>
          </CodeBlockPreview>
        </CodeBlockStreamingScope>
      </ChatArtifactWorkspaceProvider>
    </LanguageProvider>
  );

test("a finished python block gets a Run button when the switch is on, and nothing runs or loads until it is pressed", () => {
  for (const language of ["python", "py", "python3"]) {
    const html = block(language);
    assert.match(html, /data-testid="chat-code-run-button"/, language);
    assert.ok(html.includes(en.chat.codeRunButton), language);
    assert.ok(html.includes(`aria-label="${en.chat.codeRunButtonLabel}"`), language);
    // No frame, no result region, no worker: the page has not even been built.
    assert.doesNotMatch(html, /<iframe|chat-code-run-frame|chat-code-run-result|srcDoc|srcdoc/i, language);
  }
});

test("Run does not depend on the artifact workspace switch, and the Preview button is not offered for python", () => {
  const html = block("python", { workspace: false });
  assert.match(html, /chat-code-run-button/);
  assert.doesNotMatch(html, /chat-code-preview-button/);
  const both = block("python", { workspace: true });
  assert.match(both, /chat-code-run-button/);
  assert.doesNotMatch(both, /chat-code-preview-button/);
});

test("no Run button with the switch off, while the answer is streaming, on other languages, or outside the provider", () => {
  assert.equal(block("python", { codeRun: false }), "");
  assert.equal(block("python", { streaming: true }), "");
  for (const language of ["js", "ts", "bash", "r", "sql", "json"]) assert.equal(block(language), "", language);
  assert.equal(
    renderToStaticMarkup(
      <LanguageProvider initialLang="en">
        <CodeBlockPreview preRef={noRef}><code className="language-python">print(1)</code></CodeBlockPreview>
      </LanguageProvider>
    ),
    ""
  );
});

test("the html, svg, jsx and tsx Preview button is unchanged by the Run switch", () => {
  for (const language of ["html", "svg", "jsx", "tsx"]) {
    assert.match(block(language, { workspace: true, codeRun: false }), /chat-code-preview-button/, language);
    assert.match(block(language, { workspace: true, codeRun: true }), /chat-code-preview-button/, language);
    assert.doesNotMatch(block(language, { workspace: true, codeRun: true }), /chat-code-run-button/, language);
    assert.equal(block(language, { workspace: false, codeRun: true }), "", language);
  }
});

test("the Run button is read in the person's language", () => {
  assert.ok(block("python", { lang: "ko" }).includes(ko.chat.codeRunButton));
});

test("every language has every Run sentence, with the same placeholders as English", () => {
  const locales = { en, ko, zh, zhHant, fr, de, es, pt };
  assert.deepEqual(Object.keys(locales).sort(), [...SUPPORTED_LANGUAGES].map((language) => (language === "zh-Hant" ? "zhHant" : language)).sort());
  const keys = Object.keys(en.chat).filter((key) => key.startsWith("codeRun"));
  assert.ok(keys.length >= 28, `${keys.length} codeRun keys`);
  const placeholders = (text: string) => (text.match(/\{[a-z]+\}/g) ?? []).sort().join(",");
  for (const [name, locale] of Object.entries(locales)) {
    const chat = locale.chat as unknown as Record<string, string>;
    for (const key of keys) {
      assert.equal(typeof chat[key], "string", `${name}.${key}`);
      assert.ok(chat[key].trim().length > 0, `${name}.${key} is empty`);
      assert.equal(placeholders(chat[key]), placeholders((en.chat as unknown as Record<string, string>)[key]), `${name}.${key} placeholders`);
    }
  }
});

const file = (name: string, size: number) => ({ name, size });

test("a file with the name of one already chosen replaces it, even when the list is full or at the size limit", () => {
  const full = Array.from({ length: CODE_RUN_LIMITS.maxFiles }, (_, index) => file(`f${index}.csv`, 10));
  const replaced = planCodeRunFileAdd(full, file("f2.csv", 20));
  assert.equal(replaced.ok, true);
  assert.equal(replaced.files.length, CODE_RUN_LIMITS.maxFiles);
  assert.deepEqual(replaced.files.filter((entry) => entry.name === "f2.csv"), [file("f2.csv", 20)]);

  const big = CODE_RUN_LIMITS.maxFileBytes;
  const atLimit = [file("a.csv", big), file("b.csv", big)];
  const swapped = planCodeRunFileAdd(atLimit, file("a.csv", big - 1));
  assert.equal(swapped.ok, true);
  assert.deepEqual(swapped.files.map((entry) => entry.size).sort(), [big - 1, big].sort());
});

test("a refused file changes nothing: the old file of the same name stays", () => {
  const big = CODE_RUN_LIMITS.maxFileBytes;
  // Replacing would still push the total past its limit.
  const two = [file("a.csv", 1), file("b.csv", big), file("c.csv", big)];
  const tooBig = planCodeRunFileAdd(two, file("a.csv", big));
  assert.deepEqual(tooBig, { ok: false, reason: "total", files: two });
  // Over the size of one file.
  const oversize = planCodeRunFileAdd(two, file("a.csv", big + 1));
  assert.deepEqual(oversize, { ok: false, reason: "size", files: two });
  // A new name on a full list is still refused.
  const full = Array.from({ length: CODE_RUN_LIMITS.maxFiles }, (_, index) => file(`f${index}.csv`, 1));
  assert.deepEqual(planCodeRunFileAdd(full, file("new.csv", 1)), { ok: false, reason: "count", files: full });
  // The list handed back is a copy, not the caller's array.
  assert.notEqual(planCodeRunFileAdd(full, file("new.csv", 1)).files, full);
});

test("a new name is added after the others", () => {
  const plan = planCodeRunFileAdd([file("a.csv", 1)], file("b.csv", 2));
  assert.deepEqual(plan, { ok: true, files: [file("a.csv", 1), file("b.csv", 2)] });
});
