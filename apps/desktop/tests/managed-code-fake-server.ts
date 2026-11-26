import { randomUUID } from "node:crypto";
import { codeManagedRequestSchema, type CodeManagedRequest } from "../../../lib/codeManagedCore";
import { createAccountSettingsApi } from "../src/host/account-settings-api";

export const origin = "https://tomverse.example";
export const sessionCookie = "fixture..managed.settings.signature";

export const row = (modelId: string, provider: string, extra: Record<string, unknown> = {}) => ({
  modelId, name: modelId.toUpperCase(), provider, apiModelId: modelId, minimumPlan: "Free", source: "dedicated", channels: ["code"],
  capabilities: { structuredOutput: "native", maxOutputTokens: 16000 }, pricing: { creditWeight: 3 }, ...extra,
});
export const catalogRows = [
  row("alpha", "openai"), row("beta", "anthropic"), row("gamma", "openai"),
  row("chat-only", "google", { channels: ["chat"] }), row("no-json", "xai", { capabilities: { structuredOutput: "none" } }),
];

type Reservation = {
  id: string; taskId: string; bodyKey: string; status: "active" | "interrupted" | "closed"; reserved: number; settled: number; released: number;
  executor: string; reviewer: string; lease: number; unknown: number;
};
export type Refusal = { status: number; error: string; dispatchState?: "not_dispatched" | "dispatched" };

/**
 * A fake Tomverse that speaks the managed Code route's contract. Requests are checked against the server's own request
 * schema, so a Desktop client that drifts from the contract fails here. No model is called and no credit is real.
 */
