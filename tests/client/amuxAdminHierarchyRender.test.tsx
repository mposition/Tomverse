import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AmuxCardHierarchyList } from "@/components/admin/AmuxCardHierarchyList";
import type { AmuxAdminCardRow, AmuxAdminHierarchyNode } from "@/lib/amux/adminCardList";
import { adminAmuxCardsMessages } from "@/lib/adminMessages/amuxCards";

const nodes: AmuxAdminHierarchyNode[] = [
  { id: "initiative-1", level: "initiative", parentId: null, state: "active" },
  { id: "epic-1", level: "epic", parentId: "initiative-1", state: "active" },
  { id: "feature-1", level: "feature", parentId: "epic-1", state: "active" },
];
const row = (id: string, cardType: string | null, story: string | null = null) => ({
  id, sourceKey: id, cardType, parentFeatureNodeId: cardType ? "feature-1" : null,
  parentStoryCardId: story, status: "backlog", kind: cardType ?? "unknown",
}) as AmuxAdminCardRow;

test("hierarchy render identifies page scope, direct tasks, off-page Story, and readable levels", () => {
  const html = renderToStaticMarkup(<AmuxCardHierarchyList
    rows={[row("task-direct", "task"), row("task-child", "task", "story-off-page"),
      row("legacy", null)]}
    nodes={nodes} total={80} messages={adminAmuxCardsMessages.en} />);
  assert.match(html, /data-testid="amux-hierarchy-list"/);
  assert.match(html, /this page&#x27;s 3 of 80 cards/);
  assert.match(html, /Story outside this page · story-off-page/);
  assert.match(html, /Unlinked or incomplete hierarchy/);
  assert.match(html, /Level 4: <\/span><span class="font-medium">task · task-direct/);
  assert.match(html, /Level 5: <\/span><span class="font-medium">task · task-child/);
  assert.match(html, /<ol class="ms-5 mt-1 space-y-1">/);
  assert.match(html, /<section aria-labelledby="amux-hierarchy-unlinked-heading"><h3 id="amux-hierarchy-unlinked-heading"/);
  assert.match(html,
    /feature · feature-1<\/span><span[^>]*>active<\/span><ol[^>]*><li[^>]*>(?:(?!<\/li>).)*task · task-direct/s);
  assert.match(html,
    /Story outside this page · story-off-page<\/span><ol[^>]*><li[^>]*>(?:(?!<\/li>).)*task · task-child/s);
  assert.doesNotMatch(html, /Level 2: <\/span><span class="font-medium">unknown · legacy/);
  assert.equal((html.match(/<li /g) ?? []).length, 7);
});

test("Korean hierarchy render keeps the same explicit page scope and level labels", () => {
  const html = renderToStaticMarkup(<AmuxCardHierarchyList
    rows={[row("story-1", "story")]} nodes={nodes} total={5}
    messages={adminAmuxCardsMessages.ko} />);
  assert.match(html, /전체 5장 중 현재 페이지 1장의 구조/);
  assert.match(html, /4단계: <\/span><span class="font-medium">story · story-1/);
});
