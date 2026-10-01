import assert from "node:assert/strict";
import test from "node:test";

import {
  collectAmuxGitHubOwnedRefWitness,
  createAmuxIdeaGitHubRefReader,
} from "../lib/amux/ideaGitHubRefReadAdapter.ts";
import { searchAmuxOwnedRefWitness } from "../lib/amux/ideaOwnedRefSearchCore.ts";

const target = "a".repeat(40);
const head = "b".repeat(40);
const tagSha = "c".repeat(40);
const repoId = 25;
const limits = { maxPages: 3, maxRefs: 3, maxComparisons: 3, maxTagDepth: 2 };
const repo = { id: repoId, full_name: "mposition/Tomverse" };
const node = (name, oid = head) => ({
  name, prefix: "refs/heads/", target: { __typename: "Commit", oid },
});
const gqlRepo = (field) => ({ data: { repository: { databaseId: repoId, ...field } } });
const gqlPage = (nodes, hasNextPage = false, endCursor = "cursor-one") => gqlRepo({
  refs: { nodes, pageInfo: { hasNextPage, endCursor } },
});
const gqlRef = (ref) => gqlRepo({ ref });
const compare = (baseSha = target, mergeBaseSha = target) => ({
  status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1,
  base_commit: { sha: baseSha }, merge_base_commit: { sha: mergeBaseSha },
  commits: [{ sha: head }],
});

const makeFetch = (overrides = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname;
    calls.push({ path, init });
    if (path === "/graphql") {
      const body = JSON.parse(init.body);
      if (body.query.includes("query AmuxIdeaRefs")) {
        return Response.json(body.variables.prefix === "refs/tags/"
          ? (typeof overrides.tagRefs === "function"
            ? overrides.tagRefs(body.variables) : overrides.tagRefs ?? gqlPage([]))
          : (typeof overrides.refs === "function"
            ? overrides.refs(body.variables) : overrides.refs ?? gqlPage([node("main")])));
      }
      if (body.query.includes("query AmuxIdeaRef")) {
        return Response.json(overrides.ref ?? gqlRef(node("main")));
      }
    }
    if (path === "/repos/mposition/Tomverse") return Response.json(overrides.repo ?? repo);
    if (path.startsWith("/repos/mposition/Tomverse/git/tags/")) {
      return Response.json(typeof overrides.tag === "function"
        ? overrides.tag(path) : overrides.tag ?? {
          sha: tagSha, object: { type: "commit", sha: head },
        });
    }
    if (path === `/repos/mposition/Tomverse/git/commits/${head}` ||
        path === `/repos/mposition/Tomverse/git/commits/${target}`) {
      return Response.json(overrides.head ?? { sha: path.endsWith(head) ? head : target });
    }
    if (path.startsWith("/repos/mposition/Tomverse/compare/")) {
      return Response.json(typeof overrides.compare === "function"
        ? overrides.compare(parsedUrl) : overrides.compare ?? compare());
    }
    throw new Error("unexpected request");
  };
  return { fetchImpl, calls };
};
const reader = (fetchImpl, overrides = {}) => createAmuxIdeaGitHubRefReader({
  owner: "mposition", repo: "Tomverse", expectedRepositoryId: repoId,
  token: "read-only-test-token", fetchImpl, ...overrides,
});

test("adapter reads only fixed GitHub endpoints and yields a verified witness", async () => {
  const { fetchImpl, calls } = makeFetch();
  const source = reader(fetchImpl);
  assert.deepEqual(await source.readRepositoryIdentity(), { id: repoId, fullName: repo.full_name });
  const result = await searchAmuxOwnedRefWitness(repoId, target, limits, source.adapter);
  assert.equal(result.status, "verified_witness");
  assert.equal(result.witness.name, "refs/heads/main");
  assert.equal(result.witness.protected, null);
  assert.deepEqual(await source.readRepositoryIdentity(), { id: repoId, fullName: repo.full_name });
  assert.deepEqual(calls.map(({ path }) => path), [
    "/repos/mposition/Tomverse", "/graphql",
    `/repos/mposition/Tomverse/git/commits/${head}`,
    `/repos/mposition/Tomverse/compare/${target}...${head}`,
    "/graphql", "/repos/mposition/Tomverse",
  ]);
  for (const { init } of calls) {
    assert.equal(init.method === "GET" || init.method === "POST", true);
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    assert.equal(init.headers.Authorization, "Bearer read-only-test-token");
  }
});

test("comparison uses GitHub resolved commit SHAs, not request argument echoes", async () => {
  const { fetchImpl } = makeFetch({ compare: compare("c".repeat(40)) });
  const result = await searchAmuxOwnedRefWitness(repoId, target, limits, reader(fetchImpl).adapter);
  assert.deepEqual(result, { status: "hold", reason: "comparison_unverified", inspectedRefs: 1 });
  const differentMergeBase = makeFetch({ compare: compare(target, "c".repeat(40)) });
  const result2 = await searchAmuxOwnedRefWitness(repoId, target, limits,
    reader(differentMergeBase.fetchImpl).adapter);
  assert.deepEqual(result2, { status: "hold", reason: "no_verified_witness", inspectedRefs: 1 });
});

