import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) => pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;

// The production queue on 2026-11-12: 16 open rows, 12 families. The two
// qwen-image-2.0 lines carried dated snapshots that the discovery tab folds in.
const OPEN_ROWS = [
  "qwen-image-2.0", "qwen-image-2.0-2026-03-03",
  "qwen-image-2.0-pro", "qwen-image-2.0-pro-2026-03-03",
  "qwen-image-2.0-pro-2026-04-22", "qwen-image-2.0-pro-2026-06-22",
  "glm-5.3-prime", "wan2.7-image-pro", "z-image-turbo", "kimi-k3.2",
  "mistral-medium-4", "grok-5", "gemini-4-neon", "claude-fable-5-3",
  "deepseek-v5", "minimax-m4",
].map((apiModel) => ({ apiModel }));

mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: {
      modelLifecycleWorkItem: { findMany: async () => OPEN_ROWS },
      providerModelCatalogEntry: { findMany: async () => [] },
    },
  },
});

test("the menu badge counts families the way the discovery tab lists them", async () => {
  const { countOpenWorkItemFamilies } = await import(
    `${mod("lib/modelLifecycleWorkItems.ts")}?families`
  );
  assert.equal(await countOpenWorkItemFamilies(), 12);
});

test("the Models menu badge reads the family count", () => {
  const counts = readFileSync(resolve(ROOT, "lib/adminNavigationCounts.ts"), "utf8");
  assert.ok(counts.includes("countOpenWorkItemFamilies()"));
  assert.equal(counts.includes("countOpenWorkItems()"), false);
});
