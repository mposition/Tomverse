import { isSecretPath } from "./workspace.js";

/**
 * Where a remote project lives, and every rule about how it is named and reached.
 *
 * The CLI never holds a key, a password or a passphrase: it starts the user's own `ssh` with the user's own configuration
 * (~/.ssh/config, ssh-agent, known_hosts). Everything that goes into an ssh command line comes from this file, so an
 * option cannot be injected by a name, and the one place that quotes text for the remote shell is `shellQuote`.
 */

export type RemoteTarget = {
    /** A Host alias of ~/.ssh/config, a host name, or user@host. Never starts with "-". */
    destination: string;
    port?: number;
    /** Absolute, normalised folder on the remote machine. */
    folder: string;
};

export type RemoteErrorCode =
    | "invalid-target"
    | "ssh-missing"
    | "auth"
    | "host-key"
    | "host-key-changed"
    | "name-not-found"
    | "unreachable"
    | "timeout"
    | "connection-lost"
    | "folder-missing"
    | "not-a-folder"
    | "folder-too-broad"
    | "unsupported-remote"
    | "outside-root"
    | "changed"
    | "not-found"
    | "exists"
    | "write-incomplete"
    | "too-large"
    | "protocol"
    | "failed";

export class RemoteError extends Error {
    constructor(readonly code: RemoteErrorCode, message: string, readonly detail?: string) {
        super(message);
    }
}

const NAME = "[A-Za-z0-9_][A-Za-z0-9._-]{0,62}";
/** A host name or an IPv4 address (letters, digits, dots, dashes and underscores; the first character is never "-"). */
const HOST = "[A-Za-z0-9_][A-Za-z0-9._-]{0,252}";
const DESTINATION = new RegExp(`^(?:${NAME}@)?${HOST}$`);
/** An IPv6 literal: ssh takes it without brackets after the user name. */
const DESTINATION_V6 = new RegExp(`^(?:${NAME}@)?[0-9A-Fa-f:]{2,45}$`);
/** What a remote folder may be made of: letters and digits of any script, space and the few marks real folders use. */
const FOLDER_CHARS = /^[\p{L}\p{N} _.@%+=:,~/-]+$/u;

const invalid = (message: string): never => {
    throw new RemoteError("invalid-target", message);
};

export const parseDestination = (input: unknown) => {
    if (typeof input !== "string") return invalid("The SSH target must be text.");
    const value = input.trim();
    if (!value) return invalid("Enter an SSH target: a Host name from ~/.ssh/config, or user@host.");
    if (value.startsWith("-")) return invalid("An SSH target cannot start with a dash.");
    if (!DESTINATION.test(value) && !(value.includes(":") && DESTINATION_V6.test(value))) {
        return invalid("The SSH target can only contain letters, digits, dots, dashes and underscores (and one user@ in front).");
    }
    return value;
};

export const parsePort = (input: unknown) => {
    if (input === undefined || input === null || input === "") return undefined;
    const port = typeof input === "number" ? input : typeof input === "string" && /^[0-9]{1,5}$/.test(input.trim()) ? Number(input.trim()) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return invalid("The port must be a number from 1 to 65535.");
    return port;
};

/** The absolute path of the remote folder, lexically cleaned. Nothing here asks the remote machine. */
export const parseRemoteFolder = (input: unknown) => {
    if (typeof input !== "string") return invalid("The remote folder must be text.");
    const value = input.trim();
    if (!value.startsWith("/")) return invalid("Enter the remote folder as an absolute path, starting with /.");
    if (value.length > 1024) return invalid("The remote folder path is too long.");
    if (!FOLDER_CHARS.test(value)) return invalid("The remote folder can contain letters, digits, spaces and . _ - @ % + = : , ~ only.");
    const parts: string[] = [];
    for (const part of value.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") return invalid("The remote folder cannot contain .. segments.");
        parts.push(part);
    }
    if (!parts.length) throw new RemoteError("folder-too-broad", "The remote root folder is too broad to work in. Choose a project folder.");
    const folder = `/${parts.join("/")}`;
    // The same rule as a local folder: a folder inside .ssh, .aws, .git ... would expose credentials.
    if (isSecretPath(`${folder}/`)) {
        throw new RemoteError("folder-too-broad", `${folder} is inside a folder that can hold credentials; the CLI does not work there.`);
    }
    return folder;
};

