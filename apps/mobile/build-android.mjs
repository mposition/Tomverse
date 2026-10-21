import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const windows = process.platform === "win32";
const result = spawnSync(windows ? "cmd.exe" : "sh",
  windows ? ["/d", "/c", "gradlew.bat", "assembleDebug"] : ["./gradlew", "assembleDebug"],
  { cwd: fileURLToPath(new URL("./android/", import.meta.url)), stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
