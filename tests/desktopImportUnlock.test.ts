import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { desktopImportUnlockEnabled, lockedContinuationSource } from "../lib/desktopImportUnlockCore.ts";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("the Desktop import unlock switch is off unless it is exactly true", () => {
  assert.equal(desktopImportUnlockEnabled({}), false);
  for (const value of ["", "1", "TRUE", "yes", " true"]) {
    assert.equal(desktopImportUnlockEnabled({ TOMVERSE_DESKTOP_IMPORT_UNLOCK_ENABLED: value }), false, value);
  }
  assert.equal(desktopImportUnlockEnabled({ TOMVERSE_DESKTOP_IMPORT_UNLOCK_ENABLED: "true" }), true);
});

test("a locked source names its snapshot only to a Desktop request while the switch is on", () => {
  assert.deepEqual(lockedContinuationSource({ snapshotId: "ext_1", enabled: true, desktopRequest: true }),
    { status: "locked", externalConversationId: "ext_1" });
  assert.deepEqual(lockedContinuationSource({ snapshotId: "ext_1", enabled: false, desktopRequest: true }), { status: "locked" });
  assert.deepEqual(lockedContinuationSource({ snapshotId: "ext_1", enabled: true, desktopRequest: false }), { status: "locked" });
  assert.equal("externalConversationId" in lockedContinuationSource({ snapshotId: "ext_1", enabled: false, desktopRequest: false }), false);
});

test("the id is read from the owner-scoped snapshot and only the snapshot lock branch carries it", () => {
  const service = read("lib/externalContinuationService.ts");
  const start = service.indexOf("export async function getContinuationTimeline(");
  assert.ok(start > 0);
  const body = service.slice(start);
  const bridge = body.indexOf("getContinuationBridge(userId, conversationId)");
  const snapshot = body.indexOf("where: { id: bridge.externalConversationId, userId, finalized: true }");
  const helper = body.indexOf("lockedContinuationSource({");
  assert.ok(bridge > 0 && snapshot > bridge && helper > snapshot, "the id helper must come after both owner-scoped reads");
  assert.equal(body.split("lockedContinuationSource({").length, 2, "one call site");
  // A linked Review context that is refused must stay a bare locked answer.
  const reviewRefusal = body.indexOf('if (reviewReference?.status === "unavailable")');
  assert.match(body.slice(reviewRefusal, reviewRefusal + 160), /source: \{ status: "locked" \}/);
  assert.match(body.slice(helper - 20, helper + 260), /options\.request\.headers\.get\("origin"\) === DESKTOP_APP_ORIGIN/);
});

test("the continuation route stays owner-scoped before the timeline is read", () => {
  const route = read("app/api/conversations/[conversationId]/continuation/route.ts");
  assert.match(route, /prisma\.conversation\.findFirst\(\{\s*where: \{ id: conversationId, userId,/);
  assert.ok(route.indexOf("conversation.findFirst") < route.indexOf("getContinuationTimeline("));
});

test("the verify route is the only place that issues an external conversation grant", () => {
  const issuers: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(root, dir))) {
      const path = `${dir}/${name}`;
      if (statSync(join(root, path)).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name) && /createResourceUnlockCookie\(|createConversationUnlockCookie\(/.test(read(path))) issuers.push(path);
    }
  };
  walk("app");
  walk("lib");
  walk("components");
  assert.deepEqual(issuers.sort(), [
    "app/api/conversations/[conversationId]/verify/route.ts",
    "app/api/external-conversations/[conversationId]/lock/verify/route.ts",
    "lib/conversationLock.ts",
  ]);
});
