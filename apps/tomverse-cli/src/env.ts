/** Variables an approved command gets. Never a Tomverse key, whatever the config says. */
const BASE_ENV = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "windir",
    "WINDIR",
    "COMSPEC",
    "ComSpec",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "CommonProgramFiles",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "USER",
    "LOGNAME",
    "SHELL",
];

export const commandEnv = (extraNames: string[] = [], env: NodeJS.ProcessEnv = process.env) => {
    const out: Record<string, string> = {};
    for (const name of [...BASE_ENV, ...extraNames]) {
        if (/^TOMVERSE_/i.test(name)) continue;
        const value = env[name];
        if (typeof value === "string") out[name] = value;
    }
    out.NO_COLOR = "1";
    out.FORCE_COLOR = "0";
    out.TERM = "dumb";
    out.CI = env.CI ?? "";
    if (!out.CI) delete out.CI;
    return out;
};
