import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LanguageProvider } from "@/components/LanguageProvider";
import { ArtifactPreviewWorkspace } from "@/components/chat/ArtifactPreviewWorkspace";
import { artifactWorkspaceCopy } from "@/locales/artifactWorkspace";

const render = (options: { editable: boolean; original?: string; fillComposer?: ((text: string) => void) | null }) =>
  renderToStaticMarkup(
    <LanguageProvider initialLang="en">
      <ArtifactPreviewWorkspace
        source={{ kind: "html", language: "html", original: options.original ?? "<h1>hi</h1><script>1+1</script>" }}
        title="Preview"
        editable={options.editable}
        fillComposer={options.fillComposer ?? null}
        onClose={() => {}}
      />
    </LanguageProvider>
  );

test("with the workspace switch off the panel is the frame alone, as before", () => {
  const html = render({ editable: false });
  assert.match(html, /data-testid="html-artifact-preview-frame"/);
  assert.doesNotMatch(html, /role="tablist"|artifact-preview-code|artifact-preview-copy|artifact-preview-download/);
});

test("with the switch on the panel offers a preview and a code tab, opening on the preview", () => {
  const html = render({ editable: true, fillComposer: () => {} });
  const copy = artifactWorkspaceCopy.en.edit;
  assert.match(html, /role="tablist"/);
  assert.match(html, /data-testid="artifact-preview-tab-preview"[^>]*aria-selected="true"|aria-selected="true"[^>]*data-testid="artifact-preview-tab-preview"/);
  assert.ok(html.includes(copy.tabCode));
  assert.match(html, /data-testid="artifact-preview-copy"/);
  assert.match(html, /data-testid="artifact-preview-download"/);
  // Nothing has been edited yet, so there is nothing to revert or to continue with.
  assert.doesNotMatch(html, /artifact-preview-reset|artifact-preview-continue|artifact-preview-edited/);
  assert.match(html, /data-testid="html-artifact-preview-frame"/);
});

test("the edited frame is the same isolated frame: sandbox with scripts only, srcdoc, no src", () => {
  const html = render({ editable: true });
  assert.equal(/sandbox="([^"]*)"/.exec(html)?.[1], "allow-scripts");
  assert.match(html, /srcDoc=|srcdoc=/i);
  assert.doesNotMatch(html, /<iframe[^>]* src=/);
});

test("an empty source shows a notice instead of a frame", () => {
  const html = render({ editable: true, original: "   " });
  assert.match(html, /data-testid="html-artifact-preview-notice"/);
  assert.doesNotMatch(html, /html-artifact-preview-frame/);
});
