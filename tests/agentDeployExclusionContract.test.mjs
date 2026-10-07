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

test("deploy source exclusion remains narrow and grants no T1 before image proof", () => {
  const patterns = readFileSync(join(root, ".dockerignore"), "utf8")
    .split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(patterns, ["tests/", "playwright.admin.config.ts"]);
  assert.deepEqual([...DEPLOY_EXCLUDED_PREFIXES], []);
  // This live route reads committed verification records by path.
  assert.match(readFileSync(join(root,
    "lib/marketingWebhookVerification.ts"), "utf8"),
  /readFile\(path\.join\(process\.cwd\(\), relative\)/);
});

test("app runtime does not directly open excluded test source paths", () => {
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
