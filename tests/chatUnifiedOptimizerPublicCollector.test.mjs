import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { prepareChatUnifiedOptimizerCandidateGeneration } from
  "../lib/chatUnifiedOptimizerCandidateGeneration.ts";
import { createChatUnifiedOptimizerPublicCollector } from
  "../lib/chatUnifiedOptimizerPublicCollector.ts";

const sourceText = readFileSync(new URL(
  "./fixtures/chat-unified-optimizer/public-development-v1.json", import.meta.url), "utf8");
const sourceBytes = Buffer.from(sourceText);
const commitSha = "1".repeat(40);
const treeShas = [2, 3, 4, 5].map(n => String(n).repeat(40));
const blobSha = createHash("sha1")
  .update(`blob ${sourceBytes.length}\0`).update(sourceBytes).digest("hex");
const pin = { repositoryId: 123, commitSha, blobSha,
  sha256: createHash("sha256").update(sourceBytes).digest("hex") };
const path = "tests/fixtures/chat-unified-optimizer/public-development-v1.json";
const segments = path.split("/");
const rootUrl = "https://api.github.com/repos/mposition/Tomverse";

function setup(options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (options.oversized) return new Response("x".repeat(2 * 1024 * 1024 + 1),
      { headers: { "content-type": "application/json" } });
    if (url === rootUrl) return Response.json({ id: 123,
      full_name: "mposition/Tomverse", private: options.private ?? false });
    if (url === `${rootUrl}/git/commits/${commitSha}`) {
      return Response.json({ sha: commitSha, tree: { sha: treeShas[0] } });
    }
    for (const [index, treeSha] of treeShas.entries()) {
      if (url === `${rootUrl}/git/trees/${treeSha}`) {
        const last = index === segments.length - 1;
        return Response.json({ sha: treeSha, truncated: false, tree: [{
          path: segments[index], mode: last ? "100644" : "040000",
          type: last ? "blob" : "tree",
          sha: last ? blobSha : treeShas[index + 1],
          size: last ? sourceBytes.length : undefined,
        }] });
      }
    }
    if (url === `${rootUrl}/git/blobs/${blobSha}`) {
      return Response.json({ sha: blobSha, encoding: "base64",
        size: sourceBytes.length, content: sourceBytes.toString("base64") });
    }
    return new Response(null, { status: 404 });
  };
  const collector = createChatUnifiedOptimizerPublicCollector({
    repositoryId: 123, fetchImpl,
  });
  return { calls, collector };
}

test("fixed public GitHub collector verifies source without credentials or model dispatch", async () => {
  const fixture = setup();
  const request = await prepareChatUnifiedOptimizerCandidateGeneration({
    requestId: randomUUID(), authorTaskId: randomUUID(),
    sourcePin: pin, collector: fixture.collector,
  });
  assert.equal(request.dispatchAuthorized, false);
  assert.equal(fixture.calls.length, 2 + 1 + treeShas.length + 1);
  assert.deepEqual(fixture.calls.map(call => call.url), [
    rootUrl, `${rootUrl}/git/commits/${commitSha}`,
    ...treeShas.map(sha => `${rootUrl}/git/trees/${sha}`),
    `${rootUrl}/git/blobs/${blobSha}`, rootUrl,
  ]);
  for (const { init } of fixture.calls) {
    assert.equal(init.method, "GET");
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    assert.deepEqual(Object.keys(init.headers).sort(), ["Accept", "X-GitHub-Api-Version"]);
  }
});

test("private repository and oversized response fail before candidate input", async () => {
  for (const options of [{ private: true }, { oversized: true }]) {
    const fixture = setup(options);
    await assert.rejects(prepareChatUnifiedOptimizerCandidateGeneration({
      requestId: randomUUID(), authorTaskId: randomUUID(),
      sourcePin: pin, collector: fixture.collector,
    }), /optimizer_candidate_generation_unavailable/);
    assert.equal(fixture.calls.length, 1);
  }
});
