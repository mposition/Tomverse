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
  isGateOutsideRuntime,
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
    // Not named after a directory: a manifest's words are read as paths.
    "package.json": JSON.stringify({ name: "fixture", dependencies: { react: "19" } }),
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

test("a workflow or shell gate brings in the paths and globs it reads, not comments or trigger filters; one with no text fails", () => {
  const workflow =
    "on:\n  push:\n    paths: ['lib/trigger*.ts']\njobs:\n  x:\n    steps:\n" +
    "      # docs/ops/commented.json is only mentioned\n" +
    '      - run: node -e \'require("./docs/ops/frozen.json")\'\n' +
    "      - run: bash scripts/x.sh --input=docs/ops/input.json\n";
  const files = tree({
    ".github/workflows/x.yml": workflow,
    "scripts/x.sh": "cat lib/shellRead.json\n",
    "docs/ops/frozen.json": "{}\n",
    "docs/ops/input.json": "{}\n",
    "docs/ops/commented.json": "{}\n",
    "lib/shellRead.json": "{}\n",
    "lib/triggerA.ts": "export const a = 1;\n",
  });
  const paths = ["docs/ops/frozen.json", "docs/ops/input.json", "lib/shellRead.json"];
  const result = slice(
    [...paths, "docs/ops/commented.json", "lib/triggerA.ts"].map((path) => change(path, { newText: "{}\n" })),
    files,
  );
  assert.equal(result.status, "analysed", JSON.stringify(result.problems ?? []));
  assert.deepEqual([...result.slicePaths].sort(), [...paths].sort());
  assert.equal(slice([change("lib/leaf.ts")], tree({ ".github/workflows/x.yml": "" })).status, "failed");

  // A glob a gate reads through is its read set; one in a trigger filter list is not.
  const globbing = tree({
    ".github/workflows/y.yml":
      "on:\n  pull_request:\n    paths:\n      - 'lib/filtered/**'\n    branches: [develop]\njobs:\n  y:\n    steps:\n" +
      "      - run: cat docs/ops/run-*.json\n",
    "scripts/y.sh": "for f in docs/shell/*.json; do cat \"$f\"; done\n",
    "docs/ops/run-a.json": "{}\n",
    "docs/shell/b.json": "{}\n",
    "lib/filtered/c.ts": "export const c = 1;\n",
  });
  const globbed = ["docs/ops/run-a.json", "docs/shell/b.json"];
  assert.deepEqual(
    [...slice([...globbed, "lib/filtered/c.ts"].map((path) => change(path, { newText: "{}\n" })), globbing).slicePaths].sort(),
    globbed,
  );

  // `**/` matches no directory too; `paths:` under a step is an input, not a
  // trigger; an image path under /app is the repository path.
  const inputs = tree({
    ".github/workflows/z.yml":
      "on:\n  push:\n    paths: ['docs/never/**']\njobs:\n  z:\n    steps:\n      - uses: some/action@v1\n        with:\n" +
      "          paths:\n            - docs/inputs/base.json\n      - run: cat docs/deep/**/*.json\n",
    "Dockerfile": "COPY . /app\nRUN node /app/docs/image/seed.json\nRUN cat /app/docs/globbed/*.json\n",
    ".github/actions/one/action.yml": "runs:\n  using: composite\n  steps:\n    - with:\n        paths: [docs/listed/one.json]\n",
    "docs/globbed/g.json": "{}\n",
    "docs/listed/one.json": "{}\n",
    "scripts/ops/check.ps1": "$allow = Get-Content .\\docs\\ops\\allowlist.json\n",
    // A path behind a runner variable.
    "scripts/ops/patch.sh": 'git apply "$GITHUB_WORKSPACE/docs/runner/fix.json"\n',
    "docs/runner/fix.json": "{}\n",
    "docs/ops/allowlist.json": "[]\n",
    "docker/runner/Dockerfile": "COPY docs/copied /app/docs/copied\nWORKDIR /app\n",
    "docs/copied/inner/c.json": "{}\n",
    // A single top-level directory a shell gate walks, and a product
    // package's script that reads a file.
    "scripts/walk.sh": "find ./locales -type f -exec cat {} \\;\n",
    "locales/walked.json": "{}\n",
    "packages/kit/package.json": '{"name":"kit","scripts":{"gen":"node gen.mjs docs/kit/seed.json"}}',
    "docs/kit/seed.json": "{}\n",
    "docs/inputs/base.json": "{}\n",
    "docs/deep/top.json": "{}\n",
    "docs/deep/a/b.json": "{}\n",
    "docs/image/seed.json": "{}\n",
    "docs/never/x.json": "{}\n",
  });
  const read = [
    "docs/copied/inner/c.json",
    "docs/deep/a/b.json",
    "docs/deep/top.json",
    "docs/globbed/g.json",
    "docs/image/seed.json",
    "docs/inputs/base.json",
    "docs/kit/seed.json",
    "docs/listed/one.json",
    "docs/ops/allowlist.json",
    "docs/runner/fix.json",
    "locales/walked.json",
  ];
  assert.deepEqual(
    [...slice([...read, "docs/never/x.json"].map((path) => change(path, { newText: "{}\n" })), inputs).slicePaths].sort(),
    read,
  );
});

