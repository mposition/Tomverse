import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AMUX_V4_COLLECTION_APP_ORIGIN_ENV } from
  "../lib/amux/ideaLocalCollectionQueuePoll.mjs";
import { amuxV4SourceCollectorExitCode, resolveAmuxV4GitHubCredential,
  runAmuxV4SourceCollectorCommand } from
  "../scripts/amux-v4-source-collector-once.ts";

const ORIGIN = "https://collector-app.example.test";
const SECRET = "c".repeat(40);
const TOKEN = "github_read_token_0123456789abcdef";
const REPOSITORY = "mposition/Tomverse";
const COLLECTION_ID = "d218de81-0c91-4f5b-8dcb-11f335d68111";
const REQUEST_ID = "d218de81-0c91-4f5b-8dcb-11f335d68112";
const PREVIEW_ID = "d218de81-0c91-4f5b-8dcb-11f335d68113";
const LEASE_ID = "d218de81-0c91-4f5b-8dcb-11f335d68114";
const COMMIT = "a".repeat(40);
const REF = "b".repeat(40);
const ENV = { [AMUX_V4_COLLECTION_APP_ORIGIN_ENV]: ORIGIN,
  TOMVERSE_AMUX_V4_COLLECTION_AGENT_SECRET: SECRET,
  TOMVERSE_AMUX_V4_GITHUB_READ_TOKEN: TOKEN };
const claim = { collectionRequestId: COLLECTION_ID, requestId: REQUEST_ID,
  previewId: PREVIEW_ID, requestDigest: "c".repeat(64), leaseGeneration: 1,
  leaseId: LEASE_ID, leaseExpiresAt: "2099-10-04T08:00:00.000Z",
  sourceByteLimit: 8192, idea: "Review this source",
  source: { kind: "repository_file", repository: REPOSITORY,
    commitSha: COMMIT, path: "README.md" },
  collectionVerified: false, transferAuthorized: false };

function candidate(path = "README.md") {
  const source = "synthetic public source\n";
  const bytes = Buffer.from(source);
  return { status: "unscanned_candidate", inspectedRefs: 1,
    witness: { repositoryId: 25, name: "refs/heads/main", protected: null,
      refObjectSha: REF, refCommitSha: REF },
    file: { status: "verified_file", repositoryId: 25, commitSha: COMMIT,
      path, blobSha: createHash("sha1").update(`blob ${bytes.length}\0`)
        .update(bytes).digest("hex"), size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), text: source } };
}

async function withPinnedOrigin(callback) {
  const previous = process.env[AMUX_V4_COLLECTION_APP_ORIGIN_ENV];
  process.env[AMUX_V4_COLLECTION_APP_ORIGIN_ENV] = ORIGIN;
  try { return await callback(); }
  finally {
    if (previous === undefined) delete process.env[AMUX_V4_COLLECTION_APP_ORIGIN_ENV];
    else process.env[AMUX_V4_COLLECTION_APP_ORIGIN_ENV] = previous;
  }
}

test("missing configuration refuses before any network call", async () => {
  let calls = 0;
  const kind = await runAmuxV4SourceCollectorCommand({ env: {},
    appFetchImpl: async () => { calls += 1; throw new Error("must not fetch"); },
    githubFetchImpl: async () => { calls += 1; throw new Error("must not fetch"); } });
  assert.equal(kind, "refused");
  assert.equal(amuxV4SourceCollectorExitCode(kind), 1);
  assert.equal(calls, 0);
});

test("GitHub identity fetch uses only fixed API host and exact full_name plus positive id", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ id: 25, full_name: REPOSITORY });
  };
  const credential = await resolveAmuxV4GitHubCredential(REPOSITORY,
    TOKEN, new AbortController().signal, fetchImpl);
  assert.deepEqual(credential, { owner: "mposition", repo: "Tomverse",
    expectedRepositoryId: 25, token: TOKEN });
  assert.equal(calls[0].url, "https://api.github.com/repos/mposition/Tomverse");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  for (const body of [
    { id: 0, full_name: REPOSITORY },
    { id: 25, full_name: "mposition/Other" },
    { id: 25, full_name: "mposition/tomverse" },
  ]) {
    assert.equal(await resolveAmuxV4GitHubCredential(REPOSITORY,
      TOKEN, new AbortController().signal, async () => Response.json(body)), null);
  }
  assert.equal(await resolveAmuxV4GitHubCredential("other.example/repo/path",
    TOKEN, new AbortController().signal, fetchImpl), null);
  assert.equal(calls.length, 1);
  assert.equal(await resolveAmuxV4GitHubCredential(REPOSITORY,
    TOKEN, new AbortController().signal, async () => Response.json({ id: 25,
      full_name: REPOSITORY }, { status: 302 })), null);
});

