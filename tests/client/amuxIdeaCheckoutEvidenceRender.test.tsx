import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AmuxIdeaDetailSummary } from "@/components/admin/AmuxIdeaDetailSummary";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";
import { amuxIdeaProgress } from "@/lib/amux/ideaProgressCore";
import type { AmuxIdeaProgressRow } from "@/lib/amux/ideaProgressRead";

const row = (checkoutEvidence: AmuxIdeaProgressRow["checkoutEvidence"]): AmuxIdeaProgressRow => ({
  ...amuxIdeaProgress({ state: "submitted", cancelled: false, chunks: [],
    proposedUnits: 0, cards: [] }),
  ideaId: "idea-1", requestId: "11111111-1111-4111-8111-111111111111",
  submittedAt: "2026-10-16T00:00:00.000Z", displayKey: null,
  reviewPullRequests: [], taskRows: [], checkoutEvidence,
});

test("Admin idea detail shows pinned SHA and exclusion reasons without private paths", () => {
  const markup = renderToStaticMarkup(createElement(AmuxIdeaDetailSummary, { row: row([{
    referenceOrdinal: 0, pinnedCommitSha: "a".repeat(40), excludedCount: 2,
    excludedReasons: { secretPath: 1, secretContent: 1,
      nonRegular: 0, unscannableContent: 0 }, readManifest: null,
  }]) }));
  assert.match(markup, /data-testid="amux-checkout-evidence"/);
  assert.ok(markup.includes("a".repeat(40)));
  const m = markup.includes(adminAmuxIdeaProgressMessages.ko.checkoutEvidenceTitle)
    ? adminAmuxIdeaProgressMessages.ko : adminAmuxIdeaProgressMessages.en;
  assert.ok(markup.includes(m.checkoutReference(0)));
  assert.ok(markup.includes(m.checkoutExcluded(2)));
  assert.ok(markup.includes(`${m.checkoutReasons.secretPath}: 1`));
  assert.ok(markup.includes(`${m.checkoutReasons.secretContent}: 1`));
  assert.ok(!markup.includes(`${m.checkoutReasons.nonRegular}: 0`));
  assert.ok(!markup.includes(".env") && !markup.includes("/tmp/"));
  assert.doesNotMatch(renderToStaticMarkup(createElement(AmuxIdeaDetailSummary,
    { row: row([]) })), /data-testid="amux-checkout-evidence"/);
});

test("both Admin locales describe one excluded file correctly", () => {
  assert.equal(adminAmuxIdeaProgressMessages.en.checkoutExcluded(1), "1 file excluded");
  assert.equal(adminAmuxIdeaProgressMessages.en.checkoutExcluded(2), "2 files excluded");
  assert.equal(adminAmuxIdeaProgressMessages.ko.checkoutExcluded(1), "제외한 파일 1개");
});

test("Admin shows read-file count, digest and purge state without stored paths", () => {
  const evidence: AmuxIdeaProgressRow["checkoutEvidence"][number] = {
    referenceOrdinal: 0, pinnedCommitSha: "a".repeat(40), excludedCount: 0,
    excludedReasons: { secretPath: 0, secretContent: 0,
      nonRegular: 0, unscannableContent: 0 },
    readManifest: { fileCount: 2, digest: "b".repeat(64), bodyPurged: false },
  };
  const active = renderToStaticMarkup(createElement(AmuxIdeaDetailSummary,
    { row: row([evidence]) }));
  assert.match(active, /data-testid="amux-checkout-read-manifest"/);
  assert.ok(active.includes("b".repeat(64)));
  assert.ok(active.includes(adminAmuxIdeaProgressMessages.en.checkoutReadFiles(2)) ||
    active.includes(adminAmuxIdeaProgressMessages.ko.checkoutReadFiles(2)));
  assert.ok(!active.includes("docs/private.md"));
  const purged = renderToStaticMarkup(createElement(AmuxIdeaDetailSummary,
    { row: row([{ ...evidence, readManifest: { ...evidence.readManifest!,
      bodyPurged: true } }]) }));
  assert.ok(purged.includes(adminAmuxIdeaProgressMessages.en.checkoutReadPurged) ||
    purged.includes(adminAmuxIdeaProgressMessages.ko.checkoutReadPurged));
});