test("a code file a gate names by path is followed; a test or fixture a runner names is its input", () => {
  const files = tree({
    "scripts/run.mjs": 'export const LOADED = "lib/namedTool.ts";\nexport const SUITE = "tests/fixtures/process.mjs";\n',
    "lib/namedTool.ts": 'import { x } from "./viaNamed.ts";\nexport { x };\n',
    "tests/fixtures/process.mjs": 'import { y } from "../../lib/viaFixture.ts";\nexport const run = (m) => import(m);\nexport { y };\n',
    "lib/viaNamed.ts": "export const x = 1;\n",
    "lib/viaFixture.ts": "export const y = 1;\n",
  });
  const result = slice(["lib/viaNamed.ts", "lib/viaFixture.ts"].map((path) => change(path, { newText: "export const x = 2;\n" })), files);
  assert.equal(result.status, "analysed", JSON.stringify(result.problems ?? []));
  assert.deepEqual([...result.slicePaths], ["lib/viaNamed.ts"]);

  // A file first seen below a named directory is still followed once named exactly.
  const both = tree({
    "lib/amux/gate.ts":
      'import { join } from "node:path";\nexport const dir = () => join(process.cwd(), "lib", "plugins");\nexport const ENTRY = "lib/entry.ts";\n',
    "lib/entry.ts": 'export const PLUGIN = "lib/plugins/a.ts";\n',
    "lib/plugins/a.ts": 'import { v } from "../value.ts";\nexport { v };\n',
    "lib/value.ts": "export const v = 1;\n",
  });
  assert.ok(slice([change("lib/value.ts", { newText: "export const v = 2;\n" })], both).slicePaths.has("lib/value.ts"));

  // Code under a directory a gate reads is data there; running it takes a computed load.
  const byDirectory = tree({
    "lib/amux/gate.ts": 'import { join } from "node:path";\nexport const dir = () => join(process.cwd(), "lib", "plugins");\n',
    "lib/plugins/a.ts": 'import { z } from "../viaDirectory.ts";\nexport { z };\n',
    "lib/viaDirectory.ts": "export const z = 1;\n",
  });
  assert.deepEqual(
    [...slice(["lib/plugins/a.ts", "lib/viaDirectory.ts"].map((path) => change(path, { newText: byDirectory.find((f) => f.path === path).text })), byDirectory).slicePaths],
    ["lib/plugins/a.ts"],
  );
});

test("a path a gate names relative to itself or through the @/ alias is read as the file it means", () => {
  const files = tree({
    "lib/amux/gate.ts":
      'import { readFileSync } from "node:fs";\n' +
      'export const rules = () => readFileSync(new URL("../rules.json", import.meta.url));\n' +
      'export const seed = "@/lib/seed.json";\n',
    "lib/rules.json": "{}\n",
    "lib/seed.json": "{}\n",
  });
  const result = slice(["lib/rules.json", "lib/seed.json"].map((path) => change(path, { newText: "[]\n" })), files);
  assert.deepEqual([...result.slicePaths].sort(), ["lib/rules.json", "lib/seed.json"]);
});

test("imports are followed through test helpers, and a followed file that cannot be read fails the analysis", () => {
  const files = tree({
    "scripts/check.mjs": 'import { rule } from "../tests/support/check.mjs";\nexport const check = rule;\n',
    "tests/support/check.mjs": 'import { rule } from "../../lib/rule.ts";\nexport { rule };\n',
    "lib/rule.ts": "export const rule = 1;\n",
  });
  assert.deepEqual([...slice([change("lib/rule.ts")], files).slicePaths], ["lib/rule.ts"]);
  // The evidence holds no text for a test file the image leaves out.
  const unread = files.map((file) => (file.path === "tests/support/check.mjs" ? { ...file, text: "" } : file));
  assert.equal(slice([change("lib/leaf.ts")], unread).status, "failed");
  // Nor for the vendored AMUX server: reaching it fails; leaving it alone does not.
  const vendored = tree({
    "scripts/check.mjs": 'import { v } from "../vendor/amux/helper.mjs";\nexport const check = v;\n',
    "vendor/amux/helper.mjs": "",
  });
  assert.equal(slice([change("lib/leaf.ts")], vendored).status, "failed");
  assert.equal(slice([change("lib/leaf.ts")], tree({ "vendor/amux/helper.mjs": "" })).status, "analysed");
});

