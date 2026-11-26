// `node --test tools/code-eval/tests/` hands Node 22 a directory, which it runs
// as one script. This file loads every test file of the folder, so the
// directory form works as well as the glob `tools/code-eval/tests/*.test.mjs`.
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const name of readdirSync(here).filter((file) => file.endsWith(".test.mjs")).sort()) {
    await import(pathToFileURL(join(here, name)).href);
}
