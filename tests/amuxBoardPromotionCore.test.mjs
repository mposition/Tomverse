import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ADMIN_SEARCHABLE_PAGES, resolveAdminPageMeta } from "../lib/adminNavigation.ts";
import {
  BOARD_PROMOTION_APPLY_CODE_LATCH,
  boardPromotionApplyPermitted,
  boardPromotionCardWrite,
  boardPromotionRequestDigest,
  classifyBoardPromotion,
  parseBoardPromotionRequest,
} from "../lib/amux/boardPromotionCore.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const cardId = `c${"a".repeat(24)}`;
const digest = "a".repeat(64);

const item = (overrides = {}) => ({
  cardId,
  expectedRevision: 2,
  sourceDigest: digest,
  kind: "code",
  priority: "p1",
  classification: {
    task_kind: "feature",
    complexity: 4,
    risk: 2,
    files_expected: 3,
  },
  executionBrief: "Record the pilot boundary in prose.",
  ...overrides,
});

const request = (items) =>
  JSON.stringify({
    canonicalizationVersion: "amux-json-v1",
    policyVersion: 3,
    items,
  });

const fact = (overrides = {}) => ({
  id: cardId,
  revision: 2,
  status: "backlog",
  owner: null,
  claimedAt: null,
  archivedAt: null,
  sourceSystem: "tomverse_private_workboard",
  sourceDigest: digest,
  attemptCount: 0,
  deliveryCount: 0,
  routeDecisionCount: 0,
  dependencies: [],
  ...overrides,
});

test("the promotion latch is on and apply still needs the environment", () => {
  assert.equal(BOARD_PROMOTION_APPLY_CODE_LATCH, true);
  assert.equal(
    boardPromotionApplyPermitted({ envValue: "enabled", codeLatch: false }),
    false,
  );
  assert.equal(
    boardPromotionApplyPermitted({ envValue: "enabled", codeLatch: BOARD_PROMOTION_APPLY_CODE_LATCH }),
    true,
  );
  assert.equal(boardPromotionApplyPermitted({ envValue: "true", codeLatch: true }), false);
  assert.equal(boardPromotionApplyPermitted({ envValue: undefined, codeLatch: true }), false);
  assert.equal(boardPromotionApplyPermitted({ envValue: "enabled", codeLatch: true }), true);
});

test("a one-card request is canonical and a larger batch is refused", () => {
  const parsed = parseBoardPromotionRequest(request([item()]));
  assert.equal(parsed.ok, true);
  const reordered = JSON.stringify({
    items: [
      {
        executionBrief: item().executionBrief,
        priority: "p1",
        kind: "code",
        sourceDigest: digest,
        expectedRevision: 2,
        cardId,
        classification: {
          files_expected: 3,
          risk: 2,
          complexity: 4,
          task_kind: "feature",
        },
      },
    ],
    policyVersion: 3,
    canonicalizationVersion: "amux-json-v1",
  });
  const again = parseBoardPromotionRequest(reordered);
  assert.equal(again.ok, true);
  assert.equal(again.requestDigest, parsed.requestDigest);
  assert.equal(boardPromotionRequestDigest(parsed.request), parsed.requestDigest);
  assert.equal(parseBoardPromotionRequest(request([])).code, "batch_size");
  assert.equal(parseBoardPromotionRequest(request([item(), item(), item(), item()])).code, "batch_size");
  assert.equal(parseBoardPromotionRequest(request([item(), item()])).code, "duplicate_card");
});

test("unknown kind, a path, and a URL never become a promotion", () => {
  assert.equal(parseBoardPromotionRequest(request([item({ kind: "unknown" })])).code, "kind_not_explicit");
  assert.equal(
    parseBoardPromotionRequest(request([item({ executionBrief: "lib/amux stays closed" })])).code,
    "content_refused",
  );
  assert.equal(
    parseBoardPromotionRequest(request([item({ executionBrief: "see https://example.com" })])).code,
    "content_refused",
  );
});

