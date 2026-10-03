import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { collectAmuxLocalGitHubPreview } from "../lib/amux/ideaLocalGitHubCollector.ts";
import { inspectAmuxIdeaSourceScope } from "../lib/amux/ideaSourceScopeCore.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const TREE = "c".repeat(40);
const TEXT = "A bounded Korean source excerpt.\n";
const BYTES = Buffer.from(TEXT, "utf8");
const BLOB = createHash("sha1").update(`blob ${BYTES.length}\0`, "utf8")
  .update(BYTES).digest("hex");
const PATH = "README.md";
const IDEA = { version: 1, idea: "Review the source", repositories: ["mposition/Tomverse"],
  pullRequests: [{ repository: "mposition/Tomverse", number: 42 }] };
const REPO_SOURCE = { kind: "repository_file", repository: "mposition/Tomverse",
  commitSha: HEAD, path: PATH };
const PR_SOURCE = { kind: "pull_request_file", repository: "mposition/Tomverse",
  number: 42, baseSha: BASE, headSha: HEAD, side: "head", path: PATH };
const scope = (sources) => {
  const inspected = inspectAmuxIdeaSourceScope(JSON.stringify({ version: 1, sources }), IDEA);
  assert.equal(inspected.ok, true);
  return inspected.canonicalJson;
};

