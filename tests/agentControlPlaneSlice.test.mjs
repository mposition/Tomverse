import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  computeControlPlaneSlice,
  configurationNames,
  hasRuntimeLoader,
  resolveSpecifier,
} from "../lib/agentControlPlaneSlice.ts";

/**
 * A small tree. `lib/amux/gate.ts` is runtime control plane; it imports a
 * product helper, which imports another. `lib/feature.ts` calls a control-plane
 * module. `lib/leaf.ts` touches nothing.
 */
const tree = (overrides = {}) => {
  const files = {
    "lib/amux/gate.ts": 'import { helper } from "@/lib/helper";\nexport const gate = () => process.env.AMUX_GATE_MODE === "on" && helper();\n',
    "lib/helper.ts": 'import { deep } from "./deep.js";\nexport const helper = () => deep();\n',
    "lib/deep.ts": "export const deep = () => true;\n",
    "lib/feature.ts": 'import { gate } from "./amux/gate";\nexport const feature = () => gate();\n',
    "lib/leaf.ts": "export const leaf = 1;\n",
    "lib/pkg/index.ts": "export const pkg = 1;\n",
    "packages/chat-core/src/index.ts": "export const core = 1;\n",
    ...overrides,
  };
  return Object.entries(files).map(([path, text]) => ({ path, text }));
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
  assert.equal(result.status, "analysed");
  assert.deepEqual([...result.slicePaths].sort(), ["lib/deep.ts", "lib/helper.ts"]);
});

test("a product file that calls a control-plane module is in the slice", () => {
  const result = slice([change("lib/feature.ts")]);
  assert.deepEqual([...result.slicePaths], ["lib/feature.ts"]);
});

test("both sides of a rename are checked", () => {
  const result = slice([change("lib/moved.ts", { previousPath: "lib/deep.ts", status: "renamed" })]);
  assert.deepEqual([...result.slicePaths], ["lib/deep.ts"]);
});

test("a change that starts calling the control plane joins the slice", () => {
  const result = slice([
    change("lib/leaf.ts", { newText: 'import { gate } from "@/lib/amux/gate";\nexport const leaf = gate();\n' }),
  ]);
  assert.deepEqual([...result.slicePaths], ["lib/leaf.ts"]);
});

test("a change that mentions a name the control plane reads joins the slice", () => {
  const result = slice([change("lib/leaf.ts", { addedText: "process.env.AMUX_GATE_MODE = 'off';" })]);
  assert.deepEqual([...result.slicePaths], ["lib/leaf.ts"]);
  assert.deepEqual([...configurationNames('x "feature.engineeringAgentMode" process.env.FOO_KEY process.env["BAR"]')].sort(), [
    "BAR",
    "FOO_KEY",
    "feature.engineeringAgentMode",
  ]);
});

test("an import nobody can resolve fails the whole patch", () => {
  const result = slice([change("lib/leaf.ts", { newText: 'import { x } from "./missing";\n' })]);
  assert.equal(result.status, "failed");
  const base = slice([change("lib/leaf.ts")], tree({ "lib/broken.ts": 'import "@/lib/nope";\n' }));
  assert.equal(base.status, "failed");
  assert.equal(slice([change("lib/leaf.ts")], tree({ "lib/w.ts": 'import "@tomverse/unknown";\n' })).status, "failed");
});

test("a runtime control-plane module that assembles what it loads fails the analysis; words in comments do not", () => {
  assert.equal(
    slice([change("lib/leaf.ts")], tree({ "lib/amux/load.ts": "export const load = (name) => import(name);\n" })).status,
    "failed",
  );
  assert.equal(
    slice([change("lib/leaf.ts")], tree({ "lib/amux/doc.ts": "/** import (policy §22), require(x) in prose */\nexport const d = 1;\n" })).status,
    "analysed",
  );
  assert.equal(hasRuntimeLoader({ path: "a.ts", text: 'const m = await import("./x");' }), false);
  assert.equal(hasRuntimeLoader({ path: "a.ts", text: "const m = await import(`./${x}`);" }), true);
  assert.equal(hasRuntimeLoader({ path: "a.ts", text: "const m = require(name);" }), true);
  assert.equal(hasRuntimeLoader({ path: "a.ts", text: "require.resolve('x')" }), true);
  assert.equal(hasRuntimeLoader({ path: "a.ts", text: "const r = createRequire(import.meta.url);" }), true);
  assert.equal(hasRuntimeLoader({ path: "a.ts", text: "const g = import.meta.glob('./*.ts');" }), true);
});

test("specifiers resolve the way this repository's code expects", () => {
  const tracked = new Set(tree().map((file) => file.path));
  assert.equal(resolveSpecifier("lib/feature.ts", "./amux/gate", tracked), "lib/amux/gate.ts");
  assert.equal(resolveSpecifier("lib/helper.ts", "./deep.js", tracked), "lib/deep.ts");
  assert.equal(resolveSpecifier("lib/x.ts", "@/lib/pkg", tracked), "lib/pkg/index.ts");
  assert.equal(resolveSpecifier("app/x.ts", "@tomverse/chat-core", tracked), "packages/chat-core/src/index.ts");
  assert.equal(resolveSpecifier("lib/x.ts", "react", tracked), "external");
  assert.equal(resolveSpecifier("lib/x.ts", "node:fs", tracked), "external");
  assert.equal(resolveSpecifier("lib/x.ts", "../../outside", tracked), null);
});

test("on this repository the analysis resolves every import and finds a non-empty slice", () => {
  const root = new URL("..", import.meta.url);
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
  const baseFiles = paths.map((path) => ({
    path,
    text: /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path) ? readFileSync(new URL(path, root), "utf8") : "",
  }));
  const result = computeControlPlaneSlice({ baseFiles, changes: [] });
  assert.equal(result.status, "analysed", JSON.stringify(result.problems ?? []));
  assert.ok(result.baseSliceSize > 0);
});
