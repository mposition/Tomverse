// The console side of two operator decisions of 2026-11-03: the resolve form
// asks for Zernio's post id (and fills it in when the publisher kept one), and
// an approved or scheduled post can have its approval withdrawn.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { adminMarketingMessages } from "../lib/adminMessages/marketing.ts";

const panel = readFileSync(new URL("../components/admin/AdminMarketingPanel.tsx", import.meta.url), "utf8");

/** The source of one `actions.push({ id: "<id>", ... })` call. */
const action = (id) => {
  const start = panel.indexOf(`id: "${id}",`);
  assert.ok(start > 0, `action ${id}`);
  const end = panel.indexOf("\n    });", start);
  return panel.slice(start, end);
};

test("the resolve form names Zernio's post id and prefills the one the publisher kept", () => {
  const resolve = action("resolve-published");
  assert.match(resolve, /name: "externalPostId",[\s\S]*initial: str\(row\.externalPostId\)/u);
  assert.match(resolve, /hint: m\.hintExternalPostId/u);
  assert.equal(adminMarketingMessages.en.fieldExternalPostId, "Zernio post ID");
  assert.equal(adminMarketingMessages.ko.fieldExternalPostId, "Zernio 게시물 ID");
  assert.ok(adminMarketingMessages.en.hintExternalPostId.includes("Zernio"));
  assert.ok(adminMarketingMessages.ko.hintExternalPostId.includes("Zernio"));
});

test("an approved or scheduled post offers a confirmed withdrawal of its approval", () => {
  const withdraw = action("withdraw-approval");
  assert.match(withdraw, /path: POST\(row\.id, "withdraw"\)/u);
  assert.match(withdraw, /confirm: m\.confirmWithdrawApproval/u);
  assert.match(withdraw, /body: \(\) => postCas\(row\)/u);
  const guard = panel.slice(panel.lastIndexOf("if (", panel.indexOf('id: "withdraw-approval"')), panel.indexOf('id: "withdraw-approval"'));
  assert.match(guard, /status === "approved" \|\| status === "scheduled"/u);
  for (const locale of ["en", "ko"]) {
    assert.ok(adminMarketingMessages[locale].actWithdrawApproval, locale);
    assert.ok(adminMarketingMessages[locale].confirmWithdrawApproval, locale);
  }
});
