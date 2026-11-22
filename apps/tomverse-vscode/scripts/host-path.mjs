import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const desktopExecutable = () => {
    if (process.env.VSCODE_EXECUTABLE_PATH) return process.env.VSCODE_EXECUTABLE_PATH;
    const candidates = [];
    if (process.platform === "win32") {
        for (const base of [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs"), process.env.ProgramFiles])
            if (base) candidates.push(join(base, "Microsoft VS Code", "Code.exe"));
        try {
            for (const command of execFileSync("where.exe", ["code"], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/))
                candidates.push(resolve(dirname(command), "../Code.exe"));
        } catch {
            /* The explicit executable setting remains available. */
        }
    }
    const executable = candidates.find(existsSync);
    if (!executable) throw new Error("Set VSCODE_EXECUTABLE_PATH to the local VS Code Desktop executable.");
    return executable;
};
