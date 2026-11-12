/**
 * Office documents to PDF, with their layout, through the renderer service.
 *
 * Policy: docs/policy/generated-artifacts.md section 15.
 *
 * Word, PowerPoint and Excel files cannot be laid out by anything in this
 * process: that takes an office suite. The renderer is Gotenberg (LibreOffice
 * behind an HTTP API) running as a service of its own on the private network,
 * owner decision 2026-11-12 -- the user's file never leaves Tomverse, and a
 * large native program that opens untrusted documents runs in a container of
 * its own rather than in the app's.
 *
 * Off unless both are set: `CHAT_OFFICE_TO_PDF=on` and `OFFICE_RENDERER_URL`.
 * The address comes from the environment only, never from a request or a
 * model, and a plain-http address must be a private one.
 */

import "server-only";

import {
  OFFICE_RENDERABLE_EXTENSIONS,
  normalizeMediaType,
} from "@/lib/fileConversionCore";

export type OfficeRendererConfig = {
  url: URL;
  /** Basic authentication, when the renderer is started with it. */
  username?: string;
  password?: string;
  timeoutMs: number;
};

export type OfficeRenderFailure = "UNREADABLE" | "TIMEOUT" | "TOO_LARGE" | "UNAVAILABLE";

export type OfficeRenderResult =
  | { ok: true; pdf: Uint8Array }
  | { ok: false; failure: OfficeRenderFailure };

export type OfficeDocument = {
  mediaType: string;
  bytes: Uint8Array;
};

/** What the renderer is given and what it may hand back. */
export const OFFICE_RENDER_LIMITS = {
  timeoutMs: 90_000,
  /** The converted-file ceiling: a rendered PDF is the user's own content. */
  maxPdfBytes: 25 * 1024 * 1024,
} as const;

const PRIVATE_HTTP_HOSTS = /(?:\.railway\.internal|^localhost|^127\.0\.0\.1|^\[::1\])$/i;

/**
 * The renderer, or null when office rendering is off.
 *
 * A misconfigured address is "off", not an error: the product then says it
 * cannot keep the layout, which is true, instead of failing every request.
 */
export const officeRendererConfig = (
  env: Readonly<Record<string, string | undefined>> = process.env
): OfficeRendererConfig | null => {
  if (env.CHAT_OFFICE_TO_PDF !== "on") return null;
  const raw = env.OFFICE_RENDERER_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === "http:" && !PRIVATE_HTTP_HOSTS.test(url.hostname)) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const username = env.OFFICE_RENDERER_USERNAME?.trim();
  const password = env.OFFICE_RENDERER_PASSWORD;
  return {
    url,
    ...(username && password ? { username, password } : {}),
    timeoutMs: OFFICE_RENDER_LIMITS.timeoutMs,
  };
};

export const officeRenderingEnabled = (
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean => officeRendererConfig(env) !== null;

/** Reads a response body, refusing one larger than the ceiling. */
const readBounded = async (response: Response, limit: number): Promise<Uint8Array | null> => {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

const isPdf = (bytes: Uint8Array) =>
  bytes.byteLength > 5 &&
  new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-");

/**
 * Renders one office document to PDF. Never throws: a renderer that is down,
 * slow or answers with something that is not a PDF is a failure like any
 * other, and the caller words it.
 */
export const renderOfficeDocumentToPdf = async (
  config: OfficeRendererConfig,
  document: OfficeDocument
): Promise<OfficeRenderResult> => {
  const extension = OFFICE_RENDERABLE_EXTENSIONS[normalizeMediaType(document.mediaType)];
  if (!extension) return { ok: false, failure: "UNREADABLE" };

  const form = new FormData();
  form.append(
    "files",
    new Blob([Buffer.from(document.bytes)], { type: normalizeMediaType(document.mediaType) }),
    `document.${extension}`
  );

  const headers: Record<string, string> = {};
  if (config.username && config.password) {
    headers.Authorization = `Basic ${Buffer.from(
      `${config.username}:${config.password}`
    ).toString("base64")}`;
  }

  let response: Response;
  try {
    response = await fetch(new URL("forms/libreoffice/convert", config.url.href.replace(/\/?$/, "/")), {
      method: "POST",
      body: form,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    return {
      ok: false,
      failure:
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
          ? "TIMEOUT"
          : "UNAVAILABLE",
    };
  }

  // 400 is the document: LibreOffice refused it, and the same file fails the
  // same way again. 503 is the renderer's own deadline. Anything else -- an
  // auth failure, a 500, a proxy page -- is the service, not the file.
  if (response.status === 400) {
    await response.body?.cancel();
    return { ok: false, failure: "UNREADABLE" };
  }
  if (response.status === 503) {
    await response.body?.cancel();
    return { ok: false, failure: "TIMEOUT" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, failure: "UNAVAILABLE" };
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await readBounded(response, OFFICE_RENDER_LIMITS.maxPdfBytes);
  } catch {
    return { ok: false, failure: "UNAVAILABLE" };
  }
  if (!bytes) return { ok: false, failure: "TOO_LARGE" };
  // One cheap check on what came back: it has to be a PDF.
  if (!isPdf(bytes)) return { ok: false, failure: "UNAVAILABLE" };
  return { ok: true, pdf: bytes };
};
