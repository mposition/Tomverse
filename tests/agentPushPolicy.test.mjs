import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { decideTier, policyNamedTestPaths } from "../lib/agentPushPolicy.ts";

const change = (overrides = {}) => ({
  path: "lib/chatInput.ts",
  status: "modified",
  oldMode: "100644",
  newMode: "100644",
  newType: "blob",
  sizeBytes: 1200,
  isText: true,
  addedLines: 3,
  removedLines: 1,
  addedText: "const x = 1;\n",
  newText: "export const y = 0;\nconst x = 1;\n",
  ...overrides,
});

const clean = (changes, overrides = {}) => ({
  changes,
  policyNamedTests: new Set(),
  credential: { status: "analysed", forbidsAll: false, forbiddenPaths: new Set() },
  slice: { status: "analysed", slicePaths: new Set() },
  ...overrides,
});

const reasons = (verdict) => verdict.findings.map((finding) => finding.reason);

test("an ordinary product change with every analysis clean is T1", () => {
  assert.deepEqual(decideTier(clean([change()])), { tier: "T1", findings: [] });
});

test("an empty change set is not T1", () => {
  assert.deepEqual(reasons(decideTier(clean([]))), ["empty_change"]);
});

test("control-plane paths are T2", () => {
  assert.ok(
    reasons(decideTier(clean([change({ path: "lib/amux/guard.ts" })]))).includes(
      "control_plane_path",
    ),
  );
  for (const path of [
    "lib/chatUnifiedOptimizerAmuxCandidateStore.ts",
    "lib/chatUnifiedOptimizerAmuxSourcePin.ts",
    "tests/chatUnifiedOptimizerAmuxCandidateStore.test.mjs",
    "tests/chatUnifiedOptimizerAmuxSourcePin.test.mjs",
  ]) {
    const verdict = decideTier(clean([change({ path })]));
    assert.equal(verdict.tier, "T2", path);
    assert.ok(reasons(verdict).includes("control_plane_path"), path);
  }
});

// Owner decision 2026-11-16: path and file shape no longer move a change to
// T2; money, secrets and the control plane do.
test("an unclassified path or a new top-level directory is T1 when nothing else objects", () => {
  for (const path of ["public/robots.txt", "newdir/x.ts", "pages/api/x.ts", "vendor/lib/x.js"]) {
    assert.deepEqual(decideTier(clean([change({ path, status: "added", oldMode: null })])),
      { tier: "T1", findings: [] }, path);
  }
  // A root-level file and a root dot-directory are still control plane.
  assert.ok(reasons(decideTier(clean([change({ path: "next.config.ts" })]))).includes("control_plane_path"));
  assert.ok(reasons(decideTier(clean([change({ path: ".husky/pre-push" })]))).includes("control_plane_path"));
});

test("a rename is judged on both of its paths", () => {
  const verdict = decideTier(
    clean([
      change({ path: "lib/renamed.ts", previousPath: "lib/modelPricing.ts", status: "renamed" }),
    ]),
  );
  assert.equal(verdict.tier, "T2");
  assert.ok(
    verdict.findings.some(
      (finding) => finding.reason === "control_plane_path" && finding.path === "lib/modelPricing.ts",
    ),
  );
});

test("symlinks, submodules and non-blob objects are T2", () => {
  const cases = [
    [{ newMode: "120000" }, "symlink"],
    [{ oldMode: "120000", newMode: "100644" }, "symlink"],
    [{ newMode: "160000", newType: "commit" }, "gitlink"],
    [{ newMode: "040000", newType: "tree" }, "not_a_blob"],
    [{ newMode: "100664" }, "not_a_blob"],
  ];
  for (const [overrides, reason] of cases) {
    assert.ok(reasons(decideTier(clean([change(overrides)]))).includes(reason), reason);
  }
});

test("a binary file and an executable bit are T1 when nothing else objects", () => {
  for (const overrides of [
    { isText: false, addedText: "", newText: "" },
    { newMode: "100755" },
    { oldMode: "100755", newMode: "100644" },
  ]) {
    assert.deepEqual(decideTier(clean([change(overrides)])), { tier: "T1", findings: [] },
      JSON.stringify(overrides));
  }
});

// Owner decision 2026-11-15: an internal development flow carries no size,
// count or extension rule; paths and content decide the tier.
test("no file type, count or size moves a change to T2 by itself", () => {
  for (const path of ["lib/data.yaml", "lib/Makefile", "lib/data.json",
    "lib/amux/report.sql", "docs/notes.txt", "tests/fixtures/x.json"]) {
    const verdict = decideTier(clean([change({ path })]));
    assert.ok(!reasons(verdict).some((reason) =>
      /extension|json_outside|too_many|too_large/.test(reason)), path);
  }
  assert.equal(decideTier(clean([change({ path: "lib/data.yaml" })])).tier, "T1");
  const many = Array.from({ length: 300 }, (_, i) =>
    change({ path: `lib/a${i}.ts`, addedLines: 400, removedLines: 400 }));
  assert.deepEqual(decideTier(clean(many)), { tier: "T1", findings: [] });
  assert.deepEqual(decideTier(clean([change({ sizeBytes: 534 * 1024 })])),
    { tier: "T1", findings: [] });
  // AMUX's own paths stay T2 for being control plane, not for their size.
  const amux = decideTier(clean([change({ path: "lib/amux/big.ts", sizeBytes: 534 * 1024 })]));
  assert.deepEqual(reasons(amux), ["control_plane_path"]);
});

