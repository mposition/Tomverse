import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PROMPT_REFINER_PRODUCT_LIMITED_DARK_ACCESS,
  PROMPT_REFINER_PRODUCT_RECORD_EXPORTS,
  PROMPT_REFINER_PRODUCT_SELECTIVE_OMITTED_RUNTIME_SOURCES,
  promptRefinerProductLimitedDarkAccessPermitted,
  promptRefinerProductMixedExportImportProblems,
  promptRefinerProductSelectiveReleaseProblems,
} from "../scripts/prompt-refiner-product-limited-dark-access.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("product release evidence has exactly five hash-bound dark read pairs", () => {
  const pairs = PROMPT_REFINER_PRODUCT_LIMITED_DARK_ACCESS.flatMap((entry) =>
    entry.tables.map((table) => ({ entry, table })));
  assert.equal(pairs.length, 5);
  for (const { entry, table } of pairs) {
    assert.equal(promptRefinerProductLimitedDarkAccessPermitted({
      file: entry.file,
      table,
      source: read(entry.file),
    }), true, `${entry.file} -> ${table}`);
  }
});

test("the limited grant rejects other paths, tables and changed reviewed bytes", () => {
  const entry = PROMPT_REFINER_PRODUCT_LIMITED_DARK_ACCESS[0];
  const source = read(entry.file);
  assert.equal(promptRefinerProductLimitedDarkAccessPermitted({
    file: "lib/unlistedPromptRefinerReader.ts",
    table: "PromptRefinerVnextOneShotStage",
    source,
  }), null);
  assert.equal(promptRefinerProductLimitedDarkAccessPermitted({
    file: entry.file,
    table: "ModelDeployment",
    source,
  }), false);
  assert.equal(promptRefinerProductLimitedDarkAccessPermitted({
    file: entry.file,
    table: entry.tables[0],
    source: `${source}\nvoid tx.promptRefinerVnextOneShotStage.update({});\n`,
  }), false);
});

test("mixed evidence modules expose only reviewed read imports to runtime callers", () => {
  const inspect = (source) => promptRefinerProductMixedExportImportProblems({
    file: "app/api/example/route.ts",
    source,
  });
  assert.deepEqual(inspect(
    'import { readPromptRefinerVnextOneShotGateEvidence as read } from "@/lib/promptRefinerVnextOneShotGateEvidence";'
  ), []);
  assert.deepEqual(PROMPT_REFINER_PRODUCT_RECORD_EXPORTS, [
    "recordPromptRefinerVnextOneShotDisposition",
    "recordPromptRefinerVnextOneShotGateEvidence",
    "recordPromptRefinerVnextOneShotOperationalShadow",
    "recordPromptRefinerVnextOneShotTerminal",
  ]);
  for (const source of [
    'import { recordPromptRefinerVnextOneShotGateEvidence } from "@/lib/promptRefinerVnextOneShotGateEvidence";',
    'import { recordPromptRefinerVnextOneShotGateEvidence as write } from "@/lib/promptRefinerVnextOneShotGateEvidence";',
    'import * as evidence from "@/lib/promptRefinerVnextOneShotGateEvidence";',
    'const evidence = await import("@/lib/promptRefinerVnextOneShotGateEvidence");',
    'const modulePath = "@/lib/promptRefinerVnextOneShotTerminalReceipt"; const evidence = await import(modulePath);',
    'const evidence = require("@/lib/promptRefinerVnextOneShotGateEvidence");',
    'export * from "@/lib/promptRefinerVnextOneShotGateEvidence";',
  ]) {
    assert.equal(inspect(source).length, 1, source);
  }
});

test("selective release inventory fixtures distinguish omitted and installed lifecycle sources", () => {
  assert.equal(PROMPT_REFINER_PRODUCT_SELECTIVE_OMITTED_RUNTIME_SOURCES.length, 15);
  const retained = new Map([["app/api/chat/route.ts", "export const POST = () => null;"]]);
  assert.deepEqual(promptRefinerProductSelectiveReleaseProblems(retained), []);
  const installed = new Map(retained);
  const path = PROMPT_REFINER_PRODUCT_SELECTIVE_OMITTED_RUNTIME_SOURCES[0];
  installed.set(path, "export const POST = () => null;");
  assert.deepEqual(promptRefinerProductSelectiveReleaseProblems(installed), [
    `${path}: lifecycle source is present in the selective release`,
  ]);
});