export function fakeManagedServer(options: { balance?: number; catalogVersion?: number } = {}) {
  const calls: Array<{ url: URL; method: string; headers: Headers; body: unknown }> = [];
  const reservations = new Map<string, Reservation>();
  const sent: CodeManagedRequest[] = [];
  const control = {
    balance: options.balance ?? 1_000,
    catalogVersion: options.catalogVersion ?? 7,
    /** Refuse the next request that matches (once), as the server would. */
    refuse: undefined as undefined | { action: string; answer: Refusal },
    /** Answer the next request that matches with a transport failure, after the server has acted on it when `after`. */
    drop: undefined as undefined | { action: string; after: boolean },
    catalogFails: false,
    completeOutput: { ok: true } as unknown,
  };
  const receipt = (r: Reservation) => {
    const held = r.reserved - r.settled - r.released;
    return {
      reservationId: r.id, state: r.unknown && r.status !== "active" ? "outcome_unknown" : r.status, leaseExpiresAt: new Date(r.lease).toISOString(),
      heartbeatIntervalMs: 30_000,
      modelPair: { executor: catalogRows.find((x) => x.modelId === r.executor), reviewer: catalogRows.find((x) => x.modelId === r.reviewer) },
      billing: { reservedCredits: r.reserved, settledCredits: r.settled, releasedCredits: r.released, heldCredits: held,
        unknownHeldCredits: r.unknown, availableCredits: held - r.unknown },
    };
  };
  const refuse = (answer: Refusal) => Response.json({ error: answer.error, message: "refused", dispatchState: answer.dispatchState ?? "not_dispatched" }, { status: answer.status });

  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, headers, body });
    if (url.pathname === "/api/auth/desktop/settings-session") return Response.json({ token: sessionCookie, expiresAt: Date.now() + 300_000 });
    if (url.pathname === "/api/code/model-catalog") {
      if (control.catalogFails) return Response.json({ error: "catalog_stale" }, { status: 503 });
      return Response.json({ version: control.catalogVersion, contentHash: "hash-" + control.catalogVersion, coverageUntil: "2027-01-01T00:00:00.000Z",
        publishedAt: "2026-11-01T00:00:00.000Z", models: catalogRows });
    }
    if (url.pathname !== "/api/code/managed" || method !== "POST") return Response.json({}, { status: 404 });
    // What the route asks of a web page.
    if (headers.get("x-tomverse-code") !== "1" || headers.get("origin") !== origin ||
      headers.get("cookie") !== `__Secure-next-auth.session-token=${sessionCookie}` || headers.has("authorization")) {
      return Response.json({ error: "CODE_ORIGIN_FORBIDDEN", dispatchState: "not_dispatched" }, { status: 403 });
    }
    const parsed = codeManagedRequestSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: "REQUEST_REJECTED", dispatchState: "not_dispatched" }, { status: 400 });
    const request = parsed.data;
    sent.push(request);
    if (control.refuse && control.refuse.action === request.action) {
      const { answer } = control.refuse;
      control.refuse = undefined;
      return refuse(answer);
    }
    const drop = control.drop && control.drop.action === request.action ? control.drop : undefined;
    if (drop) control.drop = undefined;
    const answer = (): Response => {
      if (request.action === "reserve") {
        const key = JSON.stringify(request);
        const prior = [...reservations.values()].find((r) => r.taskId === request.taskId);
        if (prior) return prior.bodyKey === key ? Response.json(receipt(prior)) : refuse({ status: 409, error: "CODE_TASK_IDEMPOTENCY_CONFLICT" });
        if (request.catalogVersion !== control.catalogVersion) return refuse({ status: 409, error: "CODE_CATALOG_CHANGED" });
        const executor = catalogRows.find((x) => x.modelId === request.executorModelId), reviewer = catalogRows.find((x) => x.modelId === request.reviewerModelId);
        if (!executor || !reviewer) return refuse({ status: 403, error: "CODE_MODEL_UNAVAILABLE" });
        if (executor.provider === reviewer.provider) return refuse({ status: 400, error: "CODE_REVIEWER_PROVIDER_NOT_INDEPENDENT" });
        if (request.approvedCredits > control.balance) return refuse({ status: 402, error: "CREDIT_BALANCE_INSUFFICIENT" });
        control.balance -= request.approvedCredits;
        const made: Reservation = { id: randomUUID(), taskId: request.taskId, bodyKey: key, status: "active", reserved: request.approvedCredits, settled: 0, released: 0,
          executor: request.executorModelId, reviewer: request.reviewerModelId, lease: Date.now() + 120_000, unknown: 0 };
        reservations.set(made.id, made);
        return Response.json(receipt(made));
      }
      const found = reservations.get(request.reservationId);
      if (!found) return refuse({ status: 404, error: "CODE_RESERVATION_NOT_FOUND" });
      if (request.action === "heartbeat") {
        if (found.status !== "active") return Response.json(receipt(found));
        found.lease = Date.now() + 120_000;
        return Response.json(receipt(found));
      }
      if (request.action === "release") {
        if (found.status === "active") {
          found.status = "closed";
          found.released = found.reserved - found.settled - found.unknown;
          control.balance += found.released;
        }
        return Response.json(receipt(found));
      }
      if (request.action === "status") return Response.json(receipt(found));
      // complete
      if (found.status !== "active") return refuse({ status: 409, error: "CODE_TASK_NOT_ACTIVE" });
      if (control.completeOutput === null) {
        found.settled += 2;
        return Response.json({ error: "CODE_OUTPUT_INVALID", dispatchState: "dispatched", receipt: receipt(found) }, { status: 422 });
      }
      found.settled += 2;
      return Response.json({ ...receipt(found), callId: request.callId, callCredits: 2, value: control.completeOutput, dispatchState: "dispatched" });
    };
    if (drop && !drop.after) throw new TypeError("fetch failed before the server saw it");
    const response = answer();
    if (drop) throw new TypeError("fetch failed after the server acted");
    return response;
  };

  return {
    transport, calls, sent, control, reservations,
    /** Test helpers that change what the server holds, as expiry or maintenance would. */
    interrupt(id: string) {
      const found = reservations.get(id)!;
      found.status = "interrupted";
      found.released = found.reserved - found.settled - found.unknown;
    },
    markUnknown(id: string, credits: number) {
      const found = reservations.get(id)!;
      found.status = "interrupted";
      found.unknown = credits;
      found.released = found.reserved - found.settled - credits;
    },
    managedCalls: () => calls.filter(({ url }) => url.pathname === "/api/code/managed"),
  };
}

export function accountOver(server: ReturnType<typeof fakeManagedServer>, account = new AbortController()) {
  const settings = createAccountSettingsApi(origin, async () => "fixture-desktop", account.signal, server.transport);
  return { send: settings.send, signal: account.signal, account };
}
