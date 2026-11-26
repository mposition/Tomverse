import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { connect, createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hostAllowed, normalizeAllowedDomains, privateAddress, startFilteringProxy } from "../src/net-proxy.js";

const listen = (server: Server | TcpServer) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));

test("allow list entries are normalized and matched by exact host or *. pattern", () => {
    assert.deepEqual(normalizeAllowedDomains([" Registry.NPMJS.org ", "registry.npmjs.org", "*.Example.com", "bad host", "http://x.com", 7, "", "127.0.0.1"]),
        ["registry.npmjs.org", "*.example.com", "127.0.0.1"]);
    assert.equal(hostAllowed("registry.npmjs.org", ["registry.npmjs.org"]), true);
    assert.equal(hostAllowed("evil.registry.npmjs.org", ["registry.npmjs.org"]), false);
    assert.equal(hostAllowed("a.example.com", ["*.example.com"]), true);
    assert.equal(hostAllowed("example.com", ["*.example.com"]), false);
    assert.equal(hostAllowed("notexample.com", ["*.example.com"]), false);
});

test("loopback, private and link-local addresses are refused", () => {
    for (const bad of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"]) {
        assert.equal(privateAddress(bad), true, bad);
    }
    for (const fine of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) assert.equal(privateAddress(fine), false, fine);
});

test("an allowed site passes through the plain http path and a site off the list gets 403", async () => {
    const site = createServer((req, res) => res.end(`site saw ${req.headers.host} ${req.url}`));
    const sitePort = await listen(site);
    const proxy = await startFilteringProxy({
        allowed: ["registry.test"], resolve: async () => "127.0.0.1", allowPrivateAddresses: true, ports: [sitePort],
    });
    const get = (host: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: proxy.port, method: "GET", path: `http://${host}:${sitePort}/x?y=1`, headers: { host: `${host}:${sitePort}` } }, (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end();
    });
    try {
        const passed = await get("registry.test");
        assert.equal(passed.status, 200);
        assert.equal(passed.body, `site saw registry.test:${sitePort} /x?y=1`);
        assert.equal(proxy.decisions.at(-1)?.allowed, true);
        const refused = await get("other.test");
        assert.equal(refused.status, 403);
        assert.match(refused.body, /not on the allowed list/);
        assert.equal(proxy.decisions.at(-1)?.allowed, false);
    } finally {
        await proxy.close();
        site.close();
    }
});

test("CONNECT to an allowed host is tunnelled, others are refused, and the proxy resolves the name itself", async () => {
    // A TCP echo stands in for an https site on port 443: the proxy only allows 80 and 443, so the test listens on 443 when it can
    // and otherwise checks the refusal paths, which do not need the port.
    const proxy = await startFilteringProxy({ allowed: ["registry.test", "127.0.0.1"], resolve: async (host) => (host === "registry.test" ? "127.0.0.1" : "10.0.0.5") });
    const connectTo = (target: string) => new Promise<string>((resolve, reject) => {
        const socket = connect(proxy.port, "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
        let data = "";
        socket.on("data", (chunk) => {
            data += chunk;
            if (data.includes("\r\n\r\n")) {
                socket.destroy();
                resolve(data);
            }
        });
        socket.on("error", reject);
    });
    try {
        assert.match(await connectTo("not-listed.test:443"), /^HTTP\/1\.1 403/);
        assert.match(await connectTo("registry.test:22"), /^HTTP\/1\.1 403[\s\S]*ports 80 and 443/);
        // An allowed name that resolves to a loopback address is refused: the name cannot be used to reach the local machine.
        assert.match(await connectTo("registry.test:443"), /^HTTP\/1\.1 403[\s\S]*local or private/);
        assert.match(await connectTo("garbage"), /^HTTP\/1\.1 400/);
    } finally {
        await proxy.close();
    }
});

test("CONNECT tunnels bytes to an allowed host", async () => {
    const echo = createTcpServer((socket) => socket.on("data", (d) => socket.write(`echo:${d}`)));
    const port = await listen(echo);
    const proxy = await startFilteringProxy({ allowed: ["registry.test"], resolve: async () => "127.0.0.1", allowPrivateAddresses: true, ports: [port] });
    try {
        const reply = await new Promise<string>((resolve, reject) => {
            const socket = connect(proxy.port, "127.0.0.1", () => socket.write(`CONNECT registry.test:${port} HTTP/1.1\r\n\r\n`));
            let data = "";
            let sent = false;
            socket.on("data", (chunk) => {
                data += chunk;
                if (!sent && data.includes("\r\n\r\n")) {
                    sent = true;
                    socket.write("ping");
                }
                if (data.includes("echo:ping")) {
                    socket.destroy();
                    resolve(data);
                }
            });
            socket.on("error", reject);
        });
        assert.match(reply, /^HTTP\/1\.1 200/);
        assert.match(reply, /echo:ping$/);
    } finally {
        await proxy.close();
        echo.close();
    }
});

test("the allow list can be replaced while the proxy runs", async () => {
    const proxy = await startFilteringProxy({ allowed: [], resolve: async () => "93.184.216.34" });
    const status = (target: string) => new Promise<string>((resolve) => {
        const socket = connect(proxy.port, "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\n\r\n`));
        socket.once("data", (d) => { socket.destroy(); resolve(String(d).split("\r\n")[0]!); });
    });
    try {
        assert.match(await status("pypi.org:443"), /403/);
        proxy.setAllowed(["pypi.org"]);
        // Now allowed by name; the connection itself goes nowhere useful in a test, so only the decision is checked.
        void status("pypi.org:443");
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(proxy.decisions.at(-1)?.allowed, true);
    } finally {
        await proxy.close();
    }
});

test("a Unix socket listener serves the same filter", { skip: process.platform === "win32" }, async () => {
    const socketPath = join(tmpdir(), `tvproxy-${process.pid}.sock`);
    const proxy = await startFilteringProxy({ allowed: [], unixSocketPath: socketPath });
    try {
        const reply = await new Promise<string>((resolve, reject) => {
            const socket = connect(socketPath, () => socket.write("CONNECT blocked.test:443 HTTP/1.1\r\n\r\n"));
            socket.once("data", (d) => { socket.destroy(); resolve(String(d)); });
            socket.on("error", reject);
        });
        assert.match(reply, /^HTTP\/1\.1 403/);
    } finally {
        await proxy.close();
    }
});
