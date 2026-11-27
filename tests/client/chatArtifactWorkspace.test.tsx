import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LanguageProvider } from "@/components/LanguageProvider";
import { ChatArtifactWorkspaceProvider, CodeBlockStreamingScope } from "@/components/chat/ChatArtifactWorkspaceContext";
import { CodeBlockPreview } from "@/components/chat/CodeBlockPreview";
import { GeneratedArtifactCard } from "@/components/chat/GeneratedArtifactCard";
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

const block = (language: string, options: { enabled?: boolean; streaming?: boolean } = {}) =>
  renderToStaticMarkup(
    <LanguageProvider initialLang="en">
      <ChatArtifactWorkspaceProvider enabled={options.enabled ?? true} fillComposer={() => {}}>
        <CodeBlockStreamingScope streaming={options.streaming ?? false}>
          <CodeBlockPreview preRef={noRef}>
            <code className={`hljs language-${language}`}>code</code>
          </CodeBlockPreview>
        </CodeBlockStreamingScope>
      </ChatArtifactWorkspaceProvider>
    </LanguageProvider>
  );

test("a finished html, svg, jsx or tsx block gets a Preview button when the switch is on", () => {
  for (const language of ["html", "svg", "jsx", "tsx"]) {
    const html = block(language);
    assert.match(html, /data-testid="chat-code-preview-button"/, language);
    assert.ok(html.includes(en.chat.artifactPreviewOpen), language);
    // Nothing runs until the button is pressed.
    assert.doesNotMatch(html, /html-artifact-preview-panel|html-artifact-preview-frame/, language);
  }
});

test("no Preview button with the switch off, while the answer is still streaming, or on any other code", () => {
  assert.equal(block("html", { enabled: false }), "");
  assert.equal(block("tsx", { enabled: false }), "");
  assert.equal(block("html", { streaming: true }), "");
  assert.equal(block("jsx", { streaming: true }), "");
  for (const language of ["js", "ts", "python", "css", "json", "bash"]) assert.equal(block(language), "", language);
  // A block with no language tag has nothing to preview.
  assert.equal(
    renderToStaticMarkup(
      <LanguageProvider initialLang="en">
        <ChatArtifactWorkspaceProvider enabled fillComposer={null}>
          <CodeBlockPreview preRef={noRef}><code>plain</code></CodeBlockPreview>
        </ChatArtifactWorkspaceProvider>
      </LanguageProvider>
    ),
    ""
  );
});

test("outside the workspace provider (a shared page, a test) a code block never offers a preview", () => {
  assert.equal(
    renderToStaticMarkup(
      <LanguageProvider initialLang="en">
        <CodeBlockPreview preRef={noRef}><code className="language-html">x</code></CodeBlockPreview>
      </LanguageProvider>
    ),
    ""
  );
});

const artifact = (format: string) => ({
  id: `artifact-${format}`,
  ordinal: 0,
  format,
  filename: `app.${format}`,
  mediaType: "text/plain; charset=utf-8",
  byteSize: 2048,
  status: "ready" as const,
});

const card = (value: ReturnType<typeof artifact>, enabled: boolean | null) => {
  const body = <GeneratedArtifactCard artifact={value} currentProduct="chat" />;
  return renderToStaticMarkup(
    <LanguageProvider initialLang="en">
      {enabled === null ? body : <ChatArtifactWorkspaceProvider enabled={enabled} fillComposer={null}>{body}</ChatArtifactWorkspaceProvider>}
    </LanguageProvider>
  );
};

test("a generated jsx or tsx file previews only with the switch on; html previews either way", () => {
  for (const format of ["jsx", "tsx"]) {
    assert.match(card(artifact(format), true), /data-testid="generated-artifact-html-preview"/, format);
    assert.doesNotMatch(card(artifact(format), false), /generated-artifact-html-preview/, format);
    assert.doesNotMatch(card(artifact(format), null), /generated-artifact-html-preview/, format);
  }
  for (const enabled of [true, false, null]) {
    assert.match(card(artifact("html"), enabled), /data-testid="generated-artifact-html-preview"/);
  }
  for (const format of ["js", "ts", "css"]) assert.doesNotMatch(card(artifact(format), true), /generated-artifact-html-preview/, format);
});

test("every locale words the workspace sentences, keeping the placeholders the code fills in", () => {
  const locales = { en, ko, de, es, fr, pt, zh, zhHant };
  assert.deepEqual(Object.keys(locales).sort(), [...SUPPORTED_LANGUAGES].map((l) => (l === "zh-Hant" ? "zhHant" : l)).sort());
  const keys: Record<string, string | null> = {
    artifactWorkspaceCodeTitle: "{language}",
    artifactWorkspaceCodeTooLarge: null,
    artifactWorkspaceCodeEmpty: null,
    artifactWorkspaceReviseLabel: null,
    artifactWorkspaceRevisePlaceholder: null,
    artifactWorkspaceReviseSubmit: null,
    artifactWorkspaceRevisePrompt: "{request}",
    artifactWorkspaceErrorTitle: null,
    artifactWorkspaceLoadFailed: null,
    artifactWorkspaceNoComponent: null,
    artifactWorkspaceMissingPackage: "{name}",
  };
  for (const [name, locale] of Object.entries(locales)) {
    for (const [key, placeholder] of Object.entries(keys)) {
      const value = (locale.chat as Record<string, unknown>)[key];
      assert.equal(typeof value, "string", `${name}.${key}`);
      assert.ok((value as string).trim().length >= 2, `${name}.${key}`);
      if (placeholder) assert.ok((value as string).includes(placeholder), `${name}.${key} keeps ${placeholder}`);
      if (name !== "en") assert.notEqual(value, (en.chat as Record<string, unknown>)[key], `${name}.${key} is translated`);
    }
  }
});