test("repository replacement, partial GraphQL and a moved ref hold", async () => {
  const replaced = makeFetch({ repo: { id: 26, full_name: "mposition/Tomverse" } });
  await assert.rejects(reader(replaced.fetchImpl).readRepositoryIdentity(),
    (error) => error.code === "wrong_repository");
  const partial = makeFetch({ refs: { ...gqlPage([node("main")]), errors: [{ message: "partial" }] } });
  const result = await searchAmuxOwnedRefWitness(repoId, target, limits,
    reader(partial.fetchImpl).adapter);
  assert.deepEqual(result, { status: "hold", reason: "collector_unavailable", inspectedRefs: 0 });
  const moved = makeFetch({ ref: gqlRef(node("main", "c".repeat(40))) });
  const result2 = await searchAmuxOwnedRefWitness(repoId, target, limits,
    reader(moved.fetchImpl).adapter);
  assert.deepEqual(result2, { status: "hold", reason: "ref_changed", inspectedRefs: 1 });
});

test("configuration and bounded JSON refuse malformed collector inputs", async () => {
  assert.throws(() => reader(makeFetch().fetchImpl, { token: "bad\nheader" }),
    (error) => error.code === "invalid_collector_config");
  const oversized = async (url) => {
    if (new URL(url).pathname === "/graphql") {
      return new Response("x".repeat(256 * 1024 + 1),
        { headers: { "Content-Type": "application/json" } });
    }
    throw new Error("unexpected request");
  };
  const result = await searchAmuxOwnedRefWitness(repoId, target, limits, reader(oversized).adapter);
  assert.deepEqual(result, { status: "hold", reason: "collector_unavailable", inspectedRefs: 0 });
});

test("mandatory wrapper rechecks numeric repository identity after the witness", async () => {
  const base = makeFetch();
  const config = {
    owner: "mposition", repo: "Tomverse", expectedRepositoryId: repoId,
    token: "read-only-test-token", fetchImpl: base.fetchImpl,
  };
  const valid = await collectAmuxGitHubOwnedRefWitness(config, target, limits);
  assert.equal(valid.status, "verified_witness");
  assert.equal(base.calls.filter(({ path }) => path === "/repos/mposition/Tomverse").length, 2);

  let identityReads = 0;
  const changingFetch = async (url, init) => {
    if (new URL(url).pathname === "/repos/mposition/Tomverse" && ++identityReads === 2) {
      return Response.json({ id: 26, full_name: "mposition/Tomverse" });
    }
    return base.fetchImpl(url, init);
  };
  const changed = await collectAmuxGitHubOwnedRefWitness(
    { ...config, fetchImpl: changingFetch }, target, limits,
  );
  assert.deepEqual(changed, {
    status: "hold", reason: "wrong_repository", inspectedRefs: 1,
  });
});

test("comparison binds the final page commit to the requested head", async () => {
  const aheadThree = (url, finalSha = head) => ({
    ...compare(), ahead_by: 3, total_commits: 3,
    commits: [{ sha: url.searchParams.get("page") === "3" ? finalSha : "d".repeat(40) }],
  });
  const valid = makeFetch({ compare: (url) => aheadThree(url) });
  const accepted = await searchAmuxOwnedRefWitness(repoId, target, limits,
    reader(valid.fetchImpl).adapter);
  assert.equal(accepted.status, "verified_witness");
  assert.equal(valid.calls.filter(({ path }) => path.includes("/compare/")).length, 2);
  const spoofed = makeFetch({ compare: (url) => aheadThree(url, "e".repeat(40)) });
  const refused = await searchAmuxOwnedRefWitness(repoId, target, limits,
    reader(spoofed.fetchImpl).adapter);
  assert.deepEqual(refused, { status: "hold", reason: "collector_unavailable", inspectedRefs: 1 });
  const wrongHead = makeFetch({ head: { sha: "f".repeat(40) } });
  const refusedHead = await searchAmuxOwnedRefWitness(repoId, target, limits,
    reader(wrongHead.fetchImpl).adapter);
  assert.deepEqual(refusedHead, { status: "hold", reason: "collector_unavailable", inspectedRefs: 1 });
  const identical = makeFetch({
    compare: {
      status: "identical", ahead_by: 0, behind_by: 0, total_commits: 0,
      base_commit: { sha: head }, merge_base_commit: { sha: head }, commits: [],
    },
  });
  const same = await searchAmuxOwnedRefWitness(repoId, head, limits,
    reader(identical.fetchImpl).adapter);
  assert.equal(same.status, "verified_witness");
});

