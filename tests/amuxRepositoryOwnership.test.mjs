import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

const authoritativeRoots = [
  "crates/amux-core/Cargo.toml",
  "apps/tomverse-orchestrator/Cargo.toml",
  "lib/amux/index.ts",
  "app/api/internal/amux/health/route.ts",
  "docs/policy/development-agent-orchestration.md",
  "docs/ops/amux/reference-baseline.md",
  "docs/ops/amux/local-branch-migration.md",
  "docs/ops/amux/architecture.md",
  "docs/ops/amux/staging.md",
  "docs/ops/amux/recovery.md",
  "docs/ops/amux/verification/README.md",
];

for (const path of authoritativeRoots) {
  test(`Tomverse owns ${path}`, () => {
    assert.ok(existsSync(join(root, path)), `${path} is missing`);
  });
}

test("the Rust core stays outside the npm shared-package namespace", () => {
  assert.equal(
    existsSync(join(root, "packages/amux-core")),
    false,
    "packages/* is the PACKAGE-01 npm/Vite boundary; Rust crates belong in crates/*"
  );

  const workspace = read("Cargo.toml");
  assert.match(workspace, /"crates\/amux-core"/);
  assert.doesNotMatch(workspace, /"packages\/amux-core"/);

  const orchestrator = read("apps/tomverse-orchestrator/Cargo.toml");
  assert.match(orchestrator, /path\s*=\s*"\.\.\/\.\.\/crates\/amux-core"/);
});

test("the frozen reference identity remains explicit and non-authoritative", () => {
  const baseline = read("docs/ops/amux/reference-baseline.md");
  assert.match(
    baseline,
    /83835d5209b110a9497d81246c07f284372ee61c/
  );
  assert.match(
    baseline,
    /84406dd5e68155d7b2ed28e9f9e7a6294d6a4689642c8f5f55cb94f38a3c7de0/
  );
  assert.match(baseline, /FROZEN_COMPLETE/);
  assert.match(baseline, /mposition\/Tomverse/);
});
