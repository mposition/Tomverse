import { scanLocalIntakeInput } from "@/lib/amux/localIntakeCore";

/** A no-write entry validation step. It is not the external model payload. */
export const AMUX_IDEA_INPUT_VERSION = 1 as const;
export const AMUX_IDEA_INPUT_MAX_BYTES = 8_192;
export const AMUX_IDEA_INPUT_ENVELOPE_MAX_BYTES = 65_536;
export const AMUX_IDEA_REPOSITORY_MAX = 8;
export const AMUX_IDEA_PR_MAX = 16;

const REPOSITORY = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,100}$/;
const validRepository = (value: string) =>
  REPOSITORY.test(value) && value.split("/").every((part) => part !== "." && part !== "..");

export type IdeaInput = {
  version: typeof AMUX_IDEA_INPUT_VERSION;
  idea: string;
  repositories: string[];
  pullRequests: Array<{ repository: string; number: number }>;
};

export type IdeaInputInspection =
  | { ok: true; input: IdeaInput; ideaBytes: number; repositoryCount: number; pullRequestCount: number }
  | { ok: false; code: "schema_rejected" | "too_large" | "content_refused" | "metadata_incomplete" };

const exactKeys = (value: Record<string, unknown>, names: readonly string[]) =>
  Object.keys(value).sort().join("\0") === [...names].sort().join("\0");

export function inspectAmuxIdeaInput(raw: string): IdeaInputInspection {
  if (Buffer.byteLength(raw, "utf8") > AMUX_IDEA_INPUT_ENVELOPE_MAX_BYTES) {
    return { ok: false, code: "too_large" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "schema_rejected" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "schema_rejected" };
  }
  const record = parsed as Record<string, unknown>;
  if (!exactKeys(record, ["version", "idea", "repositories", "pullRequests"]) || record.version !== 1) {
    return { ok: false, code: "schema_rejected" };
  }
  if (typeof record.idea !== "string") return { ok: false, code: "schema_rejected" };
  const idea = record.idea.trim();
  const ideaBytes = Buffer.byteLength(idea, "utf8");
  if (ideaBytes === 0) return { ok: false, code: "metadata_incomplete" };
  if (ideaBytes > AMUX_IDEA_INPUT_MAX_BYTES) return { ok: false, code: "too_large" };
  const scanned = scanLocalIntakeInput(idea);
  if (!scanned.ok) {
    return {
      ok: false,
      code: scanned.code === "too_large" ? "too_large" : "content_refused",
    };
  }
  if (!Array.isArray(record.repositories) || record.repositories.length > AMUX_IDEA_REPOSITORY_MAX) {
    return { ok: false, code: "schema_rejected" };
  }
  if (!Array.isArray(record.pullRequests) || record.pullRequests.length > AMUX_IDEA_PR_MAX) {
    return { ok: false, code: "schema_rejected" };
  }
  const repositories = record.repositories;
  if (!repositories.every((value): value is string => typeof value === "string" && validRepository(value))) {
    return { ok: false, code: "schema_rejected" };
  }
  if (new Set(repositories.map((repository) => repository.toLowerCase())).size !== repositories.length) {
    return { ok: false, code: "schema_rejected" };
  }
  const pullRequests: IdeaInput["pullRequests"] = [];
  for (const candidate of record.pullRequests) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return { ok: false, code: "schema_rejected" };
    }
    const item = candidate as Record<string, unknown>;
    if (!exactKeys(item, ["repository", "number"]) ||
        typeof item.repository !== "string" || !validRepository(item.repository) ||
        !Number.isSafeInteger(item.number) || (item.number as number) <= 0) {
      return { ok: false, code: "schema_rejected" };
    }
    pullRequests.push({ repository: item.repository, number: item.number as number });
  }
  if (new Set(pullRequests.map((item) => `${item.repository.toLowerCase()}#${item.number}`)).size !== pullRequests.length) {
    return { ok: false, code: "schema_rejected" };
  }
  return {
    ok: true,
    input: { version: 1, idea, repositories, pullRequests },
    ideaBytes,
    repositoryCount: repositories.length,
    pullRequestCount: pullRequests.length,
  };
}
