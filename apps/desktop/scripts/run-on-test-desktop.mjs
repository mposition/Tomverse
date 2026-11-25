import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (!args.length) throw new Error("Pass the Node.js arguments for the Desktop test.");

function quoteWindowsArgument(arg) {
  const escaped = arg.replace(/\\+(?="|$)|"/g, (part) => part === '"' ? '\\"' : part + part);
  return '"' + escaped + '"';
}

const windows = process.platform === "win32";
const launcher = fileURLToPath(new URL("./run-on-test-desktop.ps1", import.meta.url));
const result = windows
  ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", launcher], {
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
    env: {
      ...process.env,
      TOMVERSE_TEST_NODE: process.execPath,
      TOMVERSE_TEST_COMMAND_LINE: [process.execPath, ...args].map(quoteWindowsArgument).join(" "),
    },
  })
  : spawnSync(process.execPath, args, { stdio: "inherit" });

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