test("oversized identity response and aborted read fail closed", async () => {
  const oversized = { id: 25, full_name: REPOSITORY,
    padding: "x".repeat(128 * 1024) };
  assert.equal(await resolveAmuxV4GitHubCredential(REPOSITORY,
    TOKEN, new AbortController().signal, async () => Response.json(oversized)), null);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await resolveAmuxV4GitHubCredential(REPOSITORY,
    TOKEN, controller.signal, async (_url, init) => {
      assert.equal(init.signal.aborted, true);
      throw new Error("synthetic abort");
    }), null);
});

test("one invocation claims one item, isolates GitHub token and holds scope mismatch", async () =>
  withPinnedOrigin(async () => {
    const appCalls = [];
    const githubCalls = [];
    const appFetchImpl = async (url, init) => {
      appCalls.push({ url, init });
      assert.equal(new URL(url).origin, ORIGIN);
      assert.equal(JSON.stringify(init).includes(TOKEN), false);
      const path = new URL(url).pathname;
      if (path.endsWith("/collection-queue")) return Response.json({ candidates: [
        { collectionRequestId: COLLECTION_ID, expiresAt: "2099-10-04T08:00:00.000Z" },
        { collectionRequestId: "d218de81-0c91-4f5b-8dcb-11f335d68115",
          expiresAt: "2099-10-04T08:00:00.000Z" }], hasMore: false, nextCursor: null });
      if (path.endsWith("/collection-claim")) return Response.json(claim);
      if (path.endsWith("/collection-result")) {
        const result = JSON.parse(init.body);
        assert.equal(result.outcome, "hold");
        assert.equal(result.reason, "source_selection_invalid");
        assert.equal(Object.hasOwn(result, "source"), false);
        return Response.json({ collectionRequestId: COLLECTION_ID,
          requestId: REQUEST_ID, previewId: PREVIEW_ID, state: "hold",
          resultDigest: null, collectionVerified: false, transferAuthorized: false });
      }
      throw new Error("unexpected app route");
    };
    const kind = await runAmuxV4SourceCollectorCommand({ env: ENV,
      appFetchImpl,
      githubFetchImpl: async (url, init) => {
        githubCalls.push({ url, init });
        return Response.json({ id: 25, full_name: REPOSITORY });
      },
      collectCandidate: async (config) => {
        assert.equal(config.token, TOKEN);
        assert.equal(config.expectedRepositoryId, 25);
        return candidate("OTHER.md");
      } });
    assert.equal(kind, "hold");
    assert.equal(amuxV4SourceCollectorExitCode(kind), 0);
    assert.equal(githubCalls.length, 1);
    assert.equal(appCalls.length, 3);
    assert.equal(appCalls.filter(({ url }) => url.endsWith("/collection-claim")).length, 1);
  }));

test("unknown result is nonzero and is not retried", async () =>
  withPinnedOrigin(async () => {
    let resultCalls = 0;
    const kind = await runAmuxV4SourceCollectorCommand({ env: ENV,
      appFetchImpl: async (url) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/collection-queue")) return Response.json({ candidates: [
          { collectionRequestId: COLLECTION_ID, expiresAt: "2099-10-04T08:00:00.000Z" }],
          hasMore: false, nextCursor: null });
        if (path.endsWith("/collection-claim")) return Response.json(claim);
        resultCalls += 1;
        return Response.json({ error: "outcome_unknown" }, { status: 503 });
      },
      githubFetchImpl: async () => Response.json({ id: 25, full_name: REPOSITORY }),
      collectCandidate: async () => candidate() });
    assert.equal(kind, "result_unknown");
    assert.equal(amuxV4SourceCollectorExitCode(kind), 1);
    assert.equal(resultCalls, 1);
  }));
