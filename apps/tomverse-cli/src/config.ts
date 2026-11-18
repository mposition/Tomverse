import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * User-owned configuration. It lives in the user's home (or TOMVERSE_HOME),
 * never in the workspace, and nothing a repository contains -- instructions,
 * scripts, model output -- is read as configuration. The API key is never
 * part of it.
 */

export const DEFAULT_ENDPOINT = "https://tomverse.app/api/v1";

export type CliConfig = {
    endpoint?: string;
    /** Allows http:// only for a loopback host. For local development. */
    allowInsecureLocalhost?: boolean;
    model?: string;
    /** Extra environment variable names passed to approved commands. */
    commandEnv?: string[];
    /** Folders the user has said the CLI may work in (real paths). */
    trustedRoots?: string[];
};

export const tomverseHome = (env: NodeJS.ProcessEnv = process.env) =>
    env.TOMVERSE_HOME?.trim() || join(homedir(), ".tomverse");

const configPath = (env: NodeJS.ProcessEnv) => join(tomverseHome(env), "config.json");

export const ensureHome = (env: NodeJS.ProcessEnv = process.env) => {
    const home = tomverseHome(env);
    const created = !existsSync(home);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(home, 0o700);
    return { home, created };
};

export const readConfig = (env: NodeJS.ProcessEnv = process.env): CliConfig => {
    const path = configPath(env);
    if (!existsSync(path)) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        throw new ConfigError(`The config file ${path} is not valid JSON. Fix or delete it.`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ConfigError(`The config file ${path} must hold a JSON object.`);
    }
    const value = parsed as Record<string, unknown>;
    const config: CliConfig = {};
    if (typeof value.endpoint === "string") config.endpoint = value.endpoint;
    if (typeof value.allowInsecureLocalhost === "boolean") config.allowInsecureLocalhost = value.allowInsecureLocalhost;
    if (typeof value.model === "string") config.model = value.model;
    if (Array.isArray(value.commandEnv)) config.commandEnv = value.commandEnv.filter((v): v is string => typeof v === "string");
    if (Array.isArray(value.trustedRoots)) config.trustedRoots = value.trustedRoots.filter((v): v is string => typeof v === "string");
    return config;
};

export const writeConfig = (config: CliConfig, env: NodeJS.ProcessEnv = process.env) => {
    ensureHome(env);
    const path = configPath(env);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
};

export class ConfigError extends Error {}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * The one base URL the key is ever sent to. https, or http for a loopback
 * host when the user explicitly allowed it. No credentials, query or fragment
 * in it, and it must end at the API root (`/api/v1`) so a mistyped site URL
 * is caught here rather than by a redirect.
 */
export const resolveEndpoint = (config: CliConfig, env: NodeJS.ProcessEnv = process.env) => {
    const raw = (env.TOMVERSE_ENDPOINT?.trim() || config.endpoint || DEFAULT_ENDPOINT).trim();
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new ConfigError(`The endpoint '${raw}' is not a URL.`);
    }
    if (url.username || url.password) throw new ConfigError("The endpoint must not contain a user name or password.");
    if (url.search || url.hash) throw new ConfigError("The endpoint must not contain a query or fragment.");
    const insecureAllowed = config.allowInsecureLocalhost === true || env.TOMVERSE_ALLOW_INSECURE_LOCALHOST === "1";
    if (url.protocol === "http:") {
        if (!LOOPBACK.has(url.hostname)) throw new ConfigError("The endpoint must use https. http is only for a loopback development server.");
        if (!insecureAllowed) {
            throw new ConfigError(
                "This http endpoint is a loopback development server. Allow it with `tomverse config set allow-insecure-localhost true`."
            );
        }
    } else if (url.protocol !== "https:") {
        throw new ConfigError("The endpoint must use https.");
    }
    const path = url.pathname.replace(/\/+$/, "");
    if (!path.endsWith("/api/v1")) {
        throw new ConfigError(`The endpoint must be the API root ending in /api/v1, for example ${DEFAULT_ENDPOINT}.`);
    }
    return { base: `${url.origin}${path}`, origin: url.origin, basePath: path };
};

export type Endpoint = ReturnType<typeof resolveEndpoint>;
