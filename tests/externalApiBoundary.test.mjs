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
    // The caller: a key, or Desktop Code's verified Desktop bearer (never a cookie or the web session).
    "lib/externalApiCaller.ts",
    // Native protocols (Claude Code, Codex): the same condition.
    "app/api/v1/responses/route.ts",
    "app/api/anthropic/v1/messages/route.ts",
    "app/api/anthropic/v1/messages/count_tokens/route.ts",
    "app/api/anthropic/v1/models/route.ts",
    "lib/externalApiNative.ts",
    "lib/externalApiNativeSpecs.ts",
    "lib/externalApiNativeUpstream.ts",
    "lib/externalApiModelRoutes.ts",
    // The coding API (owner decision 2026-11-21): the same handlers on their own addresses.
    "app/api/code/v1/chat/completions/route.ts",
    "app/api/code/v1/responses/route.ts",
    "app/api/code/v1/models/route.ts",
    "app/api/code/v1/usage/route.ts",
    "app/api/code/v1/requests/status/route.ts",
    "app/api/code/anthropic/v1/messages/route.ts",
    "app/api/code/anthropic/v1/messages/count_tokens/route.ts",
    "app/api/code/anthropic/v1/models/route.ts",
    "lib/codingCatalogChannels.ts",
    "lib/codingRowRuntime.ts",
    // The coding API's web search for the agent engine: the same condition.
    "app/api/code/v1/web-search/route.ts",
    "lib/codeWebSearch.ts",
    "lib/codeWebSearchCore.ts",
    // The coding API's route-only choice: the same condition.
    "app/api/code/v1/route/route.ts",
    "lib/externalApiRouteOnly.ts",
    "lib/externalApiRouteOnlyCore.ts",
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

test("a Desktop session is a verified bearer on exact coding paths, never a cookie", () => {
    const caller = read("lib/externalApiCaller.ts");
    // The only session it reads is the Desktop bearer, and only for an enrolled path from the Desktop origin.
    assert.ok(caller.includes("await requireDesktopCodeBearer(request)"));
    assert.ok(caller.includes("desktopCodeSessionRoute(new URL(request.url).pathname, request.method)"));
    assert.ok(caller.includes(`if (request.headers.has("cookie")) throw refused();`));
    // Every coding route that takes it resolves its caller there, not by a key-only path of its own.
    for (const file of ["lib/externalApiInference.ts", "lib/codeWebSearch.ts", "lib/externalApiRoutes.ts", "lib/externalApiRouteOnly.ts"]) {
        const source = read(file);
        assert.ok(source.includes("authenticateExternalApiCaller(request)"), file);
        assert.ok(!source.includes("authenticateExternalApiKey("), file);
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
    // The coding API's generation routes, on the same exact-path condition.
    for (const exact of ["/api/code/v1/chat/completions", "/api/code/v1/responses", "/api/code/anthropic/v1/messages", "/api/code/anthropic/v1/messages/count_tokens", "/api/code/v1/web-search", "/api/code/v1/route"]) {
        assert.equal(requiresMutationOriginCheck("POST", exact), false, exact);
        assert.equal(requiresMutationOriginCheck("POST", `${exact}/x`), true, `${exact}/x`);
    }
    // Code's managed path keeps the Origin check.
    assert.equal(requiresMutationOriginCheck("POST", "/api/code/managed"), true);
    assert.equal(requiresMutationOriginCheck("POST", "/api/code/v1/other"), true);
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

test("each route names its API by its address, and the receipt records it", () => {
    // The general API: /api/v1 and /api/anthropic. The coding API: /api/code/...
    const routes = {
        "app/api/v1/chat/completions/route.ts": "general",
        "app/api/v1/responses/route.ts": "general",
        "app/api/v1/models/route.ts": "general",
        "app/api/anthropic/v1/messages/route.ts": "general",
        "app/api/anthropic/v1/messages/count_tokens/route.ts": "general",
        "app/api/anthropic/v1/models/route.ts": "general",
        "app/api/code/v1/chat/completions/route.ts": "coding",
        "app/api/code/v1/responses/route.ts": "coding",
        "app/api/code/v1/models/route.ts": "coding",
        "app/api/code/anthropic/v1/messages/route.ts": "coding",
        "app/api/code/anthropic/v1/messages/count_tokens/route.ts": "coding",
        "app/api/code/anthropic/v1/models/route.ts": "coding",
    };
    for (const [file, surface] of Object.entries(routes)) {
        const source = read(file);
        const named = [...source.matchAll(/surface: "(general|coding)"|, "(general|coding)"\)/g)].map((match) => match[1] ?? match[2]);
        assert.deepEqual(named, [surface], file);
        assert.ok(!/user-agent/i.test(source), `${file}: the User-Agent decides nothing`);
    }
    // Both generation handlers hand the route's API to the receipt.
    for (const file of ["lib/externalApiInference.ts", "lib/externalApiNative.ts"]) {
        assert.match(read(file), /externalApiAdmissionHook\(\{[\s\S]*?surface: options\.surface,[\s\S]*?\}\)/, file);
    }
    const admission = read("lib/externalApiAdmission.ts");
    assert.match(admission, /surface: ExternalApiSurface;/, "required, never defaulted");
    assert.match(admission, /surface: input\.surface,/);
    // And the key's receipts return it, null for rows recorded before it existed.
    const keysSource = read("lib/externalApiKeys.ts");
    assert.match(keysSource, /surface: true,/);
    assert.match(keysSource, /surface: row\.surface,/);
    // The CHECK constraint and the application list are one set.
    const migration = read("prisma/migrations/20261121120000_external_api_request_surface/migration.sql");
    assert.match(migration, /ADD COLUMN "surface" TEXT,/);
    assert.match(migration, /CHECK \("surface" IN \('general', 'coding'\)\)/);
    assert.ok(!/UPDATE\s+"ExternalApiRequest"/i.test(migration), "no backfill: older rows stay NULL");
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
    // Within this key only, or within this account's Desktop session requests only (no key).
    assert.ok(lookup.includes(`const scope = "keyId" in owner ? { keyId: owner.keyId } : { desktopUserId: owner.desktopUserId };`));
    assert.ok(lookup.includes("where: { id: selector.requestId, ...scope }"), "a request id is looked up within this key only");
    assert.match(lookup, /keyId_idempotencyKeyDigest: \{ keyId: owner\.keyId,/);
    assert.match(lookup, /desktopUserId_idempotencyKeyDigest: \{ desktopUserId: owner\.desktopUserId,/);
    assert.ok(!/\.(create|update|upsert|delete|\$executeRaw)/.test(lookup));
});

test("every keyed front door checks the account and its paid plan through one function", () => {
    // Chat Completions, the /models, /usage and /requests/status reads, and
    // the native protocols: each accepts a key and then asks externalApiAccess.
    // A Desktop session (lib/externalApiCaller.ts) is accepted at the same doors and asks the same function.
    for (const file of ["lib/externalApiInference.ts", "lib/externalApiRoutes.ts", "lib/externalApiNative.ts", "lib/codeWebSearch.ts"]) {
        const source = read(file);
        const accepts = (source.match(/await authenticateExternalApi(?:Key|Caller)\(/g) ?? []).length;
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
