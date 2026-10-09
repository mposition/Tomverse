import assert from "node:assert/strict";
import test from "node:test";

import { amuxV4UnitBrowserCookieName, amuxV4UnitBrowserDigest,
  matchesAmuxV4UnitBrowserDigest, newAmuxV4UnitBrowserNonce,
  readAmuxV4UnitBrowserNonce } from "../lib/amux/ideaUnitBrowserCore.ts";

const key = { digestKeyId: "unit_key_v1", digestKey: Buffer.alloc(32, 3) };
const base = () => ({ decisionId: "decision_00001", actorUserId: "owner_0000001",
  authenticatedAt: "2026-10-05T01:00:00.000Z",
  nonce: newAmuxV4UnitBrowserNonce(), key });

test("one browser and login bind a prepared decision; relogin and duplicates fail", () => {
  const input = base();
  const result = amuxV4UnitBrowserDigest(input);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.equal(matchesAmuxV4UnitBrowserDigest(result.digest, input), true);
  assert.equal(matchesAmuxV4UnitBrowserDigest(result.digest,
    { ...input, authenticatedAt: "2026-10-05T01:01:00.000Z" }), false);
  assert.equal(matchesAmuxV4UnitBrowserDigest(result.digest,
    { ...input, nonce: newAmuxV4UnitBrowserNonce() }), false);
  const name = amuxV4UnitBrowserCookieName(input.decisionId);
  assert.equal(readAmuxV4UnitBrowserNonce(`${name}=${input.nonce}`, input.decisionId),
    input.nonce);
  assert.equal(readAmuxV4UnitBrowserNonce(`${name}=${input.nonce}; ${name}=${input.nonce}`,
    input.decisionId), null);
});
