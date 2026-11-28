import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LanguageProvider } from "@/components/LanguageProvider";
import { GeneratedArtifactCard } from "@/components/chat/GeneratedArtifactCard";
import { HtmlArtifactPreviewFrame } from "@/components/chat/HtmlArtifactPreviewPanel";
import { HTML_PREVIEW_CSP } from "@/lib/htmlArtifactPreview";
import { SUPPORTED_LANGUAGES } from "@/lib/language";
import { de } from "@/locales/de";
import { en } from "@/locales/en";
import { es } from "@/locales/es";
import { fr } from "@/locales/fr";
import { ko } from "@/locales/ko";
import { pt } from "@/locales/pt";
import { zh } from "@/locales/zh";
import { zhHant } from "@/locales/zhHant";

const artifact = (format: string, extra: Record<string, unknown> = {}) => ({
  id: `artifact-${format}`,
  ordinal: 0,
  format,
  filename: `chart.${format}`,
  mediaType: format === "html" ? "text/html; charset=utf-8" : "application/octet-stream",
  byteSize: 2048,
  status: "ready" as const,
  ...extra,
});

const card = (value: ReturnType<typeof artifact>) =>
  renderToStaticMarkup(
    <LanguageProvider initialLang="en">
      <GeneratedArtifactCard artifact={value} currentProduct="chat" />
    </LanguageProvider>
  );

test("the frame is a sandboxed srcdoc with scripts and no app origin, no navigation, no src", () => {
  const html = renderToStaticMarkup(
    <LanguageProvider initialLang="en">
      <HtmlArtifactPreviewFrame html="<h1>hi</h1><script>1+1</script>" title="Preview of chart.html" />
    </LanguageProvider>
  );
  const sandbox = /sandbox="([^"]*)"/.exec(html)?.[1];
  assert.equal(sandbox, "allow-scripts");
  assert.doesNotMatch(html, /allow-same-origin|allow-top-navigation|allow-popups|allow-forms|allow-modals|allow-downloads/);
  assert.match(html, /srcDoc|srcdoc/i);
  assert.doesNotMatch(html, /\ssrc="/, "the page is never loaded from a URL");
  assert.match(html, /referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/i);
  assert.ok(html.includes("Content-Security-Policy"));
  assert.ok(html.includes("connect-src &#x27;none&#x27;"), "the connect-src 'none' policy travels in the document");
  assert.ok(HTML_PREVIEW_CSP.includes("connect-src 'none'"));
  assert.match(html, /title="Preview of chart.html"/);
});

test("a page that names shadowrootmode is not drawn until its template scan has loaded", () => {
  // The scan (parse5) is loaded in an effect, which a server render never runs: no frame, only the empty placeholder.
  const html = renderToStaticMarkup(
    <LanguageProvider initialLang="en">
      <HtmlArtifactPreviewFrame html='<div><template shadowrootmode="closed"><p>x</p></template></div>' title="Preview" />
    </LanguageProvider>
  );
  assert.match(html, /data-testid="html-artifact-preview-loading"/);
  assert.doesNotMatch(html, /<iframe|srcdoc/i);
});

test("a ready HTML file gets a preview button next to download; no other file and no unfinished file does", () => {
  const html = card(artifact("html"));
  assert.match(html, /data-testid="generated-artifact-html-preview"/);
  assert.match(html, /data-testid="generated-artifact-download"/);
  assert.ok(html.includes(en.chat.artifactPreviewOpen));
  // Nothing is fetched or shown until the button is pressed.
  assert.doesNotMatch(html, /html-artifact-preview-panel|html-artifact-preview-frame/);

  for (const format of ["svg", "xlsx", "pdf", "md", "js"]) {
    assert.doesNotMatch(card(artifact(format)), /generated-artifact-html-preview/, format);
  }
  assert.doesNotMatch(card(artifact("html", { status: "failed", failureCode: "generation_failed" })), /generated-artifact-html-preview/);
  assert.doesNotMatch(card(artifact("html", { status: "blocked", failureCode: "sign_in_required" })), /generated-artifact-html-preview/);
});

test("every locale words the preview and the page-reading and past-chat status lines", () => {
  const locales = { en, ko, de, es, fr, pt, zh, zhHant };
  assert.deepEqual(Object.keys(locales).sort(), [...SUPPORTED_LANGUAGES].map((l) => (l === "zh-Hant" ? "zhHant" : l)).sort());
  const keys = [
    "artifactPreviewOpen", "artifactPreviewClose", "artifactPreviewLoading", "artifactPreviewFailed", "artifactPreviewTooLarge",
    "artifactPreviewSandboxNote", "toolPageReading", "toolPageUnavailable", "toolHistorySearching",
  ] as const;
  for (const [name, locale] of Object.entries(locales)) {
    for (const key of keys) {
      const value = (locale.chat as Record<string, unknown>)[key];
      assert.equal(typeof value, "string", `${name}.${key}`);
      assert.ok((value as string).trim().length >= 2, `${name}.${key}`);
      if (name !== "en" && key !== "artifactPreviewOpen") assert.notEqual(value, (en.chat as Record<string, unknown>)[key], `${name}.${key} is translated`);
    }
  }
});
