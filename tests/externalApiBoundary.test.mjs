import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { requiresMutationOriginCheck } from "../lib/requestOrigin.ts";

// The condition for exempting /api/v1/chat/completions from the mutation
// Origin check (lib/requestOrigin.ts): its handler chain reads no session and
// no cookie, so the only credential it accepts is a Bearer key the caller must
// hold. If any of these files starts reading one, the exemption becomes a CSRF
// hole -- this test is that condition, written down.
const BEARER_FILES = [
    "app/api/v1/chat/completions/route.ts",
    "app/api/v1/models/route.ts",
    "app/api/v1/usage/route.ts",
    "lib/externalApiInference.ts",
    "lib/externalApiAdmission.ts",
    "lib/externalApiKeys.ts",
];
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Bearer routes read no session or cookie", () => {
    for (const file of BEARER_FILES) {
        const source = read(file);
        for (const forbidden of ["getServerSession", "next/headers", "cookies()", "resolveChatRouteSession", "requireMobileBearer"]) {
            assert.ok(!source.includes(forbidden), `${file} must not use ${forbidden}`);
        }
    }
});

test("only the exact completion path skips the Origin check", () => {
    assert.equal(requiresMutationOriginCheck("POST", "/api/v1/chat/completions"), false);
    assert.equal(requiresMutationOriginCheck("POST", "/api/v1/chat/completions/x"), true);
    assert.equal(requiresMutationOriginCheck("POST", "/api/v1/other"), true);
    assert.equal(requiresMutationOriginCheck("POST", "/api/user/api-keys"), true);
    assert.equal(requiresMutationOriginCheck("PATCH", "/api/user/api-keys/k1"), true);
    assert.equal(requiresMutationOriginCheck("DELETE", "/api/user/api-keys/k1"), true);
});

test("key management refuses any Authorization header instead of falling back to the cookie", () => {
    const routes = read("lib/externalApiRoutes.ts");
    assert.match(routes, /request\.headers\.has\("authorization"\)/);
    for (const file of ["app/api/user/api-keys/route.ts", "app/api/user/api-keys/[keyId]/route.ts"]) {
        assert.match(read(file), /withKeyManagementSession/, file);
        assert.ok(!read(file).includes("withBearerKey"), file);
    }
});

test("one request is one provider generation: no SDK retry, no tool loop, no fallback", () => {
    const source = read("lib/externalApiInference.ts");
    assert.match(source, /maxRetries: 0/);
    assert.match(source, /stopWhen: stepCountIs\(1\)/);
    assert.ok(!/execute\s*:/.test(source), "client tools must never get an execute function");
    assert.equal((source.match(/streamText\(/g) ?? []).length, 1);
});

test("no key secret, prompt or output is written to the request receipt or logs", () => {
    const schema = read("prisma/schema.prisma");
    const model = /model ExternalApiRequest \{([\s\S]*?)\n\}/.exec(schema)[1];
    for (const forbidden of ["prompt", "content", "output", "arguments", "secret", "apiKey"]) {
        assert.ok(!new RegExp(`^\\s+${forbidden}\\b`, "mi").test(model), forbidden);
    }
    const keyModel = /model ExternalApiKey \{([\s\S]*?)\n\}/.exec(schema)[1];
    assert.ok(!/^\s+(key|secret)\s/m.test(keyModel), "only the digest is a column");
    for (const file of ["lib/externalApiInference.ts", "lib/externalApiKeys.ts", "lib/externalApiAdmission.ts"]) {
        const logs = read(file).match(/console\.(error|warn|log)\([\s\S]*?\);/g) ?? [];
        for (const line of logs) {
            assert.ok(!/authorization|\.key\b|raw\b|messages|parsed/.test(line), `${file}: ${line}`);
        }
    }
});

test("reservations record the external API as its own source, never a productKey", () => {
    const security = read("lib/chatSecurity.ts");
    assert.match(security, /CHAT_RESERVATION_SOURCES = \["chat", "comparison_review", "external_api"\]/);
    const inference = read("lib/externalApiInference.ts");
    assert.match(inference, /source: "external_api"/);
    assert.ok(!/productKey|conversation\.create|message\.create/i.test(inference));
});