function github({ wrongRepository = false, movedRef = false,
  movedPr = false, text = TEXT } = {}) {
  const bytes = Buffer.from(text, "utf8");
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`, "utf8")
    .update(bytes).digest("hex");
  const calls = [];
  let refReads = 0;
  let prReads = 0;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    calls.push(path);
    if (path === "/repos/mposition/Tomverse") {
      return Response.json({ id: wrongRepository ? 26 : 25,
        full_name: "mposition/Tomverse" });
    }
    if (path === "/graphql") {
      const request = JSON.parse(init.body);
      const ref = { name: "main", prefix: "refs/heads/",
        target: { __typename: "Commit",
          oid: movedRef && ++refReads > 1 ? BASE : HEAD } };
      if (request.query.includes("query AmuxIdeaRefs")) {
        return Response.json({ data: { repository: { databaseId: 25,
          refs: { nodes: request.variables.prefix === "refs/heads/" ? [ref] : [],
            pageInfo: { hasNextPage: false, endCursor: null } } } } });
      }
      if (request.query.includes("query AmuxIdeaRef")) {
        return Response.json({ data: { repository: { databaseId: 25, ref } } });
      }
    }
    if (path === "/repos/mposition/Tomverse/pulls/42") {
      prReads += 1;
      return Response.json({ number: 42, changed_files: 1,
        base: { sha: BASE, repo: { id: 25 } },
        head: { sha: movedPr && prReads >= 3 ? BASE : HEAD,
          repo: { id: 25 } } });
    }
    if (path === "/repos/mposition/Tomverse/pulls/42/files") {
      return Response.json([{ filename: PATH, status: "modified" }]);
    }
    if (path === `/repos/mposition/Tomverse/compare/${BASE}...${HEAD}`) {
      return Response.json({ status: "ahead", ahead_by: 1, behind_by: 0,
        total_commits: 1, commits: [{ sha: HEAD }],
        base_commit: { sha: BASE }, merge_base_commit: { sha: BASE } });
    }
    if (path === `/repos/mposition/Tomverse/compare/${HEAD}...${HEAD}`) {
      return Response.json({ status: "identical", ahead_by: 0, behind_by: 0,
        total_commits: 0, commits: [], base_commit: { sha: HEAD },
        merge_base_commit: { sha: HEAD } });
    }
    if (path === `/repos/mposition/Tomverse/git/commits/${HEAD}`) {
      return Response.json({ sha: HEAD, tree: { sha: TREE } });
    }
    if (path === `/repos/mposition/Tomverse/git/commits/${BASE}`) {
      return Response.json({ sha: BASE, tree: { sha: TREE } });
    }
    if (path === `/repos/mposition/Tomverse/git/trees/${TREE}`) {
      return Response.json({ sha: TREE, truncated: false,
        tree: [{ path: PATH, mode: "100644", type: "blob",
          sha: blob, size: bytes.length }] });
    }
    if (path === `/repos/mposition/Tomverse/git/blobs/${blob}`) {
      return Response.json({ sha: blob, encoding: "base64", size: bytes.length,
        content: bytes.toString("base64") });
    }
    throw new Error(`Unexpected synthetic endpoint ${path}`);
  };
  return { fetchImpl, calls };
}

function input(source, fake = github(), overrides = {}) {
  return { previewId: "11111111-1111-4111-8111-111111111111",
    declaredIdea: IDEA, canonicalScopeJson: scope([source]),
    repositoryCredentials: new Map([["mposition/tomverse", {
      owner: "mposition", repo: "Tomverse", expectedRepositoryId: 25,
      token: "synthetic-read-only-token", fetchImpl: fake.fetchImpl }]]),
    selections: [{ sourceIndex: 0, startByte: 0, endByte: BYTES.length }],
    modelId: "gpt-6-astra", digestSecret: "s".repeat(32),
    ...overrides };
}

test("local collector builds a bounded repo excerpt and exact prompt without returning credentials", async () => {
  const fake = github();
  const result = await collectAmuxLocalGitHubPreview(input(REPO_SOURCE, fake));
  assert.equal(result.status, "preview_candidate");
  assert.equal(result.sources[0].excerptText, TEXT);
  assert.match(result.prompt, /A bounded Korean source excerpt/);
  assert.match(result.sourcePreviewDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.unselectedSourceCount, 0);
  assert(!JSON.stringify(result).includes("synthetic-read-only-token"));
  assert(fake.calls.includes(`/repos/mposition/Tomverse/git/blobs/${BLOB}`));
});

test("local collector verifies PR file-list and exact file before candidate preview", async () => {
  const fake = github();
  const result = await collectAmuxLocalGitHubPreview(input(PR_SOURCE, fake));
  assert.equal(result.status, "preview_candidate");
  assert.equal(result.sources[0].commitSha, HEAD);
  assert.equal(fake.calls.filter((path) => path === "/repos/mposition/Tomverse/pulls/42/files").length, 2);
});

test("the preview explicitly counts approved sources not selected for this chunk", async () => {
  const canonicalScopeJson = scope([REPO_SOURCE, PR_SOURCE]);
  // Canonical order is PR before repository; select only the repository file.
  const result = await collectAmuxLocalGitHubPreview(input(REPO_SOURCE, github(), {
    canonicalScopeJson,
    selections: [{ sourceIndex: 1, startByte: 0, endByte: BYTES.length }],
  }));
  assert.equal(result.status, "preview_candidate");
  assert.deepEqual(result.selectedSourceIndices, [1]);
  assert.equal(result.unselectedSourceCount, 1);
});

test("mixed PR and repository excerpts use canonical order with complete provenance", async () => {
  const repositoryAtBase = { ...REPO_SOURCE, commitSha: BASE };
  const canonicalScopeJson = scope([repositoryAtBase, PR_SOURCE]);
  const reversedFake = github();
  const reversed = await collectAmuxLocalGitHubPreview(input(REPO_SOURCE, reversedFake, {
    canonicalScopeJson,
    selections: [
      { sourceIndex: 1, startByte: 0, endByte: BYTES.length },
      { sourceIndex: 0, startByte: 0, endByte: BYTES.length },
    ],
  }));
  const ordered = await collectAmuxLocalGitHubPreview(input(REPO_SOURCE, github(), {
    canonicalScopeJson,
    selections: [
      { sourceIndex: 0, startByte: 0, endByte: BYTES.length },
      { sourceIndex: 1, startByte: 0, endByte: BYTES.length },
    ],
  }));
  assert.equal(reversed.status, "preview_candidate", JSON.stringify({ result: reversed,
    calls: reversedFake.calls }));
  assert.equal(ordered.status, "preview_candidate", JSON.stringify(ordered));
  assert.deepEqual(reversed.selectedSourceIndices, [0, 1]);
  assert.equal(reversed.unselectedSourceCount, 0);
  assert.equal(reversed.canonicalScopeJson, canonicalScopeJson);
  assert.deepEqual(reversed.sources.map((source) => source.commitSha), [HEAD, BASE]);
  assert.equal(reversed.sourcePreviewDigest, ordered.sourcePreviewDigest);
  assert.equal(reversed.prompt, ordered.prompt);
  for (const source of reversed.sources) {
    assert.match(source.refObjectSha, /^[a-f0-9]{40}$/);
    assert.match(source.refCommitSha, /^[a-f0-9]{40}$/);
    assert.match(source.blobSha, /^[a-f0-9]{40}$/);
    assert.match(source.fileSha256, /^[a-f0-9]{64}$/);
  }
});

test("local collector fails closed on wrong identity, changed ref or changed PR", async () => {
  for (const [source, options] of [
    [REPO_SOURCE, { wrongRepository: true }],
    [REPO_SOURCE, { movedRef: true }],
    [PR_SOURCE, { movedPr: true }],
  ]) {
    const result = await collectAmuxLocalGitHubPreview(input(source, github(options)));
    assert.notEqual(result.status, "preview_candidate");
  }
});

test("oversized selections and noncanonical scope refuse before network collection", async () => {
  const fake = github();
  const oversized = await collectAmuxLocalGitHubPreview(input(REPO_SOURCE, fake,
    { selections: [{ sourceIndex: 0, startByte: 0, endByte: 9000 }] }));
  assert.deepEqual(oversized, { status: "reject", reason: "chunk_input_too_large" });
  const noncanonical = await collectAmuxLocalGitHubPreview(input(REPO_SOURCE, fake,
    { canonicalScopeJson: JSON.stringify({ sources: [REPO_SOURCE], version: 1 }) }));
  assert.deepEqual(noncanonical, { status: "hold", reason: "scope_unverified" });
  assert.equal(fake.calls.length, 0);
});

test("collector withholds sensitive excerpts rather than producing a prompt", async () => {
  const sensitive = "Contact operator@example.com before review\n";
  const result = await collectAmuxLocalGitHubPreview(input(REPO_SOURCE,
    github({ text: sensitive }),
    { selections: [{ sourceIndex: 0, startByte: 0,
      endByte: Buffer.byteLength(sensitive, "utf8") }] }));
  assert.notEqual(result.status, "preview_candidate");
  assert(!JSON.stringify(result).includes(sensitive));
});
