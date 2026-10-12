import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Files capable of changing the Chat/Guest execution boundary. The path list is
 * computed from the serving source tree, so adding or deleting a matching
 * module changes the fingerprint without a manually bumped version.
 */
const LIB_SOURCE = /^(?:chat|guest|auto|router|routing|promptRefiner|provider|model|credit|billing|manifest|dispatch|activeAiModel|appSettings|adminAudit|adminAuth|adminReauthentication|auth|prisma|apiSecurity|requestOrigin|originProtection|clientIp|token|usage|cost)[A-Za-z0-9_-]*\.(?:ts|tsx|mjs)$/;
const SCHEMA_MODEL = /^(?:AdminAuditLog|AppSetting|BillingPlan|ModelRegistryEntry|User|Account|Conversation[A-Za-z0-9_]*|Message[A-Za-z0-9_]*|Chat[A-Za-z0-9_]*|Credit[A-Za-z0-9_]*|Provider[A-Za-z0-9_]*|Routing[A-Za-z0-9_]*|PromptRefiner[A-Za-z0-9_]*|Guest[A-Za-z0-9_]*|AutoRouter[A-Za-z0-9_]*|ContextManifest|TokenEstimate[A-Za-z0-9_]*)$/;
const REQUIRED_PATHS = Object.freeze([
  "docs/policy/chat-refiner-stable-release-authority-v2.md",
  "prisma/schema.prisma",
]);

function sourcePaths(root: string, directory: string,
  nameMatches: (name: string) => boolean): string[] {
  const base = join(root, ...directory.split("/"));
  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && nameMatches(entry.name))
    .map((entry) => `${directory}/${relative(base,
      join(entry.parentPath, entry.name)).replaceAll("\\", "/")}`);
}

const digest = (value: string | Buffer) => createHash("sha256")
  .update(value).digest("hex");

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

/** Fail closed if the serving image cannot prove its reviewed source. */
export function chatReleaseSourceFingerprint(root: string): string {
  try {
    const paths = [
      ...readdirSync(join(root, "lib"))
        .filter((name) => LIB_SOURCE.test(name))
        .map((name) => `lib/${name}`),
      ...sourcePaths(root, "app/api/chat",
        (name) => /\.(?:ts|tsx|mjs)$/.test(name)),
      ...sourcePaths(root, "app/api/products/chat",
        (name) => /\.(?:ts|tsx|mjs)$/.test(name)),
      ...sourcePaths(root, "app/api/admin/prompt-refiner",
        (name) => /\.(?:ts|tsx|mjs)$/.test(name)),
      ...sourcePaths(root, "packages/chat-core/src",
        (name) => /\.(?:ts|tsx)$/.test(name)),
      ...REQUIRED_PATHS,
    ].filter((path) => path !== "prisma/schema.prisma").sort();
    if (paths.length < 100 ||
        !paths.includes("app/api/chat/route.ts") ||
        !paths.includes("app/api/products/chat/capabilities/route.ts") ||
        paths.some((path, index) =>
        index > 0 && path === paths[index - 1])) {
      throw new Error("chat_release_source_scope_invalid");
    }
    const entries = paths.map((path) =>
      [path, digest(readFileSync(join(root, ...path.split("/"))))]);
    const schema = readFileSync(join(root, "prisma", "schema.prisma"), "utf8");
    entries.push(["prisma/schema.prisma#execution-models",
      digest(prismaExecutionSchema(schema))]);
    return digest(JSON.stringify({ version: "chat-release-source-v2", entries }));
  } catch {
    throw new Error("chat_release_source_unavailable");
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