test("what tree verification does not support is a T2 finding, never silence", () => {
  const verdict = decideTier({ ...clean([change()]), unsupported: [
    { reason: "gitattributes_applies", path: "lib/a.ts" }] });
  assert.deepEqual(verdict, { tier: "T2", findings: [{
    reason: "unsupported_tree_change", path: "lib/a.ts",
    detail: "gitattributes_applies" }] });
});

test("a new framework entry file is judged by its path like any other", () => {
  for (const path of [
    "app/(site)/new/page.tsx",
    "app/(site)/layout.tsx",
    "lib/tool.config.ts",
    "app/not-found.tsx",
    "app/robots.ts",
  ]) {
    assert.deepEqual(decideTier(clean([change({ path, status: "added", oldMode: null })])),
      { tier: "T1", findings: [] }, path);
  }
  // A new route under the admin or internal API is control plane by its path.
  for (const path of ["app/api/admin/new/route.ts", "app/api/internal/new/route.ts"]) {
    assert.ok(reasons(decideTier(clean([change({ path, status: "added", oldMode: null })])))
      .includes("control_plane_path"), path);
  }
});

test("code that loads at run time is judged by the slice, not by its text", () => {
  for (const newText of [
    "const m = await import(name);",
    "const m = require(path);",
    "for (const f of readdirSync(dir)) {}",
    "import.meta.glob('./*.ts')",
    "eval(code)",
  ]) {
    assert.deepEqual(decideTier(clean([change({ newText })])), { tier: "T1", findings: [] }, newText);
  }
});

test("a reserved decision value outside the control-plane files still raises the alarm", () => {
  assert.ok(
    reasons(decideTier(clean([change({ addedText: "creditWeight: 4," })]))).includes(
      "decision_value_alarm",
    ),
  );
});

test("tests the policy documents name cannot be changed at T1; a policy-sounding name alone can", () => {
  assert.ok(
    reasons(
      decideTier(
        clean([change({ path: "tests/chatInput.test.mjs" })], {
          policyNamedTests: new Set(["tests/chatInput.test.mjs"]),
        }),
      ),
    ).includes("policy_named_test"),
  );
  assert.deepEqual(decideTier(clean([change({ path: "tests/fooContract.test.mjs" })])),
    { tier: "T1", findings: [] });
});

test("the policy documents' named tests are found in the real tree", () => {
  const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
  const machineIndex = readFileSync(new URL("../docs/agents/machine-index.md", import.meta.url), "utf8");
  const named = policyNamedTestPaths([agents, machineIndex]);
  assert.ok(named.has("tests/typographyPolicy.test.mjs"));
  assert.ok(named.has("tests/e2e/mobile-short-viewport-drawer.spec.ts"));
});

test("credential reachability forbids its paths, and a failed analysis forbids everything", () => {
  const forbidden = clean([change({ path: "lib/creditLedger.ts" })], {
    credential: {
      status: "analysed",
      forbidsAll: false,
      forbiddenPaths: new Set(["lib/creditLedger.ts"]),
    },
  });
  assert.ok(reasons(decideTier(forbidden)).includes("credential_reachable"));
  assert.ok(
    reasons(
      decideTier(
        clean([change()], {
          credential: { status: "analysed", forbidsAll: true, forbiddenPaths: new Set() },
        }),
      ),
    ).includes("credential_reachable"),
  );
  assert.ok(
    reasons(decideTier(clean([change()], { credential: { status: "failed" } }))).includes(
      "credential_analysis_failed",
    ),
  );
});

test("a slice hit is T2, and a slice analysis failure fails the whole patch", () => {
  assert.ok(
    reasons(
      decideTier(
        clean([change()], {
          slice: { status: "analysed", slicePaths: new Set(["lib/chatInput.ts"]) },
        }),
      ),
    ).includes("control_plane_slice"),
  );
  assert.ok(
    reasons(decideTier(clean([change()], { slice: { status: "failed" } }))).includes(
      "slice_analysis_failed",
    ),
  );
});

test("moving or copying a slice member to a fresh product path is still a slice change", () => {
  const slice = { status: "analysed", slicePaths: new Set(["lib/productBridge.ts"]) };
  for (const status of ["renamed", "copied"]) {
    const verdict = decideTier(
      clean(
        [
          change({
            path: "lib/helpers/productBridge.ts",
            previousPath: "lib/productBridge.ts",
            status,
          }),
        ],
        { slice },
      ),
    );
    assert.ok(
      verdict.findings.some(
        (finding) =>
          finding.reason === "control_plane_slice" && finding.path === "lib/productBridge.ts",
      ),
      status,
    );
  }
  // Deleting a slice member is a change to it too.
  assert.ok(
    reasons(
      decideTier(
        clean([change({ path: "lib/productBridge.ts", status: "deleted", newType: null, newMode: null, newText: "" })], {
          slice,
        }),
      ),
    ).includes("control_plane_slice"),
  );
});
