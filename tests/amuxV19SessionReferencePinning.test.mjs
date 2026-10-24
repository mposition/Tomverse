import assert from "node:assert/strict";
import test from "node:test";
import { pinAmuxSessionReferences,
  AmuxSessionReferencePinningError } from
  "../lib/amux/ideaSessionReferencePinning.ts";

const token = "synthetic_read_only_github_token_0123456789";
const sha = (character) => character.repeat(40);
const input = { version: 1, idea: "Pinned test", repositories: ["mposition/Tomverse"],
  pullRequests: [{ repository: "mposition/Tomverse", number: 42 }] };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { "content-type": "application/json" } });
// A repository without develop answers its branch read with 404.
const noDevelop = (url) => url.endsWith("/branches/develop")
  ? json({ message: "Branch not found" }, 404) : null;

test("session intake captures repository default branch and same-repo PR head in submitted order", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    const missing = noDevelop(url);
    if (missing) return missing;
    if (url.endsWith("/repos/mposition/Tomverse"))
      return json({ full_name: "mposition/Tomverse", default_branch: "release/test" });
    if (url.endsWith("/commits/release%2Ftest")) return json({ sha: sha("a") });
    if (url.endsWith("/pulls/42")) return json({ head: {
      sha: sha("b"), repo: { full_name: "mposition/Tomverse" } } });
    throw new Error("unexpected URL");
  };
  assert.deepEqual(await pinAmuxSessionReferences(input, token, fetchImpl),
    [sha("a"), sha("b")]);
  assert.equal(seen.length, 4);
  assert.ok(seen.every(({ url, options }) =>
    url.startsWith("https://api.github.com/") &&
    options.method === "GET" && options.redirect === "manual" &&
    options.headers.authorization === `Bearer ${token}`));
});

test("missing credential, fork heads and incomplete snapshots fail before intake", async () => {
  await assert.rejects(pinAmuxSessionReferences(input, undefined, async () => {
    throw new Error("must not fetch");
  }), AmuxSessionReferencePinningError);
  await assert.rejects(pinAmuxSessionReferences(input, token, async (url) =>
    noDevelop(url) ?? (url.endsWith("/repos/mposition/Tomverse")
      ? json({ full_name: "mposition/Tomverse", default_branch: "main" })
      : url.endsWith("/commits/main")
        ? json({ sha: sha("a") })
        : json({ head: { sha: sha("b"), repo: { full_name: "another/fork" } } }))),
  AmuxSessionReferencePinningError);
  await assert.rejects(pinAmuxSessionReferences(input, token, async () =>
    new Response("not-json", { status: 200 })),
  AmuxSessionReferencePinningError);
  await assert.rejects(pinAmuxSessionReferences(input, token, async () =>
    json({ full_name: "mposition/replaced", default_branch: "main" })),
  AmuxSessionReferencePinningError);
  assert.deepEqual(await pinAmuxSessionReferences({ ...input,
    repositories: [], pullRequests: [] }, undefined), []);
});

test("a large default-branch commit (its diff in the response) still pins", async () => {
  const files = Array.from({ length: 75 }, (_, i) => ({ filename: `f${i}`, patch: "x".repeat(6_000) }));
  const fetchImpl = async (url) => noDevelop(url) ?? (url.endsWith("/repos/mposition/Tomverse")
    ? json({ full_name: "mposition/Tomverse", default_branch: "main" })
    : json({ sha: sha("c"), files }));
  assert.deepEqual(await pinAmuxSessionReferences({ ...input, pullRequests: [] }, token, fetchImpl),
    [sha("c")]);
});

test("a repository with develop is pinned at its develop head, not the default branch", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.endsWith("/repos/mposition/Tomverse"))
      return json({ full_name: "mposition/Tomverse", default_branch: "main" });
    if (url.endsWith("/repos/mposition/Tomverse/branches/develop"))
      return json({ name: "develop", commit: { sha: sha("d") } });
    throw new Error("unexpected URL " + url);
  };
  assert.deepEqual(await pinAmuxSessionReferences({ ...input, pullRequests: [] },
    token, fetchImpl), [sha("d")]);
  assert.ok(!seen.some((url) => url.includes("/commits/")),
    "the default branch is not read when develop exists");
});

test("a malformed or failed develop read refuses instead of falling back", async () => {
  const withBranch = (branch) => async (url) =>
    url.endsWith("/repos/mposition/Tomverse")
      ? json({ full_name: "mposition/Tomverse", default_branch: "main" })
      : url.endsWith("/branches/develop") ? branch()
        : json({ sha: sha("a") });
  const only = { ...input, pullRequests: [] };
  for (const branch of [
    () => json({ name: "main", commit: { sha: sha("d") } }),
    () => json({ name: "develop", commit: { sha: "not-a-sha" } }),
    () => json({ name: "develop" }),
    () => json({ message: "Server Error" }, 500),
    () => new Response("not-json", { status: 404 }),
  ]) {
    await assert.rejects(pinAmuxSessionReferences(only, token, withBranch(branch)),
      AmuxSessionReferencePinningError);
  }
});
