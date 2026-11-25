import assert from "node:assert/strict";
import test from "node:test";
import { verificationBasis } from "../src/renderer/verificationBasis";

test("only execution records with an ordinary exit status can show a successful command", () => {
  assert.deepEqual(verificationBasis([
    { state: "ok", exitCode: 0 },
    { state: "ok", exitCode: 1 },
    { state: "timeout" },
    { state: "cancelled", exitCode: 0 },
    { state: "started" },
    { state: "ok" },
  ]), { passed: 1, failed: 2, unconfirmed: 3 });
});