export const parseRemoteTarget = (input: { destination?: unknown; port?: unknown; folder?: unknown }): RemoteTarget => {
    const destination = parseDestination(input.destination);
    const port = parsePort(input.port);
    const folder = parseRemoteFolder(input.folder);
    return { destination, ...(port !== undefined ? { port } : {}), folder };
};

/** How the person sees the machine: the alias or user@host, with the port when there is one. */
export const targetLabel = (target: Pick<RemoteTarget, "destination" | "port">) =>
    target.port !== undefined ? `${target.destination}:${target.port}` : target.destination;

/** A stable key for one target and folder (one project). */
export const targetKey = (target: RemoteTarget) => `${target.destination}|${target.port ?? ""}|${target.folder}`;

/**
 * Quotes one value for a POSIX shell on the remote machine. The only place in the CLI that does it: a value is wrapped in single
 * quotes and a single quote inside it becomes '\''. NUL cannot be quoted, so it is refused.
 */
export const shellQuote = (value: string) => {
    if (value.includes("\0")) throw new RemoteError("invalid-target", "A value sent to the remote machine cannot contain NUL.");
    return `'${value.replaceAll("'", `'\\''`)}'`;
};

/** `sh -c '<script>' sh <args...>`: one string for ssh's command position, whatever the remote login shell is. */
export const remoteShellCommand = (script: string, args: readonly string[]) =>
    ["sh", "-c", shellQuote(script), "sh", ...args.map(shellQuote)].join(" ");

export type SshOptions = { connectTimeoutSeconds?: number; platform?: NodeJS.Platform };

/**
 * The arguments for one ssh run, as an array (never a string a shell would read). `BatchMode=yes` means ssh never asks for a
 * password, a passphrase or a host key answer: it fails and says what is missing. StrictHostKeyChecking is not touched.
 */
export const sshArguments = (target: Pick<RemoteTarget, "destination" | "port">, remoteCommand: string, options: SshOptions = {}) => {
    const destination = parseDestination(target.destination);
    const port = parsePort(target.port);
    const platform = options.platform ?? process.platform;
    return [
        "-T",
        "-o", "BatchMode=yes",
        "-o", `ConnectTimeout=${Math.max(1, Math.min(60, Math.round(options.connectTimeoutSeconds ?? 15)))}`,
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=3",
        "-o", "LogLevel=ERROR",
        "-o", "ForwardAgent=no",
        "-o", "ForwardX11=no",
        "-o", "ClearAllForwardings=yes",
        "-o", "PermitLocalCommand=no",
        "-o", "RemoteCommand=none",
        // Windows' OpenSSH has no connection sharing; a config that asks for it would fail every run there.
        ...(platform === "win32" ? ["-o", "ControlMaster=no", "-o", "ControlPath=none"] : []),
        ...(port !== undefined ? ["-p", String(port)] : []),
        "--",
        destination,
        remoteCommand,
    ];
};

export type SshFailure = { exitCode: number | null; stderr: string; spawnError?: string; timedOut?: boolean };

const GUIDE_AGENT = "Connect once in a terminal (ssh <target>), enter the passphrase there, and add the key to ssh-agent, then try again. The app never asks for a password or passphrase.";
const GUIDE_HOST_KEY = "Connect once in a terminal (ssh <target>) and check the host key yourself. The app never accepts an unknown host.";

/** What ssh's own words mean. Remote script failures are not classified here (their exit codes are). */
export const classifySshFailure = (failure: SshFailure, label = "the remote machine"): RemoteError => {
    const text = failure.stderr.replace(/\r/g, "");
    if (failure.timedOut) return new RemoteError("timeout", `The connection to ${label} timed out.`);
    if (failure.spawnError) {
        if (/ENOENT|not found|cannot find/i.test(failure.spawnError)) {
            return new RemoteError("ssh-missing", "The ssh program was not found on this computer. Install OpenSSH (on Windows: Settings > Optional features > OpenSSH Client).");
        }
        return new RemoteError("failed", `ssh could not be started: ${failure.spawnError}`);
    }
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Offending .* key in|host key for .* has changed/i.test(text)) {
        return new RemoteError("host-key-changed", `The host key of ${label} changed. This can mean someone is intercepting the connection. ${GUIDE_HOST_KEY}`);
    }
    if (/Host key verification failed|No .* host key is known|host key.*not (?:known|verified)/i.test(text)) {
        return new RemoteError("host-key", `The host key of ${label} is not known yet. ${GUIDE_HOST_KEY}`);
    }
    if (/Permission denied|Too many authentication failures|no more authentication methods|passphrase|Authentication failed|Authentication refused/i.test(text)) {
        return new RemoteError("auth", `Signing in to ${label} needs a key that ssh can use without asking. ${GUIDE_AGENT}`);
    }
    if (/Could not resolve hostname|Name or service not known|nodename nor servname|Temporary failure in name resolution/i.test(text)) {
        return new RemoteError("name-not-found", `${label} could not be found. Check the name in ~/.ssh/config or the address.`);
    }
    if (/Connection (?:timed out|refused)|No route to host|Network is unreachable|Operation timed out|Host is down|Connection closed by remote host.*banner/i.test(text)) {
        return new RemoteError("unreachable", `${label} cannot be reached (${text.trim().split("\n").at(-1)?.slice(0, 200) ?? "no answer"}).`);
    }
    if (/Connection (?:reset|closed)|Broken pipe|client_loop|packet_write|Connection to .* closed|kex_exchange_identification|Timeout, server .* not responding/i.test(text)) {
        return new RemoteError("connection-lost", `The connection to ${label} was lost.`);
    }
    if (failure.exitCode === 255) return new RemoteError("connection-lost", `The connection to ${label} failed${text.trim() ? `: ${text.trim().split("\n").at(-1)!.slice(0, 200)}` : "."}`);
    return new RemoteError("failed", `The remote command failed (exit ${failure.exitCode ?? "none"})${text.trim() ? `: ${text.trim().slice(0, 300)}` : "."}`);
};

/** The exit codes the remote scripts use for what they found (never the exit code of a user's command; see remote-scripts.ts). */
export const SCRIPT_EXIT = {
    folderMissing: 40,
    notAFolder: 41,
    outside: 42,
    changed: 43,
    notFound: 44,
    incomplete: 45,
    exists: 46,
    unsupported: 47,
    tooLarge: 48,
    unsupportedName: 49,
} as const;

export const scriptFailure = (exitCode: number, stderr: string, label: string): RemoteError | null => {
    const note = stderr.trim().split("\n").at(-1)?.slice(0, 200) ?? "";
    switch (exitCode) {
        case SCRIPT_EXIT.folderMissing: return new RemoteError("folder-missing", `The folder does not exist on ${label}.`);
        case SCRIPT_EXIT.notAFolder: return new RemoteError("not-a-folder", `That path on ${label} is not a folder.`);
        case SCRIPT_EXIT.outside: return new RemoteError("outside-root", "The path resolves outside the remote project folder (through a link, or it is not inside).");
        case SCRIPT_EXIT.changed: return new RemoteError("changed", "The file or its folder changed on the remote machine. Nothing was written.");
        case SCRIPT_EXIT.notFound: return new RemoteError("not-found", "The path does not exist on the remote machine.");
        case SCRIPT_EXIT.incomplete: return new RemoteError("write-incomplete", "The file did not arrive completely, so the existing file was left as it was.");
        case SCRIPT_EXIT.exists: return new RemoteError("exists", "The file already exists on the remote machine.");
        case SCRIPT_EXIT.unsupported: return new RemoteError("unsupported-remote", `The remote machine lacks a tool the CLI needs (${note || "stat, cat, mv"}). It needs a POSIX shell with the usual coreutils.`);
        case SCRIPT_EXIT.tooLarge: return new RemoteError("too-large", "The file is too large.");
        case SCRIPT_EXIT.unsupportedName: return new RemoteError("invalid-target", `A folder name on ${label} contains a line break, which a remote project does not support. Choose a folder whose path has none.`);
        default: return null;
    }
};
