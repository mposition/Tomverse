// Finds an agent CLI without running it.
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

/** `file` to spawn, and whether a shell is needed (Windows .cmd/.bat shims only). */
export const findBinary = ({ names, envVar, extraDirs = [], env = process.env }) => {
    const override = envVar ? env[envVar] : undefined;
    if (override) return { file: override, shell: /\.(cmd|bat)$/i.test(override) };
    const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
    const dirs = [...(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean), ...extraDirs];
    for (const dir of dirs) {
        for (const name of names) {
            for (const suffix of suffixes) {
                const candidate = join(dir, name + suffix);
                if (existsSync(candidate)) return { file: candidate, shell: /\.(cmd|bat)$/i.test(candidate) };
            }
        }
    }
    return null;
};

export const homeBin = () => [join(homedir(), ".local", "bin"), join(homedir(), "bin")];
