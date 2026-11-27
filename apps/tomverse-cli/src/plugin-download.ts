import { createHash } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { PluginError } from "./plugin-fs.js";

/**
 * The one place a plugin archive or an npm package's files are downloaded over https. The address must be https without a user name or
 * password, and not a name or number that only means this computer or its network. The connection itself is held to the same rule: the
 * names an address resolves to are looked up here and refused if any is a private, loopback, link-local or otherwise internal address,
 * and the connection is made to exactly the address that passed (so a name that answers differently a second time gets no second
 * chance). Every redirect is checked the same way and may not leave https; the body is read up to a size and a time limit. No cookie,
 * no token and no program setting is sent. The caller says what the download is for, so a failure reads in plain words.
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

const internalIpv4 = (bytes: readonly number[]) => {
    const [a = 0, b = 0, c = 0] = bytes;
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
};

/** Eight groups as sixteen bytes, or null when the text is not an IPv6 address. */
const ipv6Bytes = (text: string): number[] | null => {
    let value = text.toLowerCase().split("%")[0]!;
    const lastColon = value.lastIndexOf(":");
    const tail = value.slice(lastColon + 1);
    if (tail.includes(".")) {
        const quad = tail.split(".").map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
        if (quad.length !== 4 || quad.some((part) => !(part >= 0 && part <= 255))) return null;
        value = `${value.slice(0, lastColon + 1)}${((quad[0]! << 8) | quad[1]!).toString(16)}:${((quad[2]! << 8) | quad[3]!).toString(16)}`;
    }
    const halves = value.split("::");
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(":") : [];
    const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
    if (halves.length === 2 && fill < 1) return null;
    const groups = [...head, ...Array<string>(Math.max(0, fill)).fill("0"), ...rest];
    if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
    return groups.flatMap((group) => [parseInt(group, 16) >> 8, parseInt(group, 16) & 255]);
};

/**
 * Whether a numeric address is one a download must not be sent to. An IPv6 address that carries an IPv4 one (mapped, NAT64, 6to4) is
 * judged by the IPv4 address inside it, whichever way it is written; an address that cannot be read is refused.
 */
export const isInternalAddress = (address: string): boolean => {
    const host = address.trim().replace(/^\[|\]$/g, "");
    const version = isIP(host);
    if (version === 4) return internalIpv4(host.split(".").map(Number));
    if (version !== 6) return true;
    const b = ipv6Bytes(host);
    if (!b) return true;
    const zeroUntil = (end: number) => b.slice(0, end).every((byte) => byte === 0);
    if (zeroUntil(10) && b[10] === 0xff && b[11] === 0xff) return internalIpv4(b.slice(12));
    if (zeroUntil(12)) return true; // ::, ::1 and the deprecated IPv4-compatible form
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((byte) => byte === 0)) return internalIpv4(b.slice(12));
    if (b[0] === 0x20 && b[1] === 0x02) return internalIpv4(b.slice(2, 6));
    if (b[0] === 0x20 && b[1] === 0x01 && (b[2] === 0x00 && b[3] === 0x00)) return true; // Teredo
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation
    if (b[0] === 0x01 && b[1] === 0x00 && b.slice(2, 8).every((byte) => byte === 0)) return true; // discard-only
    return (b[0]! & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1]! & 0xc0) >= 0x80) || b[0] === 0xff; // unique local, link-local and site-local, multicast
};

/** Names and numbers that mean this computer or its own network. A name is judged again by what it resolves to (see `publicLookup`). */
const internalHost = (hostname: string) => {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (isIP(host)) return isInternalAddress(host);
    return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".");
};

type Resolver = (hostname: string, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/**
 * A `lookup` for the connection: resolves the name, refuses it when any answer is an internal address, and hands the connection exactly
 * the addresses that were checked. `resolve` is for tests.
 */
export const publicLookup = (resolve: Resolver = (hostname, callback) => dnsLookup(hostname, { all: true }, callback)): LookupFunction => (hostname, options, callback) => {
    resolve(hostname, (error, addresses) => {
        const refuse = (cause: NodeJS.ErrnoException) => (callback as unknown as (error: NodeJS.ErrnoException | null, address: string, family: number) => void)(cause, "", 0);
        if (error) return refuse(error);
        const wanted = options.family === 4 || options.family === 6 ? addresses.filter((entry) => entry.family === options.family) : addresses;
        if (!wanted.length || wanted.some((entry) => isInternalAddress(entry.address))) {
            return refuse(Object.assign(new Error("The address resolves to this computer or a private network."), { code: "EPLUGINADDR" }) as NodeJS.ErrnoException);
        }
        if (options.all) (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, wanted);
        else callback(null, wanted[0]!.address, wanted[0]!.family);
    });
};

/** The network: an https request whose connection goes through `publicLookup`, answered as a `Response` (no redirect is followed). */
const guardedFetch: DownloadFetch = (url, init) => new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(url, { method: "GET", headers: init.headers, lookup: publicLookup(), signal: init.signal }, (answer) => {
        const status = answer.statusCode ?? 0;
        if (status < 200 || status > 599) {
            answer.destroy();
            return reject(new Error("unusable status"));
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(answer.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        const noBody = status === 204 || status === 205 || status === 304;
        if (noBody) answer.resume();
        resolve(new Response(noBody ? null : (Readable.toWeb(answer) as unknown as WebReadableStream<Uint8Array>), { status, headers }));
    });
    request.on("error", reject);
    request.end();
});

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
    const fetcher: DownloadFetch = options.fetchImpl ?? guardedFetch;
    const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 120_000)]);
    let url = checkDownloadUrl(address, what);
    for (let hop = 0; ; hop += 1) {
        let response: Response;
        try {
            response = await fetcher(url.toString(), { signal, redirect: "manual", headers: { Accept: options.accept ?? "*/*", "User-Agent": "tomverse-plugin-installer" } });
        } catch (error) {
            if (options.signal?.aborted) throw new PluginError("The download was cancelled.");
            if ((error as NodeJS.ErrnoException | undefined)?.code === "EPLUGINADDR") {
                throw new PluginError(`A ${what} may not come from this computer or a private network address (${shownUrl(url.toString())} resolves to one).`);
            }
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
