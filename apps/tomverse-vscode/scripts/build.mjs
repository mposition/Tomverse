import { build } from "esbuild";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(resolve(root, "dist"), { recursive: true });
const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["vscode"],
    metafile: true,
    legalComments: "inline",
});
if (Object.keys(result.metafile.inputs).some((name) => /tomverse-cli\/src\/(cli|main|interactive)\.ts$/.test(name)))
    throw new Error("Terminal entry imported into extension");
writeFileSync(resolve(root, "dist/build-meta.json"), JSON.stringify(result.metafile, null, 2));
copyFileSync(resolve(root, "../../public/tomverse-logo.png"), resolve(root, "media/tomverse-logo.png"));
console.log(`Bundled extension and same-revision CLI runtime (${Object.keys(result.metafile.inputs).length} modules)`);
