/* eslint-disable @typescript-eslint/no-explicit-any -- wire-format fixtures: request bodies are arbitrary JSON */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

/**
 * A stand-in for the Tomverse API at the wire level: Chat Completions SSE,
 * /models, /usage and /requests/status. A test scripts what the "model"
 * answers per request and can inject faults. Every request is recorded with
 * its URL, headers and body. Nothing leaves the machine.
 */

export type ScriptedReply =
    | { text?: string; toolCalls?: Array<{ name: string; args: unknown }>; finish?: string }
    | { fault: "http"; status: number; code: string; message?: string; heldReceipt?: boolean }
    | { fault: "drop_before_headers" }
    /** Dropped with no receipt yet: a lookup answers not found. */
    | { fault: "drop_unrecorded" }
    | { fault: "drop_mid_stream"; text?: string }
    | { fault: "hang" };

export type Recorded = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: any };

export type FakeGatewayOptions = {
    models?: Array<Record<string, unknown>>;
    script: (body: any, index: number) => ScriptedReply;
    routedModel?: string;
};

export const DEFAULT_MODELS = [
    {
        id: "fake-coder",
        object: "model",
        tomverse: { name: "Fake Coder", provider: "openai", capabilities: { tools: true, vision: false, reasoning: false }, protocols: ["chat_completions", "responses"], context_window_tokens: 200_000, max_output_tokens: 8_000, credits_per_request: 3 },
    },
    {
        id: "fake-small",
        object: "model",
        tomverse: { name: "Fake Small", provider: "deepseek", capabilities: { tools: true, vision: false, reasoning: false }, protocols: ["chat_completions"], context_window_tokens: 6_000, max_output_tokens: 1_000, credits_per_request: 1 },
    },
    {
        id: "smart-adaptive",
        object: "model",
        tomverse: { name: "Smart Adaptive", provider: "tomverse", capabilities: { tools: true, vision: false, reasoning: false }, protocols: ["chat_completions"], context_window_tokens: 200_000, max_output_tokens: 8_000, credits_per_request: 3 },
    },
];

export class FakeGateway {
    readonly requests: Recorded[] = [];
    readonly completions: Recorded[] = [];
    readonly receipts = new Map<string, { requestId: string; idempotencyKey: string | null; status: string; chargedCredits: number | null; heldCredits: number; modelId: string }>();
    revoked = false;
    private server: Server | null = null;
    port = 0;

    constructor(readonly options: FakeGatewayOptions) {}

    get base() {
        return `http://127.0.0.1:${this.port}/api/v1`;
    }

    async start() {
        // fetch refuses the Fetch standard's "bad ports" (e.g. 6665-6669), which a
        // random port can be; take another one then.
        for (;;) {
            this.server = createServer((req, res) => this.handle(req, res));
            await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
            const address = this.server.address();
            this.port = typeof address === "object" && address ? address.port : 0;
            if (!FETCH_BAD_PORTS.has(this.port)) return this;
            await new Promise<void>((resolve) => this.server!.close(() => resolve()));
        }
    }

    async stop() {
        this.server?.closeAllConnections();
        await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
    }

