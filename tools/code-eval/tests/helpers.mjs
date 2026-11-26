import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const RUN = join(ROOT, "run.mjs");
export const COMPARE = join(ROOT, "compare.mjs");

export const tempDir = (prefix = "code-eval-test-") => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
};

/** Runs a script with the current node and a clean environment (no API key). */
export const runNode = (args, { env = {}, cwd = ROOT } = {}) => {
    const clean = { ...process.env, ...env };
    delete clean.TOMVERSE_API_KEY;
    delete clean.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, args, { cwd, env: clean, encoding: "utf8", timeout: 240_000 });
};
