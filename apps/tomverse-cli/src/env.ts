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

const PROTECTED_ENV = /^(?:TOMVERSE_|ELECTRON_|NODE_(?:OPTIONS|PATH|REPL_EXTERNAL_MODULE|EXTRA_CA_CERTS)$)|(?:^|_)(?:API_?KEY|ACCESS_KEY|CREDENTIALS?|PASSWORD|SECRET|TOKEN)(?:_|$)/i;

export const commandEnv = (extraNames: string[] = [], env: NodeJS.ProcessEnv = process.env) => {
    const out: Record<string, string> = {};
    const names = new Set<string>();
    for (const name of [...BASE_ENV, ...extraNames]) {
        const key = process.platform === "win32" ? name.toLowerCase() : name;
        if (names.has(key) || PROTECTED_ENV.test(name)) continue;
        const value = env[name];
        if (typeof value === "string") {
            out[name] = value;
            names.add(key);
        }
    }
    out.NO_COLOR = "1";
    out.FORCE_COLOR = "0";
    out.TERM = "dumb";
    out.CI = env.CI ?? "";
    if (!out.CI) delete out.CI;
    return out;
};
