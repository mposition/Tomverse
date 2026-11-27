import { PLUGIN_LOGO_PATH, type PluginCatalog, type PluginCatalogView } from "../plugin-catalog-contract";

export type CatalogRead =
  | { status: "not-modified"; maxAge: number }
  | { status: "ok"; catalog: PluginCatalog; etag: string | null; maxAge: number };

const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/svg+xml", "image/webp"]);
const LOGO_LIMIT_BYTES = 512 * 1024;
const LOGO_KEPT = 256;

export type PluginLogo = { bytes: Uint8Array<ArrayBuffer>; type: string };

/** The body, read chunk by chunk: the read stops the moment it passes `limit`, whatever length the response declared (or none). */
async function readLimited(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/**
 * The Plugins screen's platform list. It is read from the server when the screen opens and when the person asks for a refresh,
 * and held in memory for the lifetime the server's Cache-Control names; after that it is revalidated with its ETag, so an
 * unchanged list costs no body. A platform's logo is fetched from the account origin on first use and held the same way.
 */
export function createPluginCatalog(deps: {
  read(known: string | undefined): Promise<CatalogRead>;
  /** One public file on the account origin; no credentials are sent. */
  fetchLogo(path: string): Promise<Response>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let held: { catalog: PluginCatalog; etag: string | null; fetchedAt: number; maxAge: number; revision: number } | undefined;
  let inflight: Promise<PluginCatalogView> | undefined;
  // Counts the lists received. The renderer puts it in a logo's address, so its images are asked for again when a new list arrives.
  let revision = 0;
  // A logo is kept with the path it was read from, and every new list from the server drops them all: a picture that changed under the same path is read again.
  const logos = new Map<string, PluginLogo & { path: string }>();

  /** `refresh` revalidates a list that is still fresh; a failed read keeps the last list for the caller to show beside the error. */
  function read(refresh = false): Promise<PluginCatalogView> {
    if (held && !refresh && now() - held.fetchedAt < held.maxAge * 1000) return Promise.resolve({ ...held.catalog, revision: held.revision });
    inflight ??= (async () => {
      const result = await deps.read(held?.etag ?? undefined);
      if (result.status === "not-modified") {
        if (!held) throw new Error("Tomverse answered with an unchanged list that was never sent.");
        held = { ...held, fetchedAt: now(), maxAge: result.maxAge };
      } else {
        logos.clear();
        revision += 1;
        held = { catalog: result.catalog, etag: result.etag, fetchedAt: now(), maxAge: result.maxAge, revision };
      }
      return { ...held.catalog, revision: held.revision };
    })().finally(() => { inflight = undefined; });
    return inflight;
  }

  async function logo(id: string): Promise<PluginLogo | null> {
    const path = held?.catalog.providers.find((provider) => provider.id === id)?.logo;
    if (!path || !PLUGIN_LOGO_PATH.test(path)) return null;
    const kept = logos.get(id);
    if (kept?.path === path) return kept;
    const generation = revision;
    let result: PluginLogo | null = null;
    try {
      const response = await deps.fetchLogo(path);
      const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      const length = Number(response.headers.get("content-length") ?? 0);
      if (response.ok && LOGO_TYPES.has(type) && length <= LOGO_LIMIT_BYTES) {
        const bytes = await readLimited(response, LOGO_LIMIT_BYTES);
        if (bytes && bytes.byteLength > 0) result = { bytes, type };
      } else {
        await response.body?.cancel().catch(() => {});
      }
    } catch { /* A logo that cannot be read is shown as the platform's initial. */ }
    // Only a logo that was read is kept: a failed one is tried again the next time it is asked for. A picture fetched for a list
    // the server has since replaced is shown once and not kept.
    if (result && generation === revision) {
      if (logos.size >= LOGO_KEPT) logos.delete(logos.keys().next().value!);
      logos.set(id, { ...result, path });
    }
    return result;
  }

  return { read, logo };
}
