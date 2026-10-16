import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AmuxOperatingScopePanel } from "@/components/admin/AmuxOperatingScopePanel";

// docs/policy/amux-intake.md v19 item 2: the owner operating scope screen.
test("before the scope is read, nothing can be saved and the approval is spelled out", () => {
  const html = renderToStaticMarkup(<AmuxOperatingScopePanel operatorId="synthetic-owner" />);
  assert.match(html, /Intake operating scope/);
  assert.match(html, /Saving starts nothing/);
  assert.match(html, /Private repositories may be listed; their contents are sent/);
  assert.match(html, /disabled=""[^>]*>Save operating scope/);
  assert.match(html, /aria-describedby="amux-operating-scope-repositories-hint amux-operating-scope-error"/);
  assert.match(html, /Checking the scope/);
});
