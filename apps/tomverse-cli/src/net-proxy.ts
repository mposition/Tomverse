import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { lookup } from "node:dns/promises";
import { connect, isIP, type Socket } from "node:net";
import { rmSync } from "node:fs";
import type { Duplex } from "node:stream";
import { isPrivateAddress } from "./web.js";

/**
 * A filtering HTTP proxy for sandboxed commands. A command gets HTTP_PROXY and
 * HTTPS_PROXY pointing here; the sandbox (where the OS can do it) lets it reach
 * nothing else. Only the host name is judged: HTTPS is tunnelled with CONNECT
 * and never opened, so this sees where a request goes and not what it says.
 *
 * Rules, all of them checked here and not left to the caller:
 *  - the host must match an entry of the allow list (`registry.npmjs.org`
 *    matches that host only; `*.example.com` matches its subdomains, not
 *    `example.com` itself);
 *  - only ports 80 and 443;
 *  - the name is resolved here, once, and the connection goes to the address
 *    that came back, so the name cannot change under the check; an address in
 *    a loopback, private, link-local or unspecified range is refused unless
 *    the person listed that exact IP address.
 */

export const DEFAULT_ALLOWED_DOMAINS = [
    "registry.npmjs.org",
    "registry.yarnpkg.com",
    "pypi.org",
    "files.pythonhosted.org",
    "index.crates.io",
    "static.crates.io",
    "crates.io",
    "proxy.golang.org",
    "sum.golang.org",
] as const;

const MAX_ENTRIES = 200;
const HOST_PATTERN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Lower-cases, trims, drops duplicates and anything that is not a plain host name, `*.host` pattern or IP address. */
export const normalizeAllowedDomains = (raw: unknown): string[] => {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const item of raw) {
        if (typeof item !== "string") continue;
        const value = item.trim().toLowerCase().replace(/\.$/, "");
        if (!value || value.length > 253 || out.includes(value)) continue;
        if (isIP(value) || HOST_PATTERN.test(value)) out.push(value);
        if (out.length >= MAX_ENTRIES) break;
    }
    return out;
};

export const hostAllowed = (host: string, allowed: readonly string[]) => {
    const name = host.toLowerCase().replace(/\.$/, "");
    return allowed.some((entry) => (entry.startsWith("*.") ? name.endsWith(entry.slice(1)) && name.length > entry.length - 1 : entry === name));
};

/**
 * True for an address the proxy refuses to connect to unless it was listed by name as an IP address. The judgement is
 * web_fetch's (web.ts): it reads an IPv6 address by its groups, so an IPv4 address carried in one (mapped in either
 * notation, compatible, NAT64, 6to4) is judged as that IPv4 address, and anything outside global unicast is refused.
 */
export const privateAddress = (address: string): boolean => isPrivateAddress(address);

export type ProxyDecision = { host: string; port: number; allowed: boolean; reason?: string };

export type FilteringProxy = {
    /** TCP port on 127.0.0.1. */
    port: number;
    /** A Unix socket for a sandbox that has no network of its own (Linux), when asked for. */
    socketPath?: string;
    url: string;
    decisions: ProxyDecision[];
    setAllowed(domains: readonly string[]): void;
    close(): Promise<void>;
};

export type ProxyOptions = {
    allowed: readonly string[];
    unixSocketPath?: string;
    /** Test hook: how a name is resolved. */
    resolve?: (host: string) => Promise<string>;
    /** Ports a request may name. Default 80 and 443; a test points it at its own server. */
    ports?: readonly number[];
    /** Test hook: lets an allowed name reach a loopback address, so a test server can stand in for a site. */
    allowPrivateAddresses?: boolean;
    /** Called for each request the proxy judged. */
    onDecision?: (decision: ProxyDecision) => void;
};

const defaultResolve = async (host: string) => (await lookup(host)).address;

const refusal = (host: string, why: string) =>
    `Blocked by the Tomverse sandbox: ${why} (${host}). The sandbox only allows the sites on its allowed list; the person can add this one in the sandbox settings.\n`;

