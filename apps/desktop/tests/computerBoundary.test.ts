import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { computerCommand } from "../src/computer-contract";

const here = dirname(fileURLToPath(import.meta.url));
const host = join(here, "..", "src", "host");
const read = (file: string) => readFileSync(join(host, file), "utf8");

test("only the open task's own run gets the window tools: parallel tasks and schedules never start with them", () => {
  // The lanes and the schedule launcher build their own start commands; none of them names the tools.
  for (const file of ["parallel-host.ts", "task-lanes.ts", "schedule-launch.ts", "schedule-engine.ts"]) {
    assert.doesNotMatch(read(file), /computerUse|computerAgent|computer-agent/, file);
  }
  // The foreground start and resume take them from the person's switch, in one place.
  const main = read("main.ts");
  assert.equal((main.match(/computerUse: true/g) ?? []).length, 1);
  assert.match(main, /\.\.\.\(computer\.host\.toolsAvailable\(\) \? \{ computerUse: true \} : \{\}\)/);
  // The parallel start in main.ts spells out its command without codeRunTools().
  const lanes = main.slice(main.indexOf("parallel.submit({ kind: \"parallel\""), main.indexOf("if (parallel.lanes.folderBusy"));
  assert.doesNotMatch(lanes, /codeRunTools|computerUse/);
  // A request from a runtime is answered only by the host of the open task's worker.
  assert.match(main, /if \(event\.type === "computer-agent"\) \{ void computer\.host\.handle\(event\); return; \}/);
});

test("the renderer reaches the window tools only through the typed command, and names a window only by an id the host listed", () => {
  const preload = read("preload.ts");
  assert.match(preload, /ipcRenderer\.invoke\("desktop:code-computer", command\)/);
  assert.match(read("main.ts"), /main\("desktop:code-computer", \(value\) => computer\.host\.command\(value\)\)/);
  assert.equal(computerCommand.safeParse({ type: "select", id: "C:\Windows\System32\cmd.exe" }).success, false);
  assert.equal(computerCommand.safeParse({ type: "select", id: "1a2b:4242" }).success, true);
  assert.equal(computerCommand.safeParse({ type: "select", id: "1a2b:4242", cls: "x" }).success, false);
  assert.equal(computerCommand.safeParse({ type: "enable", enabled: true }).success, false, "the confirmation is part of the command");
});

test("the Windows backend and its script are the only code that sends input, and no screenshot is ever written to a file", () => {
  const files = readdirSync(host).filter((name) => /\.ts$/.test(name));
  const inputs = files.filter((name) => /SendInput|SetCursorPos/.test(read(name))).map((name) => relative(host, join(host, name)));
  assert.deepEqual(inputs, ["computer-win-script.ts"]);
  const backend = read("computer-backend-windows.ts");
  // The only file it writes is the script itself, into a private temporary folder.
  assert.equal((backend.match(/writeFileSync\(/g) ?? []).length, 1);
  assert.match(backend, /writeFileSync\(script, WINDOWS_COMPUTER_SCRIPT/);
  for (const name of ["computer-host.ts", "computer-wiring.ts", "computer-policy.ts"]) assert.doesNotMatch(read(name), /writeFile|createWriteStream|appendFile/, name);
});

test("the Linux backend is the only code that starts the X11 tools, writes no file, and is reached only through the platform factory", () => {
  const files = readdirSync(host).filter((name) => /\.ts$/.test(name));
  assert.deepEqual(files.filter((name) => /["']xdotool["']/.test(read(name))).sort(), ["computer-backend-x11.ts"]);
  const backend = read("computer-backend-x11.ts");
  assert.doesNotMatch(backend, /writeFile|createWriteStream|appendFile|mkdtemp|shell:\s*true|\bexecSync\b|\bexecFile/, "no file, no shell string");
  assert.equal((backend.match(/\bspawn\(/g) ?? []).length, 1, "one place starts a program for the backend, with an argument array");
  assert.equal((backend.match(/\bspawnSync\(/g) ?? []).length, 1, "and one asks each tool whether it is installed");
  assert.match(backend, /spawn\(file, args, \{ env: toolEnvironment\(\)/);
  // Nothing but the platform factory builds it, and the factory asks for the opt-in, the session and every tool first.
  for (const name of files.filter((entry) => entry !== "computer-platform.ts" && entry !== "computer-backend-x11.ts")) assert.doesNotMatch(read(name), /createX11Backend/, name);
  const platform = read("computer-platform.ts");
  assert.match(platform, /env\[COMPUTER_UNVERIFIED_LINUX\] === "1"/);
  assert.match(platform, /x11Missing\(env, probe\)\?\.length === 0 \? createX11Backend\(\) : null/);
  // Ctrl+V is refused in the backend as well as in the policy.
  assert.match(backend, /name === "v"\) return null/);
});
