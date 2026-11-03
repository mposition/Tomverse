import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createR2ReadUrl, createR2UploadUrl } from "../lib/r2.ts";
import { validateMobileUpload } from "../apps/mobile/src/nativeUpload.ts";

const fixture = {
  R2_ACCOUNT_ID: "synthetic-account",
  R2_ACCESS_KEY_ID: "synthetic-access-key",
  R2_SECRET_ACCESS_KEY: "synthetic-secret-key",
  R2_BUCKET_NAME: "synthetic-attachments",
  R2_ENDPOINT: "https://synthetic-endpoint.r2.cloudflarestorage.com",
  R2_SIGNED_URL_TTL: "900",
};
const previous = new Map(Object.keys(fixture).map(key => [key, process.env[key]]));
before(() => Object.assign(process.env, fixture));
after(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// Real SDK signing, synthetic credentials, no storage/network operations.
test("server-signed uploads satisfy the installed native client's destination guard", async () => {
  const key = "attachments/synthetic-user/notes with spaces.txt";
  const mediaType = "text/plain";
  const raw = await createR2UploadUrl(key, mediaType, 4);
  const target = new URL(raw);

  assert.doesNotThrow(() => validateMobileUpload(raw, { "Content-Type": mediaType }));
  assert.equal(target.origin, fixture.R2_ENDPOINT);
  assert.equal(decodeURIComponent(target.pathname), `/${fixture.R2_BUCKET_NAME}/${key}`);
  assert.equal(target.searchParams.get("X-Amz-Expires"), fixture.R2_SIGNED_URL_TTL);
  assert.ok(target.searchParams.get("X-Amz-Signature"));
  assert.ok(target.searchParams.get("X-Amz-SignedHeaders").split(";").includes("content-length"));
  assert.throws(() => validateMobileUpload(raw, { Authorization: "Bearer synthetic" }));
  assert.throws(() => validateMobileUpload(raw.replace(target.hostname, "untrusted.invalid"), {}));
});

test("read links retain their existing bucket, object and addressing contract", async () => {
  const key = "attachments/synthetic-user/saved.pdf";
  const target = new URL(await createR2ReadUrl(key, 300));

  assert.equal(target.hostname, `${fixture.R2_BUCKET_NAME}.${new URL(fixture.R2_ENDPOINT).hostname}`);
  assert.equal(decodeURIComponent(target.pathname), `/${key}`);
  assert.equal(target.searchParams.get("X-Amz-Expires"), "300");
  assert.ok(target.searchParams.get("X-Amz-Signature"));
});
