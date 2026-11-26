import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LanguageProvider } from "@/components/LanguageProvider";
import {
  AssistantPackageImportWizard,
  type AssistantPackageImportHost,
} from "@/components/assistants/import/AssistantPackageImportWizard";
import { webImportRequests } from "@/lib/assistantPackageImportClient";

const host = (overrides: Partial<AssistantPackageImportHost> = {}): AssistantPackageImportHost => ({
  requests: webImportRequests,
  header: <nav data-testid="host-header">Back to the list</nav>,
  DoneLink: ({ children, ...props }) => <button type="button" {...props}>{children}</button>,
  refresh: () => {},
  ...overrides,
});

const render = (value: AssistantPackageImportHost) =>
  renderToStaticMarkup(
    <LanguageProvider initialLang="en" forceInitialLang>
      <AssistantPackageImportWizard mergeTargets={[]} host={value} />
    </LanguageProvider>
  );

test("the wizard opens on its first step with the host's navigation above the title", () => {
  const html = render(host());
  assert.match(html, /data-testid="host-header"/);
  assert.match(html, /data-testid="assistant-package-import-steps"/);
  assert.match(html, /1\. Choose a file/);
  // Continue is not offered before a package has been read.
  assert.match(html, /disabled=""[^>]*data-testid="assistant-package-import-next"/);
});

test("a host without a file dialog gets the file input, one with a dialog gets a button and no input", () => {
  const web = render(host());
  assert.match(web, /<input[^>]*type="file"[^>]*accept="\.zip,\.json"/);
  const desktop = render(host({ pickPackage: async () => null }));
  assert.doesNotMatch(desktop, /type="file"/);
  assert.match(desktop, /<button[^>]*data-testid="assistant-package-import-file"/);
  // The reason there is no address box is stated either way.
  assert.match(desktop, /There is no box for a web address/);
  assert.match(web, /There is no box for a web address/);
});
