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

test("the slice is what the gates import, directly or through other files; a caller or an unreached file is not", () => {
  const result = slice([
    change("lib/deep.ts"),
    change("lib/helper.ts"),
    // They use the gate; the gate does not use them.
    change("lib/facade.ts", { newText: 'export { gate } from "./amux/gate";\nexport const more = 1;\n' }),
    change("lib/page.ts", { newText: 'import { gate } from "@/lib/facade";\nexport const page = () => !gate();\n' }),
    change("lib/leaf.ts"),
    // Registered by the framework's route convention and reached only by a URL.
    change("app/api/example/route.ts", { status: "added", newText: 'export const POST = () => new Response("x");\n' }),
    change("tests/leaf.test.mjs", { status: "added", newText: "export {};\n" }),
    change("docs/notes.md", { status: "added", newText: "notes\n" }),
  ]);
  assert.equal(result.status, "analysed", JSON.stringify(result.problems ?? []));
  assert.deepEqual([...result.slicePaths].sort(), ["lib/deep.ts", "lib/helper.ts"]);
});

test("data a gate reads is in the slice, whether imported or named by path; a named code file's imports follow", () => {
  const overrides = {
    "lib/amux/gate.ts":
      'import rules from "../rules.json";\nimport { REGISTRY } from "@/lib/registry";\n' +
      'export const gate = () => rules.enabled && REGISTRY;\nexport const LOADER = "lib/loaded.ts";\n',
    "lib/rules.json": '{"enabled": false}\n',
    "lib/registry.ts":
      'import { readFileSync } from "node:fs";\nimport { join } from "node:path";\nexport const REGISTRY = "docs/marketing/registry.json";\n' +
      'export const font = () => readFileSync(join(process.cwd(), "docs", "fonts", "face.ttf"));\n' +
      "export const page = (name) => readFileSync(`docs/pages/${name}.md`);\n",
    "lib/loaded.ts": 'import { inner } from "./inner";\nexport const loaded = inner;\n',
    "lib/inner.ts": "export const inner = 1;\n",
    // Read only by a file no gate reaches.
    "docs/imported.json": '{"a": 1}\n',
    "lib/useConfig.ts": 'import data from "../docs/imported.json";\nexport const d = data;\n',
    "docs/marketing/registry.json": "{}\n",
    "docs/fonts/face.ttf": "x",
    "docs/pages/home.md": "x",
    "docs/unrelated.md": "x",
  };
  const paths = [
    "lib/rules.json",
    "lib/registry.ts",
    "lib/loaded.ts",
    "lib/inner.ts",
    "docs/marketing/registry.json",
    "docs/fonts/face.ttf",
    "docs/pages/home.md",
  ];
  const result = slice(
    [...paths, "docs/imported.json", "locales/strings.json", "docs/unrelated.md"]
      .map((path) => change(path, { newText: path.endsWith(".ts") ? overrides[path] : "{}\n" })),
    tree(overrides),
  );
  assert.equal(result.status, "analysed", JSON.stringify(result.problems ?? []));
  assert.deepEqual([...result.slicePaths].sort(), [...paths].sort());
});

test("gate code outside the app brings in what it imports and the files it names exactly, not the directories it walks", () => {
  const files = tree({
    "scripts/check-x.mjs":
      'import { rule } from "../lib/ruleCore.ts";\nimport "railway/iac";\nimport { join } from "node:path";\n' +
      'export const ALLOW = "docs/ops/allowlist.json";\nexport const walk = (root) => join(root, "docs", "ops");\nexport const check = rule;\n',
    "lib/ruleCore.ts": 'import { leafRule } from "./ruleLeaf";\nexport const rule = leafRule;\n',
    "lib/ruleLeaf.ts": "export const leafRule = 1;\n",
    "docs/ops/allowlist.json": "[]\n",
    "docs/ops/walked.md": "x",
    // A test is an oracle, not a starting point.
    "tests/agentGate.test.mjs": 'import { leaf } from "../lib/leaf.ts";\nexport const t = leaf;\n',
  });
  const result = slice(
    ["lib/ruleCore.ts", "lib/ruleLeaf.ts", "docs/ops/allowlist.json", "docs/ops/walked.md", "lib/leaf.ts"]
      .map((path) => change(path, { newText: path.endsWith(".ts") ? files.find((f) => f.path === path).text : "x\n" })),
    files,
  );
  assert.equal(result.status, "analysed", JSON.stringify(result.problems ?? []), "an unresolved import outside the app fails nothing");
  assert.deepEqual([...result.slicePaths].sort(), ["docs/ops/allowlist.json", "lib/ruleCore.ts", "lib/ruleLeaf.ts"]);
  assert.equal(slice([change("lib/leaf.ts")], tree({ "scripts/bad.mjs": "export const = ;\n" })).status, "failed");
});

test("a file the change brings under a gate is in the slice; a new caller of a gate is not", () => {
  const result = slice([
    change("lib/helper.ts", { newText: 'import { added } from "./added";\nexport const helper = () => added;\n' }),
    change("lib/added.ts", { status: "added", newText: "export const added = true;\n" }),
    change("lib/newBarrel.ts", { status: "added", newText: 'export * from "./amux/gate";\n' }),
    change("lib/newCaller.ts", { status: "added", newText: 'import { gate } from "./newBarrel";\nexport const c = gate;\n' }),
  ]);
  assert.equal(result.status, "analysed", JSON.stringify(result.problems ?? []));
  assert.deepEqual([...result.slicePaths].sort(), ["lib/added.ts", "lib/helper.ts"]);
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

test("adding a configuration name the control plane reads, or any AppSetting key, brings any file into the slice", () => {
  const outside = "tests/leaf.test.mjs";
  assert.ok(slice([change(outside, { addedText: "if (process.env.AMUX_GATE_MODE) {}" })]).slicePaths.has(outside));
  assert.ok(slice([change(outside, { addedText: 'const k = "feature.secretSwitch";' })]).slicePaths.has(outside));
  assert.equal(slice([change(outside, { addedText: "// a comment about switches" })]).slicePaths.size, 0);
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

test("on this repository the analysis resolves every import of the app runtime and the slice is the gates' reach", () => {
  const root = new URL("..", import.meta.url);
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
  const baseFiles = paths.map((path) => ({
    path,
    text: /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/.test(path) ? readFileSync(new URL(path, root), "utf8") : "",
  }));
  // The policy's own example (a gate writes its audit through lib/adminAudit.ts),
  // and an operating document no gate reads.
  const probes = ["lib/adminAudit.ts", "docs/ops/dev-test-lanes.md"];
  const changes = probes.map((path) => change(path, { newText: baseFiles.find((file) => file.path === path).text, addedText: "" }));
  const result = computeControlPlaneSlice({ baseFiles, changes });
  assert.equal(result.status, "analysed", JSON.stringify((result.problems ?? []).slice(0, 5)));
  assert.deepEqual([...result.slicePaths], ["lib/adminAudit.ts"]);
  assert.ok(result.baseSliceSize > 0);
});

