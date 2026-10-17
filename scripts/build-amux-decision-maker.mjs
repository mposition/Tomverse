// Builds the AMUX Decision Maker's runner release (docs/policy/amux-decision-maker.md
// §5 and §5a, stage S2-3b): one directory the operator copies to a
// root-owned place on the runner and installs from with
// scripts/install-amux-decision-maker.sh, which it contains.
//
//   broker.mjs                       the broker, one ESM file, node builtins only
//   launcher.mjs                     the launcher, the same
//   dm-output-schema-v1.json         §5a's "<스키마 파일>", the launcher's constant byte for byte
//   install-amux-decision-maker.sh   the installer, as in this commit
//   systemd/amux-dm-*                the six units, as in this commit
//   manifest.sha256                  every file above, in `sha256sum -c` format
//
// The last line printed is the sha256 of manifest.sha256: the operator checks
// the copy on the runner against it and gives it to the installer. Nothing is
// sent anywhere and neither bundle is run.
//
//   npm run build:amux-decision-maker [-- --out <directory>]

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { DM_OUTPUT_SCHEMA_JSON, DM_OUTPUT_SCHEMA_PATH, DM_OUTPUT_SCHEMA_SHA256 } from "../lib/amux/decisionMakerLauncherCore.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (!(args.length === 0 || (args.length === 2 && args[0] === "--out"))) {
  process.stderr.write("usage: build-amux-decision-maker.mjs [--out <directory>]\n");
  process.exit(2);
}
const outDirectory = resolve(args.length === 2 ? args[1] : join(repositoryRoot, ".next", "amux-decision-maker"));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

const DM_RELEASE_BUNDLES = [
  { entry: "scripts/amux-dm-broker.mjs", output: "broker.mjs" },
  { entry: "scripts/amux-dm-launcher.mjs", output: "launcher.mjs" },
];
const DM_RELEASE_UNITS = [
  "amux-dm-broker.socket",
  "amux-dm-broker.service",
  "amux-dm-launcher-openai.socket",
  "amux-dm-launcher-openai@.service",
  "amux-dm-launcher-anthropic.socket",
  "amux-dm-launcher-anthropic@.service",
];

rmSync(outDirectory, { recursive: true, force: true });
mkdirSync(join(outDirectory, "systemd"), { recursive: true });

const files = [];
for (const { entry, output } of DM_RELEASE_BUNDLES) {
  const outfile = join(outDirectory, output);
  const result = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    metafile: true,
    logLevel: "error",
    legalComments: "none",
  });
  // Everything but node's own modules is inside the file: the runner has no
  // node_modules, and nothing may be resolved from wherever node happens to run.
  const external = Object.values(result.metafile.outputs)
    .flatMap((meta) => meta.imports)
    .filter((imported) => imported.external && !builtins.has(imported.path))
    .map((imported) => imported.path);
  if (external.length > 0) {
    process.stderr.write(`${output} imports outside node's builtins: ${[...new Set(external)].join(", ")}\n`);
    process.exit(1);
  }
  files.push(output);
}

const schemaName = DM_OUTPUT_SCHEMA_PATH.slice(DM_OUTPUT_SCHEMA_PATH.lastIndexOf("/") + 1);
const schemaBytes = Buffer.from(DM_OUTPUT_SCHEMA_JSON, "utf8");
if (sha256(schemaBytes) !== DM_OUTPUT_SCHEMA_SHA256) {
  process.stderr.write("the schema bytes do not hash to the launcher's constant\n");
  process.exit(1);
}
writeFileSync(join(outDirectory, schemaName), schemaBytes);
files.push(schemaName);

copyFileSync(join(repositoryRoot, "scripts", "install-amux-decision-maker.sh"), join(outDirectory, "install-amux-decision-maker.sh"));
files.push("install-amux-decision-maker.sh");
for (const unit of DM_RELEASE_UNITS) {
  copyFileSync(join(repositoryRoot, "scripts", "systemd", unit), join(outDirectory, "systemd", unit));
  files.push(`systemd/${unit}`);
}

const manifest = files.map((name) => `${sha256(readFileSync(join(outDirectory, name)))}  ${name}\n`).join("");
writeFileSync(join(outDirectory, "manifest.sha256"), manifest);
process.stdout.write(`${outDirectory}\n${manifest}`);
process.stdout.write(`${sha256(Buffer.from(manifest, "utf8"))}  manifest.sha256\n`);
