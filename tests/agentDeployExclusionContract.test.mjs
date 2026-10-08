import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import ts from "typescript";

import { DEPLOY_EXCLUDED_PREFIXES } from
  "../lib/agentControlPlaneSlice.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePaths = execFileSync("git", ["ls-files", "app", "lib", "packages"],
  { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/)
  .filter((path) => /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path));
const fileCalls = new Set(["readFile", "readFileSync", "createReadStream",
  "open", "stat", "lstat", "access", "readdir", "existsSync"]);

test("deploy source exclusion includes only pinned vNext test sources", () => {
  const patterns = readFileSync(join(root, ".dockerignore"), "utf8")
    .split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const closure = JSON.parse(readFileSync(join(root,
    "docs/ops/prompt-refiner-quality-evaluation-vnext-candidate-source-closure.json"),
  "utf8"));
  const pinnedTests = Object.keys(closure.files).filter((path) =>
    path.startsWith("tests/")).sort();
  const oneShot = JSON.parse(readFileSync(join(root,
    "docs/ops/prompt-refiner-quality-evaluation-vnext-one-shot-candidate-source.json"),
  "utf8"));
  const oneShotPaths = Object.keys(oneShot.files).sort();
  const readerPath = join(root,
    "lib/promptRefinerVnextOneShotCandidateSourceReadback.ts");
  const reader = ts.createSourceFile(readerPath, readFileSync(readerPath, "utf8"),
    ts.ScriptTarget.Latest, true);
  let runtimePaths = null;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.name.text === "SOURCE_PATHS" && node.initializer &&
        ts.isCallExpression(node.initializer)) {
      const argument = node.initializer.arguments[0];
      const array = ts.isAsExpression(argument) ? argument.expression : argument;
      if (ts.isArrayLiteralExpression(array)) {
        runtimePaths = array.elements.map((element) =>
          ts.isStringLiteral(element) ? element.text : null);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(reader);
  assert.ok(runtimePaths?.every((path) => typeof path === "string"));
  assert.deepEqual(runtimePaths.sort(), oneShotPaths);
  assert.deepEqual(oneShotPaths.filter((path) => path.startsWith("tests/")),
    pinnedTests);
  assert.deepEqual(pinnedTests, [
    "tests/promptRefinerQualityEvaluationVnextCandidate.test.mjs",
    "tests/promptRefinerQualityEvaluationVnextDevelopment.test.mjs",
  ]);
  assert.deepEqual(patterns, ["tests/*", ...pinnedTests.map((path) =>
    `!${path}`), "playwright.admin.config.ts"]);
  assert.deepEqual([...DEPLOY_EXCLUDED_PREFIXES], []);
  // This live route reads committed verification records by path.
  assert.match(readFileSync(join(root,
    "lib/marketingWebhookVerification.ts"), "utf8"),
  /readFile\(path\.join\(process\.cwd\(\), relative\)/);
});

test("app runtime has no literal filesystem opens under tests", () => {
  const offenders = [];
  for (const path of sourcePaths) {
    const source = ts.createSourceFile(path,
      readFileSync(join(root, path), "utf8"), ts.ScriptTarget.Latest, false);
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text :
          ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
        if (fileCalls.has(name) && node.arguments.length > 0) {
          const first = node.arguments[0];
          const literals = [];
          const collect = (part) => {
            if (ts.isStringLiteral(part) ||
                ts.isNoSubstitutionTemplateLiteral(part))
              literals.push(part.text);
            ts.forEachChild(part, collect);
          };
          collect(first);
          if (literals.some((value) =>
            /^(?:\.\.?\/)*tests(?:\/|$)/.test(value)))
            offenders.push(`${path}:${source.getLineAndCharacterOfPosition(
              node.getStart(source)).line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(offenders, []);
});
