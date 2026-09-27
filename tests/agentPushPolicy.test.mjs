import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CONVENTION_VERSIONS } from "../lib/agentAuthorityFiles.ts";
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
  ...overrides,
});

const clean = (changes, overrides = {}) => ({
  changes,
  policyNamedTests: new Set(),
  installedVersions: { ...CONVENTION_VERSIONS },
  credential: { status: "analysed", forbidsAll: false, forbiddenPaths: new Set() },
  slice: { status: "analysed", touchedPaths: new Set() },
  ...overrides,
});

const reasons = (verdict) => verdict.findings.map((finding) => finding.reason);

test("an ordinary product change with every analysis clean is T1", () => {
  assert.deepEqual(decideTier(clean([change()])), { tier: "T1", findings: [] });
});

test("an empty change set is not T1", () => {
  assert.deepEqual(reasons(decideTier(clean([]))), ["empty_change"]);
});

test("control-plane, unclassified and unknown top-level paths are T2", () => {
  assert.ok(
    reasons(decideTier(clean([change({ path: "lib/amux/guard.ts" })]))).includes(
      "control_plane_path",
    ),
  );
  assert.ok(
    reasons(decideTier(clean([change({ path: "public/robots.txt" })]))).includes(
      "unclassified_path",
    ),
  );
  const unknown = reasons(decideTier(clean([change({ path: "newdir/x.ts", status: "added" })])));
  assert.ok(unknown.includes("unknown_top_level_directory"));
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

test("non-text, symlinks, submodules and executable bits are T2", () => {
  const cases = [
    [{ isText: false }, "not_text"],
    [{ newMode: "120000" }, "symlink"],
    [{ oldMode: "120000", newMode: "100644" }, "symlink"],
    [{ newMode: "160000", newType: "commit" }, "gitlink"],
    [{ newMode: "100755" }, "executable_bit"],
    [{ oldMode: "100755", newMode: "100644" }, "executable_bit"],
    [{ newMode: "040000", newType: "tree" }, "not_a_blob"],
    [{ newMode: "100664" }, "not_a_blob"],
  ];
  for (const [overrides, reason] of cases) {
    assert.ok(reasons(decideTier(clean([change(overrides)]))).includes(reason), reason);
  }
});

test("only the T1 file types, and JSON only as locale or fixture data", () => {
  assert.ok(
    reasons(decideTier(clean([change({ path: "lib/data.yaml" })]))).includes(
      "extension_not_allowed",
    ),
  );
  assert.ok(
    reasons(decideTier(clean([change({ path: "lib/Makefile" })]))).includes(
      "extension_not_allowed",
    ),
  );
  assert.ok(
    reasons(decideTier(clean([change({ path: "lib/data.json" })]))).includes(
      "json_outside_data_paths",
    ),
  );
  assert.equal(decideTier(clean([change({ path: "tests/fixtures/x.json" })])).tier, "T1");
});

test("the size limits hold at their edges", () => {
  const five = Array.from({ length: 5 }, (_, i) => change({ path: `lib/a${i}.ts`, addedLines: 60, removedLines: 0 }));
  assert.equal(decideTier(clean(five)).tier, "T1");
  const six = [...five, change({ path: "lib/a5.ts", addedLines: 0, removedLines: 0 })];
  assert.ok(reasons(decideTier(clean(six))).includes("too_many_files"));
  const lines = [change({ addedLines: 301, removedLines: 0 })];
  assert.ok(reasons(decideTier(clean(lines))).includes("too_many_lines"));
  assert.ok(
    reasons(decideTier(clean([change({ sizeBytes: 200 * 1024 + 1 })]))).includes(
      "file_too_large",
    ),
  );
});

test("a new file at a framework entry convention is T2; editing an existing one is judged by path", () => {
  for (const path of [
    "app/(site)/new/page.tsx",
    "app/api/new/route.ts",
    "app/(site)/layout.tsx",
    "lib/tool.config.ts",
    "app/not-found.tsx",
    "app/robots.ts",
  ]) {
    assert.ok(
      reasons(decideTier(clean([change({ path, status: "added" })]))).includes("entry_convention"),
      path,
    );
  }
  assert.equal(
    decideTier(clean([change({ path: "app/(site)/pricing/page.tsx", status: "modified" })])).tier,
    "T1",
  );
});

test("code that assembles what it loads is T2", () => {
  const samples = [
    "const m = await import(name);",
    "const m = await import(`./${name}.ts`);",
    "const m = require(path);",
    "require.resolve('x')",
    "import.meta.glob('./*.ts')",
    "const r = createRequire(import.meta.url);",
    "for (const f of readdirSync(dir)) {}",
    "new Function('return 1')",
    "eval(code)",
  ];
  for (const addedText of samples) {
    assert.ok(
      reasons(decideTier(clean([change({ addedText })]))).includes("runtime_discovery"),
      addedText,
    );
  }
  for (const addedText of ['const m = await import("./x.ts");', "const m = require('x');"]) {
    assert.equal(decideTier(clean([change({ addedText })])).tier, "T1", addedText);
  }
});

test("a reserved decision value outside the control-plane files still raises the alarm", () => {
  assert.ok(
    reasons(decideTier(clean([change({ addedText: "creditWeight: 4," })]))).includes(
      "decision_value_alarm",
    ),
  );
});

test("policy-named and policy-titled tests cannot be changed at T1", () => {
  assert.ok(
    reasons(
      decideTier(
        clean([change({ path: "tests/chatInput.test.mjs" })], {
          policyNamedTests: new Set(["tests/chatInput.test.mjs"]),
        }),
      ),
    ).includes("policy_named_test"),
  );
  assert.ok(
    reasons(decideTier(clean([change({ path: "tests/fooContract.test.mjs" })]))).includes(
      "policy_test_name",
    ),
  );
});

test("the policy documents' named tests are found in the real tree", () => {
  const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
  const named = policyNamedTestPaths([agents]);
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
          slice: { status: "analysed", touchedPaths: new Set(["lib/chatInput.ts"]) },
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

test("an installed version that differs from the recorded one is T2", () => {
  const verdict = decideTier(
    clean([change()], { installedVersions: { ...CONVENTION_VERSIONS, next: "17.0.0" } }),
  );
  assert.ok(reasons(verdict).includes("convention_version_mismatch"));
  const missing = decideTier(
    clean([change()], { installedVersions: { ...CONVENTION_VERSIONS, typescript: null } }),
  );
  assert.ok(reasons(missing).includes("convention_version_mismatch"));
});
