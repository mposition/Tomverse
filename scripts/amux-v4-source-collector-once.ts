import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { runAmuxV4SourceCollectorOnce } from "../lib/amux/ideaLocalSourceCollectorBridge.ts";
import { AMUX_V4_COLLECTION_APP_ORIGIN_ENV } from "../lib/amux/ideaLocalCollectionQueuePoll.mjs";
import type { collectAmuxGitHubFileCandidate } from "../lib/amux/ideaGitHubFileCandidate.ts";

const SECRET_ENV = "TOMVERSE_AMUX_V4_COLLECTION_AGENT_SECRET";
const GITHUB_TOKEN_ENV = "TOMVERSE_AMUX_V4_GITHUB_READ_TOKEN";
const GITHUB_ORIGIN = "https://api.github.com";
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,512}$/;
const REPOSITORY = /^([A-Za-z0-9_.-]{1,64})\/([A-Za-z0-9_.-]{1,100})$/;
const IDENTITY_RESPONSE_MAX_BYTES = 128 * 1024;
const IDENTITY_TIMEOUT_MS = 4_000;

type FetchLike = typeof fetch;
type Kind = Awaited<ReturnType<typeof runAmuxV4SourceCollectorOnce>>["kind"];

function validOrigin(value: string | undefined): value is string {
  if (!value || value.length > 512) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      url.pathname === "/" && !url.search && !url.hash && url.origin === value;
  } catch { return false; }
}

async function boundedIdentity(response: Response): Promise<{ id: number; full_name: string } | null> {
  if (response.status !== 200 ||
      response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") {
    try { await response.body?.cancel(); } catch { /* No response content in diagnostics. */ }
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) return null;
      total += value.byteLength;
      if (total > IDENTITY_RESPONSE_MAX_BYTES) return null;
      chunks.push(value);
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true })
      .decode(Buffer.concat(chunks, total)));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const identity = value as Record<string, unknown>;
    return Number.isSafeInteger(identity.id) && (identity.id as number) > 0 &&
      typeof identity.full_name === "string"
      ? { id: identity.id as number, full_name: identity.full_name } : null;
  } catch { return null; }
  finally {
    try { await reader.cancel(); } catch { /* Never log upstream content. */ }
    reader.releaseLock();
  }
}

/** The GitHub token is used only for a fixed API host and never reaches the app. */
export async function resolveAmuxV4GitHubCredential(repository: string,
  token: string, signal: AbortSignal, fetchImpl: FetchLike = fetch) {
  const match = REPOSITORY.exec(repository);
  if (!match || match[1] === "." || match[1] === ".." ||
      match[2] === "." || match[2] === ".." || !TOKEN.test(token)) return null;
  const owner = match[1];
  const repo = match[2];
  const endpoint = `${GITHUB_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  try {
    const response = await fetchImpl(endpoint, {
      method: "GET", redirect: "manual", cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(IDENTITY_TIMEOUT_MS)]),
      headers: { Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (response.url && response.url !== endpoint) {
      try { await response.body?.cancel(); } catch { /* No upstream content in diagnostics. */ }
      return null;
    }
    const identity = await boundedIdentity(response);
    if (!identity || identity.full_name !== repository) return null;
    return { owner, repo, expectedRepositoryId: identity.id, token };
  } catch { return null; }
}

/** Explicit one-shot invocation. No scheduler, model, child process or live default. */
export async function runAmuxV4SourceCollectorCommand(input: {
  env?: NodeJS.ProcessEnv;
  appFetchImpl?: FetchLike;
  githubFetchImpl?: FetchLike;
  collectCandidate?: typeof collectAmuxGitHubFileCandidate;
} = {}): Promise<Kind> {
  const env = input.env ?? process.env;
  const origin = env[AMUX_V4_COLLECTION_APP_ORIGIN_ENV];
  const collectorSecret = env[SECRET_ENV];
  const githubToken = env[GITHUB_TOKEN_ENV];
  if (!validOrigin(origin) || !collectorSecret || !SECRET.test(collectorSecret) ||
      !githubToken || !TOKEN.test(githubToken)) return "refused";
  const result = await runAmuxV4SourceCollectorOnce({ origin, collectorSecret,
    appFetchImpl: input.appFetchImpl, githubFetchImpl: input.githubFetchImpl,
    collectCandidate: input.collectCandidate,
    resolveCredential: (repository, signal) =>
      resolveAmuxV4GitHubCredential(repository, githubToken, signal,
        input.githubFetchImpl),
  });
  return result.kind;
}

export function amuxV4SourceCollectorExitCode(kind: Kind): 0 | 1 {
  return kind === "idle" || kind === "hold" || kind === "preview_ready" ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (process.argv.length === 2
    ? runAmuxV4SourceCollectorCommand().catch(() => "unavailable" as const)
    : Promise.resolve("refused" as const)).then((kind) => {
    process.stdout.write(`${kind}\n`);
    process.exitCode = amuxV4SourceCollectorExitCode(kind);
  });
}
