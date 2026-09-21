import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("Railpack keeps the mixed Node and Rust workspace on the Node provider", async () => {
  const [railpack, packageJson, cargoWorkspace] = await Promise.all([
    readJson(new URL("../railpack.json", import.meta.url)),
    readJson(new URL("../package.json", import.meta.url)),
    readFile(new URL("../Cargo.toml", import.meta.url), "utf8"),
  ]);

  assert.equal(railpack.$schema, "https://schema.railpack.com");
  assert.equal(
    railpack.provider,
    "node",
    "The root Cargo workspace otherwise makes Railpack deploy the Rust orchestrator instead of Tomverse."
  );
  assert.match(cargoWorkspace, /^\[workspace\]$/m);
  assert.equal(typeof packageJson.scripts?.build, "string");
  assert.equal(typeof packageJson.scripts?.start, "string");
});
