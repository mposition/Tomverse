import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { createTypecheckPlan, runBoundedTypecheck } from "../scripts/typecheck-bounded.mjs";

const fixture = t => {
  const base = resolve(tmpdir());
  const dir = mkdtempSync(join(base, "typecheck-bounded-test-"));
  t.after(() => {
    assert.ok(resolve(dir).startsWith(base + sep));
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(join(dir, ".next", "types"), { recursive: true });
  const write = (path, text) => writeFileSync(join(dir, path), text);
  write("globals.ts", "interface SharedScope { name: string }\n");
  write("deadline.ts", "export type Deadline = number;\n");
  write("augment.ts", 'import type { Deadline } from "./deadline.js"; type DeadlineValue = Deadline; export {}; declare global { interface SharedScope { deadline: DeadlineValue } }\n');
  write("first.ts", 'export const first: SharedScope = { name: "Atlas", deadline: 28 };\n');
  write("last.ts", 'export const last: SharedScope = { name: "Vega", deadline: 15 };\n');
  write(".next/types/validator.ts", `// This file is generated automatically by Next.js
export {};
type Expected<T extends { first?: SharedScope; last?: SharedScope }> = T;
{ type Check = Expected<typeof import("../../first.js")>; }
{ type Check = Expected<typeof import("../../last.js")>; }
`);
  write("tsconfig.json", JSON.stringify({ compilerOptions: {
    target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true,
    noEmit: true, skipLibCheck: true, types: [],
  }, files: ["globals.ts", "augment.ts", "deadline.ts", "first.ts", "last.ts", ".next/types/validator.ts"] }));
  return { dir, write, config: join(dir, "tsconfig.json") };
};

test("bounded checking covers every root and generated route check with shared global declarations", t => {
  const { dir, config } = fixture(t);
  const plan = createTypecheckPlan(config, join(dir, ".preview"), 1, 1);
  assert.equal(plan.globals.includes(join(dir, "augment.ts")), false, "share the declaration rather than the module implementation");
  assert.ok(Object.values(plan.virtualFiles).some(text => text.includes("DeadlineValue") && text.includes("declare global")));
  const result = runBoundedTypecheck({ configPath: config, outputRoot: join(dir, ".out"), batchSize: 1, routeBatchSize: 1, heapMb: 768 });
  assert.equal(result.status, 0);
  assert.equal(result.evidence.roots, 6);
  assert.equal(result.evidence.generatedRouteChecks, 2);
  assert.equal(result.evidence.allRootsCovered, true);
  assert.equal(result.evidence.sourceUnchanged, true);
});

test("an error in a later source batch fails the complete check", t => {
  const { dir, config, write } = fixture(t);
  write("last.ts", 'export const last: SharedScope = { name: "Vega", deadline: "wrong" };\n');
  assert.notEqual(runBoundedTypecheck({ configPath: config, outputRoot: join(dir, ".out"), batchSize: 1, heapMb: 768 }).status, 0);
});

test("generated route assertions are checked after import rebasing rather than skipped", t => {
  const { dir, config, write } = fixture(t);
  write("last.ts", 'export const last = "not a project scope";\n');
  assert.notEqual(runBoundedTypecheck({ configPath: config, outputRoot: join(dir, ".out"), batchSize: 1, routeBatchSize: 1, heapMb: 768 }).status, 0);
});

test("an unexpected validator structure is refused instead of reducing coverage", t => {
  const { dir, config, write } = fixture(t);
  write(".next/types/validator.ts", '// This file is generated automatically by Next.js\nexport const unexpected = 1;\n{}\n');
  assert.throws(() => createTypecheckPlan(config, join(dir, ".out")), /Unsupported validator structure/);
});

test("value-dependent global declarations retain their original module and symbol identity", t => {
  const { dir, config, write } = fixture(t);
  write("augment.ts", 'export const token: unique symbol = Symbol(); declare global { interface SharedScope { deadline: number; token?: typeof token } }\n');
  write("first.ts", 'import {token} from "./augment.js"; export const first: SharedScope = {name:"Atlas",deadline:28,token};\n');
  const plan = createTypecheckPlan(config, join(dir, ".preview"));
  assert.ok(plan.globals.includes(join(dir, "augment.ts")));
  assert.equal(runBoundedTypecheck({ configPath: config, outputRoot: join(dir, ".out"), batchSize: 2, heapMb: 768 }).status, 0);
});
