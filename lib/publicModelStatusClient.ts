import { discardResponseBody } from "@/lib/discardResponseBody";

export type PublicModelStatusSnapshot = { models: unknown[] };
type StatusRead = { snapshot: PublicModelStatusSnapshot | null; unavailable: boolean };

/** Public, account-independent status only; one request for all mounted consumers. */
export function createPublicModelStatusReader({
  fetchStatus,
  now = Date.now,
  timeoutMs = 10_000,
}: {
  fetchStatus: (signal: AbortSignal) => Promise<Response>;
  now?: () => number;
  timeoutMs?: number;
}) {
  let snapshot: PublicModelStatusSnapshot | null = null;
  let inFlight: Promise<StatusRead> | null = null;
  let nextReadAt = 0;
  let failures = 0;
  let unavailable = false;

  const failed = (baseDelay: number, retryAfter: string | null = null): StatusRead => {
    failures += 1;
    unavailable = true;
    const retryAt = retryAfter && /^\d+$/.test(retryAfter.trim())
      ? now() + Number(retryAfter) * 1_000
      : retryAfter ? Date.parse(retryAfter) : 0;
    nextReadAt = Math.max(
      now() + Math.min(baseDelay * 2 ** Math.min(failures - 1, 10), 1_800_000),
      Number.isFinite(retryAt) ? retryAt : 0,
    );
    return { snapshot, unavailable };
  };

  return {
    read({ force = false }: { force?: boolean } = {}): Promise<StatusRead> {
      if (inFlight) return inFlight;
      // A manual refresh may bypass a fresh success, never a failure cooldown.
      if (now() < nextReadAt && (!force || unavailable)) {
        return Promise.resolve({ snapshot, unavailable });
      }
      inFlight = Promise.resolve().then(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchStatus(controller.signal);
          if (!response.ok) {
            await discardResponseBody(response);
            return failed(response.status === 429 ? 300_000 : 60_000, response.headers.get("Retry-After"));
          }
          const data: unknown = await response.json();
          if (!data || typeof data !== "object" || !Array.isArray((data as PublicModelStatusSnapshot).models)) {
            throw new Error("Invalid public model status snapshot");
          }
          snapshot = data as PublicModelStatusSnapshot;
          failures = 0;
          unavailable = false;
          nextReadAt = now() + 60_000;
          return { snapshot, unavailable };
        } catch {
          return failed(60_000);
        } finally {
          clearTimeout(timeout);
        }
      }).finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}

const reader = createPublicModelStatusReader({
  fetchStatus: signal => fetch("/api/models/status", { cache: "no-store", signal }),
});

export const readPublicModelStatus = reader.read;