test("a followed product file that loads by a computed name fails the analysis; a gate script's own computed load does not", () => {
  const helper = (text) => tree({ "lib/helper.ts": text });
  assert.equal(slice([change("lib/leaf.ts")], helper("export const helper = (name) => import(name);\n")).status, "failed");
  // Every computed `require` call is the loader, whatever the name is bound to,
  // and so is `module.require(name)`.
  for (const text of [
    "const require = (ok, why) => { if (!ok) throw new Error(why); };\nexport const helper = (x) => require(x > 0, `x ${x}`);\n",
    "function require(name) { return module.require(name); }\nexport const helper = () => require(process.argv[2]);\n",
    "export const helper = (name) => module.require(name);\n",
    'export const helper = (name) => module["require"](name);\n',
    "export const helper = (key, name) => module[key](name);\n",
    // Parenthesised, or handed on as a value: the loader escapes.
    "export const helper = (name) => (module.require)(name);\n",
    "const load = module.require.bind(module);\nexport const helper = (name) => load(name);\n",
    "export const helper = (run) => run(require);\n",
    "export const helper = (run) => run(module);\n",
    "function check(require) { return require; }\nexport const helper = (name) => require(name);\n",
    "export const helper = (require, name) => require(name);\n",
    "var require = module.require.bind(module);\nexport const helper = (name) => require(name);\n",
    // A parameter shadows the helper defined around it.
    "const require = (ok) => ok;\nexport function helper(require, name) { return require(name); }\n",
    // A helper given something else later is that.
    "export const helper = (name) => { let require = (x) => x; require = module.require.bind(module); return require(name); };\n",
    "function require(x) { return x; }\nrequire = module.require.bind(module);\nexport const helper = (name) => require(name);\n",
  ]) {
    assert.equal(slice([change("lib/leaf.ts")], helper(text)).status, "failed", text);
  }
  assert.equal(
    slice([change("lib/leaf.ts")], tree({ "scripts/check-locales.mjs": "export const load = (locale) => import(`../locales/${locale}.ts`);\n" })).status,
    "analysed",
  );
  // The mobile apps are gates outside the app, by the manifest.
  assert.equal(isGateOutsideRuntime("apps/mobile/src/screen.tsx"), true);
  assert.equal(isGateOutsideRuntime("tests/support/check.mjs"), false);
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
  // A name a shell or workflow gate reads counts too.
  const shell = tree({
    "scripts/gate.sh": 'if [ "${GATE_SHELL_MODE}" = on ]; then exit 1; fi\n',
    "scripts/gate.ps1": "if ($env:GATE_ONLY_MODE) { exit 1 }\n",
  });
  for (const name of ["GATE_SHELL_MODE", "GATE_ONLY_MODE"]) {
    assert.ok(slice([change(outside, { addedText: `if (process.env.${name}) {}` })], shell).slicePaths.has(outside), name);
  }
  // So does one a test helper a gate imports reads.
  const helped = tree({
    "scripts/check.mjs": 'import { mode } from "../tests/support/mode.mjs";\nexport const check = mode;\n',
    "tests/support/mode.mjs": "export const mode = () => process.env.HELPER_GATE_MODE;\n",
  });
  assert.ok(slice([change(outside, { addedText: "if (process.env.HELPER_GATE_MODE) {}" })], helped).slicePaths.has(outside));
  // An AppSetting key a gate outside the app reads is protected too.
  const scripted = tree({
    "scripts/check.mjs": 'export const on = (db) => db.appSetting.findUnique({ where: { key: "gate.scriptSwitch" } });\n',
  });
  assert.ok(slice([change(outside, { addedText: 'const k = "gate.scriptSwitch";' })], scripted).slicePaths.has(outside));
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
        'const h = module.require("./viaModule");',
      ].join("\n"),
    }).sort(),
    ["./barrel", "./lazy", "./typeOnly", "./types", "./viaModule", "node:fs"],
  );
  // A gate that loads a helper through module.require, by name, by bracket or in parentheses, reaches it.
  for (const call of [
    'module.require("../moduleHelper")',
    'module["require"]("../moduleHelper")',
    '(module.require)("../moduleHelper")',
    '(require)("../moduleHelper")',
  ]) {
    const viaModule = tree({
      "lib/amux/gate.ts": `export const gate = () => ${call};\n`,
      "lib/moduleHelper.ts": 'import { deep } from "./deep";\nexport const h = deep;\n',
    });
    assert.ok(slice([change("lib/deep.ts")], viaModule).slicePaths.has("lib/deep.ts"), call);
  }
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
    // The texts the base evidence reads, text gates included.
    text: /(?:\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|ya?ml|sh|ps1|toml)|(?:^|\/)Dockerfile[^/]*)$/.test(path)
      ? readFileSync(new URL(path, root), "utf8")
      : "",
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

