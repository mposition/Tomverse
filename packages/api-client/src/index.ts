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

/** An intent signal can request permission; it never contains device data. */
export async function requestChatLocationIntent(text: string, transport: ApiFetch, options: { turnstileToken?: string } = {}): Promise<boolean> {
  const post = async (turnstileToken?: string) => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await transport("/api/chat/location-intent", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, 8_000), ...(turnstileToken ? { turnstileToken } : {}) }), signal: controller.signal,
      });
      return { response, body: await response.json().catch(() => null) };
    } finally { clearTimeout(deadline); }
  };
  if (options.turnstileToken) {
    // Redeem the single-use token and receive its cookie before any model wait.
    // An unknown redemption outcome must never fall through and reuse the token.
    try {
      const { response, body } = await post(options.turnstileToken);
      if (!response.ok) throw new ApiClientError(response.status, body?.code ?? "TURNSTILE_UNAVAILABLE");
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError(503, "TURNSTILE_UNAVAILABLE");
    }
  }
  try {
    const { response, body } = await post();
    if (!response.ok) {
      if (body?.code === "TURNSTILE_REQUIRED") throw new ApiClientError(response.status, body.code);
      return false;
    }
    return body?.requiresLocation === true;
  } catch (error) {
    if (error instanceof ApiClientError && error.code === "TURNSTILE_REQUIRED") throw error;
    return false;
  }
}
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
