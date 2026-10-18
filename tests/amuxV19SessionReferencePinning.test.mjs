import assert from "node:assert/strict";
import test from "node:test";
import { pinAmuxSessionReferences,
  AmuxSessionReferencePinningError } from
  "../lib/amux/ideaSessionReferencePinning.ts";

const token = "synthetic_read_only_github_token_0123456789";
const sha = (character) => character.repeat(40);
const input = { version: 1, idea: "Pinned test", repositories: ["mposition/Tomverse"],
  pullRequests: [{ repository: "mposition/Tomverse", number: 42 }] };
const json = (body) => new Response(JSON.stringify(body), { status: 200,
  headers: { "content-type": "application/json" } });

test("session intake captures repository default branch and same-repo PR head in submitted order", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    if (url.endsWith("/repos/mposition/Tomverse"))
      return json({ full_name: "mposition/Tomverse", default_branch: "release/test" });
    if (url.endsWith("/commits/release%2Ftest")) return json({ sha: sha("a") });
    if (url.endsWith("/pulls/42")) return json({ head: {
      sha: sha("b"), repo: { full_name: "mposition/Tomverse" } } });
    throw new Error("unexpected URL");
  };
  assert.deepEqual(await pinAmuxSessionReferences(input, token, fetchImpl),
    [sha("a"), sha("b")]);
  assert.equal(seen.length, 3);
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
    url.endsWith("/repos/mposition/Tomverse")
      ? json({ full_name: "mposition/Tomverse", default_branch: "main" })
      : url.endsWith("/commits/main")
        ? json({ sha: sha("a") })
        : json({ head: { sha: sha("b"), repo: { full_name: "another/fork" } } })),
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
