import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { MarketingManualPostBody } from "@/components/admin/AdminMarketingPanel";
import { adminMarketingMessages } from "@/lib/adminMessages/marketing";

/**
 * A hand-posted account's approved words, shown after approval so a person can
 * post them by hand (owner 2026-11-07). The read side sends them only for a
 * manual account; this is what the console draws from them.
 */

const BODY = "Same travel question.\nWhere do the answers differ?";

for (const locale of ["en", "ko"] as const) {
  const m = adminMarketingMessages[locale] as unknown as Record<string, string>;

  test(`${locale}: the whole body is shown with a copy button`, () => {
    const html = renderToStaticMarkup(<MarketingManualPostBody body={BODY} m={m} />);
    assert.match(html, /data-testid="marketing-manual-post-body"/);
    assert.match(html, /data-testid="marketing-manual-post-copy"/);
    assert.ok(html.includes("Same travel question.\nWhere do the answers differ?"));
    assert.ok(html.includes(m.manualPostBody));
    assert.ok(html.includes(m.manualPostBodyCopy));
  });

  test(`${locale}: nothing is drawn without a body`, () => {
    for (const body of [null, undefined, "", 3]) {
      assert.equal(renderToStaticMarkup(<MarketingManualPostBody body={body} m={m} />), "");
    }
  });
}

test("both languages carry the body lines", () => {
  for (const locale of ["en", "ko"] as const) {
    const m = adminMarketingMessages[locale] as unknown as Record<string, string>;
    for (const key of ["manualPostBody", "manualPostBodyCopy", "manualPostBodyCopied"]) {
      assert.ok(m[key] && m[key].length > 0, `${locale}.${key}`);
    }
  }
});
