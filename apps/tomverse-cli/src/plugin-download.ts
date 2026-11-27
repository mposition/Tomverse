import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { PluginError } from "./plugin-fs.js";

/**
 * The one place a plugin archive or an npm package's files are downloaded over https. The address must be https without a user name or
 * password, and not a name or number that only means this computer or its network; every redirect is checked the same way (and may not
 * leave https); the body is read up to a size and a time limit. No cookie, no token and no program setting is sent. The caller says
 * what the download is for, so a failure reads in plain words.
 */

export type DownloadFetch = (url: string, init: { signal: AbortSignal; redirect: "manual"; headers: Record<string, string> }) => Promise<Response>;

export type DownloadOptions = {
    maxBytes: number;
    signal?: AbortSignal;
    timeoutMs?: number;
    accept?: string;
    /** For tests: a stand-in for the network. */
    fetchImpl?: DownloadFetch;
};

const MAX_REDIRECTS = 5;

export const sha256Hex = (data: Buffer) => createHash("sha256").update(data).digest("hex");

const internalIpv4 = (text: string) => {
    const [a = 0, b = 0] = text.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};

/** Names and numbers that mean this computer or its own network. A public name that resolves to one is not caught here. */
const internalHost = (hostname: string) => {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || (!host.includes(".") && isIP(host) === 0)) return true;
    const version = isIP(host);
    if (version === 4) return internalIpv4(host);
    if (version === 6) {
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
        if (mapped) return internalIpv4(mapped[1]!);
        return host === "::" || host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
    }
    return false;
};

/** An https address for a download, or a PluginError that says why not. */
export const checkDownloadUrl = (text: string, what = "download"): URL => {
    const value = text.trim();
    if (!value || value.length > 1000 || /[\u0000-\u001f\u007f\s]/.test(value)) throw new PluginError(`That is not an address for a ${what}.`);
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new PluginError(`That is not an address for a ${what}.`);
    }
    if (url.protocol !== "https:") throw new PluginError(`A ${what} must come from an https:// address.`);
    if (url.username || url.password) throw new PluginError("An address with a user name or password is not accepted: this app stores no credentials.");
    if (internalHost(url.hostname)) throw new PluginError(`A ${what} may not come from this computer or a private network address.`);
    return url;
};

/** Hides the query and fragment of an address in anything shown or logged (they can carry a signature). */
export const shownUrl = (url: string) => {
    try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.slice(0, 300);
    } catch {
        return url.replace(/[?#].*$/, "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
    }
};

export const downloadBytes = async (address: string, options: DownloadOptions & { what?: string }): Promise<Buffer> => {
    const what = options.what ?? "download";
    const fetcher: DownloadFetch = options.fetchImpl ?? ((url, init) => fetch(url, { ...init, credentials: "omit" }));
    const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 120_000)]);
    let url = checkDownloadUrl(address, what);
    for (let hop = 0; ; hop += 1) {
        let response: Response;
        try {
            response = await fetcher(url.toString(), { signal, redirect: "manual", headers: { Accept: options.accept ?? "*/*", "User-Agent": "tomverse-plugin-installer" } });
        } catch {
            if (options.signal?.aborted) throw new PluginError("The download was cancelled.");
            throw new PluginError(`The ${what} could not be downloaded from ${shownUrl(url.toString())}.`);
        }
        if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel().catch(() => undefined);
            const location = response.headers.get("location");
            if (!location || hop >= MAX_REDIRECTS) throw new PluginError(`The ${what} was redirected too many times.`);
            try {
                url = checkDownloadUrl(new URL(location, url).toString(), what);
            } catch (error) {
                if (error instanceof PluginError) throw new PluginError(`The ${what} was redirected somewhere not allowed: ${error.message}`);
                throw error;
            }
            continue;
        }
        if (response.status !== 200) {
            await response.body?.cancel().catch(() => undefined);
            throw new PluginError(`The ${what} failed: ${shownUrl(url.toString())} answered ${response.status}.`);
        }
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > options.maxBytes) {
            await response.body?.cancel().catch(() => undefined);
            throw new PluginError(`The ${what} is larger than ${Math.floor(options.maxBytes / 1024 / 1024)} MB.`);
        }
        if (!response.body) throw new PluginError(`The ${what} came back empty.`);
        const chunks: Buffer[] = [];
        let total = 0;
        try {
            for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
                total += chunk.length;
                if (total > options.maxBytes) throw new PluginError(`The ${what} is larger than ${Math.floor(options.maxBytes / 1024 / 1024)} MB.`);
                chunks.push(Buffer.from(chunk));
            }
        } catch (error) {
            await response.body.cancel().catch(() => undefined);
            if (error instanceof PluginError) throw error;
            if (options.signal?.aborted) throw new PluginError("The download was cancelled.");
            throw new PluginError(`The ${what} was interrupted.`);
        }
        return Buffer.concat(chunks);
    }
};
