import { PLUGIN_LOGO_PATH, type PluginCatalog } from "../plugin-catalog-contract";

export type CatalogRead =
  | { status: "not-modified"; maxAge: number }
  | { status: "ok"; catalog: PluginCatalog; etag: string | null; maxAge: number };

const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/svg+xml", "image/webp"]);
const LOGO_LIMIT_BYTES = 512 * 1024;
const LOGO_KEPT = 256;

export type PluginLogo = { bytes: Uint8Array<ArrayBuffer>; type: string };

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
  let held: { catalog: PluginCatalog; etag: string | null; fetchedAt: number; maxAge: number } | undefined;
  let inflight: Promise<PluginCatalog> | undefined;
  const logos = new Map<string, PluginLogo>();

  /** `refresh` revalidates a list that is still fresh; a failed read keeps the last list for the caller to show beside the error. */
  function read(refresh = false): Promise<PluginCatalog> {
    if (held && !refresh && now() - held.fetchedAt < held.maxAge * 1000) return Promise.resolve(held.catalog);
    inflight ??= (async () => {
      const result = await deps.read(held?.etag ?? undefined);
      if (result.status === "not-modified") {
        if (!held) throw new Error("Tomverse answered with an unchanged list that was never sent.");
        held = { ...held, fetchedAt: now(), maxAge: result.maxAge };
      } else {
        if (held && held.catalog.observedAt !== result.catalog.observedAt) logos.clear();
        held = { catalog: result.catalog, etag: result.etag, fetchedAt: now(), maxAge: result.maxAge };
      }
      return held.catalog;
    })().finally(() => { inflight = undefined; });
    return inflight;
  }

  async function logo(id: string): Promise<PluginLogo | null> {
    const path = held?.catalog.providers.find((provider) => provider.id === id)?.logo;
    if (!path || !PLUGIN_LOGO_PATH.test(path)) return null;
    const kept = logos.get(id);
    if (kept) return kept;
    let result: PluginLogo | null = null;
    try {
      const response = await deps.fetchLogo(path);
      const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      const length = Number(response.headers.get("content-length") ?? 0);
      if (response.ok && LOGO_TYPES.has(type) && length <= LOGO_LIMIT_BYTES) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > 0 && bytes.byteLength <= LOGO_LIMIT_BYTES) result = { bytes, type };
      } else {
        await response.body?.cancel().catch(() => {});
      }
    } catch { /* A logo that cannot be read is shown as the platform's initial. */ }
    // Only a logo that was read is kept: a failed one is tried again the next time it is asked for.
    if (result) {
      if (logos.size >= LOGO_KEPT) logos.delete(logos.keys().next().value!);
      logos.set(id, result);
    }
    return result;
  }

  return { read, logo };
}
