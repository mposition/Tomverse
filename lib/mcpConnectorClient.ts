import "server-only";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_LIMITS, McpConnectorError, type McpServerPolicy } from "@/lib/mcpConnectorPolicy";
import { boundedMcpOutputValidator } from "@/lib/mcpConnectorSchema";

const blocked = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) blocked.addSubnet(ip, prefix, "ipv4");
const globalV6 = new BlockList(); globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
blockedV6.addSubnet("2001::", 23, "ipv6");
blockedV6.addSubnet("2001:db8::", 32, "ipv6");
blockedV6.addSubnet("2002::", 16, "ipv6");
export function publicMcpAddress(ip: string) {
  return isIP(ip) === 4 ? !blocked.check(ip, "ipv4") :
    isIP(ip) === 6 && globalV6.check(ip, "ipv6") && !blockedV6.check(ip, "ipv6");
}
export function validateMcpEndpoint(server: McpServerPolicy, oauthEndpoint = false) {
  const url = new URL(server.url);
  const synthetic = server.id === "synthetic" && process.env.NODE_ENV !== "production" &&
    url.origin === `http://127.0.0.1:${process.env.MCP_CONNECTOR_SYNTHETIC_PORT}` &&
    (oauthEndpoint ? ["/register", "/token", "/authorize", "/"].includes(url.pathname) : url.pathname === "/mcp");
  if (url.username || url.password || url.hash || url.search ||
    (!synthetic && (url.protocol !== "https:" || (url.port && url.port !== "443"))) ||
    (!synthetic && isIP(url.hostname.replace(/^\[|\]$/g, "")) && !publicMcpAddress(url.hostname.replace(/^\[|\]$/g, "")))) {
    throw new McpConnectorError("unsafe_endpoint");
  }
  return { url, synthetic };
}

export async function resolvePublicMcpEndpoint(server: McpServerPolicy, signal: AbortSignal, oauthEndpoint = false) {
  const { url, synthetic } = validateMcpEndpoint(server, oauthEndpoint);
  signal.throwIfAborted();
  const addresses = synthetic ? [{ address: "127.0.0.1", family: 4 }] : await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    const abort = () => reject(new McpConnectorError("cancelled_or_timeout"));
    signal.addEventListener("abort", abort, { once: true });
    void lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
  signal.throwIfAborted();
  if (!addresses.length || (!synthetic && addresses.some(a => !publicMcpAddress(a.address)))) throw new McpConnectorError("unsafe_address");
  return { url, synthetic, addresses };
}

// DNS is checked and the selected address is pinned to the actual socket.
// No automatic redirects, discovery, OAuth, cookies, SSE reconnection or retry.
export function guardedMcpFetch(server: McpServerPolicy, token: string | null, signal: AbortSignal, oauthEndpoint = false) {
  const { url, synthetic } = validateMcpEndpoint(server, oauthEndpoint);
  let requests = 0;
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (String(input instanceof Request ? input.url : input) !== url.href) throw new McpConnectorError("unexpected_endpoint");
    const method = init?.method || "GET";
    // Standalone notification streams are unnecessary for bounded foreground calls.
    if (method === "GET") return new Response(null, { status: 405 });
    if (!["POST", "DELETE"].includes(method) || ++requests > 8) throw new McpConnectorError("request_limit");
    const combined = AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]);
    combined.throwIfAborted();
    const { addresses } = await resolvePublicMcpEndpoint(server, combined, oauthEndpoint);
    const headers = new Headers(init?.headers);
    headers.delete("cookie"); headers.delete("authorization");
    if (token) headers.set("authorization", `Bearer ${token}`);
    headers.set("host", url.host);
    const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : undefined;
    if (body && Buffer.byteLength(body) > MCP_LIMITS.inputBytes * 2) throw new McpConnectorError("input_limit");
    return new Promise<Response>((resolve, reject) => {
      const request = (synthetic ? httpRequest : httpsRequest)({
        hostname: addresses[0].address, port: url.port || (synthetic ? 80 : 443),
        servername: url.hostname, path: url.pathname, method,
        // Each credentialed request gets a fresh, name-verified TLS session.
        agent: false,
        rejectUnauthorized: true,
        headers: Object.fromEntries(headers), signal: combined,
      }, response => {
        const status = response.statusCode || 500;
        if (status >= 300 && status < 400) { response.destroy(); reject(new McpConnectorError("redirect_refused")); return; }
        if (status === 401 || status === 403) { response.destroy(); reject(new McpConnectorError("reauth_required", 401)); return; }
        const length = Number(response.headers["content-length"]);
        if (length > MCP_LIMITS.responseBytes) { response.destroy(); reject(new McpConnectorError("response_limit")); return; }
        let bytes = 0;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > MCP_LIMITS.responseBytes) { response.destroy(new McpConnectorError("response_limit")); return; }
              controller.enqueue(new Uint8Array(chunk));
            });
            response.on("end", () => controller.close());
            response.on("error", error => controller.error(error));
          },
          cancel() { response.destroy(); request.destroy(); },
        });
        const responseHeaders = new Headers();
        for (const name of ["content-type", "mcp-session-id", "mcp-protocol-version"]) {
          const value = response.headers[name]; if (typeof value === "string") responseHeaders.set(name, value);
        }
        resolve(new Response([204, 205, 304].includes(status) ? null : stream, { status, headers: responseHeaders }));
      });
      request.on("error", reject);
      request.end(body);
    });
  };
}

export async function withMcpClient<T>(input: {
  server: McpServerPolicy; token?: string | null; signal?: AbortSignal;
}, run: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.any([AbortSignal.timeout(MCP_LIMITS.requestMs), ...(input.signal ? [input.signal] : [])]);
  const client = new Client({ name: "tomverse-connector-preview", version: "1.0.0" }, { capabilities: {}, jsonSchemaValidator: boundedMcpOutputValidator });
  const transport = new StreamableHTTPClientTransport(new URL(input.server.url), {
    fetch: guardedMcpFetch(input.server, input.token || null, signal),
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 0, maxReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
  });
  // Deliberately do not surface remote errors, instructions or logging.
  client.onerror = () => {};
  try {
    await client.connect(transport, { signal, timeout: MCP_LIMITS.requestMs });
    return await run(client, signal);
  } finally {
    if (!signal.aborted && transport.sessionId) {
      await transport.terminateSession().catch(() => {});
    }
    await client.close().catch(() => {});
  }
}
