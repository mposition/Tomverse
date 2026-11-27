import { createHash } from "node:crypto";
import { z } from "zod";
import { CODE_CLOUD_LIMITS, codeCloudJobView, type CodeCloudCreateRequest, type CodeCloudJobView } from "../../../../lib/codeCloudContract";

/** The account session's `send` (account-settings-api.ts), narrowed to what these routes need. */
export type CloudSend = (request: { path: string; method?: "GET" | "POST" | "PUT"; body?: object; raw?: { bytes: Uint8Array; type: string } },
  accept?: string, timeout?: number, extra?: Record<string, string>) => Promise<Response>;

export type CloudOutcome<T> = { kind: "ok"; value: T } | { kind: "refused"; code?: string; status?: number } | { kind: "unreachable" };

const errorBody = z.object({ error: z.string().max(80).optional() });
const headers = { "X-Tomverse-Code": "1" };

/**
 * The cloud job routes over the account session (/api/code/cloud, its bundle and patch routes), as a web page reaches
 * them: session cookie, same-origin Origin and `X-Tomverse-Code: 1`. Desktop sends the instruction, the models, the
 * credit cap and the bundle; every state and number it shows comes back from the server.
 */
export function createCloudExecutionClient(deps: { send: CloudSend; signal: AbortSignal }) {
  async function answer<T>(request: () => Promise<Response>, schema: z.ZodType<T>): Promise<CloudOutcome<T>> {
    let response: Response;
    try { response = await request(); } catch { deps.signal.throwIfAborted(); return { kind: "unreachable" }; }
    deps.signal.throwIfAborted();
    if (!response.ok) {
      const body = errorBody.safeParse(await response.json().catch(() => null));
      return { kind: "refused", status: response.status, ...(body.success && body.data.error ? { code: body.data.error } : {}) };
    }
    const parsed = schema.safeParse(await response.json().catch(() => null));
    return parsed.success ? { kind: "ok", value: parsed.data } : { kind: "refused" };
  }
  const post = <T>(body: object, schema: z.ZodType<T>, timeout = 20_000) =>
    answer(() => deps.send({ path: "/api/code/cloud", method: "POST", body }, "application/json", timeout, headers), schema);

  return {
    /** Idempotent on `taskId` with the same body: sending it again after an unreachable answer creates nothing new. */
    create: (request: Omit<CodeCloudCreateRequest, "action">) => post({ action: "create", ...request }, codeCloudJobView),
    upload: (jobId: string, bytes: Buffer) => answer(() => deps.send({ path: `/api/code/cloud/bundle?job=${encodeURIComponent(jobId)}`, method: "PUT",
      raw: { bytes, type: "application/x-git-bundle" } }, "application/json", 180_000, headers), codeCloudJobView),
    status: (jobId: string, afterLog?: number) => post({ action: "status", jobId, ...(afterLog !== undefined ? { afterLog } : {}) }, codeCloudJobView),
    cancel: (jobId: string) => post({ action: "cancel", jobId }, codeCloudJobView),
    list: () => post({ action: "list" }, z.object({ jobs: z.array(codeCloudJobView).max(50) })),
    /** The patch, checked against the size and SHA-256 the job's own record names before it is used. */
    async patch(job: Pick<CodeCloudJobView, "jobId" | "patch">): Promise<CloudOutcome<Buffer>> {
      if (!job.patch) return { kind: "refused", code: "CODE_CLOUD_PATCH_UNAVAILABLE" };
      let response: Response;
      try { response = await deps.send({ path: `/api/code/cloud/patch?job=${encodeURIComponent(job.jobId)}` }, "text/x-diff", 60_000, headers); }
      catch { deps.signal.throwIfAborted(); return { kind: "unreachable" }; }
      deps.signal.throwIfAborted();
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { kind: "refused", status: response.status, code: "CODE_CLOUD_PATCH_UNAVAILABLE" };
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > CODE_CLOUD_LIMITS.patchMaxBytes || bytes.byteLength !== job.patch.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== job.patch.sha256) return { kind: "refused", code: "CODE_CLOUD_PATCH_UNAVAILABLE" };
      return { kind: "ok", value: bytes };
    },
  };
}

export type CloudExecutionClient = ReturnType<typeof createCloudExecutionClient>;
