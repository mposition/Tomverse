import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  guestAutoRetryMetadata,
  isGuestAutoRetryBlocked,
} from "../lib/guestAutoRetry.ts";

test("only a Guest Auto send records the one-shot retry boundary", () => {
  const guestAuto = guestAutoRetryMetadata(true, "signed-authority");

  assert.deepEqual(guestAuto, { guestAutoRetryBlocked: true });
  assert.equal(isGuestAutoRetryBlocked(true, guestAuto), true);

  assert.deepEqual(guestAutoRetryMetadata(true, undefined), {});
  assert.equal(isGuestAutoRetryBlocked(true, {}), false);
  assert.deepEqual(guestAutoRetryMetadata(false, "account-auto-token"), {});
  assert.equal(isGuestAutoRetryBlocked(false, guestAuto), false);
});

test("the generic Retry action is both hidden and guarded for Guest Auto", () => {
  const source = readFileSync("components/chat/ChatApp.tsx", "utf8");

  assert.match(
    source,
    /if \(!lastPrompt \|\| isGuestAutoRetryBlocked\(isGuestMode, lastPrompt\)\) return;/
  );
  assert.match(
    source,
    /transcriptScope === "model" &&\s*!isGuestAutoRetryBlocked\(\s*isGuestMode,\s*getChatAppRetryPrompt\(runtimeKey\)/
  );
  assert.match(
    source,
    /\.\.\.guestAutoRetryMetadata\(isGuestMode, guestAutoCapability\)/
  );
});
