import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The v22 one-shot catalog. It was the TOMVERSE_AMUX_V22_WORKER_CATALOG_JSON
// variable overlaid on the legacy catalog until R2c; since R2c it is the v22
// profiles of the catalog derived from the registry, and R2e removed the
// variable and its parser (orchestration policy version 35, section 5). The
// profile rules the parser held -- Claude only, a supported model, each
// role's required tool -- are the capability write rule's
// (tests/amuxWorkerCapabilityCore.test.mjs) and the capability table's CHECK.

test("Task readiness, promotion capacity and claim use the same separated catalog", () => {
  for (const path of ["lib/amux/v4TaskReadyService.ts", "lib/amux/v22AutoPromotionService.ts",
    "lib/amux/v22WorkerClaimService.ts"]) {
    const source = readFileSync(path, "utf8");
    // Version 35, section 3: each reads the assignment catalog in its own
    // transaction.
    assert.match(source,
      /const \{ v22: \w+(?:, ceilings)? \} = await readAmuxAssignmentCatalogs\(tx\);/);
    assert.doesNotMatch(source, /getConfiguredAmuxWorkerCatalog\(\)|getConfiguredAmuxV22WorkerCatalog\(\)|WORKER_CATALOG_JSON/);
  }
  // The variables' parser is gone with the variables (R2e), and routing.ts no
  // longer re-exports it.
  assert.doesNotMatch(readFileSync("lib/amux/routing.ts", "utf8"),
    /workerCatalogVariables|getConfiguredAmux(V22)?WorkerCatalog/);
});

test("v48: readiness counts compatible workers whenever the cost is known, not only when it is allowed", () => {
  const source = readFileSync("lib/amux/v4TaskReadyService.ts", "utf8");
  // A cost that needs reconfirmation must not also read as "no worker": the
  // FIRST Task final consent stands in for exactly that one reconfirmation.
  assert.match(source, /if \(cost !== "hold"\) \{[\s\S]{0,400}?readAmuxAssignmentCatalogs\(tx\)/);
  assert.doesNotMatch(source, /if \(cost === "allow"\) \{/);
});
