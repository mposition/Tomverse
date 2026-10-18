import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import { openAmuxContent, sealAmuxContent } from "../lib/amux/ideaCrypto.ts";
import { createAmuxContentUnitKeys, deleteAmuxContentUnitKey,
  finishClaimedAmuxReadManifestKeyRetirement, loadAmuxContentUnitKeys,
  retireClaimedAmuxReadManifestKey, verifyAmuxReadManifestKeyRetired,
  verifyAmuxContentUnitKeyAbsent } from
  "../lib/amux/ideaKeyStore.ts";

test("S3 key deletion makes a retained DB ciphertext unrecoverable", async () => {
  const objects = new Map();
  let listing = "empty";
  let deleteCount = 0;
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
      deleteCount += 1;
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

    await assert.rejects(verifyAmuxContentUnitKeyAbsent(identity, env),
      { code: "outcome_unknown" });
    assert.equal(deleteCount, 0, "readback never sends DeleteObject");
    await deleteAmuxContentUnitKey(identity, env);
    await verifyAmuxContentUnitKeyAbsent(identity, env);
    assert.equal(deleteCount, 1, "verified readback does not repeat deletion");
    assert.equal(objects.size, 0);
    await assert.rejects(loadAmuxContentUnitKeys(identity, env),
      { code: "missing" });
    assert.equal(ciphertext.ciphertext.length > 0, true);
    for (const variant of ["version", "delete_marker", "truncated"]) {
      listing = variant;
      await createAmuxContentUnitKeys(identity, env);
      await assert.rejects(deleteAmuxContentUnitKey(identity, env),
        { code: "outcome_unknown" });
      const priorDeletes = deleteCount;
      await assert.rejects(verifyAmuxContentUnitKeyAbsent(identity, env),
        { code: "outcome_unknown" });
      assert.equal(deleteCount, priorDeletes);
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
  }
});

