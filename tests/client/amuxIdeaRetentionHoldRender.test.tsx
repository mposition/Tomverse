import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AmuxIdeaRetentionHoldPanel } from
  "@/components/admin/AmuxIdeaRetentionHoldPanel";

test("retention controls start with a read-back, not a write", () => {
  const html = renderToStaticMarkup(<AmuxIdeaRetentionHoldPanel
    ideaId="11111111-1111-4111-8111-111111111111" />);
  assert.match(html, /Content retention hold/);
  assert.match(html, /Check remaining content and holds/);
  assert.doesNotMatch(html, /Approve hold of remaining content/);
  assert.doesNotMatch(html, /Release hold/);
});