test("adapter forwards cursors, rejects incomplete pages, and peels annotated tags", async () => {
  const paged = makeFetch({
    refs: ({ after }) => after === null
      ? gqlPage([node("old", "d".repeat(40))], true, "next")
      : gqlPage([node("main")], false, "last"),
  });
  const source = reader(paged.fetchImpl);
  const first = await source.adapter.listRefs("refs/heads/", null);
  const second = await source.adapter.listRefs("refs/heads/", first.endCursor);
  assert.equal(first.hasNextPage, true);
  assert.equal(second.refs[0].name, "refs/heads/main");
  const after = paged.calls.filter(({ path }) => path === "/graphql")
    .map(({ init }) => JSON.parse(init.body).variables.after);
  assert.deepEqual(after, [null, "next"]);
  const incomplete = makeFetch({ refs: gqlPage([], true, null) });
  await assert.rejects(reader(incomplete.fetchImpl).adapter.listRefs("refs/heads/", null),
    (error) => error.code === "invalid_response");

  const tagNode = {
    name: "release", prefix: "refs/tags/",
    target: { __typename: "Tag", oid: tagSha },
  };
  const tagged = makeFetch({ refs: gqlPage([]), tagRefs: gqlPage([tagNode]), ref: gqlRef(tagNode) });
  const result = await searchAmuxOwnedRefWitness(repoId, target, limits,
    reader(tagged.fetchImpl).adapter);
  assert.equal(result.status, "verified_witness");
  assert.equal(result.witness.name, "refs/tags/release");
  assert.equal(result.witness.refObjectSha, tagSha);
  const wrongTag = makeFetch({
    refs: gqlPage([]), tagRefs: gqlPage([tagNode]),
    tag: { sha: "f".repeat(40), object: { type: "commit", sha: head } },
  });
  const refused = await searchAmuxOwnedRefWitness(repoId, target, limits,
    reader(wrongTag.fetchImpl).adapter);
  assert.deepEqual(refused, { status: "hold", reason: "collector_unavailable", inspectedRefs: 1 });
});

test("bounded response checks valid JSON bytes, HTTP status, encoding and repository ID", async () => {
  const largeJson = JSON.stringify({ ...gqlPage([]), padding: "x".repeat(256 * 1024) });
  const bytes = new TextEncoder().encode(largeJson);
  const oversized = async () => {
    let offset = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + 16_384));
        offset += 16_384;
      },
    }), { headers: { "Content-Type": "application/json" } });
  };
  await assert.rejects(reader(oversized).adapter.listRefs("refs/heads/", null),
    (error) => error.code === "oversized_response");
  for (const [response, code] of [
    [Response.json({ error: "forbidden" }, { status: 403 }), "http_error"],
    [new Response("not-json", { headers: { "Content-Type": "text/plain" } }), "invalid_response"],
    [new Response(new Uint8Array([0xff]), { headers: { "Content-Type": "application/json" } }),
      "invalid_response"],
  ]) {
    const failing = async () => response.clone();
    await assert.rejects(reader(failing).adapter.listRefs("refs/heads/", null),
      (error) => error.code === code);
  }
  const wrongId = makeFetch({ refs: {
    data: { repository: { databaseId: 26, refs: gqlPage([]).data.repository.refs } },
  } });
  await assert.rejects(reader(wrongId.fetchImpl).adapter.listRefs("refs/heads/", null),
    (error) => error.code === "wrong_repository");
});

test("aborts, invalid ref names and mutable caller config cannot weaken the adapter", async () => {
  const controller = new AbortController();
  controller.abort();
  const abortingFetch = async (_url, init) => {
    if (init.signal.aborted) throw new Error("aborted");
    return Response.json(gqlPage([]));
  };
  await assert.rejects(reader(abortingFetch, { signal: controller.signal })
    .adapter.listRefs("refs/heads/", null), (error) => error.code === "transport_error");
  await assert.rejects(reader(makeFetch().fetchImpl).adapter.readRef("refs/pull/1/merge"),
    (error) => error.code === "invalid_response");

  const observed = makeFetch();
  const mutable = {
    owner: "mposition", repo: "Tomverse", expectedRepositoryId: repoId,
    token: "read-only-test-token", fetchImpl: observed.fetchImpl,
  };
  const frozen = createAmuxIdeaGitHubRefReader(mutable);
  mutable.owner = "attacker";
  mutable.repo = "other";
  mutable.expectedRepositoryId = 26;
  mutable.token = "changed-token";
  const listed = await frozen.adapter.listRefs("refs/heads/", null);
  assert.equal(listed.repositoryId, repoId);
  assert.equal(observed.calls[0].init.headers.Authorization, "Bearer read-only-test-token");
  assert.deepEqual(JSON.parse(observed.calls[0].init.body).variables,
    { owner: "mposition", name: "Tomverse", prefix: "refs/heads/", after: null });
});
