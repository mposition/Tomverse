export function filenameFromContentDisposition(
    header: string | null,
    fallback: string
): string {
    if (!header) return fallback;

    const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
    if (encoded) {
        try {
            const decoded = decodeURIComponent(encoded.trim());
            if (decoded) return decoded;
        } catch {
            // A malformed `filename*` is not worth failing a download over.
        }
    }

    const quoted = /filename\s*=\s*"([^"]*)"/i.exec(header)?.[1]?.trim();
    if (quoted) return quoted;

    const bare = /filename\s*=\s*([^;]+)/i.exec(header)?.[1]?.trim();
    return bare || fallback;
}

export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
export class ApiClientError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
/** Transport is injected: secure cookies on web, the existing native bearer adapter on device. */
export function createApiClient(transport: ApiFetch) {
  const response: ApiFetch = (path, init) => transport(path, { cache: "no-store", redirect: "error", ...init });
  return {
    response,
    async json<T>(path: string, init?: RequestInit): Promise<T> {
      const result = await response(path, init);
      const body = await result.json().catch(() => {
        if (result.ok) throw Error("MOBILE_RESPONSE_INVALID");
        return {};
      });
      if (!result.ok) throw new ApiClientError(result.status, typeof body?.code === "string" ? body.code : "MOBILE_REQUEST_FAILED");
      return body as T;
    },
  };
}
