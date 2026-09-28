import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import ts from "typescript";

import {
  codeFacts,
  computeControlPlaneSlice,
  createResolver,
  environmentNames,
  hasRuntimeLoader,
  importSpecifiers,
} from "../lib/agentControlPlaneSlice.ts";

const tsParse = (text) => ts.createSourceFile("a.ts", text, ts.ScriptTarget.Latest, false);

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    module: "esnext",
    moduleResolution: "bundler",
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    paths: { "@/*": ["./*"], "@tomverse/chat-core": ["./packages/chat-core/src/index.ts"] },
  },
});
const LOCK = JSON.stringify({ packages: { "": {}, "node_modules/react": {}, "node_modules/@ai-sdk/provider": {} } });

/**
 * A small tree. The gate under the AMUX directory is runtime control plane; it
 * imports a product helper, which imports another. A facade re-exports the
 * gate, a page uses the facade, and a leaf touches nothing.
 */
const tree = (overrides = {}) => {
  const files = {
    "tsconfig.json": TSCONFIG,
    "package.json": JSON.stringify({ name: "app", dependencies: { react: "19" } }),
    "package-lock.json": LOCK,
    "lib/amux/gate.ts": 'import { helper } from "@/lib/helper";\nexport const gate = () => process.env.AMUX_GATE_MODE === "on" && helper();\n',
    "lib/helper.ts": 'import { deep } from "./deep.js";\nexport const helper = () => deep();\n',
    "lib/deep.ts": "export const deep = () => true;\n",
    "lib/facade.ts": 'export { gate } from "./amux/gate";\n',
    "lib/page.ts": 'import { gate } from "@/lib/facade";\nexport const page = () => gate();\n',
    "lib/leaf.ts": 'import React from "react";\nexport const leaf = React;\n',
    "lib/settings.ts": 'const KEY = "feature.secretSwitch";\nexport const read = (db) => db.appSetting.findUnique({ where: { key: KEY } });\n',
    "lib/pkg/index.ts": "export const pkg = 1;\n",
    "packages/chat-core/src/index.ts": "export const core = 1;\n",
    "packages/chat-core/package.json": JSON.stringify({ name: "@tomverse/chat-core", exports: { ".": "./src/index.ts" } }),
    "packages/ui-tokens/src/tokens.css": ":root{}\n",
    "packages/ui-tokens/package.json": JSON.stringify({ name: "@tomverse/ui-tokens", exports: { "./tokens.css": "./src/tokens.css" } }),
    ...overrides,
  };
  return Object.entries(files)
    .filter(([, text]) => text !== null)
    .map(([path, text]) => ({ path, text }));
};

const change = (path, overrides = {}) => ({
  path,
  status: "modified",
  newText: "export const x = 1;\n",
  addedText: "export const x = 1;",
  ...overrides,
});

const slice = (changes, files = tree()) => computeControlPlaneSlice({ baseFiles: files, changes });

test("what the control plane runs, directly or through other product files, is in the slice", () => {
  const result = slice([change("lib/deep.ts"), change("lib/helper.ts"), change("lib/leaf.ts")]);
  assert.equal(result.status, "analysed", JSON.stringify(result.problems ?? []));
  assert.deepEqual([...result.slicePaths].sort(), ["lib/deep.ts", "lib/helper.ts"]);
});

test("callers are transitive: a page reaching the gate through a barrel is in the slice", () => {
  const result = slice([change("lib/page.ts"), change("lib/facade.ts")]);
  assert.deepEqual([...result.slicePaths].sort(), ["lib/facade.ts", "lib/page.ts"]);
});

test("a new barrel and a new caller added together are both in the slice", () => {
  const result = slice([
    change("lib/newBarrel.ts", { status: "added", newText: 'export * from "./amux/gate";\n' }),
    change("lib/newCaller.ts", { status: "added", newText: 'import { gate } from "./newBarrel";\nexport const c = gate;\n' }),
  ]);
  assert.deepEqual([...result.slicePaths].sort(), ["lib/newBarrel.ts", "lib/newCaller.ts"]);
});

