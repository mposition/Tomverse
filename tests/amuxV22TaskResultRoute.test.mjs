import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { GET, POST } from
  "../app/api/internal/amux/v22/execution/result/route.ts";

const secret = "synthetic-sync-secret-0123456789abcdef";
const endpoint = "https://tomverse.test/api/internal/amux/v22/execution/result";
const request = (body, key = secret) => new Request(endpoint, {
  method: "POST", headers: { authorization: `Bearer ${key}`,
    "content-type": "application/json" }, body: JSON.stringify(body),
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
    const invalidEvidence = await POST(request({
      attemptId: "00000000-0000-4000-8000-000000000001",
      worker: "synthetic-worker", resultText: "synthetic result",
      sourceSha256: createHash("sha256").update("synthetic result")
        .digest("hex"),
      patch: { text: patchText,
        sha256: createHash("sha256").update(patchText).digest("hex"),
        baseSha: "a".repeat(40), files: [{ path: "../escape",
          mode: "100644", bytesBase64: "YQ==" }] },
    }));
    assert.equal(invalidEvidence.status, 400);
    const unboundFiles = await POST(request({
      attemptId: "00000000-0000-4000-8000-000000000001",
      worker: "synthetic-worker", resultText: "synthetic result",
      sourceSha256: createHash("sha256").update("synthetic result")
        .digest("hex"),
      patch: { text: patchText,
        sha256: createHash("sha256").update(patchText).digest("hex"),
        baseSha: "a".repeat(40), files: [{ path: "tests/example.test.mjs",
          mode: "100644", bytesBase64: "YQ==" }] },
    }));
    assert.equal(unboundFiles.status, 400);
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