test("only an unowned backlog card with a matching source and no execution is promotable", () => {
  const parsed = parseBoardPromotionRequest(request([item()]));
  const facts = new Map([[cardId, fact()]]);
  const ready = classifyBoardPromotion(parsed.request, facts);
  assert.equal(ready.refusal, null);
  assert.equal(ready.promote.length, 1);
  const write = boardPromotionCardWrite(ready.promote[0]);
  assert.equal(write.where.status, "backlog");
  assert.equal(write.where.owner, null);
  assert.equal(write.data.status, "todo");
  assert.equal(write.data.revision, 3);
  assert.equal(write.data.kind, "code");
  assert.equal(Object.hasOwn(write.data, "owner"), false);
  assert.equal(classifyBoardPromotion(parsed.request, new Map()).refusal, "card_missing");
  assert.equal(
    classifyBoardPromotion(parsed.request, new Map([[cardId, fact({ status: "todo" })]])).refusal,
    "not_backlog",
  );
  assert.equal(
    classifyBoardPromotion(parsed.request, new Map([[cardId, fact({ owner: "worker" })]])).refusal,
    "owned",
  );
  assert.equal(
    classifyBoardPromotion(parsed.request, new Map([[cardId, fact({ dependencies: [{ status: "todo", archivedAt: null }] })]])).refusal,
    "dependency_blocked",
  );
  assert.equal(
    classifyBoardPromotion(parsed.request, new Map([[cardId, fact({ attemptCount: 1 })]])).refusal,
    "attempt_present",
  );
});

test("the route cannot turn the latch on and the page stays unlisted", () => {
  const core = read("lib/amux/boardPromotionCore.ts");
  const service = read("lib/amux/boardPromotionService.ts");
  const route = read("app/api/admin/amux/board-promotion/route.ts");
  assert.equal(core.includes("BOARD_PROMOTION_APPLY_CODE_LATCH = true"), true);
  assert.equal(core.includes("codeLatch: true"), false);
  const panel = read("components/admin/AmuxBoardPromotionPanel.tsx");
  assert.match(service, /codeLatch: BOARD_PROMOTION_APPLY_CODE_LATCH/);
  assert.equal(service.includes('codeLatch: true'), false);
  const applyStart = service.indexOf("export async function applyBoardPromotion");
  const applyEnd = service.indexOf("export async function markBoardPromotionOutcomeUnknown");
  const apply = service.slice(applyStart, applyEnd);
  const marker = 'throw new BoardImportError("apply_disabled", 409, input.approvalId)';
  const refused = apply.indexOf(marker);
  const transaction = apply.indexOf("return withPromotionTransaction");
  assert.ok(applyStart >= 0 && applyEnd > applyStart);
  assert.equal(refused, apply.lastIndexOf(marker));
  assert.ok(refused > 0 && transaction > refused);
  assert.equal(service.includes("TOMVERSE_AMUX_EXECUTE"), false);
  assert.equal(service.includes("lib/amux/execution"), false);
  assert.equal(route.includes("codeLatch"), false);
  assert.equal(route.includes("BOARD_PROMOTION_APPLY_CODE_LATCH"), false);
  assert.match(route, /adminApprovalErrorResponse/);
  assert.match(panel, /const applyReady = result\?\.applyPermitted === true && approvalId\.trim\(\)\.length > 0/);
  assert.match(panel, /disabled=\{pending \|\| !applyReady\}/);
  assert.match(panel, /ADMIN_REAUTHENTICATION_REQUIRED/);
  assert.match(panel, /adminRecentAuthenticationHref/);
  const page = resolveAdminPageMeta("/admin/amux-board-promotion");
  assert.equal(page.label, "AMUX card promotion");
  assert.equal(page.isKnown, true);
  assert.equal(
    ADMIN_SEARCHABLE_PAGES.some((entry) => entry.href === "/admin/amux-board-promotion"),
    false,
  );
});
