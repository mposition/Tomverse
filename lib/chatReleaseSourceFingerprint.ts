import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Serving routes are entry points. Their local import closure is included so
 * a new cost, provider or dispatch helper cannot inherit an older Owner
 * release merely because its filename has an unfamiliar prefix.
 */
const ENTRY_DIRECTORIES = Object.freeze([
  "app/api/chat",
  "app/api/products/chat",
]);
const OWNER_RELEASE_ROUTES = Object.freeze([
  "app/api/admin/prompt-refiner/product-activation/route.ts",
  "app/api/admin/prompt-refiner/product-rollout/route.ts",
  "app/api/admin/prompt-refiner/product-status/route.ts",
  "app/api/admin/prompt-refiner/product-auto-resume/route.ts",
  "app/api/admin/prompt-refiner/guest-chat-auto-activation/route.ts",
]);
// The proxy request boundary is fingerprinted separately below. These helpers
// decide whether a Chat request may pass it, without binding marketing or
// maintenance work that happens to share the same entry point.
const REQUEST_BOUNDARY_FILES = Object.freeze([
  "lib/nativeBearerGate.ts",
  "lib/mobileAuthContract.ts",
]);
const SCHEMA_MODEL = /^(?:AdminAuditLog|AppSetting|BillingPlan|ModelRegistryEntry|User|Account|Conversation[A-Za-z0-9_]*|Message[A-Za-z0-9_]*|Chat[A-Za-z0-9_]*|Credit[A-Za-z0-9_]*|Provider[A-Za-z0-9_]*|Routing[A-Za-z0-9_]*|PromptRefiner[A-Za-z0-9_]*|Guest[A-Za-z0-9_]*|AutoRouter[A-Za-z0-9_]*|ContextManifest|TokenEstimate[A-Za-z0-9_]*)$/;
const SOURCE_EXTENSIONS = Object.freeze(["", ".ts", ".tsx", ".mjs", ".js",
  ".json", "/index.ts", "/index.tsx", "/index.mjs", "/index.js"]);
const MINIMUM_SOURCE_FILES = 100;
const REQUIRED_SOURCE = Object.freeze([
  "app/api/chat/route.ts",
  "app/api/products/chat/capabilities/route.ts",
  "lib/chatRefinerInitialAutoRelease.ts",
  "lib/guestChatSmartAdaptiveRelease.ts",
  "packages/chat-core/src/index.ts",
  ...REQUEST_BOUNDARY_FILES,
]);

const digest = (value: string | Buffer) => createHash("sha256")
  .update(value).digest("hex");
const slash = (path: string) => path.replaceAll("\\", "/");

function sourcePaths(root: string, directory: string): string[] {
  const base = join(root, ...directory.split("/"));
  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|tsx|mjs|js)$/.test(entry.name))
    .map((entry) => `${directory}/${slash(relative(base,
      join(entry.parentPath, entry.name)))}`);
}