export async function startFilteringProxy(options: ProxyOptions): Promise<FilteringProxy> {
    let allowed = normalizeAllowedDomains([...options.allowed]);
    const resolve = options.resolve ?? defaultResolve;
    const openPorts = new Set(options.ports ?? [80, 443]);
    const decisions: ProxyDecision[] = [];
    const sockets = new Set<Socket | Duplex>();
    const track = (socket: Socket | Duplex) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => socket.destroy());
    };
    const decide = (host: string, port: number): ProxyDecision & { ok: boolean } => {
        let reason: string | undefined;
        if (!openPorts.has(port)) reason = "only ports 80 and 443 are open";
        else if (!hostAllowed(host, allowed)) reason = "this site is not on the allowed list";
        const decision = { host, port, allowed: !reason, ...(reason ? { reason } : {}) };
        decisions.push(decision);
        if (decisions.length > 200) decisions.shift();
        options.onDecision?.(decision);
        return { ...decision, ok: !reason };
    };
    /** The address to connect to, or why not. */
    const target = async (host: string): Promise<{ address: string } | { error: string }> => {
        let address: string;
        try {
            address = isIP(host) ? host : await resolve(host);
        } catch {
            return { error: "the name did not resolve" };
        }
        if (privateAddress(address) && !options.allowPrivateAddresses && !(isIP(host) && hostAllowed(host, allowed))) return { error: "the name points to a local or private address" };
        return { address };
    };

    const onRequest = async (req: IncomingMessage, res: ServerResponse) => {
        let url: URL;
        try {
            url = new URL(req.url ?? "");
        } catch {
            res.writeHead(400, { "content-type": "text/plain" }).end("Proxy requests need an absolute http:// address.\n");
            return;
        }
        if (url.protocol !== "http:") {
            res.writeHead(400, { "content-type": "text/plain" }).end("Only http:// is forwarded; https uses CONNECT.\n");
            return;
        }
        const port = Number(url.port || 80);
        const host = url.hostname.replace(/^\[|\]$/g, "");
        const decision = decide(host, port);
        if (!decision.ok) {
            res.writeHead(403, { "content-type": "text/plain" }).end(refusal(host, decision.reason!));
            return;
        }
        const resolved = await target(host);
        if ("error" in resolved) {
            res.writeHead(403, { "content-type": "text/plain" }).end(refusal(host, resolved.error));
            return;
        }
        const headers = { ...req.headers };
        delete headers["proxy-connection"];
        delete headers["proxy-authorization"];
        const upstream = httpRequest({ host: resolved.address, port, method: req.method, path: `${url.pathname}${url.search}`, headers: { ...headers, host: url.host } }, (answer) => {
            res.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(res);
        });
        upstream.on("error", () => {
            if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
            res.end("The site could not be reached.\n");
        });
        res.on("close", () => upstream.destroy());
        req.pipe(upstream);
    };

    const onConnect = async (req: IncomingMessage, client: Duplex, head: Buffer) => {
        track(client);
        const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? "");
        const reject = (status: string, body: string) => {
            client.end(`HTTP/1.1 ${status}\r\ncontent-type: text/plain\r\nconnection: close\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
        };
        if (!match) return reject("400 Bad Request", "A CONNECT request needs host:port.\n");
        const host = match[1]!.replace(/^\[|\]$/g, "");
        const port = Number(match[2]);
        const decision = decide(host, port);
        if (!decision.ok) return reject("403 Forbidden", refusal(host, decision.reason!));
        const resolved = await target(host);
        if ("error" in resolved) return reject("403 Forbidden", refusal(host, resolved.error));
        const upstream = connect({ host: resolved.address, port });
        track(upstream);
        let tunnelled = false;
        upstream.once("connect", () => {
            tunnelled = true;
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) upstream.write(head);
            upstream.pipe(client);
            client.pipe(upstream);
        });
        upstream.once("error", () => {
            if (tunnelled) client.destroy();
            else reject("502 Bad Gateway", "The site could not be reached.\n");
        });
        client.once("close", () => upstream.destroy());
        upstream.once("close", () => client.destroy());
    };

    const build = (): Server => {
        const server = createHttpServer((req, res) => void onRequest(req, res));
        server.on("connect", (req, socket, head) => void onConnect(req, socket, head));
        server.on("connection", track);
        server.on("clientError", (_error, socket) => socket.destroy());
        server.headersTimeout = 30_000;
        server.requestTimeout = 0;
        return server;
    };

    const tcp = build();
    await new Promise<void>((resolveListen, reject) => {
        tcp.once("error", reject);
        tcp.listen(0, "127.0.0.1", () => resolveListen());
    });
    const port = (tcp.address() as { port: number }).port;
    let unix: Server | null = null;
    if (options.unixSocketPath) {
        unix = build();
        const path = options.unixSocketPath;
        try {
            rmSync(path, { force: true });
        } catch {
            // stale socket from a crashed run; listen will report if it matters
        }
        await new Promise<void>((resolveListen, reject) => {
            unix!.once("error", reject);
            unix!.listen(path, () => resolveListen());
        });
    }
    return {
        port,
        ...(options.unixSocketPath ? { socketPath: options.unixSocketPath } : {}),
        url: `http://127.0.0.1:${port}`,
        decisions,
        setAllowed: (domains) => {
            allowed = normalizeAllowedDomains([...domains]);
        },
        close: async () => {
            for (const socket of sockets) socket.destroy();
            await Promise.all([tcp, unix].filter((server): server is Server => !!server).map((server) => new Promise<void>((done) => server.close(() => done()))));
            if (options.unixSocketPath) rmSync(options.unixSocketPath, { force: true });
        },
    };
}
