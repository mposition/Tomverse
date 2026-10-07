import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import { openAmuxContent, sealAmuxContent } from "../lib/amux/ideaCrypto.ts";
import { createAmuxContentUnitKeys, deleteAmuxContentUnitKey,
  loadAmuxContentUnitKeys } from "../lib/amux/ideaKeyStore.ts";

test("S3 key deletion makes a retained DB ciphertext unrecoverable", async () => {
  const objects = new Map();
  let listing = "empty";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const key = url.pathname;
    if (request.method === "PUT") {
      if (objects.has(key)) { response.writeHead(412); response.end(); return; }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      objects.set(key, Buffer.concat(chunks));
      response.writeHead(200, { ETag: '"synthetic"' }); response.end();
    } else if (request.method === "GET" && url.searchParams.has("versions")) {
      const prefix = url.searchParams.get("prefix");
      response.writeHead(200, { "Content-Type": "application/xml" });
      response.end(`<ListVersionsResult><IsTruncated>${listing === "truncated"}</IsTruncated>${
        listing === "version" ? `<Version><Key>${prefix}</Key><VersionId>old</VersionId></Version>` :
        listing === "delete_marker" ?
          `<DeleteMarker><Key>${prefix}</Key><VersionId>old</VersionId></DeleteMarker>` :
          ""}</ListVersionsResult>`);
    } else if (request.method === "GET") {
      const value = objects.get(key);
      if (!value) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { "Content-Length": value.length,
        "Content-Type": "application/octet-stream" }); response.end(value);
    } else if (request.method === "HEAD") {
      response.writeHead(objects.has(key) ? 200 : 404); response.end();
    } else if (request.method === "DELETE") {
      objects.delete(key); response.writeHead(204); response.end();
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
    await assert.rejects(loadAmuxContentUnitKeys(identity, env),
      { code: "missing" });
    assert.equal(ciphertext.ciphertext.length > 0, true);
    for (const variant of ["version", "delete_marker", "truncated"]) {
      listing = variant;
      await createAmuxContentUnitKeys(identity, env);
      await assert.rejects(deleteAmuxContentUnitKey(identity, env),
        { code: "outcome_unknown" });
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
  }
});
