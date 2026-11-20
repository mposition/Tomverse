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
    "app/api/v1/requests/status/route.ts",
    "lib/externalApiInference.ts",
    "lib/externalApiAdmission.ts",
    "lib/externalApiKeys.ts",
    "lib/externalApiAccess.ts",
    // Native protocols (Claude Code, Codex): the same condition.
    "app/api/v1/responses/route.ts",
    "app/api/anthropic/v1/messages/route.ts",
    "app/api/anthropic/v1/messages/count_tokens/route.ts",
    "app/api/anthropic/v1/models/route.ts",
    "lib/externalApiNative.ts",
    "lib/externalApiNativeSpecs.ts",
    "lib/externalApiNativeUpstream.ts",
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
    for (const exact of ["/api/v1/responses", "/api/anthropic/v1/messages", "/api/anthropic/v1/messages/count_tokens"]) {
        assert.equal(requiresMutationOriginCheck("POST", exact), false, exact);
        assert.equal(requiresMutationOriginCheck("POST", `${exact}/x`), true, `${exact}/x`);
    }
    assert.equal(requiresMutationOriginCheck("POST", "/api/anthropic/v1/other"), true);
    assert.equal(requiresMutationOriginCheck("POST", "/api/v1/responses/compact"), true, "no remote compaction endpoint exists");
});

test("native protocols: one upstream call per request, at a fixed provider URL with the server's key", () => {
    const native = read("lib/externalApiNative.ts");
    // One generation call and one free token-count call, neither in a loop.
    assert.equal((native.match(/nativeUpstreamFetch\(/g) ?? []).length, 2);
    assert.ok(!/\b(retry|retries|attempt)\b\s*[(<=]/i.test(native), "no retry construct");
    assert.ok(!/execute\s*:/.test(native), "client tools are never executed");
    const upstream = read("lib/externalApiNativeUpstream.ts");
    assert.match(upstream, /PROVIDER_API_CONFIGURATION\[provider\]\.baseUrl/);
    assert.match(upstream, /resolveProviderApiKey\(provider\)/);
    assert.match(upstream, /redirect: "error"/);
    assert.ok(!/request\.(url|headers)/.test(upstream), "nothing from the client request decides where it goes");
    // The client's Tomverse credential is never one of the forwarded headers.
    const specs = read("lib/externalApiNativeSpecs.ts");
    const forwarded = specs.match(/const anthropicHeaders[\s\S]*?\n};/)[0];
    assert.ok(!/authorization|x-api-key/i.test(forwarded));
    assert.match(native, /source: "external_api"/);
    assert.ok(!/productKey|conversation\.create|message\.create/i.test(native));
    const logs = native.match(/console\.(error|warn|log)\([\s\S]*?\);/g) ?? [];
    assert.ok(logs.length > 0);
    for (const line of logs) {
        assert.ok(!/authorization|\.key\b|\braw\b|\bbody\b|payload|upstreamBody|\btext\b/.test(line), line);
    }
});

test("request status lookup is a read: GET only, key-scoped, no dispatch, reservation or write", () => {
    const route = read("app/api/v1/requests/status/route.ts");
    assert.match(route, /export async function GET\(/);
    assert.ok(!/export async function (POST|PUT|PATCH|DELETE)\b/.test(route));
    assert.match(route, /withBearerKey\(/);
    assert.match(route, /sha256Hex\(idempotencyKey/, "the raw Idempotency-Key is only ever digested");
    for (const forbidden of ["acquireChatAccess", "streamText", "settleChatUsage", "handleChatCompletions", "console."]) {
        assert.ok(!route.includes(forbidden), `status route must not use ${forbidden}`);
    }
    const keys = read("lib/externalApiKeys.ts");
    const lookup = keys.match(/export const externalApiRequestStatus[\s\S]*?\n};/)[0];
    assert.match(lookup, /where: \{ id: selector\.requestId, keyId \}/, "a request id is looked up within this key only");
    assert.match(lookup, /keyId_idempotencyKeyDigest: \{ keyId,/);
    assert.ok(!/\.(create|update|upsert|delete|\$executeRaw)/.test(lookup));
});

test("every keyed front door checks the account and its paid plan through one function", () => {
    // Chat Completions, the /models, /usage and /requests/status reads, and
    // the native protocols: each accepts a key and then asks externalApiAccess.
    for (const file of ["lib/externalApiInference.ts", "lib/externalApiRoutes.ts", "lib/externalApiNative.ts"]) {
        const source = read(file);
        const accepts = (source.match(/await authenticateExternalApiKey\(/g) ?? []).length;
        assert.ok(accepts > 0, file);
        assert.equal((source.match(/await externalApiAccountAccess\(key\.userId\)/g) ?? []).length, accepts, file);
        assert.ok(!source.includes("externalApiUserAllowed(process.env, key.userId)"), `${file}: the allowlist alone is not the check`);
    }
    const access = read("lib/externalApiAccess.ts");
    assert.match(access, /externalApiUserAllowed\(process\.env, userId\)/);
    assert.match(access, /externalApiPlanAllowed\(plan\.tier\)/);
    assert.match(access, /getUserBillingPlan\(userId\)/, "the effective plan, read per request");
    // Creating a key checks the plan in the library, whoever calls it.
    const create = read("lib/externalApiKeys.ts").match(/export const createExternalApiKey = [\s\S]*?\n};/)[0];
    assert.match(create, /externalApiPlanAllowed\(plan\.tier\)/);
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

test("the external API's model stream runs with AI SDK telemetry off", () => {
    // With Sentry on, its AI SDK tracing-channel subscriber locks the model
    // stream it taps, and every streamed Chat Completions reply failed with
    // "ReadableStream is locked". Telemetry off keeps the call off that channel.
    const source = readFileSync(new URL("../lib/externalApiInference.ts", import.meta.url), "utf8");
    const call = source.slice(source.indexOf("streamText({"), source.indexOf("abortSignal: controller.signal"));
    assert.match(call, /telemetry: \{ isEnabled: false \}/);
});
