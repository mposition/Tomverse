import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import { openAmuxContent, sealAmuxContent } from "../lib/amux/ideaCrypto.ts";
import { createAmuxContentUnitKeys, deleteAmuxContentUnitKey,
  loadAmuxContentUnitKeys } from "../lib/amux/ideaKeyStore.ts";

test("S3 key deletion makes a retained DB ciphertext unrecoverable", async () => {
  const objects = new Map();
  let deleteCount = 0;
  let failNextHead = false;
  let failHeadAfterDelete = false;
  let loseNextDeleteReply = false;
  const server = createServer(async (request, response) => {
    const key = new URL(request.url, "http://127.0.0.1").pathname;
    if (request.method === "PUT") {
      if (objects.has(key)) { response.writeHead(412); response.end(); return; }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      objects.set(key, Buffer.concat(chunks));
      response.writeHead(200, { ETag: '"synthetic"' }); response.end();
    } else if (request.method === "GET") {
      const value = objects.get(key);
      if (!value) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { "Content-Length": value.length,
        "Content-Type": "application/octet-stream" }); response.end(value);
    } else if (request.method === "HEAD") {
      if (failNextHead) { failNextHead = false; response.writeHead(503); response.end(); return; }
      response.writeHead(objects.has(key) ? 200 : 404); response.end();
    } else if (request.method === "DELETE") {
      deleteCount += 1;
      objects.delete(key);
      if (failHeadAfterDelete) { failNextHead = true; failHeadAfterDelete = false; }
      response.writeHead(loseNextDeleteReply ? 503 : 204); response.end();
      loseNextDeleteReply = false;
    } else { response.writeHead(405); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const env = {
      NODE_ENV: "test",
      AMUX_V4_CONTENT_MASTER_KEY_ID: "synthetic-global",
      AMUX_V4_CONTENT_MASTER_KEY_VERSION: "1",
      AMUX_V4_CONTENT_MASTER_KEY_B64: randomBytes(32).toString("base64"),
      AMUX_V4_CONTENT_DIGEST_KEY_ID: "synthetic-digest",
      AMUX_V4_CONTENT_DIGEST_KEY_B64: randomBytes(32).toString("base64"),
      AMUX_V4_KEY_STORE_BUCKET: "amux-test-keys",
      AMUX_V4_KEY_STORE_REGION: "test-region",
      AMUX_V4_KEY_STORE_ENDPOINT: `http://127.0.0.1:${address.port}`,
      AMUX_V4_KEY_STORE_ACCESS_KEY_ID: "synthetic-access",
      AMUX_V4_KEY_STORE_SECRET_ACCESS_KEY: "synthetic-secret",
      AMUX_V4_KEY_STORE_URL_STYLE: "path",
    };
    const identity = { ideaId: "1e5f6f12-4281-4879-ae75-8ab0d2a57b44",
      purpose: "analysis_draft", subjectId: "1f8c9c77-2e86-483e-8fbb-2d5e2c32ad78" };
    const keys = await createAmuxContentUnitKeys(identity, env);
    const ciphertext = sealAmuxContent(Buffer.from("synthetic proposal"),
      identity.purpose, identity.subjectId, keys);
    const loaded = await loadAmuxContentUnitKeys(identity, env);
    assert.deepEqual(openAmuxContent(ciphertext, identity.purpose,
      identity.subjectId, loaded), Buffer.from("synthetic proposal"));
    await assert.rejects(createAmuxContentUnitKeys(identity, env),
      { code: "conflict" });
    await deleteAmuxContentUnitKey(identity, env);
    assert.equal(objects.size, 0);
    assert.equal(deleteCount, 1);
    await assert.rejects(loadAmuxContentUnitKeys(identity, env),
      { code: "missing" });
    // The DB ciphertext still exists but no surviving object-store key can
    // unwrap its data key, even with the global app master available.
    assert.equal(ciphertext.ciphertext.length > 0, true);

    const second = { ...identity,
      subjectId: "1f8c9c77-2e86-483e-8fbb-2d5e2c32ad79" };
    await createAmuxContentUnitKeys(second, env);
    loseNextDeleteReply = true;
    await deleteAmuxContentUnitKey(second, env);
    assert.equal(deleteCount, 2);
    assert.equal(objects.size, 0);

    const third = { ...identity,
      subjectId: "1f8c9c77-2e86-483e-8fbb-2d5e2c32ad80" };
    await createAmuxContentUnitKeys(third, env);
    // Fail the first post-delete read-back. The next invocation must HEAD
    // the missing key and must not send another DELETE.
    const originalDeleteCount = deleteCount;
    failHeadAfterDelete = true;
    await assert.rejects(deleteAmuxContentUnitKey(third, env),
      { code: "outcome_unknown" });
    await deleteAmuxContentUnitKey(third, env);
    assert.equal(deleteCount, originalDeleteCount + 1);
    assert.equal(objects.size, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
  }
});
