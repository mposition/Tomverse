// The shared-package boundary (PACKAGE-01, docs/policy/shared-packages.md).
//
// `npm run check:shared-packages` reports the gate metric on the packages that
// exist today. What it cannot tell anyone is whether the rule would still
// catch a violation -- a rule that silently stopped applying reports the same
// zero as a clean tree. These tests exercise the rule against source that is
// deliberately forbidden, so the count staying at 0 keeps meaning something.

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

/* ------------------------------------------------- CSS assets, same boundary */

const cssFilesIn = (name) => {
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : entry.name.endsWith(".css")
          ? [join(dir, entry.name)]
          : []
    );
  };
  return walk(join(packagesDir, name, "src"));
};

const packageCss = packageNames.flatMap((name) =>
  cssFilesIn(name).map((file) => ({ name, file }))
);

test("a package ships CSS, so the CSS rules are guarding something", () => {
  // The ESLint rule and the standalone tsconfig only see TypeScript. A package
  // can be entirely CSS -- ui-tokens is -- and this file's TypeScript-shaped
  // assertions would then pass over a package nothing had read.
  assert.ok(
    packageCss.length > 0,
    "no .css under packages/*/src; the CSS assertions below check nothing"
  );
});

for (const { name, file } of packageCss) {
  const relative = file.slice(root.length + 1);

  test(`${relative} uses no Tailwind at-rule`, () => {
    const css = file && readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const atRule of [
      "@theme",
      "@apply",
      "@utility",
      "@variant",
      "@custom-variant",
      "@source",
      "@plugin",
      "@config",
      "@reference",
      "@tailwind",
    ]) {
      assert.ok(
        !new RegExp(`${atRule}\\b`).test(css),
        `${atRule} only resolves inside a Tailwind build`
      );
    }
  });

  test(`${relative} imports nothing outside its own package`, () => {
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of css.matchAll(/@import\s+(?:url\()?["']([^"']+)["']/g)) {
      assert.ok(
        match[1].startsWith("."),
        `${match[1]} is resolved by whatever build is around it`
      );
    }
  });

  test(`${relative} defines every custom property it reads`, () => {
    // The CSS half of the tsconfig's forbidden-global rule. A
    // `var(--font-geist-sans)` would load anywhere and render as nothing
    // outside the Next.js app that injects it.
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const defined = new Set(
      [...css.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1])
    );
    const referenced = [
      ...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g),
    ].map((match) => match[1]);
    for (const token of referenced) {
      assert.ok(
        defined.has(token),
        `${token} is read but never defined, and carries no fallback`
      );
    }
  });

  test(`${name} does not restate ${relative} in the app`, () => {
    const owned = new Set(
      [
        ...readFileSync(file, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .matchAll(/(--[\w-]+)\s*:/g),
      ].map((match) => match[1])
    );
    const appCss = readFileSync(join(root, "app", "globals.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      ""
    );
    const redefined = new Set(
      [...appCss.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1])
    );
    const clashes = [...owned].filter((token) => redefined.has(token));
    assert.deepEqual(
      clashes,
      [],
      "app/globals.css redefines tokens the package owns; which one wins is " +
        "decided by import order"
    );
  });
}

test("the app imports every CSS the packages export", () => {
  for (const name of packageNames) {
    const manifest = JSON.parse(
      readFileSync(join(packagesDir, name, "package.json"), "utf8")
    );
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      if (typeof target !== "string" || !target.endsWith(".css")) continue;
      const specifier = `${manifest.name}${subpath.replace(/^\./, "")}`;
      const appCss = readFileSync(join(root, "app", "globals.css"), "utf8");
      assert.ok(
        appCss.includes(specifier),
        `nothing imports ${specifier}; an asset no client loads is not shared`
      );
    }
  }
});

/* ----------------------------------------------------------- manifest shape */

for (const name of packageNames) {
  test(`packages/${name} declares no runtime dependencies`, () => {
    const manifest = JSON.parse(
      readFileSync(join(packagesDir, name, "package.json"), "utf8")
    );
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
    assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}), []);
    assert.equal(manifest.type, "module");
  });

  test(`packages/${name} does not inherit the app's tsconfig`, (t) => {
    // CSS-only packages have no tsconfig to inherit anything; their boundary
    // is checked by the CSS rules above.
    if (!existsSync(join(packagesDir, name, "tsconfig.json"))) {
      t.skip("no TypeScript in this package");
      return;
    }
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
