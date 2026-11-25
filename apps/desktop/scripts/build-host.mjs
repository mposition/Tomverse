import { copyFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { bundledDependencyNotices } from "../../../scripts/bundled-dependency-notices.mjs";

const packagedTaskQa = process.argv.includes("--packaged-task-qa");
const packaged = packagedTaskQa || process.argv.includes("--packaged");
const updateOrigin = packagedTaskQa ? "" : process.env.TOMVERSE_DESKTOP_UPDATE_ORIGIN ?? "";
const outdir = packagedTaskQa ? "dist/host-task-qa" : "dist/host";
const testAuthOrigin = packaged ? "" : process.env.TOMVERSE_DESKTOP_AUTH_TEST_ORIGIN ?? "";
const cliProtocolCheckAllowed = packaged
  ? !packagedTaskQa && process.env.TOMVERSE_DESKTOP_CLI_PROTOCOL_CHECKS_ENABLED === "true"
  : process.env.TOMVERSE_DESKTOP_CLI_PROTOCOL_FIXTURE === "true";
if (testAuthOrigin && !/^http:\/\/127\.0\.0\.1:[0-9]{4,5}$/.test(testAuthOrigin)) {
  throw new Error("The Desktop authentication fixture must use IPv4 loopback.");
}
if (updateOrigin && !/^https:\/\/[A-Za-z0-9.-]+$/.test(updateOrigin)) {
  throw new Error("Set TOMVERSE_DESKTOP_UPDATE_ORIGIN to the HTTPS release origin without a port or path.");
}

const host = await build({
  entryPoints: ["main", "preload", "runner-process"].map((name) => ({
    in: `src/host/${name}.ts`,
    out: name,
  })),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron"],
  outExtension: { ".js": ".cjs" },
  outdir,
  define: {
    DESKTOP_UPDATE_ORIGIN: JSON.stringify(updateOrigin),
    DESKTOP_FIXTURE_ALLOWED: String(!packaged || packagedTaskQa),
    DESKTOP_PACKAGED_TASK_QA: String(packagedTaskQa),
    DESKTOP_AUTH_ALLOWED: String(!packagedTaskQa && process.env.TOMVERSE_DESKTOP_AUTH_ENABLED === "true"),
    DESKTOP_LOGIN_WINDOW_REQUIRED: String(!packagedTaskQa && process.env.TOMVERSE_DESKTOP_AUTH_ENABLED === "true" &&
      (packaged || (!!testAuthOrigin && process.env.TOMVERSE_DESKTOP_LOGIN_FIXTURE === "true"))),
    DESKTOP_AUTH_FIXTURE_ORIGIN: JSON.stringify(testAuthOrigin),
    DESKTOP_ACCOUNT_DEVICE_FIXTURE_ALLOWED: String(!packaged && !!testAuthOrigin && process.env.TOMVERSE_DESKTOP_DEVICE_FIXTURE === "true"),
    DESKTOP_CLI_AUTH_FIXTURE_ALLOWED: String(!packaged && process.env.TOMVERSE_DESKTOP_CLI_AUTH_FIXTURE === "true"),
    DESKTOP_CLI_PROTOCOL_CHECK_ALLOWED: String(cliProtocolCheckAllowed),
  },
  minifySyntax: packaged,
  metafile: packaged,
});

if (host.metafile) {
  const inputs = new Set();
  for (const output of Object.values(host.metafile.outputs)) {
    for (const [input, contribution] of Object.entries(output.inputs)) {
      if (contribution.bytesInOutput > 0) inputs.add(input);
    }
  }
  await writeFile(`${outdir}-notices.txt`, bundledDependencyNotices(inputs).join("\n"));
}

await copyFile("../../public/tomverse-logo.png", `${outdir}/tomverse-icon.png`);
await copyFile("../../app/favicon.ico", `${outdir}/tomverse-icon.ico`);
