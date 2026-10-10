import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PROMPT_REFINER_PRODUCT_LIMITED_DARK_ACCESS,
  PROMPT_REFINER_PRODUCT_RECORD_EXPORTS,
  PROMPT_REFINER_PRODUCT_SELECTIVE_OMITTED_RUNTIME_SOURCES,
  PROMPT_REFINER_PRODUCT_TRANSITIVE_READ_EDGES,
  promptRefinerProductLimitedDarkAccessConfigurationProblems,
  promptRefinerProductLimitedDarkAccessPermitted,
  promptRefinerProductMixedExportImportProblems,
  promptRefinerProductReleaseStoreControlledImportProblems,
  promptRefinerProductSelectiveReleaseProblems,
  promptRefinerProductTransitiveReadEdgeProblems,
} from "../scripts/prompt-refiner-product-limited-dark-access.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const productRuntimeFixture = () => new Map(
  [...new Set(PROMPT_REFINER_PRODUCT_TRANSITIVE_READ_EDGES.flatMap(
    (edge) => [edge.importer, edge.target]
  ))].map((path) => [path, read(path)])
);

test("product release evidence has exactly ten hash-bound dark read pairs", () => {
  const pairs = PROMPT_REFINER_PRODUCT_LIMITED_DARK_ACCESS.flatMap((entry) =>
    entry.tables.map((table) => ({ entry, table })));
  assert.equal(PROMPT_REFINER_PRODUCT_LIMITED_DARK_ACCESS.length, 6);
  assert.equal(pairs.length, 10);
  assert.equal(PROMPT_REFINER_PRODUCT_TRANSITIVE_READ_EDGES.length, 7);
  assert.deepEqual(promptRefinerProductLimitedDarkAccessConfigurationProblems(), []);
  for (const { entry, table } of pairs) {
    assert.equal(promptRefinerProductLimitedDarkAccessPermitted({
      file: entry.file,
      table,
      source: read(entry.file),
    }), true, `${entry.file} -> ${table}`);
  }
});

test("the exact grant rejects a seventh source, source/table and edge drift", () => {
  const entries = PROMPT_REFINER_PRODUCT_LIMITED_DARK_ACCESS;
  const seventh = [...entries, Object.freeze({
    file: "lib/seventhPromptRefinerStageReader.ts",
    sha256: "f".repeat(64),
    tables: Object.freeze(["PromptRefinerVnextOneShotStage"]),
  })];
  assert.match(promptRefinerProductLimitedDarkAccessConfigurationProblems(seventh)[0],
    /expected 6 reviewed sources/);
  const drifted = entries.map((entry, index) => index === 0
    ? { ...entry, tables: ["PromptRefinerVnextOneShotSlot"] }
    : entry);
  assert.match(promptRefinerProductLimitedDarkAccessConfigurationProblems(drifted)[0],
    /exact ten-pair grant/);
  const driftedEdges = PROMPT_REFINER_PRODUCT_TRANSITIVE_READ_EDGES.map(
    (edge, index) => index === 0
      ? { ...edge, reads: ["readUnreviewedStageSnapshot"] }
      : edge
  );
  assert.match(promptRefinerProductLimitedDarkAccessConfigurationProblems(
    entries, driftedEdges)[0], /exact seven-edge chain/);
});

test("product admission keeps the exact named transitive pure-read edges", () => {
  const runtime = productRuntimeFixture();
  assert.deepEqual(promptRefinerProductTransitiveReadEdgeProblems(runtime), []);

  const missingRead = new Map(runtime);
  missingRead.set("lib/promptRefinerVnextOneShotGateEvidence.ts",
    missingRead.get("lib/promptRefinerVnextOneShotGateEvidence.ts").replace(
      "readPromptRefinerVnextOneShotStage } from",
      "readUnreviewedPromptRefinerStage } from"
    ));
  assert.match(promptRefinerProductTransitiveReadEdgeProblems(missingRead)[0],
    /missing readPromptRefinerVnextOneShotStage/);

  const absentTarget = new Map(runtime);
  absentTarget.delete("lib/promptRefinerVnextOneShotOutcomeRecovery.ts");
  assert.match(promptRefinerProductTransitiveReadEdgeProblems(absentTarget)[0],
    /product read-edge target is absent/);
});