test("both sides of a rename are checked", () => {
  const result = slice([
    change("lib/moved.ts", { previousPath: "lib/deep.ts", status: "renamed", newText: "export const deep = () => true;\n" }),
    change("lib/helper.ts", { newText: 'import { deep } from "./moved.js";\nexport const helper = () => deep();\n' }),
  ]);
  assert.equal(result.status, "analysed", JSON.stringify(result.problems ?? []));
  assert.ok(result.slicePaths.has("lib/deep.ts"));
  // A rename that leaves an importer pointing at the old path cannot be read, so it fails.
  assert.equal(slice([change("lib/moved.ts", { previousPath: "lib/deep.ts", status: "renamed" })]).status, "failed");
});

test("a file that registers into code the control plane runs joins the slice", () => {
  const files = tree({
    "lib/registry.ts": "export const handlers = [];\nexport const register = (h) => handlers.push(h);\n",
    "lib/amux/gate.ts": 'import { handlers } from "@/lib/registry";\nexport const gate = () => handlers.forEach((h) => h());\n',
  });
  const result = slice(
    [change("lib/feature.ts", { status: "added", newText: 'import { register } from "./registry";\nregister(() => 1);\n' })],
    files,
  );
  assert.equal(result.status, "analysed", JSON.stringify(result.problems ?? []));
  assert.deepEqual([...result.slicePaths], ["lib/feature.ts"]);
});

test("registration reaches through any number of hops, in either direction", () => {
  const files = tree({
    "lib/registry.ts": "export const handlers = [];\nexport const register = (h) => handlers.push(h);\n",
    "lib/amux/gate.ts": 'import { handlers } from "@/lib/registry";\nexport const gate = () => handlers.forEach((h) => h());\n',
    "lib/registrant.ts": 'import { register } from "./registry";\nimport { work } from "./worker";\nregister(work);\n',
    "lib/worker.ts": "export const work = () => 1;\n",
    "lib/intermediate.ts": 'import { register } from "./registry";\nexport const add = (h) => register(h);\n',
  });
  // The helper a registrant hands over: it imports nothing the control plane runs.
  assert.deepEqual([...slice([change("lib/worker.ts")], files).slicePaths], ["lib/worker.ts"]);
  // A feature that registers through an intermediate file.
  const feature = change("lib/feature.ts", {
    status: "added",
    newText: 'import { add } from "./intermediate";\nadd(() => 2);\n',
  });
  assert.deepEqual([...slice([feature], files).slicePaths], ["lib/feature.ts"]);
  // Code that shares no import path with the control plane stays out.
  assert.deepEqual([...slice([change("lib/leaf.ts")], files).slicePaths], []);
});

test("code that cannot be followed moves the changed file into the slice", () => {
  const cases = {
    "a computed loader": 'export const load = (n) => import(`@/lib/amux/${n}`);\n',
    "a computed member call": "export const run = (table, name) => table[name]();\n",
    "a literal member call": 'export const run = (table) => table["gate"]();\n',
    "a computed environment key": "export const read = (k) => process.env[k];\n",
    "a direct AppSetting access": "export const read = (db) => db.appSetting.findMany();\n",
  };
  for (const [label, newText] of Object.entries(cases)) {
    const result = slice([change("lib/leaf.ts", { newText })]);
    assert.deepEqual([...result.slicePaths], ["lib/leaf.ts"], label);
  }
});

test("adding a configuration name the control plane reads, or any AppSetting key, joins the slice", () => {
  assert.ok(slice([change("lib/leaf.ts", { addedText: "if (process.env.AMUX_GATE_MODE) {}" })]).slicePaths.has("lib/leaf.ts"));
  assert.ok(slice([change("lib/leaf.ts", { addedText: 'const k = "feature.secretSwitch";' })]).slicePaths.has("lib/leaf.ts"));
  assert.equal(slice([change("lib/leaf.ts", { addedText: "// a comment about switches" })]).slicePaths.size, 0);
  assert.deepEqual([...environmentNames('process.env.FOO_KEY process.env["BAR"]')].sort(), ["BAR", "FOO_KEY"]);
});

