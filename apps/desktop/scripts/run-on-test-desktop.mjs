import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHome } from "./test-home.mjs";

const args = process.argv.slice(2);
if (!args.length) throw new Error("Pass the Node.js arguments for the Desktop test.");

function quoteWindowsArgument(arg) {
  const escaped = arg.replace(/\\+(?="|$)|"/g, (part) => part === '"' ? '\\"' : part + part);
  return '"' + escaped + '"';
}

// The tests never see the skills, hooks or MCP servers in the real home folder of this computer.
// TOMVERSE_TEST_USE_REAL_HOME=1 turns it off, to tell a failure that comes from this computer's own configuration from one that does not.
const testHome = process.env.TOMVERSE_TEST_USE_REAL_HOME === "1" ? { root: tmpdir(), env: {}, remove() {} } : createTestHome();
const isolated = { ...process.env, ...testHome.env };
const windows = process.platform === "win32";
const launcher = fileURLToPath(new URL("./run-on-test-desktop.ps1", import.meta.url));
const result = windows
  ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", launcher], {
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
    env: {
      ...isolated,
      // A PowerShell whose profile folder was moved would write its module cache into the current folder.
      PSModuleAnalysisCachePath: join(testHome.root, "powershell-module-cache"),
      TOMVERSE_TEST_NODE: process.execPath,
      TOMVERSE_TEST_COMMAND_LINE: [process.execPath, ...args].map(quoteWindowsArgument).join(" "),
    },
  })
  : spawnSync(process.execPath, args, { stdio: "inherit", env: isolated });
testHome.remove();

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
