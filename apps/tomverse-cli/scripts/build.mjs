// Builds dist/ from src/ with the TypeScript compiler. dist is the only code
// the package ships; the bin keeps its shebang and is made executable.
import { chmodSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
rmSync(join(root, "dist"), { recursive: true, force: true });
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const result = spawnSync(process.execPath, [tsc, "-p", join(root, "tsconfig.json")], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
if (process.platform !== "win32") chmodSync(join(root, "dist", "cli.js"), 0o755);
console.log("built apps/tomverse-cli/dist");
