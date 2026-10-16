import assert from "node:assert/strict";
import test from "node:test";

import {
  AmuxTrackedCheckoutManifestError,
  planAmuxTrackedCheckout,
} from "../lib/amux/ideaTrackedCheckoutManifestCore.ts";

const oid = "a".repeat(40);
const file = (path, mode = "100644", type = "blob") => ({ path, mode, type, objectId: oid });

test("a pinned tree exposes only ordinary tracked files and excludes secret paths and links", () => {
  const result = planAmuxTrackedCheckout([
    file("src/server.ts"),
    file("docs/guide.md"),
    file(".env.example"),
    file("config/private.pem"),
    file("assets/link", "120000"),
    file("vendor/module", "160000", "commit"),
  ]);
  assert.deepEqual(result.files.map((entry) => entry.path), ["docs/guide.md", "src/server.ts"]);
  assert.deepEqual(result.excluded, [
    { path: ".env.example", reason: "secret_path" },
    { path: "assets/link", reason: "non_regular" },
    { path: "config/private.pem", reason: "secret_path" },
    { path: "vendor/module", reason: "non_regular" },
  ]);
});

test("malformed paths, modes and file-directory collisions fail the entire tree", () => {
  for (const entries of [
    [file("../outside")],
    [file("safe/../../outside")],
    [file("safe\\outside")],
    [file(".git/config")],
    [file("a"), file("a/b")],
    [file("a"), file("a-"), file("a/b")],
    [file("same"), file("same")],
    [file("special", "100664")],
    [{ ...file("bad-object"), objectId: "not-a-git-object" }],
  ]) {
    assert.throws(() => planAmuxTrackedCheckout(entries), AmuxTrackedCheckoutManifestError);
  }
});

test("the manifest has no arbitrary file-count ceiling", () => {
  const result = planAmuxTrackedCheckout(Array.from({ length: 501 }, (_, i) => file(`docs/${i}.md`)));
  assert.equal(result.files.length, 501);
  assert.equal(result.excluded.length, 0);
});
