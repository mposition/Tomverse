import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * User-owned configuration. It lives in the user's home (or TOMVERSE_HOME),
 * never in the workspace, and nothing a repository contains -- instructions,
 * scripts, model output -- is read as configuration. The API key is never
 * part of it.
 */

/** The coding API (Tomverse's /api/code/v1): the CLI is a coding client. */
export const DEFAULT_ENDPOINT = "https://tomverse.app/api/code/v1";

const CODING_API_ROOT = "/api/code/v1";
/** The general API root an endpoint saved before the CLI moved to the coding API ends in. */
const GENERAL_API_ROOT = "/api/v1";

export type CliConfig = {
    endpoint?: string;
    /** Allows http:// only for a loopback host. For local development. */
    allowInsecureLocalhost?: boolean;
    model?: string;
    /** Extra environment variable names passed to approved commands. */
    commandEnv?: string[];
    /** Notes the agent keeps about a project for later tasks. On unless set to false; when off nothing is read or written. */
    memory?: boolean;
    /** Lets an agent definition's model name pick the model of its subagent runs. Off unless set to true: it is a billing choice. */
    agentModels?: boolean;
    /**
     * Subagent orchestration for new sessions: parallel subtasks with write scopes and verification. Off unless set to true, because it
     * can use several times the requests of a plain task. The two numbers are how many subagents run at once and how many requests they share.
     */
    orchestrate?: boolean;
    orchestrateMaxSubagents?: number;
    orchestrateMaxRequests?: number;
    /** MCP servers and hooks (mcp.json, hooks.json and the folder's own files). On unless set to false. */
    mcp?: boolean;
    hooks?: boolean;
    /** Folders the user has said the CLI may work in (real paths). */
    trustedRoots?: string[];
    /** An operating-system sandbox for approved commands: off (the default), workspace-write or read-only. See sandbox.ts. */
    sandbox?: string;
    /** The hosts a sandboxed command may reach through the filtering proxy. When absent a small list of package registries is used. */
    sandboxDomains?: string[];
    /** Lets a sandboxed command connect to localhost. Off unless set to true. */
    sandboxLocalhost?: boolean;
};

export const tomverseHome = (env: NodeJS.ProcessEnv = process.env) =>
    env.TOMVERSE_HOME?.trim() || join(homedir(), ".tomverse");

const configPath = (env: NodeJS.ProcessEnv) => join(tomverseHome(env), "config.json");

export const ensureHome = (env: NodeJS.ProcessEnv = process.env) => {
    const home = tomverseHome(env);
    const created = !existsSync(home);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    // Only a folder the CLI just created is made private; an existing one keeps
    // its permissions (the session folders inside are private either way).
    if (created && process.platform !== "win32") chmodSync(home, 0o700);
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
    if (typeof value.memory === "boolean") config.memory = value.memory;
    if (typeof value.agentModels === "boolean") config.agentModels = value.agentModels;
    if (typeof value.orchestrate === "boolean") config.orchestrate = value.orchestrate;
    if (typeof value.orchestrateMaxSubagents === "number") config.orchestrateMaxSubagents = value.orchestrateMaxSubagents;
    if (typeof value.orchestrateMaxRequests === "number") config.orchestrateMaxRequests = value.orchestrateMaxRequests;
    if (typeof value.mcp === "boolean") config.mcp = value.mcp;
    if (typeof value.hooks === "boolean") config.hooks = value.hooks;
    if (Array.isArray(value.trustedRoots)) config.trustedRoots = value.trustedRoots.filter((v): v is string => typeof v === "string");
    if (typeof value.sandbox === "string") config.sandbox = value.sandbox;
    if (Array.isArray(value.sandboxDomains)) config.sandboxDomains = value.sandboxDomains.filter((v): v is string => typeof v === "string");
    if (typeof value.sandboxLocalhost === "boolean") config.sandboxLocalhost = value.sandboxLocalhost;
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
 * in it, and it must end at the coding API root (`/api/code/v1`) so a
 * mistyped site URL is caught here rather than by a redirect. An endpoint
 * saved before the CLI moved to the coding API ends at the general root
 * (`/api/v1`); it is read as the coding API on the same server, so a saved
 * configuration keeps working without being rewritten.
 */
export type Endpoint = {
    base: string;
    origin: string;
    basePath: string;
    /** The general-API endpoint as saved, when it was read as the coding API. */
    movedFrom?: string;
    /** Where the moved endpoint came from: TOMVERSE_ENDPOINT outranks the saved config. */
    movedFromSource?: "env" | "config";
};

export const resolveEndpoint = (config: CliConfig, env: NodeJS.ProcessEnv = process.env): Endpoint => {
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
    const given = url.pathname.replace(/\/+$/, "");
    const path =
        !given.endsWith(CODING_API_ROOT) && given.endsWith(GENERAL_API_ROOT)
            ? `${given.slice(0, -GENERAL_API_ROOT.length)}${CODING_API_ROOT}`
            : given;
    if (!path.endsWith(CODING_API_ROOT)) {
        throw new ConfigError(`The endpoint must be the coding API root ending in ${CODING_API_ROOT}, for example ${DEFAULT_ENDPOINT}.`);
    }
    const base = `${url.origin}${path}`;
    if (path === given) return { base, origin: url.origin, basePath: path };
    const movedFromSource = env.TOMVERSE_ENDPOINT?.trim() ? "env" : "config";
    return { base, origin: url.origin, basePath: path, movedFrom: `${url.origin}${given}`, movedFromSource };
};

/** One line for doctor and `config show` when a general-API endpoint was read as the coding API. */
export const endpointMoveNote = (endpoint: Endpoint) => {
    if (!endpoint.movedFrom) return null;
    // The fix differs by source: saving the config does not change an environment variable that outranks it.
    const fix =
        endpoint.movedFromSource === "env"
            ? `set TOMVERSE_ENDPOINT=${endpoint.base}`
            : `save it with: tomverse config set endpoint ${endpoint.base}`;
    const where = endpoint.movedFromSource === "env" ? "TOMVERSE_ENDPOINT is" : "saved as";
    return `${where} ${endpoint.movedFrom}, which is Tomverse's general API; the CLI uses the coding API ${endpoint.base} instead (${fix})`;
};
