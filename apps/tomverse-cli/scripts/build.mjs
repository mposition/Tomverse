// Builds dist/ from src/ with the TypeScript compiler. dist is the only code
// the package ships; the bin keeps its shebang and is made executable.
import { chmodSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
rmSync(join(root, "dist"), { recursive: true, force: true });
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const result = spawnSync(process.execPath, [tsc, "-p", join(root, "tsconfig.json")], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
// tsconfig's newLine only covers what tsc writes itself. A clone checked out
// with CRLF (Git for Windows' default autocrlf, GitHub's Windows runners)
// keeps CRs inside multi-line template literals, so the output is made LF
// here. It changes no behaviour: JavaScript reads a CRLF inside a template
// literal as LF, and no other literal can hold a raw line break.
for (const file of readdirSync(join(root, "dist")).filter((f) => f.endsWith(".js"))) {
    const path = join(root, "dist", file);
    const text = readFileSync(path, "utf8");
    if (text.includes("\r")) writeFileSync(path, text.replace(/\r\n?/g, "\n"));
}
if (process.platform !== "win32") chmodSync(join(root, "dist", "cli.js"), 0o755);
console.log("built apps/tomverse-cli/dist");