test("retired read-manifest key fences delayed creates and removes old versions", async () => {
  const objects = new Map();
  let nextVersion = 1;
  let holdNextCreate = false;
  let failNextDelete = false;
  let failNextGet = false;
  let loseNextFenceResponse = false;
  let versioningStatus = "Enabled";
  let releaseCreate;
  let createArrived;
  const arrived = new Promise((resolve) => { createArrived = resolve; });
  const held = new Promise((resolve) => { releaseCreate = resolve; });
  let fenceWrites = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const path = url.pathname;
    if (request.method === "GET" && url.searchParams.has("versioning")) {
      response.writeHead(200, { "Content-Type": "application/xml" });
      response.end(`<VersioningConfiguration>${versioningStatus ?
        `<Status>${versioningStatus}</Status>` : ""}</VersioningConfiguration>`);
      return;
    }
    if (request.method === "GET" && url.searchParams.has("versions")) {
      const prefix = url.searchParams.get("prefix");
      const entries = objects.get(`/amux-test-keys/${prefix}`) ?? [];
      response.writeHead(200, { "Content-Type": "application/xml" });
      response.end(`<ListVersionsResult><IsTruncated>false</IsTruncated>${
        entries.map((item, index) => `<Version><Key>${prefix}</Key><VersionId>${item.id}</VersionId><IsLatest>${index === entries.length - 1}</IsLatest></Version>`).join("")
      }</ListVersionsResult>`);
      return;
    }
    if (request.method === "PUT") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      if (holdNextCreate && request.headers["if-none-match"] === "*") {
        holdNextCreate = false;
        createArrived();
        await held;
      }
      const entries = objects.get(path) ?? [];
      if (request.headers["if-none-match"] === "*" && entries.length) {
        response.writeHead(412); response.end(); return;
      }
      if (request.headers["if-none-match"] !== "*") fenceWrites += 1;
      const id = `version-${nextVersion++}`;
      const updated = versioningStatus ? entries : [];
      updated.push({ id, body: Buffer.concat(chunks) });
      objects.set(path, updated);
      if (request.headers["if-none-match"] !== "*" &&
          loseNextFenceResponse) {
        loseNextFenceResponse = false;
        response.writeHead(503); response.end(); return;
      }
      response.writeHead(200, { ETag: '"synthetic"',
        "x-amz-version-id": id }); response.end();
      return;
    }
    if (request.method === "GET") {
      if (failNextGet) {
        failNextGet = false;
        response.writeHead(503); response.end(); return;
      }
      const item = objects.get(path)?.at(-1);
      if (!item) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { "Content-Length": item.body.length,
        "Content-Type": "application/octet-stream",
        "x-amz-version-id": item.id });
      response.end(item.body); return;
    }
    if (request.method === "DELETE") {
      if (failNextDelete) {
        failNextDelete = false;
        response.writeHead(503); response.end(); return;
      }
      const entries = objects.get(path) ?? [];
      objects.set(path, entries.filter((item) =>
        item.id !== url.searchParams.get("versionId")));
      response.writeHead(204); response.end(); return;
    }
    response.writeHead(405); response.end();
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
      purpose: "repository_read_manifest",
      subjectId: "1f8c9c77-2e86-483e-8fbb-2d5e2c32ad78" };
    await createAmuxContentUnitKeys(identity, env);
    await retireClaimedAmuxReadManifestKey(identity, env);
    await verifyAmuxReadManifestKeyRetired(identity, env);
    assert.equal(fenceWrites, 1);
    assert.equal([...objects.values()][0].length, 1,
      "old content-key versions were removed");
    await assert.rejects(loadAmuxContentUnitKeys(identity, env),
      { code: "integrity_unavailable" });
    await assert.rejects(createAmuxContentUnitKeys(identity, env),
      { code: "conflict" });

    const maxResult = { ...identity, purpose: "analysis_result",
      subjectId: "0f8c9c77-2e86-483e-8fbb-2d5e2c32ad78" };
    await createAmuxContentUnitKeys(maxResult, env);
    await retireClaimedAmuxReadManifestKey(maxResult, env);
    await verifyAmuxReadManifestKeyRetired(maxResult, env);
    await assert.rejects(loadAmuxContentUnitKeys(maxResult, env),
      { code: "integrity_unavailable" });
    await assert.rejects(createAmuxContentUnitKeys(maxResult, env),
      { code: "conflict" });

    const delayed = { ...identity,
      subjectId: "2f8c9c77-2e86-483e-8fbb-2d5e2c32ad78" };
    holdNextCreate = true;
    const creation = createAmuxContentUnitKeys(delayed, env);
    await arrived;
    await retireClaimedAmuxReadManifestKey(delayed, env);
    releaseCreate();
    await assert.rejects(creation, { code: "conflict" });
    await verifyAmuxReadManifestKeyRetired(delayed, env);
    assert.equal(fenceWrites, 3);
    await finishClaimedAmuxReadManifestKeyRetirement(delayed, env);
    assert.equal(fenceWrites, 3, "readback recovery never rewrites the fence");

    const interrupted = { ...identity,
      subjectId: "3f8c9c77-2e86-483e-8fbb-2d5e2c32ad78" };
    await createAmuxContentUnitKeys(interrupted, env);
    failNextDelete = true;
    await assert.rejects(retireClaimedAmuxReadManifestKey(interrupted, env),
      { code: "outcome_unknown" });
    await assert.rejects(verifyAmuxReadManifestKeyRetired(interrupted, env),
      { code: "outcome_unknown" });
    const writesBeforeRecovery = fenceWrites;
    await finishClaimedAmuxReadManifestKeyRetirement(interrupted, env);
    await verifyAmuxReadManifestKeyRetired(interrupted, env);
    assert.equal(fenceWrites, writesBeforeRecovery);

    versioningStatus = "";
    const unversioned = { ...identity,
      subjectId: "4f8c9c77-2e86-483e-8fbb-2d5e2c32ad78" };
    await createAmuxContentUnitKeys(unversioned, env);
    await retireClaimedAmuxReadManifestKey(unversioned, env);
    await verifyAmuxReadManifestKeyRetired(unversioned, env);
    await assert.rejects(createAmuxContentUnitKeys(unversioned, env),
      { code: "conflict" });

    versioningStatus = "Enabled";
    const lostResponse = { ...identity,
      subjectId: "5f8c9c77-2e86-483e-8fbb-2d5e2c32ad78" };
    loseNextFenceResponse = true;
    await assert.rejects(retireClaimedAmuxReadManifestKey(lostResponse, env),
      { code: "outcome_unknown" });
    const priorFenceWrites = fenceWrites;
    await verifyAmuxReadManifestKeyRetired(lostResponse, env);
    await finishClaimedAmuxReadManifestKeyRetirement(lostResponse, env);
    assert.equal(fenceWrites, priorFenceWrites,
      "lost fence response is reconciled without another write");

    const preChangeMissing = { ...identity,
      subjectId: "6f8c9c77-2e86-483e-8fbb-2d5e2c32ad78" };
    await assert.rejects(verifyAmuxReadManifestKeyRetired(preChangeMissing,
      env), { code: "outcome_unknown" });
    await finishClaimedAmuxReadManifestKeyRetirement(preChangeMissing, env);
    await verifyAmuxReadManifestKeyRetired(preChangeMissing, env);
    assert.equal(fenceWrites, priorFenceWrites + 1,
      "a pre-change claim with no current key gains a fence");

    const preChangePresent = { ...identity,
      subjectId: "7f8c9c77-2e86-483e-8fbb-2d5e2c32ad78" };
    await createAmuxContentUnitKeys(preChangePresent, env);
    await finishClaimedAmuxReadManifestKeyRetirement(preChangePresent, env);
    await verifyAmuxReadManifestKeyRetired(preChangePresent, env);
    await assert.rejects(loadAmuxContentUnitKeys(preChangePresent, env),
      { code: "integrity_unavailable" });

    const readUnavailable = { ...identity,
      subjectId: "8f8c9c77-2e86-483e-8fbb-2d5e2c32ad78" };
    failNextGet = true;
    const writesBeforeUnknownRead = fenceWrites;
    await assert.rejects(finishClaimedAmuxReadManifestKeyRetirement(
      readUnavailable, env), { code: "outcome_unknown" });
    assert.equal(fenceWrites, writesBeforeUnknownRead,
      "an unavailable read never authorizes a marker write");
  } finally {
    releaseCreate();
    await new Promise((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
  }
});
