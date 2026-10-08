import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const service = "lib/amux/ideaInitialSourcePlanService.ts";

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if ([".git", ".next", "node_modules"].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name)
      ? [path] : [];
  });
}

test("the v4 initial source-plan writer has only its gated Admin access caller", () => {
  const rootFiles = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name))
    .map((entry) => resolve(root, entry.name));
  const callSites = ["app", "components", "lib", "scripts", "packages", "prisma"]
    .flatMap((directory) => sourceFiles(resolve(root, directory)))
    .concat(rootFiles)
    .map((path) => ({ path: relative(root, path).split("\\").join("/"),
      source: readFileSync(path, "utf8") }))
    .filter(({ path }) => path !== service)
    .filter(({ source }) => source.includes("ideaInitialSourcePlanService") ||
      source.includes("createInitialIdeaOnlySourcePlan"))
    .map(({ path }) => path);
  assert.deepEqual(callSites, [
    "app/api/admin/amux/ideas/initial-source-plan/route.ts",
    "lib/amux/ideaInitialSourcePlanAccess.ts",
  ]);
  const route = readFileSync(resolve(root, callSites[0]), "utf8");
  const access = readFileSync(resolve(root, callSites[1]), "utf8");
  const core = readFileSync(resolve(root, "lib/amux/ideaInitialSourcePlanCore.ts"), "utf8");
  assert.match(route, /!initialPlanWritePermitted\(process\.env\[AMUX_V4_INITIAL_PLAN_WRITE_ENV\]\)/);
  assert.match(route, /!initialPlanReadbackPermitted\(process\.env\[AMUX_V4_INITIAL_PLAN_READBACK_ENV\]\)/);
  assert.match(access, /!initialPlanWritePermitted\(process\.env\[AMUX_V4_INITIAL_PLAN_WRITE_ENV\]\)/);
  assert.match(core, /AMUX_V4_INITIAL_PLAN_WRITE_CODE_ENABLED = true/);
  assert.match(core, /AMUX_V4_INITIAL_PLAN_READBACK_CODE_ENABLED = true/);
});
