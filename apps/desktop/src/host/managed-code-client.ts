import { z } from "zod";
import {
  managedCallResult, managedCatalogSnapshot, managedReceipt, managedRefusalFor,
  type ManagedCatalogSnapshot, type ManagedReceipt, type ManagedRefusal, type ManagedTerminalReason,
} from "../managed-code-contract";

/** The account session's `send` (account-settings-api.ts), narrowed to what these two routes need. */
export type ManagedSend = (
  request: { path: string; method?: "GET" | "POST"; body?: object }, accept?: string, timeout?: number, extra?: Record<string, string>,
) => Promise<Response>;

export type ManagedOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "refused"; reason: ManagedRefusal; code?: string; receipt?: ManagedReceipt }
  | { kind: "unreachable" };

export type ManagedCompleteOutcome =
  | { kind: "ok"; callId: string; value: unknown; callCredits: number; receipt: ManagedReceipt }
  // The server answered but the model's output failed its schema. The call is settled; a new call needs a new id.
  | { kind: "invalidOutput"; callId: string; receipt?: ManagedReceipt }
  | { kind: "refused"; reason: ManagedRefusal; code?: string }
  // The request may have reached the model. Never send this call again: ask `status` with the same id.
  | { kind: "unknown"; callId: string };

const errorBody = z.object({
  error: z.string().max(80).optional(), dispatchState: z.enum(["not_dispatched", "dispatched"]).optional(),
  receipt: managedReceipt.optional(),
});

const reserveWire = z.object({
  taskId: z.uuid(), catalogVersion: z.number().int().positive(), contentHash: z.string().min(1).max(128),
  executorModelId: z.string(), reviewerModelId: z.string(), approvedCredits: z.number().int().positive(),
});
export type ManagedReserveRequest = z.infer<typeof reserveWire>;

export type ManagedCompleteRequest = {
  reservationId: string; callId: string; role: "executor" | "reviewer"; modelId: string;
  prompt: { system: string; user: string }; schema: Record<string, unknown>; maxOutputTokens: number;
};

/**
 * The managed Code routes over the account session. The session cookie, the same-origin `Origin` and `X-Tomverse-Code: 1`
 * are what the route asks of a web page; `send` supplies the first two. Desktop sends no price, usage or charge: it names
 * models, an approved credit amount and a reservation id, and shows what the server answers.
 */
export function createManagedCodeClient(deps: { send: ManagedSend; signal: AbortSignal }) {
  async function post(body: object, timeout: number) {
    return deps.send({ path: "/api/code/managed", method: "POST", body }, "application/json", timeout, { "X-Tomverse-Code": "1" });
  }

  async function failure(response: Response) {
    const body = errorBody.safeParse(await response.json().catch(() => null));
    deps.signal.throwIfAborted();
    return body.success ? body.data : ({} as z.infer<typeof errorBody>);
  }

  /** One request, one answer. A transport error is `unreachable`; the caller decides whether sending again is safe. */
  async function call<T>(body: object, schema: z.ZodType<T>, timeout = 15_000): Promise<ManagedOutcome<T>> {
    let response: Response;
    try { response = await post(body, timeout); }
    catch { deps.signal.throwIfAborted(); return { kind: "unreachable" }; }
    deps.signal.throwIfAborted();
    if (response.ok) {
      const parsed = schema.safeParse(await response.json().catch(() => null));
      return parsed.success ? { kind: "ok", value: parsed.data } : { kind: "refused", reason: "unavailable" };
    }
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      return { kind: "refused", reason: "account", code: "SIGNED_OUT" };
    }
    const detail = await failure(response);
    return { kind: "refused", reason: managedRefusalFor(detail.error), ...(detail.error ? { code: detail.error } : {}),
      ...(detail.receipt ? { receipt: detail.receipt } : {}) };
  }

  async function catalog(): Promise<ManagedOutcome<ManagedCatalogSnapshot>> {
    let response: Response;
    try { response = await deps.send({ path: "/api/code/model-catalog" }); }
    catch { deps.signal.throwIfAborted(); return { kind: "unreachable" }; }
    deps.signal.throwIfAborted();
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { kind: "refused", reason: "unavailable" };
    }
    const parsed = managedCatalogSnapshot.safeParse(await response.json().catch(() => null));
    return parsed.success ? { kind: "ok", value: parsed.data } : { kind: "refused", reason: "catalog" };
  }

  return {
    catalog,
    /** Idempotent on `taskId` with the same body, so sending it again after an `unreachable` answer cannot hold credits twice. */
    reserve: (request: ManagedReserveRequest) => call({ action: "reserve", ...reserveWire.parse(request) }, managedReceipt),
    heartbeat: (reservationId: string) => call({ action: "heartbeat", reservationId }, managedReceipt),
    status: (reservationId: string, callId?: string) =>
      call({ action: "status", reservationId, ...(callId ? { callId } : {}) }, managedReceipt.extend({
        call: z.object({ callId: z.uuid(), state: z.string().max(40), callCredits: z.number().int().nonnegative() }).optional(),
      })),
    release: (reservationId: string, terminalReason: ManagedTerminalReason) =>
      call({ action: "release", reservationId, terminalReason }, managedReceipt),
    /**
     * One paid model call, made by the server. It is sent once. A transport error or an answer that says the call was
     * dispatched leaves the outcome unknown; the answer to that is `status`, never a second send.
     */
    async complete(request: ManagedCompleteRequest): Promise<ManagedCompleteOutcome> {
      let response: Response;
      try { response = await post({ action: "complete", ...request }, 90_000); }
      catch { deps.signal.throwIfAborted(); return { kind: "unknown", callId: request.callId }; }
      deps.signal.throwIfAborted();
      if (response.ok) {
        const parsed = managedCallResult.safeParse(await response.json().catch(() => null));
        return parsed.success
          ? { kind: "ok", callId: request.callId, value: parsed.data.value, callCredits: parsed.data.callCredits, receipt: parsed.data }
          : { kind: "unknown", callId: request.callId };
      }
      if (response.status === 401) {
        await response.body?.cancel().catch(() => {});
        return { kind: "refused", reason: "account", code: "SIGNED_OUT" };
      }
      const detail = await failure(response);
      if (detail.error === "CODE_OUTPUT_INVALID") return { kind: "invalidOutput", callId: request.callId, ...(detail.receipt ? { receipt: detail.receipt } : {}) };
      if (detail.dispatchState === "not_dispatched") return { kind: "refused", reason: managedRefusalFor(detail.error), ...(detail.error ? { code: detail.error } : {}) };
      return { kind: "unknown", callId: request.callId };
    },
  };
}

export type ManagedCodeClient = ReturnType<typeof createManagedCodeClient>;
