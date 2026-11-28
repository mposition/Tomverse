import assert from "node:assert/strict";
import test from "node:test";

import {
    ARTIFACT_CONTINUE_MAX_CHARS,
    ARTIFACT_EDIT_RENDER_DELAY_MS,
    continueWithVersionText,
    editedDownload,
    editedVersionKey,
    keepEditedVersion,
    markdownFenceFor,
    readEditedVersion,
} from "../lib/artifactPreviewEditing.ts";
import { artifactWorkspaceCopy } from "../locales/artifactWorkspace.ts";
import { SUPPORTED_LANGUAGES } from "../lib/language.ts";

test("the live preview waits for a pause in typing, not every key", () => {
    assert.ok(ARTIFACT_EDIT_RENDER_DELAY_MS >= 200 && ARTIFACT_EDIT_RENDER_DELAY_MS <= 1000);
});

test("the fence is longer than any backtick run in the code, so the code cannot close it", () => {
    assert.equal(markdownFenceFor("<p>plain</p>"), "```");
    assert.equal(markdownFenceFor("const s = `x`;"), "```");
    assert.equal(markdownFenceFor("```\nnested\n```"), "````");
    assert.equal(markdownFenceFor("`````"), "``````");
});

test("continue with this version writes the edited code under the request, tagged by kind", () => {
    const text = continueWithVersionText("Continue:\n\n{code}", { kind: "html", language: "htm", code: "<p>hi</p>" });
    assert.equal(text, "Continue:\n\n```html\n<p>hi</p>\n```");
    assert.match(continueWithVersionText("{code}", { kind: "react", language: "TSX", code: "x" }), /^```tsx\n/);
    assert.match(continueWithVersionText("{code}", { kind: "react", language: "jsx", code: "x" }), /^```jsx\n/);
    assert.match(continueWithVersionText("{code}", { kind: "svg", language: "svg", code: "<svg/>" }), /^```svg\n/);
    // The code's own braces are not placeholders.
    assert.equal(continueWithVersionText("{code}", { kind: "html", language: "html", code: "{code}" }), "```html\n{code}\n```");
});

test("a version longer than the cap is not put in the composer", () => {
    const atCap = "a".repeat(ARTIFACT_CONTINUE_MAX_CHARS);
    assert.ok(continueWithVersionText("{code}", { kind: "html", language: "html", code: atCap }));
    assert.equal(continueWithVersionText("{code}", { kind: "html", language: "html", code: `${atCap}a` }), null);
});

test("a download keeps a file's own name and types each kind", () => {
    assert.deepEqual(editedDownload({ kind: "html", language: "html", filename: "report.html" }), { filename: "report.html", mediaType: "text/html;charset=utf-8" });
    assert.equal(editedDownload({ kind: "html", language: "html" }).filename, "page.html");
    assert.equal(editedDownload({ kind: "svg", language: "svg" }).mediaType, "image/svg+xml;charset=utf-8");
    assert.equal(editedDownload({ kind: "react", language: "tsx" }).filename, "component.tsx");
    // React source is downloaded as text, never as a page the browser would run.
    assert.equal(editedDownload({ kind: "react", language: "jsx" }).mediaType, "text/plain;charset=utf-8");
});

test("an edit is kept for its source until it is the original again", () => {
    const fileKey = editedVersionKey({ artifactId: "art_1", kind: "html", original: "<p>a</p>" });
    const blockKey = editedVersionKey({ kind: "html", original: "<p>a</p>" });
    assert.notEqual(fileKey, blockKey);
    assert.equal(readEditedVersion(fileKey), null);
    keepEditedVersion(fileKey, "<p>b</p>", "<p>a</p>");
    assert.equal(readEditedVersion(fileKey), "<p>b</p>");
    assert.equal(readEditedVersion(blockKey), null);
    keepEditedVersion(fileKey, "<p>a</p>", "<p>a</p>");
    assert.equal(readEditedVersion(fileKey), null);
});

const shape = (value) =>
    value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shape(inner)]))
        : typeof value;

test("every language has every sentence, with the same placeholders", () => {
    const english = artifactWorkspaceCopy.en;
    for (const language of SUPPORTED_LANGUAGES) {
        const copy = artifactWorkspaceCopy[language];
        assert.deepEqual(shape(copy), shape(english), language);
        assert.ok(copy.edit.continuePrompt.includes("{code}"), language);
        assert.ok(copy.share.dialogSnapshot.includes("{days}"), language);
        assert.ok(copy.share.expires.includes("{date}"), language);
        assert.ok(copy.page.expires.includes("{date}"), language);
    }
});
