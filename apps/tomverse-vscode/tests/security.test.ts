import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { endpointFromUser, environmentProblem, namespace, parseMessage, redact, redactJson } from "../src/security.js";
import { messages, localeFor } from "../src/translations.js";

test("host protocol rejects arbitrary fields, oversized text, forged commands and approval payloads", () => {
    const base = { channel: "host", run: "run" };
    assert.ok(parseMessage({ ...base, type: "approve", id: "id", decision: "once" }));
    for (const value of [
        null,
        {},
        { ...base, type: "approve", id: "id", decision: "once", input: { argv: ["evil"] } },
        { ...base, type: "action", action: "openExternal", url: "https://evil.test" },
        { ...base, type: "send", epoch: "x", prompt: "x".repeat(40_001), mode: "agent", model: "x" },
    ])
        assert.equal(parseMessage(value), null);
});
test("endpoint reads only explicit user values, rejects redirect destinations and secret URL components", () => {
    const old = process.env.TOMVERSE_ENDPOINT;
    process.env.TOMVERSE_ENDPOINT = "https://evil.test/api/code/v1";
    try {
        assert.equal(endpointFromUser().base, "https://tomverse.app/api/code/v1");
    } finally {
        if (old === undefined) delete process.env.TOMVERSE_ENDPOINT;
        else process.env.TOMVERSE_ENDPOINT = old;
    }
    for (const endpoint of [
        "https://user:pass@example.org/api/code/v1",
        "https://example.org/api/code/v1?key=x",
        "http://example.org/api/code/v1",
        "https://example.org/not-api",
    ])
        assert.throws(() => endpointFromUser(endpoint, true));
    assert.throws(() => endpointFromUser("http://127.0.0.1/api/code/v1"));
});
test("namespaces separate full base, root, credential identity and never contain raw credentials", () => {
    const key = "tv_local_fixture_1234567890";
    const n = namespace("root", "https://host/api/code/v1", key);
    assert.equal(n.length, 64);
    assert.notEqual(n, namespace("root", "https://host/other/api/code/v1", key));
    assert.notEqual(n, namespace("root2", "https://host/api/code/v1", key));
    assert.notEqual(n, namespace("root", "https://host/api/code/v1", key + "x"));
    assert.equal(redact(`prefix ${key} Bearer abc`, key).includes(key), false);
});
test("trust, remote, virtual, web and unsupported architectures are denied before work", () => {
    const env = { trusted: true, web: false, schemes: ["file"], platform: "win32", arch: "x64" };
    assert.equal(environmentProblem(env), null);
    assert.equal(environmentProblem({ ...env, trusted: false }), "restricted");
    for (const patch of [
        { remote: "ssh-remote" },
        { remote: "wsl" },
        { remote: "dev-container" },
        { web: true },
        { schemes: ["vscode-vfs"] },
        { arch: "ia32" },
    ])
        assert.equal(environmentProblem({ ...env, ...patch }), "unsupported");
    assert.equal(environmentProblem({ ...env, platform: "darwin", arch: "arm64" }), null);
    assert.equal(environmentProblem({ ...env, platform: "linux" }), null);
});
test("eight locales have complete UI key parity and Chinese language mapping", () => {
    assert.equal(Object.keys(messages).length, 8);
    for (const locale of Object.values(messages)) {
        assert.deepEqual(Object.keys(locale), Object.keys(messages.en));
        for (const value of Object.values(locale)) assert.ok(value.length);
    }
    assert.equal(localeFor("zh-tw"), "zhHant");
    assert.equal(localeFor("zh-cn"), "zh");
    assert.equal(localeFor("ko-KR"), "ko");
});
test("webview only uses text nodes, CSP resources and keeps IME composition from sending", () => {
    const source = readFileSync(new URL("../media/sidebar.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|eval\(|fetch\(/);
    assert.match(source, /event\.isComposing/);
    assert.match(source, /textContent/);
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(manifest.capabilities.untrustedWorkspaces.supported, "limited");
    assert.equal(manifest.capabilities.virtualWorkspaces.supported, false);
    assert.equal(manifest.contributes.configuration.properties["tomverse.endpoint"].scope, "application");
});

test("redaction preserves JSON syntax for quoted Bearer text, slashes, controls and keys", () => {
    const key = "tv_fixture_1234567890";
    const values = ['Bearer "token"', 'Bearer \\"token\\"', "Bearer \\n", 'quotes " slash \\ tab\t', key];
    const result = JSON.parse(redactJson({ messages: values, [key]: key }, key));
    assert.equal(result.messages.length, values.length);
    assert.equal(redactJson(result, key).includes(key), false);
    for (let i = 0; i < values.length; i++) assert.equal(result.messages[i], redact(values[i], key));
});