function localImport(root: string, importer: string, specifier: string):
  string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = resolve(root, specifier.slice(2));
  } else if (specifier === "@tomverse/chat-core" ||
      specifier.startsWith("@tomverse/chat-core/")) {
    const subpath = specifier === "@tomverse/chat-core"
      ? "index" : specifier.slice("@tomverse/chat-core/".length);
    base = resolve(root, "packages", "chat-core", "src", subpath);
  } else if (specifier.startsWith(".")) {
    base = resolve(root, dirname(importer), specifier);
  } else {
    return null;
  }
  const path = SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`)
    .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (!path) throw new Error("chat_release_local_import_missing");
  const relativePath = slash(relative(root, path));
  if (relativePath.startsWith("../") || relativePath === "..") {
    throw new Error("chat_release_local_import_outside_repository");
  }
  return relativePath;
}

function importSpecifiers(root: string, path: string): string[] {
  const source = readFileSync(join(root, ...path.split("/")), "utf8");
  return [
    ...source.matchAll(/^\s*(?:import|export)\b\s*(?:type\s+)?(?:[^"';]*?\bfrom\s*)?["']([^"']+)["']/gm),
    ...source.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
}

function importedPaths(root: string, path: string): string[] {
  return importSpecifiers(root, path)
    .map((specifier) => localImport(root, path, specifier))
    .filter((value): value is string => value !== null);
}

function externalPackage(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("@/") ||
      specifier === "@tomverse/chat-core" ||
      specifier.startsWith("@tomverse/chat-core/") ||
      isBuiltin(specifier)) return null;
  if (specifier.startsWith("@tomverse/")) {
    throw new Error("chat_release_workspace_import_unreviewed");
  }
  if (!/^(?:@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)(?:\/|$)/i.test(
    specifier)) return null;
  const segments = specifier.split("/");
  return specifier.startsWith("@")
    ? segments.slice(0, 2).join("/") : segments[0];
}

function executionDependencyLock(root: string, paths: readonly string[]): string {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const packages = lock?.packages as Record<string, Record<string, unknown>> | undefined;
  if (!packages || typeof packages !== "object") {
    throw new Error("chat_release_dependency_lock_invalid");
  }
  const selected = new Set<string>();
  const queue = [...new Set(paths.flatMap((path) =>
    importSpecifiers(root, path).map(externalPackage)
      .filter((name): name is string => Boolean(name))))]
    .map((name) => `node_modules/${name}`);
  for (let index = 0; index < queue.length; index += 1) {
    const key = queue[index];
    if (selected.has(key)) continue;
    const entry = packages[key];
    if (!entry || typeof entry !== "object") {
      throw new Error(`chat_release_dependency_lock_incomplete:${key}`);
    }
    selected.add(key);
    const required = entry.dependencies as Record<string, string> | undefined;
    const optional = entry.optionalDependencies as Record<string, string> | undefined;
    const peers = entry.peerDependencies as Record<string, string> | undefined;
    const peerMeta = entry.peerDependenciesMeta as
      Record<string, { optional?: boolean }> | undefined;
    for (const name of [...Object.keys(required ?? {}),
      ...Object.keys(optional ?? {}), ...Object.keys(peers ?? {})]) {
      let scope = key;
      let resolvedKey = "";
      while (scope) {
        const candidate = `${scope}/node_modules/${name}`;
        if (packages[candidate]) { resolvedKey = candidate; break; }
        const parent = scope.lastIndexOf("/node_modules/");
        scope = parent < 0 ? "" : scope.slice(0, parent);
      }
      resolvedKey ||= `node_modules/${name}`;
      if (!packages[resolvedKey]) {
        if (Object.hasOwn(optional ?? {}, name) || peerMeta?.[name]?.optional) {
          continue;
        }
        throw new Error(`chat_release_dependency_lock_incomplete:${key}:${name}`);
      }
      queue.push(resolvedKey);
    }
  }
  if (selected.size < 10) {
    throw new Error("chat_release_dependency_lock_scope_invalid");
  }
  return JSON.stringify([...selected].sort().map((key) => [key, packages[key]]));
}

export function chatReleaseSourcePaths(root: string): string[] {
  const entries = new Set<string>([
    ...ENTRY_DIRECTORIES.flatMap((directory) => sourcePaths(root, directory)),
    ...OWNER_RELEASE_ROUTES,
    ...REQUEST_BOUNDARY_FILES,
    ...sourcePaths(root, "packages/chat-core/src"),
  ]);
  const queue = [...entries];
  for (let index = 0; index < queue.length; index += 1) {
    for (const imported of importedPaths(root, queue[index])) {
      if (!entries.has(imported)) {
        entries.add(imported);
        queue.push(imported);
      }
    }
  }
  const paths = [...entries].sort();
  if (paths.length < MINIMUM_SOURCE_FILES ||
      REQUIRED_SOURCE.some((path) => !entries.has(path))) {
    throw new Error("chat_release_source_scope_invalid");
  }
  return paths;
}

function prismaExecutionSchema(source: string): string {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(model|enum) ([A-Za-z0-9_]+) \{/.exec(lines[index]);
    if (!match || !SCHEMA_MODEL.test(match[2])) continue;
    const start = index;
    let depth = 0;
    do {
      depth += (lines[index].match(/\{/g) ?? []).length;
      depth -= (lines[index].match(/\}/g) ?? []).length;
      index += 1;
    } while (depth > 0 && index < lines.length);
    if (depth !== 0) throw new Error("chat_release_schema_unbalanced");
    blocks.push(lines.slice(start, index).join("\n"));
    index -= 1;
  }
  if (blocks.length < 10 || !blocks.some((block) =>
      block.startsWith("model PromptRefinerProductOperationalGuard "))) {
    throw new Error("chat_release_schema_incomplete");
  }
  return blocks.join("\n\n");
}

function proxyChatRequestBoundary(source: string): string {
  const normalized = source.replaceAll("\r\n", "\n");
  const start = normalized.indexOf("const blockedOriginResponse =");
  const end = normalized.indexOf("  // R-05-LANG.", start);
  if (start < 0 || end <= start ||
      normalized.indexOf("export function proxy(", start) < 0 ||
      normalized.indexOf("export function proxy(", start) >= end) {
    throw new Error("chat_release_proxy_boundary_unavailable");
  }
  return normalized.slice(start, end);
}

/** Fail closed if the serving image cannot prove its reviewed source. */
export function chatReleaseSourceFingerprint(root: string): string {
  try {
    const paths = chatReleaseSourcePaths(root);
    const entries = paths.map((path) =>
      [path, digest(readFileSync(join(root, ...path.split("/"))))]);
    const schema = readFileSync(join(root, "prisma", "schema.prisma"), "utf8");
    entries.push(["prisma/schema.prisma#execution-models",
      digest(prismaExecutionSchema(schema))]);
    entries.push(["proxy.ts#chat-request-boundary", digest(
      proxyChatRequestBoundary(readFileSync(join(root, "proxy.ts"), "utf8")))]);
    entries.push(["package-lock.json#execution-dependencies",
      digest(executionDependencyLock(root, paths))]);
    return digest(JSON.stringify({ version: "chat-release-source-v2", entries }));
  } catch (error) {
    throw new Error("chat_release_source_unavailable", { cause: error });
  }
}

let cachedFingerprint: string | null = null;
export function currentChatReleaseSourceFingerprint(): string {
  // Production images are immutable. Never cache an error: a transient read
  // cannot silently become authority on the next request.
  if (!cachedFingerprint) {
    cachedFingerprint = chatReleaseSourceFingerprint(process.cwd());
  }
  return cachedFingerprint;
}
