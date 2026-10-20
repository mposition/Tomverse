import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AmuxSessionBudgetResolutionPanel, readSessionBudgetReadback,
  readSessionBudgetUnknownList, sessionBudgetEvidenceDigest,
  sessionBudgetEvidenceText, UnknownClaimRow } from
  "@/components/admin/AmuxSessionBudgetResolutionPanel";
import { adminAmuxSessionBudgetResolutionMessages } from
  "@/lib/adminMessages/amuxSessionBudgetResolution";

const claimId = "9942fb52-4b78-4af6-931a-9eec8f66d394";
const row = { claimId, invocationOrdinal: 0, budgetMode: "max_shadow",
  createdAt: "2026-10-20T00:00:00.000Z" };
/** renderToStaticMarkup escapes text the way React does. */
const html = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#x27;");
const pick = (markup: string) =>
  markup.includes(adminAmuxSessionBudgetResolutionMessages.ko.title)
    ? adminAmuxSessionBudgetResolutionMessages.ko
    : adminAmuxSessionBudgetResolutionMessages.en;

test("the panel opens as an unread list with the halt-marker instruction", () => {
  const markup = renderToStaticMarkup(createElement(AmuxSessionBudgetResolutionPanel));
  const m = pick(markup);
  assert.match(markup, /data-testid="amux-session-budget-resolution"/);
  assert.ok(markup.includes(html(m.haltHint)));
  assert.ok(markup.includes(html(m.inFlightHint)));
  // Before the read answers, the state is loading, never the empty claim.
  assert.ok(markup.includes(html(m.loading)));
  assert.ok(!markup.includes(html(m.empty)));
  assert.ok(markup.includes(html(m.refresh)));
  for (const messages of [adminAmuxSessionBudgetResolutionMessages.en,
    adminAmuxSessionBudgetResolutionMessages.ko]) {
    assert.match(messages.haltHint, /halt/);
  }
});

test("a row offers only its read-back until the exact claim is read", () => {
  const markup = renderToStaticMarkup(createElement(UnknownClaimRow,
    { row, onStatus: () => {} }));
  const m = pick(renderToStaticMarkup(createElement(AmuxSessionBudgetResolutionPanel)));
  assert.match(markup, /data-testid="amux-session-budget-unknown-row"/);
  assert.ok(markup.includes(claimId));
  assert.ok(markup.includes(html(m.readBack)));
  assert.ok(!markup.includes(html(m.consume)));
  assert.ok(!markup.includes('type="checkbox"'));
});

test("the panel offers no proof-of-no-start path and resolves only as not_proven", () => {
  const source = readFileSync("components/admin/AmuxSessionBudgetResolutionPanel.tsx", "utf8");
  assert.match(source, /verification: "not_proven"/);
  assert.doesNotMatch(source, /proven_not_started/);
  assert.match(source, /adminRecentAuthenticationHref\("\/admin\/amux-settings\?tab=analysis"\)/);
  assert.match(source, /status === 428/);
  assert.doesNotMatch(source, /\bfetch\(/, "every request goes through adminFetch");
});

test("list and read-back replies are read strictly", () => {
  const list = { state: "unknown_list", rows: [row], total: 3, limit: 20,
    retryAutomatically: false };
  assert.deepEqual(readSessionBudgetUnknownList(list), { rows: [row], total: 3, limit: 20 });
  assert.deepEqual(readSessionBudgetUnknownList({ ...list, rows: [], total: 0 }),
    { rows: [], total: 0, limit: 20 });
  for (const broken of [null, { ...list, state: "readback" }, { ...list, total: 0 },
    { ...list, rows: [{ ...row, claimId: "not-a-uuid" }] },
    { ...list, rows: "none" }]) {
    assert.equal(readSessionBudgetUnknownList(broken), null);
  }
  const readback = { state: "readback", retryAutomatically: false, readback: {
    claimId, status: "outcome_unknown", reservedMicroUsd: "5000000",
    readbackDigest: "a".repeat(64), requestId: "x" } };
  assert.deepEqual(readSessionBudgetReadback(readback, claimId), { claimId,
    status: "outcome_unknown", reservedMicroUsd: "5000000",
    readbackDigest: "a".repeat(64) });
  assert.equal(readSessionBudgetReadback(readback,
    "00000000-0000-4000-8000-000000000001"), null);
  assert.equal(readSessionBudgetReadback({ ...readback,
    readback: { ...readback.readback, readbackDigest: "A".repeat(64) } }, claimId), null);
  assert.equal(readSessionBudgetReadback({ ...readback,
    readback: { ...readback.readback, reservedMicroUsd: "-1" } }, claimId), null);
});

test("the evidence digest is the sha256 of a fixed confirmation text", async () => {
  const text = sessionBudgetEvidenceText(claimId, "2026-10-20T01:02:03.000Z");
  assert.equal(text, [
    "amux-v19-session-budget-evidence-v1",
    `claimId=${claimId}`,
    "operator confirmed outcome unknown on runner",
    "confirmedAt=2026-10-20T01:02:03.000Z",
  ].join("\n"));
  assert.equal(await sessionBudgetEvidenceDigest(text),
    createHash("sha256").update(text, "utf8").digest("hex"));
});

test("a failed list refresh keeps the rows, so an unknown resolution is never resent", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../../components/admin/AmuxSessionBudgetResolutionPanel.tsx",
    import.meta.url), "utf8");
  assert.doesNotMatch(source, /setList\(null\)/);
  assert.match(source, /if \(parsed\) setList\(parsed\);/);
});
