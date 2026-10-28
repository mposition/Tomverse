import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import test from "node:test";

import { engineeringAgentV22DeployExclusion,
  loadEngineeringAgentV22BaseEvidence } from
  "../lib/engineeringAgentV22BaseEvidence.ts";
import { gitObjectId } from "../lib/engineeringAgentTreeVerify.ts";

const source = new Map([
  ["tsconfig.json", '{"compilerOptions":{"module":"esnext"}}'],
  ["package-lock.json", '{"packages":{"node_modules/next":{"version":"16.3.8"}}}'],
  ["x.yml", "name: CI\non: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps: []\n"],
  ["sample.json", '{"value":1}\n'],
  ["kept.test.mjs", "export const kept = true;\n"],
  ["security-regression-check.mjs",
    'read("tests/e2e/support/canonical-visual.ts");\n'],
  [".dockerignore",
    "# test sources\ntests/*\n!tests/kept.test.mjs\nplaywright.admin.config.ts\n"],
]);
const tree = [
  [".dockerignore", ".dockerignore"],
  ["tsconfig.json", "tsconfig.json"],
  ["package-lock.json", "package-lock.json"],
  [".github/workflows/x.yml", "x.yml"],
  ["tests/fixtures/sample.json", "sample.json"],
  ["tests/kept.test.mjs", "kept.test.mjs"],
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
const blobs = new Map([...source.values()].map((text) =>
  [gitObjectId("blob", Buffer.from(text)), Buffer.from(text)]));
const fetchBlob = async (oid) => {
  const bytes = blobs.get(oid);
  if (!bytes) throw new Error("absent");
  return bytes;
};

test("the base .dockerignore is applied in order, re-includes winning", () => {
  const paths = ["tests/a.test.mjs", "tests/e2e/b.spec.ts",
    "tests/kept.test.mjs", "playwright.admin.config.ts", "lib/x.ts"];
  assert.deepEqual(engineeringAgentV22DeployExclusion(
    source.get(".dockerignore"), paths),
  ["tests/a.test.mjs", "tests/e2e/b.spec.ts", "playwright.admin.config.ts"]);
  // A later rule re-excludes; an earlier re-include does not survive it.
  assert.deepEqual(engineeringAgentV22DeployExclusion(
    "!tests/kept.test.mjs\ntests/\n", paths),
  ["tests/a.test.mjs", "tests/e2e/b.spec.ts", "tests/kept.test.mjs"]);
  // Re-including a directory re-includes everything below it.
  assert.deepEqual(engineeringAgentV22DeployExclusion(
    "tests/*\n!tests/e2e\n", paths),
  ["tests/a.test.mjs", "tests/kept.test.mjs"]);
  // Only test sources and the admin config may leave the slice.
  assert.deepEqual(engineeringAgentV22DeployExclusion("lib/\ndocs\n", paths), []);
  assert.equal(engineeringAgentV22DeployExclusion(null, paths), null);
});

test("a rule the reader does not fully understand fails closed", () => {
  const paths = ["tests/a.test.mjs", "tests/kept.test.mjs"];
  for (const rule of ["**/*.log", "tests/*.mjs", "!tests/k?pt.test.mjs",
    "tests/[ab].mjs", "tests/../lib", "tests\\a.test.mjs",
    "! tests/kept.test.mjs", "!\ttests/kept.test.mjs", "tests/a b.mjs"])
    assert.equal(engineeringAgentV22DeployExclusion(
      `tests/*\n${rule}\n`, paths), null, rule);
});

test("the repository's own .dockerignore keeps the runtime-read tests in the image", () => {
  const text = readFileSync(".dockerignore", "utf8");
  const reincluded = text.split(/\r?\n/).filter((line) => line.startsWith("!"))
    .map((line) => line.slice(1));
  const excluded = engineeringAgentV22DeployExclusion(text,
    ["tests/unit.test.mjs", "playwright.admin.config.ts", ...reincluded]);
  assert.deepEqual(excluded, ["tests/unit.test.mjs",
    "playwright.admin.config.ts"]);
});

test("base evidence admits exact image bytes and the base build's exclusions", async () => {
  const result = await loadEngineeringAgentV22BaseEvidence(ports);
  assert.ok(result);
  assert.equal(result.workflows.length, 1);
  assert.equal(result.workflows[0].blobSha, tree.find((entry) =>
    entry.path === ".github/workflows/x.yml").oid);
  assert.equal(result.baseFiles.find((file) =>
    file.path === "tests/fixtures/sample.json").text, "");
  assert.equal(result.baseFiles.find((file) =>
    file.path === "tests/kept.test.mjs").text, source.get("kept.test.mjs"));
  // A test a change adds is excluded by the same base rules; a re-included
  // one is not.
  assert.deepEqual(result.deployExcluded(["tests/fixtures/sample.json",
    "tests/new-feature.test.mjs", "tests/kept.test.mjs", "lib/new.ts"]),
  ["tests/fixtures/sample.json", "tests/new-feature.test.mjs"]);
  assert.match(result.exclusionDigest, /^[0-9a-f]{64}$/);
  assert.equal(result.installedVersions.next, "16.3.8");
  assert.ok(result.policyDocuments.some((text) =>
    text.includes("tests/e2e/support/canonical-visual.ts")));
});

const withIgnore = (text) => {
  const oid = gitObjectId("blob", Buffer.from(text));
  return { ...ports, fetchBlob,
    tree: tree.map((entry) => entry.path === ".dockerignore" ?
      { ...entry, oid } : entry),
    read: async (path) => basename(path) === ".dockerignore" ?
      Buffer.from(text) : ports.read(path) };
};

test("a missing or unreadable base .dockerignore fails closed", async () => {
  assert.equal(await loadEngineeringAgentV22BaseEvidence({ ...ports,
    tree: tree.filter((entry) => entry.path !== ".dockerignore") }), null);
  assert.equal(await loadEngineeringAgentV22BaseEvidence(
    withIgnore("tests/**/*.mjs\n")), null);
});

test("the exclusion digest names the base .dockerignore", async () => {
  const first = (await loadEngineeringAgentV22BaseEvidence(ports)).exclusionDigest;
  const second = (await loadEngineeringAgentV22BaseEvidence(
    withIgnore("tests/*\nplaywright.admin.config.ts\n"))).exclusionDigest;
  assert.match(second, /^[0-9a-f]{64}$/);
  assert.notEqual(second, first);
});

test("missing source or mismatched bytes fail closed without a blob reader", async () => {
  assert.equal(await loadEngineeringAgentV22BaseEvidence({
    ...ports,
    read: async (path) => basename(path) === "x.yml" ?
      Buffer.from("altered") : ports.read(path),
  }), null);
});

test("a file the running image has at another revision is read from the base blob", async () => {
  const fetched = [];
  const result = await loadEngineeringAgentV22BaseEvidence({
    ...ports,
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
    ...ports,
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
    ...ports, tree: [...tree, ...many],
    read: async (path) => path.includes("generated") ?
      Promise.reject(new Error("absent")) : ports.read(path),
    fetchBlob: async (oid) => { calls += 1; return fetchBlob(oid); },
  }), null);
  assert.equal(calls, 500);
});