test("the mutable product root cannot add another controlled reader edge", () => {
  assert.deepEqual(promptRefinerProductReleaseStoreControlledImportProblems(`
    import { readPromptRefinerProductStageSnapshot as stage } from
      "@/lib/promptRefinerProductStageSnapshot";
    import {
      readPromptRefinerVnextOneShotDisposition as disposition,
      readPromptRefinerVnextOneShotGateEvidence as gate,
    } from "@/lib/promptRefinerVnextOneShotGateEvidence";
    void stage; void disposition; void gate;
  `), []);

  const releaseStore = read("lib/promptRefinerProductReleaseStore.ts");
  for (const source of [
    'import { readPromptRefinerVnextOneShotStage } from "@/lib/promptRefinerVnextOneShotStageReadback";',
    'import { lockAndReadPromptRefinerVnextOneShotStage } from "@/lib/promptRefinerVnextOneShotStageReadback";',
    'import { verifyPromptRefinerVnextOneShotConsumedRequest } from "@/lib/promptRefinerVnextOneShotOutcomeRecovery";',
    'import { stopPromptRefinerVnextOneShotUnknown } from "@/lib/promptRefinerVnextOneShotOutcomeRecovery";',
    'import { recordPromptRefinerVnextOneShotGateEvidence } from "@/lib/promptRefinerVnextOneShotGateEvidence";',
    'import type { readPromptRefinerProductStageSnapshot } from "@/lib/promptRefinerProductStageSnapshot";',
    'import * as stage from "@/lib/promptRefinerVnextOneShotStageReadback";',
    'const recovery = await import("@/lib/promptRefinerVnextOneShotOutcomeRecovery");',
    'const stagePath = "@/lib/promptRefinerVnextOneShotStageReadback"; const stageDynamic = await import(stagePath);',
    'const stage = require("@/lib/promptRefinerVnextOneShotStageReadback");',
    'export { readPromptRefinerVnextOneShotStage } from "@/lib/promptRefinerVnextOneShotStageReadback";',
    'import stage = require("@/lib/promptRefinerVnextOneShotStageReadback");',
  ]) {
    const problems = promptRefinerProductReleaseStoreControlledImportProblems(
      `${releaseStore}\n${source}`
    );
    assert.equal(problems.length, 1, `${source}\n${problems.join("\n")}`);
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
  assert.deepEqual(promptRefinerProductMixedExportImportProblems({
    file: "lib/promptRefinerProductReleaseStore.ts",
    source: 'import { readPromptRefinerProductStageSnapshot } from "@/lib/promptRefinerProductStageSnapshot";',
  }), []);
  assert.match(promptRefinerProductMixedExportImportProblems({
    file: "app/api/example/route.ts",
    source: 'import { readPromptRefinerProductStageSnapshot } from "@/lib/promptRefinerProductStageSnapshot";',
  })[0], /not an approved caller/);
  for (const source of [
    'import * as snapshot from "@/lib/promptRefinerProductStageSnapshot";',
    'const snapshot = await import("@/lib/promptRefinerProductStageSnapshot");',
    'const snapshot = require("@/lib/promptRefinerProductStageSnapshot");',
    'export { readPromptRefinerProductStageSnapshot } from "@/lib/promptRefinerProductStageSnapshot";',
  ]) {
    assert.equal(promptRefinerProductMixedExportImportProblems({
      file: "lib/promptRefinerProductReleaseStore.ts",
      source,
    }).length, 1, source);
  }
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
  const retained = productRuntimeFixture();
  retained.set("app/api/chat/route.ts", "export const POST = () => null;");
  assert.deepEqual(promptRefinerProductSelectiveReleaseProblems(retained), []);
  const installed = new Map(retained);
  const path = PROMPT_REFINER_PRODUCT_SELECTIVE_OMITTED_RUNTIME_SOURCES[0];
  installed.set(path, "export const POST = () => null;");
  assert.deepEqual(promptRefinerProductSelectiveReleaseProblems(installed), [
    `${path}: lifecycle source is present in the selective release`,
  ]);
});