    private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
    }

    private async handle(req: IncomingMessage, res: ServerResponse) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        let body: any = null;
        try {
            body = raw ? JSON.parse(raw) : null;
        } catch {
            body = raw;
        }
        const recorded = { method: req.method ?? "GET", url: url.pathname + url.search, headers: req.headers, body };
        this.requests.push(recorded);
        if (this.revoked || req.headers.authorization !== `Bearer ${TEST_KEY}`) {
            return this.json(res, 401, { error: { message: "A valid Tomverse API key is required.", code: "invalid_api_key", type: "authentication_error" } });
        }
        if (url.pathname === "/api/v1/models") return this.json(res, 200, { object: "list", data: this.options.models ?? DEFAULT_MODELS });
        if (url.pathname === "/api/v1/usage") {
            return this.json(res, 200, {
                object: "tomverse.usage",
                key: { prefix: TEST_KEY.slice(0, 12), name: "test", credit_cap: 500, committed_credits: 0, held_credits: 0, remaining_cap_credits: 500, expires_at: null },
                requests: [...this.receipts.values()].reverse().slice(0, Number(url.searchParams.get("limit") ?? 50)).map((r) => this.receiptView(r)),
            });
        }
        if (url.pathname === "/api/v1/requests/status") {
            const byId = url.searchParams.get("request_id");
            const idem = req.headers["idempotency-key"];
            const hit = [...this.receipts.values()].find((r) => (byId ? r.requestId === byId : r.idempotencyKey === idem));
            if (!hit) return this.json(res, 404, { error: { message: "No request of this key matches.", code: "request_not_found" } });
            return this.json(res, 200, { object: "tomverse.request_status", request: this.receiptView(hit), usage_source: "server_settlement", output_stored: false });
        }
        if (url.pathname === "/api/v1/chat/completions" && req.method === "POST") return this.completion(req, res, recorded);
        res.writeHead(404);
        res.end("not found");
    }

    private receiptView(r: { requestId: string; status: string; chargedCredits: number | null; heldCredits: number; modelId: string }) {
        return {
            requestId: r.requestId,
            modelId: r.modelId,
            protocol: "chat_completions",
            status: r.status,
            outcome: r.status === "held" ? null : "completed",
            heldCredits: r.heldCredits,
            chargedCredits: r.chargedCredits,
            finishReason: null,
            errorCode: null,
            createdAt: new Date().toISOString(),
            completedAt: r.status === "held" ? null : new Date().toISOString(),
            usage: r.status === "held" ? null : { inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 20 },
        };
    }

    private async completion(req: IncomingMessage, res: ServerResponse, recorded: Recorded) {
        const index = this.completions.length;
        this.completions.push(recorded);
        const reply = this.options.script(recorded.body, index);
        const idempotencyKey = (req.headers["idempotency-key"] as string | undefined) ?? null;
        const requestId = `req_${randomBytes(16).toString("hex")}`;
        const modelId = recorded.body.model === "smart-adaptive" ? (this.options.routedModel ?? "fake-coder") : recorded.body.model;
        const entry = (this.options.models ?? DEFAULT_MODELS).find((m) => m.id === modelId) as { tomverse?: { credits_per_request?: number } } | undefined;
        const credits = entry?.tomverse?.credits_per_request ?? 3;
        if ("fault" in reply) {
            if (reply.fault === "drop_before_headers") {
                // Received and charged, but the client never sees an answer.
                this.receipts.set(requestId, { requestId, idempotencyKey, status: "settled", chargedCredits: credits, heldCredits: 0, modelId });
                req.socket.destroy();
                return;
            }
            if (reply.fault === "drop_unrecorded") {
                req.socket.destroy();
                return;
            }
            if (reply.fault === "http") {
                if (reply.heldReceipt) this.receipts.set(requestId, { requestId, idempotencyKey, status: "held", chargedCredits: null, heldCredits: credits, modelId });
                return this.json(res, reply.status, { error: { message: reply.message ?? reply.code, code: reply.code } }, { "x-request-id": requestId });
            }
            if (reply.fault === "hang") {
                this.receipts.set(requestId, { requestId, idempotencyKey, status: "held", chargedCredits: null, heldCredits: credits, modelId });
                res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": requestId });
                res.write(`data: ${JSON.stringify(chunk(modelId, { role: "assistant", content: "" }))}\n\n`);
                return;
            }
        }
        this.receipts.set(requestId, { requestId, idempotencyKey, status: "settled", chargedCredits: credits, heldCredits: 0, modelId });
        const headers: Record<string, string> = { "content-type": "text/event-stream", "x-request-id": requestId };
        if (recorded.body.model === "smart-adaptive") {
            headers["x-tomverse-routed-model"] = modelId;
            headers["x-tomverse-routed-by"] = "router";
        }
        if (recorded.body.stream !== true && !("fault" in reply)) {
            const ok = reply as { text?: string; toolCalls?: Array<{ name: string; args: unknown }>; finish?: string };
            return this.json(
                res,
                200,
                {
                    id: "chatcmpl-x",
                    object: "chat.completion",
                    created: 0,
                    model: modelId,
                    choices: [
                        {
                            index: 0,
                            message: {
                                role: "assistant",
                                content: ok.text ?? null,
                                ...(ok.toolCalls?.length ? { tool_calls: ok.toolCalls.map((c, i) => ({ id: `call_${index}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
                            },
                            finish_reason: ok.finish ?? (ok.toolCalls?.length ? "tool_calls" : "stop"),
                        },
                    ],
                    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
                },
                { ...headers, "content-type": "application/json" }
            );
        }
        res.writeHead(200, headers);
        const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
        if ("fault" in reply && reply.fault === "drop_mid_stream") {
            send(chunk(modelId, { role: "assistant", content: reply.text ?? "partial " }));
            setTimeout(() => res.socket?.destroy(), 100);
            return;
        }
        const ok = reply as { text?: string; toolCalls?: Array<{ name: string; args: unknown }>; finish?: string };
        send(chunk(modelId, { role: "assistant", content: "" }));
        if (ok.text) for (const piece of ok.text.match(/[\s\S]{1,20}/g) ?? []) send(chunk(modelId, { content: piece }));
        (ok.toolCalls ?? []).forEach((call, i) => {
            const args = JSON.stringify(call.args);
            send(chunk(modelId, { tool_calls: [{ index: i, id: `call_${index}_${i}`, type: "function", function: { name: call.name, arguments: args.slice(0, 7) } }] }));
            send(chunk(modelId, { tool_calls: [{ index: i, function: { arguments: args.slice(7) } }] }));
        });
        send({ ...chunk(modelId, {}), choices: [{ index: 0, delta: {}, finish_reason: ok.finish ?? (ok.toolCalls?.length ? "tool_calls" : "stop") }] });
        send({ id: "chatcmpl-x", object: "chat.completion.chunk", created: 0, model: modelId, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
        res.write("data: [DONE]\n\n");
        res.end();
    }
}

const chunk = (model: string, delta: Record<string, unknown>) => ({
    id: "chatcmpl-x",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: null }],
});

const FETCH_BAD_PORTS = new Set([
    1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143,
    161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045,
    4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export const TEST_KEY =`tvk_abcdefgh_${"A".repeat(43)}`;

/** Tool results the model has been given since the last user message. */
export const toolResultsSinceUser = (body: any) => {
    const messages: any[] = body.messages ?? [];
    let last = -1;
    messages.forEach((m, i) => {
        if (m.role === "user") last = i;
    });
    return messages.slice(last + 1).filter((m) => m.role === "tool");
};

export const lastUserText = (body: any) => {
    const user = [...(body.messages ?? [])].reverse().find((m: any) => m.role === "user");
    return typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? "");
};
