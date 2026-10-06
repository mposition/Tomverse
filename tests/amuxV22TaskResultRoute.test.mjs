import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { GET, POST } from
  "../app/api/internal/amux/v22/execution/result/route.ts";
import { normalizeV22OptionalPatch } from
  "../lib/amux/v22OptionalPatch.ts";

const secret = "synthetic-sync-secret-0123456789abcdef";
const endpoint = "https://tomverse.test/api/internal/amux/v22/execution/result";
const request = (body, key = secret) => new Request(endpoint, {
  method: "POST", headers: { authorization: `Bearer ${key}`,
    "content-type": "application/json" }, body: JSON.stringify(body),
});

test("POST preserves a private result when publication evidence is rejected", () => {
  const child = spawnSync(process.execPath, [
    "--experimental-test-module-mocks", "--conditions=react-server",
    "--import", "tsx",
    resolve("tests/support/amuxV22TaskResultRoutePostHarness.mjs"),
  ], { cwd: process.cwd(), encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  assert.equal(child.status, 0, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
  assert.match(child.stdout, /AMUX_V22_RESULT_ROUTE_POST_OK/);
});

test("v22 result write remains env-closed and validates body before DB access", async () => {
  const oldSecret = process.env.TOMVERSE_AMUX_SYNC_SECRET;
  const oldSwitch = process.env.TOMVERSE_AMUX_V22_TASK_RESULT_WRITE;
  try {
    process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;
    delete process.env.TOMVERSE_AMUX_V22_TASK_RESULT_WRITE;
    assert.equal((await POST(request({ prompt: "private" }, "wrong"))).status, 401);
    const closed = await POST(request({ prompt: "private" }));
    assert.equal(closed.status, 409);
    assert.equal(closed.headers.get("Cache-Control"), "no-store");
    process.env.TOMVERSE_AMUX_V22_TASK_RESULT_WRITE = "enabled";
    assert.equal((await POST(request({ prompt: "private" }))).status, 400);
    const patchText = "diff --git a/components/chat/X.tsx b/components/chat/X.tsx\n";
    const invalidEvidence = normalizeV22OptionalPatch({ text: patchText,
        sha256: createHash("sha256").update(patchText).digest("hex"),
        baseSha: "a".repeat(40), files: [{ path: "../escape",
          mode: "100644", bytesBase64: "YQ==" }] });
    assert.equal(invalidEvidence.patch, undefined);
    assert.equal(invalidEvidence.patchRejected, true);
    const unboundFiles = normalizeV22OptionalPatch({ text: patchText,
        sha256: createHash("sha256").update(patchText).digest("hex"),
        baseSha: "a".repeat(40), files: [{ path: "tests/example.test.mjs",
          mode: "100644", bytesBase64: "YQ==" }] });
    assert.equal(unboundFiles.patch, undefined);
    assert.equal(unboundFiles.patchRejected, true);
    const secretPatch = normalizeV22OptionalPatch({ text: patchText +
      "ghp_" + "A".repeat(40), sha256: createHash("sha256")
        .update(patchText + "ghp_" + "A".repeat(40)).digest("hex"),
      baseSha: "a".repeat(40) });
    assert.equal(secretPatch.patch, undefined);
    assert.equal(secretPatch.patchRejected, true);
    const valid = normalizeV22OptionalPatch({ text: patchText,
      sha256: createHash("sha256").update(patchText).digest("hex"),
      baseSha: "a".repeat(40) });
    assert.equal(valid.patch?.text, patchText);
    assert.equal(valid.patchRejected, false);
    assert.equal((await GET(new Request(`${endpoint}?attemptId=x&extra=y`, {
      headers: { authorization: `Bearer ${secret}` },
    }))).status, 400);
  } finally {
    if (oldSecret === undefined) delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    else process.env.TOMVERSE_AMUX_SYNC_SECRET = oldSecret;
    if (oldSwitch === undefined)
      delete process.env.TOMVERSE_AMUX_V22_TASK_RESULT_WRITE;
    else process.env.TOMVERSE_AMUX_V22_TASK_RESULT_WRITE = oldSwitch;
  }
});
