import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

export type StaticMarketingCspHashes = {
  scriptHashes: string[];
  styleHashes: string[];
};

const hashCache = new Map<string, StaticMarketingCspHashes | null>();

const normalizePathname = (pathname: string) => {
  if (!pathname || pathname === "/") return "/";
  return pathname.replace(/\/+$/, "") || "/";
};

const hashInlineContent = (content: string) =>
  `'sha384-${createHash("sha384").update(content, "utf8").digest("base64")}'`;

const collectInlineHashes = (
  html: string,
  tagName: "script" | "style"
) => {
  const hashes = new Set<string>();
  const expression = new RegExp(
    `<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`,
    "gi"
  );

  for (const match of html.matchAll(expression)) {
    const attributes = match[1] || "";
    const content = match[2] || "";
    if (tagName === "script" && /\bsrc\s*=/.test(attributes)) continue;
    if (!content) continue;
    hashes.add(hashInlineContent(content));
  }

  return [...hashes].sort();
};

const htmlPathForRoute = (pathname: string) => {
  const normalized = normalizePathname(pathname);
  const segments = normalized === "/" ? ["index"] : normalized.slice(1).split("/");
  if (segments.some((segment) => !/^[a-z0-9-]+$/i.test(segment))) return null;

  const appOutputDirectory = resolve(process.cwd(), ".next", "server", "app");
  const htmlPath = resolve(
    appOutputDirectory,
    `${segments.join(sep)}.html`
  );
  if (!htmlPath.startsWith(`${appOutputDirectory}${sep}`)) return null;
  return htmlPath;
};

export const getStaticMarketingCspHashes = (
  pathname: string
): StaticMarketingCspHashes | null => {
  const normalized = normalizePathname(pathname);
  if (hashCache.has(normalized)) return hashCache.get(normalized) || null;

  try {
    const htmlPath = htmlPathForRoute(normalized);
    if (!htmlPath) return null;
    const html = readFileSync(htmlPath, "utf8");
    const hashes = {
      scriptHashes: collectInlineHashes(html, "script"),
      styleHashes: collectInlineHashes(html, "style"),
    };
    hashCache.set(normalized, hashes);
    return hashes;
  } catch (error) {
    if (process.env.NODE_ENV === "production") {
      console.error("Static marketing CSP hash load failed:", {
        pathname: normalized,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      hashCache.set(normalized, null);
    }
    return null;
  }
};
