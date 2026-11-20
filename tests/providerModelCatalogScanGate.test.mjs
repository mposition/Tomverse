import assert from "node:assert/strict";
import { test } from "node:test";

import { providerModelCatalogScanRuns } from "../lib/providerModelCatalogScanGate.ts";

test("the daily scan runs in production only", () => {
  assert.equal(providerModelCatalogScanRuns({ test: false }, { APP_ENV: "production" }), true);
  assert.equal(
    providerModelCatalogScanRuns({ test: false }, { RAILWAY_ENVIRONMENT_NAME: "production" }),
    true
  );
  for (const name of ["staging", "dev"]) {
    assert.equal(
      providerModelCatalogScanRuns({ test: false }, { RAILWAY_ENVIRONMENT_NAME: name, NODE_ENV: "production" }),
      false,
      name
    );
  }
  assert.equal(providerModelCatalogScanRuns({ test: false }, { NODE_ENV: "development" }), false);
});

test("a manual test run still goes through in a lower environment", () => {
  assert.equal(
    providerModelCatalogScanRuns({ test: true }, { RAILWAY_ENVIRONMENT_NAME: "staging" }),
    true
  );
});
