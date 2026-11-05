import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AmuxSessionPlanRefusalPanel, watchAmuxPlanRefusal } from
  "@/components/admin/AmuxSessionPlanRefusalPanel";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";

test("the panel shows nothing until a refusal is read", () => {
  assert.equal(renderToStaticMarkup(createElement(AmuxSessionPlanRefusalPanel,
    { ideaId: "9942fb52-4b78-4af6-931a-9eec8f66d394" })), "");
});

test("a refusal that arrives after the first read still shows, and again after a retry", async () => {
  const refusal = { refusalId: "r", chunkIndex: 0, detail: "chunk_schema_rejected" };
  const replies: Array<typeof refusal | null | Error> =
    [null, refusal, new Error("down"), null, { ...refusal, refusalId: "r2" }];
  const seen: Array<string | null> = [];
  mock.timers.enable({ apis: ["setInterval"] });
  const settle = () => new Promise((done) => setImmediate(done));
  const stop = watchAmuxPlanRefusal(async () => {
    const reply = replies.shift() ?? null;
    if (reply instanceof Error) throw reply;
    return reply;
  }, (value) => seen.push(value?.refusalId ?? null), 1_000);
  try {
    await settle();
    for (let tick = 0; tick < 4; tick += 1) {
      mock.timers.tick(1_000);
      await settle();
    }
    assert.deepEqual(seen, [null, "r", null, "r2"], "a failed read changes nothing");
    stop();
    mock.timers.tick(5_000);
    await settle();
    assert.equal(seen.length, 4, "stopped");
  } finally {
    stop();
    mock.timers.reset();
  }
});

test("both languages name both decisions", () => {
  for (const messages of [adminAmuxIdeaProgressMessages.en, adminAmuxIdeaProgressMessages.ko]) {
    assert.ok(messages.planRefusalRetry && messages.planRefusalStop && messages.planRefusalTitle);
  }
});