test("anything unresolvable or unparseable fails the whole patch", () => {
  assert.equal(slice([change("lib/leaf.ts", { newText: 'import { x } from "./missing";\n' })]).status, "failed");
  assert.equal(slice([change("lib/leaf.ts")], tree({ "lib/broken.ts": 'import "@/lib/nope";\n' })).status, "failed");
  assert.equal(slice([change("lib/leaf.ts")], tree({ "lib/w.ts": 'import "@tomverse/unknown";\n' })).status, "failed");
  assert.equal(slice([change("lib/leaf.ts")], tree({ "lib/w.ts": 'import "left-pad";\n' })).status, "failed", "a package the lockfile does not install");
  assert.equal(slice([change("lib/leaf.ts", { newText: "export const = ;\n" })]).status, "failed");
  assert.equal(slice([change("lib/leaf.ts")], tree({ "lib/bad.ts": "export const = ;\n" })).status, "failed");
  assert.equal(slice([change("lib/leaf.ts")], tree({ "tsconfig.json": null })).status, "failed");
});

test("a runtime control-plane module that assembles what it loads fails the analysis; words in comments do not", () => {
  assert.equal(
    slice([change("lib/leaf.ts")], tree({ "lib/amux/load.ts": "export const load = (name) => import(name);\n" })).status,
    "failed",
  );
  assert.equal(
    slice([change("lib/leaf.ts")], tree({ "lib/amux/doc.ts": "/** import (see the notes), require(x) in prose */\nexport const d = 1;\n" })).status,
    "analysed",
  );
  assert.equal(hasRuntimeLoader({ path: "a.ts", text: 'const m = await import("./x");' }), false);
  assert.equal(hasRuntimeLoader({ path: "a.ts", text: "const m = await import(`./${x}`);" }), true);
  assert.equal(hasRuntimeLoader({ path: "a.ts", text: "require.resolve('x')" }), true);
  assert.equal(hasRuntimeLoader({ path: "a.ts", text: "const g = import.meta.glob('./*.ts');" }), true);
});

test("imports come from the syntax tree, not from text that looks like one", () => {
  assert.deepEqual(
    importSpecifiers({
      path: "a.ts",
      text: [
        "// a comment with `import(` on a line and `x)` after",
        'import type { T } from "./types";',
        'export * from "./barrel";',
        'import fs = require("node:fs");',
        'const m = await import("./lazy");',
        'type L = import("./typeOnly").T;',
      ].join("\n"),
    }).sort(),
    ["./barrel", "./lazy", "./typeOnly", "./types", "node:fs"],
  );
  assert.deepEqual(codeFacts(tsParse("export const x = obj['literal']();")).computedCall, true);
});

test("resolution follows TypeScript: .js names the .ts source, @/ maps to the root, workspaces through their manifests", () => {
  const files = tree({ "lib/both.js": "export const js = 1;\n", "lib/both.ts": "export const ts = 1;\n" });
  const { resolve, problems } = createResolver(files);
  assert.deepEqual(problems, []);
  assert.equal(resolve("lib/helper.ts", "./deep.js"), "lib/deep.ts");
  assert.equal(resolve("lib/x.ts", "@/lib/pkg"), "lib/pkg/index.ts");
  assert.equal(resolve("app/x.ts", "@tomverse/chat-core"), "packages/chat-core/src/index.ts");
  assert.equal(resolve("app/x.ts", "@tomverse/ui-tokens/tokens.css"), "packages/ui-tokens/src/tokens.css");
  assert.equal(resolve("lib/x.ts", "react"), "external");
  assert.equal(resolve("lib/x.ts", "@ai-sdk/provider"), "external", "installed transitively per the lockfile");
  assert.equal(resolve("lib/x.ts", "node:fs"), "external");
  assert.equal(resolve("lib/x.ts", "crypto"), "external");
  assert.equal(resolve("lib/x.ts", "left-pad"), null);
  assert.equal(resolve("lib/x.ts", "../../outside"), null);
  assert.equal(resolve("lib/a.ts", "./both.js"), "lib/both.ts", "TypeScript prefers the source for a .js specifier");
});

test("on this repository the analysis resolves every import of the app runtime and finds a non-empty slice", () => {
  const root = new URL("..", import.meta.url);
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
  const baseFiles = paths.map((path) => ({
    path,
    text: /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/.test(path) ? readFileSync(new URL(path, root), "utf8") : "",
  }));
  const result = computeControlPlaneSlice({ baseFiles, changes: [] });
  assert.equal(result.status, "analysed", JSON.stringify((result.problems ?? []).slice(0, 5)));
  assert.ok(result.baseSliceSize > 0);
});

