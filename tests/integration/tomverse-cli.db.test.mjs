import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { mock } from "node:test";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { MockLanguageModelV4 } from "ai/test";
import { getSingleAccountCostCeiling, providerBudgetEnvName } from "../../lib/providerCostBudget.ts";

/**
 * The Tomverse CLI against the real external API code: key authentication,
 * the shared credit reservation and settlement, the key cap, receipts and the
 * request status lookup, on a migrated local test database. Only the model
 * provider is faked. Each CLI step must be its own request with its own
 * Idempotency-Key, and the CLI's session cost must equal its own receipts.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
test("Tomverse CLI over the real gateway and shared credit ledger", { skip: !databaseUrl }, async (t) => {
    const url = new URL(databaseUrl);
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
    assert.match(url.pathname, /test/);
    const MODEL_ID = "gpt-6-luna";
    Object.assign(process.env, {
        NEXTAUTH_SECRET: "external-api-local-synthetic-secret",
        ADMIN_AUDIT_INTEGRITY_KEY: "synthetic-external-api-audit",
        EXTERNAL_API_ENABLED: "true",
        OPENAI_API_KEY: "sk-fixture-not-a-key",
        EXTERNAL_API_ALLOWED_USER_IDS: "",
        CHAT_USER_PER_MINUTE: "1000",
        CHAT_IP_PER_MINUTE: "1000",
        EXTERNAL_API_REQUESTS_PER_MINUTE: "1000",
        EXTERNAL_API_READS_PER_MINUTE: "1000",
    });
    const floor = getSingleAccountCostCeiling();
    for (const period of ["day", "month"]) process.env[providerBudgetEnvName("openai", period)] = String(floor[period]);

    const root = resolve(import.meta.dirname, "../..");
    const mod = (path) => pathToFileURL(resolve(root, path)).href;
    const { PrismaClient } = await import("@prisma/client");
    const pool = new Pool({ connectionString: databaseUrl, max: 6 });
    const db = new PrismaClient({ adapter: new PrismaPg(pool) });
    mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: db, prismaPoolUsage: () => ({ total: 1, idle: 0, waiting: 0 }) } });

    // The fake provider: a scripted coder. It reads, patches, runs the test, reports.
    let dispatches = 0;
    const usage = { inputTokens: { total: 300, noCache: 300, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 40, text: 40, reasoning: 0 } };
    const resultsSinceUser = (prompt) => {
        let last = -1;
        prompt.forEach((m, i) => {
            if (m.role === "user") last = i;
        });
        return prompt.slice(last + 1).flatMap((m) => (m.role === "tool" ? m.content.filter((p) => p.type === "tool-result") : []));
    };
    const reply = (prompt) => {
        const n = resultsSinceUser(prompt).length;
        if (n === 0) return [{ type: "tool-call", toolCallId: `c${randomUUID().slice(0, 6)}`, toolName: "read_file", input: JSON.stringify({ path: "sum.js" }) }];
        if (n === 1)
            return [{ type: "tool-call", toolCallId: `c${randomUUID().slice(0, 6)}`, toolName: "apply_patch", input: JSON.stringify({ edits: [{ path: "sum.js", action: "update", replacements: [{ old: "return a - b;", new: "return a + b;" }] }] }) }];
        if (n === 2) return [{ type: "tool-call", toolCallId: `c${randomUUID().slice(0, 6)}`, toolName: "run_command", input: JSON.stringify({ argv: [process.execPath, "test.js"] }) }];
        return [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Fixed; the test passes." }, { type: "text-end", id: "t" }];
    };
    mock.module(mod("lib/activeAiModel.ts"), {
        namedExports: {
            getActiveAiModel: () =>
                new MockLanguageModelV4({
                    doStream: async (options) => {
                        dispatches += 1;
                        const parts = reply(options.prompt);
                        const finish = parts[0].type === "tool-call" ? "tool-calls" : "stop";
                        return {
                            stream: new ReadableStream({
                                start(c) {
                                    c.enqueue({ type: "stream-start", warnings: [] });
                                    for (const p of parts) c.enqueue(p);
                                    c.enqueue({ type: "finish", finishReason: { unified: finish, raw: finish }, usage });
                                    c.close();
                                },
                            }),
                        };
                    },
                }),
            QWEN_GROUNDED_THINKING_BUDGET: 128,
            qwenLookupStep: () => undefined,
            createCohereResearchFetch: (f) => f,
        },
    });

    const { handleChatCompletions } = await import(mod("lib/externalApiInference.ts"));
    const { GET: modelsRoute } = await import(mod("app/api/v1/models/route.ts"));
    const { GET: usageRoute } = await import(mod("app/api/v1/usage/route.ts"));
    const { GET: statusRoute } = await import(mod("app/api/v1/requests/status/route.ts"));
    const keys = await import(mod("lib/externalApiKeys.ts"));
    const { Runner } = await import(mod("apps/tomverse-cli/src/agent.ts"));
    const { Gateway } = await import(mod("apps/tomverse-cli/src/gateway.ts"));
    const { Journal } = await import(mod("apps/tomverse-cli/src/session.ts"));
    const { Workspace } = await import(mod("apps/tomverse-cli/src/workspace.ts"));
    const { createOutput } = await import(mod("apps/tomverse-cli/src/display.ts"));
    const { sessionCost } = await import(mod("apps/tomverse-cli/src/main.ts"));

    // The gateway over HTTP, as the CLI sees it in production.
    const server = createServer((req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", async () => {
            const abort = new AbortController();
            res.on("close", () => {
                if (!res.writableEnded) abort.abort();
            });
            const request = new Request(`http://127.0.0.1${req.url}`, {
                method: req.method,
                headers: Object.entries(req.headers).filter(([, v]) => typeof v === "string"),
                body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
                signal: abort.signal,
            });
            const path = req.url.split("?")[0];
            const response =
                path === "/api/v1/chat/completions" ? await handleChatCompletions(request)
                : path === "/api/v1/models" ? await modelsRoute(request)
                : path === "/api/v1/usage" ? await usageRoute(request)
                : path === "/api/v1/requests/status" ? await statusRoute(request)
                : new Response("not found", { status: 404 });
            res.writeHead(response.status, Object.fromEntries(response.headers));
            if (!response.body) return res.end();
            const reader = response.body.getReader();
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    res.write(value);
                }
            } catch {
                // client left
            }
            res.end();
        });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    t.after(async () => {
        server.closeAllConnections();
        server.close();
        await db.$disconnect();
        await pool.end();
    });

    const newUser = async () => {
        const id = randomUUID();
        await db.user.create({ data: { id, email: `${id}@example.invalid`, plan: "Pro" } });
        return id;
    };
    const sessionFor = (userId) => ({ user: { id: userId, email: `${userId}@example.invalid` }, expires: new Date(Date.now() + 3_600_000).toISOString() });
    const audit = () => new Request("http://localhost/api/user/api-keys", { method: "POST" });
    const repo = () => {
        const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "tvcli-db-repo-")));
        writeFileSync(join(dir, "sum.js"), "export function sum(a, b) {\n  return a - b;\n}\n");
        writeFileSync(join(dir, "test.js"), 'import { sum } from "./sum.js";\nif (sum(2, 3) !== 5) process.exit(1);\nconsole.log("PASS");\n');
        writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
        return dir;
    };
    const runnerFor = async (key, root, prompter) => {
        const endpoint = { base, origin: new URL(base).origin, basePath: "/api/v1" };
        const gateway = new Gateway(endpoint, key);
        const catalog = (await gateway.models()).filter((m) => m.tools);
        const model = catalog.find((m) => m.id === MODEL_ID);
        assert.ok(model, `catalog offers ${MODEL_ID}`);
        const journal = Journal.create(realpathSync.native(mkdtempSync(join(tmpdir(), "tvcli-db-home-"))), {
            workspace: { root },
            endpointOrigin: endpoint.origin,
            keyPrefix: key.slice(0, 12),
            readOnly: false,
            model: { requested: MODEL_ID, pinned: MODEL_ID, pinnedFrom: "user", contextWindowTokens: model.contextWindowTokens, maxOutputTokens: model.maxOutputTokens },
            limits: { maxRequests: 20, timeoutMs: 900_000, commandTimeoutMs: 120_000 },
        });
        const quiet = createOutput(false, { out: { write: () => true }, err: { write: () => true } });
        return { gateway, journal, runner: new Runner({ gateway, journal, workspace: new Workspace(root), output: quiet, prompter, catalog, commandEnv: [], instructions: null }) };
    };
    const approveAll = { approve: async () => true, confirm: async () => false };

    await t.test("read -> patch -> test through the real gateway: one request, reservation and receipt per step", async () => {
        const userId = await newUser();
        process.env.EXTERNAL_API_ALLOWED_USER_IDS = userId;
        const { key, summary } = await keys.createExternalApiKey({ userId, name: "cli", creditCap: null, expiresAt: null }, { session: sessionFor(userId), request: audit() });
        const root = repo();
        const before = dispatches;
        const { runner, journal, gateway } = await runnerFor(key, root, approveAll);
        assert.equal(await runner.runTask("Fix the failing test."), "success");
        assert.match(readFileSync(join(root, "sum.js"), "utf8"), /a \+ b/);
        assert.equal(dispatches - before, 4);
        const rows = await db.externalApiRequest.findMany({ where: { keyId: summary.id }, include: { reservation: true }, orderBy: { createdAt: "asc" } });
        assert.equal(rows.length, 4);
        // Every step used its own Idempotency-Key, stored only as a digest.
        assert.deepEqual(
            rows.map((r) => r.idempotencyKeyDigest),
            journal.state.generations.map((g) => createHash("sha256").update(g.idempotencyKey).digest("hex"))
        );
        assert.deepEqual(rows.map((r) => r.id), journal.state.generations.map((g) => g.requestId));
        assert.ok(rows.every((r) => r.reservation.status !== "reserved" && r.reservation.outcome === "completed"));
        assert.ok(rows.every((r) => r.clientName?.startsWith("tomverse-cli/")));

        // Another client on the same key: not part of the session's cost.
        const other = await handleChatCompletions(new Request(`${base}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: MODEL_ID, messages: [{ role: "user", content: "hi" }] }) }));
        assert.equal(other.status, 200);
        await other.text();
        const cost = await sessionCost(gateway, journal);
        const expected = rows.reduce((sum, r) => sum + r.reservation.settledCredits, 0);
        assert.equal(cost.requests, 4);
        assert.equal(cost.charged, expected, "the session's cost is the sum of its own receipts");
        assert.deepEqual(cost.unknown, []);
        journal.release();
    });

    await t.test("the key cap is the hard limit: the CLI stops at the refusal and does not retry", async () => {
        const userId = await newUser();
        process.env.EXTERNAL_API_ALLOWED_USER_IDS = userId;
        const { key, summary } = await keys.createExternalApiKey({ userId, name: "capped", creditCap: 1, expiresAt: null }, { session: sessionFor(userId), request: audit() });
        const before = dispatches;
        const { runner, journal } = await runnerFor(key, repo(), approveAll);
        assert.equal(await runner.runTask("Fix it."), "error");
        const admitted = await db.externalApiRequest.count({ where: { keyId: summary.id } });
        assert.equal(dispatches - before, admitted, "only admitted requests reach the provider");
        const last = journal.state.generations.at(-1);
        assert.equal(last.httpStatus, 429);
        assert.equal(last.error.code, "key_credit_cap_reached");
        assert.equal(journal.state.generations.length, admitted + 1, "stopped at the first refusal, no retry");
        journal.release();
    });

    await t.test("a revoked key ends the session at the next request", async () => {
        const userId = await newUser();
        process.env.EXTERNAL_API_ALLOWED_USER_IDS = userId;
        const { key, summary } = await keys.createExternalApiKey({ userId, name: "revoked", creditCap: null, expiresAt: null }, { session: sessionFor(userId), request: audit() });
        let revoked = false;
        const prompter = {
            approve: async () => {
                if (!revoked) {
                    await keys.revokeExternalApiKey({ userId, keyId: summary.id }, { session: sessionFor(userId), request: audit() });
                    revoked = true;
                }
                return true;
            },
            confirm: async () => false,
        };
        const root = repo();
        const { runner, journal } = await runnerFor(key, root, prompter);
        assert.equal(await runner.runTask("Fix it."), "error");
        assert.equal(journal.state.generations.at(-1).httpStatus, 401);
        journal.release();
    });

    await t.test("the built CLI process, read-only, over the real gateway: exit 0 and receipts", { skip: !existsSync(resolve(root, "apps/tomverse-cli/dist/cli.js")) && "build the CLI first" }, async () => {
        const userId = await newUser();
        process.env.EXTERNAL_API_ALLOWED_USER_IDS = userId;
        const { key, summary } = await keys.createExternalApiKey({ userId, name: "process", creditCap: null, expiresAt: null }, { session: sessionFor(userId), request: audit() });
        const home = realpathSync.native(mkdtempSync(join(tmpdir(), "tvcli-db-home-")));
        const dir = repo();
        writeFileSync(join(home, "config.json"), JSON.stringify({ endpoint: base, allowInsecureLocalhost: true, model: MODEL_ID, trustedRoots: [dir] }));
        const env = { ...process.env, TOMVERSE_HOME: home, TOMVERSE_API_KEY: key };
        delete env.TOMVERSE_ENDPOINT;
        const child = spawn(process.execPath, [resolve(root, "apps/tomverse-cli/dist/cli.js"), "exec", "--json", "--read-only", "--max-requests", "3", "What does sum do?"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        const code = await new Promise((r) => child.on("close", r));
        const events = stdout.trim().split("\n").map((l) => JSON.parse(l));
        const final = events.at(-1);
        // The scripted model would patch next; read-only offers no patch tool, so
        // the provider sees no apply_patch and the run ends at the request limit.
        assert.ok([0, 5].includes(code), `${code} ${stderr}`);
        const rows = await db.externalApiRequest.findMany({ where: { keyId: summary.id }, include: { reservation: true } });
        assert.equal(rows.length, final.cost.requests);
        assert.equal(final.cost.charged, rows.reduce((s, r) => s + r.reservation.settledCredits, 0));
    });
});
