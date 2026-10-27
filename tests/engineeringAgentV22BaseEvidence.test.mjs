import assert from "node:assert/strict";
import { basename } from "node:path";
import test from "node:test";

import { loadEngineeringAgentV22BaseEvidence } from
  "../lib/engineeringAgentV22BaseEvidence.ts";
import { gitObjectId } from "../lib/engineeringAgentTreeVerify.ts";

const source = new Map([
  ["tsconfig.json", '{"compilerOptions":{"module":"esnext"}}'],
  ["package-lock.json", '{"packages":{"node_modules/next":{"version":"16.3.8"}}}'],
  ["x.yml", "name: CI\non: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps: []\n"],
  ["sample.json", '{"value":1}\n'],
  ["security-regression-check.mjs",
    'read("tests/e2e/support/canonical-visual.ts");\n'],
  [".dockerignore", "# test sources\ntests/\nplaywright.admin.config.ts\n"],
]);
const tree = [
  [".dockerignore", ".dockerignore"],
  ["tsconfig.json", "tsconfig.json"],
  ["package-lock.json", "package-lock.json"],
  [".github/workflows/x.yml", "x.yml"],
  ["tests/fixtures/sample.json", "sample.json"],
  ["scripts/security-regression-check.mjs", "security-regression-check.mjs"],
].map(([path, key]) => ({ path, mode: "100644", type: "blob",
  oid: gitObjectId("blob", Buffer.from(source.get(key))),
}));
const ports = {
  tree, root: process.cwd(),
  stat: async () => ({ isFile: () => true }),
  read: async (path) => {
    const key = basename(path);
    if (key === "sample.json") throw new Error("not_in_image");
    return Buffer.from(source.get(key));
  },
};

test("base evidence admits exact image bytes and known missing tests", async () => {
  const result = await loadEngineeringAgentV22BaseEvidence({
    ...ports, excludedPrefixes: ["tests"],
  });
  assert.ok(result);
  assert.equal(result.workflows.length, 1);
  assert.equal(result.workflows[0].blobSha, tree.find((entry) =>
    entry.path === ".github/workflows/x.yml").oid);
  assert.equal(result.baseFiles.find((file) =>
    file.path === "tests/fixtures/sample.json").text, "");
  assert.equal(result.installedVersions.next, "16.3.8");
  assert.ok(result.policyDocuments.some((text) =>
    text.includes("tests/e2e/support/canonical-visual.ts")));
});

test("missing source or mismatched bytes fail closed", async () => {
  assert.equal(await loadEngineeringAgentV22BaseEvidence({
    ...ports, excludedPrefixes: [],
  }), null);
  assert.equal(await loadEngineeringAgentV22BaseEvidence({
    ...ports, excludedPrefixes: ["tests"],
    read: async (path) => basename(path) === "x.yml" ?
      Buffer.from("altered") : ports.read(path),
  }), null);
});

test("vendored AMUX control-plane assets do not exhaust source-reading limits", async () => {
  const vendorPath = "vendor/amux/crates/amux-dashboard/static/app.js";
  const result = await loadEngineeringAgentV22BaseEvidence({
    ...ports,
    tree: [...tree, { path: vendorPath, mode: "100644", type: "blob",
      oid: "a".repeat(40) }],
    excludedPrefixes: ["tests"],
    read: async (path) => {
      if (path.endsWith("app.js")) throw new Error("vendor_not_read");
      return ports.read(path);
    },
  });
  assert.ok(result);
  assert.deepEqual(result.baseFiles.find((file) =>
    file.path === vendorPath), { path: vendorPath, text: "" });
});

const blobs = new Map([...source.values()].map((text) =>
  [gitObjectId("blob", Buffer.from(text)), Buffer.from(text)]));
const fetchBlob = async (oid) => {
  const bytes = blobs.get(oid);
  if (!bytes) throw new Error("absent");
  return bytes;
};

test("a file the running image has at another revision is read from the base blob", async () => {
  const fetched = [];
  const result = await loadEngineeringAgentV22BaseEvidence({
    ...ports, excludedPrefixes: ["tests"],
    read: async (path) => basename(path) === "x.yml" ?
      Buffer.from("main revision") : ports.read(path),
    fetchBlob: async (oid, maxBytes) => {
      fetched.push(oid);
      assert.equal(maxBytes, 2 * 1024 * 1024);
      return fetchBlob(oid);
    },
  });
  assert.ok(result);
  const workflow = tree.find((entry) => entry.path === ".github/workflows/x.yml");
  assert.deepEqual(fetched, [workflow.oid]);
  assert.equal(result.workflows[0].text, source.get("x.yml"));
});

test("a fetched blob must match its OID, and fetching is bounded", async () => {
  assert.equal(await loadEngineeringAgentV22BaseEvidence({
    ...ports, excludedPrefixes: ["tests"],
    read: async () => { throw new Error("empty image"); },
    fetchBlob: async () => Buffer.from("forged"),
  }), null);
  const many = Array.from({ length: 501 }, (_, index) => {
    const text = `export const value${index} = ${index};\n`;
    const oid = gitObjectId("blob", Buffer.from(text));
    blobs.set(oid, Buffer.from(text));
    return { path: `lib/generated/v${index}.ts`, mode: "100644",
      type: "blob", oid };
  });
  let calls = 0;
  assert.equal(await loadEngineeringAgentV22BaseEvidence({
    ...ports, tree: [...tree, ...many], excludedPrefixes: ["tests"],
    read: async (path) => path.includes("generated") ?
      Promise.reject(new Error("absent")) : ports.read(path),
    fetchBlob: async (oid) => { calls += 1; return fetchBlob(oid); },
  }), null);
  assert.equal(calls, 500);
});

test("excluded tests need the base commit's own .dockerignore to exclude them", async () => {
  const withIgnore = (text) => {
    const oid = gitObjectId("blob", Buffer.from(text));
    return { ...ports,
      tree: tree.map((entry) => entry.path === ".dockerignore" ?
        { ...entry, oid } : entry),
      read: async (path) => basename(path) === ".dockerignore" ?
        Buffer.from(text) : ports.read(path),
      excludedPrefixes: ["tests"] };
  };
  assert.equal(await loadEngineeringAgentV22BaseEvidence(
    withIgnore("node_modules/\n")), null);
  assert.equal(await loadEngineeringAgentV22BaseEvidence(
    withIgnore("tests/\n")), null);
  assert.ok(await loadEngineeringAgentV22BaseEvidence(
    withIgnore("/tests/\n/playwright.admin.config.ts\n")));
  assert.equal(await loadEngineeringAgentV22BaseEvidence({ ...ports,
    tree: tree.filter((entry) => entry.path !== ".dockerignore"),
    excludedPrefixes: ["tests"] }), null);
});
