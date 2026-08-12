// The shared-package boundary (PACKAGE-01, docs/policy/shared-packages.md).
//
// `npm run check:shared-packages` reports the gate metric on the packages that
// exist today. What it cannot tell anyone is whether the rule would still
// catch a violation -- a rule that silently stopped applying reports the same
// zero as a clean tree. These tests exercise the rule against source that is
// deliberately forbidden, so the count staying at 0 keeps meaning something.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";

const root = fileURLToPath(new URL("..", import.meta.url));
const packagesDir = join(root, "packages");
const RULE = "no-restricted-imports";

const packageNames = readdirSync(packagesDir)
  .filter((entry) => statSync(join(packagesDir, entry)).isDirectory())
  .sort();

const eslint = new ESLint({ cwd: root });

/** Lints a source string as if it were a file inside a shared package. */
const lintInPackage = async (source) => {
  const [results] = await eslint.lintText(source, {
    filePath: join(packagesDir, packageNames[0], "src", "__boundary_probe.ts"),
  });
  return results.messages.filter((message) => message.ruleId === RULE);
};

test("there is at least one shared package to enforce the boundary on", () => {
  assert.ok(
    packageNames.length > 0,
    "PACKAGE-01 measures a boundary; packages/ must not be empty."
  );
});

const forbidden = [
  ["a framework import", 'import Link from "next/link";'],
  ["the framework root", 'import { after } from "next";'],
  ["a server-only module", 'import "server-only";'],
  ["the app root alias", 'import { x } from "@/lib/models";'],
  ["the database client", 'import { PrismaClient } from "@prisma/client";'],
  ["a Node builtin", 'import { createHmac } from "node:crypto";'],
  ["a bare Node builtin", 'import { join } from "path";'],
  ["a native bridge", 'import { Preferences } from "@capacitor/preferences";'],
];

for (const [label, source] of forbidden) {
  test(`${label} is rejected inside a shared package`, async () => {
    const messages = await lintInPackage(source);
    assert.equal(
      messages.length,
      1,
      `expected ${RULE} to reject: ${source}\n` +
        `got: ${JSON.stringify(messages)}`
    );
    assert.match(messages[0].message, /PACKAGE-01/);
  });
}

test("ordinary shared code is not rejected", async () => {
  const messages = await lintInPackage(
    'export const identity = (value: string) => value;\n'
  );
  assert.deepEqual(messages, []);
});

test("the rule does not apply outside packages/", async () => {
  // The same import must stay legal in the app: this boundary exists to keep
  // the *shared* half neutral, not to ban Next.js from the Next.js app.
  const [result] = await eslint.lintText('import Link from "next/link";\n', {
    filePath: join(root, "lib", "__boundary_probe.ts"),
  });
  assert.deepEqual(
    result.messages.filter((message) => message.ruleId === RULE),
    []
  );
});

for (const name of packageNames) {
  test(`packages/${name} declares no runtime dependencies`, () => {
    const manifest = JSON.parse(
      readFileSync(join(packagesDir, name, "package.json"), "utf8")
    );
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
    assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}), []);
    assert.equal(manifest.type, "module");
  });

  test(`packages/${name} does not inherit the app's tsconfig`, () => {
    const tsconfig = readFileSync(
      join(packagesDir, name, "tsconfig.json"),
      "utf8"
    );
    // Comments are stripped rather than parsed as JSON: the file is JSONC.
    const parsed = JSON.parse(
      tsconfig.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")
    );
    assert.equal(
      parsed.extends,
      undefined,
      "extending the root config would re-admit the DOM lib, the `@/*` alias " +
        "and the Next.js plugin, which is the coupling this package denies."
    );
    assert.deepEqual(parsed.compilerOptions.lib, ["ES2022"]);
    assert.deepEqual(parsed.compilerOptions.types, []);
    assert.equal(parsed.compilerOptions.paths, undefined);
  });
}

test("the workspace resolves the package by its published specifier", async () => {
  // Not a formality: the app imports `@tomverse/chat-core`, and that only
  // resolves because the root manifest declares the workspace. Importing the
  // file by relative path here would pass with the workspace removed.
  const chatCore = await import("@tomverse/chat-core");
  assert.equal(typeof chatCore.resolveChatCompletionOutcome, "function");
});

test("the root manifest declares the workspace", () => {
  const manifest = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8")
  );
  assert.ok(
    (manifest.workspaces ?? []).includes("packages/*"),
    "packages/* must be a workspace or the specifier above resolves to nothing."
  );
});
