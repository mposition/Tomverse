import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { codeProcessLaunch } from "./code-process-launch";

export function spawnNativeFixture(
  executable: string,
  args: readonly string[],
  options: Pick<SpawnOptionsWithoutStdio, "cwd" | "env">,
) {
  const launch = codeProcessLaunch(executable, args);
  const child = spawn(launch.file, launch.args, {
    ...options, detached: process.platform !== "win32", windowsHide: true, shell: false, stdio: ["pipe", "pipe", "ignore"],
  });
  // A failed request write can leave the other pipe open even though no reply can arrive.
  child.stdin.on("error", () => child.stdout.destroy());
  return child;
}
