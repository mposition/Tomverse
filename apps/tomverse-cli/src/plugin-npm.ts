import { createHash } from "node:crypto";
import { z } from "zod";
import { ArchiveSink, extractTarGz } from "./plugin-archive.js";
import { checkDownloadUrl, downloadBytes, shownUrl, type DownloadFetch } from "./plugin-download.js";
import { PLUGIN_LIMITS, PluginError } from "./plugin-fs.js";

/**
 * A plugin published as an npm package. The registry is asked for one exact version (or `latest`); the tarball it names is downloaded
 * over https, checked against the registry's own integrity value (and against the one a catalog pins, when it pins one), and unpacked
 * as plain files. `npm` itself is never run, so no lifecycle script (preinstall, install, postinstall, prepare) can start, and no
 * dependency is installed: the package's own files are the plugin. The integrity value is part of what the person approves.
 */

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const STRONG = ["sha512", "sha384", "sha256"] as const;

export type NpmSource = { package: string; version?: string; registry?: string; integrity?: string };

/** A package name and an exact version (or none: the registry's `latest`). A range or a tag is refused: the version is what the person sees. */
export const checkNpmSource = (source: NpmSource): NpmSource => {
    if (!source.package || source.package.length > 214 || !NAME.test(source.package)) throw new PluginError("That is not an npm package name.");
    if (source.version !== undefined && !EXACT_VERSION.test(source.version)) {
        throw new PluginError("Give an exact version such as 1.2.3, or no version for the newest one. A range or a tag is not accepted.");
    }
    if (source.integrity !== undefined && !integrityEntries(source.integrity).length) throw new PluginError("The pinned integrity value is not usable.");
    if (source.registry !== undefined) checkDownloadUrl(source.registry, "npm registry");
    return source;
};

type IntegrityEntry = { algorithm: (typeof STRONG)[number]; value: string };

const integrityEntries = (text: string): IntegrityEntry[] =>
    text.trim().split(/\s+/).flatMap((part) => {
        const match = /^(sha512|sha384|sha256)-([A-Za-z0-9+/]+={0,2})(?:\?.*)?$/.exec(part);
        return match ? [{ algorithm: match[1] as IntegrityEntry["algorithm"], value: match[2]! }] : [];
    });

/** The strongest integrity value of a Subresource Integrity string, as `sha512-...`. Null when it has none this app accepts (sha1 is not). */
export const strongestIntegrity = (text: string): string | null => {
    const entries = integrityEntries(text);
    for (const algorithm of STRONG) {
        const entry = entries.find((candidate) => candidate.algorithm === algorithm);
        if (entry) return `${algorithm}-${entry.value}`;
    }
    return null;
};

export const matchesIntegrity = (data: Buffer, integrity: string): boolean => {
    const wanted = strongestIntegrity(integrity);
    if (!wanted) return false;
    const algorithm = wanted.slice(0, wanted.indexOf("-"));
    return `${algorithm}-${createHash(algorithm).update(data).digest("base64")}` === wanted;
};

const MAX_METADATA_BYTES = 2 * 1024 * 1024;

const versionDocument = z.object({
    name: z.string(),
    version: z.string(),
    dist: z.object({ tarball: z.string().max(1000), integrity: z.string().max(500).optional() }).passthrough(),
}).passthrough();

export type NpmDownload = { version: string; integrity: string; registry: string };

/**
 * Downloads one package version and unpacks it into `destination` (a fresh folder under the staging area). Returns the version it found
 * and the integrity value it verified. The package's own `package/` folder is the plugin root; the caller steps into it.
 */
export const fetchNpmPackage = async (
    source: NpmSource, destination: string, options: { signal?: AbortSignal; fetchImpl?: DownloadFetch } = {},
): Promise<NpmDownload> => {
    const checked = checkNpmSource(source);
    const registry = (checked.registry ?? DEFAULT_NPM_REGISTRY).replace(/\/+$/, "");
    const registryUrl = checkDownloadUrl(registry, "npm registry");
    const encoded = checked.package.startsWith("@") ? checked.package.replaceAll("/", "%2F") : checked.package;
    const metadata = await downloadBytes(`${registry}/${encoded}/${checked.version ?? "latest"}`, {
        maxBytes: MAX_METADATA_BYTES, accept: "application/json", what: "npm package listing", ...options,
    });
    let parsed;
    try {
        parsed = versionDocument.parse(JSON.parse(metadata.toString("utf8")));
    } catch {
        throw new PluginError(`The registry gave an answer this app cannot read for ${checked.package}.`);
    }
    if (parsed.name !== checked.package || (checked.version !== undefined && parsed.version !== checked.version) || !EXACT_VERSION.test(parsed.version)) {
        throw new PluginError("The registry answered with a different package or version than the one asked for.");
    }
    const integrity = strongestIntegrity(parsed.dist.integrity ?? "");
    if (!integrity) throw new PluginError("The registry gives no sha512 integrity value for this package version, so it cannot be checked.");
    if (checked.integrity !== undefined && strongestIntegrity(checked.integrity) !== integrity) {
        throw new PluginError("The package's integrity value differs from the one the catalog pins; nothing was downloaded.");
    }
    const tarball = checkDownloadUrl(parsed.dist.tarball, "npm tarball");
    if (tarball.host !== registryUrl.host) throw new PluginError(`The tarball is not on the registry's own host (${shownUrl(tarball.toString())}).`);
    const bytes = await downloadBytes(tarball.toString(), { maxBytes: PLUGIN_LIMITS.bytes, accept: "application/octet-stream", what: "npm tarball", ...options });
    if (!matchesIntegrity(bytes, integrity)) throw new PluginError("The downloaded package does not match its integrity value; nothing was installed.");
    extractTarGz(bytes, new ArchiveSink(destination));
    return { version: parsed.version, integrity, registry };
};