test("vendored AMUX control-plane assets do not exhaust source-reading limits", async () => {
  const vendorPath = "vendor/amux/crates/amux-dashboard/static/app.js";
  const result = await loadEngineeringAgentV22BaseEvidence({
    ...ports,
    tree: [...tree, { path: vendorPath, mode: "100644", type: "blob",
      oid: "a".repeat(40) }],
    read: async (path) => {
      if (path.endsWith("app.js")) throw new Error("vendor_not_read");
      return ports.read(path);
    },
  });
  assert.ok(result);
  assert.deepEqual(result.baseFiles.find((file) =>
    file.path === vendorPath), { path: vendorPath, text: "" });
});

test("base blobs are fetched in parallel and kept in tree order", async () => {
  const many = Array.from({ length: 40 }, (_, index) => {
    const text = `export const parallel${index} = ${index};\n`;
    const oid = gitObjectId("blob", Buffer.from(text));
    blobs.set(oid, Buffer.from(text));
    return { path: `lib/parallel/p${index}.ts`, mode: "100644",
      type: "blob", oid };
  });
  let inFlight = 0;
  let peak = 0;
  const result = await loadEngineeringAgentV22BaseEvidence({
    ...ports, tree: [...tree, ...many],
    read: async (path) => path.includes("parallel") ?
      Promise.reject(new Error("not_in_image")) : ports.read(path),
    fetchBlob: async (oid) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Later entries answer first, so a result kept by arrival would reorder.
      await new Promise((resolve) => setTimeout(resolve, 40 - many.findIndex(
        (entry) => entry.oid === oid)));
      inFlight -= 1;
      return fetchBlob(oid);
    },
  });
  assert.ok(result);
  assert.ok(peak > 1 && peak <= 16, `peak ${peak}`);
  assert.deepEqual(result.baseFiles.slice(-40).map((file) => file.text),
    many.map((_, index) => `export const parallel${index} = ${index};\n`));
});

test("an abort or the first missing text starts no further reads", async () => {
  const many = Array.from({ length: 100 }, (_, index) => {
    const text = `export const stop${index} = ${index};\n`;
    const oid = gitObjectId("blob", Buffer.from(text));
    blobs.set(oid, Buffer.from(text));
    return { path: `lib/stop/s${index}.ts`, mode: "100644", type: "blob", oid };
  });
  const run = async (fetch, signal) => {
    let calls = 0;
    const result = await loadEngineeringAgentV22BaseEvidence({
      ...ports, tree: [...tree, ...many], signal,
      read: async (path) => path.includes("/stop/") ?
        Promise.reject(new Error("not_in_image")) : ports.read(path),
      fetchBlob: async (oid) => { calls += 1; return fetch(oid); },
    });
    return { result, calls };
  };
  const aborted = new AbortController();
  aborted.abort();
  const gone = await run(fetchBlob, aborted.signal);
  assert.equal(gone.result, null);
  assert.equal(gone.calls, 0);
  const missing = await run(async () => { throw new Error("absent"); });
  assert.equal(missing.result, null);
  assert.ok(missing.calls <= 16, `calls ${missing.calls}`);
});
