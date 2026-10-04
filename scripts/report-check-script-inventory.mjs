// Which `check:*` scripts are gates, and which are tools that need an argument
// or an environment. See scripts/check-script-inventory-core.mjs for why the
// distinction is worth a command, and why this reports rather than gates.
//
// Usage:
//   npm run report:check-script-inventory

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describeInventory } from "./check-script-inventory-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const scripts = Object.keys(manifest.scripts ?? {})
  .filter((name) => name.startsWith("check:"))
  .sort();

console.log(describeInventory(scripts));
console.log(`\nRead from ${root}package.json`);
