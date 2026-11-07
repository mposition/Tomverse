import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { AmuxIdeaCardCloseForm, type AmuxIdeaCardCloseFormView } from "@/components/admin/AmuxIdeaCardClosePanel";
import { adminAmuxIdeaCardCloseMessages } from "@/lib/adminMessages/amuxIdeaCardClose";

// The card close panel on an idea's detail (docs/policy/amux-decision-maker.md
// §2-10): an open question offers close and keep; with none open the owner's
// direct close offers close alone and says the Decision Maker is not asked.

const router: AppRouterInstance = {
  back: () => {}, forward: () => {}, refresh: () => {}, push: () => {},
  replace: () => {}, prefetch: () => {}, bfcacheId: "amux-idea-card-close-fixture",
};
const render = (view: AmuxIdeaCardCloseFormView) => renderToStaticMarkup(
  <AppRouterContext.Provider value={router}>
    <AmuxIdeaCardCloseForm ideaId="idea-0000-card-close" view={view} />
  </AppRouterContext.Provider>);

const cards = [
  { id: "t", displayKey: "AMUX-STARTERCHK-001-T002", cardType: "task", status: "blocked",
    blockReason: "usage_outcome_unknown" as const, updatedAtMs: 0 },
  { id: "s", displayKey: null, cardType: "story", status: "backlog" },
];
const messages = (markup: string) => markup.includes(adminAmuxIdeaCardCloseMessages.ko.close)
  ? adminAmuxIdeaCardCloseMessages.ko : adminAmuxIdeaCardCloseMessages.en;

test("an open question offers close and keep, and says nothing of a direct close", () => {
  const markup = render({ kind: "question", question: { questionId: "00000000-0000-4000-8000-00000000000a",
    reasonCode: "blocked_task", cards, handedOff: false, createdAt: "2026-11-06T00:00:00.000Z" } });
  const m = messages(markup);
  assert.match(markup, /data-kind="question"/);
  assert.ok(markup.includes(m.close) && markup.includes(m.keep));
  assert.doesNotMatch(markup, /data-testid="amux-idea-card-close-direct"/);
  assert.ok(markup.includes("AMUX-STARTERCHK-001-T002"));
});

test("with no question open the owner can close directly, and only close", () => {
  const markup = render({ kind: "direct", direct: { reasonCode: "blocked_task", cards } });
  const m = messages(markup);
  assert.match(markup, /data-kind="direct"/);
  assert.match(markup, /data-testid="amux-idea-card-close-direct"/);
  assert.ok(markup.includes(m.direct));
  assert.ok(markup.includes(m.close));
  assert.ok(!markup.includes(`>${m.keep}<`), "keeping is what not pressing the button does");
  assert.ok(markup.includes(m.reasons.blocked_task));
  assert.equal(markup.split("<li").length - 1, 2, "every card that would close is listed");
  assert.ok(markup.includes(">s<"), "a card without a number shows its id");
});

test("both Admin locales carry the direct close's messages", () => {
  const { en, ko } = adminAmuxIdeaCardCloseMessages;
  for (const key of ["direct", "notClosable"] as const) {
    assert.ok(en[key].length > 0 && ko[key].length > 0, key);
  }
});
